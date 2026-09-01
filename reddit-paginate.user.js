// ==UserScript==
// @name         Reddit Remove Infinite Scroll
// @namespace    https://github.com/cantunborn
// @version      1.25
// @description  Replace infinite scroll with Old Reddit style pagination (25 posts per page) on Reddit feeds.
// @author       cantunborn
// @license      MIT
// @homepageURL  https://github.com/cantunborn/userscripts
// @supportURL   https://github.com/cantunborn/userscripts/issues
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzAiIGZpbGw9IiMxYTFhMWIiLz4KICA8dGV4dCB4PSIzMiIgeT0iMzIiIGZvbnQtc2l6ZT0iNjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJjZW50cmFsIiBmaWxsPSIjZmY0NTAwIiBmb250LWZhbWlseT0iQXJpYWwsIEhlbHZldGljYSwgc2Fucy1zZXJpZiIgZm9udC13ZWlnaHQ9ImJvbGQiPiYjODczNDs8L3RleHQ+CiAgPGxpbmUgeDE9IjEwIiB5MT0iNTQiIHgyPSI1NCIgeTI9IjEwIiBzdHJva2U9IiNmZjQ1MDAiIHN0cm9rZS13aWR0aD0iNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+Cjwvc3ZnPgo=
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/cantunborn/userscripts/main/reddit-paginate.user.js
// @updateURL    https://raw.githubusercontent.com/cantunborn/userscripts/main/reddit-paginate.user.js
// ==/UserScript==

