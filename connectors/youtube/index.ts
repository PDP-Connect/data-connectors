#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Browser-first YouTube Collection Profile. The owner signs in in PDPP's browser. */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Request, Response } from "playwright";
import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type BrowserVideo,
	CHANNEL_TITLE_SELECTOR,
	readChannelAbout,
	readChannelPage,
	readOwnAccount,
	readPlaylistHeader,
	readPlaylistLinks,
	readSubscriptions,
	readVideos,
	type HistoryVideoPage,
} from "./browser-dom.ts";
import {
	enumerationEnded,
	readHistoryResponseEvidence,
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
const HISTORY_MAX_SCROLL_ROUNDS = 400;
const HISTORY_DEDUP_WINDOW = 500;
const HISTORY_TIME_BUDGET_MS = 180_000;
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
	skipped_unresolved_date_count?: number;
};

function id(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function videoIdentity(video: BrowserVideo): string {
	if (video.video_id) return video.video_id;
	const url = new URL(video.video_url);
	url.searchParams.delete("list");
	url.searchParams.delete("index");
	return url.href;
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

class HistoryResponseTracker {
	private static readonly MAX_TRACKED_TOKENS = HISTORY_MAX_SCROLL_ROUNDS + 8;
	private static readonly MAX_PRESEED_RESPONSES = 32;
	private readonly page: BrowserCollectContext["page"];
	private readonly tokens = new Set<string>();
	private readonly requestedTokens = new Set<string>();
	private readonly preSeedResponses: Response[] = [];
	private seeded = false;
	private preSeedOverflow = false;
	private evidenceVersion = 0;
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
	private unrecognizedResponseCount = 0;
	private latestStatus: number | null = null;
	private pending = Promise.resolve();
	private readonly onResponse = (response: Response): void => {
		if (!response.url().includes("/youtubei/v1/browse")) return;
		this.evidenceVersion += 1;
		if (!this.seeded) {
			if (
				this.preSeedResponses.length <
				HistoryResponseTracker.MAX_PRESEED_RESPONSES
			)
				this.preSeedResponses.push(response);
			else this.preSeedOverflow = true;
			return;
		}
		this.enqueue(response);
	};

	constructor(page: BrowserCollectContext["page"]) {
		this.page = page;
		page.on("response", this.onResponse);
	}

	seed(tokens: readonly string[], page: ListEnd): void {
		this.bootstrapReadable = page.dataReadable;
		this.bootstrapItemCount =
			page.historyBootstrapItemCount ?? page.dataItemCount;
		this.bootstrapHasContinuation = page.dataHasContinuation;
		this.bootstrapRendererCounts = page.historyBootstrapRendererCounts ?? {};
		for (const token of tokens.slice(0, 8))
			if (token.length > 0 && token.length <= 4096) this.tokens.add(token);
		this.bootstrapTokenCount = this.tokens.size;
		this.seeded = true;
		for (const response of this.preSeedResponses.splice(0))
			this.enqueue(response);
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
			non2xxResponseCount: this.non2xxResponseCount,
			unrecognizedResponseCount: this.unrecognizedResponseCount,
			latestStatus: this.latestStatus,
			latestRecognized: this.latestResponse?.recognized ?? null,
			latestHasContinuation: this.latestResponse?.hasContinuation ?? null,
			preSeedOverflow: this.preSeedOverflow,
		};
	}

	get latest(): HistoryResponseEvidence | null {
		return this.latestResponse;
	}

	get version(): number {
		return this.evidenceVersion;
	}

	get trackingComplete(): boolean {
		return !this.preSeedOverflow;
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	dispose(): void {
		this.page.off("response", this.onResponse);
	}

	private enqueue(response: Response): void {
		this.pending = this.pending
			.then(() => this.inspect(response))
			.catch(() => undefined);
	}

	private async inspect(response: Response): Promise<void> {
		if (!response.url().includes("/youtubei/v1/browse")) return;
		this.browseResponseCount += 1;
		let requestBody: Record<string, unknown> | null = null;
		const request: Request = response.request();
		try {
			requestBody = recordValue(request.postDataJSON());
		} catch {
			this.uncorrelatedResponseCount += 1;
			return;
		}
		const requestedContinuation =
			typeof requestBody?.continuation === "string"
				? requestBody.continuation
				: null;
		if (requestedContinuation && requestedContinuation.length > 4096) return;
		const initialHistoryRequest = requestBody?.browseId === "FEhistory";
		if (
			!initialHistoryRequest &&
			(!requestedContinuation || !this.tokens.has(requestedContinuation))
		) {
			this.uncorrelatedResponseCount += 1;
			return;
		}
		this.correlatedResponseCount += 1;
		this.latestStatus = response.status();
		const repeatedRequest =
			requestedContinuation !== null &&
			this.requestedTokens.has(requestedContinuation);
		if (
			requestedContinuation &&
			this.requestedTokens.size < HistoryResponseTracker.MAX_TRACKED_TOKENS
		)
			this.requestedTokens.add(requestedContinuation);
		if (response.status() < 200 || response.status() >= 300) {
			this.non2xxResponseCount += 1;
			this.latestResponse = {
				recognized: false,
				hasContinuation: false,
				requestedContinuation,
				nextContinuation: null,
				repeatedContinuation: false,
			};
			return;
		}
		let responseBody: unknown;
		try {
			responseBody = await response.json();
		} catch {
			this.unrecognizedResponseCount += 1;
			this.latestResponse = {
				recognized: false,
				hasContinuation: false,
				requestedContinuation,
				nextContinuation: null,
				repeatedContinuation: false,
			};
			return;
		}
		const evidence = readHistoryResponseEvidence(
			responseBody,
			requestedContinuation,
			this.requestedTokens,
		);
		if (requestedContinuation && evidence.recognized)
			this.continuationItemCount += evidence.itemCount ?? 0;
		if (!evidence.recognized) this.unrecognizedResponseCount += 1;
		this.latestResponse = {
			...evidence,
			continuationItemCount: this.continuationItemCount,
			repeatedContinuation: evidence.repeatedContinuation || repeatedRequest,
		};
		if (
			evidence.nextContinuation &&
			this.tokens.size < HistoryResponseTracker.MAX_TRACKED_TOKENS
		)
			this.tokens.add(evidence.nextContinuation);
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
export function resolveWatchedDate(
	label: string | null,
	now: Date,
): string | null {
	if (!label) return null;
	const text = label.trim().toLowerCase();
	const localDate = (date: Date) =>
		`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

async function hasYoutubeSession(
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
			"Sign in to YouTube in the secure browser, then continue. PDPP will verify the session before collecting.",
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

async function waitForContent(
	page: BrowserCollectContext["page"],
	selector: string,
	options: { playlistIndex?: boolean; timeoutMs?: number } = {},
): Promise<"content" | "empty" | "unreadable"> {
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
	fail(stream: string, message?: string): Promise<void>;
}

const END_NOT_OBSERVED_MESSAGE =
	"YouTube did not show the end of this list, so the list may be incomplete.";

function createStreamReporter(ctx: BrowserContext): StreamReporter {
	const failed = new Set<string>();
	return {
		async fail(stream, message = END_NOT_OBSERVED_MESSAGE) {
			if (failed.has(stream)) return;
			if (!ctx.reportStreamFailure)
				throw new Error(
					"reportStreamFailure is required to report a failed stream",
				);
			await ctx.reportStreamFailure(stream, message, { retryable: true });
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
		non2xxResponseCount: number;
		unrecognizedResponseCount: number;
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

async function scrollHistoryOnce(
	page: BrowserCollectContext["page"],
	remainingMs: number,
): Promise<HistoryScrollGeometry> {
	const geometry = (await page.evaluate<HistoryScrollGeometry, string>(
		(itemSelector) => {
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
		"yt-lockup-view-model",
	)) ?? {
		containerFound: false,
		containerHeight: null,
		containerClientHeight: null,
		containerTop: null,
		documentHeight: null,
		windowHeight: null,
		windowScrollY: null,
	};
	await page.waitForTimeout(
		Math.max(0, Math.min(HISTORY_SCROLL_WAIT_MS, remainingMs)),
	);
	return geometry;
}

async function readHistoryVideoList(
	page: BrowserCollectContext["page"],
	url: string,
	capture: BrowserCollectContext["capture"] | undefined,
	cursor: HistoryCursor | undefined,
	collectionMode: BrowserCollectContext["collectionMode"],
	emitRecord: HistoryStreamRecord,
): Promise<VideoReadResult> {
	const startedAt = performance.now();
	const responseTracker = new HistoryResponseTracker(page);
	await page.goto(url, {
		waitUntil: "domcontentloaded",
		timeout: HISTORY_TIME_BUDGET_MS,
	});
	let remainingMs = HISTORY_TIME_BUDGET_MS - (performance.now() - startedAt);
	if (remainingMs <= 0) {
		responseTracker.dispose();
		throw new Error("youtube_history_page_unreadable");
	}
	await page.waitForTimeout(Math.min(PAGE_HYDRATION_WAIT_MS, remainingMs));
	remainingMs = HISTORY_TIME_BUDGET_MS - (performance.now() - startedAt);
	const state = await waitForContent(
		page,
		"ytd-item-section-renderer yt-lockup-view-model, ytd-item-section-renderer ytd-video-renderer",
		{ timeoutMs: Math.max(1, Math.min(10_000, remainingMs)) },
	);
	if (state === "unreadable") {
		responseTracker.dispose();
		throw new Error("youtube_history_page_unreadable");
	}
	await capture?.captureDom(page, "youtube-watch-history");
	let currentEnd = await page.evaluate(readListEndInBrowser, {
		kind: "history" as const,
		sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
		latestHistoryResponse: responseTracker.latest,
	});
	responseTracker.seed(
		currentEnd.historyBootstrapContinuationTokens ?? [],
		currentEnd,
	);
	await responseTracker.flush();
	currentEnd = await page.evaluate(readListEndInBrowser, {
		kind: "history" as const,
		sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
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
	let sourceEnded = false;
	let verifiedEmpty = false;
	let blocked = false;
	let parseGap = false;
	let headAnchorIds: string[] = [];
	let evidence: ExhaustionEvidence = { kind: "unproven", page: null };
	// Connector memory holds at most 500 recent identities, 408 requestable
	// and 408 requested tokens (each <= 4 KiB), 32 pre-seed response handles,
	// and one 50-row parse batch. Each response scan visits at most 10,000
	// nodes; traversal is capped at 180 seconds and 400 scroll rounds.
	const rememberIdentity = (key: string): void => {
		rowsSeen.add(key);
		if (rowsSeen.size > HISTORY_DEDUP_WINDOW)
			rowsSeen.delete(rowsSeen.values().next().value!);
	};

	while (true) {
		const elapsed = performance.now() - startedAt;
		remainingMs = HISTORY_TIME_BUDGET_MS - elapsed;
		if (remainingMs <= 0) {
			stopReason = "time-budget";
			break;
		}
		const request = {
			mode: "history",
			offset,
			limit: HISTORY_READ_BATCH_SIZE,
		} as const;
		const rawBatch: unknown = await page.evaluate(
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
				.flatMap((video) => (video ? [videoIdentity(video)] : []));
		}
		if (offset >= totalRows) {
			await responseTracker.flush();
			currentEnd = await page.evaluate(readListEndInBrowser, {
				kind: "history" as const,
				sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
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
			if (scrollRounds >= HISTORY_MAX_SCROLL_ROUNDS) {
				stopReason = "scroll-budget";
				break;
			}
			lastScrollGeometry = await scrollHistoryOnce(page, remainingMs);
			const scrollPosition =
				lastScrollGeometry.containerTop ?? lastScrollGeometry.windowScrollY;
			scrollRounds += 1;
			await responseTracker.flush();
			const afterScrollRaw: unknown = await page.evaluate(
				readHistoryPageInBrowser,
				{
					mode: "history" as const,
					offset: 0,
					limit: 1,
				},
			);
			const afterScroll = decodeHistoryVideoPage(afterScrollRaw);
			currentEnd = await page.evaluate(readListEndInBrowser, {
				kind: "history" as const,
				sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
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
			const key = videoIdentity(video);
			if (resumeAnchor && !resumeAnchorFound && key !== resumeAnchor) {
				if (rowsSeen.has(key)) {
					dedupedCount += 1;
				} else {
					rememberIdentity(key);
					await emitRecord(video, position);
				}
				parsedCount += 1;
				scannedCount += 1;
				offset += 1;
				continue;
			}
			const matchingResumeAnchor = key === resumeAnchor;
			if (matchingResumeAnchor) {
				resumeAnchorFound = true;
				phase = "backfill";
			}
			if (rowsSeen.has(key)) {
				dedupedCount += 1;
			} else {
				rememberIdentity(key);
				await emitRecord(video, position);
			}
			// Before a movable saved identity is found, every observed row belongs
			// to head reconciliation. Upsert the full prefix; never infer delivery
			// from its position above that identity.
			lastAccounted = video;
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
	let stableEnd = false;
	for (let refresh = 0; refresh < 3; refresh += 1) {
		await responseTracker.flush();
		const versionBeforeRead = responseTracker.version;
		currentEnd = await page.evaluate(readListEndInBrowser, {
			kind: "history" as const,
			sessionPresent: await page.evaluate(hasYoutubeSessionOnCurrentPage),
			latestHistoryResponse: responseTracker.latest,
		});
		await responseTracker.flush();
		if (responseTracker.version === versionBeforeRead) {
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
	if (!stableEnd || !responseTracker.trackingComplete) {
		sourceEnded = false;
		verifiedEmpty = false;
		evidence = { kind: "unproven", page: currentEnd };
		stopReason = responseTracker.trackingComplete
			? "history-evidence-changed-during-final-refresh"
			: "history-response-buffer-overflow";
	}
	const hasSafePrefix = lastAccounted !== null;
	const partialCheckpointAllowed =
		!blocked &&
		((hasSafePrefix &&
			!sourceEnded &&
			!parseGap &&
			["time-budget", "scroll-budget"].includes(stopReason)) ||
			(headOnly && stopReason === "head-reconciled"));
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
			stableEnd && responseTracker.trackingComplete && lastAccounted
				? videoIdentity(lastAccounted)
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
): Promise<VideoReadResult> {
	return readHistoryVideoList(
		page,
		url,
		capture,
		historyCursor,
		collectionMode,
		emitRecord ?? (async () => undefined),
	);
}

async function readableVideos(
	ctx: BrowserContext,
	streams: StreamReporter,
	url: string,
	rounds: number,
	stream: string,
	historyCursor?: HistoryCursor,
	historyRecord?: HistoryStreamRecord,
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
					)
				: await readPlaylistVideoList(ctx.page, url, rounds, ctx.capture);
		if (
			!result.exhausted &&
			(stream !== "watch_history" || !result.partialCheckpointAllowed)
		)
			await streams.fail(stream);
		return result;
	} catch (error) {
		const preciseReason =
			error instanceof Error &&
			/^youtube_(?:history|playlist)_page_unreadable$/.test(error.message)
				? error.message
				: undefined;
		await streams.fail(stream, preciseReason);
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
				const own = await page.evaluate(
					readOwnAccount as () => ReturnType<typeof readOwnAccount>,
				);
				if (!own.channel_url) {
					if (own.email) {
						await emit("profile", {
							id: own.email,
							channel_id: null,
							channel_url: null,
							title: null,
							handle: null,
							email: own.email,
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
								email: own.email,
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
						subscriber_count_text: channel.subscriber_count_text,
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
					if (result) {
						for (const video of result.items) {
							await emit("playlist_items", {
								id: id(`playlist_item|${playlist.id}|${videoIdentity(video)}`),
								playlist_id: playlist.id,
								...videoFields(video),
							});
						}
					}
				} catch {
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
				id: id(`${stream}|${videoIdentity(video)}`),
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
		const priorCursor =
			ctx.collectionMode === "full_refresh"
				? undefined
				: (ctx.state?.watch_history as HistoryCursor | undefined);
		let dateReference: Date | null = null;
		const result = await readableVideos(
			ctx,
			streams,
			`${HOME}feed/history`,
			0,
			"watch_history",
			priorCursor,
			async (video, position) => {
				if (!dateReference) {
					const browserDate = await page.evaluate(() => {
						const now = new Date();
						return [now.getFullYear(), now.getMonth(), now.getDate()];
					});
					dateReference =
						Array.isArray(browserDate) && browserDate.length === 3
							? new Date(browserDate[0]!, browserDate[1]!, browserDate[2]!, 12)
							: new Date(capturedAt);
				}
				await emit("watch_history", {
					id: id(`history|${videoIdentity(video)}`),
					position,
					watched_date: resolveWatchedDate(
						video.watched_date_label ?? null,
						dateReference,
					),
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
					? id(result.checkpointAnchor)
					: null;
				fact.skipped_unresolved_date_count = 0;
				if (result.historyDiagnostics)
					reportHistoryTraversal(result.historyDiagnostics);
			}
			if (result.verifiedEmpty) {
				await emitVerifiedEmptyState(ctx, "watch_history", capturedAt);
			} else if (
				!result.blocked &&
				(result.exhausted ||
					(result.checkpointAnchor &&
						(!priorCursor?.complete || result.partialCheckpointAllowed)))
			) {
				const complete =
					result.exhausted ||
					(priorCursor?.complete === true &&
						result.stopReason === "head-reconciled");
				const evidence = result.exhausted
					? result.evidence.kind
					: result.partialCheckpointAllowed
						? "youtube_history_budget_yield"
						: "youtube_history_safe_prefix_before_gap";
				await ctx.emit({
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
