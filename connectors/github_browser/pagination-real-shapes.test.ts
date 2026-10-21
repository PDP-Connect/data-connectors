// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { parseRepositoriesPage } from "./parsers.ts";

// Structure of a signed-out Repositories tab row as GitHub served it on 2026-10-21, with
// names and text replaced and icon paths removed. Every row carries a lazy sparkline
// fragment whose hidden error template has its own h3.
const rowTemplate = await readFile(new URL("./__fixtures__/synthetic/repository-row-current-github.html", import.meta.url), "utf8");
const row = (name: string, inject = "") => rowTemplate.replaceAll("REPO", name).replace("</poll-include-fragment>", `${inject}</poll-include-fragment>`);
const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const counter = (total: number) => `<nav aria-label="User profile"><a data-tab-item="repositories" href="/sample-user?tab=repositories">Repositories <span class="Counter">${total}</span></a></nav>`;
const target = (page: number) => `/sample-user?page=${page}&amp;tab=repositories`;
const list = (names: string[], pager: string) => `<div id="user-repositories-list"><ul>${names.map(name => row(name)).join("")}</ul><div class="paginate-container"><div role="navigation" aria-label="Pagination" class="d-flex d-md-inline-block pagination">${pager}</div></div></div>`;

// The Previous/Next pager GitHub serves today.
const previous = (page: number) => page === 1
	? '<span class="previous_page disabled" role="link" aria-label="Previous page" aria-disabled="true">Previous</span>'
	: `<a class="previous_page" aria-label="Previous page" rel="prev" href="${target(page - 1)}">Previous</a>`;
const next = (page: number, last: number) => page === last
	? '<span class="next_page disabled" role="link" aria-label="Next page" aria-disabled="true">Next</span>'
	: `<a class="next_page" aria-label="Next page" rel="next" href="${target(page + 1)}">Next</a>`;
const currentPager = (page: number, last: number) => `${previous(page)} ${next(page, last)}`;
// The numbered pager GitHub has also served: page links between Previous and Next,
// with rel=prev/next on the adjacent numbers.
const numberedPager = (page: number, last: number, numbers = Array.from({ length: last }, (_, i) => i + 1)) => `${previous(page)} ${numbers.map(n =>
	n === page ? `<em class="current" aria-current="page">${n}</em>` : `<a${n === page + 1 ? ' rel="next"' : n === page - 1 ? ' rel="prev"' : ""} aria-label="Page ${n}" href="${target(n)}">${n}</a>`).join(" ")} ${next(page, last)}`;

const pages = [["alpha", "beta"], ["gamma", "delta"], ["epsilon"]];
async function walk(html: (page: number) => string) {
	const records: Array<Record<string, unknown>> = [];
	const messages: Array<{ type: string; diagnostics?: unknown }> = [];
	const requests: number[] = [];
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set(["repositories"]), state: {},
	}, {
		openPage: async url => {
			if (url === "https://github.com/") return { requestedUrl: url, currentUrl: url, html: owner };
			const page = Number(new URL(url).searchParams.get("page"));
			requests.push(page);
			return { requestedUrl: url, currentUrl: url, html: owner + html(page) };
		},
		fetchPublicJson: async () => { throw new Error("repositories need no REST request"); },
		now: () => new Date("2026-10-21T04:00:00Z"), sleep: async () => {},
	});
	const diagnostics = messages.find(m => m.type === "SKIP_RESULT")?.diagnostics as { cause?: string } | undefined;
	return { records, messages, requests, cause: diagnostics?.cause };
}

test("a current GitHub repository row with its hidden sparkline error template is one entry", () => {
	const parsed = parseRepositoriesPage(list(["alpha"], currentPager(1, 1)));
	assert.equal(parsed.rejectedRows, 0);
	assert.equal(parsed.entriesComplete, true);
	assert.deepEqual(parsed.rows.map(r => r.id), ["https://github.com/sample-user/alpha"]);
});

