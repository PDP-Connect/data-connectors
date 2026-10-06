// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
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
} from "./index.ts";
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

function withBrowserGlobals(html: string, run: () => void): void {
	const { document, window } = parseHTML(html);
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
function failureReporter(messages: Record<string, unknown>[]) {
	return async (stream: string, message: string) => {
		messages.push({
			type: "SKIP_RESULT",
			stream,
			reason: "stream_collection_failed",
			message,
		});
	};
}

class FixturePage {
	url = "";
	private readonly waitStates: Array<
		"content" | "empty" | "json-empty" | "unreadable"
	>;
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
		return { first: () => ({ click: async () => undefined }) };
	}
	async waitForTimeout() {
		/* fixture has no renderer delay */
	}
	async waitForFunction() {
		const state = this.waitStates.shift() ?? "content";
		if (state === "unreadable") throw new Error("fixture page read timed out");
		if (state === "json-empty")
			return { jsonValue: async () => "empty", dispose: async () => undefined };
		return { jsonValue: async () => state, dispose: async () => undefined };
	}
	async evaluate(fn: Function): Promise<any> {
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
		if (fn.name === "readVideos") return [{ ...VIDEO }];
		return undefined;
	}
}

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

	assert.equal(skips.length, 3);
	assert.equal(skips[0]?.reason, "youtube_profile_account_header_unreadable");
	assert.ok(
		skips.slice(1).every((skip) => skip.reason === "stream_collection_failed"),
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

test("history is the first 50 visible records in page order with no timestamp cursor", async () => {
	const page = new FixturePage();
	page.evaluate = async (fn: Function) =>
		fn.name === "readVideos"
			? Array.from({ length: 60 }, (_, i) => ({
					...VIDEO,
					video_id: `video${i}`,
					video_url: `https://www.youtube.com/watch?v=video${i}`,
				}))
			: undefined;
	const history: Record<string, unknown>[] = [];
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
			emit: async () => undefined,
			reportStreamFailure: async () => undefined,
			progress: async (message) => {
				progress.push(message);
			},
		});
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	assert.equal(history.length, 50);
	assert.equal(history[0]?.video_id, "video0");
	assert.equal(history[49]?.video_id, "video49");
	assert.equal(history[49]?.position, 49);
	assert.equal("watched_at" in history[0]!, false);

	const prefix = "[youtube-diagnostic] coverage ";
	const coverageLines = diagnostics.filter((line) => line.startsWith(prefix));
	assert.equal(coverageLines.length, 1);
	assert.deepEqual(JSON.parse(coverageLines[0]!.slice(prefix.length)), {
		stream: "watch_history",
		requested: true,
		source: "browser",
		emitted_count: 50,
		time_range_requested: false,
		enumerated_count: 50,
		limit: 50,
		skipped_unresolved_date_count: 0,
	});
	assert.doesNotMatch(
		diagnostics.join("\n"),
		/Real video title|Creator|youtube\.com|abc123XYZ0/,
	);
	assert.deepEqual(progress, ["Finished YouTube: 50 items saved"]);
	assertUserFacingProgress(
		progress.map((message) => ({ type: "PROGRESS", message })),
	);
});

test("repeated history videos keep the first page occurrence and one primary key", async () => {
	const page = new FixturePage();
	page.evaluate = async (fn: Function) =>
		fn.name === "readVideos"
			? [
					{ ...VIDEO, watched_date_label: "Today" },
					{ ...VIDEO, watched_date_label: "Yesterday" },
				]
			: undefined;
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
	assert.equal(history.length, 1);
	assert.equal(history[0]?.position, 0);
	assert.equal(history[0]?.watched_date_label, "Today");
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

test("page readiness treats ytInitialData empty contents as positive empty evidence", () => {
	withBrowserGlobals(
		`<script>var ytInitialData = {"contents":{"twoColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"richGridRenderer":{"contents":[]}}}}]}}};</script>`,
		() => {
			assert.equal(
				readPageReadiness({
					content: "yt-lockup-view-model",
					empty: "ytd-message-renderer",
				}),
				"empty",
			);
		},
	);
});

test("page readiness treats explicit YouTube empty renderers in JSON as positive empty evidence", () => {
	withBrowserGlobals(
		`<script>var ytInitialData = {"contents":{"messageRenderer":{"text":{"runs":[{"text":"No videos yet"}]}}}};</script>`,
		() => {
			assert.equal(
				readPageReadiness({
					content: "yt-lockup-view-model",
					empty: "ytd-message-renderer",
				}),
				"empty",
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
			failures.push([stream, options]);
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
			failures.push([stream, options]);
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
							failures.push([name, options]);
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
						message.type !== "STATE" &&
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
					failures.push([name, options]);
				},
				progress: async () => undefined,
			});
			assert.deepEqual(failures, [[stream, { retryable: true }]], stream);
		}),
	);
});

