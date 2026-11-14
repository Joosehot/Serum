// Runs in YouTube's own JavaScript world (manifest: "world": "MAIN"), where
// it can ask YouTube's app to open a page the way its own links do, without
// reloading. content.js sends {"serum-go": "/shorts/<id>"}; only Shorts
// addresses are accepted.
'use strict';

document.addEventListener('serum-go', e => {
  const url = String(e.detail || '');
  const m = url.match(/^\/shorts\/([\w-]{11})$/);
  const app = document.querySelector('ytd-app');
  if (!m || !app) return;
  const endpoint = {
    commandMetadata: { webCommandMetadata: { url, webPageType: 'WEB_PAGE_TYPE_SHORTS', rootVe: 37414 } },
    reelWatchEndpoint: { videoId: m[1] },
  };
  app.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail: { endpoint } }));
});
