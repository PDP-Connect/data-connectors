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
when the walk stops keeps a scroll still queued from scrolling afterwards. The limit: on a stalled bridge, a scroll queued ahead of the stop token still runs when the bridge recovers. Setup (hydration wait, readiness handle read and dispose) runs under the same deadline and fails closed with `youtube_history_setup_timeout` before any record is emitted. A history browse still in
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


## One outer deadline and the await inventory

The whole history path, from the browser-date evaluation to the last STATE
acknowledgement, runs under one outer deadline (`HISTORY_OUTER_DEADLINE_MS`,
10 minutes) in `collectYoutubeBrowser`. It covers every await under it,
including any an inner deadline misses; the inner deadlines only make the
failure reason more specific. On expiry the path is abandoned (its late emits
are dropped, so no STATE can follow), and the stream fails with a fixed reason:
`youtube_history_outer_timeout`, or `youtube_history_state_unacknowledged` with
`outcome: "unknown"` when a STATE was sent and never acknowledged. The outcome
of that STATE is unknown, never reported as success. The checkpoint stays at the
rows already acknowledged, because the one STATE is written last.

Every `await` on the path, entry to exit. "Outer only" means no inner deadline
covers it; the outer deadline covers every row. Line numbers are for
`connectors/youtube/index.ts` at this version.

| Line | Function | Await | Inner deadline |
| --- | --- | --- | --- |
| index.ts:169 | readBrowseRequestBody | `? JSON.parse(await gunzipText(new Uint8Array(buffer)))` | body-read deadline (5 s) |
| index.ts:309 | withinDeadline | `return await Promise.race([` | is itself the inner deadline |
| index.ts:201 | evaluateWithinDeadline | `return await Promise.race([` | is itself the inner deadline |
| index.ts:290 | settlesWithin | `return await Promise.race([` | is itself the inner deadline |
| index.ts:271 | loopCall | `return await Promise.race([` | is itself the inner deadline |
| index.ts:245 | raceOuterDeadline | `return await Promise.race([` | is itself the outer deadline |
| index.ts:432 | HistoryResponseTracker.attach | `const result = await evaluateWithinDeadline(` | install evaluate: 5 s evaluate deadline |
| index.ts:535 | HistoryResponseTracker.flush | `const settled = await withinDeadline(` | flush deadline (loop-call deadline) |
| index.ts:537 | HistoryResponseTracker.flush | `await this.pending;` | flush deadline (loop-call deadline) |
| index.ts:538 | HistoryResponseTracker.flush | `await this.drainPageLog();` | flush deadline (loop-call deadline) |
| index.ts:563 | HistoryResponseTracker.drainPageLog | `const result = await evaluateWithinDeadline(` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:584 | HistoryResponseTracker.drainPageLog | `await this.observe({` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:597 | HistoryResponseTracker.drainPageLog | `await this.page.waitForTimeout(PAGE_LOG_DRAIN_WAIT_MS);` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:619 | HistoryResponseTracker.inspectFailure | `await this.observe({` | body-read deadline (5 s) |
| index.ts:620 | HistoryResponseTracker.inspectFailure | `requestBody: await decodeBrowseRequestBody(request),` | body-read deadline (5 s) |
| index.ts:628 | HistoryResponseTracker.inspect | `await this.observe({` | body-read deadline (5 s) for the request body and the response scan |
| index.ts:629 | HistoryResponseTracker.inspect | `requestBody: await decodeBrowseRequestBody(response.request()),` | body-read deadline (5 s) for the request body and the response scan |
| index.ts:663 | HistoryResponseTracker.observe | `const scan = await observation.readScan();` | scan read: body-read deadline (5 s) |
| index.ts:707 | HistoryResponseTracker.observe | `const scan = await observation.readScan();` | scan read: body-read deadline (5 s) |
| index.ts:941 | waitForContentBounded | `const handle = await page.waitForFunction(` | setup deadline (loop-call deadline) |
| index.ts:950 | waitForContentBounded | `const state = (await handle.jsonValue()) as "content" / "empty";` | setup deadline (loop-call deadline) |
| index.ts:951 | waitForContentBounded | `await handle.dispose();` | setup deadline (loop-call deadline) |
| index.ts:957 | waitForContentBounded | `const settled = await withinDeadline(sequence, historyLoopCallDeadline` | setup deadline (loop-call deadline) |
| index.ts:1434 | scrollHistoryOnce | `const geometry = (await loopCall(` | loopCall at the call site (60 s) |
| index.ts:1473 | scrollHistoryOnce | `await page.waitForTimeout(` | loopCall at the call site (60 s) |
| index.ts:1491 | readHistoryVideoList | `const navigated = await settlesWithin(` | navigation deadline (budget + loop-call deadline) |
| index.ts:1509 | readHistoryVideoList | `const hydrated = await withinDeadline(` | hydration deadline (loop-call deadline) |
| index.ts:1518 | readHistoryVideoList | `const state = await waitForContentBounded(` | setup deadline (loop-call deadline) |
| index.ts:1535 | readHistoryVideoList | `await responseTracker.attach();` | install evaluate deadline (5 s) |
| index.ts:1536 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1539 | readHistoryVideoList | `let currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1541 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1548 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1549 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1551 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1608 | readHistoryVideoList | `const rawBatch: unknown = await loopEvaluate(` | loop-call deadline (60 s) |
| index.ts:1626 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1627 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1629 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1681 | readHistoryVideoList | `lastScrollGeometry = await loopCall(` | loop-call deadline (60 s) |
| index.ts:1687 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1688 | readHistoryVideoList | `const afterScrollRaw: unknown = await loopEvaluate(` | loop-call deadline (60 s) |
| index.ts:1697 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1699 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1763 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1782 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1807 | readHistoryVideoList | `await withinDeadline(` | stop-token evaluate deadline (5 s) |
| index.ts:1814 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1817 | readHistoryVideoList | `const waited = await withinDeadline(` | final-refresh wait deadline (loop-call deadline) |
| index.ts:1832 | readHistoryVideoList | `const refreshed = await evaluateWithinDeadline(` | evaluate deadline (5 s), final refresh |
| index.ts:1836 | readHistoryVideoList | `sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),` | evaluate deadline (5 s), final refresh |
| index.ts:1845 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:2105 | readableVideos | `? await readWatchHistoryList(` | outer only |
| index.ts:2114 | readableVideos | `: await readPlaylistVideoList(ctx.page, url, rounds, ctx.capture);` | outer only |
| index.ts:2119 | readableVideos | `await streams.fail(` | outer only |
| index.ts:2133 | readableVideos | `await streams.fail(` | outer only |
| index.ts:2590 | collectYoutubeBrowser (history block) | `const browserDate = await page.evaluate(readBrowserDate);` | outer only |
| index.ts:2596 | collectYoutubeBrowser (history block) | `const result = await readableVideos(` | outer only |
| index.ts:2609 | collectYoutubeBrowser (history block) | `await emitHistoryRecord({` | outer only |
| index.ts:2610 | collectYoutubeBrowser (history block) | `id: await youtubeRecordId(` | outer only |
| index.ts:2637 | collectYoutubeBrowser (history block) | `? await youtubeRecordId(result.checkpointAnchor)` | outer only |
| index.ts:2645 | collectYoutubeBrowser (history block) | `await emitVerifiedEmptyState(historyCtx, "watch_history", capturedAt);` | outer only |
| index.ts:2662 | collectYoutubeBrowser (history block) | `await historyCtx.emit({` | outer only |
