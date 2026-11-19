#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Browser-first YouTube Collection Profile. The owner signs in in PDPP's browser. */
import type { Request, Response } from "playwright";
import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	buildFullScanCoverageMessage,
	type BrowserCollectContext,
	type EnsureSessionArgs,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type BrowserVideo,
	CHANNEL_TITLE_SELECTOR,
	readChannelAbout,
	readChannelPage,
	openSwitchAccount,
	readGoogleAccountEmail,
	readOwnAccount,
	readPlaylistHeader,
	readPlaylistLinks,
	readSubscriptions,
	readVideos,
	type HistoryVideoPage,
} from "./browser-dom.ts";
import {
	enumerationEnded,
	drainHistoryBrowseLog,
	historyEvidenceFromScan,
	installHistoryBrowseLog,
	scanHistoryResponse,
	type HistoryBrowseLogEntry,
	type HistoryResponseScan,
	type ListEnd,
	type ListKind,
	type ListEndRequest,
	type HistoryResponseEvidence,
	readListEnd,
	readPageReadiness,
} from "./page-evidence.ts";
import { validateRecord } from "./schemas.ts";

export { readPageReadiness } from "./page-evidence.ts";

const HOME = "https://www.youtube.com/";
const HISTORY_READ_BATCH_SIZE = 50;
const HISTORY_DEDUP_WINDOW = 500;
/**
 * Bound on the history page's setup (navigation, hydration, first rows). It is a
 * per-call bound, not a limit on the walk: the walk has no time or round cap, and
 * only the no-progress watchdog ends a walk that is not moving. Not forced by the
 * platform; kept as the setup navigation timeout.
 */
const HISTORY_SETUP_BUDGET_MS = 180_000;
const HISTORY_SCROLL_WAIT_MS = 1_000;
const HISTORY_HEAD_REFRESH_ROUNDS = 3;
const HISTORY_HEAD_REFRESH_ROWS =
	HISTORY_READ_BATCH_SIZE * HISTORY_HEAD_REFRESH_ROUNDS;
const PAGE_HYDRATION_WAIT_MS = 2_000;
const SCROLLS = {
	subscriptions: 3,
	playlists: 5,
	playlist_items: 20,
} as const;
const LIST_CONTINUATION_SELECTORS: Record<ListKind, string> = {
	history: "ytd-item-section-renderer ytd-continuation-item-renderer",
	playlist:
		"ytd-playlist-video-list-renderer ytd-continuation-item-renderer, #contents ytd-playlist-video-list-renderer ytd-continuation-item-renderer",
	"playlist-index":
		"ytd-rich-grid-renderer ytd-continuation-item-renderer, ytd-grid-renderer ytd-continuation-item-renderer",
	subscriptions:
		"ytd-expanded-shelf-contents-renderer ytd-continuation-item-renderer",
};

type CoverageFact = {
	stream: string;
	requested: true;
	source: "browser";
	emitted_count: number;
	time_range_requested: boolean;
	enumerated_count?: number;
	parsed_count?: number;
	deduped_count?: number;
	stop_reason?: string;
	next_checkpoint?: string | null;
	incomplete?: boolean;
	unresolved_date_count?: number;
};

export async function youtubeRecordId(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

export function videoIdentity(video: BrowserVideo): string {
	if (video.video_id) return video.video_id;
	const url = new URL(video.video_url);
	url.searchParams.delete("list");
	url.searchParams.delete("index");
	return url.href;
}

function historyIdentity(video: BrowserVideo, dateReference: Date): string {
	const label = video.watched_date_label ?? null;
	const watchedDate = resolveWatchedDate(
		label,
		dateReference,
	);
	if (watchedDate) return `${videoIdentity(video)}|${watchedDate}`;
	const sectionLabel = label
		?.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLowerCase();
	const collectionDate = localDate(dateReference);
	return `${videoIdentity(video)}|unresolved:${collectionDate}:${sectionLabel ?? "unknown-section"}`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** One browse call, reduced to what the end proof needs, whichever transport saw it. */
type BrowseObservation = {
	/** Decoded request body; null when it could not be decoded. */
	readonly requestBody: HistoryBrowseLogEntry["requestBody"];
	readonly status: number;
	/** Read lazily: uncorrelated and non-2xx calls never pay for their body. */
	readonly readScan: () => Promise<HistoryResponseScan | null>;
};

const GZIP_MAGIC = [0x1f, 0x8b];

async function gunzipText(bytes: Uint8Array): Promise<string> {
	return new Response(
		new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
}

/**
 * Decode a browse request body without node:zlib (this file is bundled for
 * PageShim). YouTube sends a gzip body that postDataJSON cannot parse.
 * Returns null when it cannot be decoded.
 */
async function decodeBrowseRequestBody(
	request: Request,
): Promise<HistoryBrowseLogEntry["requestBody"]> {
	// Bytes, decode and parse all sit under one deadline; a stalled decode
	// leaves the request unattributable, which vetoes completion.
	return withinDeadline(readBrowseRequestBody(request), HISTORY_BODY_READ_DEADLINE_MS);
}

async function readBrowseRequestBody(
	request: Request,
): Promise<HistoryBrowseLogEntry["requestBody"]> {
	try {
		const buffer = request.postDataBuffer?.() ?? null;
		const gzipHeader = (request.headers?.()["content-encoding"] ?? "")
			.split(",")
			.some((token) => token.trim().toLowerCase() === "gzip");
		const gzipBody =
			buffer !== null &&
			buffer.length > 2 &&
			buffer[0] === GZIP_MAGIC[0] &&
			buffer[1] === GZIP_MAGIC[1];
		const parsed =
			buffer !== null && (gzipBody || gzipHeader)
				? JSON.parse(await gunzipText(new Uint8Array(buffer)))
				: request.postDataJSON();
		const body = recordValue(parsed);
		if (!body) return null;
		return {
			...(typeof body.browseId === "string" ? { browseId: body.browseId } : {}),
			...(typeof body.continuation === "string"
				? body.continuation.length <= 16384
					? { continuation: body.continuation }
					: { continuationTooLong: true }
				: {}),
		};
	} catch {
		return null;
	}
}

const PAGE_LOG_DRAIN_ATTEMPTS = 20;
const PAGE_LOG_DRAIN_WAIT_MS = 250;
/** One response body read gets this long; a stalled body must not stall the chain. */
const HISTORY_BODY_READ_DEADLINE_MS = 5000;

/** One PageShim or renderer evaluate in the drain or final proof gets this long. */
const HISTORY_EVALUATE_DEADLINE_MS = HISTORY_BODY_READ_DEADLINE_MS;

/**
 * The evaluate result, or null when it does not settle in time. A rejection
 * still propagates so callers keep their own handling of it.
 */
async function evaluateWithinDeadline<T>(work: Promise<T>): Promise<{ value: T } | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then((value) => ({ value })),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), HISTORY_EVALUATE_DEADLINE_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * One Desktop evaluate or capture in the history walk gets this long. It is
 * generous, because a scroll or a capture can be slow on a long history, but a
 * stalled renderer must not hang the run.
 */
export const HISTORY_LOOP_CALL_DEADLINE_MS = 60_000;
let historyLoopCallDeadlineMs = HISTORY_LOOP_CALL_DEADLINE_MS;
/** Test seam: a short deadline for the stalled-call test. Returns the previous value. */
export function setHistoryLoopCallDeadlineMsForTest(ms: number): number {
	const previous = historyLoopCallDeadlineMs;
	historyLoopCallDeadlineMs = ms;
	return previous;
}

/**
 * A no-progress watchdog over the whole history path, from the browser-date
 * evaluation to the last STATE acknowledgement. It is not a cap on total length:
 * every real progress event re-arms it (a row accounted or acknowledged, a browse
 * response that adds rows, a STATE acknowledged), so a long history that keeps
 * moving never expires. A path that goes the full window with no progress
 * expires. It covers every await under it, including any an inner deadline
 * misses; the inner deadlines only make the failure reason more specific.
 *
 * Ten minutes is above the longest legitimate gap between progress events. The
 * longest is setup, before the first row: a navigation up to HISTORY_SETUP_BUDGET_MS
 * (180 s) plus its 60 s bridge margin, then the hydration wait and the readiness
 * wait at up to 60 s each, about 6 minutes. In the walk, one round makes about
 * five bridge calls, each bounded at 60 s. A stall is any gap longer than this.
 */
export const HISTORY_OUTER_DEADLINE_MS = 600_000;
let historyOuterDeadlineMs = HISTORY_OUTER_DEADLINE_MS;
/** Test seam: a short no-progress window. Returns the previous value. */
export function setHistoryOuterDeadlineMsForTest(ms: number): number {
	const previous = historyOuterDeadlineMs;
	historyOuterDeadlineMs = ms;
	return previous;
}

/**
 * The progress channel of ONE history run. The walk and the tracker receive it
 * as an argument, so a second run on the same page never sees this run's hook,
 * and the run closes it on every exit path: a late event from an abandoned run
 * finds it closed and does nothing.
 *
 * Row progress re-arms the watchdog only when it names a row identity this run
 * has not seen before. A page that rescans the same rows forever is not moving.
 */
export class HistoryRunProgress {
	private rearm: (() => void) | undefined;
	private readonly seen = new Set<string>();

	open(rearm: () => void): void {
		this.rearm = rearm;
	}

	close(): void {
		this.rearm = undefined;
	}

	/** An acknowledged emit: always real progress. */
	acknowledged(): void {
		this.rearm?.();
	}

	/** Re-arms only when some identity is new in this run. */
	rows(identities: Iterable<string>): void {
		let fresh = false;
		for (const identity of identities) {
			if (this.seen.has(identity)) continue;
			this.seen.add(identity);
			fresh = true;
		}
		if (fresh) this.rearm?.();
	}
}

/**
 * "done" when the work settled (its rejection propagates); "expired" when the
 * window passed with no re-arm. The progress channel is closed on every path.
 */
export async function raceNoProgress(
	work: Promise<void>,
	progress: HistoryRunProgress,
): Promise<"done" | "expired"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let deadlineAt = performance.now() + historyOuterDeadlineMs;
	progress.open(() => {
		deadlineAt = performance.now() + historyOuterDeadlineMs;
	});
	try {
		return await Promise.race([
			work.then(() => "done" as const),
			new Promise<"expired">((resolve) => {
				const check = () => {
					const left = deadlineAt - performance.now();
					if (left <= 0) resolve("expired");
					else timer = setTimeout(check, left);
				};
				timer = setTimeout(check, historyOuterDeadlineMs);
			}),
		]);
	} finally {
		progress.close();
		clearTimeout(timer);
	}
}

/** How long each sink write after an expiry may take before the run settles anyway. */
export const HISTORY_EXPIRY_SINK_DEADLINE_MS = 15_000;
let historyExpirySinkDeadlineMs = HISTORY_EXPIRY_SINK_DEADLINE_MS;
/** Test seam: a short sink deadline. Returns the previous value. */
export function setHistoryExpirySinkDeadlineMsForTest(ms: number): number {
	const previous = historyExpirySinkDeadlineMs;
	historyExpirySinkDeadlineMs = ms;
	return previous;
}

/**
 * Wait for a sink write after the history path expired. A write that stalls or
 * rejects is logged as outcome unknown and the run settles; it is never retried.
 */
async function settleSink(work: Promise<unknown>, sink: string): Promise<void> {
	let settled = false;
	try {
		settled = await settlesWithin(work, historyExpirySinkDeadlineMs);
	} catch {
		// A rejection is an unknown outcome too.
	}
	if (!settled)
		connectorDiagnostic("youtube", "history_expiry_sink", {
			sink,
			outcome: "unknown",
		});
}

class HistoryLoopTimeout extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super("history_loop_call_timeout");
		this.reason = reason;
	}
}