test("empty-state JSON text may contain braces and escaped quotes", () => {
	const data = {
		contents: {
			messageRenderer: { text: { simpleText: 'No videos } yet "saved"' } },
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
			failures.push([stream, options]);
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

/** Runs the connector's real page functions against parsed HTML, one page per URL. */
class DocumentPage {
	url = "";
	private readonly pageFor: (url: string) => string;
	constructor(pageFor: (url: string) => string) {
		this.pageFor = pageFor;
	}
	async goto(url: string) {
		this.url = url;
	}
	locator() {
		return { first: () => ({ click: async () => undefined }) };
	}
	async waitForTimeout() {
		/* no renderer delay */
	}
	private inPage<T>(run: () => T): T {
		const { document, window } = parseHTML(this.pageFor(this.url));
		(window as unknown as { scrollBy: () => void }).scrollBy = () => undefined;
		const globals = globalThis as Record<string, unknown>;
		const previous = { document: globals.document, window: globals.window };
		globals.document = document;
		globals.window = window;
		try {
			return run();
		} finally {
			globals.document = previous.document;
			globals.window = previous.window;
		}
	}
	async waitForFunction(fn: Function, arg: unknown) {
		const value = this.inPage(() => fn(arg));
		if (!value) throw new Error("page read timed out");
		return { jsonValue: async () => value, dispose: async () => undefined };
	}
	async evaluate(fn: Function, arg?: unknown) {
		return this.inPage(() => fn(arg));
	}
}

async function collectFromDocuments(
	pageFor: (url: string) => string,
	streams: string[],
) {
	const records = new Map<string, Record<string, unknown>[]>();
	const messages: Record<string, unknown>[] = [];
	await collectYoutubeBrowser({
		page: new DocumentPage(pageFor) as never,
		requested: new Map(streams.map((name) => [name, { name }])) as never,
		emitRecord: async (stream, data) => {
			records.set(stream, [...(records.get(stream) ?? []), data]);
		},
		emit: async (message) => {
			messages.push(message as Record<string, unknown>);
		},
		reportStreamFailure: failureReporter(messages),
		progress: async () => undefined,
	});
	const outcome = (stream: string) =>
		messages
			.filter((message) => message.stream === stream)
			.map((message) => message.reason ?? message.type);
	return { records, messages, outcome };
}

test("finding 1: a list whose source total matches what was read completes with no skip", async () => {
	const { records, outcome } = await collectFromDocuments(
		() => `${playlistRow}${headerTotal("1 video")}${playlistPageData(1, true)}`,
		["likes", "watch_later"],
	);
	assert.equal(records.get("likes")?.length, 1);
	assert.equal(records.get("watch_later")?.length, 1);
	assert.deepEqual(outcome("likes"), []);
	assert.deepEqual(outcome("watch_later"), []);
});

test("finding 1: a list the source reports no next page for completes with no skip", async () => {
	const pages = (url: string) =>
		url.includes("feed/history")
			? `${historyRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }] } }))}`
			: url.includes("feed/channels")
				? `${channelRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ channelRenderer: { channelId: "UC1" } }] } }))}`
				: "";
	const { records, outcome } = await collectFromDocuments(pages, [
		"watch_history",
		"subscriptions",
	]);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.equal(records.get("subscriptions")?.length, 1);
	assert.deepEqual(outcome("watch_history"), []);
	assert.deepEqual(outcome("subscriptions"), []);
});

test("finding 1: playlist index and every playlist read to their end complete with no skip", async () => {
	const pages = (url: string) =>
		url.includes("feed/playlists")
			? `<a href="/playlist?list=PL1">My list</a>${pageData(tabbedData({ gridRenderer: { items: [{ gridPlaylistRenderer: { playlistId: "PL1" } }] } }))}`
			: `<h1><yt-formatted-string>My list</yt-formatted-string></h1>${playlistRow}${headerTotal("1 video")}${playlistPageData(1)}`;
	const { records, outcome } = await collectFromDocuments(pages, [
		"playlists",
		"playlist_items",
	]);
	assert.equal(records.get("playlists")?.length, 1);
	assert.equal(records.get("playlist_items")?.length, 1);
	assert.deepEqual(outcome("playlists"), []);
	assert.deepEqual(outcome("playlist_items"), []);
});

test("finding 1: a list with a next page still pending fails with stream_collection_failed", async () => {
	const pages = (url: string) =>
		url.includes("feed/history")
			? `${historyRow}<ytd-continuation-item-renderer></ytd-continuation-item-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }, { continuationItemRenderer: {} }] } }))}`
			: `${playlistRow}${headerTotal("5 videos")}<ytd-continuation-item-renderer></ytd-continuation-item-renderer>${playlistPageData(1, true)}`;
	const { records, outcome } = await collectFromDocuments(pages, [
		"watch_history",
		"likes",
	]);
	assert.equal(records.get("likes")?.length, 1);
	assert.deepEqual(outcome("likes"), ["stream_collection_failed"]);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
});

test("finding 1: reading to the history limit is a cap that fails the stream, not the end of the list", async () => {
	const rows = Array.from(
		{ length: 60 },
		(_, n) =>
			`<yt-lockup-view-model><a href="/watch?v=vid${String(n).padStart(8, "0")}"></a><h3>V${n}</h3></yt-lockup-view-model>`,
	).join("");
	const { records, messages, outcome } = await collectFromDocuments(
		() =>
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: {} }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
	assert.match(String(messages[0]?.message), /stopped at the 50-item limit/);
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
	// A real empty target with a non-empty list elsewhere on the page still counts.
	assert.equal(
		ready(
			pageData(
				tabbedData(SIDEBAR_EMPTY, { secondaryContents: TARGET_NON_EMPTY }),
			),
		),
		"empty",
		"empty target, non-empty sidebar",
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
	assert.equal(ready(`${BUILT_IN_LINKS}${NO_PLAYLISTS}`), "empty");
	assert.equal(ready(BUILT_IN_LINKS), false);
	assert.equal(
		ready(`${BUILT_IN_LINKS}<a href="/playlist?list=PL1">Mine</a>`),
		"content",
	);
	// Built-in lists in the page data do not block the source's empty evidence.
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
		"empty",
	);
});

test("finding 3: readiness and readPlaylistLinks agree on which links are playlists", async () => {
	const { readPlaylistLinks } = await import("./browser-dom.ts");
	for (const html of [
		BUILT_IN_LINKS,
		`${BUILT_IN_LINKS}<a href="/playlist?list=PL1">Mine</a>`,
		`<a href="https://evil.example/playlist?list=PL9">Elsewhere</a>`,
		`<a href="/playlist?list=PL1">A</a><a href="/playlist?list=PL1&amp;x=1">Again</a>`,
	]) {
		withBrowserGlobals(html, () => {
			const readiness = readPageReadiness(PLAYLIST_INDEX);
			assert.equal(
				readiness === "content",
				readPlaylistLinks().length > 0,
				html,
			);
		});
	}
});

test("finding 3: an account with only built-in lists and a genuine empty state completes both playlist streams", async () => {
	const { records, messages, outcome } = await collectFromDocuments(
		() => `${BUILT_IN_LINKS}${NO_PLAYLISTS}`,
		["playlists", "playlist_items"],
	);
	assert.equal(records.size, 0);
	assert.deepEqual(outcome("playlists"), ["STATE"]);
	assert.deepEqual(outcome("playlist_items"), ["STATE"]);
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
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
});

test("round 2: a next page in the source data with no rendered control is not an end", async () => {
	const { records, outcome } = await collectFromDocuments(
		() =>
			`${historyRow}${pageData(tabbedData({ sectionListRenderer: { contents: [{ lockupViewModel: { contentId: "aaaaaaaaaaa" } }, { continuationItemRenderer: {} }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 1);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
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
			collectFromDocuments(
				() => `${playlistRow}${pageData(data)}`,
				["likes"],
			),
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
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: ids.map((contentId) => ({ lockupViewModel: { contentId } })) } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), []);
});

test("round 3: exactly 50 history items with a next page still pending fail the stream", async () => {
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
			`<ytd-item-section-renderer>${rows}</ytd-item-section-renderer>${pageData(tabbedData({ sectionListRenderer: { contents: [...ids.map((contentId) => ({ lockupViewModel: { contentId } })), { continuationItemRenderer: {} }] } }))}`,
		["watch_history"],
	);
	assert.equal(records.get("watch_history")?.length, 50);
	assert.deepEqual(outcome("watch_history"), ["stream_collection_failed"]);
});
