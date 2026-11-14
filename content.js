// Serum content script (runs on youtube.com).
// 1. Judges every video card by its title + channel: kept when it matches a
//    keyword, hidden when it matches none or a blocklist word. A card stays
//    hidden until it is judged (content.css), so nothing flashes.
// 2. Draws its own endless feed on the homepage and in the suggestions beside
//    a video: YouTube's matching videos mixed with keyword search results.
// 3. Skips Shorts that don't match.
// Helpers (matching, parsing YouTube's data) are in lib.js.
'use strict';

// ---------------------------------------------------------------- settings

let settings = { ...SERUM_DEFAULTS };
let matcher = serumMatcher(settings.keywords, settings.blocklist);
let ready = false; // settings loaded; until then cards wait, hidden

// Every kind of video card YouTube draws (the same list is in content.css).
// A card nested inside another card (the newer lockup inside a homepage
// grid item) is judged through its outer one.
const CARD_SELECTOR = [
  'ytd-rich-item-renderer', // homepage grid
  'ytd-video-renderer', // search results
  'ytd-compact-video-renderer', // suggestions, older layout
  'ytd-grid-video-renderer', // channel grids
  'yt-lockup-view-model', // suggestions and home, newer layout
  'ytd-reel-item-renderer', // Shorts shelf, older layout
  'ytm-shorts-lockup-view-model', // Shorts shelf, newer layout
].join(',');

// Serum's own endless feed.
const FEED = {
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
  let title = textOf(el, ['#video-title', 'h3 a', 'h3', '[class*="lockup-metadata"] [class*="title"]', 'a[title]']);
  if (!title) {
    // Shorts lockups sometimes carry the title only in an aria-label.
    const a = el.querySelector('a[aria-label]');
    title = a ? a.getAttribute('aria-label').trim() : '';
  }
  if (!title) {
    // A layout none of the selectors know: judge all the card's text
    // (title, channel, views). Never leave a drawn card unjudged.
    title = (el.textContent || '').replace(/\s+/g, ' ').trim();
  }
  const channel = textOf(el, ['ytd-channel-name #text', 'ytd-channel-name', 'a[href^="/@"]', '[class*="content-metadata"] a']);
  const link = el.querySelector('a[href*="watch?v="], a[href*="/shorts/"]');
  const href = link ? link.getAttribute('href') : '';
  const m = href.match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
  return { title, channel, id: m ? m[1] || m[2] : '' };
}

// -------------------------------------------------------------- judging

// Judge one card: data-serum="show" or "hide". Until then the card is
// hidden by content.css. Cards are judged again when their text changes,
// because YouTube reuses card elements for other videos.
function judgeCard(el) {
  if (!ready || el.closest('.serum-feed-box')) return;
  const outer = el.parentElement && el.parentElement.closest(CARD_SELECTOR);
  if (outer) {
    el.dataset.serum = 'inner'; // its outer card decides for both
    judgeCard(outer);
    return;
  }
  for (const inner of el.querySelectorAll(CARD_SELECTOR)) inner.dataset.serum = 'inner';
  const { title, channel, id } = cardInfo(el);
  if (!title) return; // an empty placeholder: stays hidden until it's drawn
  const key = title + '|' + channel;
  if (el.dataset.serumKey === key && el.dataset.serum) return;
  el.dataset.serumKey = key;
  const verdict = matcher.decide(title + ' ' + channel).verdict;
  el.dataset.serum = verdict;
  if (verdict === 'hide') countHidden(id || key);
  else keepOwnCard(el, { title, channel, id });
}

// Judge every card on the page (on load, on settings changes, and now and
// then as a safety net).
function scan() {
  if (!ready || !settings.enabled) return;
  for (const el of document.querySelectorAll(CARD_SELECTOR)) judgeCard(el);
  checkShorts();
  maybeFeed();
}

// The cards one batch of DOM changes touched: added cards, and cards whose
// insides changed.
function touchedCards(mutations) {
  const cards = new Set();
  for (const m of mutations) {
    const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    const c = t && t.closest(CARD_SELECTOR);
    if (c) cards.add(c);
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(CARD_SELECTOR)) cards.add(n);
      for (const c2 of n.querySelectorAll(CARD_SELECTOR)) cards.add(c2);
    }
  }
  return cards;
}

// Undo every verdict (before judging again with new settings).
function clearVerdicts() {
  for (const el of document.querySelectorAll('[data-serum]')) {
    delete el.dataset.serum;
    delete el.dataset.serumKey;
  }
}

// ---------------------------------------------------------------- the feed
// On the homepage and beside a video Serum draws its own feed: the videos
// YouTube showed there that match a keyword, mixed with keyword search
// results. It never ends: when you scroll near its end the next round loads,
// page after page of each keyword's search results.

