#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Browser-first YouTube Collection Profile. The owner signs in in PDPP's browser. */
import { createHash } from "node:crypto";
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
} from "./browser-dom.ts";
import {
	enumerationEnded,
	type ListEnd,
	type ListKind,
	readListEnd,
	readPageReadiness,
} from "./page-evidence.ts";
import { validateRecord } from "./schemas.ts";

export { readPageReadiness } from "./page-evidence.ts";

const HOME = "https://www.youtube.com/";
const HISTORY_LIMIT = 50;
const PAGE_HYDRATION_WAIT_MS = 2_000;
const SCROLLS = {
	subscriptions: 3,
	playlists: 5,
	playlist_items: 20,
	history: 4,
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
	limit?: number;
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
	return await page.evaluate(
		() =>
			Boolean(
				document.querySelector(
					'button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn, ytd-masthead button[aria-label*="Account"]',
				),
			) &&
			!document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'),
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
		const continuationBefore = await page
			.locator(continuationSelector)
			.count();
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
		const continuationAfter = await page
			.locator(continuationSelector)
			.count();
		if (continuationBefore > 0 && continuationAfter === 0) {
			await page.waitForTimeout(settleMilliseconds);
			if ((await page.locator(continuationSelector).count()) === 0)
				return true;
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
	options: { playlistIndex?: boolean } = {},
): Promise<"content" | "empty" | "unreadable"> {
	try {
		const handle = await page.waitForFunction(
			readPageReadiness,
			{
				content: selector,
				empty: EMPTY_STATE,
				playlistIndex: options.playlistIndex ?? false,
			},
			{ timeout: 10_000 },
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
const HISTORY_CAP_MESSAGE = `The watch history read stopped at the ${HISTORY_LIMIT}-item limit before the end of the list.`;

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
		| "page-data-empty"
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
): ExhaustionEvidence {
	if (page?.verifiedEmpty) return { kind: "page-data-empty", page };
	if (!page || !enumerationEnded(page, renderedCount, continuationRemoved))
		return { kind: "unproven", page };
	return {
		kind: continuationRemoved ? "continuation-removed" : "explicit-end-marker",
		page,
	};
}

async function readSubscriptionsList(
	page: BrowserCollectContext["page"],
	state: "content" | "empty",
): Promise<
	ListRead<Awaited<ReturnType<typeof readSubscriptions>>[number]>
> {
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
	const pageEnd = await page.evaluate<ListEnd, ListKind>(
		readListEnd,
		"playlist-index",
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

interface VideoReadResult extends ListRead<BrowserVideo> {
	readonly verifiedEmpty: boolean;
	/** The read stopped at the connector's own item limit. */
	readonly cappedAtLimit: boolean;
}

async function readVideoList(
	page: BrowserCollectContext["page"],
	url: string,
	rounds: number,
	mode: "playlist" | "history",
	capture?: BrowserCollectContext["capture"],
): Promise<VideoReadResult> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(PAGE_HYDRATION_WAIT_MS);
	const state = await waitForContent(
		page,
		mode === "history"
			? "ytd-item-section-renderer yt-lockup-view-model"
			: "yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer",
	);
	if (state === "unreadable")
		throw new Error(`youtube_${mode}_page_unreadable`);
	await capture?.captureDom(
		page,
		url.includes("list=LL")
			? "youtube-liked-videos"
			: mode === "history"
				? "youtube-watch-history"
				: "youtube-playlist-items",
	);
	if (state === "empty") {
		const end = await page.evaluate(readListEnd, mode);
		if (!end.verifiedEmpty) throw new Error("youtube_empty_list_unproven");
		return {
			items: [],
			exhausted: true,
			evidence: { kind: "page-data-empty", page: end },
			verifiedEmpty: true,
			cappedAtLimit: false,
		};
	}
	const seen = new Set<string>();
	const out: BrowserVideo[] = [];
	let renderedCount = 0;
	let continuationRemoved = false;
	let noChangeRounds = 0;
	const selector =
		mode === "history"
			? "yt-lockup-view-model"
			: "yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer";
	for (let round = 0; round <= rounds; round += 1) {
		const previousCount = out.length;
		const batch = await page.evaluate(readVideos, mode);
		renderedCount = batch.length;
		for (const video of batch) {
			const key = videoIdentity(video);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(video);
			}
		}
		noChangeRounds = out.length === previousCount ? noChangeRounds + 1 : 0;
		if (mode === "history" && out.length >= HISTORY_LIMIT) break;
		if (noChangeRounds >= 2) break;
		if (round < rounds)
			continuationRemoved =
				(await scroll(
					page,
					1,
					selector,
					LIST_CONTINUATION_SELECTORS[mode],
					mode === "history" ? 800 : 1_500,
				)) ||
				continuationRemoved;
	}
	if (out.length === 0) throw new Error("youtube_video_parse_mismatch");
	// The history limit is a cap the connector chose, not the end of the list.
	// Reaching it exactly can still be the end, so source evidence decides, unless
	// the cap discarded rows that were read.
	const cappedAtLimit = mode === "history" && out.length >= HISTORY_LIMIT;
	const discardedRows = mode === "history" && out.length > HISTORY_LIMIT;
	const pageEnd = await page.evaluate(readListEnd, mode);
	await capture?.captureDom(
		page,
		url.includes("list=LL")
			? "youtube-liked-videos-after-scroll"
			: mode === "history"
				? "youtube-watch-history-after-scroll"
				: "youtube-playlist-items-after-scroll",
	);
	const evidenceReadCount =
		mode === "history" ? Math.min(out.length, HISTORY_LIMIT) : renderedCount;
	const evidence = exhaustionEvidence(
		pageEnd,
		evidenceReadCount,
		continuationRemoved && !discardedRows,
	);
	return {
		items: mode === "history" ? out.slice(0, HISTORY_LIMIT) : out,
		exhausted: evidence.kind !== "unproven",
		evidence,
		verifiedEmpty: false,
		cappedAtLimit,
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
	rounds: number,
	capture?: BrowserCollectContext["capture"],
): Promise<VideoReadResult> {
	return readVideoList(page, url, rounds, "history", capture);
}

async function readableVideos(
	ctx: BrowserContext,
	streams: StreamReporter,
	url: string,
	rounds: number,
	stream: string,
): Promise<VideoReadResult | null> {
	try {
		const result =
			stream === "watch_history"
				? await readWatchHistoryList(ctx.page, url, rounds, ctx.capture)
				: await readPlaylistVideoList(ctx.page, url, rounds, ctx.capture);
		if (!result.exhausted)
			await streams.fail(
				stream,
				result.cappedAtLimit ? HISTORY_CAP_MESSAGE : undefined,
			);
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
	| "emitRecord"
	| "emit"
	| "progress"
	| "reportStreamFailure"
> & { capture?: BrowserCollectContext["capture"] };

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
					if (result.exhausted)
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
					if (state === "empty" && result.exhausted) {
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
		const result = await readableVideos(
			ctx,
			streams,
			`${HOME}feed/history`,
			SCROLLS.history,
			"watch_history",
		);
		if (result) {
			const { items } = result;
			const fact = coverage.get("watch_history");
			if (fact) {
				fact.enumerated_count = items.length;
				fact.limit = HISTORY_LIMIT;
				fact.skipped_unresolved_date_count = 0;
			}
			const browserDate = await page.evaluate(() => {
				const now = new Date();
				return [now.getFullYear(), now.getMonth(), now.getDate()];
			});
			const dateReference =
				Array.isArray(browserDate) && browserDate.length === 3
					? new Date(browserDate[0]!, browserDate[1]!, browserDate[2]!, 12)
					: new Date(capturedAt);
			for (const [position, video] of items.entries()) {
				const watchedDate = resolveWatchedDate(
					video.watched_date_label ?? null,
					dateReference,
				);
				await emit("watch_history", {
					id: id(`history|${videoIdentity(video)}`),
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
			}
			if (result.verifiedEmpty)
				await emitVerifiedEmptyState(ctx, "watch_history", capturedAt);
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
