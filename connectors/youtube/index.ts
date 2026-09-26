#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Browser-first YouTube Collection Profile. The owner signs in in PDPP's browser. */
import { createHash } from "node:crypto";
import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
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
import { validateRecord } from "./schemas.ts";

const HOME = "https://www.youtube.com/";
const HISTORY_LIMIT = 50;
const SCROLLS = {
	subscriptions: 3,
	playlists: 5,
	playlist_items: 20,
	history: 4,
} as const;

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
			!Boolean(
				document.querySelector('a[href*="accounts.google.com/ServiceLogin"]'),
			),
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
): Promise<void> {
	for (let i = 0; i < rounds; i += 1) {
		await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
		await page.waitForTimeout(500);
	}
}

const EMPTY_STATE =
	"ytd-message-renderer, yt-message-renderer, ytd-background-promo-renderer";

async function waitForContent(
	page: BrowserCollectContext["page"],
	selector: string,
): Promise<"content" | "empty" | "unreadable"> {
	try {
		const handle = await page.waitForFunction(
			({ content, empty }) => {
				if (document.querySelector(content)) return "content";
				if (document.querySelector(empty)) return "empty";
				return false;
			},
			{ content: selector, empty: EMPTY_STATE },
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
					) ||
					/@[^/?#]+/.test(location.pathname),
				);
				const placeholderTitle =
					/^(?:loading\b|please wait\b|home$|youtube$|channel$)/i.test(
						title ?? "",
					);
				return title && !placeholderTitle && hasIdentity
					? true
					: false;
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
				const hasStatsInAbout = Boolean(about) && text.some(
					(value) => /subscriber|view|video/i.test(value) && /\d/.test(value),
				);
				const hasDescription = Boolean(
					aboutRoot
						.querySelector(
							"#description-container yt-formatted-string, #description yt-formatted-string, #description",
						)
						?.textContent?.trim(),
				);
				return hasJoinedDate || hasStatsInAbout || hasDescription ? "content" : false;
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
		message: "YouTube content did not appear before the page-read deadline.",
	});
}

async function visibleVideos(
	page: BrowserCollectContext["page"],
	url: string,
	rounds: number,
	mode: "playlist" | "history",
): Promise<BrowserVideo[]> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	const state = await waitForContent(
		page,
		mode === "history"
			? "ytd-item-section-renderer yt-lockup-view-model"
			: "yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer",
	);
	if (state === "unreadable")
		throw new Error(`youtube_${mode}_page_unreadable`);
	if (state === "empty") return [];
	const seen = new Set<string>();
	const out: BrowserVideo[] = [];
	for (let round = 0; round <= rounds; round += 1) {
		const batch = await page.evaluate(readVideos, mode);
		for (const video of batch) {
			const key = videoIdentity(video);
			if (!seen.has(key)) {
				seen.add(key);
				out.push(video);
			}
		}
		if (mode === "history" && out.length >= HISTORY_LIMIT) break;
		if (round < rounds) await scroll(page, 1);
	}
	return mode === "history" ? out.slice(0, HISTORY_LIMIT) : out;
}

async function readableVideos(
	ctx: BrowserContext,
	url: string,
	rounds: number,
	mode: "playlist" | "history",
	stream: string,
): Promise<BrowserVideo[] | null> {
	try {
		return await visibleVideos(ctx.page, url, rounds, mode);
	} catch {
		await skipUnreadable(ctx, stream, "page_unreadable");
		return null;
	}
}

type BrowserContext = Pick<
	BrowserCollectContext,
	"page" | "requested" | "emitRecord" | "emit" | "progress"
>;

