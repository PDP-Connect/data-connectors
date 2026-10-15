// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	buildContributionSnapshot,
	inspectInventoryPage,
	parseContributionHtml,
	parseLegacyEvent,
	parseProfileHtml,
	parseRepositoriesHtml,
	parseRepositoriesPage,
	parseStarredHtml,
	parseStarredPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): Promise<string> =>
	readFile(
		new URL(`./__fixtures__/synthetic/${name}`, import.meta.url),
		"utf8",
	);

function calendarDays(
	startDate: string,
	endDate: string,
): Array<{ id: string; count: number; date: string; level: number }> {
	const days = [];
	for (
		let date = new Date(`${startDate}T00:00:00Z`);
		date.toISOString().slice(0, 10) <= endDate;
		date.setUTCDate(date.getUTCDate() + 1)
	) {
		days.push({ count: 1, date: date.toISOString().slice(0, 10), level: 1 });
	}
	return days.map((day) => ({ ...day, id: day.date }));
}

function inventoryObservation(
	stream: "repositories" | "starred",
	html: string,
	pageNumber: number,
) {
	const tab = stream === "repositories" ? "repositories" : "stars";
	const url = `https://github.com/sample-user?page=${pageNumber}&tab=${tab}`;
	return { requestedUrl: url, currentUrl: url, html };
}

test("synthetic browser HTML retains legacy profile and repository fields", async () => {
	const profile = parseProfileHtml(
		await fixture("profile.html"),
		"https://github.com/sample-user",
	);
	assert.equal(profile?.contributionsLastYear, 1234);
	assert.equal(profile?.followers, 42);
	assert.equal(
		validateRecord("profile", { id: "sample-user:profile", ...profile }).ok,
		true,
	);
	const repositories = parseRepositoriesHtml(
		await fixture("repositories.html"),
	);
	assert.equal(repositories[0]?.name, "demo");
	assert.equal(repositories[0]?.stars, 12);
	assert.equal(
		validateRecord("repositories", { ...(repositories[0] ?? {}) } as Parameters<
			typeof validateRecord
		>[1]).ok,
		true,
	);
});

test("inventory parsing accounts for rejected rows and preserves empty source strings", () => {
	const repositories = parseRepositoriesPage(
		'<main><ul id="user-repositories-list"><li><h3><a href="/sample-user/demo">demo</a></h3><p itemprop="description"></p><span itemprop="programmingLanguage"></span></li><li><h3>Missing link</h3></li></ul></main>',
	);
	assert.equal(repositories.rawRows, 2);
	assert.equal(repositories.rejectedRows, 1);
	assert.equal(repositories.rows[0]?.description, "");
	assert.equal(repositories.rows[0]?.language, "");

	const starred = parseStarredPage(
		'<main><ul><li><h3><a href="/sample-owner/demo">sample-owner/demo</a></h3><span itemprop="programmingLanguage"></span></li></ul></main>',
	);
	assert.equal(starred.rows[0]?.language, "");
});

test("repository and starred pages require list or explicit empty evidence", () => {
	for (const stream of ["repositories", "starred"] as const) {
		assert.equal(
			inspectInventoryPage(
				inventoryObservation(stream, "<main>Sign in</main>", 1),
				stream,
				"sample-user",
				1,
				0,
				0,
			).valid,
			false,
		);
		const empty =
			stream === "repositories"
				? "sample-user doesn't have any public repositories yet"
				: "sample-user hasn't starred any repositories yet";
		assert.deepEqual(
			inspectInventoryPage(
				inventoryObservation(
					stream,
					`<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main>${empty}</main>`,
					1,
				),
				stream,
				"sample-user",
				1,
				0,
				0,
			),
			{ valid: true, nextUrl: null, reason: "terminal_list" },
		);
		const list =
			stream === "repositories"
				? "user-repositories-list"
				: "user-starred-repos";
		const html = `<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><ul id="${list}"></ul><a class="next_page" rel="next" href="/sample-user?page=2&tab=${stream === "repositories" ? "repositories" : "stars"}&after=cursor">Next</a></main>`;
		assert.equal(
			inspectInventoryPage(
				inventoryObservation(stream, html, 1),
				stream,
				"sample-user",
				1,
				1,
				0,
			).nextUrl?.includes("after=cursor"),
			true,
		);
		assert.equal(
			inspectInventoryPage(
				inventoryObservation(
					stream,
					html.replace("/sample-user?", "/other-user?"),
					1,
				),
				stream,
				"sample-user",
				1,
				1,
				0,
			).valid,
			false,
		);
	}
});

test("current GitHub starred empty state confirms an empty inventory", async () => {
	const html = await fixture("starred-empty-current-github.html");
	assert.deepEqual(parseStarredHtml(html), []);
	assert.deepEqual(
		inspectInventoryPage(
			inventoryObservation(
				"starred",
				`<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>${html}`,
				1,
			),
			"starred",
			"sample-user",
			1,
			0,
			0,
		),
		{ valid: true, nextUrl: null, reason: "terminal_list" },
	);
});