/** The value; throws HistoryLoopTimeout when the call does not settle in time. */
async function loopCall<T>(
	work: Promise<T>,
	reason = "history-loop-timeout",
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new HistoryLoopTimeout(reason)), historyLoopCallDeadlineMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * True when the work settled in time; false when it did not. A rejection
 * propagates. The timer is unref'd, so a long wait left behind by an abandoned
 * call cannot keep the process alive.
 */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
				(timer as { unref?: () => void }).unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The value, or null when it does not settle in time or rejects. */
async function withinDeadline<T>(
	work: Promise<T>,
	ms: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), ms);
			}),
		]);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

class HistoryResponseTracker {
	private static readonly MAX_PRESEED_RESPONSES = 32;
	private readonly page: BrowserCollectContext["page"];
	/**
	 * A page without response events (PageShim) is observed through a wrapper the
	 * page installs around fetch; its log is drained instead of listened to.
	 */
	private readonly pageLog: boolean;
	private pageLogBroken = false;
	private pageLogOverflow = false;
	private pageLogConsumed = 0;
	/** A correlated non-2xx answer: the run can no longer claim it saw the whole source. */
	private non2xxSeen = false;
	/** Sticky: a browse request failed in transport and no later reply undoes that. */
	private transportFailureSeen = false;
	/** Sticky: an evaluate in the drain or final proof did not settle in time. */
	private evidenceTimedOut = false;
	/** A correlated 2xx response whose body could not be read in time or at all. */
	private unreadableSeen = false;
	/** A browse call the run cannot attribute came after the last terminal evidence. */
	private uncorrelatedSinceTerminal = false;
	/** Browse requests the page started that have neither answered nor failed. */
	private readonly openRequests = new Set<Request>();
	private startedRequests = 0;
	private pageLogInFlight = 0;
	private readonly tokens = new Set<string>();
	private readonly requestedTokens = new Set<string>();
	private readonly preSeedResponses: Array<{
		response?: Response;
		failedRequest?: Request;
		version: number;
	}> = [];
	private seeded = false;
	private preSeedOverflow = false;
	private evidenceVersion = 0;
	private processedVersion = 0;
	private latestResponse: HistoryResponseEvidence | null = null;
	private continuationItemCount = 0;
	private bootstrapReadable = false;
	private bootstrapItemCount = 0;
	private bootstrapHasContinuation = false;
	private bootstrapTokenCount = 0;
	private bootstrapRendererCounts: Readonly<Record<string, number>> = {};
	private browseResponseCount = 0;
	private correlatedResponseCount = 0;
	private uncorrelatedResponseCount = 0;
	private non2xxResponseCount = 0;
	/** Requests for another page (a browseId other than history, no continuation). */
	private foreignResponseCount = 0;
	private unrecognizedResponseCount = 0;
	private latestStatus: number | null = null;
	private pending = Promise.resolve();
	private readonly onRequest = (request: Request): void => {
		if (!request.url().includes("/youtubei/v1/browse")) return;
		this.openRequests.add(request);
		this.startedRequests += 1;
	};
	private readonly onRequestFailed = (request: Request): void => {
		if (!request.url().includes("/youtubei/v1/browse")) return;
		this.openRequests.delete(request);
		// A transport failure is classified like a non-2xx answer: its body says
		// whether it was a history call, and no body means no positive evidence.
		const version = ++this.evidenceVersion;
		if (!this.seeded) {
			if (
				this.preSeedResponses.length <
				HistoryResponseTracker.MAX_PRESEED_RESPONSES
			)
				this.preSeedResponses.push({ failedRequest: request, version });
			else this.preSeedOverflow = true;
			return;
		}
		this.enqueue({ failedRequest: request }, version);
	};
	private readonly onResponse = (response: Response): void => {
		if (!response.url().includes("/youtubei/v1/browse")) return;
		this.openRequests.delete(response.request());
		const version = ++this.evidenceVersion;
		if (!this.seeded) {
			if (
				this.preSeedResponses.length <
				HistoryResponseTracker.MAX_PRESEED_RESPONSES
			)
				this.preSeedResponses.push({ response, version });
			else this.preSeedOverflow = true;
			return;
		}
		this.enqueue({ response }, version);
	};

	private readonly progress: HistoryRunProgress | undefined;

	constructor(
		page: BrowserCollectContext["page"],
		progress?: HistoryRunProgress,
	) {
		this.page = page;
		this.progress = progress;
		this.pageLog = typeof (page as { on?: unknown }).on !== "function";
		if (!this.pageLog) {
			page.on("request", this.onRequest);
			page.on("requestfailed", this.onRequestFailed);
			page.on("response", this.onResponse);
		}
	}

	/** Called when a proof-time evaluate did not settle: the evidence is incomplete. */
	markEvidenceTimeout(): void {
		this.evidenceTimedOut = true;
	}

	/** Install the page-side log after navigation; a no-op where events exist. */
	async attach(): Promise<void> {
		if (!this.pageLog) return;
		try {
			const result = await evaluateWithinDeadline(
				this.page.evaluate(installHistoryBrowseLog as never),
			);
			if (!result || result.value !== true) this.pageLogBroken = true;
		} catch {
			this.pageLogBroken = true;
		}
	}

	seed(tokens: readonly string[], page: ListEnd): void {
		this.bootstrapReadable = page.dataReadable;
		this.bootstrapItemCount =
			page.historyBootstrapItemCount ?? page.dataItemCount;
		this.bootstrapHasContinuation = page.dataHasContinuation;
		this.bootstrapRendererCounts = page.historyBootstrapRendererCounts ?? {};
		for (const token of tokens.slice(0, 8))
			if (token.length > 0 && token.length <= 16384) this.tokens.add(token);
		this.bootstrapTokenCount = this.tokens.size;
		this.seeded = true;
		for (const queued of this.preSeedResponses.splice(0))
			this.enqueue(
				queued.response
					? { response: queued.response }
					: queued.failedRequest
						? { failedRequest: queued.failedRequest }
						: {},
				queued.version,
			);
	}

	get diagnostics() {
		return {
			bootstrapReadable: this.bootstrapReadable,
			bootstrapItemCount: this.bootstrapItemCount,
			bootstrapHasContinuation: this.bootstrapHasContinuation,
			bootstrapTokenCount: this.bootstrapTokenCount,
			bootstrapRendererCounts: this.bootstrapRendererCounts,
			browseResponseCount: this.browseResponseCount,
			correlatedResponseCount: this.correlatedResponseCount,
			uncorrelatedResponseCount: this.uncorrelatedResponseCount,
			foreignResponseCount: this.foreignResponseCount,
			non2xxResponseCount: this.non2xxResponseCount,
			unrecognizedResponseCount: this.unrecognizedResponseCount,
			trackingComplete: this.trackingComplete,
			latestStatus: this.latestStatus,
			latestRecognized: this.latestResponse?.recognized ?? null,
			latestHasContinuation: this.latestResponse?.hasContinuation ?? null,
			preSeedOverflow: this.preSeedOverflow,
		};
	}

	get latest(): HistoryResponseEvidence | null {
		return this.latestResponse;
	}

	/** Changes whenever a browse request starts or a response arrives. */
	get version(): number {
		return this.evidenceVersion + this.startedRequests;
	}

	/** History browse requests started and not yet answered or failed. */
	get inFlight(): number {
		return this.pageLog ? this.pageLogInFlight : this.openRequests.size;
	}

	get trackingComplete(): boolean {
		return !this.preSeedOverflow && !this.pageLogBroken && !this.pageLogOverflow;
	}

	/**
	 * Why this run must not claim the source ended, or null. A correlated non-2xx
	 * answer and any browse call after the last terminal evidence that the run
	 * could not attribute both hide what the source said. On the page-log path the
	 * terminal response must also account for every row and continuation the page
	 * shows: otherwise a fetch captured before the wrapper delivered them unseen.
	 */
	stateVeto(end: ListEnd): string | null {
		if (this.non2xxSeen) return "history-browse-non-2xx";
		if (this.unreadableSeen) return "history-response-unreadable";
		if (this.transportFailureSeen) return "history-browse-failed";
		if (this.evidenceTimedOut) return "history-evidence-timeout";
		if (this.uncorrelatedSinceTerminal) return "history-browse-uncorrelated";
		const latest = this.latestResponse;
		if (this.pageLog && latest?.recognized && !latest.hasContinuation) {
			const unseenRows =
				end.domItemCount !== null &&
				end.domItemCount >
					this.bootstrapItemCount + (latest.continuationItemCount ?? 0);
			if (end.domHasContinuation || unseenRows) return "history-log-blind";
		}
		return null;
	}

	get allArrivalsProcessed(): boolean {
		return this.processedVersion === this.evidenceVersion;
	}

	/**
	 * Wait for queued arrivals and drain the page log, under the walk deadline.
	 * A stalled bridge ends the wait and marks the evidence incomplete, which
	 * vetoes the complete STATE.
	 */
	async flush(): Promise<void> {
		const settled = await withinDeadline(
			(async () => {
				await this.pending;
				await this.drainPageLog();
				return true;
			})(),
			historyLoopCallDeadlineMs,
		);
		if (settled === null) this.evidenceTimedOut = true;
	}

	dispose(): void {
		if (this.pageLog) return;
		this.page.off("request", this.onRequest);
		this.page.off("requestfailed", this.onRequestFailed);
		this.page.off("response", this.onResponse);
	}

	/**
	 * Take the page's logged browse calls. Waits a bounded time for calls the
	 * page started but has not finished; any left over keep arrivals unprocessed,
	 * so the final proof fails closed.
	 */
	private async drainPageLog(): Promise<void> {
		if (!this.pageLog || !this.seeded || this.pageLogBroken) return;
		for (let attempt = 0; attempt < PAGE_LOG_DRAIN_ATTEMPTS; attempt += 1) {
			let drained: ReturnType<typeof drainHistoryBrowseLog>;
			try {
				const result = await evaluateWithinDeadline(
					this.page.evaluate(drainHistoryBrowseLog as never),
				);
				if (!result) {
					this.evidenceTimedOut = true;
					this.pageLogBroken = true;
					return;
				}
				drained = result.value as ReturnType<typeof drainHistoryBrowseLog>;
			} catch {
				drained = null;
			}
			if (!drained) {
				// The page lost the wrapper (navigation or reload): calls are unaccounted.
				this.pageLogBroken = true;
				return;
			}
			if (drained.overflow) this.pageLogOverflow = true;
			for (const entry of drained.entries) {
				this.pageLogConsumed += 1;
				try {
					await this.observe({
						requestBody: entry.requestBody,
						status: entry.status,
						readScan: async () => entry.summary,
					});
				} catch {
					// Keep draining when one entry cannot be inspected.
				}
			}
			this.evidenceVersion = drained.sent;
			this.processedVersion = this.pageLogConsumed;
			this.pageLogInFlight = Math.max(0, drained.sent - drained.completed);
			if (drained.completed >= drained.sent) return;
			await this.page.waitForTimeout(PAGE_LOG_DRAIN_WAIT_MS);
		}
	}

