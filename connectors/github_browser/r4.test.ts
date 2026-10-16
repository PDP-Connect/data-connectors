// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Structure-only DOM shaped like the live GitHub pages: row chrome, data lines,
// plain-div profile sections and nested empty states. No personal values.

import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import {
	inspectInventoryPage,
	parseProfilePage,
	parseRepositoriesPage,
	parseStarredPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { BrowserServices } from "./types.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });
const terminal = '<div class="paginate-container"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
const profileUrl = "https://github.com/sample-user";

const starForm = `
<div class="js-toggler-container starring-container"><div class="starred BtnGroup">
	<form class="js-social-form"><input type="hidden" name="authenticity_token"><button type="submit" aria-label="Unstar this repository"><svg class="octicon"><path d="M0 0"/></svg><span class="d-inline">Starred</span></button></form>
	<user-list-menu><select-panel><dialog class="Overlay"><div class="Overlay-body"><include-fragment><div class="SelectPanel-loadingPanel" aria-busy="true">Loading</div></include-fragment><div class="blankslate"><h3>Oh no!</h3></div></div></dialog></select-panel></user-list-menu>
</div></div>`;
const chromeColumn = `<div class="col-2"><template class="js-unstar-confirmation-dialog-template"><div class="Box-header"><h2>Unstar this repository?</h2></div></template>${starForm}<svg class="sparkline" width="155" height="30"><g><rect x="0" y="0" width="3" height="3"/></g></svg></div>`;

function repositoryRow(opts: { fork?: boolean; license?: boolean; extra?: string; description?: boolean } = {}): string {
	return `<li class="col-12 d-flex" itemprop="owns"><div class="col-10">
	<div class="d-inline-block mb-1"><h3 class="wb-break-all"><a href="/sample-user/demo" itemprop="name codeRepository">demo</a><span></span><span class="Label Label--secondary">Public</span></h3></div>
	${opts.fork === true ? '<span class="f6 color-fg-muted mb-1">Forked from <a class="Link--muted" href="/sample-owner/upstream">sample-owner/upstream</a></span>' : ""}
	<div>${opts.description === false ? "" : '<p class="col-9" itemprop="description">Synthetic fixture repository</p>'}</div>
	<div class="f6 color-fg-muted mt-2"><span class="mr-3 ml-0"><span class="repo-language-color"></span><span itemprop="programmingLanguage">TypeScript</span></span>${opts.license === true ? '<span class="mr-3">MIT License</span>' : ""}Updated <relative-time datetime="2026-01-02T00:00:00Z" class="no-wrap">Jan 2, 2026</relative-time></div>
	${opts.extra ?? ""}</div>${chromeColumn}</li>`;
}
const repositories = (rows: string): string => `<div id="user-repositories-list"><ul data-filterable-for>${rows}</ul></div>`;

function starredRow(extra = ""): string {
	return `<li class="col-12"><div class="d-inline-block mb-1"><h3><a href="/sample-owner/demo">sample-owner / demo</a></h3></div><div><p>Synthetic starred repository</p></div><div class="f6 mt-2"><span class="mr-3"><span class="repo-language-color"></span><span itemprop="programmingLanguage">Go</span></span><a href="/sample-owner/demo/stargazers"><svg class="octicon"></svg>3</a><a href="/sample-owner/demo/forks"><svg class="octicon"></svg>1</a><span class="mr-3">Apache-2.0 license</span>Updated <relative-time datetime="2026-01-02T00:00:00Z">Jan 2, 2026</relative-time>${extra}</div>${chromeColumn}</li>`;
}
const listPromo = '<div class="blankslate border"><h3>Create your first list</h3><button type="button">Create list</button><dialog-helper><dialog class="Overlay"><div class="blankslate"><h3>Oh no!</h3></div></dialog></dialog-helper></div>';
const emptyStarred = `<main><turbo-frame id="user-starred-repos">${listPromo}<div class="toolbar d-flex"><h2>Stars <span>(0)</span></h2><details class="details-overlay"><summary class="btn">Sort</summary><details-menu role="menu"><button>Recently starred</button></details-menu></details></div><div class="wrapper"><span class="sr-only">0 results</span><div class="position-relative"><action-menu><div class="Overlay"><ul role="menu"><li role="none" class="ActionListItem"><button role="menuitemradio">Most stars</button></li></ul></div></action-menu></div><div class="d-flex"><div class="mt-5 blankslate"><h3>You don’t have any starred repositories yet.</h3><p>Star repositories to save them for later.</p></div></div></div></turbo-frame></main>`;

const tabNav = '<nav><ul><li><a data-tab-item="overview" href="/sample-user"><span data-content>Overview</span></a></li><li><a data-tab-item="repositories" href="/sample-user?tab=repositories"><span data-content>Repositories</span><span><span class="prc-CounterLabel-CounterLabel-x">8</span><span class="prc-VisuallyHidden-x">(8)</span></span></a></li></ul></nav>';
const header = '<h1 class="vcard-names"><span class="p-name vcard-fullname" itemprop="name"></span><span class="p-nickname vcard-username">sample-user</span></h1><img class="avatar avatar-user" src="https://avatars.githubusercontent.com/u/1">';
const achievementsBlock = (heading = "Achievements"): string => `<div class="border-top"><h2 class="h4 mb-2"><a href="/sample-user?tab=achievements" class="Link--primary">${heading}</a></h2><div class="d-flex flex-wrap"><a href="/sample-user?achievement=sample-badge&tab=achievements" class="position-relative"><img class="achievement-badge-sidebar" alt="Achievement: Sample Badge" src="https://github.githubassets.com/assets/sample-badge.png"></a></div></div>`;
const organizationsBlock = (heading = "Organizations"): string => `<div class="border-top clearfix"><h2 class="mb-2 h4">${heading}</h2><a aria-label="sample-org" itemprop="follows" class="avatar-group-item" data-hovercard-type="organization" href="/sample-org"><img class="avatar" alt="@sample-org" src="https://avatars.githubusercontent.com/u/2"></a></div>`;
const pinnedCard = `<li class="mb-3 d-flex"><div class="Box pinned-item-list-item"><div class="pinned-item-list-item-content"><div class="d-flex"><span class="position-relative"><a id="1" href="/sample-owner/known" class="Link text-bold"><span class="repo">known</span></a><tool-tip for="1" class="sr-only" role="tooltip">sample-owner/known</tool-tip></span><span class="flex-auto text-right"><span></span><span class="Label Label--secondary">Public</span></span></div><p class="color-fg-muted text-small mb-2">Forked from <a class="Link--muted" href="/sample-owner/upstream">sample-owner/upstream</a></p><p class="pinned-item-desc color-fg-muted">Synthetic pinned repository</p><p class="mb-0 f6 color-fg-muted"><span class="mr-3"><span class="repo-language-color"></span><span itemprop="programmingLanguage">TypeScript</span></span><a href="/sample-owner/known/stargazers"><svg class="octicon"></svg>5</a><a href="/sample-owner/known/forks"><svg class="octicon"></svg>2</a></p></div></div></li>`;
const pinnedSection = `<div class="js-pinned-items-reorder-container"><div class="float-right"><button class="pinned-items-setting-link Button--link">Customize your pins</button><dialog-helper><dialog class="Overlay"><div class="Overlay-body"><include-fragment aria-busy="true"><span>Loading</span></include-fragment></div></dialog></dialog-helper></div><h2 class="f4 mb-2 text-normal">Popular repositories</h2><ol class="d-flex flex-wrap">${pinnedCard}</ol></div>`;
const contributions = '<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">1,234 contributions in the last year</h2>';
function profile(parts: { sidebar?: string; followers?: string; pinned?: string; nav?: string; head?: string } = {}): string {
	return `${owner}${parts.nav ?? tabNav}<div class="h-card">${parts.head ?? header}<div class="js-profile-editable-area"><div class="p-note user-profile-bio"></div><ul class="vcard-details"></ul></div>${parts.followers ?? ""}${parts.sidebar ?? `${achievementsBlock()}${achievementsBlock()}${organizationsBlock()}`}</div>${parts.pinned ?? pinnedSection}${contributions}`;
}

// ---- live false vetoes, reproduced ----------------------------------------

test("r4 repository rows with form, sparkline, colour dot and Updated label parse as chrome", () => {
	const parsed = parseRepositoriesPage(repositories(repositoryRow()));
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	assert.equal(parsed.rows.length, 1);
	const row = parsed.rows[0] ?? ({} as Record<string, unknown>);
	assert.equal(row.description, "Synthetic fixture repository");
	assert.equal(row.language, "TypeScript");
	for (const key of ["stars", "forks", "topics", "license", "forkedFrom"]) assert.equal(key in row, false, key);
});

test("r4 a row without a description wrapper child or language is still an omission", () => {
	const html = repositories(repositoryRow({ description: false }).replace(/<span class="mr-3 ml-0">.*?<\/span><\/span>/u, ""));
	const parsed = parseRepositoriesPage(html);
	assert.equal(parsed.complete, true);
	assert.equal("description" in (parsed.rows[0] ?? {}), false);
	assert.equal("language" in (parsed.rows[0] ?? {}), false);
});

test("r4 the license line and the fork-parent line are parsed into fields", () => {
	const parsed = parseRepositoriesPage(repositories(repositoryRow({ fork: true, license: true })));
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	assert.equal(parsed.rows[0]?.license, "MIT License");
	assert.equal(parsed.rows[0]?.forkedFrom, "sample-owner/upstream");
	assert.equal(validateRecord("repositories", { id: "sample-user:repositories", repositories: parsed.rows.map(({ id: _id, ...rest }) => rest) }).ok, true);
});

test("r4 a starred row with chrome, forks and a license line is complete and parsed", () => {
	const parsed = parseStarredPage(`<ul id="user-starred-repos">${starredRow()}</ul>`);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	assert.equal(parsed.rows[0]?.stars, 3);
	assert.equal(parsed.rows[0]?.forks, 1);
	assert.equal(parsed.rows[0]?.license, "Apache-2.0 license");
	assert.equal(validateRecord("starred", { id: "sample-user:starred", starred: parsed.rows.map(({ id: _id, ...rest }) => rest) }).ok, true);
});

test("r5 an empty state with unaccounted toolbar text cannot prove completion", () => {
	const parsed = parseStarredPage(emptyStarred);
	assert.equal(parsed.rawRows, 0);
	assert.ok(parsed.rejectedRows > 0);
	assert.equal(parsed.complete, false);
	const url = "https://github.com/sample-user?page=1&tab=stars";
	assert.deepEqual(
		inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + emptyStarred }, "starred", "sample-user", 1, 0, 0),
		{ valid: false, nextUrl: null, reason: "unreadable_fields" },
	);
});

