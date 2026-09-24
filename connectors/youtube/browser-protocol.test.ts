// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { packageRoot } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectYoutubeBrowser } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const card =
	'<yt-lockup-view-model class="content-id-abc123XYZ0"><a href="/watch?v=abc123XYZ0"></a><h3 title="Real title"></h3><span aria-label="Go to channel Creator"></span><span class="ytBadgeShapeText">4:30</span></yt-lockup-view-model>';
const pages: Record<string, string> = {
	"/": '<button id="avatar-btn">Account</button><ytd-active-account-header-renderer><span id="channel-handle">@owner</span></ytd-active-account-header-renderer>',
	"/@owner":
		'<link rel="canonical" href="https://www.youtube.com/channel/UCowner"><h1>Owner</h1>',
	"/@owner/about":
		"<ytd-channel-about-metadata-renderer><span>Joined Jan 3, 2020</span><span>1.2K subscribers</span><span>32 videos</span><span>4K views</span></ytd-channel-about-metadata-renderer>",
	"/feed/channels":
		'<ytd-channel-renderer><ytd-channel-name><yt-formatted-string id="text">Creator</yt-formatted-string><badge-shape></badge-shape></ytd-channel-name><a id="main-link" href="/channel/UCcreator"></a><div id="metadata"><span id="video-count">1.2K subscribers</span></div><button aria-label="All notifications"></button></ytd-channel-renderer>',
	"/feed/playlists": '<a href="/playlist?list=PL1">My playlist</a>',
	"/playlist?list=PL1": '<h1 id="title">My playlist</h1>' + card,
	"/playlist?list=LL": card,
	"/playlist?list=WL": card,
	"/feed/history":
		'<ytd-item-section-renderer><ytd-item-section-header-renderer><div id="header"><div id="title">Yesterday</div></div></ytd-item-section-header-renderer><yt-lockup-view-model><a href="/watch?v=abc123XYZ0"></a><h3 title="Real title"></h3><span class="yt-content-metadata-view-model__metadata-text">1.2K views</span></yt-lockup-view-model></ytd-item-section-renderer>',
};