	private enqueue(
		item: { response?: Response; failedRequest?: Request },
		version: number,
	): void {
		this.pending = this.pending
			.then(async () => {
				try {
					if (item.failedRequest) await this.inspectFailure(item.failedRequest);
					else if (item.response) await this.inspect(item.response);
				} catch {
					// Keep the response chain alive when one body cannot be inspected.
				} finally {
					this.processedVersion = Math.max(this.processedVersion, version);
				}
			});
	}

	private async inspectFailure(request: Request): Promise<void> {
		await this.observe({
			requestBody: await decodeBrowseRequestBody(request),
			status: 0,
			readScan: async () => null,
		});
	}

	private async inspect(response: Response): Promise<void> {
		if (!response.url().includes("/youtubei/v1/browse")) return;
		await this.observe({
			requestBody: await decodeBrowseRequestBody(response.request()),
			status: response.status(),
			readScan: async () =>
				withinDeadline(
					response.json().then(scanHistoryResponse),
					HISTORY_BODY_READ_DEADLINE_MS,
				),
		});
	}

	/** The transport-free step: Desktop events and the page log both end here. */
	private async observe(observation: BrowseObservation): Promise<void> {
		this.browseResponseCount += 1;
		const { requestBody, status } = observation;
		if (status === 0) this.transportFailureSeen = true;
		if (!requestBody) {
			this.uncorrelatedResponseCount += 1;
			this.uncorrelatedSinceTerminal = true;
			return;
		}
		if (requestBody.continuationTooLong) {
			this.uncorrelatedSinceTerminal = true;
			return;
		}
		const requestedContinuation = requestBody.continuation ?? null;
		const initialHistoryRequest = requestBody.browseId === "FEhistory";
		if (
			requestBody.browseId !== undefined &&
			!initialHistoryRequest &&
			requestedContinuation === null
		) {
			// Another page's request is ignored on positive evidence only: a 2xx
			// answer that reads and shows no rows and no continuation.
			if (status >= 200 && status < 300) {
				const scan = await observation.readScan();
				if (scan && scan.itemCount === 0 && !scan.hasContinuation) {
					this.foreignResponseCount += 1;
					return;
				}
			}
			this.uncorrelatedResponseCount += 1;
			this.uncorrelatedSinceTerminal = true;
			return;
		}
		// A continuation request is history only when its token is one the page
		// issued, whatever browseId it also names; a request without one is the
		// initial history request only when it names FEhistory.
		if (
			requestedContinuation !== null
				? !this.tokens.has(requestedContinuation)
				: !initialHistoryRequest
		) {
			this.uncorrelatedResponseCount += 1;
			this.uncorrelatedSinceTerminal = true;
			return;
		}
		this.correlatedResponseCount += 1;
		this.latestStatus = status;
		const repeatedRequest =
			requestedContinuation !== null &&
			this.requestedTokens.has(requestedContinuation);
		// No count cap: a cap would leave a long history's later pages
		// uncorrelated and so unable to complete. Each token is length-bounded.
		if (requestedContinuation) this.requestedTokens.add(requestedContinuation);
		if (status < 200 || status >= 300) {
			this.non2xxResponseCount += 1;
			this.non2xxSeen = true;
			this.latestResponse = {
				recognized: false,
				hasContinuation: false,
				requestedContinuation,
				nextContinuation: null,
				repeatedContinuation: false,
			};
			return;
		}
		const scan = await observation.readScan();
		// A browse response that names rows this run has not seen is real progress.
		if (scan?.itemIds) this.progress?.rows(scan.itemIds);
		if (!scan) {
			this.unrecognizedResponseCount += 1;
			this.unreadableSeen = true;
			this.latestResponse = {
				recognized: false,
				hasContinuation: false,
				requestedContinuation,
				nextContinuation: null,
				repeatedContinuation: false,
			};
			return;
		}
		const evidence = historyEvidenceFromScan(
			scan,
			requestedContinuation,
			this.requestedTokens,
		);
		if (requestedContinuation && evidence.recognized)
			this.continuationItemCount += evidence.itemCount ?? 0;
		if (!evidence.recognized) this.unrecognizedResponseCount += 1;
		if (evidence.recognized && !evidence.hasContinuation)
			this.uncorrelatedSinceTerminal = false;
		this.latestResponse = {
			...evidence,
			continuationItemCount: this.continuationItemCount,
			repeatedContinuation: evidence.repeatedContinuation || repeatedRequest,
		};
		if (evidence.nextContinuation) this.tokens.add(evidence.nextContinuation);
	}
}

export function parseCount(value: string | null | undefined): number | null {
	const match = value?.replace(/,/g, "").match(/([\d.]+)\s*([KkMmBb]?)/);
	if (!match) return null;
	const n =
		Number(match[1]) *
		({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase() as "K" | "M" | "B"] ??
			1);
	return Number.isFinite(n) ? Math.round(n) : null;
}

/** A section label has at most day precision. Never infer a time of day. */
function localDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function resolveWatchedDate(
	label: string | null,
	now: Date,
): string | null {
	if (!label) return null;
	const text = label.trim().toLowerCase();
	if (text === "today") return localDate(now);
	if (text === "yesterday")
		return localDate(
			new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
		);
	const weekdays = [
		"sunday",
		"monday",
		"tuesday",
		"wednesday",
		"thursday",
		"friday",
		"saturday",
	];
	const weekday = weekdays.indexOf(text);
	if (weekday >= 0) {
		const delta = (now.getDay() - weekday + 7) % 7 || 7;
		return localDate(
			new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta),
		);
	}
	const match =
		/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(
			text,
		);
	if (!match) return null;
	const month = [
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec",
	].indexOf(match[1]!);
	const year = match[3] ? Number(match[3]) : now.getFullYear();
	const date = new Date(year, month, Number(match[2]));
	if (date.getMonth() !== month || date.getDate() !== Number(match[2]))
		return null;
	if (!match[3] && date > now) date.setFullYear(year - 1);
	return localDate(date);
}

function videoFields(video: BrowserVideo) {
	return {
		video_id: video.video_id,
		video_url: video.video_url,
		video_title: video.video_title,
		channel_title: video.channel_title,
		channel_url: video.channel_url,
		duration_text: video.duration_text,
		duration_seconds:
			video.duration_text &&
			/^\d{1,2}(?::\d{2}){1,2}$/.test(video.duration_text)
				? video.duration_text
						.split(":")
						.reduce((seconds, part) => seconds * 60 + Number(part), 0)
				: null,
		thumbnail_url: video.thumbnail_url,
	};
}

export async function hasYoutubeSession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	if (
		(await waitForContent(
			page,
			'button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn, ytd-masthead button[aria-label*="Account"], a[href*="accounts.google.com/ServiceLogin"]',
		)) !== "content"
	)
		return false;
	return page.evaluate(hasYoutubeSessionOnCurrentPage);
}

/** Reads the authenticated marker after a target page has finished rendering. */
function hasYoutubeSessionOnCurrentPage(): boolean {
	return (
		Boolean(
			document.querySelector(
				'button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn, ytd-masthead button[aria-label*="Account"]',
			),
		) && !document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')
	);
}

async function probeYoutubeSession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	await page.goto(HOME, { waitUntil: "domcontentloaded" });
	return hasYoutubeSession(page);
}

export async function ensureYoutubeSession(
	args: EnsureSessionArgs,
	timeoutSeconds = 30 * 60,
): Promise<void> {
	if (await probeYoutubeSession(args.page)) return;
	const ready = await manualBrowserLogin({
		assist: args.assist,
		capture: args.capture,
		completeAssistance: args.completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to YouTube in the secure browser, then continue. Collection starts once the session is verified.",
		page: args.page,
		probe: () => hasYoutubeSession(args.page),
		readinessProbe: hasYoutubeSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction: args.sendInteraction,
		timeoutSeconds,
	});
	if (!ready) throw new Error("youtube_session_dead");
}

async function scroll(
	page: BrowserCollectContext["page"],
	rounds: number,
	selector: string,
	continuationSelector: string,
	settleMilliseconds: number,
): Promise<boolean> {
	let unchangedRounds = 0;
	for (let i = 0; i < rounds; i += 1) {
		const before = await page.locator(selector).count();
		const continuationBefore = await page.locator(continuationSelector).count();
		await page.evaluate((itemSelector) => {
			const scrollable = Array.from(document.querySelectorAll("*"))
				.filter(
					(element) =>
						element.scrollHeight > element.clientHeight + 8 &&
						element.querySelector(itemSelector),
				)
				.sort(
					(a, b) =>
						b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
				)[0];
			if (scrollable) scrollable.scrollBy(0, window.innerHeight * 2);
			else window.scrollBy(0, window.innerHeight * 2);
		}, selector);
		await page.waitForTimeout(settleMilliseconds);
		const after = await page.locator(selector).count();
		unchangedRounds = after === before ? unchangedRounds + 1 : 0;
		const continuationAfter = await page.locator(continuationSelector).count();
		if (continuationBefore > 0 && continuationAfter === 0) {
			await page.waitForTimeout(settleMilliseconds);
			if ((await page.locator(continuationSelector).count()) === 0) return true;
		}
		if (unchangedRounds >= 2) break;
	}
	return false;
}

const EMPTY_STATE =
	"ytd-message-renderer, yt-message-renderer, ytd-background-promo-renderer";

/**
 * The readiness wait, its handle read and its dispose all sit under one fixed
 * deadline (the walk's call deadline). The caller stops waiting at the deadline,
 * so a dispose that hangs cannot block the failure report; it keeps running in
 * the background. "timeout" means the sequence did not settle in time.
 */
async function waitForContentBounded(
	page: BrowserCollectContext["page"],
	selector: string,
	options: { playlistIndex?: boolean; timeoutMs?: number } = {},
): Promise<"content" | "empty" | "unreadable" | "timeout"> {
	const sequence = (async (): Promise<"content" | "empty" | "unreadable"> => {
		try {
			const handle = await page.waitForFunction(
				readPageReadiness,
				{
					content: selector,
					empty: EMPTY_STATE,
					playlistIndex: options.playlistIndex ?? false,
				},
				{ timeout: options.timeoutMs ?? 10_000 },
			);
			const state = (await handle.jsonValue()) as "content" | "empty";
			await handle.dispose();
			return state;
		} catch {
			return "unreadable";
		}
	})();
	const settled = await withinDeadline(sequence, historyLoopCallDeadlineMs);
	return settled ?? "timeout";
}

async function waitForContent(
	page: BrowserCollectContext["page"],
	selector: string,
	options: { playlistIndex?: boolean; timeoutMs?: number } = {},
): Promise<"content" | "empty" | "unreadable"> {
	const state = await waitForContentBounded(page, selector, options);
	return state === "timeout" ? "unreadable" : state;
}

