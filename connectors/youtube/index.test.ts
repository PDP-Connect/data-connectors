// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	collectYoutubeBrowser,
	readPageReadiness,
	resolveWatchedDate,
	setHistoryLoopCallDeadlineMsForTest,
	HistoryRunProgress,
	raceNoProgress,
	setHistoryExpirySinkDeadlineMsForTest,
	setHistoryOuterDeadlineMsForTest,
} from "./index.ts";
import { readSubscriptions } from "./browser-dom.ts";
import { enumerationEnded, readListEnd } from "./page-evidence.ts";
import { validateRecord } from "./schemas.ts";

const VIDEO = {
	video_id: "abc123XYZ0",
	video_url: "https://www.youtube.com/watch?v=abc123XYZ0",
	video_title: "Real video title",
	channel_title: "Creator",
	channel_url: "https://www.youtube.com/@creator",
	duration_text: "4:30",
	thumbnail_url: "https://i.ytimg.com/vi/abc123XYZ0/default.jpg",
	watched_date_label: "Yesterday",
	views_text: "1.2K views",
	description: "Snippet",
};
const VIDEO_HISTORY_KEY = (videoId: string) =>
	`${videoId}|${resolveWatchedDate(VIDEO.watched_date_label, new Date())}`;

function withBrowserGlobals(
	html: string,
	run: () => void,
	url = "https://www.youtube.com/",
): void {
	const { document, window } = parseHTML(html);
	Object.defineProperty(window, "location", {
		configurable: true,
		value: new URL(url),
	});
	const globals = globalThis as typeof globalThis & {
		document?: Document;
		window?: Window;
	};
	const previousDocument = globals.document;
	const previousWindow = globals.window;
	globals.document = document as unknown as Document;
	globals.window = window as unknown as Window & typeof globalThis;
	try {
		run();
	} finally {
		globals.document = previousDocument;
		globals.window = previousWindow;
	}
}

/** Mirrors the runtime's reportStreamFailure: one stream_collection_failed SKIP_RESULT. */
/** History failures also carry diagnostics; their content has its own test. */
function withoutDiagnostics(options: unknown): unknown {
	const { diagnostics: _diagnostics, ...rest } = (options ?? {}) as Record<string, unknown>;
	return rest;
}

function failureReporter(messages: Record<string, unknown>[]) {
	return async (
		stream: string,
		message: string,
		options?: { diagnostics?: Record<string, unknown> },
	) => {
		messages.push({
			type: "SKIP_RESULT",
			stream,
			reason: "stream_collection_failed",
			message,
			...(options?.diagnostics ? { diagnostics: options.diagnostics } : {}),
		});
	};
}

class FixturePage {
	url = "";
	private readonly responseListeners = new Set<(response: never) => void>();
	private readonly waitStates: Array<
		"content" | "empty" | "json-empty" | "unreadable"
	>;
	private lastWaitState: "content" | "empty" | "json-empty" = "content";
	on(event: string, listener: (response: never) => void): this {
		if (event === "response") this.responseListeners.add(listener);
		return this;
	}
	off(event: string, listener: (response: never) => void): this {
		if (event === "response") this.responseListeners.delete(listener);
		return this;
	}
	private readonly ownAccount: {
		channel_url: string | null;
		email: string | null;
	};
	constructor(
		waitStates: Array<"content" | "empty" | "json-empty" | "unreadable"> = [],
		ownAccount: { channel_url: string | null; email: string | null } = {
			channel_url: "https://www.youtube.com/@owner",
			email: "owner@example.com",
		},
	) {
		this.waitStates = waitStates;
		this.ownAccount = ownAccount;
	}
	async goto(url: string) {
		this.url = url;
	}
	locator() {
		return {
			first: () => ({ click: async () => undefined }),
			count: async () => 0,
		};
	}
	async waitForTimeout() {
		/* fixture has no renderer delay */
	}
	async waitForFunction() {
		const state = this.waitStates.shift() ?? "content";
		if (state === "unreadable") throw new Error("fixture page read timed out");
		this.lastWaitState = state;
		if (state === "json-empty")
			return { jsonValue: async () => "empty", dispose: async () => undefined };
		return { jsonValue: async () => state, dispose: async () => undefined };
	}
	async evaluate(fn: Function, arg?: unknown): Promise<unknown> {
		if (fn.name === "hasYoutubeSessionOnCurrentPage") return true;
		if (
			fn.name === "readListEnd" ||
			(typeof arg === "object" && arg !== null && "kind" in arg)
		) {
			const empty =
				this.lastWaitState === "empty" || this.lastWaitState === "json-empty";
			const kind =
				typeof arg === "object" && arg !== null && "kind" in arg
					? (arg as { kind: string }).kind
					: "";
			const readable = !empty && kind !== "history";
			const request =
				typeof arg === "object" && arg !== null
					? (arg as { latestHistoryResponse?: unknown })
					: {};
			return {
				dataReadable: readable,
				dataItemCount: readable ? 1 : 0,
				dataHasContinuation: !empty,
				domHasContinuation: false,
				declaredTotal: null,
				domItemCount: null,
				domHasEndMarker: false,
				verifiedEmpty: empty,
				pageBlocked: false,
				latestHistoryResponse: request.latestHistoryResponse ?? null,
			};
		}
		if (fn.name === "readOwnAccount") return this.ownAccount;
		if (fn.name === "readChannelPage")
			return {
				channel_id: "UCowner",
				channel_url: this.url,
				title: "Owner",
				handle: "@owner",
				avatar_url: null,
			};
		if (fn.name === "readSubscriptions")
			return [
				{
					channel_url: "https://www.youtube.com/@creator",
					channel_id: null,
					channel_title: "Creator",
					handle: "@creator",
					avatar_url: null,
					description: null,
					subscriber_count_text: "1.2K subscribers",
					is_verified: true,
					notifications: true,
				},
			];
		if (fn.name === "readPlaylistLinks")
			return [{ id: "PL1", url: "https://www.youtube.com/playlist?list=PL1" }];
		if (fn.name === "readPlaylistHeader")
			return {
				title: "My list",
				owner: "Owner",
				owner_url: "https://www.youtube.com/@owner",
				visibility: "Public",
				video_count_text: "1 video",
				view_count_text: "No views",
			};
		if (
			fn.name === "readVideos" ||
			arg === "playlist" ||
			arg === "history" ||
			(typeof arg === "object" && arg !== null && "offset" in arg)
		) {
			if (typeof arg === "object" && arg !== null && "offset" in arg) {
				const request = arg as { offset: number; limit: number };
				if (
					this.lastWaitState === "empty" ||
					this.lastWaitState === "json-empty"
				)
					return { offset: request.offset, totalRows: 0, rows: [] };
				return {
					offset: request.offset,
					totalRows: 1,
					rows: request.offset === 0 ? [{ ...VIDEO }] : [],
				};
			}
			return [{ ...VIDEO }];
		}
		return undefined;
	}
}

function historyFixturePage(
	videos: Record<string, unknown>[],
	end: Partial<{
		dataReadable: boolean;
		dataItemCount: number;
		dataHasContinuation: boolean;
		domHasContinuation: boolean;
		declaredTotal: number | null;
		domItemCount: number | null;
		domHasEndMarker: boolean;
		verifiedEmpty: boolean;
		pageBlocked: boolean;
	}> = {},
): FixturePage {
	const page = new FixturePage();
	page.evaluate = async (fn: Function, arg?: unknown) => {
		if (
			fn.name === "readVideos" ||
			(typeof arg === "object" && arg !== null && "offset" in arg)
		) {
			if (typeof arg === "object" && arg !== null && "offset" in arg) {
				const request = arg as { offset: number; limit: number };
				return {
					offset: request.offset,
					totalRows: videos.length,
					rows: videos.slice(request.offset, request.offset + request.limit),
				};
			}
			return videos;
		}
		if (
			fn.name === "readListEnd" ||
			(typeof arg === "object" && arg !== null && "kind" in arg)
		)
			return {
				dataReadable: true,
				dataItemCount: videos.length,
				dataHasContinuation: false,
				domHasContinuation: false,
				declaredTotal: null,
				domItemCount: videos.length,
				domHasEndMarker: false,
				verifiedEmpty: false,
				pageBlocked: false,
				latestHistoryResponse:
					typeof arg === "object" &&
					arg !== null &&
					"latestHistoryResponse" in arg
						? (arg as { latestHistoryResponse: unknown }).latestHistoryResponse
						: null,
				...end,
			};
		return undefined;
	};
	return page;
}

test("subscriptions emit optional raw count text from channel renderers", async () => {
	const html = readFileSync(
		new URL("./__fixtures__/subscriptions-subscriber-count.html", import.meta.url),
		"utf8",
	);
	const { document } = parseHTML(html);
	const subscriptions = readSubscriptions(document as unknown as Document);
	const page = new FixturePage();
	const evaluate = page.evaluate.bind(page);
	page.evaluate = async (fn: Function, arg?: unknown) =>
		fn.name === "readSubscriptions" ? subscriptions : evaluate(fn, arg);
	const records: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map([["subscriptions", { name: "subscriptions" }]]) as never,
		emitRecord: async (_stream, data) => {
			records.push(data);
		},
		emit: async () => undefined,
		reportStreamFailure: async () => undefined,
		progress: async () => undefined,
	});
	assert.equal(records.length, 4);
	assert.equal(records[0]?.subscriber_count_text, "1.2M subscribers");
	assert.equal(records[0]?.subscriber_count, 1_200_000);
	assert.equal(records[3]?.subscriber_count_text, "1,2 M d’abonnés");
	for (const record of records.slice(1, 3)) {
		assert.equal(Object.hasOwn(record, "subscriber_count_text"), false);
		assert.equal(record.subscriber_count, null);
	}
	for (const record of records) {
		assert.equal(validateRecord("subscriptions", record).ok, true);
		const withoutCountText = { ...record };
		delete withoutCountText.subscriber_count_text;
		assert.equal(validateRecord("subscriptions", withoutCountText).ok, true);
	}
});

test("subscription and playlist parsers enumerate beyond legacy caps", async () => {
	const { readPlaylistLinks } = await import("./browser-dom.ts");
	const subscriptions = Array.from({ length: 21 }, (_, index) =>
		`<ytd-channel-renderer><ytd-channel-name><yt-formatted-string id="text">Channel ${index}</yt-formatted-string></ytd-channel-name><a id="main-link" href="/@channel${index}"></a></ytd-channel-renderer>`,
	).join("");
	const playlists = Array.from({ length: 51 }, (_, index) =>
		`<a href="/playlist?list=PL${index + 1}">Playlist ${index + 1}</a>`,
	).join("");
	withBrowserGlobals(subscriptions + playlists, () => {
		assert.equal(readSubscriptions().length, 21);
		const found = readPlaylistLinks();
		assert.equal(found.length, 51);
		assert.equal(found[50]?.id, "PL51");
	});
});

test("profile skips report a redacted branch code for each unreadable page", async () => {
	const scenarios = [
		{
			name: "home page is not ready",
			page: new FixturePage(["empty"]),
			reason: "youtube_profile_home_not_ready",
		},
		{
			name: "account menu has no channel link",
			page: new FixturePage(["content", "content"], {
				channel_url: null,
				email: null,
			}),
			reason: "youtube_profile_channel_link_unavailable",
		},
		{
			name: "account header is empty",
			page: new FixturePage(["content", "empty"]),
			reason: "youtube_profile_account_header_unreadable",
		},
		{
			name: "account header is unreadable",
			page: new FixturePage(["content", "unreadable"]),
			reason: "youtube_profile_account_header_unreadable",
		},
		{
			name: "channel page identity is unreadable",
			page: new FixturePage(["content", "content", "unreadable"]),
			reason: "youtube_profile_channel_page_unreadable",
		},
		{
			name: "channel About page is unreadable",
			page: new FixturePage(["content", "content", "content", "unreadable"]),
			reason: "youtube_profile_about_page_unreadable",
		},
	];

	for (const scenario of scenarios) {
		const skips: Array<Record<string, unknown>> = [];
		await collectYoutubeBrowser({
			page: scenario.page as never,
			requested: new Map([["profile", { name: "profile" }]]) as never,
			emitRecord: async () => undefined,
			emit: async (event) => {
				skips.push(event as Record<string, unknown>);
			},
			progress: async () => undefined,
		});

		assert.equal(skips.length, 1, scenario.name);
		assert.equal(skips[0]?.type, "SKIP_RESULT", scenario.name);
		assert.equal(skips[0]?.reason, scenario.reason, scenario.name);
		assert.doesNotMatch(
			JSON.stringify(skips[0]),
			/youtube\.com|owner@example\.com/,
		);
	}
});

test("profile account-header skips do not suppress later requested streams", async () => {
	const skips: Array<Record<string, unknown>> = [];
	const records = new Map<string, Record<string, unknown>[]>();
	await collectYoutubeBrowser({
		page: new FixturePage(["content", "empty"]) as never,
		requested: new Map(
			["profile", "subscriptions", "watch_history"].map((name) => [
				name,
				{ name },
			]),
		) as never,
		emitRecord: async (stream, data) => {
			records.set(stream, [...(records.get(stream) ?? []), data]);
		},
		emit: async (event) => {
			skips.push(event as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(skips),
		progress: async () => undefined,
	});

	assert.equal(skips.length, 4);
	assert.equal(skips[0]?.reason, "youtube_profile_account_header_unreadable");
	assert.ok(
		skips.slice(1).some((skip) => skip.reason === "stream_collection_failed"),
	);
	assert.equal(
		skips.some((skip) => skip.type === "STATE"),
		true,
	);
	assert.equal(records.get("subscriptions")?.length, 1);
	assert.equal(records.get("watch_history")?.length, 1);
});

test("profile emits an email-only record when the account has no channel link", async () => {
	const skips: Array<Record<string, unknown>> = [];
	const records: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: new FixturePage(["content", "content"], {
			channel_url: null,
			email: "owner@example.com",
		}) as never,
		requested: new Map([["profile", { name: "profile" }]]) as never,
		emitRecord: async (stream, data) => {
			assert.equal(stream, "profile");
			assert.equal(validateRecord(stream, data).ok, true);
			records.push(data);
		},
		emit: async (event) => {
			skips.push(event as Record<string, unknown>);
		},
		progress: async () => undefined,
	});

	assert.equal(skips.length, 0);
	assert.deepEqual(records, [
		{
			id: "owner@example.com",
			channel_id: null,
			channel_url: null,
			title: null,
			handle: null,
			email: "owner@example.com",
			joined_at: null,
			avatar_url: null,
			description: null,
			country: null,
			subscriber_count: null,
			view_count: null,
			video_count: null,
		},
	]);
});

test("date resolver keeps day precision and rejects unknown labels", () => {
	const now = new Date(2026, 8, 23, 12);
	assert.equal(resolveWatchedDate("Today", now), "2026-09-23");
	assert.equal(resolveWatchedDate("Yesterday", now), "2026-09-22");
	assert.equal(resolveWatchedDate("Sep 21, 2026", now), "2026-09-21");
	assert.equal(resolveWatchedDate("Feb 30, 2026", now), null);
	assert.equal(resolveWatchedDate("Unknown", now), null);
});