test("r4 an empty blankslate list needs no particular wording", () => {
	const html = '<main><div id="user-starred-repos"><div><div class="blankslate"><h3>Nothing here</h3></div></div></div></main>';
	const url = "https://github.com/sample-user?page=1&tab=stars";
	assert.equal(inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + html }, "starred", "sample-user", 1, 0, 0).valid, true);
});

test("r4 a busy list withholds an otherwise proven empty state", () => {
	const html = emptyStarred.replace('id="user-starred-repos"', 'id="user-starred-repos" aria-busy="true"');
	const url = "https://github.com/sample-user?page=1&tab=stars";
	assert.equal(parseStarredPage(html).complete, false);
	assert.equal(inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + html }, "starred", "sample-user", 1, 0, 0).valid, false);
});

test("r4 profile sections in plain divs are read by heading and link, and absent followers are omitted", () => {
	const parsed = parseProfilePage(profile(), profileUrl);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.complete, true);
	assert.equal(parsed.row?.organizations?.[0]?.login, "sample-org");
	assert.equal(parsed.row?.organizations?.length, 1);
	assert.deepEqual(parsed.row?.achievements, [{ name: "Sample Badge", iconUrl: "https://github.githubassets.com/assets/sample-badge.png" }]);
	assert.equal(parsed.row?.pinnedRepositories?.[0]?.stars, 5);
	assert.equal(parsed.row?.pinnedRepositories?.[0]?.forks, 2);
	assert.equal(parsed.row?.pinnedRepositories?.[0]?.forkedFrom, "sample-owner/upstream");
	for (const key of ["followers", "following"]) assert.equal(key in (parsed.row ?? {}), false, key);
	assert.equal(validateRecord("profile", { id: "sample-user:profile", ...parsed.row }).ok, true);
});

