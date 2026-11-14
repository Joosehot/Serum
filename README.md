# Serum

A Chrome extension (Manifest V3) for personal use: YouTube shows only what
you actually want, on the homepage, the sidebar, search and Shorts.

There is no AI and no outside server. Everything runs in your browser. The
only requests Serum makes are to youtube.com itself, for the refill searches,
and to YouTube's own image hosts, i.ytimg.com (thumbnails) and
yt3.ggpht.com (channel pictures).

## What it does

- **Keywords.** Each video card is scored by matching your keywords against
  its title and channel name. Matching ignores case, and a keyword must stand
  as a whole word, so `rust` matches "Rust 1.80" but not "trust". A card that
  matches no keyword is hidden.
- **Blocklist.** A card that matches a blocklist word is always hidden, even
  if it also matches a keyword.
- **No flashing.** Every video card is hidden until Serum has judged it, so a
  card that doesn't match never shows for a moment. Serum starts with the page
  (`document_start`). It judges each batch of new cards in its
  MutationObserver, before the browser paints them. Cards are judged again
  when YouTube reuses them for other videos.
- **An endless feed, in two places.** Serum draws its own feed, "Serum: from
  your keywords", in place of YouTube's list:
  - **on the homepage,** instead of the grid of cards (the chips bar stays);
  - **beside a video,** instead of the suggestions, as one column like
    YouTube's.
  - **What's in it.** The videos YouTube put there that match a keyword
    (tagged `#for you` on the homepage and `#related` beside a video), mixed
    with keyword search results, three keywords per round in turn. Beside a
    video, the matching suggestions come first.
  - **Where results come from.** The first page of a keyword is
    `https://www.youtube.com/results?search_query=<keyword>`, read from its
    `ytInitialData`. Later pages are fetched the way YouTube's own page does
    it: a continuation token sent to `youtube.com/youtubei/v1/search`.
  - **Scrolling.** When you scroll within about two screens of the end, the
    next 18 cards load, so you can scroll on until the right video shows up.
  - **What's skipped.** A video is never added twice, and blocklisted videos
    are skipped.
  - **The end.** The feed ends only when every keyword's results run out, and
    then it says so.
  - **Logging.** Each round is logged in the page's console as
    `[Serum] feed: ...`.
- **Shorts.** When the Short on screen doesn't match, Serum moves on to the
  next one by itself. After 30 skips in a row it stops and tells you, so it
  never loops forever.
- **Popup.** It has an on/off switch, the number of brain-rot videos hidden
  today (Shorts skipped count too), and the keyword and blocklist lists. The
  lists are saved in `chrome.storage.sync`, so they follow your Chrome
  profile.

With no keywords at all, nothing is hidden for lack of a match; only the
blocklist applies.

## Install (Load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder (the one with
   `manifest.json`).
4. Pin Serum: click the puzzle-piece icon in the toolbar, then the pin next
   to Serum.
5. Open youtube.com, or reload it if it was already open.

After changing the code, click the reload arrow on Serum's card in
`chrome://extensions`, then reload YouTube.

## Use

- Click the Serum icon to open the popup.
- Add keywords. You can add several at once, separated by commas:
  `business, tech, computers, rust programming`.
- Remove a word with ×.
- Changes apply at once on open YouTube tabs.

The defaults are `business`, `tech`, `computers` and `rust`. Tip: `rust` on
its own also brings in videos of the game Rust; `rust programming` or
`rustlang` is narrower. A keyword can be several words; they must then appear
together, in that order.

## Files

| file | what it is |
|---|---|
| `manifest.json` | the extension's description, permissions (`storage` only) and content script |
| `lib.js` | matching and reading `ytInitialData`; no DOM, so Node can test it |
| `content.js` | runs on youtube.com: filtering, refill, Shorts skipping, the counter |
| `content.css` | hides cards and styles the refill cards |
| `popup.html`, `popup.js`, `popup.css` | the popup |
| `test.js` | `node test.js` checks the matching and the parser; `node test.js --live` also reads a real search page |

## Limits

- YouTube changes its page structure now and then. The card and Shorts
  selectors are at the top of `content.js` (`CARD_SELECTOR`, `checkShorts`).
  When something stops being hidden, those are the places to look.
- Refill cards are Serum's own cards, laid out like YouTube's (thumbnail,
  channel picture, title, channel, views, age). They have no hover preview
  and no YouTube menu.
- The counter counts each hidden video once per page load, so a video hidden
  again after a reload counts again.