test("history streams beyond one batch and checkpoints its accounted prefix", async () => {
	const page = historyFixturePage(
		Array.from({ length: 60 }, (_, i) => ({
			...VIDEO,
			video_id: `video${i}`,
			video_url: `https://www.youtube.com/watch?v=video${i}`,
		})),
		{},
	);
	const history: Record<string, unknown>[] = [];
	const messages: Record<string, unknown>[] = [];
	const progress: string[] = [];
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
	try {
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([
				["watch_history", { name: "watch_history" }],
			]) as never,
			emitRecord: async (_stream, data) => {
				history.push(data);
			},
			emit: async (message) => {
				messages.push(message as Record<string, unknown>);
			},
			reportStreamFailure: async () => undefined,
			progress: async (message) => {
				progress.push(message);
			},
		});
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	assert.equal(history.length, 60);
	assert.equal(history[0]?.video_id, "video0");
	assert.equal(history[59]?.video_id, "video59");
	assert.equal(history[59]?.position, 59);
	assert.equal("watched_at" in history[0]!, false);
	assert.deepEqual(
		messages
			.filter((message) => message.type === "STATE")
			.map((message) => message.cursor),
		[
			{
				version: 2,
				scope: "watch_history",
				phase: "head_reconciliation",
				backfill_anchor_id: VIDEO_HISTORY_KEY("video59"),
				position: 59,
				head_anchor_ids: ["video0", "video1", "video2"].map(VIDEO_HISTORY_KEY),
				complete: true,
				stop_reason: "source-end",
				evidence: "readable-data",
			},
		],
	);

	const prefix = "[youtube-diagnostic] coverage ";
	const coverageLines = diagnostics.filter((line) => line.startsWith(prefix));
	assert.equal(coverageLines.length, 1);
	const coverage = JSON.parse(coverageLines[0]!.slice(prefix.length));
	assert.match(coverage.next_checkpoint, /^[a-f0-9]{24}$/);
	delete coverage.next_checkpoint;
	assert.deepEqual(coverage, {
		stream: "watch_history",
		requested: true,
		source: "browser",
		emitted_count: 60,
		time_range_requested: false,
		enumerated_count: 60,
		parsed_count: 60,
		deduped_count: 0,
		stop_reason: "source-end",
		incomplete: false,
		unresolved_date_count: 0,
	});
	assert.doesNotMatch(
		diagnostics.join("\n"),
		/Real video title|Creator|youtube\.com|abc123XYZ0/,
	);
	assert.deepEqual(progress, ["Finished YouTube: 60 items saved"]);
	assertUserFacingProgress(
		progress.map((message) => ({ type: "PROGRESS", message })),
	);
});

test("history resumes after the last seen video checkpoint", async () => {
	const videos = Array.from({ length: 110 }, (_, i) => ({
		...VIDEO,
		video_id: `video${i}`,
		video_url: `https://www.youtube.com/watch?v=video${i}`,
	}));
	const run = async (state: Record<string, unknown> = {}) => {
		const records: Record<string, unknown>[] = [];
		const messages: Record<string, unknown>[] = [];
		const failures: string[] = [];
		await collectYoutubeBrowser({
			page: historyFixturePage(videos) as never,
			requested: new Map([
				["watch_history", { name: "watch_history" }],
			]) as never,
			state,
			emitRecord: async (_stream, data) => {
				records.push(data);
			},
			emit: async (message) => {
				messages.push(message as Record<string, unknown>);
			},
			reportStreamFailure: async (_stream, message) => {
				failures.push(message);
			},
			progress: async () => undefined,
		});
		return { records, messages, failures };
	};

	const first = await run();
	const firstState = first.messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.deepEqual(first.failures, []);
	assert.deepEqual(
		first.records.map((record) => record.video_id),
		Array.from({ length: 110 }, (_, i) => `video${i}`),
	);
	assert.equal(firstState.backfill_anchor_id, VIDEO_HISTORY_KEY("video109"));
	assert.equal(firstState.complete, true);

	const second = await run({ watch_history: firstState });
	const secondState = second.messages.find(
		(message) => message.type === "STATE",
	)?.cursor as Record<string, unknown>;
	assert.deepEqual(second.failures, []);
	assert.deepEqual(
		second.records.map((record) => record.video_id),
		Array.from({ length: 110 }, (_, i) => `video${i}`),
	);
	assert.equal(secondState.backfill_anchor_id, VIDEO_HISTORY_KEY("video109"));
	assert.equal(secondState.position, 109);
	assert.equal(secondState.complete, true);
});

test("history checkpoints an accounted prefix but reports a pending continuation", async () => {
	const videos = Array.from({ length: 41 }, (_, i) => ({
		...VIDEO,
		video_id: `video${i}`,
		video_url: `https://www.youtube.com/watch?v=video${i}`,
	}));
	const messages: Record<string, unknown>[] = [];
	const failures: string[] = [];
	await collectYoutubeBrowser({
		page: historyFixturePage(videos, {
			dataHasContinuation: true,
			domHasContinuation: true,
		}) as never,
		requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
		state: {
			watch_history: { last_seen_video_id: "video9", position: 9 },
		},
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: async (_stream, message) => {
			failures.push(message);
		},
		progress: async () => undefined,
	});

	const checkpoint = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(failures.length, 1);
	assert.equal(checkpoint.backfill_anchor_id, VIDEO_HISTORY_KEY("video40"));
	assert.equal(checkpoint.position, 40);
	assert.equal(checkpoint.complete, false);
	assert.equal(checkpoint.evidence, "youtube_history_safe_prefix_before_gap");
});

test("history no-progress after a checkpoint reports a gap and does not checkpoint", async () => {
	const videos = Array.from({ length: 50 }, (_, i) => ({
		...VIDEO,
		video_id: `video${i}`,
		video_url: `https://www.youtube.com/watch?v=video${i}`,
	}));
	const messages: Record<string, unknown>[] = [];
	const failures: string[] = [];
	const records: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: historyFixturePage(videos, {
			dataHasContinuation: true,
			domHasContinuation: true,
		}) as never,
		requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
		state: {
			watch_history: { last_seen_video_id: "video49", position: 49 },
		},
		emitRecord: async (_stream, data) => {
			records.push(data);
		},
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: async (_stream, message) => {
			failures.push(message);
		},
		progress: async () => undefined,
	});

	assert.equal(failures.length, 1);
	assert.equal(records.length, 50);
	const safePrefix = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(safePrefix?.complete, false);
});

test("history source-end evidence completes the checkpoint", async () => {
	const videos = Array.from({ length: 3 }, (_, i) => ({
		...VIDEO,
		video_id: `video${i}`,
		video_url: `https://www.youtube.com/watch?v=video${i}`,
	}));
	const messages: Record<string, unknown>[] = [];
	const failures: string[] = [];
	await collectYoutubeBrowser({
		page: historyFixturePage(videos) as never,
		requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: async (_stream, message) => {
			failures.push(message);
		},
		progress: async () => undefined,
	});

	assert.deepEqual(failures, []);
	const state = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(state.backfill_anchor_id, VIDEO_HISTORY_KEY("video2"));
	assert.equal(state.position, 2);
	assert.equal(state.complete, true);
	assert.equal(state.evidence, "readable-data");
});

test("a blocked history page vetoes completion and emits no checkpoint", async () => {
	const { messages, outcome } = await collectFromDocuments(
		() =>
			`${SIGNED_IN}<a href="https://accounts.google.com/ServiceLogin">Sign in</a>${historyRow}${END_OF_LIST}`,
		["watch_history"],
	);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("history reconciliation emits a re-watched row beyond the head window", async () => {
	const firstOrder = Array.from({ length: 90 }, (_, index) => `v${index}`);
	const insertedHead = Array.from({ length: 151 }, (_, index) => `new${index}`);
	const cursor = {
		last_seen_video_id: "v49",
		position: 49,
		complete: false,
	};
	const movedOrder = [
		...insertedHead.slice(0, 150),
		"v70",
		insertedHead[150]!,
		...firstOrder.filter((id) => id !== "v70"),
	];
	const rows = movedOrder
		.map(
			(id) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>${id}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const sourceItems = movedOrder.map((contentId) => ({
		lockupViewModel: { contentId },
	}));
	const { records, messages } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${resolvedHistoryHeader}${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: sourceItems } }))}${END_OF_LIST}`,
		["watch_history"],
		undefined,
		{ watch_history: cursor },
	);

	assert.equal(
		records.get("watch_history")?.some((record) => record.video_id === "v70"),
		true,
	);
	const state = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(state?.complete, true);
});

test("history anchor re-watch is reconciled instead of skipped", async () => {
	const order = [
		"v49",
		...Array.from({ length: 90 }, (_, index) => `v${index}`).filter(
			(id) => id !== "v49",
		),
	];
	const rows = order
		.map(
			(id) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>${id}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const sourceItems = order.map((contentId) => ({
		lockupViewModel: { contentId },
	}));
	const { records } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: sourceItems } }))}${END_OF_LIST}`,
		["watch_history"],
		undefined,
		{
			watch_history: {
				last_seen_video_id: "v49",
				position: 49,
				complete: false,
			},
		},
	);

	assert.equal(
		records.get("watch_history")?.some((record) => record.video_id === "v49"),
		true,
	);
});

test("a normal target-list continuation is not a blocked page", () => {
	const rows = Array.from(
		{ length: 55 },
		(_, index) =>
			`<yt-lockup-view-model><a href="/watch?v=v${index}"></a></yt-lockup-view-model>`,
	).join("");
	const sourceItems = Array.from({ length: 55 }, (_, index) => ({
		lockupViewModel: { contentId: `v${index}` },
	}));
	const continuationItem = {
		continuationItemRenderer: {
			continuationEndpoint: { continuationCommand: { token: "next" } },
		},
	};
	const html = `${SIGNED_IN}<ytd-item-section-renderer>${rows}<ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...sourceItems, continuationItem] } }))}`;
	let end: ReturnType<typeof readListEnd> | undefined;
	withBrowserGlobals(
		html,
		() => {
			end = readListEnd({ kind: "history", sessionPresent: true });
		},
		"https://www.youtube.com/feed/history",
	);

	assert.equal(end?.domHasContinuation, true);
	assert.equal(end?.pageBlocked, false);
});

test("a real continuation permits a safe incomplete checkpoint", async () => {
	const rows = Array.from(
		{ length: 55 },
		(_, index) =>
			`<yt-lockup-view-model><a href="/watch?v=cont${index}"></a><h3>cont${index}</h3></yt-lockup-view-model>`,
	).join("");
	const sourceItems = Array.from({ length: 55 }, (_, index) => ({
		lockupViewModel: { contentId: `cont${index}` },
	}));
	const { records, messages, outcome } = await collectFromDocuments(
		() =>
			`${SIGNED_IN}<ytd-item-section-renderer>${rows}<ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...sourceItems, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 55);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
	const state = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(state.complete, false);
});

test("a parsed suffix cannot checkpoint across a malformed history card", async () => {
	const now = new Date();
	const collectionDate = [
		String(now.getFullYear()),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	const rows = Array.from({ length: 10 }, (_, index) =>
		index === 5
			? `<yt-lockup-view-model><h3>hydrating</h3></yt-lockup-view-model>`
			: `<yt-lockup-view-model><a href="/watch?v=v${index}"></a><h3>v${index}</h3></yt-lockup-view-model>`,
	).join("");
	const sourceItems = Array.from({ length: 10 }, (_, index) => ({
		lockupViewModel: { contentId: `v${index}` },
	}));
	const { messages } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: sourceItems } }))}`,
		["watch_history"],
		undefined,
		{
			watch_history: { last_seen_video_id: "v2", position: 2, complete: false },
		},
	);

	const state = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(state?.complete, false);
	assert.equal(
		state?.backfill_anchor_id,
		`v4|unresolved:${collectionDate}:unknown-section`,
	);
	assert.equal(
		messages.some((message) => message.reason === "stream_collection_failed"),
		true,
	);
});

