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
): Array<{ count: number; date: string; level: number }> {
	const days = [];
	for (
		let date = new Date(`${startDate}T00:00:00Z`);
		date.toISOString().slice(0, 10) <= endDate;
		date.setUTCDate(date.getUTCDate() + 1)
	) {
		days.push({ count: 1, date: date.toISOString().slice(0, 10), level: 1 });
	}
	return days;
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
		validateRecord("repositories", {
			id: "sample-user:repositories",
			repositories,
		}).ok,
		true,
	);
});

test("repository and starred pages require list or explicit empty evidence", () => {
	for (const stream of ["repositories", "starred"] as const) {
		assert.equal(
			inspectInventoryPage("<main>Sign in</main>", stream, "sample-user", 1, 0)
				.valid,
			false,
		);
		const empty =
			stream === "repositories"
				? "sample-user doesn't have any public repositories yet"
				: "sample-user hasn't starred any repositories yet";
		assert.deepEqual(
			inspectInventoryPage(
				`<main>${empty}</main>`,
				stream,
				"sample-user",
				1,
				0,
			),
			{ valid: true, nextUrl: null },
		);
		const list =
			stream === "repositories"
				? "user-repositories-list"
				: "user-starred-repos";
		const html = `<main><ul id="${list}"></ul><a class="next_page" rel="next" href="/sample-user?tab=${stream === "repositories" ? "repositories" : "stars"}&after=cursor">Next</a></main>`;
		assert.equal(
			inspectInventoryPage(html, stream, "sample-user", 1, 1).nextUrl?.includes(
				"after=cursor",
			),
			true,
		);
		assert.equal(
			inspectInventoryPage(
				html.replace("/sample-user?", "/other-user?"),
				stream,
				"sample-user",
				1,
				1,
			).valid,
			false,
		);
	}
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

test("contributions tolerate absent prior views but never claim them as zero", () => {
	const current = {
		days: calendarDays("2025-01-02", "2026-01-01"),
		total: 1234,
		year: 2026,
	};
	const snapshot = buildContributionSnapshot(
		[
			current,
			{ days: [], total: 0, year: 2025 },
			{ days: [], total: 0, year: 2024 },
			{ days: calendarDays("2023-01-01", "2023-12-31"), total: 40, year: 2023 },
		],
		"2026-01-01T00:00:00Z",
	);
	assert.equal(snapshot?.totalContributionsLastYear, 1234);
	assert.deepEqual(snapshot?.yearTotals.map(({ year }) => year), [2026, 2023]);
	assert.equal(snapshot?.days.some(({ date }) => date.startsWith("2024-")), false);
	assert.equal(
		validateRecord("contributions", { id: "sample-user:contributions", ...snapshot }).ok,
		true,
	);
	assert.equal(
		buildContributionSnapshot(
			[{ days: [], total: 0, year: 2026 }, ...[2025, 2024, 2023].map((year) => ({ days: [], total: 0, year }))],
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
		validateRecord("events", {
			id: "sample-user:events",
			events: [pullRequest],
			fetchedAt: "2026-01-02T00:00:00Z",
			windowDescription: "Recent events",
		}).ok,
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
});
