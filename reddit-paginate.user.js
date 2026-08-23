// ==UserScript==
// @name         Reddit Remove Infinite Scroll
// @namespace    reddit-paginate
// @version      1.14.10
// @description  Replace infinite scroll with Google-style numbered pages (25 posts per page) on Reddit feeds.
// @match        https://www.reddit.com/*
// @run-at       document-start
// @grant        none
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

  const PAGE_SIZE = 25;
  const LOAD_TIMEOUT_MS = 8000;

  let state = null;
  let lastPath = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CARET_PATH = 'M10 13.7a.897.897 0 01-.636-.264l-4.6-4.6a.9.9 0 111.272-1.273L10 11.526l3.964-3.963a.9.9 0 011.272 1.273l-4.6 4.6A.897.897 0 0110 13.7Z';

  function makeCaretIcon(rotateDeg) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('height', '16');
    svg.setAttribute('width', '16');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.style.transform = `rotate(${rotateDeg}deg)`;
    svg.style.flexShrink = '0';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', CARET_PATH);
    svg.appendChild(path);
    return svg;
  }

  function isListingPath(pathname) {
    if (/\/comments\//.test(pathname)) return false;
    if (/^\/(message|settings|submit|premium|chat)/.test(pathname)) return false;
    return true;
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
      if (state.topBar) state.topBar.remove();
      document.removeEventListener('click', onOutsidePopupClick, true);
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
    teardown();
    if (!isListingPath(location.pathname)) return;

    let tries = 0;
    const tryInit = () => {
      const feed = document.querySelector('shreddit-feed');
      const posts = feed ? Array.from(feed.querySelectorAll('shreddit-post')) : [];
      if (feed && posts.length > 0) {
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
    state = {
      feed,
      posts: posts.slice(),
      currentPage: 1,
      highestPage: 1,
      hasMore: true,
      loading: false,
      pendingTimer: null,
      pendingResolve: null,
      bar: null,
      topBar: null,
      openPopup: null,
      observer: null,
    };

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

    await ensureLoadedThrough(1);
    reflow();
  }

  function registerPost(node) {
    if (!state || state.posts.includes(node)) return false;
    state.posts.push(node);
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

  function getDividerBox(preferredWrapper) {
    let hr = null;
    if (preferredWrapper && preferredWrapper.nextElementSibling && preferredWrapper.nextElementSibling.tagName === 'HR') {
      hr = preferredWrapper.nextElementSibling;
    }
    if (!hr) hr = state.feed.querySelector('article + hr') || state.feed.querySelector('hr');
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
    const start = (state.currentPage - 1) * PAGE_SIZE;
    const firstPost = state.posts[start];
    const topWrapper = firstPost ? wrapperOf(firstPost) : null;

    const box = getDividerBox(topWrapper);

    const lastPost = state.posts[state.posts.length - 1];
    const bottomWrapper = lastPost ? wrapperOf(lastPost) : null;
    if (bottomWrapper) {
      bottomWrapper.insertAdjacentElement('afterend', state.bar);
      applyDividerBox(state.bar, box);
    } else {
      state.feed.appendChild(state.bar);
    }
    hideTrailingElements();

    const pages = Math.min(totalKnownPages(), state.highestPage);
    if (topWrapper && pages > 1) {
      topWrapper.insertAdjacentElement('beforebegin', state.topBar);
      applyDividerBox(state.topBar, box);
    } else if (state.topBar.isConnected) {
      state.topBar.remove();
    }
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

  function makeButton(label, enabled, onClick, current, isPageNumber) {
    const el = document.createElement('button');
    el.type = 'button';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'flex items-center gap-xs';
    if (isPageNumber) {
      const num = document.createElement('faceplate-number');
      num.setAttribute('pretty', '');
      num.setAttribute('number', label);
      labelSpan.appendChild(num);
    } else {
      labelSpan.textContent = label;
    }
    el.appendChild(labelSpan);
    el.className = 'button button-small leading-none inline-flex items-center px-sm py-xs ' + (current ? 'button-primary' : 'button-secondary');
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

  function renderPageList(pages, budget, barEl) {
    const span = Math.min(2, Math.max(1, Math.floor((budget - 3) / 4)));
    const EDGE = span;
    const AROUND = span;
    const cur = state.currentPage;

    if (pages <= EDGE * 2 + AROUND * 2 + 3) {
      for (let n = 1; n <= pages; n++) appendPageButton(n, barEl);
      return;
    }

    for (let n = 1; n <= EDGE; n++) appendPageButton(n, barEl);

    const midStart = Math.max(EDGE + 1, cur - AROUND);
    const midEnd = Math.min(pages - EDGE, cur + AROUND);

    if (midStart > EDGE + 1) appendEllipsis(EDGE + 1, midStart - 1, barEl);

    for (let n = midStart; n <= midEnd; n++) appendPageButton(n, barEl);

    if (midEnd < pages - EDGE) appendEllipsis(midEnd + 1, pages - EDGE, barEl);

    for (let n = pages - EDGE + 1; n <= pages; n++) appendPageButton(n, barEl);
  }

  function appendPageButton(n, barEl) {
    const isCurrent = n === state.currentPage;
    const btn = makeButton(String(n), !isCurrent, () => goToPage(n), isCurrent, true);
    barEl.appendChild(btn);
  }

  function appendEllipsis(rangeStart, rangeEnd, barEl) {
    const wrap = document.createElement('span');
    wrap.style.position = 'relative';
    wrap.style.display = 'inline-flex';

    const btn = makeButton('…', true, () => togglePagePopup(wrap, rangeStart, rangeEnd), false);
    wrap.appendChild(btn);
    barEl.appendChild(wrap);
  }

  function togglePagePopup(anchor, rangeStart, rangeEnd) {
    const wasOpenHere = state.openPopup && anchor.contains(state.openPopup);
    closeOpenPopup();
    if (wasOpenHere) return;

    const popup = document.createElement('div');
    popup.setAttribute('data-reddit-paginate', 'popup');
    applyPopupStyles(popup);

    for (let n = rangeStart; n <= rangeEnd; n++) {
      const isCurrent = n === state.currentPage;
      const item = makeButton(String(n), !isCurrent, () => {
        goToPage(n);
        closeOpenPopup();
      }, isCurrent, true);
      popup.appendChild(item);
    }

    anchor.appendChild(popup);
    state.openPopup = popup;

    setTimeout(() => document.addEventListener('click', onOutsidePopupClick, true), 0);
  }

  function onOutsidePopupClick(e) {
    if (state.openPopup && !state.openPopup.contains(e.target) && e.target.textContent !== '…') {
      closeOpenPopup();
    }
  }

  function closeOpenPopup() {
    if (state.openPopup) {
      state.openPopup.remove();
      state.openPopup = null;
    }
    document.removeEventListener('click', onOutsidePopupClick, true);
  }

  function applyPopupStyles(el) {
    el.style.position = 'absolute';
    el.style.bottom = '100%';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.marginBottom = '4px';
    el.style.display = 'grid';
    el.style.gridTemplateColumns = 'repeat(5, max-content)';
    el.style.justifyItems = 'center';
    el.style.gap = '4px';
    el.style.padding = '8px';
    el.style.background = 'var(--rp-bg)';
    el.style.border = '1px solid var(--rp-border)';
    el.style.borderRadius = '8px';
    el.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
    el.style.maxHeight = '160px';
    el.style.overflowY = 'auto';
    el.style.zIndex = '1000';
  }

  function buildBarContents(barEl) {
    barEl.innerHTML = '';

    const containerWidth = barEl.clientWidth || 400;
    const numberBudget = Math.max(5, Math.floor((containerWidth - 170) / 44));

    const prevBtn = makeButton('prev', state.currentPage > 1, goPrev);
    prevBtn.insertBefore(wrapIcon(makeCaretIcon(90), true), prevBtn.firstChild);
    barEl.appendChild(prevBtn);

    renderPageList(Math.min(totalKnownPages(), state.highestPage), numberBudget, barEl);

    const canAdvance = state.hasMore || state.posts.length > state.currentPage * PAGE_SIZE;
    const nextBtn = makeButton(
      state.loading ? 'loading…' : 'next',
      canAdvance && !state.loading,
      goNext
    );
    if (!state.loading) {
      nextBtn.appendChild(wrapIcon(makeCaretIcon(-90), false));
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
      applyBarStyles(state.bar);
    }
    if (!state.topBar) {
      state.topBar = document.createElement('div');
      state.topBar.setAttribute('data-reddit-paginate', 'bar-top');
      applyBarStyles(state.topBar);
    }
    positionBars();
    buildBarContents(state.bar);
    if (state.topBar.isConnected) buildBarContents(state.topBar);
  }

  function scrollToTopOfFeed() {
    const top = state.feed.getBoundingClientRect().top + window.scrollY - 8;
    window.scrollTo({ top, behavior: 'instant' });
  }

  function goPrev() {
    if (state.currentPage <= 1) return;
    state.currentPage--;
    reflow();
    scrollToTopOfFeed();
  }

  function goToPage(n) {
    if (n === state.currentPage) return;
    state.currentPage = n;
    reflow();
    scrollToTopOfFeed();
  }

  async function goNext() {
    if (state.loading) return;
    const target = state.currentPage + 1;
    await ensureLoadedThrough(target);

    if (state.posts.length > (target - 1) * PAGE_SIZE) {
      state.currentPage = target;
      state.highestPage = Math.max(state.highestPage, target);
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
    el.style.gap = '4px';
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
        --rp-bg: var(--color-neutral-background, #ffffff);
        --rp-border: var(--color-neutral-border, #edeff1);
        --rp-fg-disabled: var(--color-neutral-content-weak, #9b9ba1);
      }
      faceplate-partial[slot="load-after"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function watchNavigation() {
    lastPath = location.pathname;
    setInterval(() => {
      const pathChanged = location.pathname !== lastPath;
      const feedGone = state && !state.feed.isConnected;
      if (pathChanged || feedGone) {
        lastPath = location.pathname;
        scheduleInit();
      }
    }, 500);
  }

  function start() {
    injectThemeVars();
    scheduleInit();
    watchNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();