test("a complete HTML bootstrap ends a resumed cursor with no unread suffix", async () => {
	const rows = Array.from(
		{ length: 3 },
		(_, index) =>
			`<yt-lockup-view-model><a href="/watch?v=v${index}"></a></yt-lockup-view-model>`,
	).join("");
	const { records, messages } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer><ytd-item-section-header-renderer><div id="header"><div id="title">Today</div></div></ytd-item-section-header-renderer>${rows}</ytd-item-section-renderer>${historyBootstrap(["v0", "v1", "v2"])}`,
		["watch_history"],
		undefined,
		{
			watch_history: { last_seen_video_id: "v2", position: 2, complete: false },
		},
	);

	const state = messages.find((message) => message.type === "STATE")
		?.cursor as Record<string, unknown>;
	assert.equal(
		records
			.get("watch_history")
			?.some(
				(record) => typeof record.position === "number" && record.position > 2,
			),
		false,
	);
	assert.equal(state?.complete, true);
});

test("a repeated bootstrap continuation reports a gap and never completes", async () => {
	const ids = ["aaaaaaaaaaa"];
	const { messages, outcome } = await collectFromDocuments(
		() => `${historyCards(ids)}${historyBootstrap(ids, "bootstrap-C")}`,
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: "bootstrap-C" },
			],
		},
	);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		false,
	);
});

test("history preserves the same video when its watch date differs", async () => {
	const page = new FixturePage();
	page.evaluate = async (fn: Function, arg?: unknown) => {
		if (fn.name === "hasYoutubeSessionOnCurrentPage") return true;
		if (
			fn.name === "readVideos" ||
			(typeof arg === "object" && arg !== null && "offset" in arg)
		) {
			const request = arg as { offset: number; limit: number };
			return {
				offset: request.offset,
				totalRows: 2,
				rows: [
					{ ...VIDEO, watched_date_label: "Today" },
					{ ...VIDEO, watched_date_label: "Yesterday" },
				].slice(request.offset, request.offset + request.limit),
			};
		}
		if (
			fn.name === "readListEnd" ||
			(typeof arg === "object" && arg !== null && "kind" in arg)
		)
			return {
				dataReadable: true,
				dataItemCount: 2,
				dataHasContinuation: false,
				domHasContinuation: false,
				declaredTotal: 2,
				domItemCount: 2,
				domHasEndMarker: true,
				verifiedEmpty: false,
				pageBlocked: false,
				latestHistoryResponse:
					typeof arg === "object" &&
					arg !== null &&
					"latestHistoryResponse" in arg
						? (arg as { latestHistoryResponse: unknown }).latestHistoryResponse
						: null,
			};
		return undefined;
	};
	const history: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
		emitRecord: async (_stream, data) => {
			history.push(data);
		},
		emit: async () => undefined,
		reportStreamFailure: async () => undefined,
		progress: async () => undefined,
	});
	assert.equal(history.length, 2);
	assert.deepEqual(history.map((record) => record.watched_date_label), ["Today", "Yesterday"]);
	assert.notEqual(history[0]?.id, history[1]?.id);
});

test("unresolved localized history dates keep section rows distinct and incomplete", async () => {
	const page = new FixturePage();
	page.evaluate = async (fn: Function, arg?: unknown) => {
		if (fn.name === "hasYoutubeSessionOnCurrentPage") return true;
		if (fn.name === "readVideos" || (typeof arg === "object" && arg !== null && "offset" in arg)) {
			const request = arg as { offset: number; limit: number };
			return {
				offset: request.offset,
				totalRows: 2,
				rows: [
					{ ...VIDEO, watched_date_label: "Heute" },
					{ ...VIDEO, watched_date_label: "Gestern" },
				].slice(request.offset, request.offset + request.limit),
			};
		}
		if (fn.name === "readListEnd" || (typeof arg === "object" && arg !== null && "kind" in arg))
			return {
				dataReadable: true,
				dataItemCount: 2,
				dataHasContinuation: false,
				domHasContinuation: false,
				declaredTotal: 2,
				domItemCount: 2,
				domHasEndMarker: true,
				verifiedEmpty: false,
				pageBlocked: false,
				latestHistoryResponse: null,
			};
		return undefined;
	};
	const history: Record<string, unknown>[] = [];
	const messages: Record<string, unknown>[] = [];
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
	try {
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
			emitRecord: async (_stream, data) => { history.push(data); },
			emit: async (message) => { messages.push(message as Record<string, unknown>); },
			reportStreamFailure: async () => undefined,
			progress: async () => undefined,
		});
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	assert.equal(history.length, 2);
	assert.notEqual(history[0]?.id, history[1]?.id);
	assert.deepEqual(history.map((record) => record.watched_date), [null, null]);
	assert.equal((messages.find((message) => message.type === "STATE")?.cursor as Record<string, unknown>)?.complete, false);
	const coverage = diagnostics.find((line) => line.startsWith("[youtube-diagnostic] coverage "));
	assert.ok(coverage);
	assert.equal(
		JSON.parse(coverage.slice("[youtube-diagnostic] coverage ".length))
			.unresolved_date_count,
		2,
	);
});

test("unresolved relative history labels use the collection date in record identity", async () => {
	const collectId = async (browserDate: [number, number, number]) => {
		const page = new FixturePage();
		page.evaluate = async (fn: Function, arg?: unknown) => {
			if (fn.name === "hasYoutubeSessionOnCurrentPage") return true;
			if (fn.name === "readBrowserDate") return browserDate;
			if (
				fn.name === "readVideos" ||
				(typeof arg === "object" && arg !== null && "offset" in arg)
			) {
				const request = arg as { offset: number; limit: number };
				return {
					offset: request.offset,
					totalRows: 1,
					rows: [{ ...VIDEO, watched_date_label: "Heute" }].slice(
						request.offset,
						request.offset + request.limit,
					),
				};
			}
			if (
				fn.name === "readListEnd" ||
				(typeof arg === "object" && arg !== null && "kind" in arg)
			)
				return {
					dataReadable: true,
					dataItemCount: 1,
					dataHasContinuation: false,
					domHasContinuation: false,
					declaredTotal: 1,
					domItemCount: 1,
					domHasEndMarker: true,
					verifiedEmpty: false,
					pageBlocked: false,
					latestHistoryResponse: null,
				};
			return undefined;
		};
		const history: Record<string, unknown>[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([[
				"watch_history",
				{ name: "watch_history" },
			]]) as never,
			emitRecord: async (_stream, data) => {
				history.push(data);
			},
			emit: async () => undefined,
			reportStreamFailure: async () => undefined,
			progress: async () => undefined,
		});
		return history[0]?.id;
	};

	const firstVisit = await collectId([2026, 8, 23]);
	const laterVisit = await collectId([2026, 8, 24]);
	assert.ok(firstVisit);
	assert.ok(laterVisit);
	assert.notEqual(firstVisit, laterVisit);
});

test("resolved history dates keep the same record identity across runs", async () => {
	const collectRecord = async (browserDate: [number, number, number]) => {
		const page = new FixturePage();
		page.evaluate = async (fn: Function, arg?: unknown) => {
			if (fn.name === "hasYoutubeSessionOnCurrentPage") return true;
			if (fn.name === "readBrowserDate") return browserDate;
			if (
				fn.name === "readVideos" ||
				(typeof arg === "object" && arg !== null && "offset" in arg)
			) {
				const request = arg as { offset: number; limit: number };
				return {
					offset: request.offset,
					totalRows: 1,
					rows: [{ ...VIDEO, watched_date_label: "Sep 21, 2026" }].slice(
						request.offset,
						request.offset + request.limit,
					),
				};
			}
			if (
				fn.name === "readListEnd" ||
				(typeof arg === "object" && arg !== null && "kind" in arg)
			)
				return {
					dataReadable: true,
					dataItemCount: 1,
					dataHasContinuation: false,
					domHasContinuation: false,
					declaredTotal: 1,
					domItemCount: 1,
					domHasEndMarker: true,
					verifiedEmpty: false,
					pageBlocked: false,
					latestHistoryResponse: null,
				};
			return undefined;
		};
		const history: Record<string, unknown>[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([[
				"watch_history",
				{ name: "watch_history" },
			]]) as never,
			emitRecord: async (_stream, data) => {
				history.push(data);
			},
			emit: async () => undefined,
			reportStreamFailure: async () => undefined,
			progress: async () => undefined,
		});
		return history[0];
	};

	const firstRun = await collectRecord([2026, 8, 23]);
	const secondRun = await collectRecord([2026, 8, 24]);
	assert.ok(firstRun);
	assert.ok(secondRun);
	assert.equal(firstRun.watched_date, "2026-09-21");
	assert.equal(secondRun.watched_date, "2026-09-21");
	assert.equal(firstRun.id, secondRun.id);
});

test("video primary keys survive playlist index changes", async () => {
	const collectKeys = async (
		index: number,
		videoId: string | null = VIDEO.video_id,
	) => {
		const page = new FixturePage();
		page.evaluate = async (fn: Function) =>
			fn.name === "readVideos"
				? [
						{
							...VIDEO,
							video_id: videoId,
							video_url: `${VIDEO.video_url}&list=PL1&index=${index}`,
						},
					]
				: fn.name === "readPlaylistLinks"
					? [{ id: "PL1", url: "https://www.youtube.com/playlist?list=PL1" }]
					: fn.name === "readPlaylistHeader"
						? {
								title: "My list",
								owner: null,
								owner_url: null,
								visibility: null,
								video_count_text: null,
								view_count_text: null,
							}
						: undefined;
		const keys = new Map<string, string>();
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map(
				["playlist_items", "likes", "watch_later"].map((name) => [
					name,
					{ name },
				]),
			) as never,
			emitRecord: async (stream, data) => {
				keys.set(stream, String(data.id));
			},
			emit: async () => undefined,
			reportStreamFailure: async () => undefined,
			progress: async () => undefined,
		});
		return keys;
	};
	assert.deepEqual(await collectKeys(1), await collectKeys(9));
	assert.deepEqual(await collectKeys(1, null), await collectKeys(9, null));
});

test("unreadable list DOM emits a skip instead of a successful zero-row snapshot", async () => {
	const page = new FixturePage();
	page.waitForFunction = async () => {
		throw new Error("read deadline");
	};
	const skipped: Record<string, unknown>[] = [];
	const records: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map(
			["subscriptions"].map((name) => [name, { name }]),
		) as never,
		emitRecord: async (_stream, data) => {
			records.push(data);
		},
		emit: async (message) => {
			skipped.push(message as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(skipped),
		progress: async () => undefined,
	});
	assert.deepEqual(
		skipped.map((message) => [message.type, message.stream, message.reason]),
		[["SKIP_RESULT", "subscriptions", "stream_collection_failed"]],
	);
	assert.equal(records.length, 0);
});

test("an empty grid without rendered built-in playlist links is not empty evidence", () => {
	withBrowserGlobals(
		`<script>var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"richGridRenderer":{"contents":[]}}}}]}}};</script>`,
		() => {
			assert.equal(
				readPageReadiness({
					content: "yt-lockup-view-model",
					empty: "ytd-message-renderer",
				}),
				false,
			);
		},
	);
});

test("an unbound empty message in page data is not target-list evidence", () => {
	withBrowserGlobals(
		`<script>var ytInitialData = {"contents":{"messageRenderer":{"text":{"runs":[{"text":"No videos yet"}]}}}};</script>`,
		() => {
			assert.equal(
				readPageReadiness({
					content: "yt-lockup-view-model",
					empty: "ytd-message-renderer",
				}),
				false,
			);
		},
	);
});

test("page readiness rejects sign-in and error message renderers as empty evidence", () => {
	for (const text of [
		"Sign in to confirm you're not a bot",
		"Something went wrong. Try again later.",
	]) {
		withBrowserGlobals(
			`<script>var ytInitialData = {"contents":{"messageRenderer":{"text":{"runs":[{"text":${JSON.stringify(text)}}]}}}};</script>`,
			() => {
				assert.equal(
					readPageReadiness({
						content: "yt-lockup-view-model",
						empty: "ytd-message-renderer",
					}),
					false,
					text,
				);
			},
		);
	}
});

test("empty YouTube page data completes requested empty browser lists", async () => {
	const records = new Map<string, Record<string, unknown>[]>();
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: new FixturePage([
			"json-empty",
			"json-empty",
			"json-empty",
			"json-empty",
		]) as never,
		requested: new Map(
			[
				"playlists",
				"playlist_items",
				"likes",
				"watch_later",
				"watch_history",
			].map((name) => [name, { name }]),
		) as never,
		emitRecord: async (stream, data) => {
			records.set(stream, [...(records.get(stream) ?? []), data]);
		},
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(messages),
		progress: async () => undefined,
	});

	for (const stream of [
		"playlists",
		"playlist_items",
		"likes",
		"watch_later",
		"watch_history",
	])
		assert.equal(records.get(stream)?.length ?? 0, 0, stream);
	assert.deepEqual(
		messages.map((message) => [
			message.type,
			message.stream,
			(message.cursor as Record<string, unknown> | undefined)?.evidence,
		]),
		[
			["STATE", "playlists", "youtube_page_data_empty"],
			["STATE", "playlist_items", "youtube_page_data_empty"],
			["DETAIL_COVERAGE", "playlist_items", undefined],
			["STATE", "likes", "youtube_page_data_empty"],
			["STATE", "watch_later", "youtube_page_data_empty"],
			["STATE", "watch_history", "youtube_page_data_empty"],
		],
	);
});

test("unreadable YouTube empty-target pages do not emit served STATE", async () => {
	const page = new FixturePage();
	page.waitForFunction = async () => {
		throw new Error("read deadline");
	};
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map(
			["likes", "watch_later", "watch_history"].map((name) => [name, { name }]),
		) as never,
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(messages),
		progress: async () => undefined,
	});

	assert.deepEqual(
		messages.map((message) => [message.type, message.stream, message.reason]),
		[
			["SKIP_RESULT", "likes", "stream_collection_failed"],
			["SKIP_RESULT", "watch_later", "stream_collection_failed"],
			["SKIP_RESULT", "watch_history", "stream_collection_failed"],
		],
	);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("content pages that parse zero videos are not verified empty", async () => {
	const page = new FixturePage(["content"]);
	page.evaluate = async (fn: Function) =>
		fn.name === "readVideos" ? [] : undefined;
	const records = new Map<string, Record<string, unknown>[]>();
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map(["likes"].map((name) => [name, { name }])) as never,
		emitRecord: async (stream, data) => {
			records.set(stream, [...(records.get(stream) ?? []), data]);
		},
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(messages),
		progress: async () => undefined,
	});

	assert.deepEqual(
		messages.map((message) => [message.type, message.stream, message.reason]),
		[["SKIP_RESULT", "likes", "stream_collection_failed"]],
	);
	assert.equal(records.get("likes")?.length ?? 0, 0);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("DOM sign-in and error renderers are not empty evidence", () => {
	for (const text of [
		"Sign in to view your videos",
		"Something went wrong. Try again.",
		"Loading",
	]) {
		withBrowserGlobals(
			`<ytd-message-renderer>${text}</ytd-message-renderer>`,
			() => {
				assert.equal(
					readPageReadiness({
						content: "yt-lockup-view-model",
						empty: "ytd-message-renderer",
					}),
					false,
					text,
				);
			},
		);
	}
});

test("unreadable enumeration calls reportStreamFailure with retryable true", async () => {
	const failures: unknown[] = [];
	const messages: unknown[] = [];
	await collectYoutubeBrowser({
		page: new FixturePage(["unreadable"]) as never,
		requested: new Map([["likes", { name: "likes" }]]) as never,
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message);
		},
		reportStreamFailure: async (stream, _message, options) => {
			failures.push([stream, withoutDiagnostics(options)]);
		},
		progress: async () => undefined,
	});
	assert.deepEqual(failures, [["likes", { retryable: true }]]);
	assert.deepEqual(messages, []);
});

test("parse mismatch fails instead of completing a zero-row list", async () => {
	const page = new FixturePage(["content"]);
	page.evaluate = async () => [];
	const failures: unknown[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map([["likes", { name: "likes" }]]) as never,
		emitRecord: async () => undefined,
		emit: async () => undefined,
		reportStreamFailure: async (stream, _message, options) => {
			failures.push([stream, withoutDiagnostics(options)]);
		},
		progress: async () => undefined,
	});
	assert.deepEqual(failures, [["likes", { retryable: true }]]);
});

test("each requested enumeration reports timeout and parse mismatch as retryable failure", async () => {
	await Promise.all(
		[
			"subscriptions",
			"playlists",
			"playlist_items",
			"likes",
			"watch_later",
			"watch_history",
		].map(async (stream) => {
			await Promise.all(
				(["unreadable", "content"] as const).map(async (state) => {
					const page = new FixturePage([state]);
					page.evaluate = async () => [];
					const failures: unknown[] = [];
					const messages: unknown[] = [];
					await collectYoutubeBrowser({
						page: page as never,
						requested: new Map([[stream, { name: stream }]]) as never,
						emitRecord: async () => undefined,
						emit: async (message) => {
							messages.push(message);
						},
						reportStreamFailure: async (name, _message, options) => {
							failures.push([name, withoutDiagnostics(options)]);
						},
						progress: async () => undefined,
					});
					assert.deepEqual(
						failures,
						[[stream, { retryable: true }]],
						`${stream}: ${state}`,
					);
					assert.deepEqual(messages, []);
				}),
			);
		}),
	);
});

test("subscription source empty evidence completes with STATE", async () => {
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: new FixturePage(["empty"]) as never,
		requested: new Map([["subscriptions", { name: "subscriptions" }]]) as never,
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		progress: async () => undefined,
	});
	assert.equal(messages[0]?.type, "STATE");
	assert.equal(messages[0]?.stream, "subscriptions");
});

test("nonempty enumerations without source-end evidence fail with stream_collection_failed", async () => {
	await Promise.all(
		[
			"subscriptions",
			"playlists",
			"playlist_items",
			"likes",
			"watch_later",
			"watch_history",
		].map(async (stream) => {
			const messages: Record<string, unknown>[] = [];
			const records: Record<string, unknown>[] = [];
			await collectYoutubeBrowser({
				page: new FixturePage() as never,
				requested: new Map([[stream, { name: stream }]]) as never,
				emitRecord: async (_stream, data) => {
					records.push(data);
				},
				emit: async (message) => {
					messages.push(message as Record<string, unknown>);
				},
				reportStreamFailure: failureReporter(messages),
				progress: async () => undefined,
			});
			assert.ok(
				messages.some(
					(message) =>
						message.stream === stream &&
						message.reason === "stream_collection_failed",
				),
				stream,
			);
			assert.ok(
				messages.every(
					(message) =>
						(stream === "watch_history" || message.type !== "STATE") &&
						message.reason !== "bounded_browser_snapshot",
				),
				stream,
			);
			// Records already read are still emitted.
			assert.ok(records.length > 0, stream);
		}),
	);
});

test("empty source list with continuation does not prove completion", () => {
	withBrowserGlobals(
		'<script>var ytInitialData = {"contents":{"playlistVideoListRenderer":{"contents":[],"continuations":[{"nextContinuationData":{"continuation":"next"}}]}}};</script>',
		() => {
			assert.equal(
				readPageReadiness({
					content: "ytd-playlist-video-renderer",
					empty: "ytd-message-renderer",
				}),
				false,
			);
		},
	);
});

test("browser navigation failures report each requested enumeration as retryable", async () => {
	await Promise.all(
		[
			"subscriptions",
			"playlists",
			"playlist_items",
			"likes",
			"watch_later",
			"watch_history",
		].map(async (stream) => {
			const page = new FixturePage();
			page.goto = async () => {
				throw new Error("navigation failed");
			};
			const failures: unknown[] = [];
			await collectYoutubeBrowser({
				page: page as never,
				requested: new Map([[stream, { name: stream }]]) as never,
				emitRecord: async () => undefined,
				emit: async () => undefined,
				reportStreamFailure: async (name, _message, options) => {
					failures.push([name, withoutDiagnostics(options)]);
				},
				progress: async () => undefined,
			});
			assert.deepEqual(failures, [[stream, { retryable: true }]], stream);
		}),
	);
});

test("LL empty-state JSON text may contain braces and escaped quotes", () => {
	const data = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							selected: true,
							content: {
								sectionListRenderer: {
									contents: [
										{
											itemSectionRenderer: {
												contents: [
													{
														messageRenderer: {
															text: { simpleText: 'No videos } yet "saved"' },
														},
													},
												],
											},
										},
									],
								},
							},
						},
					},
				],
			},
		},
	};
	withBrowserGlobals(
		`<script>var ytInitialData = ${JSON.stringify(data)};</script>`,
		() => {
			assert.equal(
				readPageReadiness({
					content: "ytd-playlist-video-renderer",
					empty: "ytd-message-renderer",
				}),
				"empty",
			);
		},
		"https://www.youtube.com/playlist?list=LL",
	);
});

test("a stream failure is reported once across several playlists", async () => {
	const page = new FixturePage();
	const evaluate = page.evaluate.bind(page);
	page.evaluate = async (fn: Function) => {
		if (fn.name === "readPlaylistLinks")
			return [1, 2, 3].map((n) => ({
				id: `PL${n}`,
				url: `https://www.youtube.com/playlist?list=PL${n}`,
			}));
		if (fn.name === "readVideos" && page.url.includes("list=PL2")) return [];
		return evaluate(fn);
	};
	const failures: unknown[] = [];
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map(
			["playlists", "playlist_items"].map((name) => [name, { name }]),
		) as never,
		emitRecord: async () => undefined,
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: async (stream, _message, options) => {
			failures.push([stream, withoutDiagnostics(options)]);
		},
		progress: async () => undefined,
	});
	// The index shows no end (both streams), and playlist PL2 read nothing.
	assert.deepEqual(failures, [
		["playlists", { retryable: true }],
		["playlist_items", { retryable: true }],
	]);
	assert.deepEqual(messages, []);
});