const feed = {
  page: '', // the page this feed belongs to ("home", or "watch:<video id>")
  since: 0, // when this page's feed started
  busy: false,
  box: null, // Serum's feed element
  next: 0, // which keyword starts the next round (round robin)
  seen: new Set(), // video ids already in this feed
  own: [], // YouTube's own matching videos on this page, waiting to be shown
  ownIds: new Set(),
  sources: new Map(), // keyword -> { queue, token, version, started, done }
};

// Which feed this page gets: 'home', 'watch', or null (no feed).
function feedKind() {
  if (location.pathname === '/') return 'home';
  if (location.pathname === '/watch') return 'watch';
  return null;
}

function feedPage() {
  const kind = feedKind();
  return kind === 'watch' ? 'watch:' + new URLSearchParams(location.search).get('v') : kind || '';
}

// A new page (another video, or home): start a new feed.
function syncPage() {
  const page = feedPage();
  if (feed.page !== page) {
    dropBox();
    feed.page = page;
    feed.since = Date.now();
  }
}

// Beside a video, the first round waits (2.5 s at most) for YouTube's own
// suggestions, so the matching ones come first in Serum's feed.
function ownCardsPending() {
  if (feedKind() !== 'watch' || feed.box || feed.own.length) return false;
  const judged = document.querySelector('ytd-watch-flexy #related [data-serum="show"], ytd-watch-flexy #related [data-serum="hide"]');
  return !judged && Date.now() - feed.since < 2500;
}

// A card YouTube drew in the place Serum's feed replaces, that matched:
// keep it for the feed.
function keepOwnCard(el, info) {
  const kind = feedKind();
  const inPlace = kind === 'home' ? el.closest('ytd-browse[page-subtype="home"]') : kind === 'watch' ? el.closest('#related') : null;
  if (!inPlace || !info.id) return;
  syncPage();
  if (feed.ownIds.has(info.id)) return;
  feed.ownIds.add(info.id);
  const avatar = el.querySelector('img[src*="yt3."], img[src*="ggpht"]');
  const channelLink = el.querySelector('a[href^="/@"], a[href^="/channel/"]');
  feed.own.push({
    id: info.id,
    title: info.title,
    channel: info.channel,
    channelUrl: channelLink ? channelLink.getAttribute('href') : '',
    avatar: avatar ? avatar.src : '',
    length: textOf(el, ['ytd-thumbnail-overlay-time-status-renderer', '[class*="badge-shape"] [class*="text"]']),
    views: '',
    age: '',
    thumb: 'https://i.ytimg.com/vi/' + info.id + '/mqdefault.jpg',
    keyword: kind === 'home' ? 'for you' : 'related',
  });
}

