// Runs in YouTube's own JavaScript world (manifest: "world": "MAIN"), where
// it can ask YouTube's app to open a Short the way its own links do, without
// reloading. content.js sends "serum-go" with {url: "/shorts/<id>", endpoint}:
// the endpoint is what a search result carries (its sequence), so the Shorts
// after it continue through the same results. Only Shorts addresses are
// accepted.
'use strict';

document.addEventListener('serum-go', e => {
  let msg;
  try {
    msg = JSON.parse(String(e.detail || ''));
  } catch (err) {
    return;
  }
  const m = String(msg.url || '').match(/^\/shorts\/([\w-]{11})$/);
  const app = document.querySelector('ytd-app');
  if (!m || !app) return;
  const ep = msg.endpoint && msg.endpoint.videoId === m[1] ? msg.endpoint : { videoId: m[1] };
  const reelWatchEndpoint = { videoId: m[1] };
  for (const k of ['playerParams', 'params', 'sequenceProvider', 'sequenceParams']) {
    if (typeof ep[k] === 'string') reelWatchEndpoint[k] = ep[k];
  }
  const endpoint = {
    commandMetadata: { webCommandMetadata: { url: msg.url, webPageType: 'WEB_PAGE_TYPE_SHORTS', rootVe: 37414 } },
    reelWatchEndpoint,
  };
  app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
});
