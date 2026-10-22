// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { githubLink } from "./api-link-fixture.ts";
import { parseProfilePage } from "./parsers.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
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
		allowFailedDone: true,
		cwd: new URL("../../packages/polyfill-connectors/", import.meta.url)
			.pathname,
		entrypoint: new URL("./protocol-runtime-fixture.ts", import.meta.url)
			.pathname,
		start: {
			type: "START",
			scope: { streams: streams.map((name) => ({ name })) },
		},
	});
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
	// starred and contributions are not proven complete: Collection Profile
	// 5.5 and 5.8 end that run failed with the portable stream failure, and the
	// streams that were proven keep their records.
	assert.deepEqual(
		result.messages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => `${message.stream}:${message.reason}`)
			.sort(),
		["contributions:stream_collection_failed", "starred:stream_collection_failed"],
	);
	assert.equal(result.code, 1);
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") {
		assert.equal(done.status, "failed");
		assert.equal(done.error?.code, "stream_collection_failed");
		assert.equal(done.records_emitted, records.length);
	}
});

test("a profile with an unreadable embedded section fails the real runtime run with the portable stream failure", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: new URL("../../packages/polyfill-connectors/", import.meta.url)
			.pathname,
		entrypoint: new URL("./protocol-profile-runtime-fixture.ts", import.meta.url)
			.pathname,
		start: { type: "START", scope: { streams: [{ name: "profile" }] } },
	});
	assert.equal(result.code, 1);
	assert.deepEqual(
		result.messages.filter(
			(message) => message.type === "RECORD" || message.type === "STATE",
		),
		[],
	);
	assert.deepEqual(
		result.messages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => `${message.stream}:${message.reason}`),
		["profile:stream_collection_failed"],
	);
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") {
		assert.equal(done.status, "failed");
		assert.equal(done.error?.code, "stream_collection_failed");
	}
});

for (const [field, container, brokenEntry] of [
	[
		"pinnedRepositories",
		'<div class="js-pinned-items-reorder-container"></div>',
		'<div class="js-pinned-items-reorder-container"><li><a href="/sponsors/sample-user">Sponsor</a></li></div>',
	],
	[
		"organizations",
		'<div class="avatar-group"></div>',
		'<div class="avatar-group"><a class="avatar-group-item" href="/"></a></div>',
	],
	[
		"achievements",
		'<div class="profile-achievements"></div>',
		'<div class="profile-achievements"><a href="/sample-user?achievement=badge"><img src="https://example.test/badge.png"></a></div>',
	],
] as const) {
	for (const failure of ["entry", "section"] as const) {
		test(`profile with unreadable ${field} ${failure} reports a portable stream failure when the runtime supplies one`, async () => {
			const html = (
				await readFile(new URL("./__fixtures__/synthetic/profile.html", import.meta.url), "utf8")
			).replace(
				container,
				failure === "entry"
					? brokenEntry
					: container.replace("></div>", ' aria-busy="true"></div>'),
			);
			const messages: EmittedMessage[] = [];
			const records: unknown[] = [];
			const reports: Array<{ stream: string; message: string; options: unknown }> = [];
			await collectGitHubBrowser(
				{
					emit: async (message) => {
						messages.push(message);
					},
					emitRecord: async (_stream, record) => {
						records.push(record);
					},
					progress: async () => {},
					reportStreamFailure: async (stream, message, options) => {
						reports.push({ stream, message, options });
					},
					requested: new Set(["profile"]),
					state: {},
				},
				{
					fetchPublicJson: async () => {
						throw new Error("a profile-only run must not call the API");
					},
					now: () => new Date("2026-10-20T17:00:00Z"),
					openPage: async (url) => pageObservation(url, html),
					sleep: async () => {},
				},
			);
			assert.deepEqual(messages, []);
			assert.deepEqual(records, []);
			assert.equal(reports.length, 1);
			assert.equal(reports[0]?.stream, "profile");
			assert.equal(
				reports[0]?.message,
				"GitHub did not return a complete result for this stream: discarded_rows.",
			);
			const options = reports[0]?.options as {
				recoveryHint: unknown;
				diagnostics: Record<string, unknown>;
			};
			assert.deepEqual(options.recoveryHint, {
				action: "retry_by_runtime",
				retryable: true,
			});
			assert.equal(options.diagnostics.reason, "discarded_rows");
			assert.equal(options.diagnostics.collection, field);
		});
	}
}

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
		const records: unknown[] = [];
		const prior = { fetched_at: "2020-01-01" };
		const state = { history: prior };
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async (_stream, data) => {
					records.push(data);
				},
				progress: async () => {},
				requested: new Set(["history"]),
				state,
			},
			{
				fetchPublicJson: async (url: string) => apiObservation(url, response),
				now: () => new Date("2026-01-01"),
				openPage: async (url: string) => pageObservation(url, profile),
				sleep: async () => {},
			},
		);
		assert.deepEqual(records, []);
		assert.deepEqual(state, { history: prior });
		assert.equal(state.history, prior);
		assert.ok(!messages.some((message) => message.type === "DETAIL_COVERAGE"));
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
			fetchPublicJson: async (url: string) => ({
				...apiObservation(url, pages[page++]),
				link: githubLink(url, 5),
			}),
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
				return Object.assign(apiObservation(url, {
					items: Array.from({ length: 100 }, (_, index) => ({
						...source,
						id: page * 100 + index + 1,
						number: page * 100 + index + 1,
						repository_url:
							"https://api.github.com/repos/sample-owner/sample-repo",
					})),
					total_count: 1000,
					incomplete_results: false,
				}), { link: githubLink(url, 10) });
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

