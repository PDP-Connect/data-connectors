# YouTube on PageShim

The explicit entry forwards saved state and the host's state capability to the
shared runtime. The six non-history streams reuse the Desktop collector and its
source-evidence checks: profile, subscriptions, playlists, playlist_items, likes,
and watch_later. Connector-local adapters implement count/click/readiness using
evaluate and use bounded local sleeps; no missing facade member is probed.

Record IDs use WebCrypto SHA-256 with the same 24-hex-character IDs as Desktop.
Timing uses the browser/global performance clock. Desktop response correlation,
history traversal limits, and completeness checks are unchanged.

## History

Watch history runs Desktop's own traversal (`readHistoryVideoList`) through the
adapter: scroll rounds, row reading in 50-row batches, stop reasons, the
resumable checkpoint, the partial-budget rules and the STATE it emits. There is
no row cap on this port.

The facade has no response events, so Desktop's `page.on("response")` feed is
replaced by a page-side log. After the history page loads, `installHistoryBrowseLog`
(page-evidence.ts) wraps `window.fetch` once. For each `/youtubei/v1/browse`
call it clones the Request before the original fetch runs (afterwards the body is
used), decodes the gzip body with `DecompressionStream`, and keeps the request
continuation token or browseId, the status, and a compact scan of the response
(recognized, has continuation, item count, next token). An XHR browse is logged
the same way when the call ends (`loadend`), with its request body and status;
a failed or aborted XHR logs status 0. Each send binds its own `loadend` listener (once), so a reused XHR logs each call once with its own body, and the response is read by `responseType` (`json` from `response`, `''` or `text` from `responseText`, any other type unreadable). Response bodies (about 450 KB) never cross to the
host; the log holds at most 32 entries and flags overflow. The traversal drains
the log each round, waits a bounded time for calls still in flight, and feeds
the same transport-free tracker step Desktop uses. The page scan and the host
evidence are one implementation (`HISTORY_RESPONSE_SCAN_SOURCE`).

The proof rules are strict. A response counts as recognized only when it carries
readable rows or an explicit continuation item; a list key alone proves nothing.
Any correlated non-2xx answer, and any browse call the run cannot attribute
(XHR, an undecodable body, an over-long or unknown continuation token) after the
last terminal response, vetoes the end claim for the run. A request for another
page (a browseId other than history, no continuation) is counted as foreign and
ignored only when its response is 2xx, reads, and shows no rows and no
continuation; otherwise it counts as uncorrelated. A request that failed at the
transport is classified like a non-2xx answer: a failed history call (the initial
request, or a known token) vetoes the run. Any transport failure also sets a
sticky veto (`history-browse-failed`) that no later reply, terminal or not,
clears within the run, so a failure the run cannot attribute (no body, or a
foreign body) cannot be hidden by a recognized terminal response. The whole
body read (bytes, decode, parse) gets one bounded deadline (five seconds): a
response body that stalls counts as unreadable, and a request body whose decode
stalls counts as unattributable; both veto completion without stalling the
chain. Every `page.evaluate` in the page-log drain and in the final refresh gets
the same deadline; a timeout is incomplete evidence (`history-evidence-timeout`)
and vetoes completion. On Desktop, each evaluate and capture in the history walk
races one generous deadline (`HISTORY_LOOP_CALL_DEADLINE_MS`, 60 s); a stalled
call ends the walk with `history-loop-timeout`: no complete STATE, the stream
fails, and the checkpoint stays tied to the rows already accounted. The record callback runs under the same deadline
(`history-record-timeout`), each tracker flush too (a stalled wait bridge marks
the evidence incomplete, so no complete STATE), and a stop token set in the page
when the walk stops keeps a scroll still queued from scrolling afterwards. A history browse still in
flight (started, not yet answered or failed) keeps the final refresh from being
stable, bounded by the three refreshes and the page-log drain wait. A veto blocks the complete STATE only; the partial checkpoint rests on
rows already read and is kept. On this path the terminal logged response must also
account for the page: if the page shows more rows than the bootstrap plus the
logged responses carried, or still shows a continuation, the log is blind (a
fetch captured before the wrapper, or a replaced `fetch`) and the run fails
closed with `history-log-blind`. A request that carries both `browseId` and a
continuation keeps both; `content-encoding` is read as a token list.

The run still ends failed (`stream_collection_failed`, retry_by_runtime, no STATE)
when the wrapper cannot be installed or is lost to a navigation, the log
overflows, a call stays unfinished, a body cannot be decoded, or the correlated
responses do not prove the end. A failed history read passes bounded diagnostics
(stop reason, counts, proof kind, correlation counts; never ids, titles, dates,
URLs or tokens) to the stream failure.

What stays unproven on a device: that the mobile WebView lets the page wrap
`fetch` before YouTube's player code runs, supports `DecompressionStream`,
sends the browse calls through `fetch` (not XHR or a service worker), and keeps
the page alive through a long scroll under the 30-second evaluate limit. The
wrapper and gzip decode were checked in headless Chromium only. Until a device
run shows a complete history, treat a phone history as read-through-proof, not
as a verified full export.

The shared PageShim runtime classifies the failed stream as Partial. Regression
coverage runs a multi-batch gzip continuation walk to the source end (with STATE)
and a page whose calls the wrapper cannot see (incomplete, no STATE) on both
one-message and streaming hosts. Owner-bound, source-verified empty history
retains its empty STATE.

## Device validation still required

Capabilities declare same_origin_page_fetch for page-origin requests and
page_script_evaluation for in-page scripts (including fetch of any origin).
There is no cross_origin capability. Actual device CORS behavior remains unverified.

Fixtures are synthetic Chromium harness evidence, not a real mobile device run.
Verify mobile WebView DOM/layout parity (especially m.youtube.com redirects),
account-menu click behavior, login/consent walls and session loss, WebCrypto
availability, evaluate size/30-second call limits under slow networks, real
playlist/subscription continuation and exhaustion evidence, and accepted STATE
persistence on supported hosts. Do not claim a verified full history export from this port until a device run shows one.
