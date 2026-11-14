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

// The homepage feed Serum draws itself, endlessly, as you scroll.
const REFILL = {
  keywordsPerRound: 3, // mix this many keywords in each round
  cardsPerRound: 18, // add this many cards per round
  aheadPx: 2000, // load the next round when the feed's end is this close
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
  else if (el.closest('ytd-browse[page-subtype="home"]')) keepHomeCard(el, { title, channel, id });
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
// On the homepage Serum draws its own feed: the videos YouTube showed you
// that match a keyword, mixed with keyword search results. It never ends:
// when you scroll near its end, the next round is loaded, page after page
// of each keyword's search results.

const refill = {
  busy: false,
  box: null, // Serum's feed element
  next: 0, // which keyword starts the next round (round robin)
  seen: new Set(), // video ids already in the feed
  home: [], // YouTube's own homepage videos that matched, waiting to be shown
  homeIds: new Set(),
  sources: new Map(), // keyword -> { queue, token, version, started, done }
};

function isHome() {
  return location.pathname === '/';
}

// A homepage card YouTube drew that matched: keep it for Serum's feed.
function keepHomeCard(el, info) {
  if (!isHome() || !info.id || refill.homeIds.has(info.id)) return;
  refill.homeIds.add(info.id);
  const avatar = el.querySelector('img[src*="yt3."], img[src*="ggpht"]');
  const channelLink = el.querySelector('a[href^="/@"], a[href^="/channel/"]');
  refill.home.push({
    id: info.id,
    title: info.title,
    channel: info.channel,
    channelUrl: channelLink ? channelLink.getAttribute('href') : '',
    avatar: avatar ? avatar.src : '',
    length: textOf(el, ['ytd-thumbnail-overlay-time-status-renderer', '[class*="badge-shape"] [class*="text"]']),
    views: '',
    age: '',
    thumb: 'https://i.ytimg.com/vi/' + info.id + '/mqdefault.jpg',
    keyword: 'for you',
  });
}

function source(keyword) {
  if (!refill.sources.has(keyword)) {
    refill.sources.set(keyword, { queue: [], token: '', version: '', started: false, done: false });
  }
  return refill.sources.get(keyword);
}

// Load the next page of one keyword's search results into its queue: the
// search page first, then the pages after it the way YouTube's own page
// asks for them (a "continuation" token, sent to youtube.com).
async function loadPage(keyword) {
  const s = source(keyword);
  if (s.done) return;
  let data;
  if (!s.started) {
    s.started = true;
    const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(keyword), {
      credentials: 'include',
    });
    const html = await res.text();
    s.version = serumClientVersion(html);
    data = serumExtractInitialData(html);
  } else if (s.token) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: serumContinuationBody(s.token, s.version),
    });
    data = await res.json();
  }
  const videos = serumParseVideos(data);
  videos.forEach(v => (v.keyword = keyword));
  s.queue.push(...videos);
  s.token = serumFindContinuation(data);
  if (!s.token) s.done = true;
}

// How close the end of Serum's feed is to the bottom of the screen.
function feedEndNear() {
  const box = refill.box;
  if (!box || !box.isConnected) return true;
  return box.getBoundingClientRect().bottom - window.innerHeight < REFILL.aheadPx;
}

function maybeRefill() {
  if (!isHome() || !matcher.hasKeywords || !settings.enabled) return;
  placeBox(); // put Serum's feed back if YouTube redrew the page without it
  if (refill.busy || !feedEndNear()) return;
  doRefill();
}

async function doRefill() {
  refill.busy = true;
  try {
    const kws = settings.keywords;
    const picked = [];
    for (let i = 0; i < Math.min(REFILL.keywordsPerRound, kws.length); i++) {
      picked.push(kws[(refill.next + i) % kws.length]);
    }
    refill.next = (refill.next + picked.length) % kws.length;

    // Make sure each picked keyword has enough waiting; load a page if not.
    const per = Math.ceil(REFILL.cardsPerRound / picked.length);
    await Promise.all(
      picked.map(async k => {
        const s = source(k);
        if (s.queue.length < per && !s.done) await loadPage(k).catch(e => console.warn('[Serum] search failed:', k, e));
      })
    );

    // Mix: YouTube's own matching videos and each keyword's results in turn.
    const queues = [refill.home, ...picked.map(k => source(k).queue)];
    const chosen = [];
    while (chosen.length < REFILL.cardsPerRound && queues.some(q => q.length)) {
      for (const q of queues) {
        const v = q.shift();
        if (!v || refill.seen.has(v.id)) continue;
        if (matcher.decide(v.title + ' ' + v.channel).blocked) continue;
        refill.seen.add(v.id);
        chosen.push(v);
        if (chosen.length >= REFILL.cardsPerRound) break;
      }
    }
    console.info(`[Serum] feed: +${chosen.length} (${picked.join(', ')})`);

    if (settings.enabled && isHome()) {
      const box = refillBox();
      const grid = box.querySelector('.serum-grid');
      chosen.forEach(v => grid.appendChild(makeCard(v)));
      const allDone = kws.every(k => source(k).done && source(k).queue.length === 0) && refill.home.length === 0;
      box.querySelector('.serum-more').textContent = allDone ? 'That is all for your keywords. Add more in Serum.' : 'Loading more…';
      placeBox();
    }
  } catch (e) {
    console.warn('[Serum] refill failed:', e);
  } finally {
    refill.busy = false;
  }
  // Still near the end (a tall screen, or few results)? Load another round.
  const done = settings.keywords.every(k => source(k).done && source(k).queue.length === 0);
  if (!done && isHome() && feedEndNear()) setTimeout(maybeRefill, 300);
}