test("routed browser collection emits seven schema-valid streams without a Takeout file", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.youtube.com/**", async (route) => {
			const url = new URL(route.request().url());
			const html = pages[`${url.pathname}${url.search}`];
			await route.fulfill({
				status: html ? 200 : 404,
				contentType: "text/html",
				body: `<html><body>${html ?? ""}</body></html>`,
			});
		});
		const fastPage = new Proxy(page, {
			get(target, key) {
				if (key === "waitForTimeout") return async () => undefined;
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const streams = [
			"profile",
			"subscriptions",
			"playlists",
			"playlist_items",
			"likes",
			"watch_later",
			"watch_history",
			"coverage_diagnostics",
		];
		const records = new Map<string, Record<string, unknown>[]>();
		await collectYoutubeBrowser({
			page: fastPage as never,
			requested: new Map(streams.map((name) => [name, { name }])) as never,
			emitRecord: async (stream, data) => {
				assert.equal(
					validateRecord(stream, data).ok,
					true,
					`${stream}: ${JSON.stringify(data)}`,
				);
				records.set(stream, [...(records.get(stream) ?? []), data]);
			},
			emit: async () => undefined,
			progress: async () => undefined,
		});
		for (const stream of streams)
			assert.ok(records.get(stream)?.length, stream);
		assert.equal(records.get("profile")?.[0]?.subscriber_count, 1200);
		assert.equal(records.get("subscriptions")?.[0]?.notifications, true);
		assert.equal(
			records.get("subscriptions")?.[0]?.subscriber_count_text,
			"1.2K subscribers",
		);
		assert.equal(records.get("playlist_items")?.[0]?.video_title, "Real title");
		assert.equal(records.get("playlist_items")?.[0]?.duration_text, "4:30");
		assert.equal(records.get("watch_history")?.[0]?.watched_at, undefined);
		assert.equal(
			records.get("watch_history")?.[0]?.watched_date_label,
			"Yesterday",
		);
		assert.equal(records.get("watch_history")?.[0]?.views_text, "1.2K views");
		assert.equal(records.get("watch_history")?.[0]?.position, 0);
	} finally {
		await browser.close();
	}
});

test("browser fixture completes START to RECORD to DONE through the connector protocol", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: packageRoot,
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/protocol.ts", import.meta.url),
		),
		start: { type: "START", scope: { streams: [{ name: "watch_history" }] } },
	});
	const messages = result.messages as Array<{
		type: string;
		stream?: string;
		data?: Record<string, unknown>;
	}>;
	const history = messages.find(
		(message) =>
			message.type === "RECORD" && message.stream === "watch_history",
	);
	assert.ok(history);
	assert.equal(history.data?.video_title, "Real title");
	assert.equal(history.data?.watched_at, undefined);
	assert.equal(messages.filter((message) => message.type === "DONE").length, 1);
});

test("production history field filters since inclusive, until exclusive, and unknown dates", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: packageRoot,
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/protocol.ts", import.meta.url),
		),
		start: {
			type: "START",
			scope: {
				streams: [
					{
						name: "watch_history",
						time_range: { since: "2026-09-22", until: "2026-09-23" },
					},
				],
			},
		},
	});
	const records = result.messages.filter(
		(message) =>
			message.type === "RECORD" && message.stream === "watch_history",
	);
	assert.equal(records.length, 1);
	assert.equal(
		(records[0] as { data?: { watched_date?: string } })?.data?.watched_date,
		"2026-09-22",
	);
	assert.equal(
		result.messages.filter((message) => message.type === "DONE").length,
		1,
	);
});

test("history waits for delayed client DOM before recording", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.youtube.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `<html><body><script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<ytd-item-section-renderer><ytd-item-section-header-renderer><div id="header"><div id="title">Sep 22, 2026</div></div></ytd-item-section-header-renderer><yt-lockup-view-model><a href="/watch?v=delayed123"></a><h3 title="Delayed title"></h3></yt-lockup-view-model></ytd-item-section-renderer>'), 75)</script></body></html>`,
			});
		});
		const records: Record<string, unknown>[] = [];
		const skips: unknown[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([
				["watch_history", { name: "watch_history" }],
			]) as never,
			emitRecord: async (_stream, data) => {
				records.push(data);
			},
			emit: async (message) => {
				skips.push(message);
			},
			progress: async () => undefined,
		});
		assert.equal(records.length, 1);
		assert.equal(records[0]?.video_title, "Delayed title");
		assert.equal(skips.length, 0);
	} finally {
		await browser.close();
	}
});

test("profile waits past a generic h1 shell until channel identity and title arrive", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.youtube.com/**", async (route) => {
			const url = new URL(route.request().url());
			let body = "";
			if (url.pathname === "/")
				body = '<button id="avatar-btn">Account</button><ytd-active-account-header-renderer><span id="channel-handle">@owner</span></ytd-active-account-header-renderer>';
			else if (url.pathname === "/@owner")
				body = '<link rel="canonical" href="https://www.youtube.com/channel/UCowner"><h1>Loading</h1><script>setTimeout(() => document.querySelector("h1").textContent = "Real Owner", 500)</script>';
			else if (url.pathname === "/@owner/about")
				body =
					'<ytd-channel-about-metadata-renderer><span>Joined Jan 3, 2020</span><span>1.2K subscribers</span></ytd-channel-about-metadata-renderer>';
			await route.fulfill({
				status: body ? 200 : 404,
				contentType: "text/html",
				body: `<html><body>${body}</body></html>`,
			});
		});
		const records: Record<string, unknown>[] = [];
		const skips: unknown[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([["profile", { name: "profile" }]]) as never,
			emitRecord: async (_stream, data) => {
				records.push(data);
			},
			emit: async (message) => {
				skips.push(message);
			},
			progress: async () => undefined,
		});
		assert.equal(records.length, 1);
		assert.equal(records[0]?.title, "Real Owner");
		assert.equal(skips.length, 0);
	} finally {
		await browser.close();
	}
});

test("profile waits past a generic About span shell until fields arrive", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.youtube.com/**", async (route) => {
			const url = new URL(route.request().url());
			let body = "";
			if (url.pathname === "/")
				body = '<button id="avatar-btn">Account</button><ytd-active-account-header-renderer><span id="channel-handle">@owner</span></ytd-active-account-header-renderer>';
			else if (url.pathname === "/@owner")
				body =
					'<link rel="canonical" href="https://www.youtube.com/channel/UCowner"><h1>Real Owner</h1>';
			else if (url.pathname === "/@owner/about")
				body =
					'<ytd-channel-about-metadata-renderer><span>Loading</span></ytd-channel-about-metadata-renderer><script>setTimeout(() => document.querySelector("ytd-channel-about-metadata-renderer").innerHTML = "<span>Joined Jan 3, 2020</span><span>1.2K subscribers</span>", 500)</script>';
			await route.fulfill({
				status: body ? 200 : 404,
				contentType: "text/html",
				body: `<html><body>${body}</body></html>`,
			});
		});
		const records: Record<string, unknown>[] = [];
		const skips: unknown[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([["profile", { name: "profile" }]]) as never,
			emitRecord: async (_stream, data) => {
				records.push(data);
			},
			emit: async (message) => {
				skips.push(message);
			},
			progress: async () => undefined,
		});
		assert.equal(records.length, 1);
		assert.equal(records[0]?.subscriber_count, 1200);
		assert.equal(records[0]?.joined_at, "Jan 3, 2020");
		assert.equal(skips.length, 0);
	} finally {
		await browser.close();
	}
});

test("profile ignores channel chrome counts while About metadata is loading", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.youtube.com/**", async (route) => {
			const url = new URL(route.request().url());
			let body = "";
			if (url.pathname === "/")
				body = '<button id="avatar-btn">Account</button><ytd-active-account-header-renderer><span id="channel-handle">@owner</span></ytd-active-account-header-renderer>';
			else if (url.pathname === "/@owner")
				body = '<link rel="canonical" href="https://www.youtube.com/channel/UCowner"><h1>Real Owner</h1>';
			else if (url.pathname === "/@owner/about")
				body = '<span>32 videos</span><ytd-channel-about-metadata-renderer><span>Loading</span></ytd-channel-about-metadata-renderer><script>setTimeout(() => document.querySelector("ytd-channel-about-metadata-renderer").innerHTML = "<span>Joined Jan 3, 2020</span><span>1.2K subscribers</span>", 500)</script>';
			await route.fulfill({
				status: body ? 200 : 404,
				contentType: "text/html",
				body: `<html><body>${body}</body></html>`,
			});
		});
		const records: Record<string, unknown>[] = [];
		await collectYoutubeBrowser({
			page: page as never,
			requested: new Map([["profile", { name: "profile" }]]) as never,
			emitRecord: async (_stream, data) => { records.push(data); },
			emit: async () => undefined,
			progress: async () => undefined,
		});
		assert.equal(records.length, 1);
		assert.equal(records[0]?.joined_at, "Jan 3, 2020");
		assert.equal(records[0]?.subscriber_count, 1200);
	} finally {
		await browser.close();
	}
});
