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

// Build a matcher from the keyword and blocklist arrays.
// decide(text) returns 'show' or 'hide' and how many keywords matched.
function serumMatcher(keywords, blocklist) {
  const clean = list => (list || []).map(w => String(w).trim()).filter(Boolean);
  const keep = clean(keywords).map(serumWordRegex);
  const block = clean(blocklist).map(serumWordRegex);
  return {
    hasKeywords: keep.length > 0,
    decide(text) {
      if (block.some(re => re.test(text))) return { verdict: 'hide', score: 0, blocked: true };
      const score = keep.filter(re => re.test(text)).length;
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

if (typeof module !== 'undefined') {
  module.exports = { SERUM_DEFAULTS, serumWordRegex, serumMatcher, serumExtractInitialData, serumParseVideos, serumText };
}
