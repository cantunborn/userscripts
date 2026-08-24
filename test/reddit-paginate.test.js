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

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = '';
  window.history.pushState({}, '', '/r/test/');
  rp.__setState(null);
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