test("r4 sections missing from a recognisable profile page are omitted fields", () => {
	const parsed = parseProfilePage(profile({ sidebar: "", pinned: "" }), profileUrl);
	assert.equal(parsed.complete, true);
	assert.equal("organizations" in (parsed.row ?? {}), false);
	assert.equal("achievements" in (parsed.row ?? {}), false);
	assert.equal("pinnedRepositories" in (parsed.row ?? {}), false);
});

test("r4 a heading with no entries is a readable empty section", () => {
	const parsed = parseProfilePage(profile({ sidebar: '<div><h2 class="h4">Organizations</h2></div><div><h2 class="h4"><a href="/sample-user?tab=achievements">Achievements</a></h2></div>' }), profileUrl);
	assert.equal(parsed.complete, true);
	assert.deepEqual(parsed.row?.organizations, []);
	assert.deepEqual(parsed.row?.achievements, []);
});

test("r4 followers and following are read from links wherever they sit", () => {
	const links = '<div><a href="/sample-user?tab=followers"><span class="text-bold">42</span> followers</a> · <a href="/sample-user?tab=following"><span class="text-bold">7</span> following</a></div>';
	const parsed = parseProfilePage(profile({ followers: links }), profileUrl);
	assert.equal(parsed.complete, true);
	assert.equal(parsed.row?.followers, 42);
	assert.equal(parsed.row?.following, 7);
	const slashed = parseProfilePage(profile({ followers: '<a href="/sample-user/followers"><b>3</b> followers</a>' }), profileUrl);
	assert.equal(slashed.row?.followers, 3);
});

