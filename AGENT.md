# Reorder Saved for Later - Amazon

Chrome (Manifest V3) extension that lets you drag-and-drop (or type a new
position number) to reorder items in Amazon's "Saved for later" cart
section, then applies that order for real on amazon.com by driving the
page's own "Move to cart" / "Save for later" controls to bump items into
place.

No data is collected, stored remotely, or transmitted anywhere — all state
lives in the popup's memory, the content script's in-page memory, and
`chrome.storage.local` (extension settings only).

## Architecture

- `manifest.json` — MV3 manifest. Content script is injected on all Amazon
  storefront domains listed under `content_scripts.matches`. Popup is
  `popup.html` (no background service worker).
- `popup.html` / `popup.js` — the toolbar popup UI. Renders the saved-item
  list, handles drag-and-drop and numeric-position reordering, polls the
  content script for live item snapshots and apply-progress, and stores
  user settings (bump delay, reload-after-apply) via `chrome.storage.local`.
  Manual reordering (drag or typed position) is mirrored to the content
  script as a "pending order" so it survives the popup being closed before
  Apply is hit — Chrome discards all popup JS state on close, there's no
  other way to keep it. `naturalOrder` tracks the order items actually
  appear in on the page (independent of manual reordering) so the "Reset"
  button can revert to it.
- `content.js` — injected into the Amazon cart page. Scans the DOM for
  saved-for-later rows (`scanItems`), optionally auto-scrolls to force lazy
  loading of the full list (`autoScrollToLoadAll`), computes a bump plan to
  reach a target order (`computeBumpPlan`), and executes it by clicking
  Amazon's real "Move to cart" / "Save for later" buttons per item
  (`bumpItem`, `applyOrder`). Also holds the in-memory `pendingOrder` — the
  not-yet-applied manual reorder — deliberately kept here instead of
  `chrome.storage.local`: this script is destroyed and re-injected fresh on
  every page reload/navigation/tab close, so `pendingOrder` resets to
  `null` automatically exactly when the page session resets, instead of
  silently reapplying a stale order later. It's cleared as soon as
  `SFL_APPLY_ORDER` is received (the applied order becomes the new natural
  order). Communicates with `popup.js` over `chrome.runtime.onMessage`
  using message types prefixed `SFL_*` (`SFL_PING`, `SFL_GET_ITEMS`,
  `SFL_GET_LOAD_STATUS`, `SFL_GET_STATUS`, `SFL_APPLY_ORDER`,
  `SFL_SET_PENDING_ORDER`, `SFL_GET_PENDING_ORDER`).
- `content.css` — minimal styling injected alongside the content script.
- `icons/` — extension icons at 16/32/48/128px, generated from a single
  source image via `sips`. Regenerate all four sizes together if the icon
  changes; don't hand-edit individual sizes.

## Notes for future changes

- Amazon's DOM structure for the cart page is not versioned or documented
  anywhere — `content.js`'s selectors are inherently fragile scraping logic
  tied to Amazon's current markup. If reordering stops working, that's the
  first place to check against the live page.
- The extension reorders by simulating real user actions (moving items to
  cart and back to saved-for-later) because Amazon has no API for
  reordering saved items directly — there is no shortcut around this.
- Items marked "Currently unavailable" or "This item is no longer
  available from the seller you selected" have no working "Move to cart"
  control, which `getCandidateItemRows` (`content.js`) requires to detect a
  row at all — see `isMoveToCartElement`. These items are therefore
  invisible to the extension entirely: never scanned, never shown in the
  popup, never bumped, and left wherever they sit in Amazon's real list
  when applying an order around them. Documented for users in `README.md`.
- Popup CSS intentionally matches Amazon's own visual language (yellow
  primary CTA `#ffd814`, navy `#0f1111`/`#232f3e`, pill-shaped buttons,
  `#e77600` orange accents) — keep new UI consistent with that palette.
