// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { validateRecord } from "./schemas.ts";

const pageObservation = (requestedUrl: string, html: string) => ({
	requestedUrl,
	currentUrl: requestedUrl,
	html,
});

const apiObservation = (requestedUrl: string, data: unknown) => ({
	requestedUrl,
	responseUrl: requestedUrl,
	status: 200,
	data,
});
const profilePlaceholder =
	'<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><span class="p-name">Sample User</span>';
const withOwner = (html: string) => `${profilePlaceholder}${html}`;
const terminalInventory =
	'<div class="paginate-container"><span class="next_page disabled" aria-disabled="true">Next</span></div>';

const readFixture = (name: string): Promise<string> =>
	readFile(
		new URL(`./__fixtures__/synthetic/${name}`, import.meta.url),
		"utf8",
	);

test("collector uses the contribution page loader that waits for rendered calendar cells", async () => {
	const now = new Date("2026-09-24T12:00:00Z");
	const contributionPageLoads: string[] = [];
	const messages: Array<{ type: string; stream: string | undefined }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const calendar = (start: string, end: string): string => {
		let html = '<h2 class="f4 text-normal mb-2">0 contributions</h2>';
		for (
			let date = new Date(`${start}T00:00:00Z`);
			date.toISOString().slice(0, 10) <= end;
			date.setUTCDate(date.getUTCDate() + 1)
		) {
			html += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="0" data-level="0"></td>`;
		}
		return html;
	};
	const rollingStart = new Date(now);
	rollingStart.setUTCDate(rollingStart.getUTCDate() - 364);
	const services = {
		fetchPublicJson: async (url: string) => apiObservation(url, []),
		now: () => now,
		openPage: async (url: string) =>
			pageObservation(
				url,
				url === "https://github.com/"
					? profilePlaceholder
					: "<main>Calendar still loading</main>",
			),
		openContributionPage: async (url: string) => {
			contributionPageLoads.push(url);
			const year = Number(
				/from=(\d{4})/u.exec(url)?.[1] ?? now.getUTCFullYear(),
			);
			return pageObservation(
				url,
				withOwner(
					year === now.getUTCFullYear()
						? calendar(
								rollingStart.toISOString().slice(0, 10),
								now.toISOString().slice(0, 10),
							)
						: calendar(`${year}-01-01`, `${year}-12-31`),
				),
			);
		},
		sleep: async () => {},
	};

	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push({
					type: message.type,
					stream: "stream" in message ? message.stream : undefined,
				});
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set(["contributions"]),
			state: {},
		},
		services,
	);

	assert.equal(contributionPageLoads.length, 4);
	assert.ok(records.length > 0);
	assert.ok(
		records.every(
			({ stream, data }) =>
				stream === "contributions" && validateRecord(stream, data).ok,
		),
	);
	assert.deepEqual(messages, [
		{ type: "STATE", stream: "contributions" },
		{ type: "DETAIL_COVERAGE", stream: "contributions" },
	]);
});


test("collector skips contribution snapshots when any year view is unavailable", async () => {
	const profile = await readFixture("profile.html");
	let current = '<h2 class="f4 text-normal mb-2">3 contributions</h2>';
	for (
		let date = new Date("2025-01-02T00:00:00Z");
		date.toISOString().slice(0, 10) <= "2026-01-01";
		date.setUTCDate(date.getUTCDate() + 1)
	)
		current += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="0" data-level="0"></td>`;
	const run = async (currentHtml: string) => {
		const records: Array<Record<string, unknown>> = [];
		const messages: Array<{ type: string }> = [];
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push({ type: message.type });
				},
				emitRecord: async (_stream, record) => {
					records.push(record);
				},
				progress: async () => {},
				requested: new Set(["contributions"]),
				state: {},
			},
			{
				fetchPublicJson: async (url: string) => apiObservation(url, []),
				now: () => new Date("2026-01-01T00:00:00Z"),
				openPage: async (url) =>
					pageObservation(
						url,
						url === "https://github.com/"
							? profile
							: url.includes("?from=")
								? "<main>Unavailable</main>"
								: currentHtml,
					),
				sleep: async () => {},
			},
		);
		return { messages, records };
	};
	const missingPrior = await run(current);
	assert.equal(missingPrior.records.length, 0);
	assert.ok(missingPrior.messages.some(({ type }) => type === "SKIP_RESULT"));
	assert.equal(
		missingPrior.messages.some(({ type }) => type === "STATE"),
		false,
	);
	const missingCurrent = await run("<main>Unavailable</main>");
	assert.equal(missingCurrent.records.length, 0);
	assert.ok(missingCurrent.messages.some(({ type }) => type === "SKIP_RESULT"));
});