// ---- drift negatives still veto -------------------------------------------

test("r4 an unknown element with visible text inside a row vetoes completion", () => {
	for (const extra of ['<div class="Box-badge">Sponsored</div>', '<span class="NewThing">3 watchers</span>']) {
		const parsed = parseRepositoriesPage(repositories(repositoryRow({ extra })));
		assert.equal(parsed.rows.length, 1, "readable row data survives");
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.some((field) => field.endsWith("rowLayout")));
	}
	const starred = parseStarredPage(`<ul id="user-starred-repos">${starredRow('<span class="NewThing">3 watchers</span>')}</ul>`);
	assert.equal(starred.complete, false);
	const pinned = parseProfilePage(profile({ pinned: pinnedSection.replace("</p></div></div></li>", '</p><div class="Extra">Sponsor me</div></div></div></li>') }), profileUrl);
	assert.equal(pinned.complete, false);
	assert.equal(pinned.row?.pinnedRepositories?.length, 1);
});

test("r4 a control whose text carries a number is unknown data, a plain star button is not", () => {
	assert.equal(parseRepositoriesPage(repositories(repositoryRow({ extra: '<button type="button">Watch 12</button>' }))).complete, false);
	assert.equal(parseRepositoriesPage(repositories(repositoryRow({ extra: '<button type="button">Sponsor</button>' }))).complete, true);
});

test("r4 a renamed section keeps its data but cannot certify completeness", () => {
	for (const sidebar of [
		`${achievementsBlock()}${organizationsBlock("Groups")}`,
		`${achievementsBlock("Honors")}${organizationsBlock()}`,
	]) {
		const parsed = parseProfilePage(profile({ sidebar }), profileUrl);
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.some((field) => field === "organizations" || field === "achievements"));
	}
});