/** Exported so fixture/protocol tests can run without launching a browser. */
export async function collectYoutubeBrowser(
	ctx: BrowserContext,
): Promise<void> {
	const { page, requested } = ctx;
	const capturedAt = new Date().toISOString();
	const coverage = async (
		stream: string,
		count: number,
		fieldsUnavailable: string[] = [],
	) => {
		if (!requested.has("coverage_diagnostics")) return;
		await ctx.emitRecord("coverage_diagnostics", {
			id: id(`${stream}|${capturedAt}`),
			stream,
			status: "partial",
			reason: "bounded_browser_snapshot",
			record_count: count,
			fields_unavailable: fieldsUnavailable,
			freshness: "live",
			captured_at: capturedAt,
		});
	};
	const emit = async (stream: string, record: Record<string, unknown>) => {
		await ctx.emitRecord(stream, record);
	};
	const missingVideoTitles = (videos: readonly BrowserVideo[]) =>
		videos.some((video) => !video.video_title) ? ["video_title"] : [];
	if (requested.has("profile")) {
		await page.goto(HOME, { waitUntil: "domcontentloaded" });
		const homeState = await waitForContent(
			page,
			"button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn",
		);
		if (homeState !== "content") {
			await skipUnreadable(ctx, "profile", "youtube_profile_home_not_ready");
		} else {
			let profileEmitted = false;
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
					await ctx.emit({
						type: "SKIP_RESULT",
						stream: "profile",
						reason: "youtube_profile_channel_link_unavailable",
						message:
							"The signed-in account header did not expose an own-channel link.",
					});
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
							profileEmitted = true;
						}
					}
				}
			}
			await coverage("profile", profileEmitted ? 1 : 0);
		}
	}
	if (requested.has("subscriptions")) {
		await page.goto(`${HOME}feed/channels`, { waitUntil: "domcontentloaded" });
		const state = await waitForContent(page, "ytd-channel-renderer");
		if (state === "unreadable")
			await skipUnreadable(ctx, "subscriptions", "page_unreadable");
		else {
			await scroll(page, SCROLLS.subscriptions);
			const subscriptions =
				state === "empty"
					? []
					: await page.evaluate(
							readSubscriptions as () => ReturnType<typeof readSubscriptions>,
						);
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
			await coverage(
				"subscriptions",
				subscriptions.length,
				subscriptions.some((channel) => channel.notifications === null)
					? ["notifications"]
					: [],
			);
		}
	}
	let playlistLinks: Array<{ id: string; url: string }> = [];
	let playlistIndexReadable = true;
	if (requested.has("playlists") || requested.has("playlist_items")) {
		await page.goto(`${HOME}feed/playlists`, { waitUntil: "domcontentloaded" });
		const state = await waitForContent(page, 'a[href*="playlist?list="]');
		if (state === "unreadable") {
			playlistIndexReadable = false;
			for (const stream of ["playlists", "playlist_items"])
				if (requested.has(stream))
					await skipUnreadable(ctx, stream, "page_unreadable");
		} else if (state === "content") {
			await scroll(page, SCROLLS.playlists);
			playlistLinks = await page.evaluate(
				readPlaylistLinks as () => ReturnType<typeof readPlaylistLinks>,
			);
		}
	}
	if (
		playlistIndexReadable &&
		(requested.has("playlists") || requested.has("playlist_items"))
	) {
		let playlistCount = 0;
		let itemCount = 0;
		let itemTitlesMissing = false;
		for (const playlist of playlistLinks) {
			await page.goto(playlist.url, { waitUntil: "domcontentloaded" });
			if (
				(await waitForContent(
					page,
					"yt-dynamic-text-view-model h1 span, .yt-page-header-view-model__page-header-title h1 span, h1#title, h1 yt-formatted-string",
				)) !== "content"
			) {
				for (const stream of ["playlists", "playlist_items"])
					if (requested.has(stream))
						await skipUnreadable(ctx, stream, "page_unreadable");
				continue;
			}
			const header = await page.evaluate(
				readPlaylistHeader as () => ReturnType<typeof readPlaylistHeader>,
			);
			if (requested.has("playlists")) {
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
				playlistCount += 1;
			}
			if (requested.has("playlist_items")) {
				const videos = await readableVideos(
					ctx,
					playlist.url,
					SCROLLS.playlist_items,
					"playlist",
					"playlist_items",
				);
				if (videos) {
					itemTitlesMissing ||= missingVideoTitles(videos).length > 0;
					for (const video of videos) {
						await emit("playlist_items", {
							id: id(`playlist_item|${playlist.id}|${videoIdentity(video)}`),
							playlist_id: playlist.id,
							...videoFields(video),
						});
						itemCount += 1;
					}
				}
			}
		}
		if (requested.has("playlists")) await coverage("playlists", playlistCount);
		if (requested.has("playlist_items"))
			await coverage(
				"playlist_items",
				itemCount,
				itemTitlesMissing ? ["video_title"] : [],
			);
	}
	for (const [stream, list] of [
		["likes", "LL"],
		["watch_later", "WL"],
	] as const) {
		if (!requested.has(stream)) continue;
		const videos = await readableVideos(
			ctx,
			`${HOME}playlist?list=${list}`,
			SCROLLS.playlist_items,
			"playlist",
			stream,
		);
		if (!videos) continue;
		for (const video of videos)
			await emit(stream, {
				id: id(`${stream}|${videoIdentity(video)}`),
				...videoFields(video),
			});
		await coverage(stream, videos.length, missingVideoTitles(videos));
	}
	if (requested.has("watch_history")) {
		const videos = await readableVideos(
			ctx,
			`${HOME}feed/history`,
			SCROLLS.history,
			"history",
			"watch_history",
		);
		if (videos) {
			const browserDate = await page.evaluate(() => {
				const now = new Date();
				return [now.getFullYear(), now.getMonth(), now.getDate()];
			});
			const dateReference =
				Array.isArray(browserDate) && browserDate.length === 3
					? new Date(browserDate[0]!, browserDate[1]!, browserDate[2]!, 12)
					: new Date(capturedAt);
			for (const [position, video] of videos.entries()) {
				const watchedDate = resolveWatchedDate(
					video.watched_date_label ?? null,
					dateReference,
				);
				if (!watchedDate && requested.get("watch_history")?.time_range)
					continue;
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
			await coverage("watch_history", videos.length, [
				"watch_time_of_day",
				...missingVideoTitles(videos),
			]);
		}
	}
}

export const youtubeConnectorConfig = {
	name: "youtube",
	validateRecord,
	timeRangeField: (stream) =>
		stream === "watch_history" ? "watched_date" : "date",
	browser: { profileName: "youtube" },
	ensureSession: ensureYoutubeSession,
	probeSession: async ({ page }) => probeYoutubeSession(page),
	probeSessionIsAuthoritative: true,
	collect: collectYoutubeBrowser,
} satisfies Parameters<typeof runConnector>[0];

if (isMainModule(import.meta.url)) {
	runConnector(youtubeConnectorConfig);
}
