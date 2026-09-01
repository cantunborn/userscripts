// Node's own experimental global `localStorage` shadows jsdom's window.localStorage
// and stays disabled without a --localstorage-file flag, so polyfill it here.
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage.setItem !== 'function') {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

const rp = require('../reddit-paginate.user.js');

function makePost(id, extraHtml) {
  const article = document.createElement('article');
  article.className = 'w-full m-0';
  const post = document.createElement('shreddit-post');
  post.id = id;
  post.textContent = extraHtml || id;
  article.appendChild(post);
  document.body.appendChild(article);
  return post;
}

function makeSortDropdown(headerText, sortEvent) {
  const el = document.createElement('shreddit-sort-dropdown');
  el.setAttribute('header-text', headerText);
  el.setAttribute('sort-event', sortEvent);
  const parent = document.createElement('div');
  parent.appendChild(el);
  document.body.appendChild(parent);
  return el;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/r/test/');
  rp.__setState(null);
  rp.__setPageSize(25);
});

describe('storage keys', () => {
  it('differ between feeds so pages and snapshots do not collide', () => {
    window.history.pushState({}, '', '/r/test/');
    const keyA = rp.pageStorageKey();
    const snapA = rp.snapshotStorageKey();
    window.history.pushState({}, '', '/r/other/?sort=hot');
    const keyB = rp.pageStorageKey();
    const snapB = rp.snapshotStorageKey();
    expect(keyA).not.toBe(keyB);
    expect(snapA).not.toBe(snapB);
  });
});

describe('page save and restore', () => {
  it('round-trips the current page number', () => {
    rp.__setState({ currentPage: 3 });
    rp.saveCurrentPage();
    expect(rp.readSavedPage()).toBe(3);
  });

  it('treats page 1 as nothing to restore', () => {
    rp.__setState({ currentPage: 1 });
    rp.saveCurrentPage();
    expect(rp.readSavedPage()).toBeNull();
  });

  it('returns null when nothing was saved', () => {
    expect(rp.readSavedPage()).toBeNull();
  });
});

describe('registerPost', () => {
  it('adds a post once and skips a second post with the same id', () => {
    rp.__setState({ posts: [] });
    const first = makePost('t3_a');
    const duplicate = makePost('t3_a');

    expect(rp.registerPost(first)).toBe(true);
    expect(rp.registerPost(duplicate)).toBe(false);
    expect(rp.__getState().posts).toEqual([first]);
  });

  it('saves each registered post into the snapshot', () => {
    rp.__setState({ posts: [] });
    rp.registerPost(makePost('t3_a'));
    rp.registerPost(makePost('t3_b'));

    const saved = rp.loadSnapshot();
    expect(saved.map((e) => e.id)).toEqual(['t3_a', 't3_b']);
  });
});

describe('snapshot size cap', () => {
  it('drops the oldest entries once the saved size passes the cap', () => {
    const bigChunk = 'x'.repeat(15000);
    for (let i = 0; i < 250; i++) {
      rp.appendToSnapshot(makePost('t3_' + i, bigChunk));
    }
    const saved = rp.loadSnapshot();
    const bytes = JSON.stringify(saved).length;

    expect(bytes).toBeLessThanOrEqual(rp.MAX_SNAPSHOT_BYTES);
    expect(saved.length).toBeLessThan(250);
    expect(saved[saved.length - 1].id).toBe('t3_249');
  });
});

describe('clearSnapshot', () => {
  it('empties out any saved posts', () => {
    rp.appendToSnapshot(makePost('t3_a'));
    expect(rp.loadSnapshot().length).toBe(1);
    rp.clearSnapshot();
    expect(rp.loadSnapshot()).toEqual([]);
  });
});

