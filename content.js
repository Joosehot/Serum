// Serum content script (runs on youtube.com).
// 1. Hides every video card whose title + channel match none of your
//    keywords, or match a blocklist word.
// 2. Refills the homepage with keyword search results when too much is hidden.
// 3. Skips Shorts that don't match.
// Helpers (matching, parsing ytInitialData) are in lib.js.
'use strict';

// ---------------------------------------------------------------- settings

let settings = { ...SERUM_DEFAULTS };
let matcher = serumMatcher(settings.keywords, settings.blocklist);

// Every kind of video card YouTube draws. A card nested inside another card
// (the newer lockup inside a homepage grid item) is handled through its outer one.
const CARD_SELECTOR = [
  'ytd-rich-item-renderer', // homepage grid
  'ytd-video-renderer', // search results
  'ytd-compact-video-renderer', // sidebar, older layout
  'ytd-grid-video-renderer', // channel grids
  'yt-lockup-view-model', // sidebar and home, newer layout
  'ytd-reel-item-renderer', // Shorts shelf, older layout
  'ytm-shorts-lockup-view-model', // Shorts shelf, newer layout
].join(',');

// Homepage refill: when fewer than MIN_VISIBLE cards are left showing.
const REFILL = {
  minVisible: 12, // refill below this many visible homepage cards
  cooldownMs: 15000, // at most one refill per 15 s
  keywordsPerRound: 3, // search this many keywords per refill
  cardsPerRound: 18, // add at most this many cards per refill
  maxCards: 96, // stop after this many injected cards on one page
};

// --------------------------------------------------------------- the counter

const counted = new Set(); // what was already counted on this page
let pending = 0;
let flushTimer = null;

function today() {
  return new Date().toLocaleDateString('sv'); // YYYY-MM-DD in local time
}

// Count one hidden video (or skipped Short), once per page.
function countHidden(key) {
  if (counted.has(key)) return;
  counted.add(key);
  pending++;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushCount, 800);
}

async function flushCount() {
  const add = pending;
  pending = 0;
  try {
    const { stats } = await chrome.storage.local.get('stats');
    const s = stats && stats.date === today() ? stats : { date: today(), count: 0 };
    s.count += add;
    await chrome.storage.local.set({ stats: s });
  } catch (e) {
    // The extension was reloaded; this old script can't save any more.
  }
}

// -------------------------------------------------------------- reading cards

