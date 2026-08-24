// ==UserScript==
// @name         Reddit Remove Infinite Scroll
// @namespace    https://github.com/cantunborn
// @version      1.16
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

  const PAGE_SIZE = 25;
  const LOAD_TIMEOUT_MS = 8000;

  let state = null;
  let lastPath = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CARET_LEFT_PATH = 'M6.3 10c0-.23.088-.46.264-.636l4.6-4.6a.9.9 0 111.273 1.272L8.474 10l3.963 3.964a.9.9 0 01-1.273 1.272l-4.6-4.6A.897.897 0 016.3 10Z';
  const CARET_RIGHT_PATH = 'M13.7 10c0 .23-.088.46-.264.636l-4.6 4.6a.9.9 0 11-1.273-1.272L11.526 10 7.563 6.036a.9.9 0 011.273-1.272l4.6 4.6A.897.897 0 0113.7 10Z';

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
    entries.push({ id: post.id, html: wrapperOf(post).outerHTML });
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
    for (const entry of entries) {
      template.innerHTML = entry.html;
      const wrapper = template.content.firstElementChild;
      if (!wrapper) continue;
      const post = wrapper.matches('shreddit-post') ? wrapper : wrapper.querySelector('shreddit-post');
      if (!post) continue;
      restoredWrappers.push(wrapper);
      restoredPosts.push(post);
    }
    if (!restoredPosts.length) return null;

    feed.querySelectorAll('shreddit-post').forEach((p) => wrapperOf(p).remove());

    const sentinel = feed.querySelector('faceplate-partial[slot="load-after"]');
    restoredWrappers.forEach((wrapper) => {
      if (sentinel) sentinel.insertAdjacentElement('beforebegin', wrapper);
      else feed.appendChild(wrapper);
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
    const prevFeed = state ? state.feed : null;
    const prevFirstPostId = state && state.posts[0] ? state.posts[0].id : null;
    teardown();
    if (!isListingPath(location.pathname)) return;

    let tries = 0;
    const tryInit = () => {
      const feed = document.querySelector('shreddit-feed');
      const posts = feed ? Array.from(feed.querySelectorAll('shreddit-post')) : [];
      const stale = feed && feed === prevFeed && posts[0] && posts[0].id === prevFirstPostId;
      if (feed && posts.length > 0 && !stale) {
        init(feed, posts);
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

  async function init(feed, posts) {
    log('init: starting with', posts.length, 'posts');
    const navType = navigationType();

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
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SHREDDIT-POST') {
            if (registerPost(node)) added = true;
          } else if (node.querySelectorAll) {
            node.querySelectorAll('shreddit-post').forEach((p) => {
              if (registerPost(p)) added = true;
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
      }
    });
    state.observer.observe(feed, { childList: true, subtree: true });

    const savedPage = navType === 'back_forward' ? readSavedPage() : null;
    const target = savedPage || 1;
    log('init: savedPage is', savedPage, 'target is', target);
    await ensureLoadedThrough(target);
    if (state.posts.length > (target - 1) * PAGE_SIZE) {
      state.currentPage = target;
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

  function totalKnownPages() {
    return Math.max(1, Math.ceil(state.posts.length / PAGE_SIZE));
  }

  function applyVisibility() {
    const start = (state.currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    state.posts.forEach((p, i) => setVisible(p, i >= start && i < end));
  }

  function reflow() {
    applyVisibility();
    renderBars();
  }

  function findSentinel() {
    const matches = state.feed.querySelectorAll('faceplate-partial[slot="load-after"]');
    if (matches.length > 1) {
      log('findSentinel: found', matches.length, 'sentinels, using last:', matches[matches.length - 1].id);
    }
    return matches.length ? matches[matches.length - 1] : null;
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

  async function requestNextBatch() {
    const sentinel = findSentinel();
    if (!sentinel) {
      log('requestNextBatch: no sentinel found, stopping');
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
    log('requestNextBatch: after count', state.posts.length);
    if (state.posts.length === before) {
      log('requestNextBatch: count unchanged, marking hasMore false');
      state.hasMore = false;
    }
  }

  async function ensureLoadedThrough(page) {
    const needed = page * PAGE_SIZE;
    while (state.posts.length < needed && state.hasMore) {
      state.loading = true;
      renderBars();
      await requestNextBatch();
    }
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
      scheduleInit,
      watchNavigation,
      totalKnownPages,
      applyVisibility,
      wrapperOf,
      __setState: (s) => { state = s; },
      __getState: () => state,
    };
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();