test("playlist items reach the 51st enumerated playlist", async () => {
	const playlists = Array.from({ length: 51 }, (_, index) => ({
		id: `PL${index + 1}`,
		url: `https://www.youtube.com/playlist?list=PL${index + 1}`,
	}));
	const page = new FixturePage();
	const evaluate = page.evaluate.bind(page);
	page.evaluate = async (fn: Function, arg?: unknown) => {
		if (fn.name === "readPlaylistLinks") return playlists;
		if (
			fn.name === "readListEnd" &&
			typeof arg === "object" && arg !== null && "kind" in arg
		) {
			const kind = (arg as { kind: string }).kind;
			const total = kind === "playlist-index" ? 51 : 1;
			return {
				dataReadable: true,
				dataItemCount: total,
				dataHasContinuation: false,
				domHasContinuation: false,
				declaredTotal: total,
				domItemCount: total,
				domHasEndMarker: true,
				verifiedEmpty: false,
				pageBlocked: false,
			};
		}
		return evaluate(fn, arg);
	};
	const items: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: page as never,
		requested: new Map([["playlist_items", { name: "playlist_items" }]]) as never,
		emitRecord: async (_stream, data) => {
			items.push(data);
		},
		emit: async () => undefined,
		reportStreamFailure: async () => undefined,
		progress: async () => undefined,
	});
	assert.equal(items.at(-1)?.playlist_id, "PL51");
});

// ── Source-end evidence and list scoping, run against parsed pages ──────────

const pageData = (data: unknown) =>
	`<script>var ytInitialData = ${JSON.stringify(data)};</script>`;

/** A browse page whose list region is the selected tab's content. */
const tabbedData = (content: unknown, extra: Record<string, unknown> = {}) => ({
	contents: {
		twoColumnBrowseResultsRenderer: {
			tabs: [{ tabRenderer: { selected: true, content } }],
			...extra,
		},
	},
});

const playlistRow = `<ytd-playlist-video-renderer><a href="/watch?v=abc123XYZ0&list=LL"></a><h3>Real video title</h3></ytd-playlist-video-renderer>`;
const historyRow = `<ytd-item-section-renderer><yt-lockup-view-model><a href="/watch?v=aaaaaaaaaaa"></a><h3>Seen</h3></yt-lockup-view-model></ytd-item-section-renderer>`;
const channelRow = `<ytd-channel-renderer><a id="main-link" href="/@creator"></a><ytd-channel-name><yt-formatted-string id="text">Creator</yt-formatted-string></ytd-channel-name></ytd-channel-renderer>`;
const END_OF_LIST = `<div id="contents"><div id="message">No more videos</div></div>`;
const END_OF_PLAYLIST_INDEX = `<div id="contents"><div id="message">No more items</div></div>`;
/** The page-local session probe needs the account avatar. */
const SIGNED_IN = `<button id="avatar-btn"></button>`;
const headerTotal = (text: string) =>
	`<div class="yt-content-metadata-view-model__metadata-text">${text}</div>`;
const playlistPageData = (itemCount: number, continuation = false) =>
	pageData(
		tabbedData({
			playlistVideoListRenderer: {
				contents: [
					...Array.from({ length: itemCount }, () => ({
						playlistVideoRenderer: { videoId: "abc123XYZ0" },
					})),
					...(continuation
						? [{ continuationItemRenderer: { token: "next" } }]
						: []),
				],
			},
		}),
	);

const historyBootstrap = (videoIds: string[], continuation?: string) =>
	pageData(
		tabbedData({
			sectionListRenderer: {
				contents: [
					{
						itemSectionRenderer: {
							contents: [
								...videoIds.map((videoId) => ({
									lockupViewModel: { contentId: videoId },
								})),
								...(continuation
									? [
											{
												continuationItemRenderer: {
													continuationEndpoint: {
														continuationCommand: { token: continuation },
													},
												},
											},
										]
									: []),
							],
						},
					},
				],
			},
		}),
	);

const resolvedHistoryHeader =
	'<ytd-item-section-header-renderer><div id="header"><div id="title">Today</div></div></ytd-item-section-header-renderer>';

const historyCards = (videoIds: string[]) =>
	`<ytd-item-section-renderer>${resolvedHistoryHeader}${videoIds
		.map(
			(videoId) =>
				`<yt-lockup-view-model><a href="/watch?v=${videoId}"></a><h3>Seen</h3></yt-lockup-view-model>`,
		)
		.join("")}</ytd-item-section-renderer>`;

type HistoryResponseAfterReadListEnd = {
	readNumber: number;
	requested: string;
	next: string | null;
	initialRequest?: boolean;
	requestBody?: Record<string, unknown>;
	itemCount?: number;
	status?: number;
	duringJson?: {
		requested: string;
		next: string | null;
		initialRequest?: boolean;
		jsonDelayMs?: number;
	};
	jsonDelayMs?: number;
};

/** A browse request the page starts: it never settles, or it fails with this body (null: none). */
type BrowseRequestSpec = "hang" | "fail" | { failBody: Record<string, unknown> | null };

/** One scripted browse response; the options shape the request and the answer. */
type HistoryResponseSpec = {
	requested: string;
	next: string | null;
	/** Rows the response carries; a response without rows has no readable list. */
	itemCount?: number;
	status?: number;
	initialRequest?: boolean;
	/** The decoded request body, when it is not just the continuation. */
	requestBody?: Record<string, unknown>;
	/** The content-encoding header value; the body is gzip only with gzipRequestBodies. */
	contentEncoding?: string;
	/** Wrap each row in an outer row, as a grid item wraps its video. */
	nested?: boolean;
	/** The body never resolves after the headers arrive. */
	jsonHangs?: boolean;
};

/** A page-log entry the way the page-side wrapper reports it. */
type LoggedEntry = {
	requestBody: Record<string, unknown> | null;
	status: number;
	summary: Record<string, unknown> | null;
};
const loggedResponse = (
	requested: string,
	itemCount: number,
	next: string | null = null,
	status = 200,
): LoggedEntry => ({
	requestBody: { continuation: requested },
	status,
	summary: {
		recognized: true,
		hasContinuation: next !== null,
		itemCount,
		nextContinuation: next,
	},
});
const loggedUncorrelated = (): LoggedEntry => ({ requestBody: null, status: 0, summary: null });

/** Runs the connector's real page functions against parsed HTML, one page per URL. */
class DocumentPage {
	url = "";
	private readonly responseListeners = new Set<(response: never) => void>();
	private readonly pageFor: (url: string) => string;
	private readonly forcedReadiness: "content" | "empty" | undefined;
	private readonly historyResponsesOnScroll: HistoryResponseSpec[];
	private readonly historyResponsesOnGoto: HistoryResponseSpec[];
	private readonly pageLogOnScroll: LoggedEntry[][] | undefined;
	private pageLogPending: LoggedEntry[] = [];
	private pageLogSent = 0;
	private pageLogHanging = 0;
	private drainCount = 0;
	private readonly setupStall: "hydration" | "wait" | "jsonValue" | "dispose" | undefined;
	private hydrationStalled = false;
	/** The page's own stop token, kept across the fake's per-call windows. */
	private pageStopToken: unknown;
	/** Held scroll evaluates run only after this settles. */
	private readonly scrollGate: Promise<void> | undefined;
	scrollByCount = 0;
	private readonly hangDrainWait: boolean;
	private readonly hangDrainFrom: number | undefined;
	private readonly hangReadListEndFrom: number | undefined;
	private readonly browseRequestsFirst: boolean;
	private readonly gotoError: Error | undefined;
	private readonly gotoHangs: boolean;
	private readonly hangBrowserDate: boolean;
	private readonly browseRequestsOnScroll: BrowseRequestSpec[];
	private readonly pageLogHangOnScroll: number;
	private readonly historyResponseOnReadListEnd:
		| { readNumber: number; requested: string; next: string | null }
		| undefined;
	private readonly historyResponsesAfterReadListEnd: HistoryResponseAfterReadListEnd[];
	private readListEndCount = 0;
	private pendingHistoryScroll = false;
	private readonly gzipRequestBodies: boolean;
	constructor(
		pageFor: (url: string) => string,
		forcedReadiness?: "content" | "empty",
		options: {
			historyResponsesOnScroll?: HistoryResponseSpec[];
			historyResponsesOnGoto?: HistoryResponseSpec[];
			/**
			 * Observe history through a page-side log, as PageShim does: the page has
			 * no response events and each scroll appends these logged entries.
			 */
			pageLogOnScroll?: LoggedEntry[][];
			/** Page-log browse calls the page starts on scroll and never finishes. */
			pageLogHangOnScroll?: number;
			/** Browse requests the page starts on scroll; "hang" never settles. */
			browseRequestsOnScroll?: BrowseRequestSpec[];
			gotoError?: Error;
			/** Navigation to the history page never settles. */
			gotoHangs?: boolean;
			/** The browser-date evaluation never settles. */
			hangBrowserDate?: boolean;
			/** The nth page-log drain, and every one after it, never resolves. */
			hangDrainFrom?: number;
			/** The nth readListEnd evaluate, and every one after it, never resolves. */
			hangReadListEndFrom?: number;
			/** One setup step never settles. */
			setupStall?: "hydration" | "wait" | "jsonValue" | "dispose";
			/** The drain's short wait never returns. */
			hangDrainWait?: boolean;
			/** Scroll evaluates are held until this settles. */
			scrollGate?: Promise<void>;
			/** Start the scroll's browse requests before its response arrives. */
			browseRequestsFirst?: boolean;
			historyResponseOnReadListEnd?: {
				readNumber: number;
				requested: string;
				next: string | null;
			};
		historyResponsesAfterReadListEnd?: HistoryResponseAfterReadListEnd[];
			/** Send request bodies gzip-encoded, as YouTube does; postDataJSON cannot read them. */
			gzipRequestBodies?: boolean;
		} = {},
	) {
		this.pageFor = pageFor;
		this.forcedReadiness = forcedReadiness;
		this.gzipRequestBodies = options.gzipRequestBodies ?? false;
		this.pageLogOnScroll = options.pageLogOnScroll;
		this.pageLogHangOnScroll = options.pageLogHangOnScroll ?? 0;
		this.browseRequestsOnScroll = options.browseRequestsOnScroll ?? [];
		this.gotoError = options.gotoError;
		this.gotoHangs = options.gotoHangs ?? false;
		this.hangBrowserDate = options.hangBrowserDate ?? false;
		this.hangDrainFrom = options.hangDrainFrom;
		this.setupStall = options.setupStall;
		this.hangDrainWait = options.hangDrainWait ?? false;
		this.scrollGate = options.scrollGate;
		this.hangReadListEndFrom = options.hangReadListEndFrom;
		this.browseRequestsFirst = options.browseRequestsFirst ?? false;
		if (this.pageLogOnScroll)
			Object.defineProperty(this, "on", { value: undefined });
		this.historyResponsesOnScroll = options.historyResponsesOnScroll ?? [];
		this.historyResponsesOnGoto = options.historyResponsesOnGoto ?? [];
		this.historyResponseOnReadListEnd = options.historyResponseOnReadListEnd;
		this.historyResponsesAfterReadListEnd =
			options.historyResponsesAfterReadListEnd ?? [];
	}
	private readonly requestListeners = new Set<(request: never) => void>();
	private readonly requestFailedListeners = new Set<(request: never) => void>();
	private listenersFor(event: string) {
		return event === "response"
			? this.responseListeners
			: event === "request"
				? this.requestListeners
				: event === "requestfailed"
					? this.requestFailedListeners
					: new Set<(value: never) => void>();
	}
	on(event: string, listener: (value: never) => void): this {
		this.listenersFor(event).add(listener);
		return this;
	}
	off(event: string, listener: (value: never) => void): this {
		this.listenersFor(event).delete(listener);
		return this;
	}
	private emitBrowseRequest(settle: BrowseRequestSpec): void {
		const body =
			typeof settle === "object" ? settle.failBody : null;
		const request = {
			url: () => "https://www.youtube.com/youtubei/v1/browse",
			postDataJSON: () => {
				if (body === null) throw new Error("no body");
				return body;
			},
		};
		for (const listener of this.requestListeners) listener(request as never);
		if (settle !== "hang")
			for (const listener of this.requestFailedListeners) listener(request as never);
	}
	async goto(url: string) {
		if (this.gotoError && url.includes("/feed/history")) throw this.gotoError;
		if (this.gotoHangs && url.includes("/feed/history"))
			await new Promise<never>(() => undefined);
		this.url = url;
		for (const { requested, next, ...options } of this.historyResponsesOnGoto.splice(0))
			this.emitHistoryResponse(requested, next, options);
	}
	private emitHistoryResponse(
		requested: string,
		next: string | null,
		options: {
			jsonDelayMs?: number;
			initialRequest?: boolean;
			itemCount?: number;
			status?: number;
			requestBody?: Record<string, unknown>;
			contentEncoding?: string;
			nested?: boolean;
			jsonHangs?: boolean;
			duringJson?: {
				requested: string;
				next: string | null;
				initialRequest?: boolean;
				jsonDelayMs?: number;
			};
		} = {},
	): void {
		const rows = Array.from({ length: options.itemCount ?? 0 }, () =>
			options.nested
				? { richItemRenderer: { content: { videoRenderer: {} } } }
				: { lockupViewModel: {} },
		);
		const continuationItems = next
			? [
					{
						continuationItemRenderer: {
							continuationEndpoint: { continuationCommand: { token: next } },
						},
					},
				]
			: [];
		const response = {
			url: () => "https://www.youtube.com/youtubei/v1/browse",
			request: () => {
				const body =
					options.requestBody ??
					(options.initialRequest
						? { browseId: "FEhistory" }
						: { continuation: requested });
				if (this.gzipRequestBodies)
					return {
						postDataJSON: () => {
							throw new Error("gzip body is not JSON");
						},
						postDataBuffer: () => gzipSync(JSON.stringify(body)),
						headers: () => ({
							"content-encoding": options.contentEncoding ?? "gzip",
						}),
					};
				if (options.contentEncoding !== undefined)
					return {
						postDataJSON: () => body,
						postDataBuffer: () => Buffer.from(JSON.stringify(body)),
						headers: () => ({ "content-encoding": options.contentEncoding }),
					};
				return { postDataJSON: () => body };
			},
			status: () => options.status ?? 200,
			json: async () => {
				if (options.jsonHangs) await new Promise<never>(() => undefined);
				if (options.jsonDelayMs)
					await new Promise((resolve) =>
						setTimeout(resolve, options.jsonDelayMs),
					);
				if (options.duringJson) {
					await new Promise((resolve) =>
						setTimeout(resolve, options.duringJson?.jsonDelayMs ?? 0),
					);
					this.emitHistoryResponse(
						options.duringJson.requested,
						options.duringJson.next,
						{
							...(options.duringJson.initialRequest !== undefined
								? { initialRequest: options.duringJson.initialRequest }
								: {}),
							...(options.duringJson.jsonDelayMs !== undefined
								? { jsonDelayMs: options.duringJson.jsonDelayMs }
								: {}),
						},
					);
				}
				return {
					onResponseReceivedActions: [
						{ appendContinuationItemsAction: { continuationItems: [...rows, ...continuationItems] } },
					],
				};
			},
		};
		for (const listener of this.responseListeners) listener(response as never);
	}
	locator(selector: string) {
		return {
			first: () => ({ click: async () => undefined }),
			count: async () =>
				this.inPage(() => document.querySelectorAll(selector).length),
		};
	}
	async waitForTimeout(ms?: number) {
		if (this.hangDrainWait && ms === 250) await new Promise<never>(() => undefined);
		if (this.setupStall === "hydration" && ms !== 250 && !this.hydrationStalled) {
			this.hydrationStalled = true;
			await new Promise<never>(() => undefined);
		}
		if (!this.pendingHistoryScroll) return;
		this.pendingHistoryScroll = false;
		if (this.browseRequestsFirst)
			for (const settle of this.browseRequestsOnScroll.splice(0))
				this.emitBrowseRequest(settle);
		const response = this.historyResponsesOnScroll.shift();
		if (response) {
			const { requested, next, ...options } = response;
			this.emitHistoryResponse(requested, next, options);
		}
		for (const settle of this.browseRequestsOnScroll.splice(0))
			this.emitBrowseRequest(settle);
		if (this.pageLogHangOnScroll > 0) {
			this.pageLogSent += this.pageLogHangOnScroll;
			this.pageLogHanging += this.pageLogHangOnScroll;
		}
		const logged = this.pageLogOnScroll?.shift();
		if (logged) {
			this.pageLogSent += logged.length;
			this.pageLogPending.push(...logged);
		}
	}
	private inPage<T>(run: () => T): T {
		const { document, window } = parseHTML(this.pageFor(this.url));
		Object.defineProperty(window, "location", {
			configurable: true,
			value: new URL(this.url || "https://www.youtube.com/"),
		});
		(window as unknown as { scrollBy: () => void }).scrollBy = () => {
			this.scrollByCount += 1;
		};
		(window as unknown as Record<string, unknown>).__pdpHistoryStop = this.pageStopToken;
		const globals = globalThis as Record<string, unknown>;
		const previous = { document: globals.document, window: globals.window };
		globals.document = document;
		globals.window = window;
		try {
			return run();
		} finally {
			this.pageStopToken = (window as unknown as Record<string, unknown>).__pdpHistoryStop;
			globals.document = previous.document;
			globals.window = previous.window;
		}
	}
	async waitForFunction(fn: Function, arg: unknown) {
		if (this.setupStall === "wait") await new Promise<never>(() => undefined);
		const value = this.forcedReadiness ?? this.inPage(() => fn(arg));
		if (!value) throw new Error("page read timed out");
		const never = () => new Promise<never>(() => undefined);
		return {
			jsonValue: this.setupStall === "jsonValue" ? never : async () => value,
			dispose: this.setupStall === "dispose" ? never : async () => undefined,
		};
	}
	async evaluate(fn: Function, arg?: unknown) {
		if (this.hangBrowserDate && fn.name === "readBrowserDate")
			await new Promise<never>(() => undefined);
		if (
			this.scrollGate &&
			fn.toString().includes("scrollable=Array.from(document.querySelectorAll")
		)
			await this.scrollGate;
		if (fn.name === "installHistoryBrowseLog") return true;
		if (fn.name === "drainHistoryBrowseLog") {
			this.drainCount += 1;
			if (this.hangDrainFrom !== undefined && this.drainCount >= this.hangDrainFrom)
				await new Promise<never>(() => undefined);
			return {
				entries: this.pageLogPending.splice(0),
				overflow: false,
				sent: this.pageLogSent,
				completed: this.pageLogSent - this.pageLogHanging,
			};
		}
		if (fn.name === "readListEnd") {
			this.readListEndCount += 1;
			if (
				this.hangReadListEndFrom !== undefined &&
				this.readListEndCount >= this.hangReadListEndFrom
			)
				await new Promise<never>(() => undefined);
			if (
				this.readListEndCount ===
				this.historyResponseOnReadListEnd?.readNumber
			) {
				this.emitHistoryResponse(
					this.historyResponseOnReadListEnd.requested,
					this.historyResponseOnReadListEnd.next,
				);
			}
		}
		const value = this.inPage(() => {
			if (fn.name === "hasYoutubeSessionOnCurrentPage")
				return Boolean(document.querySelector("button#avatar-btn"));
			return fn(arg);
		});
		if (
			fn.name === "readListEnd" &&
			this.historyResponsesAfterReadListEnd.some(
				(response) => response.readNumber === this.readListEndCount,
			)
		) {
			for (const response of this.historyResponsesAfterReadListEnd)
				if (response.readNumber === this.readListEndCount)
					this.emitHistoryResponse(response.requested, response.next, {
						...(response.initialRequest !== undefined
							? { initialRequest: response.initialRequest }
							: {}),
						...(response.requestBody
							? { requestBody: response.requestBody }
							: {}),
						...(response.itemCount !== undefined
							? { itemCount: response.itemCount }
							: {}),
						...(response.status !== undefined
							? { status: response.status }
							: {}),
						...(response.jsonDelayMs !== undefined
							? { jsonDelayMs: response.jsonDelayMs }
							: {}),
						...(response.duringJson
							? { duringJson: response.duringJson }
							: {}),
					});
		}
		if (
			fn.toString().includes("scrollable=Array.from(document.querySelectorAll")
		)
			this.pendingHistoryScroll = true;
		return value;
	}
}