test("contribution summary requires the full rolling year and three complete prior years", async () => {
	const graph = parseContributionHtml(await fixture("contributions.html"));
	const incomplete = [2026, 2025, 2024].map((year) => ({ ...graph, year }));
	assert.equal(
		buildContributionSnapshot(incomplete, "2026-01-01T00:00:00Z"),
		null,
	);
	const firstDay = graph.days[0];
	assert.ok(firstDay);
	const partialYear = [2026, 2025, 2024, 2023].map((year) => ({
		days: [{ ...firstDay, date: `${year}-01-01` }],
		total: graph.total,
		year,
	}));
	assert.equal(
		buildContributionSnapshot(partialYear, "2026-01-02T00:00:00Z"),
		null,
	);
	const complete = [
		{
			days: calendarDays("2025-01-02", "2026-01-01"),
			total: 1234,
			year: 2026,
		},
		...[2025, 2024, 2023].map((year) => ({
			days: calendarDays(`${year}-01-01`, `${year}-12-31`),
			total: 100,
			year,
		})),
	];
	const snapshot = buildContributionSnapshot(complete, "2026-01-01T00:00:00Z");
	assert.equal(snapshot?.totalContributionsLastYear, 1234);
	assert.equal(snapshot?.yearTotals[0]?.year, 2026);
});

test("contributions reject absent prior views instead of emitting a silent partial snapshot", () => {
	const current = {
		days: calendarDays("2025-01-02", "2026-01-01"),
		total: 1234,
		year: 2026,
	};
	assert.equal(
		buildContributionSnapshot(
			[
				current,
				{ days: [], total: 0, year: 2025 },
				{ days: [], total: 0, year: 2024 },
				{
					days: calendarDays("2023-01-01", "2023-12-31"),
					total: 40,
					year: 2023,
				},
			],
			"2026-01-01T00:00:00Z",
		),
		null,
	);
	assert.equal(
		buildContributionSnapshot(
			[
				current,
				{ days: [], total: 5, year: 2025 },
				{ days: [], total: 0, year: 2024 },
				{ days: [], total: 0, year: 2023 },
			],
			"2026-01-01T00:00:00Z",
		),
		null,
	);
});

test("a contribution cell without count evidence cannot become a zero or complete aggregate", () => {
	const parsed = parseContributionHtml(
		'<h2 class="f4 text-normal mb-2">5 contributions</h2><td class="ContributionCalendar-day" data-date="2026-01-01"></td>',
	);
	assert.deepEqual(parsed.days, []);
	assert.equal(parsed.total, 5);
	const years = [2026, 2025, 2024, 2023].map((year) => ({ ...parsed, year }));
	assert.equal(buildContributionSnapshot(years, "2026-01-01T00:00:00Z"), null);
});

test("browser events recover legacy details from nested GitHub event payloads", () => {
	const push = parseLegacyEvent({
		id: "1",
		type: "PushEvent",
		created_at: "2026-01-01T00:00:00Z",
		repo: { name: "sample-user/demo" },
		payload: {
			commits: [{ message: "Fix parser\nMore details" }, { message: "Test" }],
			ref: "refs/heads/main",
			size: 2,
		},
		public: true,
	});
	assert.equal(push?.action, "pushed");
	assert.equal(push?.title, "Fix parser");
	assert.equal(push?.branch, "main");
	assert.equal(push?.commits, 2);
	assert.equal(push?.repoUrl, "https://github.com/sample-user/demo");

	const pullRequest = parseLegacyEvent({
		id: "2",
		type: "PullRequestEvent",
		created_at: "2026-01-02T00:00:00Z",
		repo: { name: "sample-user/demo" },
		payload: {
			action: "opened",
			pull_request: {
				body: "Description",
				head: { ref: "feature/parity" },
				html_url: "https://github.com/sample-user/demo/pull/4",
				title: "Restore event details",
			},
		},
		public: true,
	});
	assert.equal(pullRequest?.action, "opened");
	assert.equal(pullRequest?.title, "Restore event details");
	assert.equal(pullRequest?.body, "Description");
	assert.equal(pullRequest?.url, "https://github.com/sample-user/demo/pull/4");
	assert.equal(pullRequest?.branch, "feature/parity");
	assert.equal(
		validateRecord("events", { ...(pullRequest ?? {}) } as Parameters<
			typeof validateRecord
		>[1]).ok,
		true,
	);

	const issue = parseLegacyEvent({
		id: "3",
		type: "IssuesEvent",
		created_at: "2026-01-03T00:00:00Z",
		repo: { name: "sample-user/demo" },
		payload: {
			action: "closed",
			issue: {
				body: "Issue description",
				html_url: "https://github.com/sample-user/demo/issues/8",
				title: "Fix the report",
			},
		},
		public: true,
	});
	assert.equal(issue?.action, "closed");
	assert.equal(issue?.title, "Fix the report");
	assert.equal(issue?.body, "Issue description");
	assert.equal(issue?.url, "https://github.com/sample-user/demo/issues/8");

	const release = parseLegacyEvent({
		id: "4",
		type: "ReleaseEvent",
		created_at: "2026-01-04T00:00:00Z",
		repo: { name: "sample-user/demo" },
		payload: {
			action: "published",
			release: {
				name: "",
				tag_name: "v2.0.0",
				html_url: "https://example.test/release",
			},
		},
		public: true,
	});
	// The legacy formatter preserves an explicitly empty release name.
	assert.equal(release?.title, "");
});