describe('restoreFromSnapshot', () => {
  it('replaces the live posts with the saved ones, in saved order, ahead of the sentinel', () => {
    const feed = document.createElement('shreddit-feed');
    document.body.appendChild(feed);

    const liveArticle = document.createElement('article');
    const livePost = document.createElement('shreddit-post');
    livePost.id = 't3_live';
    liveArticle.appendChild(livePost);
    feed.appendChild(liveArticle);

    const sentinel = document.createElement('faceplate-partial');
    sentinel.setAttribute('slot', 'load-after');
    feed.appendChild(sentinel);

    sessionStorage.setItem(
      rp.snapshotStorageKey(),
      JSON.stringify([
        { id: 't3_x', html: '<article><shreddit-post id="t3_x">X</shreddit-post></article>' },
        { id: 't3_y', html: '<article><shreddit-post id="t3_y">Y</shreddit-post></article>' },
      ])
    );

    const restored = rp.restoreFromSnapshot(feed);

    expect(restored.map((p) => p.id)).toEqual(['t3_x', 't3_y']);
    expect(feed.querySelector('#t3_live')).toBeNull();

    const order = Array.from(feed.children).map((el) => el.tagName);
    const sentinelIndex = order.indexOf('FACEPLATE-PARTIAL');
    expect(sentinelIndex).toBe(order.length - 1);
  });

  it('returns null when there is nothing saved', () => {
    const feed = document.createElement('shreddit-feed');
    expect(rp.restoreFromSnapshot(feed)).toBeNull();
  });
});

describe('requestNextBatch sentinel retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries until the sentinel is upgraded with a callable loadContent, then loads more', async () => {
    const feed = document.createElement('shreddit-feed');
    document.body.appendChild(feed);
    const post = document.createElement('shreddit-post');
    post.id = 't3_a';
    feed.appendChild(post);

    const sentinel = document.createElement('faceplate-partial');
    sentinel.setAttribute('slot', 'load-after');
    feed.appendChild(sentinel);

    rp.__setState({ feed, posts: [post], currentPage: 1, hasMore: true });

    vi.useFakeTimers();
    const donePromise = rp.requestNextBatch();

    await vi.advanceTimersByTimeAsync(250);
    expect(rp.__getState().hasMore).toBe(true);

    sentinel.loadContent = () => {
      const newPost = document.createElement('shreddit-post');
      newPost.id = 't3_b';
      rp.__getState().posts.push(newPost);
      if (rp.__getState().pendingResolve) rp.__getState().pendingResolve();
    };
    await vi.advanceTimersByTimeAsync(250);
    await donePromise;

    expect(rp.__getState().hasMore).toBe(true);
    expect(rp.__getState().posts.length).toBe(2);
  });

  it('gives up and sets hasMore false if no sentinel ever becomes callable', async () => {
    const feed = document.createElement('shreddit-feed');
    document.body.appendChild(feed);
    const sentinel = document.createElement('faceplate-partial');
    sentinel.setAttribute('slot', 'load-after');
    feed.appendChild(sentinel);

    rp.__setState({ feed, posts: [], currentPage: 1, hasMore: true });

    vi.useFakeTimers();
    const donePromise = rp.requestNextBatch();
    await vi.advanceTimersByTimeAsync(1500);
    await donePromise;

    expect(rp.__getState().hasMore).toBe(false);
  });
});

describe('scheduleInit race guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('only runs init once when a second scheduleInit call arrives while both are still polling for the feed', async () => {
    const logSpy = vi.spyOn(console, 'log');

    vi.useFakeTimers();
    rp.scheduleInit();
    await vi.advanceTimersByTimeAsync(100);
    rp.scheduleInit();
    await vi.advanceTimersByTimeAsync(100);
    makeFeed(10);
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    const startCount = logSpy.mock.calls.filter((args) => args[1] === 'init: starting with').length;
    expect(startCount).toBe(1);
    logSpy.mockRestore();
  });

  it('does not throw when scheduleInit tears down state while an earlier init is still awaiting a load', async () => {
    const feed = makeFeed(3);
    rp.__setPageSize(5);

    vi.useFakeTimers();
    rp.scheduleInit();
    await vi.advanceTimersByTimeAsync(150);

    rp.scheduleInit();
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    expect(feed.isConnected).toBe(true);
  });
});

describe('page math', () => {
  it('slices posts into pages of 25 and hides the rest', () => {
    const posts = [];
    for (let i = 0; i < 30; i++) posts.push(makePost('t3_' + i));
    rp.__setState({ posts, currentPage: 1 });

    expect(rp.totalKnownPages()).toBe(2);

    rp.applyVisibility();
    expect(posts[0].closest('article').style.display).toBe('');
    expect(posts[24].closest('article').style.display).toBe('');
    expect(posts[25].closest('article').style.display).toBe('none');
    expect(posts[29].closest('article').style.display).toBe('none');
  });
});

