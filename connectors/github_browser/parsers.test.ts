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

test("a contribution cell without count evidence cannot become a zero or complete aggregate", () => {
	const parsed = parseContributionHtml(
		'<h2 class="f4 text-normal mb-2">5 contributions</h2><td class="ContributionCalendar-day" data-date="2026-01-01"></td>',
	);
	assert.deepEqual(parsed.days, []);
	assert.equal(parsed.total, 5);
	const years = [2026, 2025, 2024, 2023].map((year) => ({ ...parsed, year }));
	assert.equal(buildContributionSnapshot(years, "2026-01-01T00:00:00Z"), null);
});

test("event detail additions reuse the PAT event parser and preserve nullable fields", () => {
	const event = parseLegacyEvent({
		id: "1",
		type: "PushEvent",
		created_at: "2026-01-01T00:00:00Z",
		repo: { name: "sample-user/demo" },
		payload: { ref: "refs/heads/main", size: 2 },
		public: true,
	});
	assert.equal(event?.branch, "main");
	assert.equal(event?.commits, 2);
	assert.equal(event?.repoUrl, "https://github.com/sample-user/demo");
});