test("r4 absent sections prove omission only when the profile structure is present", () => {
	const withoutStructure = parseProfilePage(profile({ nav: "", sidebar: "", pinned: "" }), profileUrl);
	assert.equal(withoutStructure.complete, false);
	for (const key of ["organizations", "achievements", "pinnedRepositories"]) assert.ok(withoutStructure.unreadableFields.includes(key), key);
});

test("r4 a followers link whose count is unreadable vetoes, and absent links without profile structure veto", () => {
	for (const followers of [
		'<a href="/sample-user?tab=followers">followers</a>',
		'<a href="/sample-user?tab=followers"><span>lots</span> followers</a>',
		'<a href="/sample-user?tab=followers"><span>Loading</span></a>',
	]) {
		const parsed = parseProfilePage(profile({ followers }), profileUrl);
		assert.equal(parsed.complete, false, followers);
		assert.ok(parsed.unreadableFields.includes("followers"));
	}
	const noNav = parseProfilePage(profile({ nav: "" }), profileUrl);
	assert.equal(noNav.complete, false);
	assert.ok(noNav.unreadableFields.includes("followers"));
	const noAvatar = parseProfilePage(profile({ head: '<span class="p-nickname">sample-user</span>' }), profileUrl);
	assert.equal(noAvatar.complete, false);
});

test("r4 a busy or placeholder marker in a section vetoes it", () => {
	for (const sidebar of [
		`${achievementsBlock()}${organizationsBlock().replace("</div>", '<div class="skeleton"></div></div>')}`,
		`${achievementsBlock().replace('<div class="d-flex flex-wrap">', '<div class="d-flex flex-wrap" aria-busy="true">')}${organizationsBlock()}`,
	]) {
		assert.equal(parseProfilePage(profile({ sidebar }), profileUrl).complete, false);
	}
});

test("r4 a blankslate beside a row is a contradiction", () => {
	const html = `<ul id="user-starred-repos">${starredRow()}<div class="blankslate"><h3>You don’t have any starred repositories yet.</h3></div></ul>`;
	const parsed = parseStarredPage(html);
	assert.equal(parsed.rows.length, 1);
	assert.equal(parsed.complete, false);
	const repos = parseRepositoriesPage(`<div id="user-repositories-list"><div class="wrap"><div class="blankslate">Nothing</div></div><ul>${repositoryRow()}</ul></div>`);
	assert.equal(repos.complete, false);
	const url = "https://github.com/sample-user?page=1&tab=stars";
	const verdict = inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + html + terminal }, "starred", "sample-user", 1, 1, 0);
	assert.equal(verdict.valid, false);
});

// ---- collector level ------------------------------------------------------

async function collect(stream: string, html: string, overrides: Partial<BrowserServices> = {}) {
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string; stream?: string; reason?: string }> = [];
	const state: Record<string, unknown> = {};
	await collectGitHubBrowser({
		emit: async (message) => { messages.push(message); },
		emitRecord: async (selected, data) => { records.push({ stream: selected, data }); },
		progress: async () => {},
		requested: new Set([stream]),
		state,
	}, {
		openPage: async (url) => page(url, url === "https://github.com/" ? owner : owner + html),
		openContributionPage: async (url) => page(url, owner + html),
		fetchPublicJson: async (url) => ({ requestedUrl: url, responseUrl: url, status: 200, data: [] }),
		now: () => new Date("2026-01-01T00:00:00Z"),
		sleep: async () => {},
		...overrides,
	});
	return { records, messages, state };
}
const completed = (result: Awaited<ReturnType<typeof collect>>, stream: string): boolean =>
	result.messages.some((message) => message.type === "STATE" && message.stream === stream) &&
	!result.messages.some((message) => message.type === "SKIP_RESULT");

