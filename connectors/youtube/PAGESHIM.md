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
resumable checkpoint and the STATE it emits. There is
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


## The no-progress watchdog and the await inventory

The whole history path, from the browser-date evaluation to the last STATE
acknowledgement, runs under one no-progress watchdog (`HISTORY_OUTER_DEADLINE_MS`,
10 minutes) in `collectYoutubeBrowser`. It is not a cap on total length: each real
progress event re-arms it: a STATE or record acknowledged, or a row identity this
run has not seen before (from a browse response or the walk). A scan that keeps
returning the same rows re-arms nothing. The progress channel is one object per
run, passed to the walk and the tracker, and closed on every exit path, so a
second run on the same page never meets the first run's hook. So a long history that keeps
moving never expires. A path that goes the full window with no progress expires.
Ten minutes is above the longest legitimate gap between events: setup before the
first row takes about 6 minutes at worst (navigation up to 180 s plus a 60 s
margin, then the hydration and readiness waits at up to 60 s each), and one walk
round makes about five bridge calls, each bounded at 60 s. It covers every await
under it, including any an inner deadline misses; the inner deadlines only make
the failure reason more specific. On expiry the path is abandoned (its late emits
are dropped, so no STATE can follow), and the stream fails with a fixed reason:
`youtube_history_outer_timeout`, or `youtube_history_state_unacknowledged` with
`outcome: "unknown"` when a STATE was sent and never acknowledged. The outcome of
that STATE is unknown, never reported as success. The checkpoint stays at the rows
already acknowledged, because the one STATE is written last. After expiry the two
sink writes (the failure report, then the coverage progress write) each run under
their own fixed deadline (`HISTORY_EXPIRY_SINK_DEADLINE_MS`, 15 s). A sink that
stalls or rejects is logged as `history_expiry_sink` with `outcome: "unknown"`
and collection settles anyway; the write is not retried.