test("current div-based starred cards publish after the exact owner total is met", async () => {
	const messages: Array<{ type: string }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const html =
		withOwner(`<nav><a href="/sample-user?tab=stars" data-tab-item="stars">Stars <span class="Counter">1</span></a></nav>
		<turbo-frame id="user-starred-repos"><div class="position-relative"><form><input name="q"></form>
		<div class="col-12 d-block width-full tmp-py-4 border-bottom color-border-muted"><div class="d-inline-block mb-1"><h3><a href="/sample-owner/demo">sample-owner / demo</a></h3></div><p>Example repository</p><div><relative-time datetime="2026-10-19T00:00:00Z"></relative-time></div></div></div></turbo-frame>`);
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
			fetchPublicJson: async () => {
				throw new Error("exact total needs no REST fallback");
			},
			now: () => new Date("2026-10-20T17:00:00Z"),
			openPage: async (url) =>
				pageObservation(
					url,
					url === "https://github.com/" ? profilePlaceholder : html,
				),
			sleep: async () => {},
		},
	);
	assert.equal(records.length, 1);
	assert.equal((records[0]?.data.starred as unknown[]).length, 1);
	assert.deepEqual(
		messages.map((message) => message.type),
		["STATE", "DETAIL_COVERAGE"],
	);
});

test("compact pull-request event payloads publish the observed events window", async () => {
	const messages: Array<{ type: string }> = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
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
			state: {},
		},
		{
			fetchPublicJson: async (url) => ({
				...apiObservation(url, [
					{
						id: "123",
						type: "PullRequestEvent",
						public: true,
						created_at: "2026-10-19T12:00:00Z",
						repo: { name: "sample-owner/demo" },
						payload: {
							action: "opened",
							number: 7,
							pull_request: {
								id: 77,
								number: 7,
								url: "https://api.github.com/repos/sample-owner/demo/pulls/7",
								head: { ref: "feature", sha: "abc", repo: { id: 1 } },
								base: { ref: "main", sha: "def", repo: { id: 1 } },
							},
						},
					},
				]),
				link: null,
			}),
			now: () => new Date("2026-10-20T17:00:00Z"),
			openPage: async (url) => pageObservation(url, profilePlaceholder),
			sleep: async () => {},
		},
	);
	assert.equal(records.length, 1);
	const events = records[0]?.data.events as Array<Record<string, unknown>>;
	assert.equal(events.length, 1);
	assert.equal(events[0]?.title, "PR #7 (feature)");
	assert.equal(events[0]?.body, null);
	assert.equal(events[0]?.url, "https://github.com/sample-owner/demo/pull/7");
	assert.deepEqual(
		messages.map((message) => message.type),
		["STATE", "DETAIL_COVERAGE"],
	);
});

test("two-identity starred cards cannot publish with terminal pagination and no counter", async () => {
	const messages: EmittedMessage[] = [];
	const prior = { starred: { fetched_at: "2026-10-01T00:00:00Z" } };
	const state = structuredClone(prior);
	const records: unknown[] = [];
	const html = withOwner(`<main><turbo-frame id="user-starred-repos"><div class="col-12 d-block width-full border-bottom"><h3><a href="/sample-owner/first">sample-owner/first</a></h3><h3><a href="/sample-owner/second">sample-owner/second</a></h3><relative-time datetime="2026-10-19T00:00:00Z"></relative-time></div></turbo-frame>${terminalInventory}</main>`);
	await collectGitHubBrowser(
		{
			emit: async (message) => { messages.push(message); },
			emitRecord: async (_stream, data) => { records.push(data); },
			progress: async () => {},
			requested: new Set(["starred"]),
			state,
		},
		{
			fetchPublicJson: async (url) => apiObservation(url, []),
			now: () => new Date("2026-10-20T17:00:00Z"),
			openPage: async (url) => pageObservation(url, url === "https://github.com/" ? profilePlaceholder : html),
			sleep: async () => {},
		},
	);
	assert.deepEqual(records, []);
	assert.equal(messages.some(({ type }) => ["RECORD", "STATE", "DETAIL_COVERAGE"].includes(type)), false);
	assert.deepEqual(state, prior);
	assert.equal(messages.length, 1);
	const skip = messages[0];
	assert.ok(skip?.type === "SKIP_RESULT");
	assert.equal(skip.stream, "starred");
	assert.equal(skip.reason, "inventory_not_proven_complete");
	assert.deepEqual(skip.recovery_hint, { action: "retry_by_runtime", retryable: true });
});