test("real runtime preserves selected aggregate contracts before DONE", async () => {
	const streams = [
		"profile",
		"repositories",
		"starred",
		"events",
		"contributions",
		"history",
	];
	const result = await runConnectorProtocolSubprocess({
		cwd: new URL("../../packages/polyfill-connectors/", import.meta.url)
			.pathname,
		entrypoint: new URL("./protocol-runtime-fixture.ts", import.meta.url)
			.pathname,
		start: {
			type: "START",
			scope: { streams: streams.map((name) => ({ name })) },
		},
	});
	assert.equal(result.code, 0);
	const records = result.messages.filter(
		(message) => message.type === "RECORD",
	);
	assert.deepEqual(
		new Set(records.map((message) => message.stream)),
		new Set(["profile", "repositories", "events", "history"]),
	);
	for (const message of records) {
		if (message.type !== "RECORD") continue;
		assert.equal(message.data.id, message.key);
	}
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") assert.equal(done.records_emitted, records.length);
});

test("inventory follows next link and rejects an unproven empty page", async () => {
	const profile = await readFixture("profile.html");
	const row = await readFixture("repositories.html");
	const visited: string[] = [];
	const emitted: unknown[] = [];
	const messages: Array<{ type: string }> = [];
	const run = async (secondPage: string) => {
		visited.length = 0;
		emitted.length = 0;
		messages.length = 0;
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async (_stream, data) => {
					emitted.push(data);
				},
				progress: async () => {},
				requested: new Set(["repositories"]),
				state: {},
			},
			{
				fetchPublicJson: async (url: string) => apiObservation(url, {}),
				now: () => new Date("2026-01-01"),
				sleep: async () => {},
				openPage: async (url) => {
					visited.push(url);
					if (url.endsWith("github.com/")) return pageObservation(url, profile);
					return pageObservation(
						url,
						withOwner(
							url.includes("page=1")
								? `${row}<div class="pagination"><a class="next_page" rel="next" href="/sample-user?page=2&tab=repositories">Next</a></div>`
								: secondPage,
						),
					);
				},
			},
		);
	};
	await run(row);
	assert.ok(visited.some((url) => url.includes("page=2")));
	assert.equal(emitted.length, 0);
	await run("<main>Sign in to GitHub</main>");
	assert.equal(
		emitted.length,
		0,
		"a later-page failure must preserve the prior aggregate snapshot",
	);
	assert.ok(messages.some((message) => message.type === "SKIP_RESULT"));
	assert.ok(!messages.some((message) => message.type === "STATE"));
});

test("incomplete or contradictory history search cannot emit a completed snapshot", async () => {
	const profile = await readFixture("profile.html");
	for (const response of [
		{ items: [], total_count: 2, incomplete_results: true },
		{ items: [], total_count: 2, incomplete_results: false },
	]) {
		const messages: Array<{ type: string }> = [];
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async () => {
					throw new Error("unexpected history record");
				},
				progress: async () => {},
				requested: new Set(["history"]),
				state: {},
			},
			{
				fetchPublicJson: async (url: string) => apiObservation(url, response),
				now: () => new Date("2026-01-01"),
				openPage: async (url: string) => pageObservation(url, profile),
				sleep: async () => {},
			},
		);
		assert.ok(messages.some((message) => message.type === "SKIP_RESULT"));
		assert.ok(!messages.some((message) => message.type === "STATE"));
	}
});

test("starred inventory enters the legacy page-one fallback and follows its continuation", async () => {
	const profile = await readFixture("profile.html");
	const visits: string[] = [];
	const messages: Array<{ type: string; stream?: string }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const first = withOwner(
		`<main><div id="user-starred-repos"><ul><li><h3><a href="/sample-owner/first">sample-owner/first</a></h3><p></p><span itemprop="programmingLanguage"></span><a href="/sample-owner/first/stargazers">0</a><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></li></ul></div><div class="pagination"><a rel="next" href="/stars/sample-user?page=2">Next</a></div></main>`,
	);
	const second = withOwner(
		'<main><div id="user-starred-repos"><ul><li><h3><a href="/sample-owner/second">sample-owner/second</a></h3><p></p><span itemprop="programmingLanguage"></span><a href="/sample-owner/second/stargazers">0</a><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></li></ul></div></main>' +
			terminalInventory,
	);
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push(message);
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set(["starred"]),
			state: {},
		},
		{
			fetchPublicJson: async (url: string) => apiObservation(url, []),
			now: () => new Date("2026-01-01T00:00:00Z"),
			openPage: async (url) => {
				visits.push(url);
				if (url === "https://github.com/") return pageObservation(url, profile);
				return pageObservation(url, url.includes("tab=stars") ? withOwner("<main>Loading...</main>") : url.includes("page=2") ? second : first);
			},
			sleep: async () => {},
		},
	);

	assert.ok(
		visits.some((url) => url === "https://github.com/stars/sample-user?page=2"),
	);
	assert.ok(visits.includes("https://github.com/stars/sample-user?page=1"));
	assert.equal(records.length, 1);
	assert.equal(records[0]?.data.id, "sample-user:starred");
	assert.equal((records[0]?.data.starred as unknown[]).length, 2);
	assert.equal(messages.filter(({ type }) => type === "STATE").length, 1);
});