/** When set, the downstream record callback never settles. */
let recordCallbackHangs = false;
/** Each record callback takes this long to acknowledge. */
let recordCallbackDelayMs = 0;
/** When set, the downstream sink never acknowledges a STATE. */
let stateSinkHangs = false;
/** When set, the failure sink never answers. */
let failureSinkHangs = false;
/** When set, the progress (coverage) sink never answers. */
let progressSinkHangs = false;

async function collectFromDocuments(
	pageFor: (url: string) => string,
	streams: string[],
	forcedReadiness?: "content" | "empty",
	state: Record<string, unknown> = {},
	pageOptions: ConstructorParameters<typeof DocumentPage>[2] = {},
	onPage?: (page: DocumentPage) => void,
) {
	const records = new Map<string, Record<string, unknown>[]>();
	const messages: Record<string, unknown>[] = [];
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
	try {
		const documentPage = new DocumentPage(
			(url) => {
				const html = pageFor(url);
				return url.includes("/feed/history") && !html.includes("avatar-btn")
					? `${SIGNED_IN}${html}`
					: html;
			},
			forcedReadiness,
			pageOptions,
		);
		onPage?.(documentPage);
		await collectYoutubeBrowser({
			page: documentPage as never,
			requested: new Map(streams.map((name) => [name, { name }])) as never,
			state,
			emitRecord: async (stream, data) => {
				if (recordCallbackHangs) await new Promise<never>(() => undefined);
				if (recordCallbackDelayMs > 0)
					await new Promise((resolve) => setTimeout(resolve, recordCallbackDelayMs));
				records.set(stream, [...(records.get(stream) ?? []), data]);
			},
			emit: async (message) => {
				if (stateSinkHangs && (message as { type?: string }).type === "STATE")
					await new Promise<never>(() => undefined);
				messages.push(message as Record<string, unknown>);
			},
			reportStreamFailure: failureSinkHangs
				? () => new Promise<never>(() => undefined)
				: failureReporter(messages),
			progress: async () => {
				if (progressSinkHangs) await new Promise<never>(() => undefined);
			},
		});
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	const outcome = (stream: string) =>
		messages
			.filter((message) => message.stream === stream)
			.map((message) => message.reason ?? message.type);
	return { records, messages, outcome, diagnostics };
}

test("finding 1: a matching source total without a terminal marker still fails", async () => {
	const { records, outcome } = await collectFromDocuments(
		() => `${playlistRow}${headerTotal("1 video")}${playlistPageData(1, true)}`,
		["likes", "watch_later"],
	);
	assert.equal(records.get("likes")?.length, 1);
	assert.equal(records.get("watch_later")?.length, 1);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	assert.deepEqual(outcome("watch_later"), ["stream_collection_failed"]);
});

test("finding 1: source entries left unread do not prove completion without a next-page token", async () => {
	const pages = (url: string) =>
		url.includes("feed/history")
			? `${historyRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }, { lockupViewModel: { contentId: "bbbbbbbbbbb" } }] } }))}`
			: url.includes("feed/channels")
				? `${channelRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ channelRenderer: { channelId: "UC1" } }, { channelRenderer: { channelId: "UC2" } }] } }))}`
				: "";
	const { records, outcome } = await collectFromDocuments(pages, [
		"watch_history",
		"subscriptions",
	]);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.equal(records.get("subscriptions")?.length, 1);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
	assert.deepEqual(outcome("subscriptions"), ["stream_collection_failed"]);
});

test("a playlist index and each playlist with explicit end markers complete", async () => {
	const pages = (url: string) =>
		url.includes("feed/playlists")
			? `${SIGNED_IN}<a href="/playlist?list=PL1">My list</a>${pageData(tabbedData({ gridRenderer: { items: [{ gridPlaylistRenderer: { playlistId: "PL1" } }] } }))}${END_OF_PLAYLIST_INDEX}`
			: `${SIGNED_IN}<h1><yt-formatted-string>My list</yt-formatted-string></h1>${playlistRow}${headerTotal("1 video")}${playlistPageData(1)}${END_OF_LIST}`;
	const { records, outcome } = await collectFromDocuments(pages, [
		"playlists",
		"playlist_items",
	]);
	assert.equal(records.get("playlists")?.length, 1);
	assert.equal(records.get("playlist_items")?.length, 1);
	assert.deepEqual(outcome("playlists"), []);
	assert.deepEqual(outcome("playlist_items"), []);
});

test("playlist item collection continues when playlist header details are unreadable", async () => {
	const { records, outcome } = await collectFromDocuments(
		(url) =>
			url.includes("feed/playlists")
				? `${SIGNED_IN}<a href="/playlist?list=PL1">My list</a>${pageData(tabbedData({ gridRenderer: { items: [{ gridPlaylistRenderer: { playlistId: "PL1" } }] } }))}${END_OF_PLAYLIST_INDEX}`
				: `${SIGNED_IN}${playlistRow}${headerTotal("1 video")}${playlistPageData(1)}${END_OF_LIST}`,
		["playlists", "playlist_items"],
	);
	assert.equal(records.get("playlists")?.length, undefined);
	assert.equal(records.get("playlist_items")?.length, 1);
	assert.deepEqual(outcome("playlists"), ["stream_collection_failed"]);
	assert.deepEqual(outcome("playlist_items"), []);
});

test("finding 1: a list with a next page still pending fails with stream_collection_failed", async () => {
	const pages = (url: string) =>
		url.includes("feed/history")
			? `${historyRow}<ytd-continuation-item-renderer></ytd-continuation-item-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`
			: `${playlistRow}${headerTotal("5 videos")}<ytd-continuation-item-renderer></ytd-continuation-item-renderer>${playlistPageData(1, true)}`;
	const { records, outcome } = await collectFromDocuments(pages, [
		"watch_history",
		"likes",
	]);
	assert.equal(records.get("likes")?.length, 1);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
});

test("history streams all loaded rows and uses latest target response for end evidence", async () => {
	const sourceItems = Array.from({ length: 60 }, () => ({
		lockupViewModel: {},
	}));
	const rows = Array.from(
		{ length: 60 },
		(_, n) =>
			`<yt-lockup-view-model><a href="/watch?v=vid${String(n).padStart(8, "0")}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
	).join("");
	const { records, messages, outcome } = await collectFromDocuments(
		() =>
				`<ytd-item-section-renderer>${resolvedHistoryHeader}${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: sourceItems } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 60);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("latest history response can prove end despite stale bootstrap row counts", async () => {
	const cases = [false, true];
	for (const withEndMarker of cases) {
		const sourceItems = [
			...Array.from({ length: 30 }, () => ({ lockupViewModel: {} })),
			{
				continuationItemRenderer: {
					continuationEndpoint: {
						continuationCommand: { token: "bootstrap-C" },
					},
				},
			},
		];
		const rows = Array.from(
			{ length: 60 },
			(_, n) =>
				`<yt-lockup-view-model><a href="/watch?v=vid${String(n).padStart(8, "0")}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
		).join("");
		const { records, messages, outcome } = await collectFromDocuments(
			() =>
				`<ytd-item-section-renderer>${resolvedHistoryHeader}${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: sourceItems } }))}${withEndMarker ? END_OF_LIST : ""}`,
			["watch_history"],
			undefined,
			{},
			{
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 30 },
				],
			},
		);
		assert.equal(records.get("watch_history")?.length, 60);
		assert.deepEqual(outcome("watch_history"), ["STATE"]);
		assert.equal(
			(
				messages.find((message) => message.type === "STATE")?.cursor as Record<
					string,
					unknown
				>
			)?.complete,
			true,
		);
	}
});

test("HTML history bootstrap with one complete page proves end without a browse fetch", async () => {
	const videoIds = ["aaaaaaaaaaa"];
	const { records, messages, outcome } = await collectFromDocuments(
		() => `${historyCards(videoIds)}${historyBootstrap(videoIds)}`,
		["watch_history"],
		undefined,
		{},
		{},
	);
	assert.equal(records.get("watch_history")?.length, videoIds.length);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("HTML history bootstrap accounts for legacy videoRenderer rows", async () => {
	const videoId = "legacyvid01";
	const html = `<ytd-item-section-renderer>${resolvedHistoryHeader}<ytd-video-renderer><a href="/watch?v=${videoId}"></a><h3>Legacy row</h3></ytd-video-renderer></ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ videoRenderer: { videoId } }] } }] } }))}`;
	const { records, messages, outcome } = await collectFromDocuments(
		() => html,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("HTML history continuation chain is correlated and terminal response beats stale bootstrap token", async () => {
	const videoIds = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
	const { records, messages, outcome } = await collectFromDocuments(
		() => grownHistory(videoIds, 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
		},
	);
	assert.equal(records.get("watch_history")?.length, videoIds.length);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("history responses received during navigation are replayed after HTML tokens seed", async () => {
	const videoIds = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
	const { records, messages, outcome } = await collectFromDocuments(
		() => grownHistory(videoIds, 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesOnGoto: [
				{ requested: "bootstrap-C", next: "continuation-D" },
			],
			historyResponsesOnScroll: [
				{ requested: "continuation-D", next: null, itemCount: 1 },
			],
		},
	);
	assert.equal(records.get("watch_history")?.length, videoIds.length);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("history completion is revoked when the final refresh receives a continuation cycle", async () => {
	const videoIds = ["aaaaaaaaaaa"];
	const { messages, outcome } = await collectFromDocuments(
		() =>
			`${historyCards(videoIds)}${historyBootstrap(videoIds, "bootstrap-C")}`,
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null },
			],
			historyResponseOnReadListEnd: {
				readNumber: 3,
				requested: "bootstrap-C",
				next: "continuation-D",
			},
		},
	);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"]);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" &&
				(message.cursor as Record<string, unknown>)?.complete === true,
		),
		false,
	);
});

test("final history refresh rechecks a response that arrives while its flush is pending", async () => {
	const videoIds = ["aaaaaaaaaaa"];
	const { messages, outcome } = await collectFromDocuments(
		() => `${historyCards(videoIds)}${historyBootstrap(videoIds)}`,
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesAfterReadListEnd: [
				{
					readNumber: 3,
					requested: "initial-history-request",
					next: null,
					initialRequest: true,
					duringJson: {
						requested: "invalidating-history-request",
						next: "continuation-D",
						initialRequest: true,
						jsonDelayMs: 30,
					},
				},
			],
		},
	);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"]);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" &&
				(message.cursor as Record<string, unknown>)?.complete === true,
		),
		false,
	);
});

test("a response arriving during the final page evaluation invalidates that end snapshot", async () => {
	const videoIds = ["aaaaaaaaaaa"];
	const { messages, outcome, diagnostics } = await collectFromDocuments(
		() => `${historyCards(videoIds)}${historyBootstrap(videoIds)}`,
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesAfterReadListEnd: [
				{
					// Calls 1–2 are bootstrap reads, call 3 is the main-loop end
					// check, and call 4 is the final refresh. DocumentPage emits
					// after readListEnd returns but before evaluate resolves.
					readNumber: 4,
					requested: "initial-history-request",
					next: "continuation-D",
					initialRequest: true,
				},
			],
		},
	);
	assert.deepEqual(
		outcome("watch_history"),
		["stream_collection_failed", "STATE"],
	);
	const coverageLine = diagnostics.find(
		(line) =>
			line.startsWith("[youtube-diagnostic] coverage ") &&
			line.includes('"stream":"watch_history"'),
	);
	assert.ok(coverageLine);
	const coverage = JSON.parse(
		coverageLine.slice("[youtube-diagnostic] coverage ".length),
	) as Record<string, unknown>;
	assert.equal(coverage.stop_reason, "final-proof-invalidated");
	assert.equal(coverage.incomplete, true);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "watch_history" &&
				(message.cursor as Record<string, unknown>)?.complete === true,
		),
		false,
	);
});

test("history end remains unproven when responses invalidate all final refresh retries", async () => {
	const videoIds = ["aaaaaaaaaaa"];
	const { messages, outcome, diagnostics } = await collectFromDocuments(
		() => `${historyCards(videoIds)}${historyBootstrap(videoIds)}`,
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesAfterReadListEnd: [4, 5, 6].map((readNumber) => ({
				readNumber,
				requested: `history-request-${readNumber}`,
				next: `continuation-${readNumber}`,
				initialRequest: true,
			})),
		},
	);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
	const coverageLine = diagnostics.find(
		(line) =>
			line.startsWith("[youtube-diagnostic] coverage ") &&
			line.includes('"stream":"watch_history"'),
	);
	assert.ok(coverageLine);
	const coverage = JSON.parse(
		coverageLine.slice("[youtube-diagnostic] coverage ".length),
	) as Record<string, unknown>;
	assert.equal(coverage.stop_reason, "history-evidence-changed-during-final-refresh");
	assert.equal(coverage.incomplete, true);
	assert.equal(
		messages.some(
			(message) => message.type === "STATE" && message.stream === "watch_history",
		),
		false,
	);
});

test("second unchanged scroll rechecks newly arrived terminal continuation evidence", async () => {
	const videoIds = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
	const { records, messages, outcome } = await collectFromDocuments(
		() => grownHistory(videoIds, 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{},
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: "continuation-D" },
				{ requested: "continuation-D", next: null, itemCount: 1 },
			],
		},
	);
	assert.equal(records.get("watch_history")?.length, videoIds.length);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
	assert.equal(
		(
			messages.find((message) => message.type === "STATE")?.cursor as Record<
				string,
				unknown
			>
		)?.complete,
		true,
	);
});

test("playlist total mismatch cannot be excused by unrelated DOM text", async () => {
	const phrase = "100 unavailable videos are hidden";
	for (const placement of [
		"none",
		"notice",
		"title",
		"description",
		"sidebar",
	]) {
		const rows = Array.from(
			{ length: 4 },
			(_, n) =>
				`<ytd-playlist-video-renderer><a href="/watch?v=vid${String(n).padStart(8, "0")}&list=PL1"></a><h3>V${n}</h3></ytd-playlist-video-renderer>`,
		).join("");
		const rowsWithPhrase =
			placement === "title"
				? rows.replace("<h3>V0</h3>", `<h3>${phrase}</h3>`)
				: placement === "description"
					? rows.replace(
							"<h3>V0</h3>",
							`<h3>V0</h3><div id="description">${phrase}</div>`,
						)
					: rows;
		const data = pageData(
			tabbedData({
				playlistVideoListRenderer: {
					contents: Array.from({ length: 4 }, (_, n) => ({
						playlistVideoRenderer: {
							videoId: `vid${String(n).padStart(8, "0")}`,
						},
					})),
				},
			}),
		);
		const { records, outcome } = await collectFromDocuments(
			() =>
				`${rowsWithPhrase}${headerTotal("5 videos")}${data}${placement === "notice" ? `<div>Unavailable videos are hidden</div>` : placement === "sidebar" ? `<ytd-guide-renderer><span>${phrase}</span></ytd-guide-renderer>` : ""}${END_OF_LIST}`,
			["likes"],
		);
		assert.equal(records.get("likes")?.length, 4);
		assert.deepEqual(outcome("likes"), ["stream_collection_failed"], placement);
	}
});

test("exactly 50 data-backed history rows can end without an end marker", async () => {
	const ids = Array.from(
		{ length: 50 },
		(_, n) => `vid${String(n).padStart(8, "0")}`,
	);
	const rows = ids
		.map(
			(id, n) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const { records, outcome } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: ids.map((contentId) => ({ lockupViewModel: { contentId } })) } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
});

test("delayed DOM rows beyond readable data do not prove completion", async () => {
	const rows = Array.from(
		{ length: 2 },
		(_, n) =>
			`<ytd-playlist-video-renderer><a href="/watch?v=vid${String(n).padStart(8, "0")}&list=PL1"></a><h3>V${n}</h3></ytd-playlist-video-renderer>`,
	).join("");
	const { records, outcome } = await collectFromDocuments(
		() => `${rows}${playlistPageData(1)}`,
		["likes"],
	);
	assert.equal(records.get("likes")?.length, 2);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
});

test("verified empty list evidence is vetoed by current DOM rows or continuation", async () => {
	for (const currentDom of [
		`<ytd-channel-renderer><a id="main-link" href="/@creator"></a><ytd-channel-name><yt-formatted-string id="text">Creator</yt-formatted-string></ytd-channel-name></ytd-channel-renderer>`,
		`<ytd-expanded-shelf-contents-renderer><ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-expanded-shelf-contents-renderer>`,
	]) {
		withBrowserGlobals(
			`${currentDom}${pageData(tabbedData({ sectionListRenderer: { contents: [{ messageRenderer: { text: { simpleText: "No subscriptions" } } }, { richGridRenderer: { contents: [] } }] } }))}`,
			() =>
				assert.equal(enumerationEnded(readListEnd("subscriptions"), 0), false),
			"https://www.youtube.com/feed/channels",
		);
		const { outcome } = await collectFromDocuments(
			() =>
				`${currentDom}${pageData(tabbedData({ sectionListRenderer: { contents: [{ messageRenderer: { text: { simpleText: "No subscriptions" } } }, { richGridRenderer: { contents: [] } }] } }))}`,
			["subscriptions"],
			"empty",
		);
		assert.deepEqual(outcome("subscriptions"), ["stream_collection_failed"]);
	}
});

test("verified empty video evidence is vetoed by current DOM rows or continuation", async () => {
	for (const currentDom of [
		playlistRow,
		`<ytd-playlist-video-list-renderer><ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-playlist-video-list-renderer>`,
	]) {
		withBrowserGlobals(
			`${currentDom}${pageData(
				tabbedData({
					messageRenderer: { text: { simpleText: "No videos" } },
					playlistVideoListRenderer: { contents: [] },
				}),
			)}`,
			() => assert.equal(readListEnd("playlist").verifiedEmpty, false),
		);
		const { outcome } = await collectFromDocuments(
			() =>
				`${currentDom}${pageData(
					tabbedData({
						messageRenderer: { text: { simpleText: "No videos" } },
						playlistVideoListRenderer: { contents: [] },
					}),
				)}`,
			["likes"],
			"empty",
		);
		assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	}
});

const SIDEBAR_EMPTY = { richGridRenderer: { contents: [] } };
const TARGET_NON_EMPTY = {
	playlistVideoListRenderer: {
		contents: [{ playlistVideoRenderer: { videoId: "abc123XYZ0" } }],
	},
};

test("finding 2: an unrelated empty list cannot prove a non-empty target list empty", () => {
	const ready = (html: string) => {
		let state: unknown;
		withBrowserGlobals(html, () => {
			state = readPageReadiness({
				content: "ytd-playlist-video-renderer",
				empty: "ytd-message-renderer",
			});
		});
		return state;
	};
	// An empty list beside the target list in the same tab.
	assert.equal(
		ready(
			pageData(
				tabbedData({
					sectionListRenderer: { contents: [TARGET_NON_EMPTY, SIDEBAR_EMPTY] },
				}),
			),
		),
		false,
		"sibling in the tab",
	);
	// An empty list outside the selected tab: sidebar and a hidden tab.
	assert.equal(
		ready(
			pageData(
				tabbedData(TARGET_NON_EMPTY, { secondaryContents: SIDEBAR_EMPTY }),
			),
		),
		false,
		"sidebar",
	);
	assert.equal(
		ready(
			pageData({
				contents: {
					twoColumnBrowseResultsRenderer: {
						tabs: [
							{ tabRenderer: { selected: true, content: TARGET_NON_EMPTY } },
							{ tabRenderer: { content: SIDEBAR_EMPTY } },
						],
					},
				},
			}),
		),
		false,
		"other tab",
	);
	// An empty section is not a target-bound completion marker for arbitrary lists.
	assert.equal(
		ready(
			pageData(
				tabbedData(SIDEBAR_EMPTY, { secondaryContents: TARGET_NON_EMPTY }),
			),
		),
		false,
		"empty payload without a target end marker",
	);
});

test("finding 2: a non-empty target playlist that has not rendered fails instead of completing empty", async () => {
	const { records, messages, outcome } = await collectFromDocuments(
		() =>
			pageData(
				tabbedData({
					sectionListRenderer: { contents: [TARGET_NON_EMPTY, SIDEBAR_EMPTY] },
				}),
			),
		["likes"],
	);
	assert.equal(records.get("likes")?.length ?? 0, 0);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
});

const PLAYLIST_INDEX = {
	content: 'a[href*="playlist?list="]',
	empty: "ytd-message-renderer",
	playlistIndex: true,
};
const BUILT_IN_LINKS = `<a href="/playlist?list=LL">Liked videos</a><a href="/playlist?list=WL">Watch later</a>`;
const NO_PLAYLISTS = `<ytd-message-renderer>No playlists yet</ytd-message-renderer>`;

test("finding 3: the playlist index counts only the playlists the connector enumerates", () => {
	const ready = (html: string) => {
		let state: unknown;
		withBrowserGlobals(html, () => {
			state = readPageReadiness(PLAYLIST_INDEX);
		});
		return state;
	};
	assert.notEqual(ready(`${BUILT_IN_LINKS}${NO_PLAYLISTS}`), "empty");
	assert.equal(ready(BUILT_IN_LINKS), false);
	assert.equal(
		ready(`${BUILT_IN_LINKS}<a href="/playlist?list=PL1">Mine</a>`),
		"content",
	);
	// An empty-message section beside built-ins is not the playlist grid's end proof.
	assert.equal(
		ready(
			`${BUILT_IN_LINKS}${pageData(
				tabbedData({
					sectionListRenderer: {
						contents: [
							{ lockupViewModel: { contentId: "LL" } },
							{ gridPlaylistRenderer: { playlistId: "WL" } },
							{
								messageRenderer: {
									text: { runs: [{ text: "No playlists yet" }] },
								},
							},
						],
					},
				}),
			)}`,
		),
		false,
	);
});

test("finding 3: readiness and readPlaylistLinks agree on which links are playlists", async () => {
	const { readPlaylistLinks } = await import("./browser-dom.ts");
	const cases = [
		{ html: BUILT_IN_LINKS, ready: false, playlists: 0 },
		{
			html: `${BUILT_IN_LINKS}<a href="/playlist?list=PL1">Mine</a>`,
			ready: true,
			playlists: 1,
		},
		{
			html: `<a href="https://evil.example/playlist?list=PL9">Elsewhere</a>`,
			ready: false,
			playlists: 0,
		},
		{
			html: `<a href="/playlist?list=PL1">A</a><a href="/playlist?list=PL1&amp;x=1">Again</a>`,
			ready: true,
			playlists: 1,
		},
		{
			html: `<yt-lockup-view-model>${BUILT_IN_LINKS}</yt-lockup-view-model>`,
			ready: true,
			playlists: 0,
		},
	];
	for (const { html, ready, playlists } of cases) {
		withBrowserGlobals(html, () => {
			const readiness = readPageReadiness(PLAYLIST_INDEX);
			assert.equal(readiness === "content", ready, html);
			assert.equal(readPlaylistLinks().length, playlists, html);
		});
	}
});

test("built-in lists plus page-data empty evidence complete both playlist streams", async () => {
	const builtIns = (id: "LL" | "WL") => ({
		content: {
			lockupViewModel: {
				contentId: id,
				contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
				rendererContext: {
					commandContext: {
						onTap: { innertubeCommand: { watchEndpoint: { playlistId: id } } },
					},
				},
			},
		},
	});
	const { records, messages, outcome } = await collectFromDocuments(
		() =>
			`<button id="avatar-btn"></button><div id="contents"><yt-lockup-view-model><a href="/playlist?list=WL"></a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model></yt-lockup-view-model><yt-lockup-view-model><a href="/playlist?list=LL"></a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model></yt-lockup-view-model></div>${pageData(
				tabbedData({
					richGridRenderer: {
						contents: [
							{ richItemRenderer: builtIns("WL") },
							{ richItemRenderer: builtIns("LL") },
						],
					},
				}),
			)}`,
		["playlists", "playlist_items"],
	);
	assert.equal(records.size, 0);
	// Desktop requires both declared inventory authority and a matching proof
	// before an empty stream can replace stored data and serve an empty view.
	const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
	assert.equal(manifest.streams.find((stream: { name: string }) => stream.name === "playlist_items").coverage_strategy, "full_inventory");
	assert.deepEqual(messages.find((message) => message.type === "DETAIL_COVERAGE" && message.stream === "playlist_items"), {
		type: "DETAIL_COVERAGE", reference_only: true,
		stream: "playlist_items", state_stream: "playlist_items",
		required_keys: [], hydrated_keys: [], considered: 0, covered: 0,
	});
	assert.deepEqual(outcome("playlists"), ["STATE"]);
	assert.deepEqual(outcome("playlist_items"), ["STATE", "DETAIL_COVERAGE"]);
	assert.equal(
		messages.some((message) => message.reason === "stream_collection_failed"),
		false,
	);
});

test("finding 3: an index of only built-in lists with no empty evidence fails both playlist streams", async () => {
	const { outcome } = await collectFromDocuments(
		() => BUILT_IN_LINKS,
		["playlists", "playlist_items"],
	);
	assert.deepEqual(outcome("playlists"), ["stream_collection_failed"]);
	assert.deepEqual(outcome("playlist_items"), ["stream_collection_failed"]);
});

// ── Review round 2: no completion without the source's own end ──────────────

test("round 2: a header total and source payload larger than the rows read fail the stream", async () => {
	const { records, messages, outcome } = await collectFromDocuments(
		() => `${playlistRow}${headerTotal("3 videos")}${playlistPageData(3)}`,
		["likes"],
	);
	// One valid row was read and emitted. The list is not complete.
	assert.equal(records.get("likes")?.length, 1);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("round 2: a header total that differs from the rows read fails even with no next page", async () => {
	const { records, outcome } = await collectFromDocuments(
		() => `${playlistRow}${headerTotal("5 videos")}${playlistPageData(1)}`,
		["watch_later"],
	);
	assert.equal(records.get("watch_later")?.length, 1);
	assert.deepEqual(outcome("watch_later"), ["stream_collection_failed"]);
});

test("round 2: source entries left unread with no header total fail the stream", async () => {
	const { records, outcome } = await collectFromDocuments(
		() =>
			`${historyRow}${pageData(tabbedData({ sectionListRenderer: { contents: [1, 2, 3].map(() => ({ lockupViewModel: { contentId: "aaaaaaaaaaa" } })) } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
});

test("round 2: a next page in the source data with no rendered control is not an end", async () => {
	const { records, outcome } = await collectFromDocuments(
		() =>
			`${historyRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
});

test("round 2: no stream is ever reported as a bounded browser snapshot", async () => {
	const { messages } = await collectFromDocuments(
		() => `${playlistRow}${playlistPageData(1, true)}`,
		["likes", "watch_later", "watch_history"],
	);
	assert.equal(
		messages.some((message) => message.reason === "bounded_browser_snapshot"),
		false,
	);
	assert.equal(
		messages.filter((message) => message.reason === "stream_collection_failed")
			.length,
		3,
	);
});

// ── Review round 3: unreadable regions and exact-limit lists ────────────────

test("round 3: a page-data region with no recognized list does not prove completion", async () => {
	const regions = [
		{ contents: {} },
		{
			contents: {
				messageRenderer: { text: { simpleText: "Something went wrong" } },
			},
		},
	];
	const runs = await Promise.all(
		regions.map((data) =>
			collectFromDocuments(() => `${playlistRow}${pageData(data)}`, ["likes"]),
		),
	);
	for (const { records, messages, outcome } of runs) {
		assert.equal(records.get("likes")?.length, 1);
		assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
		assert.equal(
			messages.some((message) => message.type === "STATE"),
			false,
		);
	}
});

test("round 3: exactly 50 complete history items with source-end evidence complete the stream", async () => {
	const ids = Array.from(
		{ length: 50 },
		(_, n) => `vid${String(n).padStart(8, "0")}`,
	);
	const rows = ids
		.map(
			(id, n) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const { records, outcome } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: ids.map((contentId) => ({ lockupViewModel: { contentId } })) } }))}${END_OF_LIST}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), ["STATE"]);
});

test("exactly 50 history items with a next page pending checkpoint partial progress", async () => {
	const ids = Array.from(
		{ length: 50 },
		(_, n) => `vid${String(n).padStart(8, "0")}`,
	);
	const rows = ids
		.map(
			(id, n) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const { records, outcome } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...ids.map((contentId) => ({ lockupViewModel: { contentId } })), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), [
		"stream_collection_failed",
		"STATE",
	]);
});

test("playlist items prove empty only after every owned playlist and the index end", async () => {
 for (const unreadable of [false, true]) {
  const { records, messages } = await collectFromDocuments(
   (url) => url.includes("feed/playlists")
    ? `${SIGNED_IN}<a href="/playlist?list=PL1">My list</a>${pageData(tabbedData({ gridRenderer: { items: [{ gridPlaylistRenderer: { playlistId: "PL1" } }] } }))}${END_OF_PLAYLIST_INDEX}`
    : unreadable ? `${SIGNED_IN}<main>Loading</main>`
    : `${SIGNED_IN}<ytd-message-renderer>No videos</ytd-message-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ messageRenderer: { text: { simpleText: "No videos" } } }] } }] } }))}`,
   ["playlist_items"],
  );
  assert.equal(records.size, 0);
  const proof = messages.find((message) => message.type === "DETAIL_COVERAGE");
  assert.equal(Boolean(proof), !unreadable);
  if (proof) assert.equal(proof.considered, 0);
 }
});

test("a gzip request body carrying a 5000-character token correlates the history response", async () => {
	const videoIds = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
	const token = "T".repeat(5000);
	for (const gzipRequestBodies of [true, false]) {
		const { records, messages, outcome } = await collectFromDocuments(
			() => grownHistory(videoIds, 1, token),
			["watch_history"],
			undefined,
			{},
			{
				gzipRequestBodies,
				historyResponsesOnScroll: [
					{ requested: token, next: null, itemCount: 1 },
				],
			},
		);
		assert.equal(records.get("watch_history")?.length, videoIds.length);
		// Uncorrelated, the terminal response would not prove the end and no
		// complete STATE would follow.
		assert.deepEqual(outcome("watch_history"), ["STATE"], `gzip=${gzipRequestBodies}`);
		const cursor = messages.find((message) => message.type === "STATE")
			?.cursor as Record<string, unknown>;
		assert.equal(cursor.complete, true);
		assert.equal(cursor.evidence, "latest-history-response");
	}
});

test("a failed history read carries bounded diagnostics and no row values", async () => {
	const token = "SECRET-TOKEN-" + "z".repeat(40);
	const videoIds = ["secretVid001", "secretVid002"];
	const { messages } = await collectFromDocuments(
		() => `${historyCards(videoIds)}${historyBootstrap(videoIds, token)}`,
		["watch_history"],
	);
	const failure = messages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "watch_history",
	);
	assert.ok(failure, "history must end failed with no response proof");
	const diagnostics = failure.diagnostics as Record<string, unknown>;
	assert.deepEqual(Object.keys(diagnostics).sort(), [
		"blocked",
		"browse_total",
		"correlated",
		"deduped_count",
		"foreign",
		"non_2xx",
		"parsed_count",
		"phase",
		"proof_kind",
		"safe_prefix",
		"scanned_count",
		"stop_reason",
		"tracking_complete",
		"uncorrelated",
		"unrecognized",
	]);
	assert.equal(diagnostics.stop_reason, "stalled");
	assert.equal(diagnostics.parsed_count, 2);
	assert.equal(diagnostics.safe_prefix, true);
	assert.equal(diagnostics.blocked, false);
	assert.equal(diagnostics.proof_kind, "unproven");
	assert.equal(diagnostics.correlated, 0);
	assert.equal(diagnostics.tracking_complete, true);
	for (const value of Object.values(diagnostics))
		assert.ok(["string", "number", "boolean"].includes(typeof value) || value === null);
	const text = JSON.stringify(diagnostics);
	for (const secret of [token, ...videoIds, "youtube.com", "Seen"])
		assert.equal(text.includes(secret), false, secret);
});

// --- history proof rules: blind logs, vetoes, readable scans, request keys ---

/** The page shows `ids`; the first rows came from the bootstrap, the rest from responses. */
const grownHistory = (ids: string[], fromResponses: number, token?: string) =>
	`${historyCards(ids)}${historyBootstrap(ids.slice(0, ids.length - fromResponses), token)}`;

const historyStateMessages = (messages: Record<string, unknown>[]) =>
	messages.filter(
		(message) => message.type === "STATE" && message.stream === "watch_history",
	);

const historyStopReason = (diagnostics: string[]): unknown => {
	const line = diagnostics.find(
		(entry) =>
			entry.startsWith("[youtube-diagnostic] coverage ") &&
			entry.includes('"stream":"watch_history"'),
	);
	return line
		? (
				JSON.parse(line.slice("[youtube-diagnostic] coverage ".length)) as Record<
					string,
					unknown
				>
			).stop_reason
		: undefined;
};

const completeCursorEmitted = (messages: Record<string, unknown>[]) =>
	historyStateMessages(messages).some(
		(message) => (message.cursor as Record<string, unknown>)?.complete === true,
	);

test("page log: a terminal logged response with rows the log never saw is blind and emits no STATE", async () => {
	// The bootstrap holds 1 row and the logged response carries 1, but the page
	// shows 3: a fetch captured before the wrapper delivered a row unseen.
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"], 2, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{ pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]] },
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-log-blind");
});

test("page log: a terminal logged response that accounts for every row still proves the end", async () => {
	const { messages } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{ pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]] },
	);
	assert.equal(completeCursorEmitted(messages), true);
});

test("page log: a continuation still shown after the terminal logged response is blind", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() =>
			`${grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C")}<ytd-item-section-renderer><ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer>`,
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{ pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]] },
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-log-blind");
});