async function readSwitchAccountEmail(
	page: BrowserCollectContext["page"],
): Promise<string | null> {
	try {
		const opened = await page.evaluate(
			openSwitchAccount as () => ReturnType<typeof openSwitchAccount>,
		);
		if (opened !== true) return null;
		const handle = await page.waitForFunction(
			readGoogleAccountEmail as () => ReturnType<typeof readGoogleAccountEmail>,
			undefined,
			{ timeout: 4_000 },
		);
		const email = (await handle.jsonValue()) as unknown;
		await handle.dispose();
		return typeof email === "string" ? email : null;
	} catch {
		return null;
	}
}

async function waitForChannelIdentity(
	page: BrowserCollectContext["page"],
): Promise<"content" | "unreadable"> {
	try {
		const handle = await page.waitForFunction(
			(titleSelector) => {
				const title = Array.from(document.querySelectorAll(titleSelector))
					.map((node) => node.textContent?.trim() ?? "")
					.find(Boolean);
				const hasIdentity = Boolean(
					document.querySelector(
						'link[rel="canonical"][href*="/channel/"], meta[itemprop="channelId"]',
					) || /@[^/?#]+/.test(location.pathname),
				);
				const placeholderTitle =
					/^(?:loading\b|please wait\b|home$|youtube$|channel$)/i.test(
						title ?? "",
					);
				return title && !placeholderTitle && hasIdentity ? true : false;
			},
			CHANNEL_TITLE_SELECTOR,
			{ timeout: 10_000 },
		);
		await handle.dispose();
		return "content";
	} catch {
		return "unreadable";
	}
}

async function waitForChannelAbout(
	page: BrowserCollectContext["page"],
): Promise<"content" | "unreadable"> {
	try {
		const handle = await page.waitForFunction(
			() => {
				const about = document.querySelector(
					"ytd-channel-about-metadata-renderer, yt-about-this-channel-renderer",
				);
				const aboutRoot = about ?? document;
				const text = Array.from(
					aboutRoot.querySelectorAll("yt-formatted-string, span, td, dd"),
				)
					.filter((node) => node.children.length === 0)
					.map((node) => node.textContent?.trim() ?? "")
					.filter((value) => value && !/^(loading|please wait)$/i.test(value));
				const hasJoinedDate = text.some((value) => /^joined\s+/i.test(value));
				const hasStatsInAbout =
					Boolean(about) &&
					text.some(
						(value) => /subscriber|view|video/i.test(value) && /\d/.test(value),
					);
				const hasDescription = Boolean(
					aboutRoot
						.querySelector(
							"#description-container yt-formatted-string, #description yt-formatted-string, #description",
						)
						?.textContent?.trim(),
				);
				return hasJoinedDate || hasStatsInAbout || hasDescription
					? "content"
					: false;
			},
			undefined,
			{ timeout: 10_000 },
		);
		const state = (await handle.jsonValue()) as "content";
		await handle.dispose();
		return state;
	} catch {
		return "unreadable";
	}
}

async function skipUnreadable(
	ctx: BrowserContext,
	stream: string,
	reason: string,
): Promise<void> {
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason,
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		message: "YouTube content did not appear before the page-read deadline.",
	});
}

/**
 * Reports each stream's failure at most once per run, however many pages of
 * that stream were read.
 */
interface StreamReporter {
	/**
	 * The enumeration end could not be proven: `stream_collection_failed`, once
	 * per stream. Records already read are still emitted, and no finishing
	 * `STATE` follows.
	 */
	fail(
		stream: string,
		message?: string,
		diagnostics?: Record<string, unknown>,
	): Promise<void>;
}

const END_NOT_OBSERVED_MESSAGE =
	"YouTube did not show the end of this list, so the list may be incomplete.";

function createStreamReporter(ctx: BrowserContext): StreamReporter {
	const failed = new Set<string>();
	return {
		async fail(stream, message = END_NOT_OBSERVED_MESSAGE, diagnostics) {
			if (failed.has(stream)) return;
			if (!ctx.reportStreamFailure)
				throw new Error(
					"reportStreamFailure is required to report a failed stream",
				);
			await ctx.reportStreamFailure(stream, message, {
				retryable: true,
				...(diagnostics ? { diagnostics } : {}),
			});
			failed.add(stream);
		},
	};
}

async function emitVerifiedEmptyState(
	ctx: BrowserContext,
	stream: string,
	capturedAt: string,
): Promise<void> {
	await ctx.emit({
		type: "STATE",
		stream,
		cursor: {
			verified_empty_at: capturedAt,
			evidence: "youtube_page_data_empty",
		},
	});
	if (stream === "playlist_items")
		await ctx.emit(buildFullScanCoverageMessage(stream, 0));
}

type ExhaustionEvidence = {
	readonly kind:
		| "continuation-removed"
		| "explicit-end-marker"
		| "latest-history-response"
		| "page-data-empty"
		| "readable-data"
		| "unproven";
	readonly page: ListEnd | null;
};

interface ListRead<T> {
	readonly items: T[];
	readonly exhausted: boolean;
	readonly evidence: ExhaustionEvidence;
}

function exhaustionEvidence(
	page: ListEnd | null,
	renderedCount: number,
	continuationRemoved: boolean,
	discardedRows = 0,
): ExhaustionEvidence {
	if (
		!page ||
		!enumerationEnded(page, renderedCount, continuationRemoved, discardedRows)
	)
		return { kind: "unproven", page };
	// Only page data that says the list is empty proves zero rows. An end
	// marker or a vanished continuation with no rows can be a failed load.
	if (renderedCount === 0)
		return { kind: page.verifiedEmpty ? "page-data-empty" : "unproven", page };
	if (
		page.latestHistoryResponse?.recognized === true &&
		!page.latestHistoryResponse.hasContinuation
	)
		return { kind: "latest-history-response", page };
	if (page.domHasEndMarker) return { kind: "explicit-end-marker", page };
	if (continuationRemoved) return { kind: "continuation-removed", page };
	if (
		page.dataReadable &&
		!page.dataHasContinuation &&
		!page.domHasContinuation &&
		page.dataItemCount > 0 &&
		renderedCount >= page.dataItemCount
	)
		return { kind: "readable-data", page };
	if (page.verifiedEmpty) return { kind: "page-data-empty", page };
	return {
		kind: "unproven",
		page,
	};
}

async function readSubscriptionsList(
	page: BrowserCollectContext["page"],
	state: "content" | "empty",
): Promise<ListRead<Awaited<ReturnType<typeof readSubscriptions>>[number]>> {
	const selector = "ytd-channel-renderer";
	const continuationRemoved =
		state === "content"
			? await scroll(
					page,
					SCROLLS.subscriptions,
					selector,
					LIST_CONTINUATION_SELECTORS.subscriptions,
					800,
				)
			: false;
	const items =
		state === "empty"
			? []
			: await page.evaluate(
					readSubscriptions as () => ReturnType<typeof readSubscriptions>,
				);
	const pageEnd = await page.evaluate<ListEnd, ListKind>(
		readListEnd,
		"subscriptions",
	);
	const evidence = exhaustionEvidence(
		pageEnd,
		items.length,
		continuationRemoved,
	);
	return {
		items,
		exhausted: evidence.kind !== "unproven",
		evidence,
	};
}

async function readPlaylistIndex(
	page: BrowserCollectContext["page"],
	state: "content" | "empty",
): Promise<ListRead<Awaited<ReturnType<typeof readPlaylistLinks>>[number]>> {
	const selector =
		'ytd-playlist-renderer a[href*="list="], ytd-grid-playlist-renderer a[href*="list="], ytd-compact-playlist-renderer a[href*="list="], yt-lockup-view-model a[href*="list="], a[href*="list="]';
	const continuationRemoved =
		state === "content"
			? await scroll(
					page,
					SCROLLS.playlists,
					selector,
					LIST_CONTINUATION_SELECTORS["playlist-index"],
					1_000,
				)
			: false;
	const items =
		state === "empty"
			? []
			: await page.evaluate(
					readPlaylistLinks as () => ReturnType<typeof readPlaylistLinks>,
				);
	const pageEnd = await page.evaluate<
		ListEnd,
		{ kind: ListKind; sessionPresent: boolean }
	>(readListEnd, {
		kind: "playlist-index",
		sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
	});
	const evidence = exhaustionEvidence(
		pageEnd,
		items.length,
		continuationRemoved,
	);
	return {
		items,
		exhausted: evidence.kind !== "unproven",
		evidence,
	};
}

interface VideoReadResult extends ListRead<BrowserVideo> {
	readonly verifiedEmpty: boolean;
	readonly partialCheckpointAllowed: boolean;
	readonly stopReason?: string;
	readonly scannedCount?: number;
	readonly parsedCount?: number;
	readonly dedupedCount?: number;
	readonly lastAccounted?: BrowserVideo | null;
	readonly checkpointAnchor?: string | null;
	readonly checkpointPosition?: number;
	readonly phase?: "backfill" | "head_reconciliation";
	readonly headAnchorIds?: readonly string[];
	readonly historyDiagnostics?: {
		bootstrapReadable: boolean;
		bootstrapItemCount: number;
		bootstrapHasContinuation: boolean;
		bootstrapTokenCount: number;
		bootstrapRendererCounts: Readonly<Record<string, number>>;
		browseResponseCount: number;
		correlatedResponseCount: number;
		uncorrelatedResponseCount: number;
		foreignResponseCount: number;
		non2xxResponseCount: number;
		unrecognizedResponseCount: number;
		trackingComplete: boolean;
		latestStatus: number | null;
		latestRecognized: boolean | null;
		latestHasContinuation: boolean | null;
		rowsAtStart: number;
		rowsAtEnd: number;
		scrollRounds: number;
		unchangedRounds: number;
		scrollGeometry: HistoryScrollGeometry | null;
	};
	readonly blocked?: boolean;
	/** The read can save a fully accounted prefix without claiming an end. */
}

type HistoryTraversalDiagnostics = NonNullable<
	VideoReadResult["historyDiagnostics"]
>;

function reportHistoryTraversal(history: HistoryTraversalDiagnostics): void {
	connectorDiagnostic("youtube", "history_bootstrap", {
		readable: history.bootstrapReadable,
		items: history.bootstrapItemCount,
		renderer_counts: JSON.stringify(history.bootstrapRendererCounts),
		has_continuation: history.bootstrapHasContinuation,
		tokens: history.bootstrapTokenCount,
	});
	connectorDiagnostic("youtube", "history_browse", {
		total: history.browseResponseCount,
		correlated: history.correlatedResponseCount,
		uncorrelated: history.uncorrelatedResponseCount,
		foreign: history.foreignResponseCount,
		non_2xx: history.non2xxResponseCount,
		unrecognized: history.unrecognizedResponseCount,
	});
	connectorDiagnostic("youtube", "history_latest", {
		status: history.latestStatus,
		recognized: history.latestRecognized,
		has_continuation: history.latestHasContinuation,
	});
	connectorDiagnostic("youtube", "history_scroll", {
		rows_start: history.rowsAtStart,
		rows_end: history.rowsAtEnd,
		rounds: history.scrollRounds,
		unchanged: history.unchangedRounds,
	});
	connectorDiagnostic("youtube", "history_geometry", {
		container: history.scrollGeometry?.containerFound ?? null,
		height: history.scrollGeometry?.containerHeight ?? null,
		client: history.scrollGeometry?.containerClientHeight ?? null,
		top: history.scrollGeometry?.containerTop ?? null,
		document: history.scrollGeometry?.documentHeight ?? null,
		window: history.scrollGeometry?.windowHeight ?? null,
		scroll_y: history.scrollGeometry?.windowScrollY ?? null,
	});
}

