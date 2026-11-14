// Serum's pure helpers: keyword matching and reading YouTube's search pages.
// No DOM and no chrome.* here, so the same file runs in the content script
// and in Node (test.js).
'use strict';

// Defaults used until you save your own in the popup.
const SERUM_DEFAULTS = {
  enabled: true,
  keywords: ['business', 'tech', 'computers', 'rust'],
  blocklist: [],
};

// A word must stand on its own: "rust" matches "Rust 1.80" and "rust-lang"
// but not "trust". Letters and digits of any script count as word parts.
function serumWordRegex(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?=[^\\p{L}\\p{N}]|$)', 'iu');
}

// At most this many keywords and key sentences together.
const SERUM_MAX_KEYWORDS = 25;

// Words a key sentence doesn't need to match (English and Finnish).
const SERUM_STOPWORDS = new Set(
  ('a an and are as at be by for from how i in is it my of on or that the this to was what when where which who why ' +
    'with you your ja on se ne ei mitä miten miksi kun jos tai että joka mikä kuin myös vain sekä').split(' ')
);

// A key sentence (three words or more): it matches when at least two thirds
// of its meaningful words are in the text, in any order. "How to start a
// business online" matches "Start Your Online Business in 2026". A word may
// also end in s, es or 's ("business" matches "businesses").
function serumSentenceTest(sentence) {
  const words = sentence
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter(w => w && !SERUM_STOPWORDS.has(w));
  if (words.length === 0) return () => false;
  const res = words.map(w => {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + "(s|es|'s)?(?=[^\\p{L}\\p{N}]|$)", 'iu');
  });
  const need = Math.max(Math.min(2, words.length), Math.ceil((words.length * 2) / 3));
  return text => res.filter(re => re.test(text)).length >= need;
}

// One keyword's test:
// - one word: as written ("rust", not "trust");
// - two words: both, in any order ("classical music" matches "Music:
//   classical favourites"); a word may end in s, es or 's;
// - three words or more: a key sentence (serumSentenceTest).
// Words written together as a hashtag also match: "classical music" matches
// "#classicalmusic".
function serumKeywordTest(keyword) {
  const words = keyword.trim().split(/\s+/);
  const tag = words.length > 1 ? serumWordRegex(words.join('')) : null;
  const withTag = test => (tag ? text => test(text) || tag.test(text) : test);
  if (words.length >= 3) return withTag(serumSentenceTest(keyword));
  if (words.length === 2) {
    const res = words.map(w => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + "(s|es|'s)?(?=[^\\p{L}\\p{N}]|$)", 'iu');
    });
    return withTag(text => res.every(re => re.test(text)));
  }
  const re = serumWordRegex(keyword);
  return text => re.test(text);
}

// Build a matcher from the keyword and blocklist arrays. Only the first
// SERUM_MAX_KEYWORDS keywords count. Blocklist words are matched as written.
// decide(text) returns 'show' or 'hide' and how many keywords matched.
function serumMatcher(keywords, blocklist) {
  const clean = list => (list || []).map(w => String(w).trim()).filter(Boolean);
  const keep = clean(keywords).slice(0, SERUM_MAX_KEYWORDS).map(serumKeywordTest);
  const block = clean(blocklist)
    .map(serumWordRegex)
    .map(re => text => re.test(text));
  return {
    hasKeywords: keep.length > 0,
    decide(text) {
      if (block.some(test => test(text))) return { verdict: 'hide', score: 0, blocked: true };
      const score = keep.filter(test => test(text)).length;
      // With no keywords at all, nothing is hidden for lack of a match.
      if (keep.length === 0) return { verdict: 'show', score, blocked: false };
      return { verdict: score > 0 ? 'show' : 'hide', score, blocked: false };
    },
  };
}

// The JSON YouTube puts in the page as `var ytInitialData = {...};`.
function serumExtractInitialData(html) {
  const marker = html.match(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*/);
  if (!marker) return null;
  const start = marker.index + marker[0].length;
  const end = html.indexOf(';</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch (e) {
    return null;
  }
}