test("r5 readable profiles and repositories complete; unaccounted starred chrome vetoes", async () => {
	const repos = await collect("repositories", repositories(repositoryRow({ fork: true, license: true })) + terminal);
	assert.equal(completed(repos, "repositories"), true);
	assert.equal((repos.records[0]?.data.repositories as Array<Record<string, unknown>>)[0]?.license, "MIT License");
	assert.equal(completed(await collect("starred", emptyStarred), "starred"), false);
	assert.equal(completed(await collect("profile", profile()), "profile"), true);
});

test("r4 an unfollowed Load more still vetoes a live-shaped repository page", async () => {
	const result = await collect("repositories", repositories(repositoryRow()) + '<button type="button">Load more</button>');
	assert.equal(completed(result, "repositories"), false);
	assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
});

test("r4 a blankslate beside a row vetoes the stream", async () => {
	const html = `<ul id="user-starred-repos">${starredRow()}<div class="blankslate"><h3>Nothing</h3></div></ul>` + terminal;
	assert.equal(completed(await collect("starred", html), "starred"), false);
});

test("r5 unaccounted list chrome and feature prompts veto while retaining rows", () => {
	const chrome = '<div class="toolbar"><h2>Repositories</h2><span class="sr-only">8 results</span></div><div class="paginate-container"><a rel="next" href="/sample-user?page=2&tab=repositories">Next</a></div>';
	const parsed = parseRepositoriesPage(`<div id="user-repositories-list">${chrome}<ul>${repositoryRow()}</ul>${listPromo}</div>`);
	assert.equal(parsed.rawRows, 1);
	assert.ok(parsed.rejectedRows > 0);
	assert.equal(parsed.complete, false);
	const starred = parseStarredPage(`<turbo-frame id="user-starred-repos">${listPromo}<ul>${starredRow()}</ul></turbo-frame>`);
	assert.equal(starred.rawRows, 1);
	assert.equal(starred.complete, false);
});

test("r4 repository links outside any list entry are discarded rows, not an empty list", () => {
	const html = `<turbo-frame id="user-starred-repos"><div class="blankslate"><h3>Nothing</h3></div><div class="Box-row"><h3><a href="/sample-owner/demo">sample-owner / demo</a></h3></div></turbo-frame>`;
	const parsed = parseStarredPage(html);
	assert.equal(parsed.rawRows, 0);
	assert.equal(parsed.rejectedRows, 1);
	assert.equal(parsed.complete, false);
});

test("r4 a deferred fragment in the site header is not a continuation, one in the page body is", async () => {
	const header = '<div class="header-wrapper js-header-wrapper"><include-fragment class="is-error"><div class="blankslate"><h3>Oh no!</h3></div></include-fragment></div>';
	const url = "https://github.com/sample-user?page=1&tab=stars";
	const cleanEmpty = '<main><div id="user-starred-repos"><div class="blankslate">Nothing</div></div></main>';
	const verdict = (html: string) => inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + html }, "starred", "sample-user", 1, 0, 0);
	assert.equal(verdict(header + cleanEmpty).valid, true);
	assert.equal(verdict(cleanEmpty + '<include-fragment src="/sample-user?tab=stars&page=2"></include-fragment>').valid, false);
	assert.equal(completed(await collect("starred", header + cleanEmpty), "starred"), true);
});

test("r5 numeric controls cannot hide in a second or consumed starred paragraph", () => {
 for (const html of [
  starredRow("<p><button>Watch 12</button></p>"),
  starredRow().replace("Synthetic starred repository", "<button>Watch 12</button>"),
  starredRow("<p>Unparsed information</p>"),
  starredRow("<p><button>3</button></p>").replace('<a href="/sample-owner/demo/stargazers"><svg class="octicon"></svg>3</a>', ""),
 ]) {
  const parsed = parseStarredPage(`<ul id="user-starred-repos">${html}</ul>`);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.complete, false);
 }
});