type HistoryCursor = {
	version?: 2;
	phase?: "backfill" | "head_reconciliation";
	backfill_anchor_id?: string;
	head_anchor_ids?: string[];
	last_seen_video_id?: string;
	position?: number;
	complete?: boolean;
};

type HistoryPageRequest = {
	readonly mode: "history";
	readonly offset: number;
	readonly limit: number;
};

const readHistoryPageInBrowser = readVideos as unknown as (
	request: HistoryPageRequest,
) => HistoryVideoPage;
const readPlaylistVideosInBrowser = readVideos as unknown as (
	mode: "playlist",
) => BrowserVideo[];
const readListEndInBrowser = readListEnd as unknown as (
	request: ListEndRequest,
) => ListEnd;

function decodeHistoryVideoPage(value: unknown): HistoryVideoPage | null {
	const page = recordValue(value);
	if (
		!page ||
		typeof page.offset !== "number" ||
		typeof page.totalRows !== "number" ||
		!Array.isArray(page.rows)
	)
		return null;
	const rows: Array<BrowserVideo | null> = [];
	for (const row of page.rows) {
		if (row === null) {
			rows.push(null);
			continue;
		}
		const video = recordValue(row);
		if (!video || typeof video.video_url !== "string") return null;
		const stringOrNull = (field: unknown): string | null =>
			typeof field === "string" ? field : null;
		rows.push({
			video_id: stringOrNull(video.video_id),
			video_url: video.video_url,
			video_title: stringOrNull(video.video_title),
			channel_title: stringOrNull(video.channel_title),
			channel_url: stringOrNull(video.channel_url),
			duration_text: stringOrNull(video.duration_text),
			thumbnail_url: stringOrNull(video.thumbnail_url),
			watched_date_label: stringOrNull(video.watched_date_label),
			views_text: stringOrNull(video.views_text),
			description: stringOrNull(video.description),
		});
	}
	return { offset: page.offset, totalRows: page.totalRows, rows };
}

type HistoryStreamRecord = (
	video: BrowserVideo,
	position: number,
) => Promise<void>;

type HistoryScrollGeometry = {
	containerFound: boolean;
	containerHeight: number | null;
	containerClientHeight: number | null;
	containerTop: number | null;
	documentHeight: number | null;
	windowHeight: number | null;
	windowScrollY: number | null;
};

type ScrollRequest = { itemSelector: string; stopToken: string };

/** Runs in the page: marks this walk as stopped, so a queued scroll returns unscrolled. */
function setHistoryStopToken(token: string): void {
	(window as unknown as Record<string, unknown>).__pdpHistoryStop = token;
}

async function scrollHistoryOnce(
	page: BrowserCollectContext["page"],
	stopToken: string,
): Promise<HistoryScrollGeometry> {
	const geometry = (await loopCall(
		page.evaluate<HistoryScrollGeometry | null, ScrollRequest>(
		({ itemSelector, stopToken: stopped }) => {
			// The walk set this token when it stopped: a late call must not scroll.
			if ((window as unknown as Record<string, unknown>).__pdpHistoryStop === stopped)
				return null;
			const scrollable = Array.from(document.querySelectorAll("*"))
				.filter(
					(element) =>
						element.scrollHeight > element.clientHeight + 8 &&
						element.querySelector(itemSelector),
				)
				.sort(
					(a, b) =>
						b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
				)[0];
			if (scrollable) scrollable.scrollBy(0, window.innerHeight * 2);
			else window.scrollBy(0, window.innerHeight * 2);
			return {
				containerFound: Boolean(scrollable),
				containerHeight: scrollable?.scrollHeight ?? null,
				containerClientHeight: scrollable?.clientHeight ?? null,
				containerTop: scrollable?.scrollTop ?? null,
				documentHeight: document.documentElement?.scrollHeight ?? null,
				windowHeight: window.innerHeight,
				windowScrollY: window.scrollY,
			};
		},
		{ itemSelector: "yt-lockup-view-model", stopToken },
		),
	)) ?? {
		containerFound: false,
		containerHeight: null,
		containerClientHeight: null,
		containerTop: null,
		documentHeight: null,
		windowHeight: null,
		windowScrollY: null,
	};
	await page.waitForTimeout(HISTORY_SCROLL_WAIT_MS);
	return geometry;
}