test("page log: an uncorrelated browse call after the terminal response vetoes STATE", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			pageLogOnScroll: [
				[loggedResponse("bootstrap-C", 1, null), loggedUncorrelated()],
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-failed");
});

test("an uncorrelated browse call arriving after the terminal response vetoes STATE on Desktop", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
			historyResponsesAfterReadListEnd: [
				{ readNumber: 4, requested: "stray-token", next: null },
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-uncorrelated");
});

test("a correlated non-2xx history response falls back to no DOM or bootstrap proof", async () => {
	const ids = ["aaaaaaaaaaa"];
	const { messages, diagnostics } = await collectFromDocuments(
		() => `${historyCards(ids)}${historyBootstrap(ids)}`,
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnGoto: [
				{ requested: "initial", next: null, initialRequest: true, status: 500 },
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-non-2xx");
});

test("a correlated non-2xx response stays a veto after a later terminal response", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnGoto: [
				{ requested: "initial", next: null, initialRequest: true, status: 500 },
			],
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-non-2xx");
});

test("a response with a list key but no readable rows or continuation cannot prove the end", async () => {
	const ids = ["aaaaaaaaaaa"];
	const { messages } = await collectFromDocuments(
		() => `${historyCards(ids)}${historyBootstrap(ids, "bootstrap-C")}`,
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{ historyResponsesOnScroll: [{ requested: "bootstrap-C", next: null }] },
	);
	assert.equal(completeCursorEmitted(messages), false);
});

test("a request carrying both browseId and a continuation is correlated by its token: a known token correlates, an unknown one vetoes", async () => {
	const run = (continuation: string) => collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{
					requested: continuation,
					next: null,
					itemCount: 1,
					requestBody: { browseId: "FEhistory", continuation },
				},
			],
		},
	);
	const [known, unknown] = await Promise.all([run("bootstrap-C"), run("unseen")]);
	assert.equal(completeCursorEmitted(known.messages), true);
	assert.equal(completeCursorEmitted(unknown.messages), false);
});

