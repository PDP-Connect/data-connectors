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
	parseLegacyEventPageItem,
	parseLegacyHistoryPageItem,
	parseLegacyHistoryItem,
	parseProfileHtml,
	parseProfilePage,
	parseRepositoriesHtml,
	parseRepositoriesPage,
	parseStarredHtml,
	parseStarredPage,
} from "./parsers.ts";
import { validateEntity, validateRecord } from "./schemas.ts";

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
	assert.equal(validateRecord("repositories", { id: "sample-user:repositories", repositories }).ok, true);
	assert.equal(
		validateEntity("repositories", { ...(repositories[0] ?? {}) } as Parameters<
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
		'<main><ul id="user-starred-repos"><li><h3><a href="/sample-owner/demo">sample-owner/demo</a></h3><span itemprop="programmingLanguage"></span></li></ul></main>',
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
					`<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><div id="${stream === "repositories" ? "user-repositories-list" : "user-starred-repos"}">${empty}</div></main>`,
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
		const html = `<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><ul id="${list}"><li><h3><a href="/sample-user/demo">demo</a></h3><p itemprop="description"></p><span itemprop="programmingLanguage"></span><a href="/sample-user/demo/stargazers">0</a>${stream === "repositories" ? '<a href="/sample-user/demo/forks">0</a><span class="Label">Public</span><div class="topics-row-container"></div>' : ""}<relative-time datetime="2026-01-01T00:00:00Z"></relative-time></li></ul><a class="next_page" rel="next" href="/sample-user?page=2&tab=${stream === "repositories" ? "repositories" : "stars"}&after=cursor">Next</a></main>`;
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
	assert.equal(validateRecord("events", { id: "sample-user:events", events: [pullRequest], fetchedAt: "2026-01-02T00:00:00Z", windowDescription: "Fixture window" }).ok, true);
	assert.equal(
		validateEntity("events", { ...(pullRequest ?? {}) } as Parameters<
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

test("missing profile counts and strings remain unknown rather than fabricated", () => {
	const row = parseProfileHtml('<span class="p-nickname">sample-user</span><a href="/sample-user?tab=followers">Loading</a>', "https://github.com/sample-user");
	assert.equal(row?.followers, undefined);
	assert.equal(row?.bio, undefined);
});

test("missing repository fields remain unknown and empty names are rejected", () => {
	const rows = parseRepositoriesPage('<ul id="user-repositories-list"><li><h3><a href="/sample-user/demo">demo</a></h3></li><li><h3><a href="/sample-user/empty"></a></h3></li></ul>');
	assert.equal(rows.rows[0]?.stars, undefined);
	assert.equal(rows.rows[0]?.topics, undefined);
	assert.equal(rows.rejectedRows, 1);
});

test("starred main navigation never becomes repository inventory", () => {
	assert.deepEqual(parseStarredHtml('<main><li><h3><a href="/sponsors/sample-user">Sponsors</a></h3></li></main>'), []);
});

test("missing API payload fields remain unknown rather than invented", () => {
	const event = parseLegacyEvent({ id: "1", type: "PushEvent", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" } });
	assert.equal(event?.isPublic, undefined);
	assert.equal(event?.action, undefined);
	const history = parseLegacyHistoryItem({ id: 10, number: 2, repository_url: "https://api.github.com/repos/sample-user/demo" }, "issue");
	assert.equal(history?.comments, undefined);
	assert.equal(history?.labels, undefined);
});

test("profile completeness distinguishes readable zeroes and empty fields from absent or loading data", async () => {
	const html = await fixture("profile.html");
	const complete = parseProfilePage(html, "https://github.com/sample-user");
	assert.equal(complete.complete, true);
	for (const unreadable of [
		html.replace("<span>42</span>", "<span>Loading</span>"),
		html.replace('<div class="p-note"></div>', ""),
		// Without the profile structure, absent follower links prove nothing.
		html.replace(/<nav>.*?<\/nav>/u, "").replace('<a href="/sample-user?tab=followers"><span>42</span></a>', ""),
		html.replace('<div class="avatar-group"></div>', '<div class="avatar-group loading"></div>'),
	]) {
		const parsed = parseProfilePage(unreadable, "https://github.com/sample-user");
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.length > 0);
	}
	const loading = parseProfilePage(html.replace("<span>42</span>", "<span>Loading</span>"), "https://github.com/sample-user");
	assert.equal(loading.row?.followers, undefined);
	const zero = parseProfilePage(html.replace("<span>42</span>", "<span>0</span>"), "https://github.com/sample-user");
	assert.equal(zero.row?.followers, 0);
	assert.equal(zero.row?.bio, "");
	assert.equal(zero.complete, true);
});

test("profile completeness accounts for rejected pinned and organization entries", async () => {
	const html = await fixture("profile.html");
	const pinned = parseProfilePage(html.replace('<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><li><a href="/sponsors/sample-user">Sponsor</a></li></div>'), "https://github.com/sample-user");
	assert.equal(pinned.complete, false);
	assert.equal(pinned.rejectedEntries, 1);
	const organization = parseProfilePage(html.replace('<div class="avatar-group"></div>', '<div class="avatar-group"><a class="avatar-group-item" href="/"></a></div>'), "https://github.com/sample-user");
	assert.equal(organization.complete, false);
	assert.equal(organization.rejectedEntries, 1);
});

test("repository completeness requires identity and readable row fields", async () => {
	const html = await fixture("repositories.html");
	assert.equal(parseRepositoriesPage(html).complete, true);
	const blank = parseRepositoriesPage(html.replace(">demo</a>", "></a>"));
	assert.equal(blank.rejectedRows, 1);
	assert.deepEqual(blank.rows, []);
	const wrongRoute = parseRepositoriesPage(html.replace('href="/sample-user/demo"', 'href="/sponsors/sample-user"'));
	assert.equal(wrongRoute.rejectedRows, 1);
	for (const unreadable of [
		html.replace('<a href="/sample-user/demo/forks">2</a>', '<a href="/sample-user/demo/forks">Loading</a>'),
		html.replace('<a href="/sample-user/demo/stargazers">12</a>', '<a href="/sample-user/demo/stargazers">many</a>'),
		html.replace('<relative-time datetime="2026-01-02T00:00:00Z"></relative-time>', ""),
	]) {
		const parsed = parseRepositoriesPage(unreadable);
		assert.equal(parsed.rows.length, 1);
		assert.equal(parsed.complete, false);
	}
});

test("starred parsing is bounded to a recognized list and never consumes unrelated main links", () => {
	const html = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><li><h3><a href="/sponsors/sample-user">Sponsors</a></h3></li><div>Loading</div></main>';
	assert.deepEqual(parseStarredPage(html).rows, []);
	assert.equal(inspectInventoryPage(inventoryObservation("starred", html, 1), "starred", "sample-user", 1, 0, 0).reason, "unreadable_list");
	const forgedEmpty = html.replace("Loading", "You don’t have any starred repositories yet");
	assert.equal(inspectInventoryPage(inventoryObservation("starred", forgedEmpty, 1), "starred", "sample-user", 1, 0, 0).valid, false);
	const unreadable = parseStarredPage('<ul id="user-starred-repos"><li>Loading</li></ul>');
	assert.equal(unreadable.rejectedRows, 1);
	assert.equal(unreadable.complete, false);
});

test("skeletal API rows retain known fields without inventing completion", () => {
	const history = parseLegacyHistoryPageItem({ id: 10, number: 2, repository_url: "https://api.github.com/repos/sample-user/demo" }, "issue");
	assert.equal(history.row?.id, "gh-issue-10");
	assert.equal(history.complete, false);
	assert.equal(history.row?.comments, undefined);
	assert.equal(history.row?.labels, undefined);
	assert.equal(history.row?.title, undefined);
	const event = parseLegacyEventPageItem({ id: "1", type: "PushEvent", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" } });
	assert.equal(event.row?.id, "1");
	assert.equal(event.complete, false);
	assert.equal(event.row?.isPublic, undefined);
	assert.equal(event.row?.action, undefined);
});

test("history completeness preserves explicit empty/null/zero and rejects discarded labels", () => {
	const item = { id: 10, number: 2, repository_url: "https://api.github.com/repos/sample-user/demo", title: "", body: null, state: "open", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", closed_at: null, html_url: "https://github.com/sample-user/demo/issues/2", comments: 0, reactions: { total_count: 0 }, labels: [] };
	const parsed = parseLegacyHistoryPageItem(item, "issue");
	assert.equal(parsed.complete, true);
	assert.equal(parsed.row?.comments, 0);
	assert.deepEqual(parsed.row?.labels, []);
	assert.equal(parsed.row?.title, "");
	assert.equal(parsed.row?.body, null);
	assert.equal(parseLegacyHistoryPageItem({ ...item, labels: [{ name: "good" }, {}] }, "issue").complete, false);
});

test("PushEvent preserves an explicit empty commit list and checks every commit entry", () => {
	const event = { id: "1", type: "PushEvent", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" }, public: false, payload: { ref: "refs/heads/main", commits: [] } };
	const empty = parseLegacyEventPageItem(event);
	assert.equal(empty.complete, true);
	assert.equal(empty.row?.commits, 0);
	assert.equal(empty.row?.isPublic, false);
	assert.equal(parseLegacyEventPageItem({ ...event, payload: { ...event.payload, commits: [{ message: "Known" }, {}] } }).complete, false);
});

test("inventory end proof also rejects unreadable mapped fields", () => {
	for (const stream of ["repositories", "starred"] as const) {
		const list = stream === "repositories" ? "user-repositories-list" : "user-starred-repos";
		const html = `<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><ul id="${list}"><li><h3><a href="/sample-user/demo">demo</a></h3></li></ul></main>`;
		assert.equal(inspectInventoryPage(inventoryObservation(stream, html, 1), stream, "sample-user", 1, 1, 0).valid, false);
	}
});

test("collection loading markers veto otherwise readable profile entries", async () => {
	const html = await fixture("profile.html");
	for (const changed of [
		html.replace('<div class="avatar-group"></div>', '<div class="avatar-group"><a class="avatar-group-item" href="/sample-org" aria-label="Sample"><img src="https://example.test/org.png"></a><span class="loading">Loading</span></div>'),
		html.replace('<div class="profile-achievements"></div>', '<div class="profile-achievements"><div class="js-achievement-card"><img src="https://example.test/a.png" alt="Achievement: Test"></div><span class="loading">Loading</span></div>'),
	]) {
		assert.equal(parseProfilePage(changed, "https://github.com/sample-user").complete, false);
	}
});

test("profile partial collection entries preserve known fields and count missing evidence", async () => {
	const html = await fixture("profile.html");
	const pinned = parseProfilePage(html.replace('<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><li><a href="/sample-user/demo">demo</a><p class="pinned-item-desc">Known</p></li></div>'), "https://github.com/sample-user");
	assert.equal(pinned.row?.pinnedRepositories?.[0]?.fullName, "sample-user/demo");
	assert.equal(pinned.row?.pinnedRepositories?.[0]?.description, "Known");
	assert.equal(pinned.row?.pinnedRepositories?.[0]?.stars, undefined);
	assert.equal(pinned.complete, false);
	assert.equal(pinned.rejectedEntries, 1);
	const malformedPinned = parseProfilePage(html.replace('<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><li><a href="/sample-user/demo">demo</a><a href="/sample-user/demo/stargazers">many</a></li></div>'), "https://github.com/sample-user");
	assert.equal(malformedPinned.complete, false);
	const broken = parseProfilePage(html.replace('<div class="profile-achievements"></div>', '<div class="profile-achievements"><div class="js-achievement-card">Unreadable</div></div>'), "https://github.com/sample-user");
	assert.equal(broken.complete, false);
	assert.equal(broken.rejectedEntries, 1);
});

test("event titles preserve explicit null and missing titles cannot acquire completeness", () => {
	const event = { id: "1", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" }, public: true };
	const pr = { number: 4, body: null, head: { ref: null }, html_url: null, url: "https://api.github.com/repos/sample-user/demo/pulls/4" };
	const explicit = parseLegacyEventPageItem({ ...event, type: "PullRequestEvent", payload: { action: "opened", pull_request: { ...pr, title: null } } });
	assert.equal(explicit.row?.title, null);
	assert.equal(explicit.row?.url, null);
	assert.equal(explicit.complete, true);
	const missing = parseLegacyEventPageItem({ ...event, type: "PullRequestEvent", payload: { action: "opened", pull_request: pr } });
	assert.equal(missing.row?.title, undefined);
	assert.equal(missing.complete, false);
	const issue = parseLegacyEventPageItem({ ...event, type: "IssuesEvent", payload: { action: "opened", issue: { number: 4, title: null, body: null, html_url: null } } });
	assert.equal(issue.row?.title, null);
	const release = parseLegacyEventPageItem({ ...event, type: "ReleaseEvent", payload: { action: "published", release: { name: null, tag_name: "v1", body: null, html_url: null } } });
	assert.equal(release.row?.title, null);
	assert.equal(release.complete, true);
});

test("current GitHub profile: contribution heading, tab counter, badges and empty details are read", async () => {
	const parsed = parseProfilePage(
		await fixture("profile-current-github.html"),
		"https://github.com/sample-user",
	);
	assert.equal(parsed.row?.contributionsLastYear, 1234);
	assert.equal(parsed.row?.repositoryCount, 8);
	assert.deepEqual(parsed.row?.achievements, [
		{ name: "Sample Badge", iconUrl: "https://github.githubassets.com/assets/sample-badge.png" },
	]);
	assert.equal(parsed.row?.pinnedRepositories?.[0]?.stars, 5);
	// An empty rendered details list proves company, location and website are unset.
	for (const key of ["company", "location", "website"] as const)
		assert.equal(key in (parsed.row ?? {}), false);
	// The page has no follower links and is recognisably a profile, so both are omitted.
	for (const key of ["followers", "following"] as const)
		assert.equal(key in (parsed.row ?? {}), false);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.row?.organizations?.[0]?.login, "sample-org");
	assert.equal(parsed.complete, true);
});

test("profile details list with an entry that has no readable fields stays unreadable", () => {
	const parsed = parseProfilePage(
		'<span class="p-nickname">sample-user</span><ul class="vcard-details"><li class="vcard-detail">?</li></ul>',
		"https://github.com/sample-user",
	);
	for (const key of ["company", "location", "website"])
		assert.equal(parsed.unreadableFields.includes(key), true);
});

test("contribution total comes from the contribution heading, not an earlier similar heading", () => {
	const parsed = parseContributionHtml(
		'<h2 class="f4 mb-2 text-normal">Popular repositories</h2><h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">1 contribution in 2025</h2><td class="ContributionCalendar-day" data-date="2025-01-01" data-count="1" data-level="1"></td>',
	);
	assert.equal(parsed.total, 1);
	assert.equal(parsed.complete, true);
	assert.deepEqual(parsed.unreadableFields, []);
	const missing = parseContributionHtml(
		'<h2 class="f4 mb-2 text-normal">Popular repositories</h2><td class="ContributionCalendar-day" data-date="2025-01-01" data-count="1" data-level="1"></td>',
	);
	assert.equal(missing.complete, false);
});

test("loading panels inside a row's menus do not make a rendered repository list unreadable", async () => {
	const html = await fixture("repositories-current-github.html");
	const parsed = parseRepositoriesPage(html);
	assert.equal(parsed.rows.length, 1);
	assert.equal(parsed.rawRows, 1);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	// A loading marker on the list itself still withholds completion.
	assert.equal(
		parseRepositoriesPage(html.replace('id="user-repositories-list"', 'id="user-repositories-list" aria-busy="true"')).complete,
		false,
	);
	assert.equal(
		parseRepositoriesPage(html.replace("<ul>", '<ul><li aria-busy="true"><h3><a href="/sample-user/other">other</a></h3></li>')).complete,
		false,
	);
});

test("current GitHub starred empty state with filter menus has no rows to discard", async () => {
	const html = await fixture("starred-empty-with-menus-current-github.html");
	const parsed = parseStarredPage(html);
	assert.equal(parsed.rawRows, 0);
	assert.equal(parsed.rejectedRows, 0);
	assert.equal(parsed.complete, true);
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
			parsed.rows.length,
			parsed.rejectedRows,
		),
		{ valid: true, nextUrl: null, reason: "terminal_list" },
	);
});

test("a rendered repository row without optional slots omits those fields and counts as read", async () => {
	const html = await fixture("repositories.html");
	const bare = html
		.replace('<p itemprop="description">Synthetic fixture repository</p>', "")
		.replace('<span itemprop="programmingLanguage">TypeScript</span>', "")
		.replace('<a href="/sample-user/demo/stargazers">12</a>', "")
		.replace('<a href="/sample-user/demo/forks">2</a>', "")
		.replace('<a class="topic-tag" href="/topics/fixture">fixture</a>', "");
	const parsed = parseRepositoriesPage(bare);
	assert.equal(parsed.rows.length, 1);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	const row = parsed.rows[0] ?? ({} as Record<string, unknown>);
	for (const key of ["description", "language", "stars", "forks", "topics"]) {
		assert.equal(key in row, false, key);
	}
	assert.equal(validateRecord("repositories", { id: "sample-user:repositories", repositories: parsed.rows }).ok, true);
	const owned = `<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>${bare}`;
	assert.deepEqual(
		inspectInventoryPage(
			inventoryObservation("repositories", owned, 1),
			"repositories", "sample-user", 1, parsed.rows.length, parsed.rejectedRows,
		),
		{ valid: false, nextUrl: null, reason: "terminal_unverified" },
	);
	const terminal = owned +
		'<div class="paginate-container"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
	assert.deepEqual(
		inspectInventoryPage(
			inventoryObservation("repositories", terminal, 1),
			"repositories", "sample-user", 1, parsed.rows.length, parsed.rejectedRows,
		),
		{ valid: true, nextUrl: null, reason: "terminal_list" },
	);
});

test("a repository row slot that is present but malformed or loading still vetoes", async () => {
	const html = await fixture("repositories.html");
	for (const changed of [
		html.replace('<a href="/sample-user/demo/stargazers">12</a>', '<a href="/sample-user/demo/stargazers">many</a>'),
		html.replace("<li>", '<li aria-busy="true">'),
		html.replace('<span itemprop="programmingLanguage">TypeScript</span>', '<span itemprop="programmingLanguage" class="loading">Loading</span>'),
	]) {
		assert.equal(parseRepositoriesPage(changed).complete, false);
	}
});

test("a starred row without optional slots omits them and a malformed star count vetoes", () => {
	const base = (inner: string): string => `<main><ul id="user-starred-repos"><li><h3><a href="/sample-owner/demo">sample-owner/demo</a></h3>${inner}<relative-time datetime="2026-01-02T00:00:00Z"></relative-time></li></ul></main>`;
	const bare = parseStarredPage(base(""));
	assert.equal(bare.complete, true);
	for (const key of ["description", "language", "stars"]) assert.equal(key in (bare.rows[0] ?? {}), false, key);
	assert.equal(parseStarredPage(base('<a href="/sample-owner/demo/stargazers">many</a>')).complete, false);
});

test("a profile without follower links is omitted when recognisable and unreadable when not", async () => {
	const html = await fixture("profile.html");
	const links = (text: string): string => text
		.replace('<a href="/sample-user?tab=followers"><span>42</span></a>', "")
		.replace('<a href="/sample-user?tab=following"><span>7</span></a>', "");
	const bare = parseProfilePage(links(html), "https://github.com/sample-user");
	assert.equal(bare.complete, true);
	assert.equal(bare.row?.contributionsLastYear, 1234);
	assert.equal("followers" in (bare.row ?? {}), false);
	assert.equal("following" in (bare.row ?? {}), false);
	const unrecognised = parseProfilePage(links(html).replace(/<nav>.*?<\/nav>/u, ""), "https://github.com/sample-user");
	assert.equal(unrecognised.complete, false);
	for (const key of ["followers", "following"]) assert.ok(unrecognised.unreadableFields.includes(key), key);
	for (const changed of [
		html.replace("<span>42</span>", "<span>lots</span>"),
		html.replace("<span>7</span>", "<span>Loading</span>"),
	]) {
		assert.equal(parseProfilePage(changed, "https://github.com/sample-user").complete, false);
	}
});

test("link-only pinned cards lack render proof while known empty slots preserve completeness", async () => {
	const html = await fixture("profile.html");
	const empty = '<div class="js-pinned-items-reorder-container"></div>';
	const card = (inner: string): string => `<div class="js-pinned-items-reorder-container"><li><a href="/sample-user/demo">demo</a>${inner}</li></div>`;
	const bare = parseProfilePage(html.replace(empty, card("")), "https://github.com/sample-user");
	assert.equal(bare.complete, false);
	assert.equal(bare.rejectedEntries, 1);
	assert.equal(bare.row?.pinnedRepositories?.[0]?.fullName, "sample-user/demo");
	const pinned = bare.row?.pinnedRepositories?.[0] ?? {};
	for (const key of ["description", "language", "stars"]) assert.equal(key in pinned, false, key);
	assert.equal(parseProfilePage(html.replace(empty, card('<p class="pinned-item-desc" aria-busy="true">x</p>')), "https://github.com/sample-user").complete, false);
	const renderedCard = '<div class="js-pinned-items-reorder-container"><li><div class="pinned-item-list-item"><a href="/sample-user/demo"><span class="repo">demo</span></a><p class="pinned-item-desc"></p><p class="f6"></p></div></li></div>';
	const rendered = parseProfilePage(html.replace(empty, renderedCard), "https://github.com/sample-user");
	assert.equal(rendered.complete, true);
	assert.equal(rendered.row?.pinnedRepositories?.[0]?.description, "");
	for (const key of ["language", "stars"])
		assert.equal(key in (rendered.row?.pinnedRepositories?.[0] ?? {}), false, key);
});