async function readHistoryVideoList(
	page: BrowserCollectContext["page"],
	url: string,
	capture: BrowserCollectContext["capture"] | undefined,
	cursor: HistoryCursor | undefined,
	collectionMode: BrowserCollectContext["collectionMode"],
	emitRecord: HistoryStreamRecord,
	identityForVideo: (video: BrowserVideo) => string,
	progress?: HistoryRunProgress,
): Promise<VideoReadResult> {
	const startedAt = performance.now();
	const responseTracker = new HistoryResponseTracker(page, progress);
	// The bridge's own goto timeout is not trusted: stop waiting a little after it.
	const navigated = await settlesWithin(
		page.goto(url, {
			waitUntil: "domcontentloaded",
			timeout: HISTORY_SETUP_BUDGET_MS,
		}),
		HISTORY_SETUP_BUDGET_MS + historyLoopCallDeadlineMs,
	);
	if (!navigated) {
		responseTracker.dispose();
		throw new Error("youtube_history_page_unreadable");
	}
	let remainingMs = HISTORY_SETUP_BUDGET_MS - (performance.now() - startedAt);
	if (remainingMs <= 0) {
		responseTracker.dispose();
		throw new Error("youtube_history_page_unreadable");
	}
	// Setup runs before any record is emitted, so a stall here fails closed
	// with nothing emitted and no checkpoint.
	const hydrated = await withinDeadline(
		page.waitForTimeout(Math.min(PAGE_HYDRATION_WAIT_MS, remainingMs)),
		historyLoopCallDeadlineMs,
	);
	if (hydrated === null) {
		responseTracker.dispose();
		throw new Error("youtube_history_setup_timeout");
	}
	remainingMs = HISTORY_SETUP_BUDGET_MS - (performance.now() - startedAt);
	const state = await waitForContentBounded(
		page,
		"ytd-item-section-renderer yt-lockup-view-model, ytd-item-section-renderer ytd-video-renderer",
		{ timeoutMs: Math.max(1, Math.min(10_000, remainingMs)) },
	);
	if (state === "timeout") {
		responseTracker.dispose();
		throw new Error("youtube_history_setup_timeout");
	}
	if (state === "unreadable") {
		responseTracker.dispose();
		throw new Error("youtube_history_page_unreadable");
	}
	const loopEvaluate = ((...args: unknown[]) =>
		loopCall(
			(page.evaluate as (...a: unknown[]) => Promise<unknown>).apply(page, args),
		)) as typeof page.evaluate;
	await responseTracker.attach();
	await loopCall(
		Promise.resolve(capture?.captureDom(page, "youtube-watch-history")),
	);
	let currentEnd = await loopEvaluate(readListEndInBrowser, {
		kind: "history" as const,
		sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),
		latestHistoryResponse: responseTracker.latest,
	});
	responseTracker.seed(
		currentEnd.historyBootstrapContinuationTokens ?? [],
		currentEnd,
	);
	await responseTracker.flush();
	currentEnd = await loopEvaluate(readListEndInBrowser, {
		kind: "history" as const,
		sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),
		latestHistoryResponse: responseTracker.latest,
	});
	const headOnly =
		cursor?.complete === true && collectionMode !== "full_refresh";
	const rowsSeen = new Set<string>();
	let resumeAnchor = !headOnly
		? (cursor?.backfill_anchor_id ?? cursor?.last_seen_video_id ?? null)
		: null;
	let resumeAnchorFound = resumeAnchor === null;
	let phase: "backfill" | "head_reconciliation" = resumeAnchor
		? "head_reconciliation"
		: "backfill";
	let offset = 0;
	let totalRows = 0;
	let rowsAtStart = 0;
	let scrollRounds = 0;
	let unchangedRounds = 0;
	let lastScrollGeometry: HistoryScrollGeometry | null = null;
	let lastScrollPosition: number | null = null;
	let scannedCount = 0;
	let parsedCount = 0;
	let dedupedCount = 0;
	let lastAccounted: BrowserVideo | null = null;
	let stopReason = "unproven-end";
	let loopTimedOut = false;
	let loopTimeoutReason = "history-loop-timeout";
	const stopToken = `stop-${Math.random().toString(36).slice(2)}`;
	let sourceEnded = false;
	let verifiedEmpty = false;
	let blocked = false;
	let parseGap = false;
	let headAnchorIds: string[] = [];
	let evidence: ExhaustionEvidence = { kind: "unproven", page: null };
	// Connector memory holds at most 500 recent identities, one 50-row parse
	// batch and 32 pre-seed response handles, plus the continuation tokens of
	// the pages walked (each <= 16 KiB). Each response scan visits at most
	// 10,000 nodes. The walk has no time or round cap; the no-progress watchdog
	// alone bounds a walk that stops moving.
	const rememberIdentity = (key: string): void => {
		rowsSeen.add(key);
		if (rowsSeen.size > HISTORY_DEDUP_WINDOW)
			rowsSeen.delete(rowsSeen.values().next().value!);
	};

	try {
		while (true) {
			const request = {
				mode: "history",
				offset,
				limit: HISTORY_READ_BATCH_SIZE,
			} as const;
			const rawBatch: unknown = await loopEvaluate(
				readHistoryPageInBrowser,
				request,
			);
			const batch = decodeHistoryVideoPage(rawBatch);
			if (!batch) {
				stopReason = "unreadable-batch";
				parseGap = true;
				break;
			}
			totalRows = batch.totalRows;
			if (offset === 0) {
				rowsAtStart = batch.totalRows;
				headAnchorIds = batch.rows
					.slice(0, 3)
					.flatMap((video) => (video ? [identityForVideo(video)] : []));
			}
			if (offset >= totalRows) {
				await responseTracker.flush();
				currentEnd = await loopEvaluate(readListEndInBrowser, {
					kind: "history" as const,
					sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),
					latestHistoryResponse: responseTracker.latest,
				});
				if (currentEnd.pageBlocked) {
					blocked = true;
					stopReason = "blocked-page";
					break;
				}
				const latest = currentEnd.latestHistoryResponse;
				if (latest?.repeatedContinuation) {
					stopReason = "continuation-cycle";
					break;
				}
				if (totalRows === 0) {
					const emptyEvidence = exhaustionEvidence(currentEnd, 0, false);
					if (emptyEvidence.kind === "page-data-empty") {
						verifiedEmpty = true;
						sourceEnded = true;
						evidence = emptyEvidence;
						stopReason = "source-end";
						break;
					}
					stopReason = "empty-unproven";
					break;
				}
				if (resumeAnchor && !resumeAnchorFound) {
					// The saved boundary was deleted or moved out of this traversal.
					// Restart from the head and reconcile every visible row; never treat
					// a missing anchor as permission to skip an unknown prefix.
					resumeAnchor = null;
					resumeAnchorFound = true;
					phase = "backfill";
					offset = 0;
					parsedCount = 0;
					lastAccounted = null;
					continue;
				}
				const end = exhaustionEvidence(currentEnd, parsedCount, false);
				if (end.kind !== "unproven" && parsedCount === totalRows) {
					sourceEnded = true;
					evidence = end;
					stopReason = "source-end";
					break;
				}
				if (headOnly && scrollRounds >= HISTORY_HEAD_REFRESH_ROUNDS) {
					stopReason = "head-reconciled";
					break;
				}
				lastScrollGeometry = await loopCall(
					scrollHistoryOnce(page, stopToken),
				);
				const scrollPosition =
					lastScrollGeometry.containerTop ?? lastScrollGeometry.windowScrollY;
				scrollRounds += 1;
				await responseTracker.flush();
				const afterScrollRaw: unknown = await loopEvaluate(
					readHistoryPageInBrowser,
					{
						mode: "history" as const,
						offset: 0,
						limit: 1,
					},
				);
				const afterScroll = decodeHistoryVideoPage(afterScrollRaw);
				currentEnd = await loopEvaluate(readListEndInBrowser, {
					kind: "history" as const,
					sessionPresent: await loopEvaluate(hasYoutubeSessionOnCurrentPage),
					latestHistoryResponse: responseTracker.latest,
				});
				const latestAfterScroll = responseTracker.latest;
				if (currentEnd.pageBlocked) {
					blocked = true;
					stopReason = "blocked-page";
					break;
				}
				if (latestAfterScroll?.repeatedContinuation) {
					stopReason = "continuation-cycle";
					break;
				}
				if (afterScroll && parsedCount === afterScroll.totalRows) {
					const refreshedEnd = exhaustionEvidence(currentEnd, parsedCount, false);
					if (refreshedEnd.kind !== "unproven") {
						sourceEnded = true;
						evidence = refreshedEnd;
						stopReason = "source-end";
						break;
					}
				}
				if (!afterScroll || afterScroll.totalRows <= totalRows) {
					const scrollAdvanced =
						scrollPosition !== null &&
						lastScrollPosition !== null &&
						scrollPosition > lastScrollPosition;
					lastScrollPosition = scrollPosition;
					if (scrollAdvanced) {
						unchangedRounds = 0;
						continue;
					}
					unchangedRounds += 1;
					if (unchangedRounds >= 2) {
						stopReason = "stalled";
						break;
					}
				} else {
					unchangedRounds = 0;
					lastScrollPosition = scrollPosition;
				}
				continue;
			}
			const rows = batch.rows;
			if (rows.length === 0) {
				stopReason = "empty-batch";
				parseGap = true;
				break;
			}
			for (const video of rows) {
				if (!video) {
					parseGap = true;
					stopReason = "parse-gap";
					break;
				}
				const position = offset;
				const key = identityForVideo(video);
				const matchesResumeAnchor =
					key === resumeAnchor || videoIdentity(video) === resumeAnchor;
				if (resumeAnchor && !resumeAnchorFound && !matchesResumeAnchor) {
					if (rowsSeen.has(key)) {
						dedupedCount += 1;
					} else {
						rememberIdentity(key);
						await loopCall(
							emitRecord(video, position),
							"history-record-timeout",
						);
					}
					parsedCount += 1;
					scannedCount += 1;
					offset += 1;
					continue;
				}
				const matchingResumeAnchor = matchesResumeAnchor;
				if (matchingResumeAnchor) {
					resumeAnchorFound = true;
					phase = "backfill";
				}
				if (rowsSeen.has(key)) {
					dedupedCount += 1;
				} else {
					rememberIdentity(key);
					await loopCall(
							emitRecord(video, position),
							"history-record-timeout",
						);
				}
				// Before a movable saved identity is found, every observed row belongs
				// to head reconciliation. Upsert the full prefix; never infer delivery
				// from its position above that identity.
				lastAccounted = video;
				progress?.rows([key]);
				parsedCount += 1;
				scannedCount += 1;
				offset += 1;
			}
			if (parseGap) break;
			if (headOnly && offset >= HISTORY_HEAD_REFRESH_ROWS) {
				stopReason = "head-reconciled";
				break;
			}
		}
	} catch (error) {
		if (!(error instanceof HistoryLoopTimeout)) throw error;
		loopTimedOut = true;
		loopTimeoutReason = error.reason;
		stopReason = error.reason;
		// A call still queued in the page must not scroll after the walk stopped.
		await withinDeadline(
			page.evaluate(setHistoryStopToken, stopToken),
			HISTORY_EVALUATE_DEADLINE_MS,
		);
	}
	let stableEnd = false;
	for (let refresh = 0; refresh < 3 && !loopTimedOut; refresh += 1) {
		await responseTracker.flush();
		if (responseTracker.inFlight > 0) {
			// Bounded: three refreshes, one short wait each.
			const waited = await withinDeadline(
				page.waitForTimeout(PAGE_LOG_DRAIN_WAIT_MS),
				historyLoopCallDeadlineMs,
			);
			if (waited === null) {
				responseTracker.markEvidenceTimeout();
				break;
			}
			continue;
		}
		if (!responseTracker.allArrivalsProcessed) continue;
		const snapshot = {
			version: responseTracker.version,
			latest: responseTracker.latest,
		};
		const refreshed = await evaluateWithinDeadline(
			(async () =>
				page.evaluate(readListEndInBrowser, {
					kind: "history" as const,
					sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
					latestHistoryResponse: snapshot.latest,
				}))(),
		);
		if (!refreshed) {
			responseTracker.markEvidenceTimeout();
			break;
		}
		currentEnd = refreshed.value;
		await responseTracker.flush();
		if (
			responseTracker.inFlight === 0 &&
			responseTracker.version === snapshot.version &&
			responseTracker.allArrivalsProcessed
		) {
			stableEnd = true;
			break;
		}
	}
	responseTracker.dispose();
	blocked ||= currentEnd.pageBlocked;
	if (blocked) {
		stopReason = "blocked-page";
		sourceEnded = false;
	}
	if (sourceEnded) {
		evidence = exhaustionEvidence(currentEnd, parsedCount, false);
		if (
			evidence.kind === "unproven" ||
			(verifiedEmpty && evidence.kind !== "page-data-empty")
		) {
			sourceEnded = false;
			verifiedEmpty = false;
			stopReason = "final-proof-invalidated";
		}
	}
	if (loopTimedOut) {
		// A stalled renderer or capture ended the walk. Rows already accounted
		// stand; the end of the history is unproven.
		sourceEnded = false;
		verifiedEmpty = false;
		evidence = { kind: "unproven", page: currentEnd };
		stopReason = loopTimeoutReason;
	} else if (!stableEnd || !responseTracker.trackingComplete) {
		sourceEnded = false;
		verifiedEmpty = false;
		evidence = { kind: "unproven", page: currentEnd };
		stopReason = !responseTracker.trackingComplete
			? "history-response-buffer-overflow"
			: responseTracker.inFlight > 0
				? "history-browse-in-flight"
				: "history-evidence-changed-during-final-refresh";
	}
	// The veto blocks the end claim only. A checkpoint rests on rows already
	// read, so the stop reason that decides it is the one before the veto.
	const endStopReason = stopReason;
	const stateVeto = responseTracker.stateVeto(currentEnd);
	if (stateVeto) {
		sourceEnded = false;
		verifiedEmpty = false;
		evidence = { kind: "unproven", page: currentEnd };
		stopReason = stateVeto;
	}
	const partialCheckpointAllowed =
		!blocked &&
		headOnly && endStopReason === "head-reconciled";
	return {
		items: [],
		exhausted: sourceEnded && !blocked,
		evidence,
		verifiedEmpty: verifiedEmpty && !blocked,
		partialCheckpointAllowed,
		blocked,
		stopReason,
		scannedCount,
		parsedCount,
		dedupedCount,
		lastAccounted,
		checkpointAnchor:
			(stableEnd || loopTimedOut) &&
			responseTracker.trackingComplete &&
			lastAccounted
				? identityForVideo(lastAccounted)
				: null,
		phase: headOnly ? "head_reconciliation" : phase,
		...(lastAccounted ? { checkpointPosition: Math.max(0, offset - 1) } : {}),
		headAnchorIds,
		historyDiagnostics: {
			...responseTracker.diagnostics,
			rowsAtStart,
			rowsAtEnd: currentEnd.domItemCount ?? totalRows,
			scrollRounds,
			unchangedRounds,
			scrollGeometry: lastScrollGeometry,
		},
	};
}

async function readVideoList(
	page: BrowserCollectContext["page"],
	url: string,
	rounds: number,
	mode: "playlist",
	capture?: BrowserCollectContext["capture"],
): Promise<VideoReadResult> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(PAGE_HYDRATION_WAIT_MS);
	const state = await waitForContent(
		page,
		"yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer",
	);
	if (state === "unreadable")
		throw new Error("youtube_playlist_page_unreadable");
	await capture?.captureDom(
		page,
		url.includes("list=LL") ? "youtube-liked-videos" : "youtube-playlist-items",
	);
	if (state === "empty") {
		const end = await page.evaluate(readListEndInBrowser, {
			kind: "playlist" as const,
			sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
		});
		const evidence = exhaustionEvidence(end, 0, false);
		return {
			items: [],
			exhausted: evidence.kind !== "unproven",
			evidence,
			verifiedEmpty: evidence.kind === "page-data-empty",
			partialCheckpointAllowed: false,
		};
	}
	const seen = new Set<string>();
	const out: BrowserVideo[] = [];
	let continuationRemoved = false;
	let noChangeRounds = 0;
	const selector =
		"yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer";
	for (let round = 0; round <= rounds; round += 1) {
		const previousCount = out.length;
		const batch = await page.evaluate(readPlaylistVideosInBrowser, mode);
		for (const video of batch) {
			const key = videoIdentity(video);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(video);
			}
		}
		noChangeRounds = out.length === previousCount ? noChangeRounds + 1 : 0;
		if (noChangeRounds >= 2) break;
		if (round < rounds)
			continuationRemoved =
				(await scroll(
					page,
					1,
					selector,
					LIST_CONTINUATION_SELECTORS.playlist,
					1_500,
				)) || continuationRemoved;
	}
	if (out.length === 0) throw new Error("youtube_video_parse_mismatch");
	const pageEnd = await page.evaluate(readListEndInBrowser, {
		kind: "playlist" as const,
		sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
	});
	await capture?.captureDom(
		page,
		url.includes("list=LL")
			? "youtube-liked-videos-after-scroll"
			: "youtube-playlist-items-after-scroll",
	);
	const evidence = exhaustionEvidence(pageEnd, out.length, continuationRemoved);
	return {
		items: out,
		exhausted: evidence.kind !== "unproven",
		evidence,
		verifiedEmpty: false,
		partialCheckpointAllowed: false,
	};
}

function readPlaylistVideoList(
	page: BrowserCollectContext["page"],
	url: string,
	rounds: number,
	capture?: BrowserCollectContext["capture"],
): Promise<VideoReadResult> {
	return readVideoList(page, url, rounds, "playlist", capture);
}

