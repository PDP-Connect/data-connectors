# YouTube on PageShim

The explicit entry forwards saved state and the host's state capability to the
shared runtime. Every stream reuses the Desktop collector and its
source-evidence checks: profile, subscriptions, playlists, playlist_items, likes,
watch_later and watch_history. Connector-local adapters implement
count/click/readiness using evaluate and use bounded local sleeps; no missing
facade member is probed.

Record IDs use WebCrypto SHA-256 with the same 24-hex-character IDs as Desktop.
Timing uses the browser/global performance clock. History traversal limits and
completeness checks are Desktop's.

## Watch history

Desktop correlates the history page's `/youtubei/v1/browse` continuation
responses with the rows it reads, and claims the end only from a correlated
response without a continuation. The facade has no response events, so on
PageShim those responses come from the shared in-page capture
(`packages/polyfill-connectors/src/page-exchange-capture.ts`, through
`pageShimHistoryResponses`). The Desktop tracker receives them in arrival
order each time it flushes.

- With `page_init_script`, the capture runs at the start of the history
  document and sees every browse response.
- Without it, the capture is installed after the page loads. A continuation
  the page sent before then is missed. Later tokens then do not correlate, so
  the walk keeps the rows it read and reports the list as not proven complete.
- A full capture buffer, a replaced document or an unreadable drain makes the
  response source incomplete, with the same result.

Records and cursors are Desktop's. Record IDs are `history|<video>|<date>`;
before 0.2.49 Mobile used `history|<video>` and read at most 50 rows, so the
first run after the update writes new record IDs for rows it saved before.

`scripts/pageshim/pageshim.test.mjs` runs a synthetic history app in both
install modes: continuations over XHR and fetch to the end, an error status, a
replaced document, and a continuation sent while the document loads.

## Device validation still required

Capabilities declare same_origin_page_fetch for page-origin requests and
page_script_evaluation for in-page scripts (including fetch of any origin).
There is no cross_origin capability. Actual device CORS behavior remains unverified.

Fixtures are synthetic Chromium harness evidence, not a real mobile device run.
Verify mobile WebView DOM/layout parity (especially m.youtube.com redirects),
account-menu click behavior, login/consent walls and session loss, WebCrypto
availability, evaluate size/30-second call limits under slow networks, real
playlist/subscription continuation and exhaustion evidence, and accepted STATE
persistence on supported hosts. For watch history, confirm that the mobile
history page sends its continuations to `/youtubei/v1/browse` through the page's
own fetch or XMLHttpRequest, and that a full read ends with a correlated
response without a continuation (the `history_capture` and `history_latest`
diagnostics show both).