(function () {
  'use strict';

  function log(...args) {
    console.log('[rp]', ...args);
  }

  function isBlockedSentinel(el) {
    return !!(el && el.tagName === 'FACEPLATE-PARTIAL' && el.getAttribute('slot') === 'load-after');
  }

  function fakeHiddenEntry(entry) {
    return {
      isIntersecting: false,
      intersectionRatio: 0,
      target: entry.target,
      time: entry.time,
      boundingClientRect: entry.boundingClientRect,
      intersectionRect: entry.intersectionRect,
      rootBounds: entry.rootBounds,
    };
  }

  const NativeIntersectionObserver = window.IntersectionObserver;
  if (NativeIntersectionObserver) {
    window.IntersectionObserver = function (callback, options) {
      function wrappedCallback(entries, observer) {
        const patched = entries.map((e) => {
          if (!isBlockedSentinel(e.target)) return e;
          return fakeHiddenEntry(e);
        });
        callback(patched, observer);
      }
      return new NativeIntersectionObserver(wrappedCallback, options);
    };
    window.IntersectionObserver.prototype = NativeIntersectionObserver.prototype;
  }

  const PAGE_SIZE_OPTIONS = [5, 10, 15, 20, 25];
  const PAGE_SIZE_STORAGE_KEY = 'reddit-paginate:pageSize';

  function readSavedPageSize() {
    try {
      const n = parseInt(localStorage.getItem(PAGE_SIZE_STORAGE_KEY), 10);
      return PAGE_SIZE_OPTIONS.includes(n) ? n : 25;
    } catch (err) {
      log('readSavedPageSize: failed', err);
      return 25;
    }
  }

  function savePageSize(n) {
    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(n));
    } catch (err) {
      log('savePageSize: failed', err);
    }
  }

  let PAGE_SIZE = readSavedPageSize();
  const LOAD_TIMEOUT_MS = 8000;

  let state = null;
  let lastPath = null;
  let sawPopState = false;
  let initGeneration = 0;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CARET_LEFT_PATH = 'M6.3 10c0-.23.088-.46.264-.636l4.6-4.6a.9.9 0 111.273 1.272L8.474 10l3.963 3.964a.9.9 0 01-1.273 1.272l-4.6-4.6A.897.897 0 016.3 10Z';
  const CARET_RIGHT_PATH = 'M13.7 10c0 .23-.088.46-.264.636l-4.6 4.6a.9.9 0 11-1.273-1.272L11.526 10 7.563 6.036a.9.9 0 011.273-1.272l4.6 4.6A.897.897 0 0113.7 10Z';
  const CARET_DOWN_PATH = 'M10 13.7a.897.897 0 01-.636-.264l-4.6-4.6a.9.9 0 111.272-1.273L10 11.526l3.964-3.963a.9.9 0 011.272 1.273l-4.6 4.6A.897.897 0 0110 13.7Z';

  function makeCaretIcon(path) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('height', '16');
    svg.setAttribute('width', '16');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.style.flexShrink = '0';
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.setAttribute('d', path);
    svg.appendChild(pathEl);
    return svg;
  }

  function isListingPath(pathname) {
    if (/\/comments\//.test(pathname)) return false;
    if (/^\/(message|settings|submit|premium|chat)/.test(pathname)) return false;
    return true;
  }

  const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;

  function navigationType() {
    try {
      const entries = performance.getEntriesByType('navigation');
      if (entries.length) return entries[0].type;
    } catch (err) {
      log('navigationType: check failed', err);
    }
    return 'navigate';
  }

  function storageKeySuffix() {
    return location.pathname + location.search;
  }

  function pageStorageKey() {
    return 'reddit-paginate:page:' + storageKeySuffix();
  }

  function snapshotStorageKey() {
    return 'reddit-paginate:snapshot:' + storageKeySuffix();
  }

  function saveCurrentPage() {
    try {
      sessionStorage.setItem(pageStorageKey(), String(state.currentPage));
    } catch (err) {
      log('saveCurrentPage: failed', err);
    }
  }

  function readSavedPage() {
    try {
      const raw = sessionStorage.getItem(pageStorageKey());
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 1 ? n : null;
    } catch (err) {
      log('readSavedPage: failed', err);
      return null;
    }
  }

  function loadSnapshot() {
    try {
      const raw = sessionStorage.getItem(snapshotStorageKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      log('loadSnapshot: failed', err);
      return [];
    }
  }

  function appendToSnapshot(post) {
    const key = snapshotStorageKey();
    const entries = loadSnapshot();
    const wrapper = wrapperOf(post);
    const sib = wrapper.nextElementSibling;
    const hrHtml = sib && sib.tagName === 'HR' ? sib.outerHTML : '';
    entries.push({ id: post.id, html: wrapper.outerHTML + hrHtml });
    let serialized = JSON.stringify(entries);
    while (serialized.length > MAX_SNAPSHOT_BYTES && entries.length > 1) {
      entries.shift();
      serialized = JSON.stringify(entries);
    }
    try {
      sessionStorage.setItem(key, serialized);
    } catch (err) {
      log('appendToSnapshot: storage quota exceeded, leaving earlier snapshot in place', err);
    }
  }

  function clearSnapshot() {
    try {
      sessionStorage.removeItem(snapshotStorageKey());
    } catch (err) {
      log('clearSnapshot: failed', err);
    }
  }

  function restoreFromSnapshot(feed) {
    const entries = loadSnapshot();
    if (!entries.length) return null;

    const template = document.createElement('template');
    const restoredWrappers = [];
    const restoredPosts = [];
    let referenceHrHtml = null;
    for (const entry of entries) {
      template.innerHTML = entry.html;
      const wrapper = template.content.firstElementChild;
      if (!wrapper) continue;
      const post = wrapper.matches('shreddit-post') ? wrapper : wrapper.querySelector('shreddit-post');
      if (!post) continue;
      const hrSib = wrapper.nextElementSibling;
      const hr = hrSib && hrSib.tagName === 'HR' ? hrSib : null;
      if (hr && !referenceHrHtml) referenceHrHtml = hr.outerHTML;
      restoredWrappers.push({ wrapper, hr });
      restoredPosts.push(post);
    }
    if (!restoredPosts.length) return null;

    restoredWrappers.forEach((entry, i) => {
      if (entry.hr || i === restoredWrappers.length - 1) return;
      const hrTemplate = document.createElement('template');
      hrTemplate.innerHTML = referenceHrHtml || '<hr>';
      entry.hr = hrTemplate.content.firstElementChild;
    });

    feed.querySelectorAll('shreddit-post').forEach((p) => {
      const wrapper = wrapperOf(p);
      const sib = wrapper.nextElementSibling;
      if (sib && sib.tagName === 'HR') sib.remove();
      wrapper.remove();
    });

    const sentinel = feed.querySelector('faceplate-partial[slot="load-after"]');
    restoredWrappers.forEach(({ wrapper, hr }) => {
      if (sentinel) {
        sentinel.insertAdjacentElement('beforebegin', wrapper);
        if (hr) sentinel.insertAdjacentElement('beforebegin', hr);
      } else {
        feed.appendChild(wrapper);
        if (hr) feed.appendChild(hr);
      }
    });
    return restoredPosts;
  }

  function wrapperOf(post) {
    return post.closest('article') || post;
  }

  function setVisible(post, visible) {
    const wrapper = wrapperOf(post);
    wrapper.style.display = visible ? '' : 'none';
    const sib = wrapper.nextElementSibling;
    if (sib && sib.tagName === 'HR') sib.style.display = visible ? '' : 'none';
  }

  function teardown() {
    if (state) {
      if (state.observer) state.observer.disconnect();
      if (state.pendingTimer) clearTimeout(state.pendingTimer);
      if (state.pendingResolve) state.pendingResolve();
      if (state.bar) state.bar.remove();
      const sentinel = findSentinel();
      if (sentinel) sentinel.style.removeProperty('display');
      state.posts.forEach((p) => {
        p.style.removeProperty('display');
        const sib = wrapperOf(p).nextElementSibling;
        if (sib && sib.tagName === 'HR') sib.style.removeProperty('display');
      });
    }
    state = null;
  }

  function scheduleInit() {
    const generation = ++initGeneration;
    const prevFeed = state ? state.feed : null;
    const prevFirstPostId = state && state.posts[0] ? state.posts[0].id : null;
    teardown();
    if (!isListingPath(location.pathname)) return;
    schedulePageSizeControl();

    let tries = 0;
    const tryInit = () => {
      if (generation !== initGeneration) {
        log('scheduleInit: superseded by a newer call, aborting');
        return;
      }
      const feed = document.querySelector('shreddit-feed');
      const posts = feed ? Array.from(feed.querySelectorAll('shreddit-post')) : [];
      const stale = feed && feed === prevFeed && posts[0] && posts[0].id === prevFirstPostId;
      if (feed && posts.length > 0 && !stale) {
        init(feed, posts, generation);
        return;
      }
      tries++;
      if (tries < 30) {
        setTimeout(tryInit, 300);
      } else {
        log('scheduleInit: gave up after', tries, 'tries, feed:', !!feed, 'posts:', posts.length);
      }
    };
    tryInit();
  }

  async function init(feed, posts, generation) {
    log('init: starting with', posts.length, 'posts');
    const navType = navigationType() === 'back_forward' || sawPopState ? 'back_forward' : 'navigate';
    sawPopState = false;

    state = {
      feed,
      posts: [],
      currentPage: 1,
      hasMore: true,
      loading: false,
      pendingTimer: null,
      pendingResolve: null,
      bar: null,
      observer: null,
    };

    log('init: navType is', navType, 'live posts seen so far', posts.length);
    const restoredPosts = navType === 'back_forward' ? restoreFromSnapshot(feed) : null;
    log('init: restoreFromSnapshot returned', restoredPosts ? restoredPosts.length + ' posts' : 'null');
    if (!restoredPosts) {
      clearSnapshot();
      posts.forEach((p) => registerPost(p));
    } else {
      state.posts = restoredPosts;
    }

    state.observer = new MutationObserver((mutations) => {
      let added = false;
      let styleReset = false;
      for (const m of mutations) {
        if (m.type === 'attributes') {
          styleReset = true;
          continue;
        }
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SHREDDIT-POST') {
            if (registerPost(node)) added = true;
            else discardDuplicatePost(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('shreddit-post').forEach((p) => {
              if (registerPost(p)) added = true;
              else discardDuplicatePost(p);
            });
          }
        }
      }
      if (added) {
        applyVisibility();
        if (state.pendingResolve) {
          clearTimeout(state.pendingTimer);
          const resolve = state.pendingResolve;
          state.pendingResolve = null;
          resolve();
        }
      } else if (styleReset && visibilityIsStale()) {
        log('observer: external style reset detected on a tracked post, re-applying visibility');
        applyVisibility();
      }
    });
    state.observer.observe(feed, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });

    const savedPage = navType === 'back_forward' ? readSavedPage() : null;
    const target = savedPage || 1;
    state.currentPage = target;
    applyVisibility();
    log('init: savedPage is', savedPage, 'target is', target);
    await ensureLoadedThrough(target);
    if (generation !== initGeneration) {
      log('init: superseded during load, aborting');
      return;
    }
    if (state.posts.length <= (target - 1) * PAGE_SIZE) {
      state.currentPage = 1;
    }
    log('init: done, currentPage is', state.currentPage, 'total posts', state.posts.length);
    reflow();
  }

  function registerPost(node) {
    if (!state || state.posts.some((p) => p.id === node.id)) return false;
    state.posts.push(node);
    appendToSnapshot(node);
    return true;
  }

  function discardDuplicatePost(node) {
    if (!state || state.posts.includes(node)) return;
    const wrapper = wrapperOf(node);
    const sib = wrapper.nextElementSibling;
    if (sib && sib.tagName === 'HR') sib.remove();
    wrapper.remove();
  }

  function totalKnownPages() {
    return Math.max(1, Math.ceil(state.posts.length / PAGE_SIZE));
  }

  function applyVisibility() {
    const start = (state.currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    state.posts.forEach((p, i) => setVisible(p, i >= start && i < end));
  }

  function visibilityIsStale() {
    const start = (state.currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    return state.posts.some((p, i) => {
      const shouldBeVisible = i >= start && i < end;
      const isHidden = wrapperOf(p).style.display === 'none';
      return shouldBeVisible === isHidden;
    });
  }

  function reflow() {
    applyVisibility();
    renderBars();
  }

  function findSentinel() {
    const matches = Array.from(state.feed.querySelectorAll('faceplate-partial[slot="load-after"]'));
    if (matches.length > 1) {
      log('findSentinel: found', matches.length, 'sentinels');
    }
    for (let i = matches.length - 1; i >= 0; i--) {
      if (typeof matches[i].loadContent === 'function') return matches[i];
    }
    return null;
  }

  function getDividerBox() {
    const hr = state.feed.querySelector('article + hr') || state.feed.querySelector('hr');
    if (!hr) return null;
    const cs = getComputedStyle(hr);
    return { width: cs.width, marginLeft: cs.marginLeft, marginRight: cs.marginRight };
  }

  function applyDividerBox(el, box) {
    if (!box) return;
    el.style.width = box.width;
    el.style.marginLeft = box.marginLeft;
    el.style.marginRight = box.marginRight;
    el.style.maxWidth = 'none';
  }

  function positionBars() {
    const box = getDividerBox();

    const lastPost = state.posts[state.posts.length - 1];
    const bottomWrapper = lastPost ? wrapperOf(lastPost) : null;
    if (bottomWrapper) {
      bottomWrapper.insertAdjacentElement('afterend', state.bar);
      applyDividerBox(state.bar, box);
    } else {
      state.feed.appendChild(state.bar);
    }
    hideTrailingElements();
  }

  function hideTrailingElements() {
    if (!state.bar || !state.bar.isConnected) return;
    let sib = state.bar.nextElementSibling;
    while (sib) {
      sib.style.display = 'none';
      sib = sib.nextElementSibling;
    }
  }

  function waitForMorePosts(timeoutMs) {
    return new Promise((resolve) => {
      state.pendingResolve = resolve;
      state.pendingTimer = setTimeout(() => {
        state.pendingResolve = null;
        resolve();
      }, timeoutMs);
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function findSentinelWithRetry(tries, delayMs) {
    for (let i = 0; i < tries; i++) {
      if (!state) return null;
      const sentinel = findSentinel();
      if (sentinel) return sentinel;
      await sleep(delayMs);
    }
    return null;
  }

  async function requestNextBatch() {
    const sentinel = await findSentinelWithRetry(10, 100);
    if (!state) return;
    if (!sentinel) {
      log('requestNextBatch: no upgraded sentinel found after retrying, stopping');
      state.hasMore = false;
      return;
    }
    const before = state.posts.length;
    log('requestNextBatch: calling loadContent on', sentinel.id, 'before count', before);
    const waitPromise = waitForMorePosts(LOAD_TIMEOUT_MS);
    try {
      sentinel.loadContent();
    } catch (err) {
      log('requestNextBatch: loadContent threw', err);
    }
    await waitPromise;
    if (!state) return;
    log('requestNextBatch: after count', state.posts.length);
    if (state.posts.length === before) {
      log('requestNextBatch: count unchanged, marking hasMore false');
      state.hasMore = false;
    }
  }

  async function ensureLoadedThrough(page) {
    const needed = page * PAGE_SIZE;
    while (state && state.posts.length < needed && state.hasMore) {
      state.loading = true;
      renderBars();
      await requestNextBatch();
    }
    if (!state) return;
    state.loading = false;
    log('ensureLoadedThrough: done, have', state.posts.length, 'hasMore', state.hasMore);
  }

  function makeButton(label, enabled, onClick) {
    const el = document.createElement('button');
    el.type = 'button';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'flex items-center gap-xs';
    labelSpan.textContent = label;
    el.appendChild(labelSpan);
    el.className = 'button button-small leading-none inline-flex items-center px-sm py-xs button-secondary';
    el.style.fontSize = 'var(--font-label-2-size, 12px)';
    if (!enabled) {
      el.disabled = true;
    } else {
      el.addEventListener('click', onClick);
    }
    return el;
  }

  function wrapIcon(svg, leading) {
    const wrap = document.createElement('span');
    wrap.className = leading ? 'flex me-2xs ms-[-2px]' : 'flex ms-2xs me-[-2px]';
    wrap.appendChild(svg);
    return wrap;
  }

  function buildPageLabel() {
    const el = document.createElement('span');
    el.className = 'whitespace-nowrap text-neutral-content-weak flex items-center';
    el.textContent = 'page ' + state.currentPage;
    return el;
  }

  function buildBarContents(barEl) {
    barEl.innerHTML = '';

    const prevBtn = makeButton('prev', state.currentPage > 1, goPrev);
    prevBtn.insertBefore(wrapIcon(makeCaretIcon(CARET_LEFT_PATH), true), prevBtn.firstChild);
    barEl.appendChild(prevBtn);

    barEl.appendChild(buildPageLabel());

    const canAdvance = state.hasMore || state.posts.length > state.currentPage * PAGE_SIZE;
    const nextBtn = makeButton(
      state.loading ? 'loading…' : 'next',
      canAdvance && !state.loading,
      goNext
    );
    if (!state.loading) {
      nextBtn.appendChild(wrapIcon(makeCaretIcon(CARET_RIGHT_PATH), false));
    }
    barEl.appendChild(nextBtn);

    if (!canAdvance) {
      const end = document.createElement('span');
      end.textContent = 'end of feed';
      applyEndLabelStyles(end);
      barEl.appendChild(end);
    }
  }

  function renderBars() {
    if (!state.bar) {
      state.bar = document.createElement('div');
      state.bar.setAttribute('data-reddit-paginate', 'bar');
      state.bar.className = 'gap-xs';
      applyBarStyles(state.bar);
    }
    positionBars();
    buildBarContents(state.bar);
  }

  function scrollToTopOfFeed() {
    const top = state.feed.getBoundingClientRect().top + window.scrollY - 8;
    window.scrollTo({ top, behavior: 'instant' });
  }

  function goPrev() {
    if (state.currentPage <= 1) return;
    state.currentPage--;
    saveCurrentPage();
    reflow();
    scrollToTopOfFeed();
  }

  async function goNext() {
    if (state.loading) return;
    const target = state.currentPage + 1;
    await ensureLoadedThrough(target);

    if (state.posts.length > (target - 1) * PAGE_SIZE) {
      state.currentPage = target;
      saveCurrentPage();
    }
    reflow();
    scrollToTopOfFeed();
  }

  let pageSizeMenuOpen = null;

  function closePageSizeMenu() {
    if (!pageSizeMenuOpen) return;
    pageSizeMenuOpen.menu.style.display = 'none';
    pageSizeMenuOpen.button.setAttribute('aria-expanded', 'false');
    pageSizeMenuOpen = null;
  }

  document.addEventListener('click', (e) => {
    if (pageSizeMenuOpen && !pageSizeMenuOpen.wrapper.contains(e.target)) closePageSizeMenu();
  });

  const pageSizeLabels = new Set();
  const pageSizeRows = new Set();

  function applyPageSizeChange(newSize) {
    if (newSize === PAGE_SIZE) return;
    const firstVisibleIndex = state ? (state.currentPage - 1) * PAGE_SIZE : 0;
    PAGE_SIZE = newSize;
    savePageSize(newSize);
    pageSizeLabels.forEach((el) => {
      if (!el.isConnected) {
        pageSizeLabels.delete(el);
        return;
      }
      el.textContent = PAGE_SIZE + ' per page';
    });
    pageSizeRows.forEach((row) => {
      if (!row.isConnected) {
        pageSizeRows.delete(row);
        return;
      }
      const selected = Number(row.dataset.pageSize) === PAGE_SIZE;
      row.classList.toggle('bg-neutral-background-selected', selected);
      row.classList.toggle('hover:bg-neutral-background-selected', selected);
      row.classList.toggle('hover:text-secondary-plain-hover', !selected);
      row.classList.toggle('active:bg-interactive-pressed', !selected);
      row.parentElement.toggleAttribute('rpl-selected', selected);
    });
    if (!state) return;
    const target = Math.floor(firstVisibleIndex / PAGE_SIZE) + 1;
    ensureLoadedThrough(target).then(() => {
      if (state.posts.length > (target - 1) * PAGE_SIZE) {
        state.currentPage = target;
        saveCurrentPage();
      }
      reflow();
    });
  }

  function buildPageSizeMenuItem(size) {
    const li = document.createElement('li');
    li.className = 'relative list-none mt-0';
    li.setAttribute('role', 'presentation');
    if (size === PAGE_SIZE) li.setAttribute('rpl-selected', '');
    const row = document.createElement('a');
    const selected = size === PAGE_SIZE;
    row.className =
      'flex justify-between relative px-md gap-xs text-secondary-plain' +
      (selected
        ? ' bg-neutral-background-selected hover:bg-neutral-background-selected'
        : ' hover:text-secondary-plain-hover active:bg-interactive-pressed') +
      ' hover:bg-neutral-background-hover hover:no-underline cursor-pointer py-xs -outline-offset-1 no-underline';
    row.style.paddingInlineEnd = '16px';
    row.tabIndex = -1;
    row.dataset.pageSize = size;
    pageSizeRows.add(row);
    const text = document.createElement('span');
    text.className = 'flex flex-col justify-center min-w-0 shrink py-[0.375rem]';
    const textInner = document.createElement('span');
    textInner.className = 'text-body-2';
    textInner.textContent = size + ' per page';
    text.appendChild(textInner);
    row.appendChild(text);
    row.addEventListener('click', (e) => {
      e.preventDefault();
      applyPageSizeChange(size);
      closePageSizeMenu();
    });
    li.appendChild(row);
    return li;
  }

  function buildPageSizeControl() {
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-flex';
    wrapper.setAttribute('data-reddit-paginate', 'page-size');

    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      'text-neutral-content-weak button-small px-[calc(var(--rem10)-var(--button-border-width,0px))] button-plain items-center justify-center button inline-flex';
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Posts per page');

    const label = document.createElement('span');
    label.className = 'flex items-center gap-xs';
    label.textContent = PAGE_SIZE + ' per page';
    pageSizeLabels.add(label);
    button.appendChild(label);
    button.appendChild(wrapIcon(makeCaretIcon(CARET_DOWN_PATH), false));

    const menu = document.createElement('ul');
    menu.setAttribute('role', 'menu');
    menu.className = 'overflow-y-auto max-h-[50vh]';
    menu.style.cssText =
      'display:none;position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:4px;min-width:140px;' +
      'background:var(--color-neutral-background,#fff);border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.2);' +
      'z-index:100;padding:4px 0;list-style:none;';
    const header = document.createElement('div');
    header.className = 'font-semibold m-md mb-xs';
    header.textContent = 'Posts count';
    menu.appendChild(header);

    PAGE_SIZE_OPTIONS.forEach((size) => menu.appendChild(buildPageSizeMenuItem(size)));

    const tooltip = document.createElement('rpl-tooltip');
    tooltip.setAttribute('appearance', 'inverted');
    tooltip.setAttribute('trigger', 'hover focus-visible');
    tooltip.setAttribute('placement', 'bottom');

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = pageSizeMenuOpen && pageSizeMenuOpen.wrapper === wrapper;
      closePageSizeMenu();
      if (!isOpen) {
        menu.style.display = 'block';
        button.setAttribute('aria-expanded', 'true');
        pageSizeMenuOpen = { wrapper, menu, button };
      }
    });

    tooltip.appendChild(button);
    const tooltipContent = document.createElement('span');
    tooltipContent.setAttribute('slot', 'content');
    tooltipContent.textContent = 'Change number of posts in feed';
    tooltip.appendChild(tooltipContent);

    wrapper.appendChild(tooltip);
    wrapper.appendChild(menu);
    return wrapper;
  }

  function ensurePageSizeControl() {
    const viewDropdowns = document.querySelectorAll('shreddit-sort-dropdown[sort-event="layout-view-change"]');
    viewDropdowns.forEach((viewDropdown) => {
      const parent = viewDropdown.parentElement;
      if (!parent) return;
      if (parent.querySelector(':scope > [data-reddit-paginate="page-size"]')) return;
      parent.appendChild(buildPageSizeControl());
    });
  }

  let pageSizeControlObserver = null;

  function schedulePageSizeControl() {
    ensurePageSizeControl();
    if (pageSizeControlObserver) return;
    pageSizeControlObserver = new MutationObserver(() => ensurePageSizeControl());
    pageSizeControlObserver.observe(document.body, { childList: true, subtree: true });
  }

  function applyBarStyles(el) {
    el.style.display = 'flex';
    el.style.flexWrap = 'nowrap';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.width = '100%';
    el.style.maxWidth = '100%';
    el.style.boxSizing = 'border-box';
    el.style.padding = '16px 8px';
    el.style.fontFamily = 'inherit';
    el.style.fontSize = 'var(--font-label-2-size, 14px)';
  }

  function applyEndLabelStyles(el) {
    el.style.marginLeft = '8px';
    el.style.color = 'var(--rp-fg-disabled)';
    el.style.fontSize = 'var(--font-label-2-size, 13px)';
  }

  function injectThemeVars() {
    if (document.getElementById('reddit-paginate-vars')) return;
    const style = document.createElement('style');
    style.id = 'reddit-paginate-vars';
    style.textContent = `
      :root {
        --rp-fg-disabled: var(--color-neutral-content-weak, #9b9ba1);
      }
      faceplate-partial[slot="load-after"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function watchNavigation() {
    lastPath = location.pathname + location.search;
    setInterval(() => {
      const currentPath = location.pathname + location.search;
      const pathChanged = currentPath !== lastPath;
      const feedGone = state && !state.feed.isConnected;
      if (pathChanged || feedGone) {
        lastPath = currentPath;
        scheduleInit();
      }
    }, 500);
  }

  function start() {
    injectThemeVars();
    window.addEventListener('popstate', () => {
      sawPopState = true;
    });
    scheduleInit();
    watchNavigation();
  }

  if (typeof module !== 'undefined' && module.exports) {
    // Test-only export. A userscript manager never defines `module`, so this
    // branch never runs in the browser, and `start()` never auto-runs under test.
    module.exports = {
      PAGE_SIZE,
      MAX_SNAPSHOT_BYTES,
      navigationType,
      pageStorageKey,
      snapshotStorageKey,
      saveCurrentPage,
      readSavedPage,
      loadSnapshot,
      appendToSnapshot,
      clearSnapshot,
      restoreFromSnapshot,
      registerPost,
      discardDuplicatePost,
      scheduleInit,
      watchNavigation,
      totalKnownPages,
      applyVisibility,
      wrapperOf,
      PAGE_SIZE_OPTIONS,
      readSavedPageSize,
      savePageSize,
      applyPageSizeChange,
      ensurePageSizeControl,
      schedulePageSizeControl,
      requestNextBatch,
      __setState: (s) => { state = s; },
      __getState: () => state,
      __setPageSize: (n) => { PAGE_SIZE = n; },
      __getPageSize: () => PAGE_SIZE,
      __setSawPopState: (v) => { sawPopState = v; },
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();