for (const extra of ['<div class="Box-row">Fetching another repository</div>', '<a href="/sample-owner/deferred">deferred</a>', 'Loose row text', '<div class="Box-row"><a href="/sample-owner/deferred"></a></div>']) {
 test(`r5 unaccounted wrapper content vetoes inventory: ${extra}`, () => {
  assert.equal(parseRepositoriesPage(repositories(repositoryRow()).replace("</ul>", `</ul>${extra}`)).complete, false);
  assert.equal(parseStarredPage(`<div id="user-starred-repos"><ul>${starredRow()}</ul>${extra}</div>`).complete, false);
  assert.equal(parseProfilePage(profile({ pinned: `<div><h2>Popular repositories</h2><div>${extra}</div></div>` }), profileUrl).complete, false);
 });
}

test("r5 main and inventory footer continuation cannot be site chrome", () => {
 const url = "https://github.com/sample-user?page=1&tab=repositories";
 const next = '<a rel="next" href="/sample-user?page=2&tab=repositories">Next</a>';
 for (const attrs of ["", 'role="contentinfo"', 'role="banner"']) {
  const html = `<main>${repositories(repositoryRow()).replace("</ul>", `</ul><footer ${attrs}>${next}</footer>`)}${terminal}</main>`;
  const result = inspectInventoryPage(page(url, owner + html), "repositories", "sample-user", 1, 1, 0);
  assert.ok(!result.valid || result.nextUrl !== null);
 }
 const chromeOnly = owner + repositories(repositoryRow()) + `<footer role="contentinfo">${terminal}</footer>`;
 assert.equal(inspectInventoryPage(page(url, chromeOnly), "repositories", "sample-user", 1, 1, 0).valid, false);
});

for (const kind of ["followers", "following"]) {
 test(`r5 every duplicate ${kind} count must be readable`, () => {
  for (const bad of ["lots", ""]) {
   const followers = `<a href="/sample-user?tab=${kind}">42 ${kind}</a><a href="/sample-user?tab=${kind}"><span>${bad}</span> ${kind}</a>`;
   const parsed = parseProfilePage(profile({ followers }), profileUrl);
   assert.equal(parsed.complete, false);
   assert.ok(parsed.unreadableFields.includes(kind));
  }
 });
}

test("r5 renamed organization and pinned sections cannot omit surviving entries", () => {
 assert.equal(parseProfilePage(profile({ sidebar: '<div><h2>Groups</h2><a href="/orgs/sample-org"><img></a></div>' }), profileUrl).complete, false);
 assert.equal(parseProfilePage(profile({ pinned: '<div><h2>Selected work</h2><div><a href="/sample-owner/demo"></a></div></div>' }), profileUrl).complete, false);
});

test("r5 a text-free direct pinned section entry cannot disappear", () => {
 const parsed = parseProfilePage(profile({ pinned: '<div><h2>Popular repositories</h2><a href="/sample-owner/deferred"></a></div>' }), profileUrl);
 assert.equal(parsed.complete, false);
});
test("r5 a page-main footer outside the inventory follows its next link", () => {
 const url = "https://github.com/sample-user?page=1&tab=repositories";
 const html = owner + `<main>${repositories(repositoryRow())}<footer role="contentinfo"><a rel="next" href="/sample-user?page=2&tab=repositories">Next</a></footer>${terminal}</main>`;
 const result = inspectInventoryPage(page(url, html), "repositories", "sample-user", 1, 1, 0);
 assert.equal(result.valid, true);
 assert.equal(result.nextUrl, "https://github.com/sample-user?page=2&tab=repositories");
});
for (const [stream, html] of [
 ["starred", `<ul id="user-starred-repos">${starredRow("<p><button>Watch 12</button></p>")}</ul>`],
 ["repositories", repositories(repositoryRow()).replace("</ul>", '</ul><div>Fetching another repository</div>')],
 ["profile", profile({ followers: '<a href="/sample-user?tab=followers">42 followers</a><a href="/sample-user?tab=followers">lots followers</a>' })],
] as const) {
 test(`r5 ${stream} retains readable records without completion authority`, async () => {
  const result = await collect(stream, html + terminal);
  assert.ok(result.records.length > 0);
  assert.equal(result.messages.some((message) => message.type === "STATE" || message.type === "DETAIL_COVERAGE"), false);
  assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
 });
}