test("a content-encoding that merely contains gzip is not a gzip body", async () => {
	const { messages } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{
					requested: "bootstrap-C",
					next: null,
					itemCount: 1,
					contentEncoding: "x-not-gzip",
				},
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), true);
});

test("a gzip token in a content-encoding list still decodes the body", async () => {
	const { messages } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			gzipRequestBodies: true,
			historyResponsesOnScroll: [
				{
					requested: "bootstrap-C",
					next: null,
					itemCount: 1,
					contentEncoding: "identity, GZIP",
				},
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), true);
});

// --- a foreign browse call is not unseen history; a veto still keeps the prefix ---

const loggedForeign = (browseId: string): LoggedEntry => ({
	requestBody: { browseId },
	status: 200,
	summary: {
		recognized: false,
		hasContinuation: false,
		itemCount: 0,
		nextContinuation: null,
	},
});

const browseDiagnostic = (diagnostics: string[]): Record<string, unknown> =>
	JSON.parse(
		(
			diagnostics.find((line) =>
				line.startsWith("[youtube-diagnostic] history_browse "),
			) ?? ""
		).slice("[youtube-diagnostic] history_browse ".length) || "{}",
	) as Record<string, unknown>;

test("a request for another page after the terminal response is foreign and still allows STATE", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
			historyResponsesAfterReadListEnd: [
				{
					readNumber: 4,
					requested: "other",
					next: null,
					requestBody: { browseId: "FEsubscriptions" },
				},
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), true);
	assert.equal(browseDiagnostic(diagnostics).foreign, 1);
});

test("page log: a request for another page after the terminal response is foreign and still allows STATE", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			pageLogOnScroll: [
				[loggedResponse("bootstrap-C", 1, null), loggedForeign("FEsubscriptions")],
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), true);
	assert.equal(browseDiagnostic(diagnostics).foreign, 1);
});

test("an unknown continuation token still vetoes STATE, with or without a browseId", async () => {
	for (const requestBody of [
		{ continuation: "stray-token" },
		{ browseId: "FEsubscriptions", continuation: "stray-token" },
	]) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 1 },
				],
				historyResponsesAfterReadListEnd: [
					{ readNumber: 4, requested: "stray-token", next: null, requestBody },
				],
			},
		);
		assert.equal(completeCursorEmitted(messages), false, JSON.stringify(requestBody));
		assert.equal(historyStopReason(diagnostics), "history-browse-uncorrelated");
	}
});

test("a vetoed run keeps its partial checkpoint", async () => {
	const ids = Array.from(
		{ length: 50 },
		(_, n) => `vid${String(n).padStart(8, "0")}`,
	);
	const rows = ids
		.map(
			(id, n) =>
				`<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
		)
		.join("");
	const page = () =>
		`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...ids.map((contentId) => ({ lockupViewModel: { contentId } })), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`;
	for (const stray of [false, true]) {
		const { messages, outcome, diagnostics } = await collectFromDocuments(
			page,
			["watch_history"],
			undefined,
			{},
			stray
				? {
						historyResponsesOnGoto: [
							{ requested: "stray-token", next: "more", itemCount: 0 },
						],
					}
				: {},
		);
		assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"], `stray=${stray}`);
		assert.equal(completeCursorEmitted(messages), false);
		if (stray) assert.equal(historyStopReason(diagnostics), "history-browse-uncorrelated");
	}
});

// --- in-flight browse requests, foreign evidence, nested rows, error names ---

test("a history browse still in flight during the final refresh leaves the run not complete", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
			browseRequestsOnScroll: ["hang"],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-in-flight");
});

test("a history browse that failed is no longer in flight, but it vetoes completion", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
			browseRequestsOnScroll: ["fail"],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	// Settled, so not the in-flight reason; a transport failure is its own sticky veto.
	assert.equal(historyStopReason(diagnostics), "history-browse-failed");
});

test("page log: a history browse the page started and never finished leaves the run not complete", async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]],
			pageLogHangOnScroll: 1,
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-browse-in-flight");
});

test("a foreign-looking request is ignored only when its response shows no rows and no continuation", async () => {
	const body = { browseId: "FEsubscriptions" };
	const cases: Array<{ name: string; spec: Partial<HistoryResponseSpec> }> = [
		{ name: "a row", spec: { itemCount: 2 } },
		{ name: "a continuation", spec: { next: "more" } },
		{ name: "a non-2xx status", spec: { status: 500 } },
	];
	for (const { name, spec } of cases) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 1 },
				],
				historyResponsesAfterReadListEnd: [
					{ readNumber: 4, requested: "other", next: spec.next ?? null, requestBody: body, ...spec },
				],
			},
		);
		assert.equal(completeCursorEmitted(messages), false, name);
		assert.equal(browseDiagnostic(diagnostics).foreign, 0, name);
	}
});

test("page log: a foreign-looking request with a row or an unreadable body vetoes", async () => {
	for (const entry of [
		{ ...loggedForeign("FEsubscriptions"), summary: { recognized: true, hasContinuation: false, itemCount: 5, nextContinuation: null } },
		{ ...loggedForeign("FEsubscriptions"), summary: null },
		{ ...loggedForeign("FEsubscriptions"), status: 500 },
	]) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{ pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null), entry]] },
		);
		assert.equal(completeCursorEmitted(messages), false);
		assert.equal(historyStopReason(diagnostics), "history-browse-uncorrelated");
	}
});

test("a row nested in another row is one row, so the Desktop end still holds", async () => {
	const { messages } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1, nested: true },
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), true);
});

test("an exception names only a fixed error vocabulary", async () => {
	const cases: Array<[unknown, string]> = [
		[new TypeError("x"), "TypeError"],
		[Object.assign(new Error("x"), { name: "secret-video-id-abc" }), "other"],
		["a string", "non-error"],
	];
	for (const [thrown, expected] of cases) {
		const { messages } = await collectFromDocuments(
			() => "",
			["watch_history"],
			undefined,
			{},
			{ gotoError: thrown as Error },
		);
		const failure = messages.find(
			(message) => message.type === "SKIP_RESULT" && message.stream === "watch_history",
		);
		const diagnostics = failure?.diagnostics as Record<string, unknown> | undefined;
		assert.equal(diagnostics?.error_name, expected);
	}
});

// --- failed requests and stalled bodies ---

test("a failed history browse request vetoes completion, whatever it looked like", async () => {
	const bodies: Array<Record<string, unknown> | null> = [
		{ continuation: "bootstrap-C" },
		{ browseId: "FEhistory" },
		null,
		{ browseId: "FEsubscriptions" },
	];
	for (const failBody of bodies) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 1 },
				],
				browseRequestsOnScroll: [{ failBody }],
			},
		);
		assert.equal(completeCursorEmitted(messages), false, JSON.stringify(failBody));
		assert.match(
			String(historyStopReason(diagnostics)),
			/^history-browse-(non-2xx|uncorrelated|failed)$/,
			JSON.stringify(failBody),
		);
	}
});

test("a failed history browse request keeps the partial checkpoint", async () => {
	const ids = Array.from({ length: 50 }, (_, n) => `vid${String(n).padStart(8, "0")}`);
	const rows = ids
		.map((id, n) => `<yt-lockup-view-model><a href="/watch?v=${id}"></a><h3>V${n}</h3></yt-lockup-view-model>`)
		.join("");
	const { outcome, messages } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...ids.map((contentId) => ({ lockupViewModel: { contentId } })), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } }] } }))}`,
		["watch_history"],
		undefined,
		{},
		{ browseRequestsOnScroll: [{ failBody: { continuation: "next" } }] },
	);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"]);
	assert.equal(completeCursorEmitted(messages), false);
});

