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

