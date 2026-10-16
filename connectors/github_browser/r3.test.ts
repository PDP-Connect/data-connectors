// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import {
	parseContributionHtml,
	parseProfilePage,
	parseRepositoriesPage,
	parseStarredPage,
} from "./parsers.ts";
import type { BrowserServices } from "./types.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });
const fixture = (name: string) => readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8");
const terminal = '<div class="paginate-container"><span class="next_page disabled" aria-disabled="true">Next</span></div>';

async function collect(stream: string, html: string, overrides: Partial<BrowserServices> = {}) {
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string; stream?: string }> = [];
	const state: Record<string, unknown> = {};
	await collectGitHubBrowser({
		emit: async (message) => { messages.push(message); },
		emitRecord: async (selected, data) => { records.push({ stream: selected, data }); },
		progress: async () => {},
		requested: new Set([stream]),
		state,
	}, {
		openPage: async (url) => page(url, url === "https://github.com/" ? owner : owner + html),
		fetchPublicJson: async (url) => ({ requestedUrl: url, responseUrl: url, status: 200, data: [] }),
		now: () => new Date("2026-01-01T00:00:00Z"),
		sleep: async () => {},
		...overrides,
	});
	return { records, messages, state };
}

function assertPartial(result: Awaited<ReturnType<typeof collect>>, stream: string) {
	assert.equal(result.records.length, 1, "readable data remains in one partial legacy aggregate");
	assert.equal(result.records[0]?.data.id, `sample-user:${stream}`);
	assert.equal(result.state[stream], undefined);
	assert.equal(result.messages.some(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE"), false);
	assert.ok(result.messages.some(({ type }) => type === "SKIP_RESULT"));
}

const optionalMutations: Array<[string, (html: string) => string]> = [
	["description selector", (html) => html.replace('itemprop="description"', 'data-testid="description"')],
	["topic selector", (html) => html.replace('class="topic-tag"', 'class="TopicTag"')],
	["topic children inside recognized container", (html) => html.replace(
		'<a class="topic-tag" href="/topics/fixture">fixture</a>',
		'<div class="topics-row-container"><a class="TopicTag" href="/topics/fixture">fixture</a></div>',
	)],
];
for (const [label, mutate] of optionalMutations) {
	test(`r3 optional ${label} drift retains the row without completion authority`, async () => {
		const html = mutate(await fixture("repositories.html"));
		const parsed = parseRepositoriesPage(html);
		assert.equal(parsed.rows.length, 1);
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.length > 0);
		if (label.startsWith("topic")) assert.notDeepEqual(parsed.rows[0]?.topics, []);
		const result = await collect("repositories", html + terminal);
		assertPartial(result, "repositories");
		assert.equal((result.records[0]?.data.repositories as unknown[]).length, 1);
	});
}

test("r3 optional pinned description drift retains the profile without completion authority", async () => {
	const html = (await fixture("profile-current-github.html")).replace('class="pinned-item-desc"', 'class="PinnedItemDescription"');
	const parsed = parseProfilePage(html, "https://github.com/sample-user");
	assert.equal(parsed.row?.pinnedRepositories?.length, 1);
	assert.equal(parsed.complete, false);
	const result = await collect("profile", html);
	assertPartial(result, "profile");
});

const inventory = async (stream: "repositories" | "starred") => {
	return stream === "repositories"
		? fixture("repositories.html")
		: '<ul id="user-starred-repos"><li><h3><a href="/sample-user/demo">sample-user/demo</a></h3><p>Synthetic fixture repository</p><span itemprop="programmingLanguage">TypeScript</span><a href="/sample-user/demo/stargazers">12</a><relative-time datetime="2026-01-02T00:00:00Z"></relative-time></li></ul>';
};
for (const stream of ["repositories", "starred"] as const) {
	for (const [label, suffix] of [
		["missing terminal paginator", ""],
		["load-more button", '<button type="button">Load more</button>'],
		["load-more form", '<form action="?page=2"><button>Load more</button></form>'],
		["deferred paginator", '<include-fragment src="/sample-user?page=2"></include-fragment>'],
	] as const) {
		test(`r3 ${stream} ${label} cannot prove an inventory end`, async () => {
			const result = await collect(stream, await inventory(stream) + suffix);
			assertPartial(result, stream);
			assert.equal((result.records[0]?.data[stream] as unknown[]).length, 1);
		});
	}

	for (const [label, candidate] of [
		["non-li skeleton", '<div class="Box-row skeleton"></div>'],
		["unmarked non-li placeholder", '<div class="Box-row"></div>'],
		["identityless li", '<li><div class="skeleton"></div></li>'],
		["unrecognized row wrapper", '<div role="listitem"><h3><a href="/sample-user/deferred">deferred</a></h3></div>'],
	] as const) {
		test(`r3 ${stream} accounts for ${label} beside a readable row`, async () => {
			const html = (await inventory(stream)).replace("</ul>", candidate + "</ul>");
			const parsed = stream === "repositories" ? parseRepositoriesPage(html) : parseStarredPage(html);
			assert.equal(parsed.complete, false);
			assert.ok(parsed.rawRows >= 2 || parsed.rejectedRows > 0 || parsed.unreadableFields.length > 0);
			const result = await collect(stream, html + terminal);
			assertPartial(result, stream);
			assert.ok((result.records[0]?.data[stream] as unknown[]).length >= 1);
		});
	}

	test(`r3 ${stream} a real terminal marker and overlay loading preserve completion`, async () => {
		const html = (await inventory(stream)).replace("</li>", '<select-panel><dialog><include-fragment aria-busy="true"><div class="skeleton">Loading</div></include-fragment></dialog></select-panel></li>');
		const result = await collect(stream, html + terminal);
		assert.equal(result.records.length, 1);
		assert.ok(result.messages.some(({ type }) => type === "STATE"));
		assert.ok(result.messages.some(({ type }) => type === "DETAIL_COVERAGE"));
	});
}

test("r3 renamed repository paginator cannot silently end on page one", async () => {
	const first = await inventory("repositories");
	const visited: string[] = [];
	const result = await collect("repositories", "", {
		openPage: async (url) => {
			visited.push(url);
			if (url === "https://github.com/") return page(url, owner);
			if (url.includes("page=2")) return page(url, owner + "<main>Loading</main>");
			return page(url, owner + first + '<a class="Pagination-next" rel="next" href="/sample-user?page=2&tab=repositories">Next</a>');
		},
	});
	assertPartial(result, "repositories");
	assert.equal((result.records[0]?.data.repositories as unknown[]).length, 1);
	// Either follow the safely recognized next relation or refuse the unknown layout.
	assert.ok(visited.length >= 2);
});

const profileCollectionMutations: Array<[string, string, string]> = [
	["pinned non-li wrapper", '<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><div role="listitem"><a href="/sample-owner/deferred">deferred</a></div></div>'],
	["pinned link-only card", '<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><ol><li><a href="/sample-owner/deferred">deferred</a></li></ol></div>'],
	["pinned placeholder", '<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><div class="skeleton"></div></div>'],
	["organization placeholder", '<div class="avatar-group"></div>', '<div class="avatar-group"><div class="skeleton"></div></div>'],
	["achievement placeholder", '<div class="profile-achievements"></div>', '<div class="profile-achievements"><div class="skeleton"></div></div>'],
];
for (const [label, before, after] of profileCollectionMutations) {
	test(`r3 profile ${label} cannot certify an empty or fully rendered collection`, async () => {
		const html = (await fixture("profile.html")).replace(before, after);
		const parsed = parseProfilePage(html, "https://github.com/sample-user");
		assert.ok(parsed.row);
		assert.equal(parsed.complete, false);
		assert.ok(parsed.rejectedEntries > 0 || parsed.unreadableFields.length > 0);
		assertPartial(await collect("profile", html), "profile");
	});
}

// Sections are anchored by heading and links, so renamed container classes are still read.
for (const [collection, before, after] of [
	["organizations", '<div class="avatar-group"></div>', '<div class="avatar-group"><a class="OrganizationItem" href="/sample-org"><img alt="@sample-org" src="https://avatars.githubusercontent.com/u/2"></a></div>'],
	["achievements", '<div class="profile-achievements"></div>', '<div class="profile-achievements"><a href="/sample-user?achievement=sample&tab=achievements"><img alt="Achievement: Sample Badge" src="https://github.githubassets.com/assets/sample.png"></a></div>'],
] as const) {
	test(`r3 profile ${collection} are read by heading and link when container classes drift`, async () => {
		const parsed = parseProfilePage((await fixture("profile.html")).replace(before, after), "https://github.com/sample-user");
		assert.equal(parsed.row?.[collection]?.length, 1);
		assert.equal(parsed.complete, true);
	});
}

function calendar(start: string, end: string): string {
	let html = '<div class="js-yearly-contributions"><h2 class="f4 text-normal mb-2">0 contributions</h2>';
	for (let date = new Date(start + "T00:00:00Z"); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1)) {
		html += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="0" data-level="0"></td>`;
	}
	return html + "</div>";
}
const busyMutations: Array<[string, (html: string) => string]> = [
	["graph", (html) => html.replace('class="js-yearly-contributions"', 'class="js-yearly-contributions" aria-busy="true"')],
	["heading", (html) => html.replace("<h2 ", '<h2 aria-busy="true" ')],
	["cell", (html) => html.replace("<td ", '<td aria-busy="true" ')],
];
for (const [label, mutate] of busyMutations) {
	test(`r3 busy contribution ${label} vetoes authority despite retained numbers and full date coverage`, async () => {
		const parsed = parseContributionHtml(mutate(calendar("2025-01-02", "2026-01-01")));
		assert.equal(parsed.complete, false);
		const result = await collect("contributions", "", {
			openContributionPage: async (url) => {
				const year = Number(/from=(\d{4})/u.exec(url)?.[1] ?? 2026);
				const html = year === 2026 ? mutate(calendar("2025-01-02", "2026-01-01")) : calendar(`${year}-01-01`, `${year}-12-31`);
				return page(url, owner + html);
			},
		});
		assertPartial(result, "contributions");
		assert.ok((result.records[0]?.data.days as unknown[]).length > 0, "readable dates from the other three years survive");
	});
}

for (const stream of ["repositories", "starred"] as const) {
	test(`r3 ${stream} displayed count mismatch vetoes even a disabled-next marker`, async () => {
		const tab = stream === "repositories" ? "repositories" : "stars";
		const count = `<a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">2</span></a>`;
		const result = await collect(stream, count + await inventory(stream) + terminal);
		assertPartial(result, stream);
		assert.equal((result.records[0]?.data[stream] as unknown[]).length, 1);
	});
	test(`r3 ${stream} exact unfiltered page-one count proves a rendered single page`, async () => {
		const tab = stream === "repositories" ? "repositories" : "stars";
		const count = `<a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">1</span></a>`;
		const result = await collect(stream, count + await inventory(stream));
		assert.equal((result.records[0]?.data[stream] as unknown[]).length, 1);
		assert.ok(result.messages.some(({ type }) => type === "STATE"));
		assert.ok(result.messages.some(({ type }) => type === "DETAIL_COVERAGE"));
	});
}