for (const countConflict of [false, true]) {
test(`overlapping contribution views ${countConflict ? "withhold conflicting counts" : "may shade the same count differently"}`, async () => {
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string }> = [];
	const now = new Date("2026-10-20T17:00:00Z");
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push(message);
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set(["contributions"]),
			state: {},
		},
		{
			now: () => now,
			sleep: async () => {},
			fetchPublicJson: async () => {
				throw new Error("not used");
			},
			openPage: async (url) => pageObservation(url, profilePlaceholder),
			openContributionPage: async (url) => {
				const year = Number(/from=(\d{4})/u.exec(url)?.[1] ?? 2026);
				const start =
					year === 2026
						? new Date("2025-10-21T00:00:00Z")
						: new Date(`${year}-01-01T00:00:00Z`);
				const end = year === 2026 ? "2026-10-20" : `${year}-12-31`;
				const cells: string[] = [];
				const count = countConflict && year === 2025 ? 2 : 1;
				for (
					let date = start;
					date.toISOString().slice(0, 10) <= end;
					date.setUTCDate(date.getUTCDate() + 1)
				) {
					cells.push(
						`<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="${count}" data-level="${year === 2026 ? 2 : 1}"></td>`,
					);
				}
				return pageObservation(
					url,
					withOwner(
						`<h2 id="js-contribution-activity-description">${cells.length * count} contributions</h2><table>${cells.join("")}</table>`,
					),
				);
			},
		},
	);
	if (countConflict) {
		assert.equal(records.length, 0);
		assert.deepEqual(messages.map(message => message.type), ["SKIP_RESULT"]);
		return;
	}
	assert.equal(records.length, 1);
	assert.equal((records[0]?.data.days as unknown[]).length, 1389);
	const days = records[0]?.data.days as Array<{ date: string; level: number }>;
	assert.equal(days.find(day => day.date === "2025-10-21")?.level, 2);
	assert.deepEqual(
		messages.map((message) => message.type),
		["STATE", "DETAIL_COVERAGE"],
	);
});

}

// A GitHub request that throws (navigation, an HTTP status such as the
// unauthenticated REST rate limit, transport) never read the inventory. It is
// a failed read reported through reportStreamFailure, not an unproven
// enumeration (Collection Profile 5.5).
for (const { stream, services } of [
	{
		stream: "events",
		services: {
			fetchPublicJson: async (): Promise<never> => {
				throw new Error("github_browser_http_429");
			},
		},
	},
	{
		stream: "history",
		services: {
			fetchPublicJson: async (): Promise<never> => {
				throw new Error("github_browser_http_403");
			},
		},
	},
	{
		stream: "contributions",
		services: {
			openContributionPage: async (): Promise<never> => {
				throw new Error("net::ERR_TIMED_OUT at https://github.com/sample-user");
			},
		},
	},
] as const) {
	test(`a ${stream} request that throws is a reported stream failure, not an unproven inventory`, async () => {
		const profile = await readFixture("profile.html");
		const messages: Array<{ type: string; stream?: string; reason?: string }> = [];
		const reports: Array<{ stream: string; message: string; options: unknown }> = [];
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async () => {},
				progress: async () => {},
				reportStreamFailure: async (failed, message, options) => {
					reports.push({ stream: failed, message, options });
				},
				requested: new Set([stream]),
				state: {},
			},
			{
				fetchPublicJson: async (url) => apiObservation(url, []),
				now: () => new Date("2026-01-01T00:00:00Z"),
				openPage: async (url) => pageObservation(url, profile),
				sleep: async () => {},
				...services,
			},
		);
		assert.equal(
			messages.some((message) => message.type === "SKIP_RESULT"),
			false,
			"no unproven-enumeration SKIP_RESULT",
		);
		assert.equal(reports.length, 1);
		assert.equal(reports[0]?.stream, stream);
		assert.equal(
			reports[0]?.message,
			"GitHub requests for this stream failed: source_request_failed.",
		);
		const options = reports[0]?.options as {
			recoveryHint: unknown;
			diagnostics: Record<string, unknown>;
		};
		assert.deepEqual(options.recoveryHint, {
			action: "retry_by_runtime",
			retryable: true,
		});
		assert.equal(options.diagnostics.reason, "source_request_failed");
		assert.equal(
			options.diagnostics.source_error,
			stream === "events" ? "http_429" : stream === "history" ? "http_403" : undefined,
		);
		assert.doesNotMatch(JSON.stringify(reports), /https:\/\/github\.com/u);
	});
}