The walk has no time cap and no round cap. Run N+1 always navigates to
`feed/history` and starts at the top: the connector sends no cursor or
continuation token of its own, because the page issues its own continuation
requests as it scrolls. A resumed run therefore re-scrolls the prefix it already
has. Under a per-run time or round budget, a history longer than one budget
could never complete: every run would stop at the same frontier (a test with a
history three budgets long, over eight runs, stayed at its first run's rows).
The old `HISTORY_TIME_BUDGET_MS` (180 s) and `HISTORY_MAX_SCROLL_ROUNDS` (400)
came from #414 as per-run bounds on memory and time, not from a platform limit;
no host run limit for them was found in this repo. Both are removed. The
continuation-token sets lost their count cap for the same reason: a cap would
leave later pages uncorrelated. The remaining 180 s constant,
`HISTORY_SETUP_BUDGET_MS`, bounds only the setup navigation. Only this watchdog
ends a walk that stops moving. The 60 s per-call deadlines, the 5 s evidence
deadlines and the navigation deadline bound one call, not the walk.

Every `await` on the path, entry to exit. "Outer only" means no inner deadline
covers it; the watchdog covers every row. Line numbers are for
`connectors/youtube/index.ts` at this version.

| Line | Function | Await | Inner deadline |
| --- | --- | --- | --- |
| index.ts:174 | readBrowseRequestBody | `? JSON.parse(await gunzipText(new Uint8Array(buffer)))` | body-read deadline (5 s) |
| index.ts:405 | withinDeadline | `return await Promise.race([` | is itself the inner deadline |
| index.ts:206 | evaluateWithinDeadline | `return await Promise.race([` | is itself the inner deadline |
| index.ts:386 | settlesWithin | `return await Promise.race([` | is itself the inner deadline |
| index.ts:341 | settleSink | `settled = await settlesWithin(work, historyExpirySinkDeadlineMs);` | is itself the sink deadline (15 s) |
| index.ts:367 | loopCall | `return await Promise.race([` | is itself the inner deadline |
| index.ts:307 | raceNoProgress | `return await Promise.race([` | is itself the watchdog |
| index.ts:533 | HistoryResponseTracker.attach | `const result = await evaluateWithinDeadline(` | install evaluate: 5 s evaluate deadline |
| index.ts:636 | HistoryResponseTracker.flush | `const settled = await withinDeadline(` | flush deadline (loop-call deadline) |
| index.ts:638 | HistoryResponseTracker.flush | `await this.pending;` | flush deadline (loop-call deadline) |
| index.ts:639 | HistoryResponseTracker.flush | `await this.drainPageLog();` | flush deadline (loop-call deadline) |
| index.ts:664 | HistoryResponseTracker.drainPageLog | `const result = await evaluateWithinDeadline(` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:685 | HistoryResponseTracker.drainPageLog | `await this.observe({` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:698 | HistoryResponseTracker.drainPageLog | `await this.page.waitForTimeout(PAGE_LOG_DRAIN_WAIT_MS);` | evaluate deadline (5 s) for the drain; wait covered by the flush deadline |
| index.ts:720 | HistoryResponseTracker.inspectFailure | `await this.observe({` | body-read deadline (5 s) |
| index.ts:721 | HistoryResponseTracker.inspectFailure | `requestBody: await decodeBrowseRequestBody(request),` | body-read deadline (5 s) |
| index.ts:729 | HistoryResponseTracker.inspect | `await this.observe({` | body-read deadline (5 s) for the request body and the response scan |
| index.ts:730 | HistoryResponseTracker.inspect | `requestBody: await decodeBrowseRequestBody(response.request()),` | body-read deadline (5 s) for the request body and the response scan |
| index.ts:764 | HistoryResponseTracker.observe | `const scan = await observation.readScan();` | scan read: body-read deadline (5 s) |
| index.ts:806 | HistoryResponseTracker.observe | `const scan = await observation.readScan();` | scan read: body-read deadline (5 s) |
| index.ts:1038 | waitForContentBounded | `const handle = await page.waitForFunction(` | setup deadline (loop-call deadline) |
| index.ts:1047 | waitForContentBounded | `const state = (await handle.jsonValue()) as "content" / "empty";` | setup deadline (loop-call deadline) |
| index.ts:1048 | waitForContentBounded | `await handle.dispose();` | setup deadline (loop-call deadline) |
| index.ts:1054 | waitForContentBounded | `const settled = await withinDeadline(sequence, historyLoopCallDeadline` | setup deadline (loop-call deadline) |
| index.ts:1530 | scrollHistoryOnce | `const geometry = (await loopCall(` | loopCall at the call site (60 s) |
| index.ts:1569 | scrollHistoryOnce | `await page.waitForTimeout(HISTORY_SCROLL_WAIT_MS);` | loopCall at the call site (60 s) |
| index.ts:1586 | readHistoryVideoList | `const navigated = await settlesWithin(` | navigation deadline (budget + loop-call deadline) |
| index.ts:1604 | readHistoryVideoList | `const hydrated = await withinDeadline(` | hydration deadline (loop-call deadline) |
| index.ts:1613 | readHistoryVideoList | `const state = await waitForContentBounded(` | setup deadline (loop-call deadline) |
| index.ts:1630 | readHistoryVideoList | `await responseTracker.attach();` | install evaluate deadline (5 s) |
| index.ts:1631 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1634 | readHistoryVideoList | `let currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1636 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1643 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1644 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1646 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1698 | readHistoryVideoList | `const rawBatch: unknown = await loopEvaluate(` | loop-call deadline (60 s) |
| index.ts:1716 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1717 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1719 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1767 | readHistoryVideoList | `lastScrollGeometry = await loopCall(` | loop-call deadline (60 s) |
| index.ts:1773 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1774 | readHistoryVideoList | `const afterScrollRaw: unknown = await loopEvaluate(` | loop-call deadline (60 s) |
| index.ts:1783 | readHistoryVideoList | `currentEnd = await loopEvaluate(readListEndInBrowser, {` | loop-call deadline (60 s) |
| index.ts:1785 | readHistoryVideoList | `sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),` | loop-call deadline (60 s) |
| index.ts:1849 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1868 | readHistoryVideoList | `await loopCall(` | loop-call deadline (60 s) |
| index.ts:1894 | readHistoryVideoList | `await withinDeadline(` | stop-token evaluate deadline (5 s) |
| index.ts:1901 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:1904 | readHistoryVideoList | `const waited = await withinDeadline(` | final-refresh wait deadline (loop-call deadline) |
| index.ts:1919 | readHistoryVideoList | `const refreshed = await evaluateWithinDeadline(` | evaluate deadline (5 s), final refresh |
| index.ts:1923 | readHistoryVideoList | `sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),` | evaluate deadline (5 s), final refresh |
| index.ts:1932 | readHistoryVideoList | `await responseTracker.flush();` | flush deadline |
| index.ts:2190 | readableVideos | `? await readWatchHistoryList(` | outer only |
| index.ts:2200 | readableVideos | `: await readPlaylistVideoList(ctx.page, url, rounds, ctx.capture);` | outer only |
| index.ts:2205 | readableVideos | `await streams.fail(` | outer only |
| index.ts:2219 | readableVideos | `await streams.fail(` | outer only |
| index.ts:2682 | collectYoutubeBrowser (history block) | `const browserDate = await page.evaluate(readBrowserDate);` | outer only |
| index.ts:2688 | collectYoutubeBrowser (history block) | `const result = await readableVideos(` | outer only |
| index.ts:2701 | collectYoutubeBrowser (history block) | `await emitHistoryRecord({` | outer only |
| index.ts:2702 | collectYoutubeBrowser (history block) | `id: await youtubeRecordId(` | outer only |
| index.ts:2730 | collectYoutubeBrowser (history block) | `? await youtubeRecordId(result.checkpointAnchor)` | outer only |
| index.ts:2738 | collectYoutubeBrowser (history block) | `await emitVerifiedEmptyState(historyCtx, "watch_history", capturedAt);` | outer only |
| index.ts:2755 | collectYoutubeBrowser (history block) | `await historyCtx.emit({` | outer only |