// Serum's feed element. It is kept in refill.box, so when YouTube redraws
// the page and drops it, placeBox() puts the same feed (with its cards) back.
function refillBox() {
  if (!refill.box) {
    const box = document.createElement('div');
    box.className = 'serum-refill';
    const head = document.createElement('div');
    head.className = 'serum-refill-head';
    head.textContent = 'Serum: from your keywords';
    const grid = document.createElement('div');
    grid.className = 'serum-grid';
    const more = document.createElement('div');
    more.className = 'serum-more';
    more.textContent = 'Loading more…';
    box.append(head, grid, more);
    refill.box = box;
  }
  return refill.box;
}

// Remove the feed and start over (Serum switched off, or not on the homepage).
function dropBox() {
  if (refill.box) refill.box.remove();
  refill.box = null;
  refill.seen.clear();
  refill.home = [];
  refill.homeIds.clear();
  for (const s of refill.sources.values()) {
    // Start each keyword again from its first page next time.
    s.queue = [];
    s.token = '';
    s.started = false;
    s.done = false;
  }
  document.documentElement.classList.remove('serum-feed');
}

// Put the feed right after YouTube's grid. While Serum's feed is there,
// YouTube's own list of cards is hidden (the serum-feed class): the videos
// from it that matched are in Serum's feed already, and the two would
// otherwise both scroll forever.
function placeBox() {
  const box = refill.box;
  const on = !!(box && isHome() && settings.enabled && box.querySelector('.serum-card'));
  document.documentElement.classList.toggle('serum-feed', on);
  if (!on) return;
  const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  if (grid && grid.parentElement) {
    if (box.previousElementSibling !== grid) grid.after(box);
  } else if (!box.isConnected) {
    const primary = document.querySelector('ytd-browse[page-subtype="home"] #primary');
    if (primary) primary.append(box);
  }
}

// A card laid out like YouTube's: thumbnail, then the channel's picture
// beside the title, channel, views and age. Built with DOM calls (no
// innerHTML, so titles can't inject HTML).
function makeCard(v) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const watch = '/watch?v=' + v.id;
  const card = el('div', 'serum-card');

  const thumb = el('a', 'serum-thumb');
  thumb.href = watch;
  const img = el('img');
  img.src = v.thumb;
  img.loading = 'lazy';
  img.alt = '';
  thumb.appendChild(img);
  if (v.length) thumb.appendChild(el('span', 'serum-len', v.length));

  const row = el('div', 'serum-row');
  const avatar = el(v.channelUrl ? 'a' : 'span', 'serum-avatar');
  if (v.channelUrl) avatar.href = v.channelUrl;
  if (v.avatar) {
    const pic = el('img');
    pic.src = v.avatar;
    pic.loading = 'lazy';
    pic.alt = '';
    avatar.appendChild(pic);
  }
  const text = el('div', 'serum-text');
  const title = el('a', 'serum-title', v.title);
  title.href = watch;
  title.title = v.title;
  const channel = el(v.channelUrl ? 'a' : 'span', 'serum-channel', v.channel);
  if (v.channelUrl) channel.href = v.channelUrl;
  text.append(
    title,
    channel,
    el('div', 'serum-meta', [v.views, v.age].filter(Boolean).join(' · ')),
    el('div', 'serum-tag', '#' + v.keyword)
  );
  row.append(avatar, text);
  card.append(thumb, row);
  return card;
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
  if (keywordsChanged) refill.sources.clear();
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

// Scrolling near the end of Serum's feed loads the next round.
window.addEventListener('scroll', () => {
  if (isHome() && refill.box && !refill.busy && feedEndNear()) maybeRefill();
}, { passive: true });