for (const [field, container, brokenEntry] of [
	["pinnedRepositories", '<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><li><a href="/sponsors/sample-user">Sponsor</a></li></div>'],
	["organizations", '<div class="avatar-group"></div>', '<div class="avatar-group"><a class="avatar-group-item" href="/"></a></div>'],
	["achievements", '<div class="profile-achievements"></div>', '<div class="profile-achievements"><a href="/sample-user?achievement=badge"><img src="https://example.test/badge.png"></a></div>'],
] as const) {
	for (const failure of ["entry", "section"] as const) {
		test(`profile with unreadable ${field} ${failure} preserves prior state and signals incomplete`, async () => {
			const html = (await readFixture("profile.html")).replace(container,
				failure === "entry" ? brokenEntry : container.replace("></div>", ' aria-busy="true"></div>'));
			const parsed = parseProfilePage(html, "https://github.com/sample-user");
			assert.equal(parsed.row?.username, "sample-user");
			assert.equal(parsed.complete, false);
			if (failure === "entry") assert.ok(parsed.rejectedEntries > 0);
			else assert.ok(parsed.unreadableFields.includes(field));
			const prior = { profile: { fetched_at: "2026-10-01T00:00:00Z" } };
			const state = structuredClone(prior);
			const messages: EmittedMessage[] = [];
			const records: unknown[] = [];
			await collectGitHubBrowser({
				emit: async (message) => { messages.push(message); },
				emitRecord: async (_stream, record) => { records.push(record); },
				progress: async () => {},
				requested: new Set(["profile"]), state,
			}, {
				fetchPublicJson: async (url) => apiObservation(url, []),
				now: () => new Date("2026-10-20T17:00:00Z"),
				openPage: async (url) => pageObservation(url, html),
				sleep: async () => {},
			});
			assert.deepEqual(messages.map(message => message.type), ["SKIP_RESULT"]);
			const skip = messages[0];
			assert.ok(skip?.type === "SKIP_RESULT");
			assert.equal(skip.stream, "profile");
			assert.equal(skip.reason, "github_browser_incomplete");
			assert.deepEqual(skip.recovery_hint, { action: "retry_by_runtime", retryable: true });
			assert.deepEqual(records, []);
			assert.deepEqual(state, prior);
		});
	}
}


for (const nested of [false, true]) {
 test(`ambiguous repository rows preserve prior state with terminal pagination: ${nested ? "nested row" : "two identities"}`, async () => {
  const messages: EmittedMessage[] = [];
  const records: unknown[] = [];
  const prior = { repositories: { fetched_at: "2026-10-01T00:00:00Z" } };
  const state = structuredClone(prior);
  const second = '<h3><a href="/sample-user/second">second</a></h3>';
  const html = withOwner(`<main><div id="user-repositories-list"><ul><li><h3><a href="/sample-user/first">first</a></h3>${nested ? `<ul><li>${second}</li></ul>` : second}<span class="Label">Public</span><relative-time datetime="2026-10-19T00:00:00Z"></relative-time></li></ul></div>${terminalInventory}</main>`);
  await collectGitHubBrowser({
   emit: async message => { messages.push(message); },
   emitRecord: async (_stream, data) => { records.push(data); },
   progress: async () => {}, requested: new Set(["repositories"]), state,
  }, {
   fetchPublicJson: async url => apiObservation(url, []),
   now: () => new Date("2026-10-20T17:00:00Z"),
   openPage: async url => pageObservation(url, url === "https://github.com/" ? profilePlaceholder : html),
   sleep: async () => {},
  });
  assert.deepEqual(records, []);
  assert.deepEqual(state, prior);
  assert.deepEqual(messages.map(message => message.type), ["SKIP_RESULT"]);
  const skip = messages[0];
  assert.ok(skip?.type === "SKIP_RESULT");
  assert.equal(skip.stream, "repositories");
  assert.equal(skip.reason, "inventory_not_proven_complete");
 });
}