// YouTube text is either {simpleText} or {runs: [{text}, ...]}.
function serumText(t) {
  if (!t) return '';
  if (t.simpleText) return t.simpleText;
  return (t.runs || []).map(r => r.text).join('');
}

// Every videoRenderer anywhere in ytInitialData, as plain objects.
function serumParseVideos(data) {
  const out = [];
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const v = node.videoRenderer;
    if (v && v.videoId && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      const owner = v.ownerText || v.longBylineText || v.shortBylineText;
      const ownerRun = owner && owner.runs && owner.runs[0];
      const url = ownerRun && ownerRun.navigationEndpoint && ownerRun.navigationEndpoint.commandMetadata;
      // The channel's picture (on YouTube's own image host), when given.
      const csr = v.channelThumbnailSupportedRenderers;
      const pics = csr && csr.channelThumbnailWithLinkRenderer && csr.channelThumbnailWithLinkRenderer.thumbnail;
      const avatar = pics && pics.thumbnails && pics.thumbnails.length ? pics.thumbnails[0].url : '';
      out.push({
        id: v.videoId,
        title: serumText(v.title),
        channel: serumText(owner),
        channelUrl: (url && url.webCommandMetadata && url.webCommandMetadata.url) || '',
        avatar,
        length: serumText(v.lengthText),
        views: serumText(v.shortViewCountText) || serumText(v.viewCountText),
        age: serumText(v.publishedTimeText),
        // Thumbnails come from YouTube's own image host.
        thumb: 'https://i.ytimg.com/vi/' + v.videoId + '/mqdefault.jpg',
      });
    }
    for (const k in node) walk(node[k]);
  };
  walk(data);
  return out;
}

// Every Short in ytInitialData (search results show them as
// shortsLockupViewModel, older pages as reelItemRenderer): its id and the
// text it is shown with (title, hashtags), for matching.
function serumParseShorts(data) {
  const out = [];
  const seen = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const lock = node.shortsLockupViewModel;
    const reel = node.reelItemRenderer;
    let id = '';
    let text = '';
    let endpoint = null;
    if (lock) {
      const cmd = lock.onTap && lock.onTap.innertubeCommand;
      const rwe = cmd && cmd.reelWatchEndpoint;
      id = (rwe && rwe.videoId) || '';
      if (rwe) {
        // What YouTube's own page sends when the Short is clicked: with the
        // sequence, the Shorts after it continue through the same results.
        endpoint = {
          videoId: rwe.videoId,
          playerParams: rwe.playerParams,
          params: rwe.params,
          sequenceProvider: rwe.sequenceProvider,
          sequenceParams: rwe.sequenceParams,
        };
      }
      const meta = lock.overlayMetadata && lock.overlayMetadata.primaryText;
      text = (meta && meta.content) || lock.accessibilityText || '';
    } else if (reel) {
      id = reel.videoId || '';
      text = serumText(reel.headline) || (reel.accessibility && reel.accessibility.accessibilityData && reel.accessibility.accessibilityData.label) || '';
    }
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(endpoint ? { id, text, endpoint } : { id, text });
    }
    for (const k in node) walk(node[k]);
  };
  walk(data);
  return out;
}

// The token for the next page of results ("continuation"), or ''.
function serumFindContinuation(data) {
  let token = '';
  const walk = node => {
    if (token || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const c = node.continuationItemRenderer;
    const cmd = c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand;
    if (cmd && cmd.token) {
      token = cmd.token;
      return;
    }
    for (const k in node) walk(node[k]);
  };
  walk(data);
  return token;
}

// The web client's version, which YouTube's own next-page requests send.
function serumClientVersion(html) {
  const m = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/);
  return m ? m[1] : '2.20250101.00.00';
}

// The body of the next-page request YouTube's own page makes.
function serumContinuationBody(token, clientVersion) {
  return JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion } }, continuation: token });
}

if (typeof module !== 'undefined') {
  module.exports = {
    SERUM_DEFAULTS,
    SERUM_MAX_KEYWORDS,
    serumWordRegex,
    serumSentenceTest,
    serumMatcher,
    serumExtractInitialData,
    serumParseVideos,
    serumParseShorts,
    serumText,
    serumFindContinuation,
    serumClientVersion,
    serumContinuationBody,
  };
}
