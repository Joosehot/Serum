// Runs in YouTube's own JavaScript world (manifest: "world": "MAIN"), where
// it can ask YouTube's app to open a video or a Short the way its own links
// do, without reloading. content.js sends "serum-go" with {url, endpoint}:
// - "/watch?v=<id>": a video from Serum's feed;
// - "/shorts/<id>": a Short; the endpoint is what a search result carries
//   (its sequence), so the Shorts after it continue through the same
//   results.
// Only these two kinds of address are accepted.
'use strict';

function serumShortsEndpoint(url, id, given) {
  const ep = given && given.videoId === id ? given : { videoId: id };
  const reelWatchEndpoint = { videoId: id };
  for (const k of ['playerParams', 'params', 'sequenceProvider', 'sequenceParams']) {
    if (typeof ep[k] === 'string') reelWatchEndpoint[k] = ep[k];
  }
  return {
    commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_SHORTS', rootVe: 37414 } },
    reelWatchEndpoint,
  };
}

function serumWatchEndpoint(url, id) {
  return {
    commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832 } },
    watchEndpoint: { videoId: id },
  };
}

document.addEventListener('serum-go', e => {
  let msg;
  try {
    msg = JSON.parse(String(e.detail || ''));
  } catch (err) {
    return;
  }
  const url = String(msg.url || '');
  const app = document.querySelector('ytd-app');
  if (!app) return;
  const short = url.match(/^\/shorts\/([\w-]{11})$/);
  const watch = url.match(/^\/watch\?v=([\w-]{11})$/);
  let endpoint;
  if (short) endpoint = serumShortsEndpoint(url, short[1], msg.endpoint);
  else if (watch) endpoint = serumWatchEndpoint(url, watch[1]);
  else return;
  app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
});