function readWatchHistoryList(
	page: BrowserCollectContext["page"],
	url: string,
	capture?: BrowserCollectContext["capture"],
	historyCursor?: HistoryCursor,
	collectionMode?: BrowserCollectContext["collectionMode"],
	emitRecord?: HistoryStreamRecord,
	identityForVideo?: (video: BrowserVideo) => string,
	progress?: HistoryRunProgress,
): Promise<VideoReadResult> {
	return readHistoryVideoList(
		page,
		url,
		capture,
		historyCursor,
		collectionMode,
		emitRecord ?? (async () => undefined),
		identityForVideo ?? videoIdentity,
		progress,
	);
}

const DIAGNOSTIC_ERROR_NAMES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"TimeoutError",
	"AbortError",
]);

/** A fixed vocabulary: a browser or adapter can put data in an error name. */
function errorNameForDiagnostics(error: unknown): string {
	if (!(error instanceof Error)) return "non-error";
	return DIAGNOSTIC_ERROR_NAMES.has(error.name) ? error.name : "other";
}

/**
 * Why a history read ended failed or incomplete, as numbers, flags and fixed
 * vocabulary only. It never holds a video id, title, date, URL or token.
 */
function historyFailureDiagnostics(
	result: VideoReadResult,
): Record<string, unknown> {
	const history = result.historyDiagnostics;
	return {
		stop_reason: result.stopReason ?? null,
		phase: result.phase ?? null,
		scanned_count: result.scannedCount ?? 0,
		parsed_count: result.parsedCount ?? 0,
		deduped_count: result.dedupedCount ?? 0,
		safe_prefix: Boolean(result.lastAccounted),
		blocked: result.blocked === true,
		proof_kind: result.evidence.kind,
		browse_total: history?.browseResponseCount ?? null,
		correlated: history?.correlatedResponseCount ?? null,
		uncorrelated: history?.uncorrelatedResponseCount ?? null,
		foreign: history?.foreignResponseCount ?? null,
		non_2xx: history?.non2xxResponseCount ?? null,
		unrecognized: history?.unrecognizedResponseCount ?? null,
		tracking_complete: history?.trackingComplete ?? null,
	};
}

async function readableVideos(
	ctx: BrowserContext,
	streams: StreamReporter,
	url: string,
	rounds: number,
	stream: string,
	historyCursor?: HistoryCursor,
	historyRecord?: HistoryStreamRecord,
	historyIdentityForVideo?: (video: BrowserVideo) => string,
	historyProgress?: HistoryRunProgress,
): Promise<VideoReadResult | null> {
	try {
		const result =
			stream === "watch_history"
				? await readWatchHistoryList(
						ctx.page,
						url,
						ctx.capture,
						historyCursor,
						ctx.collectionMode,
						historyRecord,
						historyIdentityForVideo,
						historyProgress,
					)
				: await readPlaylistVideoList(ctx.page, url, rounds, ctx.capture);
		if (
			!result.exhausted &&
			(stream !== "watch_history" || !result.partialCheckpointAllowed)
		)
			await streams.fail(
				stream,
				undefined,
				stream === "watch_history"
					? historyFailureDiagnostics(result)
					: undefined,
			);
		return result;
	} catch (error) {
		const preciseReason =
			error instanceof Error &&
			/^youtube_(?:history_setup_timeout|(?:history|playlist)_page_unreadable)$/.test(error.message)
				? error.message
				: undefined;
		await streams.fail(
			stream,
			preciseReason,
			stream === "watch_history"
				? {
						stop_reason: "exception",
						error_name: errorNameForDiagnostics(error),
					}
				: undefined,
		);
		return null;
	}
}

type BrowserContext = Pick<
	BrowserCollectContext,
	| "page"
	| "requested"
	| "collectionMode"
	| "emitRecord"
	| "emit"
	| "progress"
	| "reportStreamFailure"
> & {
	state?: BrowserCollectContext["state"];
	capture?: BrowserCollectContext["capture"];
};

async function emitCoverageProgress(
	ctx: Pick<BrowserContext, "progress">,
	connector: "youtube",
	facts: Iterable<CoverageFact>,
): Promise<void> {
	const sorted = [...facts].sort((a, b) => a.stream.localeCompare(b.stream));
	// One diagnostic line per stream keeps each line under the helper's length
	// bound. The facts are the ones the old JSON PROGRESS carried.
	for (const fact of sorted) {
		connectorDiagnostic(connector, "coverage", { ...fact });
	}
	const saved = sorted.reduce((sum, fact) => sum + fact.emitted_count, 0);
	const history = sorted.find((fact) => fact.stream === "watch_history");
	if (history?.incomplete) {
		await ctx.progress(
			`YouTube: ${saved} items saved; watch history incomplete (${history.stop_reason ?? "unproven"}; ${history.parsed_count ?? 0} rows parsed, ${history.deduped_count ?? 0} repeated rows).`,
		);
		return;
	}
	await ctx.progress(
		`Finished YouTube: ${saved} ${saved === 1 ? "item" : "items"} saved`,
	);
}

