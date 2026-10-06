// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { collectYoutubeBrowser, resolveWatchedDate } from "./index.ts";
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

class FixturePage {
	url = "";
	private readonly waitStates: Array<"content" | "empty" | "unreadable">;
	private readonly ownAccount: {
		channel_url: string | null;
		email: string | null;
	};
	constructor(
		waitStates: Array<"content" | "empty" | "unreadable"> = [],
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
		progress: async () => undefined,
	});

	assert.equal(skips.length, 1);
	assert.equal(skips[0]?.reason, "youtube_profile_account_header_unreadable");
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
			progress: async () => undefined,
		});
		return keys;
	};
	assert.deepEqual(await collectKeys(1), await collectKeys(9));
	assert.deepEqual(await collectKeys(1, null), await collectKeys(9, null));
});