function makeFeed(postCount) {
  const feed = document.createElement('shreddit-feed');
  document.body.appendChild(feed);
  for (let i = 0; i < postCount; i++) {
    const article = document.createElement('article');
    const post = document.createElement('shreddit-post');
    post.id = 't3_' + i;
    article.appendChild(post);
    feed.appendChild(article);
  }
  const sentinel = document.createElement('faceplate-partial');
  sentinel.setAttribute('slot', 'load-after');
  feed.appendChild(sentinel);
  return feed;
}

describe('scheduleInit staleness guard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not re-init when the feed and its first post are unchanged', async () => {
    const feed = makeFeed(25);
    rp.__setState({ feed, posts: [feed.querySelector('#t3_0')], currentPage: 3 });

    vi.useFakeTimers();
    rp.scheduleInit();
    await vi.advanceTimersByTimeAsync(30 * 300);

    expect(rp.__getState()).toBeNull();
  });

  it('re-inits when the feed content has actually changed', async () => {
    const feed = makeFeed(25);
    const otherPost = document.createElement('shreddit-post');
    otherPost.id = 't3_old';
    rp.__setState({ feed, posts: [otherPost], currentPage: 3 });

    rp.scheduleInit();
    await Promise.resolve();
    await Promise.resolve();

    const state = rp.__getState();
    expect(state).not.toBeNull();
    expect(state.posts.length).toBe(25);
  });
});

describe('watchNavigation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats a query-string-only change as a navigation, not just a pathname change', async () => {
    const feed = makeFeed(25);
    const priorPost = document.createElement('shreddit-post');
    priorPost.id = 't3_old';
    rp.__setState({ feed, posts: [priorPost], currentPage: 3 });

    vi.useFakeTimers();
    rp.watchNavigation();
    window.history.pushState({}, '', location.pathname + '?sort=new');
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await Promise.resolve();
    await Promise.resolve();

    const state = rp.__getState();
    expect(state).not.toBeNull();
    expect(state.currentPage).toBe(1);
  });
});

describe('navigationType', () => {
  it('reads the type reported by the Navigation Timing API', () => {
    const original = performance.getEntriesByType;
    performance.getEntriesByType = () => [{ type: 'back_forward' }];
    expect(rp.navigationType()).toBe('back_forward');
    performance.getEntriesByType = original;
  });

  it('falls back to "navigate" if the check fails', () => {
    const original = performance.getEntriesByType;
    performance.getEntriesByType = () => {
      throw new Error('not supported');
    };
    expect(rp.navigationType()).toBe('navigate');
    performance.getEntriesByType = original;
  });
});

describe('back/forward restore via popstate', () => {
  it('restores the saved page on a popstate even though navigationType stays "navigate"', async () => {
    makeFeed(30);
    rp.__setPageSize(5);
    rp.__setState({ currentPage: 3 });
    rp.saveCurrentPage();
    rp.__setState(null);

    const original = performance.getEntriesByType;
    performance.getEntriesByType = () => [{ type: 'navigate' }];
    rp.__setSawPopState(true);

    rp.scheduleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(rp.__getState().currentPage).toBe(3);
    performance.getEntriesByType = original;
  });

  it('resets to page 1 on a normal forward navigation, with no popstate seen', async () => {
    makeFeed(30);
    rp.__setPageSize(5);
    rp.__setState({ currentPage: 3 });
    rp.saveCurrentPage();
    rp.__setState(null);

    const original = performance.getEntriesByType;
    performance.getEntriesByType = () => [{ type: 'navigate' }];

    rp.scheduleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(rp.__getState().currentPage).toBe(1);
    performance.getEntriesByType = original;
  });
});

describe('external style resets on tracked posts', () => {
  it('re-hides a post whose inline display gets cleared by something else', async () => {
    const feed = makeFeed(30);
    rp.__setPageSize(5);

    rp.scheduleInit();
    await Promise.resolve();
    await Promise.resolve();

    const hiddenPost = feed.querySelector('#t3_10');
    const wrapper = hiddenPost.closest('article');
    expect(wrapper.style.display).toBe('none');

    wrapper.style.display = '';
    await Promise.resolve();
    await Promise.resolve();

    expect(wrapper.style.display).toBe('none');
  });
});

describe('page size storage', () => {
  it('defaults to 25 when nothing is saved', () => {
    expect(rp.readSavedPageSize()).toBe(25);
  });

  it('round-trips a saved value', () => {
    rp.savePageSize(10);
    expect(rp.readSavedPageSize()).toBe(10);
  });

  it('falls back to 25 for a value outside the allowed options', () => {
    localStorage.setItem('reddit-paginate:pageSize', '999');
    expect(rp.readSavedPageSize()).toBe(25);
  });
});