/** Exported so fixture/protocol tests can run without launching a browser. */
export async function collectYoutubeBrowser(
	ctx: BrowserContext,
): Promise<void> {
	const capturedAt = new Date().toISOString();
	const { page, requested } = ctx;
	const streams = createStreamReporter(ctx);
	const failPlaylistStreams = async (message?: string) => {
		for (const stream of ["playlists", "playlist_items"])
			if (requested.has(stream)) await streams.fail(stream, message);
	};
	const coverage = new Map<string, CoverageFact>(
		[...requested.keys()].map((stream) => [
			stream,
			{
				stream,
				requested: true,
				source: "browser",
				emitted_count: 0,
				time_range_requested: Boolean(requested.get(stream)?.time_range),
			},
		]),
	);
	const emit = async (stream: string, record: Record<string, unknown>) => {
		const fact = coverage.get(stream);
		if (fact) fact.emitted_count += 1;
		await ctx.emitRecord(stream, record);
	};
	if (requested.has("profile")) {
		await page.goto(HOME, { waitUntil: "domcontentloaded" });
		const homeState = await waitForContent(
			page,
			"button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn",
		);
		if (homeState !== "content") {
			await skipUnreadable(ctx, "profile", "youtube_profile_home_not_ready");
		} else {
			await page
				.locator(
					"button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn",
				)
				.first()
				.click();
			const headerState = await waitForContent(
				page,
				"ytd-active-account-header-renderer",
			);
			if (headerState !== "content") {
				await skipUnreadable(
					ctx,
					"profile",
					"youtube_profile_account_header_unreadable",
				);
			} else {
				const account = await page.evaluate(
					readOwnAccount as () => ReturnType<typeof readOwnAccount>,
				);
				// The avatar menu itself does not show the email on current YouTube;
				// the Switch account view does, in the signed-in account's header.
				const own = {
					...account,
					email: account.email ?? (await readSwitchAccountEmail(page)),
				};
				if (!own.channel_url) {
					if (own.email) {
						await emit("profile", {
							id: own.email,
							channel_id: null,
							channel_url: null,
							title: null,
							handle: null,
							...(own.email ? { email: own.email } : {}),
							joined_at: null,
							avatar_url: null,
							description: null,
							country: null,
							subscriber_count: null,
							view_count: null,
							video_count: null,
						});
					} else {
						await ctx.emit({
							type: "SKIP_RESULT",
							stream: "profile",
							reason: "youtube_profile_channel_link_unavailable",
							recovery_hint: { action: "retry_by_runtime", retryable: true },
							message:
								"The signed-in account header did not expose an own-channel link.",
						});
					}
				} else {
					await page.goto(own.channel_url, { waitUntil: "domcontentloaded" });
					const channelState = await waitForChannelIdentity(page);
					if (channelState !== "content") {
						await skipUnreadable(
							ctx,
							"profile",
							"youtube_profile_channel_page_unreadable",
						);
					} else {
						const channel = await page.evaluate(
							readChannelPage as () => ReturnType<typeof readChannelPage>,
						);
						let about: ReturnType<typeof readChannelAbout> | null = null;
						let aboutUnreadable = false;
						try {
							await page.goto(`${own.channel_url.replace(/\/$/, "")}/about`, {
								waitUntil: "domcontentloaded",
							});
							const aboutState = await waitForChannelAbout(page);
							if (aboutState === "unreadable") {
								await skipUnreadable(
									ctx,
									"profile",
									"youtube_profile_about_page_unreadable",
								);
								aboutUnreadable = true;
							} else if (aboutState === "content")
								about = await page.evaluate(
									readChannelAbout as () => ReturnType<typeof readChannelAbout>,
								);
						} catch {
							await skipUnreadable(
								ctx,
								"profile",
								"youtube_profile_about_page_unreadable",
							);
							aboutUnreadable = true;
						}
						if (!aboutUnreadable) {
							await emit("profile", {
								id: channel.channel_id ?? own.channel_url,
								channel_id: channel.channel_id,
								channel_url: own.channel_url,
								title: channel.title,
								handle: channel.handle,
								...(own.email ? { email: own.email } : {}),
								joined_at: about?.joined_at ?? null,
								avatar_url: channel.avatar_url,
								description: about?.description ?? null,
								country: about?.country ?? null,
								subscriber_count: parseCount(about?.subscriber_count_text),
								view_count: parseCount(about?.view_count_text),
								video_count: parseCount(about?.video_count_text),
							});
						}
					}
				}
			}
		}
	}
	if (requested.has("subscriptions")) {
		try {
			await page.goto(`${HOME}feed/channels`, {
				waitUntil: "domcontentloaded",
			});
			await page.waitForTimeout(PAGE_HYDRATION_WAIT_MS);
			const state = await waitForContent(page, "ytd-channel-renderer");
			await ctx.capture?.captureDom(page, "youtube-subscriptions");
			if (state === "unreadable")
				await streams.fail(
					"subscriptions",
					"YouTube did not expose readable subscription cards.",
				);
			else {
				const result = await readSubscriptionsList(page, state);
				await ctx.capture?.captureDom(
					page,
					"youtube-subscriptions-after-scroll",
				);
				const subscriptions = result.items;
				if (state === "content" && subscriptions.length === 0) {
					await streams.fail(
						"subscriptions",
						"YouTube showed subscription content, but the connector could not parse any channel cards.",
					);
				} else if (state === "empty") {
					if (result.evidence.kind === "page-data-empty")
						await emitVerifiedEmptyState(ctx, "subscriptions", capturedAt);
					else await streams.fail("subscriptions");
				} else if (!result.exhausted) {
					await streams.fail("subscriptions");
				}
				for (const channel of subscriptions)
					await emit("subscriptions", {
						id: channel.channel_url,
						channel_id: channel.channel_id,
						channel_title: channel.channel_title,
						channel_url: channel.channel_url,
						handle: channel.handle,
						avatar_url: channel.avatar_url,
						subscriber_count: parseCount(channel.subscriber_count_text),
						...(channel.subscriber_count_text
							? { subscriber_count_text: channel.subscriber_count_text }
							: {}),
						description: channel.description,
						is_verified: channel.is_verified,
						notifications: channel.notifications,
					});
			}
		} catch {
			await streams.fail("subscriptions");
		}
	}
	let playlistLinks: Array<{ id: string; url: string }> = [];
	let playlistIndexReadable = true;
	let playlistIndexVerifiedEmpty = false;
	let playlistItemsEmptyProven = false;
	if (requested.has("playlists") || requested.has("playlist_items")) {
		try {
			await page.goto(`${HOME}feed/playlists`, {
				waitUntil: "domcontentloaded",
			});
			await page.waitForTimeout(PAGE_HYDRATION_WAIT_MS);
			const state = await waitForContent(page, 'a[href*="list="]', {
				playlistIndex: true,
			});
			await ctx.capture?.captureDom(page, "youtube-playlist-index");
			if (state === "unreadable") {
				playlistIndexReadable = false;
				await failPlaylistStreams(
					"YouTube did not expose a readable playlist index.",
				);
			} else {
				const result = await readPlaylistIndex(page, state);
				await ctx.capture?.captureDom(
					page,
					"youtube-playlist-index-after-scroll",
				);
				playlistLinks = result.items;
				playlistItemsEmptyProven = result.exhausted;
				for (const stream of ["playlists", "playlist_items"]) {
					if (!requested.has(stream)) continue;
					if (
						result.items.length === 0 &&
						result.evidence.kind === "page-data-empty"
					) {
						playlistIndexVerifiedEmpty = true;
					} else if (playlistLinks.length === 0) {
						playlistIndexReadable = false;
						await streams.fail(
							stream,
							"YouTube showed playlist index content, but the connector could not parse any playlist links.",
						);
					} else if (!result.exhausted) await streams.fail(stream);
				}
			}
		} catch {
			playlistIndexReadable = false;
			await failPlaylistStreams(
				"YouTube playlist index navigation or parsing failed.",
			);
		}
	}
	if (
		playlistIndexReadable &&
		(requested.has("playlists") || requested.has("playlist_items"))
	) {
		for (const playlist of playlistLinks) {
			if (requested.has("playlists")) {
				try {
					await page.goto(playlist.url, { waitUntil: "domcontentloaded" });
					if (
						(await waitForContent(
							page,
							"yt-dynamic-text-view-model h1 span, .yt-page-header-view-model__page-header-title h1 span, h1#title, h1 yt-formatted-string",
						)) !== "content"
					) {
						await streams.fail(
							"playlists",
							`YouTube playlist ${playlist.id} did not expose readable header details.`,
						);
					} else {
						const header = await page.evaluate(
							readPlaylistHeader as () => ReturnType<typeof readPlaylistHeader>,
						);
						await emit("playlists", {
							id: playlist.id,
							url: playlist.url,
							title: header.title,
							owner: header.owner,
							owner_url: header.owner_url,
							visibility: header.visibility,
							video_count: parseCount(header.video_count_text),
							view_count: /no views/i.test(header.view_count_text ?? "")
								? 0
								: parseCount(header.view_count_text),
						});
					}
				} catch {
					await streams.fail(
						"playlists",
						`YouTube playlist ${playlist.id} header navigation or parsing failed.`,
					);
				}
			}
			if (requested.has("playlist_items")) {
				try {
					const result = await readableVideos(
						ctx,
						streams,
						playlist.url,
						SCROLLS.playlist_items,
						"playlist_items",
					);
					playlistItemsEmptyProven = playlistItemsEmptyProven &&
						result !== null && result.exhausted && result.items.length === 0;
					if (result) {
						for (const video of result.items) {
							await emit("playlist_items", {
								id: await youtubeRecordId(`playlist_item|${playlist.id}|${videoIdentity(video)}`),
								playlist_id: playlist.id,
								...videoFields(video),
							});
						}
					}
				} catch {
					playlistItemsEmptyProven = false;
					await streams.fail(
						"playlist_items",
						`YouTube playlist ${playlist.id} items could not be collected.`,
					);
				}
			}
		}
	}
	if (playlistIndexVerifiedEmpty) {
		for (const stream of ["playlists", "playlist_items"])
			if (requested.has(stream))
				await emitVerifiedEmptyState(ctx, stream, capturedAt);
	}
	if (!playlistIndexVerifiedEmpty && playlistIndexReadable &&
		playlistItemsEmptyProven && requested.has("playlist_items"))
		await emitVerifiedEmptyState(ctx, "playlist_items", capturedAt);
	for (const [stream, list] of [
		["likes", "LL"],
		["watch_later", "WL"],
	] as const) {
		if (!requested.has(stream)) continue;
		const result = await readableVideos(
			ctx,
			streams,
			`${HOME}playlist?list=${list}`,
			SCROLLS.playlist_items,
			stream,
		);
		if (!result) continue;
		for (const video of result.items)
			await emit(stream, {
				id: await youtubeRecordId(`${stream}|${videoIdentity(video)}`),
				...videoFields(video),
			});
		if (result.verifiedEmpty)
			await emitVerifiedEmptyState(ctx, stream, capturedAt);
	}
	if (requested.has("watch_history")) {
		if (requested.get("watch_history")?.time_range) {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream: "watch_history",
				reason: "scope_not_supported",
				message:
					"Watch history provides dates without watch times, so a time_range cannot be applied.",
				recovery_hint: { action: "not_retriable", retryable: false },
			});
			return;
		}
		// One outer deadline bounds the whole history path. After it expires the
		// path is abandoned: its late emits are dropped, so no STATE can follow.
		let historyAbandoned = false;
		let stateInFlight = false;
		const progress = new HistoryRunProgress();
		const gate = <A extends unknown[]>(send: (...args: A) => Promise<void>) =>
			async (...args: A): Promise<void> => {
				if (!historyAbandoned) await send(...args);
			};
		const gatedEmit = gate(ctx.emit.bind(ctx));
		const historyCtx: BrowserContext = {
			...ctx,
			emit: async (message) => {
				if (historyAbandoned) return;
				const isState = (message as { type?: string }).type === "STATE";
				if (isState) stateInFlight = true;
				await gatedEmit(message);
				if (isState) stateInFlight = false;
				progress.acknowledged();
			},
			emitRecord: async (stream, record) => {
				if (historyAbandoned) return;
				await ctx.emitRecord(stream, record);
				progress.acknowledged();
			},
			...(ctx.reportStreamFailure
				? { reportStreamFailure: gate(ctx.reportStreamFailure.bind(ctx)) }
				: {}),
		};
		const historyStreams = createStreamReporter(historyCtx);
		const emitHistoryRecord = async (record: Record<string, unknown>) => {
			const fact = coverage.get("watch_history");
			if (fact) fact.emitted_count += 1;
			await historyCtx.emitRecord("watch_history", record);
		};
		const runHistory = async (): Promise<void> => {
			const priorCursor =
				ctx.collectionMode === "full_refresh"
					? undefined
					: (ctx.state?.watch_history as HistoryCursor | undefined);
			const readBrowserDate = () => {
				const now = new Date();
				return [now.getFullYear(), now.getMonth(), now.getDate()];
			};
			const browserDate = await page.evaluate(readBrowserDate);
			const dateReference =
				Array.isArray(browserDate) && browserDate.length === 3
					? new Date(browserDate[0]!, browserDate[1]!, browserDate[2]!, 12)
					: new Date(capturedAt);
			let unresolvedDateCount = 0;
			const result = await readableVideos(
				historyCtx,
				historyStreams,
				`${HOME}feed/history`,
				0,
				"watch_history",
				priorCursor,
				async (video, position) => {
					const watchedDate = resolveWatchedDate(
						video.watched_date_label ?? null,
						dateReference,
					);
					if (!watchedDate) unresolvedDateCount += 1;
					await emitHistoryRecord({
						id: await youtubeRecordId(
							`history|${historyIdentity(video, dateReference)}`,
						),
						position,
						watched_date: watchedDate,
						watched_date_label: video.watched_date_label ?? null,
						video_id: video.video_id,
						video_url: video.video_url,
						video_title: video.video_title,
						channel_title: video.channel_title,
						channel_url: video.channel_url,
						view_count: parseCount(video.views_text),
						views_text: video.views_text ?? null,
						description: video.description,
					});
				},
				(video) => historyIdentity(video, dateReference),
				progress,
			);
			if (result) {
				const fact = coverage.get("watch_history");
				if (fact) {
					fact.enumerated_count = result.scannedCount ?? 0;
					fact.parsed_count = result.parsedCount ?? 0;
					fact.deduped_count = result.dedupedCount ?? 0;
					if (result.stopReason) fact.stop_reason = result.stopReason;
					fact.incomplete = !result.exhausted;
					fact.next_checkpoint = result.checkpointAnchor
						? await youtubeRecordId(result.checkpointAnchor)
						: null;
					fact.unresolved_date_count = unresolvedDateCount;
					if (unresolvedDateCount > 0) fact.incomplete = true;
					if (result.historyDiagnostics)
						reportHistoryTraversal(result.historyDiagnostics);
				}
				if (result.verifiedEmpty) {
					await emitVerifiedEmptyState(historyCtx, "watch_history", capturedAt);
				} else if (
					!result.blocked &&
					(result.exhausted ||
						(result.checkpointAnchor &&
							(!priorCursor?.complete || result.partialCheckpointAllowed)))
				) {
					const complete =
						unresolvedDateCount === 0 &&
						(result.exhausted ||
							(priorCursor?.complete === true &&
								result.stopReason === "head-reconciled"));
					const evidence = result.exhausted
						? result.evidence.kind
						: result.partialCheckpointAllowed
							? "youtube_history_head_reconciled"
							: "youtube_history_safe_prefix_before_gap";
					await historyCtx.emit({
						type: "STATE",
						stream: "watch_history",
						cursor: {
							version: 2,
							scope: "watch_history",
							phase: complete
								? "head_reconciliation"
								: (result.phase ?? "backfill"),
							backfill_anchor_id:
								result.checkpointAnchor ??
								priorCursor?.backfill_anchor_id ??
								priorCursor?.last_seen_video_id,
							position: result.checkpointPosition ?? priorCursor?.position ?? 0,
							head_anchor_ids:
								result.headAnchorIds ?? priorCursor?.head_anchor_ids ?? [],
							complete,
							stop_reason: result.stopReason,
							evidence,
						},
					});
				}
			}
		};
		if ((await raceNoProgress(runHistory(), progress)) === "expired") {
			historyAbandoned = true;
			// A STATE that was sent but never acknowledged has an unknown outcome:
			// it is reported as such, never as success.
			const unacknowledged = stateInFlight;
			// Neither sink is trusted: each gets its own fixed deadline, and a sink
			// that does not answer leaves the outcome unknown instead of hanging.
			await settleSink(
				streams.fail(
					"watch_history",
					unacknowledged
						? "youtube_history_state_unacknowledged"
						: "youtube_history_outer_timeout",
					{
						stop_reason: unacknowledged
							? "history-state-unacknowledged"
							: "history-outer-timeout",
						outcome: unacknowledged ? "unknown" : "failed",
					},
				),
				"failure-report",
			);
			await settleSink(
				emitCoverageProgress(ctx, "youtube", coverage.values()),
				"coverage-progress",
			);
			return;
		}
	}
	await emitCoverageProgress(ctx, "youtube", coverage.values());
}

export const youtubeConnectorConfig = {
	name: "youtube",
	validateRecord,
	browser: { profileName: "youtube" },
	ensureSession: ensureYoutubeSession,
	probeSession: async ({ page }) => probeYoutubeSession(page),
	probeSessionIsAuthoritative: true,
	collect: collectYoutubeBrowser,
} satisfies Parameters<typeof runConnector>[0];

if (isMainModule(import.meta.url)) {
	runConnector(youtubeConnectorConfig);
}