// Text of the first element that matches one of the selectors.
function textOf(root, selectors) {
  for (const sel of selectors) {
    const n = root.querySelector(sel);
    if (!n) continue;
    const t = (n.getAttribute('title') || n.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return '';
}

function cardInfo(el) {
  let title = textOf(el, [
    '#video-title',
    'h3 a',
    'h3',
    '[class*="lockup-metadata"] [class*="title"]',
    'a[title]',
  ]);
  if (!title) {
    // Shorts lockups sometimes carry the title only in an aria-label.
    const a = el.querySelector('a[aria-label]');
    title = a ? a.getAttribute('aria-label').trim() : '';
  }
  if (!title) {
    // A layout none of the selectors know: judge all the card's text
    // (title, channel, views). Never leave a card unjudged.
    title = (el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const channel = textOf(el, ['ytd-channel-name #text', 'ytd-channel-name', 'a[href^="/@"]', '[class*="content-metadata"] a']);
  const link = el.querySelector('a[href*="watch?v="], a[href*="/shorts/"]');
  const href = link ? link.getAttribute('href') : '';
  const m = href.match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
  return { title, channel, id: m ? m[1] || m[2] : '' };
}

// -------------------------------------------------------------- filtering

// Score one card and hide or show it. Cards are re-scored when their text
// changes, because YouTube reuses card elements for other videos.
function processCard(el) {
  const { title, channel, id } = cardInfo(el);
  if (!title) return; // not drawn yet; the next scan will look again
  const key = title + '|' + channel;
  if (el.dataset.serumKey === key) return;
  el.dataset.serumKey = key;
  const { verdict } = matcher.decide(title + ' ' + channel);
  const hide = verdict === 'hide';
  el.classList.toggle('serum-hidden', hide);
  if (hide) countHidden(id || key);
}

function scan() {
  if (!settings.enabled) return;
  for (const el of document.querySelectorAll(CARD_SELECTOR)) {
    if (el.closest('.serum-refill')) continue;
    const outer = el.parentElement && el.parentElement.closest(CARD_SELECTOR);
    if (outer) continue; // the outer card decides for both
    processCard(el);
  }
  checkShorts();
  maybeRefill();
}

// Undo everything (when Serum is switched off or settings change).
function resetAll() {
  for (const el of document.querySelectorAll('.serum-hidden')) el.classList.remove('serum-hidden');
  for (const el of document.querySelectorAll('[data-serum-key]')) delete el.dataset.serumKey;
  dropBox();
  shorts.lastId = null;
}

// ---------------------------------------------------------------- refill

const refill = {
  busy: false,
  last: 0,
  box: null, // Serum's block of cards
  injected: 0,
  hiddenAtLast: 0, // hidden homepage cards at the last refill
  next: 0, // which keyword is searched next (round robin)
  cache: new Map(), // keyword -> videos from its search page
};

function isHome() {
  return location.pathname === '/';
}

function homeCards() {
  return [...document.querySelectorAll('ytd-browse[page-subtype="home"] ytd-rich-item-renderer')];
}

function maybeRefill() {
  if (!isHome() || !matcher.hasKeywords) return;
  placeBox(); // put Serum's block back if YouTube redrew the page without it
  if (refill.busy || Date.now() - refill.last < REFILL.cooldownMs || refill.injected >= REFILL.maxCards) return;
  const cards = homeCards();
  const hidden = cards.filter(c => c.classList.contains('serum-hidden')).length;
  // Count only Serum cards that are really on the page.
  const ours = refill.box && refill.box.isConnected ? refill.box.querySelectorAll('.serum-card').length : 0;
  const visible = cards.length - hidden + ours;
  // Always on the homepage: a first round of keyword videos, so the feed is
  // more than your subscriptions. After that, another round when cards run
  // short, or when another page-full was hidden while you scrolled.
  const first = ours === 0;
  const short = visible < REFILL.minVisible;
  const scrolledPast = hidden - refill.hiddenAtLast >= REFILL.cardsPerRound;
  if (!first && !short && !scrolledPast) return;
  refill.hiddenAtLast = hidden;
  doRefill();
}

async function searchVideos(keyword) {
  if (refill.cache.has(keyword)) return refill.cache.get(keyword);
  const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(keyword), {
    credentials: 'include',
  });
  const videos = serumParseVideos(serumExtractInitialData(await res.text()));
  videos.forEach(v => (v.keyword = keyword));
  refill.cache.set(keyword, videos);
  return videos;
}

// Every video id already on the page, so refills never repeat one.
function idsOnPage() {
  const ids = new Set();
  for (const a of document.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]')) {
    const m = a.getAttribute('href').match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
    if (m) ids.add(m[1] || m[2]);
  }
  return ids;
}

async function doRefill() {
  refill.busy = true;
  refill.last = Date.now();
  try {
    const kws = settings.keywords;
    const picked = [];
    for (let i = 0; i < Math.min(REFILL.keywordsPerRound, kws.length); i++) {
      picked.push(kws[(refill.next + i) % kws.length]);
    }
    refill.next = (refill.next + picked.length) % kws.length;
    const lists = await Promise.all(picked.map(k => searchVideos(k).catch(() => [])));

    // Mix the keywords: one from each list in turn.
    const seen = idsOnPage();
    const chosen = [];
    for (let i = 0; chosen.length < REFILL.cardsPerRound; i++) {
      if (lists.every(l => i >= l.length)) break;
      for (const l of lists) {
        const v = l[i];
        if (!v || seen.has(v.id)) continue;
        if (matcher.decide(v.title + ' ' + v.channel).blocked) continue;
        seen.add(v.id);
        chosen.push(v);
        if (chosen.length >= REFILL.cardsPerRound) break;
      }
    }
    console.info(`[Serum] refill: ${picked.join(', ')} gave ${lists.map(l => l.length).join('+')} videos, ${chosen.length} new`);
    if (chosen.length && settings.enabled && isHome()) {
      const grid = refillBox().querySelector('.serum-grid');
      chosen.forEach(v => grid.appendChild(makeCard(v)));
      refill.injected += chosen.length;
      placeBox();
    }
  } catch (e) {
    console.warn('[Serum] refill failed:', e);
  } finally {
    refill.busy = false;
  }
}

// Serum's own block above the homepage feed. The element is kept in
// refill.box, so when YouTube redraws the page and drops it, placeBox() puts
// the same block (with its cards) back.
function refillBox() {
  if (!refill.box) {
    const box = document.createElement('div');
    box.className = 'serum-refill';
    const head = document.createElement('div');
    head.className = 'serum-refill-head';
    head.textContent = 'Serum: from your keywords';
    const grid = document.createElement('div');
    grid.className = 'serum-grid';
    box.append(head, grid);
    refill.box = box;
  }
  return refill.box;
}

// Remove the block and start over (Serum switched off, or not on the homepage).
function dropBox() {
  if (refill.box) refill.box.remove();
  refill.box = null;
  refill.injected = 0;
  refill.hiddenAtLast = 0;
}

// Put the block just before YouTube's grid, as its sibling: outside the
// grid's own list, which YouTube empties and refills on its own.
function placeBox() {
  const box = refill.box;
  if (!box || !isHome() || !box.querySelector('.serum-card')) return;
  const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  if (grid && grid.parentElement) {
    if (box.nextElementSibling !== grid) grid.parentElement.insertBefore(box, grid);
  } else if (!box.isConnected) {
    const primary = document.querySelector('ytd-browse[page-subtype="home"] #primary');
    if (primary) primary.prepend(box);
  }
}

// A plain card built with DOM calls (no innerHTML, so titles can't inject HTML).
function makeCard(v) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const a = el('a', 'serum-card');
  a.href = '/watch?v=' + v.id;
  const thumb = el('div', 'serum-thumb');
  const img = el('img');
  img.src = v.thumb;
  img.loading = 'lazy';
  img.alt = '';
  thumb.appendChild(img);
  if (v.length) thumb.appendChild(el('span', 'serum-len', v.length));
  a.append(
    thumb,
    el('div', 'serum-title', v.title),
    el('div', 'serum-meta', [v.channel, v.views, v.age].filter(Boolean).join(' Â· ')),
    el('div', 'serum-tag', '#' + v.keyword)
  );
  return a;
}

// ---------------------------------------------------------------- Shorts

const shorts = {
  lastId: null, // the Short already judged (or being judged)
  skipsInRow: 0,
  info: new Map(), // id -> {title, channel}
};

// A Short's title and channel by its id, from YouTube's own oEmbed endpoint
// (same site, plain JSON). This doesn't depend on how the Shorts player is
// drawn, and can't read the previous Short's title by mistake.
async function shortInfo(id) {
  if (shorts.info.has(id)) return shorts.info.get(id);
  let info = null;
  try {
    const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/shorts/' + id);
    const res = await fetch(url);
    if (res.ok) {
      const j = await res.json();
      info = { title: j.title || '', channel: j.author_name || '' };
    }
  } catch (e) {
    info = null;
  }
  if (!info) {
    // oEmbed failed: read the player itself.
    const active = document.querySelector('ytd-reel-video-renderer[is-active]') || document;
    info = {
      title: textOf(active, ['yt-shorts-video-title-view-model', '[class*="ShortsVideoTitle"]', 'h2']),
      channel: textOf(active, ['[class*="ChannelName"]', 'ytd-channel-name', 'a[href^="/@"]']),
    };
  }
  shorts.info.set(id, info);
  return info;
}

async function checkShorts() {
  if (!location.pathname.startsWith('/shorts/')) return;
  const id = location.pathname.split('/')[2];
  if (!id || id === shorts.lastId) return;
  shorts.lastId = id;
  const { title, channel } = await shortInfo(id);
  // The user may have moved on while we were looking it up.
  if (location.pathname.split('/')[2] !== id || !settings.enabled) return;
  if (!title) return;
  if (matcher.decide(title + ' ' + channel).verdict === 'show') {
    shorts.skipsInRow = 0;
    return;
  }
  if (shorts.skipsInRow >= 30) {
    toast('Serum: 30 Shorts in a row matched nothing, so it stopped skipping. Scroll on yourself, or add keywords.');
    return;
  }
  shorts.skipsInRow++;
  countHidden(id);
  setTimeout(skipShort, 150);
}

function skipShort() {
  const btn = document.querySelector('#navigation-button-down button');
  if (btn) {
    btn.click();
    return;
  }
  // No button in this layout: scroll the Shorts list one screen down, or
  // else press the down-arrow key (YouTube's own shortcut).
  const list = document.querySelector('#shorts-inner-container');
  if (list) {
    list.scrollBy({ top: list.clientHeight, behavior: 'instant' });
    return;
  }
  const ev = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40, bubbles: true };
  document.dispatchEvent(new KeyboardEvent('keydown', ev));
}

function toast(text) {
  let t = document.querySelector('.serum-toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'serum-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  clearTimeout(t._hide);
  t._hide = setTimeout(() => t.remove(), 6000);
}

// ------------------------------------------------------------ wiring it up

// Scans are batched: many DOM changes in a row cause one scan.
let scanQueued = false;
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  setTimeout(() => {
    scanQueued = false;
    scan();
  }, 150);
}

function apply(s) {
  const keywordsChanged = JSON.stringify(s.keywords) !== JSON.stringify(settings.keywords);
  settings = s;
  matcher = serumMatcher(s.keywords, s.blocklist);
  if (keywordsChanged) refill.cache.clear();
  resetAll();
  queueScan();
}

chrome.storage.sync.get(SERUM_DEFAULTS, apply);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') chrome.storage.sync.get(SERUM_DEFAULTS, apply);
});

// YouTube loads cards while you scroll: watch the page for new ones.
new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });

// YouTube is a single-page app: a new "page" doesn't reload this script.
document.addEventListener('yt-navigate-finish', () => {
  if (!isHome()) dropBox();
  queueScan();
});

// A slow safety net for text that changes without new elements.
setInterval(queueScan, 2000);
