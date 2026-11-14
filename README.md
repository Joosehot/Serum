# Serum

A Chrome extension (Manifest V3) for personal use: YouTube shows only what
you actually want, on the homepage, the sidebar, search and Shorts.

There is no AI and no outside server. Everything runs in your browser. The
only requests Serum makes are to youtube.com itself, for the refill searches,
and to YouTube's own thumbnail host, i.ytimg.com.

## What it does

- **Keywords.** Each video card is scored by matching your keywords against
  its title and channel name. Matching ignores case, and a keyword must stand
  as a whole word, so `rust` matches "Rust 1.80" but not "trust". A card that
  matches no keyword is hidden.
- **Blocklist.** A card that matches a blocklist word is always hidden, even
  if it also matches a keyword.
- **Live filtering.** YouTube loads videos while you scroll, so a
  MutationObserver re-checks the page as cards arrive. Cards are checked again
  when YouTube reuses them for other videos.
- **Refill.** On the homepage Serum fetches
  `https://www.youtube.com/results?search_query=<keyword>` for up to three of
  your keywords in turn. It reads the videos out of the page's
  `ytInitialData` and adds them as cards in a "Serum: from your keywords"
  block above the feed, so you see more than your subscriptions. The first
  round comes at once. More rounds come when fewer than 12 cards are showing,
  or when another 18 were hidden as you scrolled. The keywords are mixed, a
  video already on the page is never added twice, and blocklisted videos are
  skipped. A refill happens at most once every 15 s, and at most 96 cards are
  added to one page. Each refill is logged in the page's console as
  `[Serum] refill: ...`.
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
- Refill cards are Serum's own simple cards. They have no hover preview and
  no YouTube menu.
- The counter counts each hidden video once per page load, so a video hidden
  again after a reload counts again.