test("page log: a fetch that failed is recorded and vetoes completion", async () => {
	for (const requestBody of [{ continuation: "bootstrap-C" }, null]) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				pageLogOnScroll: [
					[
						loggedResponse("bootstrap-C", 1, null),
						{ requestBody, status: 0, summary: null },
					],
				],
			},
		);
		assert.equal(completeCursorEmitted(messages), false);
		assert.match(
			String(historyStopReason(diagnostics)),
			/^history-browse-(non-2xx|uncorrelated|failed)$/,
		);
	}
});

test("a response body that stalls after its headers ends the run unproven, not hung", { timeout: 30_000 }, async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1, jsonHangs: true },
			],
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-response-unreadable");
});

// --- unresolved failures, bounded reads, XHR ---

test("a failed browse queued before the terminal reply still vetoes completion", async () => {
	for (const failBody of [null, { browseId: "FEsubscriptions" }]) {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				browseRequestsFirst: true,
				browseRequestsOnScroll: [{ failBody }],
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 1 },
				],
			},
		);
		assert.equal(completeCursorEmitted(messages), false, JSON.stringify(failBody));
		assert.equal(historyStopReason(diagnostics), "history-browse-failed");
	}
});

test("a gzip request decode that never resolves ends the run unproven, not hung", { timeout: 40_000 }, async () => {
	const Real = globalThis.DecompressionStream;
	(globalThis as Record<string, unknown>).DecompressionStream = class {
		readonly readable: ReadableStream;
		readonly writable: WritableStream;
		constructor() {
			const stream = new TransformStream({
				flush: () => new Promise<void>(() => undefined),
			});
			this.readable = stream.readable;
			this.writable = stream.writable;
		}
	};
	try {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				gzipRequestBodies: true,
				historyResponsesOnScroll: [
					{ requested: "bootstrap-C", next: null, itemCount: 1 },
				],
			},
		);
		assert.equal(completeCursorEmitted(messages), false);
		assert.equal(historyStopReason(diagnostics), "history-browse-uncorrelated");
	} finally {
		(globalThis as Record<string, unknown>).DecompressionStream = Real;
	}
});

test("a final-refresh evaluate that never resolves ends the run unproven, not hung", { timeout: 40_000 }, async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			historyResponsesOnScroll: [
				{ requested: "bootstrap-C", next: null, itemCount: 1 },
			],
			hangReadListEndFrom: 5,
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-evidence-timeout");
});

test("page log: a drain evaluate that never resolves ends the run unproven, not hung", { timeout: 40_000 }, async () => {
	const { messages, diagnostics } = await collectFromDocuments(
		() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
		["watch_history"],
		undefined,
		{ watch_history: { complete: false } },
		{
			pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]],
			hangDrainFrom: 3,
		},
	);
	assert.equal(completeCursorEmitted(messages), false);
	assert.equal(historyStopReason(diagnostics), "history-evidence-timeout");
});

test("a Desktop evaluate that never resolves inside the walk ends it with a partial checkpoint, not a hang", { timeout: 20_000 }, async () => {
	const previous = setHistoryLoopCallDeadlineMsForTest(50);
	try {
		const { messages, outcome, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{ hangReadListEndFrom: 3 },
		);
		assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"]);
		assert.equal(completeCursorEmitted(messages), false);
		assert.equal(historyStopReason(diagnostics), "history-loop-timeout");
	} finally {
		setHistoryLoopCallDeadlineMsForTest(previous);
	}
});

test("a record callback that never settles fails the walk closed, with no checkpoint", { timeout: 20_000 }, async () => {
	const previous = setHistoryLoopCallDeadlineMsForTest(50);
	recordCallbackHangs = true;
	try {
		const { messages, outcome, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
		);
		assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
		assert.equal(completeCursorEmitted(messages), false);
		assert.equal(historyStopReason(diagnostics), "history-record-timeout");
	} finally {
		recordCallbackHangs = false;
		setHistoryLoopCallDeadlineMsForTest(previous);
	}
});

test("page log: a drain wait that never returns leaves the evidence incomplete", { timeout: 20_000 }, async () => {
	const previous = setHistoryLoopCallDeadlineMsForTest(50);
	try {
		const { messages, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				pageLogOnScroll: [[loggedResponse("bootstrap-C", 1, null)]],
				pageLogHangOnScroll: 1,
				hangDrainWait: true,
			},
		);
		assert.equal(completeCursorEmitted(messages), false);
		assert.equal(historyStopReason(diagnostics), "history-evidence-timeout");
	} finally {
		setHistoryLoopCallDeadlineMsForTest(previous);
	}
});

test("a scroll evaluation dispatched after the walk stopped does not scroll", { timeout: 20_000 }, async () => {
	const previous = setHistoryLoopCallDeadlineMsForTest(50);
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let page: DocumentPage | undefined;
	try {
		const { outcome, diagnostics } = await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{ scrollGate: gate },
			(created) => {
				page = created;
			},
		);
		assert.deepEqual(outcome("watch_history"), ["stream_collection_failed", "STATE"]);
		assert.equal(historyStopReason(diagnostics), "history-loop-timeout");
		release();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(page?.scrollByCount, 0);
	} finally {
		release();
		setHistoryLoopCallDeadlineMsForTest(previous);
	}
});

test("a stalled setup step fails the walk closed with nothing emitted", { timeout: 20_000 }, async () => {
	const previous = setHistoryLoopCallDeadlineMsForTest(50);
	try {
		for (const setupStall of ["hydration", "wait", "jsonValue", "dispose"] as const) {
			const { records, messages, outcome } = await collectFromDocuments(
				() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
				["watch_history"],
				undefined,
				{ watch_history: { complete: false } },
				{ setupStall },
			);
			assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"], setupStall);
			assert.equal(
				messages.find((message) => message.stream === "watch_history")?.message,
				"youtube_history_setup_timeout",
				setupStall,
			);
			assert.equal(records.get("watch_history")?.length ?? 0, 0, setupStall);
			assert.equal(messages.some((message) => message.type === "STATE"), false, setupStall);
		}
	} finally {
		setHistoryLoopCallDeadlineMsForTest(previous);
	}
});

async function collectUnderOuterDeadline(pageOptions: ConstructorParameters<typeof DocumentPage>[2]) {
	const previous = setHistoryOuterDeadlineMsForTest(300);
	try {
		return await collectFromDocuments(
			() => grownHistory(["aaaaaaaaaaa", "bbbbbbbbbbb"], 1, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			pageOptions,
		);
	} finally {
		setHistoryOuterDeadlineMsForTest(previous);
	}
}

test("the outer deadline ends a history path whose browser-date evaluation or navigation never settles", { timeout: 20_000 }, async () => {
	for (const pageOptions of [{ hangBrowserDate: true }, { gotoHangs: true }]) {
		const { records, messages, outcome } = await collectUnderOuterDeadline(pageOptions);
		const label = JSON.stringify(pageOptions);
		assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"], label);
		assert.equal(
			messages.find((message) => message.stream === "watch_history")?.message,
			"youtube_history_outer_timeout",
			label,
		);
		assert.equal(records.get("watch_history")?.length ?? 0, 0, label);
		assert.equal(messages.some((message) => message.type === "STATE"), false, label);
	}
});

test("a STATE sink that never acknowledges is reported as an unknown outcome, not success", { timeout: 20_000 }, async () => {
	stateSinkHangs = true;
	try {
		const { messages, outcome } = await collectUnderOuterDeadline({});
		assert.ok(outcome("watch_history").includes("stream_collection_failed"));
		const failure = messages.find(
			(message) => message.message === "youtube_history_state_unacknowledged",
		);
		assert.ok(failure);
		assert.equal((failure?.diagnostics as Record<string, unknown>)?.outcome, "unknown");
		assert.equal(messages.some((message) => message.type === "STATE"), false);
	} finally {
		stateSinkHangs = false;
	}
});

test("a slow walk that keeps progressing for longer than the window still completes", { timeout: 20_000 }, async () => {
	const ids = Array.from({ length: 8 }, (_, n) => `slowvid${String(n).padStart(4, "0")}`);
	// Eight rows at 120 ms each take about 1 s, over three times the 300 ms
	// window, but no gap between acknowledged rows is longer than the window.
	recordCallbackDelayMs = 120;
	const previous = setHistoryOuterDeadlineMsForTest(300);
	try {
		const { messages, outcome } = await collectFromDocuments(
			() => grownHistory(ids, 7, "bootstrap-C"),
			["watch_history"],
			undefined,
			{ watch_history: { complete: false } },
			{
				historyResponsesOnScroll: [{ requested: "bootstrap-C", next: null, itemCount: 7 }],
			},
		);
		assert.equal(completeCursorEmitted(messages), true);
		assert.equal(outcome("watch_history").includes("stream_collection_failed"), false);
	} finally {
		recordCallbackDelayMs = 0;
		setHistoryOuterDeadlineMsForTest(previous);
	}
});

test("a stalled failure sink or a stalled coverage sink still lets collection settle after an expiry", { timeout: 20_000 }, async () => {
	const previous = setHistoryExpirySinkDeadlineMsForTest(100);
	try {
		for (const stall of ["failure", "progress"] as const) {
			failureSinkHangs = stall === "failure";
			progressSinkHangs = stall === "progress";
			const { messages, diagnostics } = await collectUnderOuterDeadline({ hangBrowserDate: true });
			assert.equal(messages.some((message) => message.type === "STATE"), false, stall);
			assert.ok(
				diagnostics.some(
					(line) =>
						line.includes("history_expiry_sink") &&
						line.includes(stall === "failure" ? "failure-report" : "coverage-progress") &&
						line.includes('"outcome":"unknown"'),
				),
				stall,
			);
		}
	} finally {
		failureSinkHangs = false;
		progressSinkHangs = false;
		setHistoryExpirySinkDeadlineMsForTest(previous);
	}
});

test("a scan that keeps returning the same rows lets the no-progress watchdog expire", { timeout: 20_000 }, async () => {
	const previous = setHistoryOuterDeadlineMsForTest(300);
	try {
		const progress = new HistoryRunProgress();
		const ticker = setInterval(() => progress.rows(["aaaaaaaaaaa", "bbbbbbbbbbb"]), 50);
		try {
			assert.equal(
				await raceNoProgress(new Promise<void>(() => undefined), progress),
				"expired",
			);
		} finally {
			clearInterval(ticker);
		}
		// New identities on every scan keep the same window open until the work ends.
		const moving = new HistoryRunProgress();
		let next = 0;
		const mover = setInterval(() => moving.rows([`row${next++}`]), 50);
		try {
			assert.equal(
				await raceNoProgress(new Promise<void>((resolve) => setTimeout(resolve, 900)), moving),
				"done",
			);
		} finally {
			clearInterval(mover);
		}
	} finally {
		setHistoryOuterDeadlineMsForTest(previous);
	}
});

test("a second run on the same page does not see the first run's progress hook", { timeout: 20_000 }, async () => {
	const previous = setHistoryOuterDeadlineMsForTest(300);
	try {
		const first = new HistoryRunProgress();
		assert.equal(await raceNoProgress(Promise.resolve(), first), "done");
		const second = new HistoryRunProgress();
		// A late event from the finished first run must not re-arm the second.
		const late = setInterval(() => first.rows([`late${Math.random()}`]), 50);
		try {
			assert.equal(
				await raceNoProgress(new Promise<void>(() => undefined), second),
				"expired",
			);
		} finally {
			clearInterval(late);
		}
		// A run that fails still closes its channel.
		const failing = new HistoryRunProgress();
		await assert.rejects(raceNoProgress(Promise.reject(new Error("boom")), failing));
		let rearmed = false;
		failing.open(() => {
			rearmed = true;
		});
		failing.close();
		failing.rows(["x"]);
		assert.equal(rearmed, false);
	} finally {
		setHistoryOuterDeadlineMsForTest(previous);
	}
});

test("a walk stopped at the time budget and resumed equals one full walk", { timeout: 30_000 }, async () => {
	const videos = Array.from({ length: 110 }, (_, i) => ({
		...VIDEO,
		video_id: `video${i}`,
		video_url: `https://www.youtube.com/watch?v=video${i}`,
	}));
	const run = async (state: Record<string, unknown>, jumpAfter?: number) => {
		const records: Record<string, unknown>[] = [];
		const messages: Record<string, unknown>[] = [];
		const failures: string[] = [];
		const realNow = performance.now.bind(performance);
		let jumped = false;
		performance.now = () => realNow() + (jumped ? 400_000 : 0);
		try {
			await collectYoutubeBrowser({
				page: historyFixturePage(videos) as never,
				requested: new Map([["watch_history", { name: "watch_history" }]]) as never,
				state,
				emitRecord: async (_stream, data) => {
					records.push(data);
					if (jumpAfter !== undefined && records.length === jumpAfter) jumped = true;
				},
				emit: async (message) => {
					messages.push(message as Record<string, unknown>);
				},
				reportStreamFailure: async (_stream, message) => {
					failures.push(message);
				},
				progress: async () => undefined,
			});
		} finally {
			performance.now = realNow;
		}
		return { ids: records.map((record) => record.video_id as string), messages, failures };
	};
	const full = await run({});
	const stopped = await run({}, 50);
	assert.ok(stopped.ids.length < full.ids.length, "the first run must stop early");
	assert.equal(completeCursorEmitted(stopped.messages), false);
	const cursor = historyStateMessages(stopped.messages).at(-1)?.cursor;
	assert.ok(cursor, "the stopped run checkpoints");
	const resumed = await run({ watch_history: cursor });
	// The resumed run replays the accounted prefix as idempotent upserts (the
	// walk never trusts a position above the saved identity). So "no duplicate"
	// holds per run, and the rows keyed by id equal one full walk: no gap.
	for (const ids of [full.ids, stopped.ids, resumed.ids])
		assert.equal(new Set(ids).size, ids.length);
	const merged = new Map<string, number>();
	for (const id of [...stopped.ids, ...resumed.ids]) merged.set(id, (merged.get(id) ?? 0) + 1);
	assert.deepEqual([...merged.keys()].sort(), [...full.ids].sort());
	assert.ok(resumed.ids.length >= full.ids.length - stopped.ids.length);
	assert.equal(completeCursorEmitted(resumed.messages), true);
});