// In a live browser the lazy fragment shows its error template when the sparkline
// fails to load, so the template's heading is not row content in any state.
for (const [label, edit] of [
	["shown after a failed load", (html: string) => html.replace('data-show-on-forbidden-error="" hidden', 'data-show-on-forbidden-error=""')],
	["hidden by class", (html: string) => html.replace('data-show-on-forbidden-error="" hidden', 'class="d-none"')],
] as const) {
	test(`a repository row keeps its entry when the sparkline fragment's template is ${label}`, () => {
		const parsed = parseRepositoriesPage(edit(list(["alpha"], currentPager(1, 1))));
		assert.equal(parsed.rejectedRows, 0);
		assert.equal(parsed.entriesComplete, true);
	});
}

for (const [label, inject] of [
	["a repository heading link", '<h3><a href="/sample-user/fragment-entry">fragment-entry</a></h3>'],
	["a nested list item", '<ul><li>fragment-entry</li></ul>'],
] as const) {
	test(`a lazy fragment holding ${label} still rejects the row`, () => {
		const parsed = parseRepositoriesPage(`<div id="user-repositories-list"><ul>${row("alpha", inject)}</ul></div>`);
		assert.equal(parsed.rejectedRows, 1);
	});
}

test("next controls that name the same page with reordered parameters are one continuation", async () => {
	const result = await walk(page => list(pages[page - 1] ?? [], page === 1
		? numberedPager(1, 3).replace(`rel="next" aria-label="Page 2" href="${target(2)}"`, 'rel="next" aria-label="Page 2" href="/sample-user?tab=repositories&amp;page=2"')
		: numberedPager(page, 3)));
	assert.deepEqual(result.requests, [1, 2, 3]);
	assert.equal(result.records.length, 1);
});

test("a repository link inside hidden row content is still a second entry", () => {
	const html = `<div id="user-repositories-list"><ul>${row("alpha", '<div hidden><a href="/sample-user/hidden-entry">hidden</a></div>')}</ul></div>`;
	const parsed = parseRepositoriesPage(html);
	assert.equal(parsed.rejectedRows, 1);
	assert.equal(parsed.entriesComplete, false);
});

for (const withCounter of [true, false]) {
	for (const [label, pager] of [["Previous/Next", currentPager], ["numbered", numberedPager]] as const) {
		test(`a real-shape three-page repositories walk with the ${label} pager publishes${withCounter ? " with its counter" : ""}`, async () => {
			const result = await walk(page => (withCounter ? counter(5) : "") + list(pages[page - 1] ?? [], pager(page, 3)));
			assert.deepEqual(result.requests, [1, 2, 3]);
			assert.equal(result.records.length, 1);
			assert.equal((result.records[0]?.repositories as unknown[] | undefined)?.length, 5);
			assert.deepEqual(result.messages.map(m => m.type), ["STATE", "DETAIL_COVERAGE"]);
		});
	}
}

test("a numbered next-page link that contradicts Next withholds the walk", async () => {
	const result = await walk(page => list(pages[page - 1] ?? [], page === 1
		? numberedPager(1, 3).replace(`rel="next" aria-label="Page 2" href="${target(2)}"`, `rel="next" aria-label="Page 2" href="${target(3)}"`)
		: numberedPager(page, 3)));
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.requests, [1]);
});

test("a walk that ends before a page some page linked to is withheld", async () => {
	// Page 1 links to a fourth page, but page 3 claims to be the last.
	const result = await walk(page => list(pages[page - 1] ?? [], page === 1 ? numberedPager(1, 3, [1, 2, 3, 4]) : numberedPager(page, 3)));
	assert.deepEqual(result.records, []);
	assert.equal(result.cause, "end_before_linked_page");
});

test("numbered forward links without an enabled Next still withhold the walk", async () => {
	const result = await walk(() => list(pages[0] ?? [], numberedPager(1, 1, [1, 2])));
	assert.deepEqual(result.records, []);
	assert.equal(result.cause, "unknown_continuation");
});