describe('applyVisibility with page size', () => {
  it('shows only the first PAGE_SIZE posts on page 1', () => {
    const posts = Array.from({ length: 12 }, (_, i) => makePost('t3_' + i));
    rp.__setPageSize(5);
    rp.__setState({ posts, currentPage: 1 });
    rp.applyVisibility();

    const visible = posts.filter((p) => rp.wrapperOf(p).style.display !== 'none');
    expect(visible.map((p) => p.id)).toEqual(['t3_0', 't3_1', 't3_2', 't3_3', 't3_4']);
  });

  it('changes how many posts are visible when the page size changes', () => {
    const posts = Array.from({ length: 12 }, (_, i) => makePost('t3_' + i));
    rp.__setState({ posts, currentPage: 1 });

    rp.__setPageSize(5);
    rp.applyVisibility();
    expect(posts.filter((p) => rp.wrapperOf(p).style.display !== 'none')).toHaveLength(5);

    rp.__setPageSize(10);
    rp.applyVisibility();
    expect(posts.filter((p) => rp.wrapperOf(p).style.display !== 'none')).toHaveLength(10);
  });
});

describe('applyPageSizeChange', () => {
  it('updates PAGE_SIZE, persists it, and actually changes how many posts show in the feed', async () => {
    const posts = Array.from({ length: 25 }, (_, i) => makePost('t3_' + i));
    rp.__setState({
      posts,
      currentPage: 1,
      hasMore: false,
      loading: false,
      bar: null,
      feed: document.body,
    });

    await rp.applyPageSizeChange(5);

    expect(rp.__getPageSize()).toBe(5);
    expect(rp.readSavedPageSize()).toBe(5);
    const visible = posts.filter((p) => rp.wrapperOf(p).style.display !== 'none');
    expect(visible).toHaveLength(5);
  });

  it('does nothing when the requested size matches the current one', async () => {
    rp.__setState({ posts: [], currentPage: 1 });
    rp.__setPageSize(10);
    await rp.applyPageSizeChange(10);
    expect(rp.__getPageSize()).toBe(10);
  });
});

describe('ensurePageSizeControl', () => {
  it('attaches next to the View dropdown, not the Sort dropdown', () => {
    makeSortDropdown('Sort by', 'feed-sort-change');
    const view = makeSortDropdown('View', 'layout-view-change');

    rp.ensurePageSizeControl();

    const sortParent = document.querySelectorAll('shreddit-sort-dropdown')[0].parentElement;
    expect(sortParent.querySelector('[data-reddit-paginate="page-size"]')).toBeNull();
    expect(view.parentElement.querySelector('[data-reddit-paginate="page-size"]')).not.toBeNull();
  });

  it('does not insert a second control next to the same dropdown', () => {
    const view = makeSortDropdown('View', 'layout-view-change');
    rp.ensurePageSizeControl();
    rp.ensurePageSizeControl();
    expect(view.parentElement.querySelectorAll('[data-reddit-paginate="page-size"]')).toHaveLength(1);
  });

  it('inserts a control next to every View dropdown when Reddit renders more than one', () => {
    const viewA = makeSortDropdown('View', 'layout-view-change');
    const viewB = makeSortDropdown('View', 'layout-view-change');

    rp.ensurePageSizeControl();

    expect(viewA.parentElement.querySelector('[data-reddit-paginate="page-size"]')).not.toBeNull();
    expect(viewB.parentElement.querySelector('[data-reddit-paginate="page-size"]')).not.toBeNull();
  });
});

describe('schedulePageSizeControl', () => {
  it('re-inserts the control after the View dropdown is replaced (SPA navigation)', async () => {
    const view = makeSortDropdown('View', 'layout-view-change');
    rp.schedulePageSizeControl();
    expect(view.parentElement.querySelector('[data-reddit-paginate="page-size"]')).not.toBeNull();

    const parent = view.parentElement;
    parent.removeChild(view);
    const replacement = document.createElement('shreddit-sort-dropdown');
    replacement.setAttribute('header-text', 'View');
    replacement.setAttribute('sort-event', 'layout-view-change');
    parent.appendChild(replacement);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(parent.querySelector('[data-reddit-paginate="page-size"]')).not.toBeNull();
  });
});