for (const [collection, before, after] of [
	["pinnedRepositories", '<div class="js-pinned-items-reorder-container"></div>', '<div class="js-pinned-items-reorder-container"><ol><li><div class="Box pinned-item-list-item"><a href="/sample-owner/known"><span class="repo">known</span></a><p class="pinned-item-desc">Synthetic repository</p><p class="mb-0 f6 color-fg-muted"><span itemprop="programmingLanguage">TypeScript</span><a href="/sample-owner/known/stargazers">1</a></p></div></li></ol><div class="skeleton"></div></div>'],
	["organizations", '<div class="avatar-group"></div>', '<div class="avatar-group"><a class="avatar-group-item" href="/sample-org" aria-label="sample-org"><img alt="@sample-org" src="https://avatars.githubusercontent.com/u/2"></a><div class="skeleton"></div></div>'],
	["achievements", '<div class="profile-achievements"></div>', '<div class="profile-achievements"><a class="js-achievement-card" href="/sample-user/achievements/sample"><img alt="Achievement: Sample Badge" src="https://github.githubassets.com/assets/sample.png"></a><div class="skeleton"></div></div>'],
] as const) {
	test(`r3 profile preserves readable ${collection} while unknown siblings veto completion`, async () => {
		const html = (await fixture("profile.html")).replace(before, after);
		const parsed = parseProfilePage(html, "https://github.com/sample-user");
		assert.equal(parsed.row?.[collection]?.length, 1);
		assert.equal(parsed.complete, false);
		const result = await collect("profile", html);
		assertPartial(result, "profile");
		assert.equal((result.records[0]?.data[collection] as unknown[]).length, 1);
	});
}

for (const stream of ["repositories", "starred"] as const) {
	const tab = stream === "repositories" ? "repositories" : "stars";
	for (const [label, evidence] of [
		["next relation without href", '<a rel="next">Next</a>'],
		["future-page link with drifted class relation and label", `<a class="PagerForward" href="/sample-user?page=2&tab=${tab}">Continue inventory</a>`],
		["malformed displayed count", `<a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">1?</span></a>`],
	] as const) {
		test(`r3 ${stream} ${label} vetoes a contradictory terminal marker`, async () => {
			const result = await collect(stream, await inventory(stream) + evidence + terminal);
			assertPartial(result, stream);
			assert.equal((result.records[0]?.data[stream] as unknown[]).length, 1);
		});
	}
}