test("three full event pages withhold the snapshot without source end evidence", async () => {
	const profile = await readFixture("profile.html");
	const fixtureEvents = JSON.parse(await readFixture("events.json")) as Array<
		Record<string, unknown>
	>;
	const sourceEvent = fixtureEvents[0];
	assert.ok(sourceEvent);
	const pages = Array.from({ length: 3 }, (_, page) =>
		Array.from({ length: 100 }, (_, index) => ({
			...sourceEvent,
			id: `${page}-${index}`,
		})),
	);
	let page = 0;
	const messages: Array<{ type: string; stream?: string }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const state: Record<string, Record<string, unknown>> = {};
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push(message);
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set(["events"]),
			state,
		},
		{
			fetchPublicJson: async (url: string) =>
				apiObservation(url, pages[page++]),
			now: () => new Date("2026-01-01T00:00:00Z"),
			openPage: async (url) => pageObservation(url, profile),
			sleep: async () => {},
		},
	);

	assert.equal(page, 3);
	assert.equal(records.length, 0);
	assert.equal(state.events, undefined);
	assert.ok(messages.some((message) => message.type === "SKIP_RESULT"));
	assert.equal(messages.filter(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE").length, 0);
});

test("history exact source total of 1,000 can prove completeness", async () => {
	const profile = await readFixture("profile.html");
	const source = (JSON.parse(await readFixture("history-issue.json")) as { items: Record<string, unknown>[] }).items[0];
	let issuePage = 0;
	const messages: Array<{ type: string; stream?: string }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const state: Record<string, Record<string, unknown>> = {};
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push(message);
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set(["history"]),
			state,
		},
		{
			fetchPublicJson: async (url) => {
				if (url.includes("type%3Apr"))
					return apiObservation(url, {
						items: [],
						total_count: 0,
						incomplete_results: false,
					});
				const page = issuePage++;
				return apiObservation(url, {
					items: Array.from({ length: 100 }, (_, index) => ({
						...source,
						id: page * 100 + index + 1,
						number: page * 100 + index + 1,
						repository_url:
							"https://api.github.com/repos/sample-owner/sample-repo",
					})),
					total_count: 1000,
					incomplete_results: false,
				});
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
			openPage: async (url) => pageObservation(url, profile),
			sleep: async () => {},
		},
	);

	assert.equal(issuePage, 10);
	assert.equal(records.length, 1);
	assert.ok(records.every(({ stream }) => stream === "history"));
	assert.equal(records[0]?.data.id, "sample-user:history");
	assert.equal((records[0]?.data.issues as unknown[]).length, 1000);
	assert.ok(state.history);
	assert.equal(messages.some((message) => message.type === "SKIP_RESULT"), false);
	assert.equal(messages.filter(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE").length, 2);
});

test("an events failure is isolated and does not prevent later requested streams", async () => {
	const profile = await readFixture("profile.html");
	let historyRequested = false;
	const messages: Array<{ type: string; stream?: string }> = [];
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push(message);
			},
			emitRecord: async () => {},
			progress: async () => {},
			requested: new Set(["events", "history"]),
			state: {},
		},
		{
			fetchPublicJson: async (url) => {
				if (url.includes("events")) throw new Error("synthetic event failure");
				historyRequested = true;
				return apiObservation(url, {
					items: [],
					total_count: 0,
					incomplete_results: false,
				});
			},
			now: () => new Date("2026-01-01T00:00:00Z"),
			openPage: async (url) => pageObservation(url, profile),
			sleep: async () => {},
		},
	);

	assert.equal(historyRequested, true);
	assert.ok(
		messages.some(
			({ type, stream }) => type === "SKIP_RESULT" && stream === "events",
		),
	);
	assert.ok(
		messages.some(
			({ type, stream }) => type === "STATE" && stream === "history",
		),
	);
});