function source(keyword) {
  if (!feed.sources.has(keyword)) {
    feed.sources.set(keyword, { queue: [], token: '', version: '', started: false, done: false });
  }
  return feed.sources.get(keyword);
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

// The keywords in use (the popup allows at most SERUM_MAX_KEYWORDS).
function activeKeywords() {
  return settings.keywords.slice(0, SERUM_MAX_KEYWORDS);
}

function sourcesEmpty() {
  return activeKeywords().every(k => source(k).done && source(k).queue.length === 0);
}

// How close the end of Serum's feed is to the bottom of the screen.
function feedEndNear() {
  const box = feed.box;
  if (!box || !box.isConnected) return true;
  return box.getBoundingClientRect().bottom - window.innerHeight < FEED.aheadPx;
}

function maybeFeed() {
  if (!feedKind() || !matcher.hasKeywords || !settings.enabled) return;
  syncPage();
  placeBox(); // put Serum's feed back if YouTube redrew the page without it
  if (feed.busy || !feedEndNear()) return;
  if (sourcesEmpty() && feed.own.length === 0) return;
  if (ownCardsPending()) {
    setTimeout(maybeFeed, 300);
    return;
  }
  addRound();
}

async function addRound() {
  feed.busy = true;
  const page = feed.page;
  try {
    const kws = activeKeywords();
    const picked = [];
    for (let i = 0; i < Math.min(FEED.keywordsPerRound, kws.length); i++) {
      picked.push(kws[(feed.next + i) % kws.length]);
    }
    feed.next = (feed.next + picked.length) % kws.length;

    // Make sure each picked keyword has enough waiting; load a page if not.
    const per = Math.ceil(FEED.cardsPerRound / picked.length);
    await Promise.all(
      picked.map(async k => {
        const s = source(k);
        if (s.queue.length < per && !s.done) await loadPage(k).catch(e => console.warn('[Serum] search failed:', k, e));
      })
    );
    if (feed.page !== page) return; // you moved to another page meanwhile

    // Mix: YouTube's own matching videos and each keyword's results in turn.
    const queues = [feed.own, ...picked.map(k => source(k).queue)];
    const chosen = [];
    while (chosen.length < FEED.cardsPerRound && queues.some(q => q.length)) {
      for (const q of queues) {
        const v = q.shift();
        if (!v || feed.seen.has(v.id)) continue;
        if (matcher.decide(v.title + ' ' + v.channel).blocked) continue;
        feed.seen.add(v.id);
        chosen.push(v);
        if (chosen.length >= FEED.cardsPerRound) break;
      }
    }
    console.info(`[Serum] feed (${feed.page}): +${chosen.length} (${picked.join(', ')})`);

    if (settings.enabled) {
      const box = feedBox();
      const list = box.querySelector('.serum-grid');
      chosen.forEach(v => list.appendChild(makeCard(v)));
      const allDone = sourcesEmpty() && feed.own.length === 0;
      box.querySelector('.serum-more').textContent = allDone ? 'That is all for your keywords. Add more in Serum.' : 'Loading more…';
      placeBox();
    }
  } catch (e) {
    console.warn('[Serum] feed failed:', e);
  } finally {
    feed.busy = false;
  }
  // Still near the end (a tall screen, or few results)? Load another round.
  if (feed.page === page && feedEndNear()) setTimeout(maybeFeed, 300);
}

// Serum's feed element. It is kept in feed.box, so when YouTube redraws the
// page and drops it, placeBox() puts the same feed (with its cards) back.
function feedBox() {
  if (!feed.box) {
    const box = document.createElement('div');
    box.className = 'serum-feed-box' + (feedKind() === 'watch' ? ' serum-compact' : '');
    const head = document.createElement('div');
    head.className = 'serum-feed-head';
    head.textContent = 'Serum: from your keywords';
    const list = document.createElement('div');
    list.className = 'serum-grid';
    const more = document.createElement('div');
    more.className = 'serum-more';
    more.textContent = 'Loading more…';
    box.append(head, list, more);
    feed.box = box;
  }
  return feed.box;
}

// Remove the feed and start over (another page, or Serum switched off).
function dropBox() {
  if (feed.box) feed.box.remove();
  feed.box = null;
  feed.seen.clear();
  feed.own = [];
  feed.ownIds.clear();
  // A keyword whose results ran out starts again from its first page.
  for (const s of feed.sources.values()) {
    if (s.done && s.queue.length === 0) Object.assign(s, { token: '', started: false, done: false });
  }
  document.documentElement.classList.remove('serum-feed');
}

// Put the feed where YouTube's list was: after the homepage grid, or just
// before the suggestions beside a video. While Serum's feed is there,
// YouTube's own list is hidden (the serum-feed class in content.css): its
// matching videos are in Serum's feed already, and two endless lists would
// otherwise scroll side by side.
function placeBox() {
  const box = feed.box;
  const on = !!(box && feedKind() && settings.enabled && box.querySelector('.serum-card'));
  document.documentElement.classList.toggle('serum-feed', on);
  if (!on) return;
  if (feedKind() === 'home') {
    const grid = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
    if (grid && grid.parentElement) {
      if (box.previousElementSibling !== grid) grid.after(box);
    } else if (!box.isConnected) {
      const primary = document.querySelector('ytd-browse[page-subtype="home"] #primary');
      if (primary) primary.append(box);
    }
  } else {
    const related = document.querySelector('ytd-watch-flexy #related');
    if (related && box.nextElementSibling !== related) related.before(box);
  }
}

// A card laid out like YouTube's: thumbnail, then the channel's picture
// beside the title, channel, views and age (beside a video: thumbnail on the
// left, text on the right). Built with DOM calls (no innerHTML, so titles
// can't inject HTML).
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

// The full scan is batched: many DOM changes in a row cause one.
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
  ready = true;
  if (keywordsChanged) feed.sources.clear();
  // Switched off: the serum-off class shows every card again.
  document.documentElement.classList.toggle('serum-off', !s.enabled);
  dropBox();
  feed.page = '';
  shorts.lastId = null;
  // Clear and judge again in one go, so nothing is drawn in between.
  clearVerdicts();
  scan();
}

chrome.storage.sync.get(SERUM_DEFAULTS, apply);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') chrome.storage.sync.get(SERUM_DEFAULTS, apply);
});

// YouTube draws cards while you scroll. Each batch of changes is judged
// right here, before the browser paints, so a card that doesn't match is
// never seen; then a full scan follows a little later.
new MutationObserver(mutations => {
  if (!ready || !settings.enabled) return;
  for (const card of touchedCards(mutations)) judgeCard(card);
  queueScan();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['href', 'title', 'aria-label'], // a reused card gets a new link and title
});

// YouTube is a single-page app: a new "page" doesn't reload this script.
document.addEventListener('yt-navigate-finish', () => {
  syncPage();
  queueScan();
});

// A slow safety net for text that changes without new elements.
setInterval(queueScan, 2000);

// Scrolling near the end of Serum's feed loads the next round.
window.addEventListener(
  'scroll',
  () => {
    if (feed.box && !feed.busy && feedEndNear()) maybeFeed();
  },
  { passive: true }
);
