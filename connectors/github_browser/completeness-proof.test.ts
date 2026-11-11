// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";
import { type Continuation, InventoryEvidence } from "./inventory-evidence.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectInventoryPage, parseProfilePage } from "./parsers.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const terminal = '<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
const prior = { fetched_at: "2025-12-01T00:00:00Z" };

async function collect(stream: string, htmlFor: (url: string) => string, api?: (url: string) => { link: string | null | undefined; data: unknown }) {
	const records: object[] = [];
	const apiRequests: string[] = [];
	const messages: Array<{ type: string; reason?: string; diagnostics?: unknown }> = [];
	const state: Record<string, unknown> = { [stream]: structuredClone(prior) };
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set([stream]), state,
	}, {
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html: htmlFor(url) }),
		fetchPublicJson: async url => {
			apiRequests.push(url);
			return { requestedUrl: url, responseUrl: url, status: api === undefined ? 500 : 200, data: null, ...api?.(url) };
		},
		now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
	});
	return { records, messages, state, apiRequests };
}

for (const stream of ["repositories", "starred"] as const) {
	const tab = stream === "repositories" ? "repositories" : "stars";
	const list = (names: string[], changed = false) => `<ul id="${stream === "repositories" ? "user-repositories-list" : "user-starred-repos"}">${names.map(name => `<li><h3><a href="/sample-user/${name}">${name}</a></h3><p${stream === "repositories" ? ' itemprop="description"' : ""}>${changed ? "Changed" : "Original"}</p></li>`).join("")}</ul>`;
	const next = (page: number) => `<div class="pagination"><a class="next_page" rel="next" href="/sample-user?page=${page}&tab=${tab}">Next</a></div>`;
	for (const scenario of ["missing", "absent", "renamed", "numbered", "disabled-with-forward", "short"] as const) {
		test(`${stream} withholds inventory after ${scenario} Next control without a total`, async () => {
			const result = await collect(stream, url => {
				if (url.endsWith("github.com/")) return owner;
				const first = new URL(url).searchParams.get("page") === "1";
				const forward = `<a class="continue_page" href="/sample-user?page=2&tab=${tab}">${scenario === "numbered" ? "2" : "Continue"}</a>`;
				let pagination = '<div class="pagination"></div>';
				if (scenario === "absent") pagination = "";
				if (scenario === "disabled-with-forward") pagination = terminal.replace("</div>", forward + "</div>");
				if (scenario === "renamed" || scenario === "numbered") pagination = `<div class="pagination">${forward}</div>`;
				return owner + list(scenario === "short" && first ? ["a", "b"] : [first ? "a" : "c"]) +
					(scenario === "short" && first ? next(2) : pagination);
			});
			assert.deepEqual(result.records, []);
			const failedRead = stream === "starred" && ["missing", "absent", "short"].includes(scenario);
			assert.deepEqual(result.apiRequests, failedRead ? ["https://api.github.com/users/sample-user/starred?per_page=100&page=1"] : []);
			assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", failedRead ? "stream_collection_failed" : "inventory_not_proven_complete"]]);
			assert.deepEqual(result.state, { [stream]: prior });
		});
	}
	for (const scenario of ["overlap", "contradiction", "repeated", "empty", "earlier-overlap", "exact-total-overlap"] as const) {
		test(`${stream} preserves prior snapshot after ${scenario} with explicit terminal pagination`, async () => {
			const result = await collect(stream, url => {
				if (url.endsWith("github.com/")) return owner;
				const page = Number(new URL(url).searchParams.get("page"));
				const counter = scenario === "exact-total-overlap" ? `<nav><a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">3</span></a></nav>` : "";
				const names = page === 1 ? ["a", "b"] : page === 3 ? ["d"] : scenario === "empty" ? [] : scenario === "repeated" ? ["a", "b"] : ["b", "c"];
				return owner + counter + list(names, scenario === "contradiction" && page === 2) +
					(page === 1 ? next(2) : scenario === "earlier-overlap" && page === 2 ? next(3) : terminal);
			});
			assert.deepEqual(result.records, []);
			assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "inventory_not_proven_complete"]]);
			assert.deepEqual(result.state, { [stream]: prior });
		});
	}
	for (const empty of [false, true]) {
		test(`${stream} publishes a ${empty ? "legitimately empty" : "disjoint multi-page"} terminal inventory`, async () => {
			const result = await collect(stream, url => {
				if (url.endsWith("github.com/")) return owner;
				const first = new URL(url).searchParams.get("page") === "1";
				return owner + list(empty ? [] : first ? ["a", "b"] : ["c", "d"]) + (empty || !first ? terminal : next(2));
			});
			assert.equal(result.records.length, 1);
			assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
		});
	}
	test(`${stream} page proof rejects no progress before next or terminal evidence`, () => {
		for (const pagination of [next(3), terminal]) {
			const url = `https://github.com/sample-user?page=2&tab=${tab}`;
			const result = inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + list(["a"]) + pagination }, stream, "sample-user", 2, 1, 0, true);
			assert.equal(result.complete, false);
			assert.equal(result.nextUrl, null);
			assert.equal(result.reason, "no_progress");
		}
	});
}

for (const section of ["organizations", "achievements"] as const) {
	test(`headingless real ${section} remain uncertified beside unrelated README links`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-with-readme-links.html", import.meta.url), "utf8"));
		for (const node of Array.from(document.querySelectorAll(".h-card h2"))) {
			if (node.textContent?.toLowerCase() === section) node.remove();
		}
		const article = document.querySelector("article");
		assert.ok(article);
		article.innerHTML += '<a href="/orgs/readme-only">README org</a><a href="/sample-user?achievement=readme-only&tab=achievements">README badge</a>';
		const html = document.toString();
		const parsed = parseProfilePage(html, "https://github.com/sample-user");
		assert.equal(parsed.complete, false);
		assert.equal(parsed.row?.[section]?.length, 1);
		const result = await collect("profile", () => html);
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "stream_collection_failed"]]);
		assert.deepEqual(result.state, { profile: prior });
	});
}

for (const section of ["organizations", "achievements"] as const) {
	for (const prose of ["README", "bio"] as const) {
		test(`absent ${section} stay absent when ${prose} links mention them`, async () => {
			const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-with-readme-links.html", import.meta.url), "utf8"));
			if (section === "organizations") {
				for (const node of Array.from(document.querySelectorAll('.h-card h2, .h-card [itemprop="follows"]'))) {
					if (node.matches('[itemprop="follows"]') || node.textContent === "Organizations") node.remove();
				}
			} else {
				for (const node of Array.from(document.querySelectorAll('.h-card a[href*="achievement"]'))) node.remove();
			}
			const target = document.querySelector(prose === "README" ? "article" : ".p-note");
			assert.ok(target);
			target.innerHTML += section === "organizations" ? '<a href="/orgs/example">Example organization</a>' : '<a href="/sample-user?achievement=example&tab=achievements">Example badge</a>';
			const html = document.toString();
			const parsed = parseProfilePage(html, "https://github.com/sample-user");
			assert.equal(parsed.complete, true);
			assert.equal(parsed.rejectedEntries, 0);
			assert.deepEqual(parsed.unreadableFields, []);
			assert.equal(parsed.row?.[section], undefined);
			const result = await collect("profile", () => html);
			assert.equal(result.records.length, 1);
			assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
		});
	}
}

for (const section of ["organizations", "achievements", "pinnedRepositories"] as const) {
	test(`surviving ${section} heading cannot certify entries hidden behind a nested heading`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-pinned-listitem-current-github.html", import.meta.url), "utf8"));
		const selector = section === "organizations" ? '.avatar-group-item' : section === "achievements" ? 'a[href*="achievement="]' : '.js-pinned-items-reorder-container';
		for (const entry of Array.from(document.querySelectorAll(selector))) {
			const wrapper = document.createElement("div");
			wrapper.innerHTML = '<h3>Memberships</h3>';
			entry.replaceWith(wrapper);
			wrapper.append(entry);
		}
		const html = document.toString();
		const parsed = parseProfilePage(html, "https://github.com/sample-user");
		assert.equal(parsed.complete, false);
		const result = await collect("profile", () => html);
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "stream_collection_failed"]]);
		assert.deepEqual(result.state, { profile: prior });
	});
}

test("history manifest publishes the same bounded-window contract as collection", async () => {
	const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
	const description = manifest.streams.find((stream: { name: string }) => stream.name === "history").description;
	assert.match(description, /min\(stable total_count, 1000\)/u);
	assert.match(description, /withheld/iu);
	assert.doesNotMatch(description, /without completion/iu);
});

for (const section of ["organizations", "achievements", "pinnedRepositories"] as const) {
	test(`a rendered profile with truly empty ${section} still publishes`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-pinned-listitem-current-github.html", import.meta.url), "utf8"));
		const selector = section === "organizations" ? '.avatar-group-item' : section === "achievements" ? 'a[href*="achievement="]' : '.js-pinned-items-reorder-container';
		for (const node of Array.from(document.querySelectorAll(selector))) node.remove();
		const title = section === "pinnedRepositories" ? "Popular repositories" : section;
		for (const heading of Array.from(document.querySelectorAll("h2"))) {
			if (heading.textContent?.trim().toLowerCase() === title.toLowerCase()) heading.remove();
		}
		const html = document.toString();
		assert.equal(parseProfilePage(html, "https://github.com/sample-user").collectionsComplete, true);
		const result = await collect("profile", () => html);
		assert.equal(result.records.length, 1);
		assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
	});
}

for (const region of ["company", "activity"] as const) {
	test(`organization mentions in ${region} are separate from membership entries`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-pinned-listitem-current-github.html", import.meta.url), "utf8"));
		const mention = '<a class="user-mention" data-hovercard-type="organization" href="https://github.com/sample-company">@sample-company</a>';
		if (region === "company") document.querySelector(".vcard-details")!.innerHTML = `<li itemprop="worksFor">${mention}</li>`;
		else document.querySelector("main")!.innerHTML += `<div id="js-contribution-activity"><div class="contribution-activity-listing">Joined ${mention}</div></div>`;
		const html = document.toString();
		assert.equal(parseProfilePage(html, "https://github.com/sample-user").collectionsComplete, true);
		const result = await collect("profile", () => html);
		assert.equal(result.records.length, 1);
	});
}

for (const section of ["organizations", "achievements", "pinnedRepositories"] as const) {
	test(`a ${section} heading without a located region stays ambiguous`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-pinned-listitem-current-github.html", import.meta.url), "utf8"));
		const selector = section === "organizations" ? '.avatar-group-item' : section === "achievements" ? 'a[href*="achievement="]' : '.js-pinned-items-reorder-container';
		for (const node of Array.from(document.querySelectorAll(selector))) node.remove();
		const result = await collect("profile", () => document.toString());
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.state, { profile: prior });
	});
}

test("profile withholding retains the collection and evidence failure", async () => {
	const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-pinned-listitem-current-github.html", import.meta.url), "utf8"));
	const entry = document.querySelector('.avatar-group-item')!;
	const wrapper = document.createElement("div");
	wrapper.innerHTML = '<h3>Memberships</h3>';
	entry.replaceWith(wrapper);
	wrapper.append(entry);
	const result = await collect("profile", () => document.toString());
	const diagnostics = (result.messages[0] as { diagnostics?: { collection?: string; cause?: string } }).diagnostics;
	assert.equal(diagnostics?.collection, "organizations");
	assert.equal(diagnostics?.cause, "unclaimed_candidates");
});

test("InventoryEvidence ends a walk only on the last page's own positive end evidence", () => {
	const url = "https://github.com/sample-user?page=1&tab=repositories";
	const evidence = new InventoryEvidence(url);
	evidence.observePage({ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "unproven" } });
	assert.equal(evidence.decide(1), "terminal_unverified");
	// A walk that has ended accepts no later page, so no page can supply its proof.
	evidence.observePage({ ids: [], rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
	assert.equal(evidence.decide(1), "observation_after_end");
	const ended = new InventoryEvidence(url);
	ended.observePage({ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
	assert.equal(ended.decide(1), null);
});

for (const link of ["unreadable", '<https://api.github.com/users/sample-user/events/public?page=2>; rel="continue"']) {
	test(`events withholds state and coverage for unknown Link: ${link}`, async () => {
		const event = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/events.json", import.meta.url), "utf8"))[0];
		let calls = 0;
		const result = await collect("events", () => owner, url => {
			calls += 1;
			const page = new URL(url).searchParams.get("page");
			return { link, data: Array.from({ length: 100 }, (_, i) => ({ ...event, id: `${page}-${i}` })) };
		});
		// Unknown metadata ends the walk; it may not consume further pages.
		assert.equal(calls, 1);
		const diagnostics = result.messages[0]?.diagnostics;
		assert.ok(typeof diagnostics === "object" && diagnostics !== null && "cause" in diagnostics);
		assert.equal(diagnostics.cause, "unreadable_pagination");
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.state, { events: prior });
		assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
	});
}

test("events withholds an empty later page with unobserved pagination", async () => {
	const event = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/events.json", import.meta.url), "utf8"))[0];
	const result = await collect("events", () => owner, url => new URL(url).searchParams.get("page") === "1"
		? { link: '<https://api.github.com/users/sample-user/events/public?page=2>; rel="next"', data: [event] }
		: { link: undefined, data: [] });
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.state, { events: prior });
	assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
});

// Real starred cards show owner/repo as the link text (see starred-card-with-auxiliary-links.html).
const starredCard = (i: number) => `<li><h3><a href="/sample-user/repo${i}">sample-user/repo${i}</a></h3></li>`;
const starredPage = (ids: number[], controls: string) => owner +
	`<ul id="user-starred-repos">${ids.map(starredCard).join("")}</ul>` +
	`<div class="paginate-container"><div class="BtnGroup" data-test-selector="pagination">${controls}</div></div>`;
const cursorNext = (href: string) => `<a rel="nofollow" class="btn BtnGroup-item" href="${href}">Next</a>`;
const cursorPrev = (href: string) => `<a rel="nofollow" class="btn BtnGroup-item" href="${href}">Previous</a>`;
const disabledControl = (label: string) => `<button class="btn BtnGroup-item" disabled="disabled">${label}</button>`;
const starsUrl = "https://github.com/sample-user?page=1&tab=stars";

test("starred real BtnGroup pagination with disabled Next alone cannot certify end", () => {
	const html = starredPage(Array.from({ length: 30 }, (_, i) => i), disabledControl("Previous") + disabledControl("Next"));
	const proof = inspectInventoryPage({ requestedUrl: starsUrl, currentUrl: starsUrl, html }, "starred", "sample-user", 1, 30, 0);
	assert.equal(proof.complete, false);
	assert.equal(proof.reason, "terminal_unverified");
});

test("starred cursor Next is an inspector-bound successor", () => {
	const html = starredPage(Array.from({ length: 30 }, (_, i) => i), disabledControl("Previous") + cursorNext("https://github.com/sample-user?after=Y3Vyc29y&tab=stars"));
	const proof = inspectInventoryPage({ requestedUrl: starsUrl, currentUrl: starsUrl, html }, "starred", "sample-user", 1, 30, 0);
	assert.equal(proof.complete, false);
	assert.equal(proof.reason, "remaining_continuation");
	assert.deepEqual(proof.continuation, { kind: "next", url: "https://github.com/sample-user?after=Y3Vyc29y&tab=stars", cursor: "Y3Vyc29y" });
});

for (const [name, href] of ([
	["cross-path", "https://github.com/other-user?after=Y3Vyc29y&tab=stars"],
	["cross-origin", "https://example.com/sample-user?after=Y3Vyc29y&tab=stars"],
	["other tab", "https://github.com/sample-user?after=Y3Vyc29y&tab=repositories"],
	["empty cursor", "https://github.com/sample-user?after=&tab=stars"],
	["extra parameter", "https://github.com/sample-user?after=Y3Vyc29y&tab=stars&q=x"],
] as const)) {
	test(`starred cursor Next stays unknown: ${name}`, () => {
		const html = starredPage(Array.from({ length: 30 }, (_, i) => i), cursorNext(href));
		const proof = inspectInventoryPage({ requestedUrl: starsUrl, currentUrl: starsUrl, html }, "starred", "sample-user", 1, 30, 0);
		assert.equal(proof.complete, false);
		assert.equal(proof.reason, "unknown_continuation");
		assert.equal(proof.continuation.kind, "unknown");
	});
}

test("starred marked numbered Next beside an unmarked cursor Next stays unknown", () => {
	const marked = '<a rel="next" class="next_page" href="/sample-user?page=2&tab=stars">Next</a>';
	const html = starredPage(Array.from({ length: 30 }, (_, i) => i), marked + cursorNext("https://github.com/sample-user?after=Y3Vyc29y&tab=stars"));
	const proof = inspectInventoryPage({ requestedUrl: starsUrl, currentUrl: starsUrl, html }, "starred", "sample-user", 1, 30, 0);
	assert.equal(proof.complete, false);
	assert.equal(proof.reason, "unknown_continuation");
	assert.equal(proof.continuation.kind, "unknown");
});

test("repositories cursor Next stays unknown", () => {
	const url = "https://github.com/sample-user?page=1&tab=repositories";
	const html = owner + '<ul id="user-repositories-list"><li><h3><a href="/sample-user/a">a</a></h3></li></ul>' +
		'<div class="paginate-container"><div class="BtnGroup">' + cursorNext("https://github.com/sample-user?after=Y3Vyc29y&tab=repositories") + "</div></div>";
	const proof = inspectInventoryPage({ requestedUrl: url, currentUrl: url, html }, "repositories", "sample-user", 1, 1, 0);
	assert.equal(proof.reason, "unknown_continuation");
});

const cursorUrl = (value: string) => `https://github.com/sample-user?after=${value}&tab=stars`;
const stars = (...pages: Array<{ ids: number[]; control: string }>) => {
	const requests: string[] = [];
	const pageFor = (url: string) => {
		requests.push(url);
		const index = url === starsUrl ? 0 : pages.findIndex((_, i) => url === cursorUrl(`c${i}`));
		const page = pages[index];
		return page === undefined ? owner : starredPage(page.ids, (index > 0 ? cursorPrev(`https://github.com/sample-user?before=p${index}&tab=stars`) : disabledControl("Previous")) + page.control);
	};
	return { pageFor, requests };
};
const restList = (all: number[]) => () => ({ link: null, data: all.map(i => ({ full_name: `sample-user/repo${i}`, html_url: `https://github.com/sample-user/repo${i}` })) });
const ids = (from: number, count = 30) => Array.from({ length: count }, (_, i) => from + i);

test("starred collects every page of a cursor-paginated list and ends on a disabled Next", async () => {
	const { pageFor, requests } = stars(
		{ ids: ids(0), control: cursorNext(cursorUrl("c1")) },
		{ ids: ids(30), control: cursorNext(cursorUrl("c2")) },
		{ ids: ids(60, 5), control: disabledControl("Next") },
	);
	// The last page has no source-end proof of its own; the REST list is the independent witness, as for any starred walk.
	const result = await collect("starred", url => url === "https://github.com/" ? owner : pageFor(url), restList([...ids(0), ...ids(30), ...ids(60, 5)]));
	assert.equal((result.records[0] as { starred: unknown[] }).starred.length, 65);
	assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
	assert.deepEqual(requests.filter(url => url !== "https://github.com/"), [starsUrl, cursorUrl("c1"), cursorUrl("c2")]);
});

test("starred single page with no further Next ends with proof", async () => {
	const { pageFor } = stars({ ids: ids(0, 3), control: disabledControl("Next") });
	const result = await collect("starred", url => url === "https://github.com/" ? owner : pageFor(url), restList(ids(0, 3)));
	assert.equal((result.records[0] as { starred: unknown[] }).starred.length, 3);
	assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
});

test("starred repeated cursor fails the walk", async () => {
	const { pageFor } = stars(
		{ ids: ids(0), control: cursorNext(cursorUrl("c1")) },
		{ ids: ids(30), control: cursorNext(cursorUrl("c1")) },
	);
	const result = await collect("starred", url => url === "https://github.com/" ? owner : pageFor(url));
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.state, { starred: prior });
	assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
});

test("starred cursor to another path fails the walk", async () => {
	const { pageFor } = stars({ ids: ids(0), control: cursorNext("https://github.com/other-user?after=c1&tab=stars") });
	const result = await collect("starred", url => url === "https://github.com/" ? owner : pageFor(url), () => ({ link: null, data: [] }));
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.state, { starred: prior });
});

test("InventoryEvidence follows a bound cursor and rejects an unbound one", () => {
	const page = (continuation: Continuation, i: number) =>
		({ ids: [String(i)], rowsComplete: true, rejectedRows: 0, continuation });
	const bound = new InventoryEvidence(starsUrl);
	bound.observePage(page({ kind: "next", url: cursorUrl("c1"), cursor: "c1" }, 1));
	assert.deepEqual(bound.next, { url: cursorUrl("c1"), page: 2 });
	bound.observePage(page({ kind: "end" }, 2));
	assert.equal(bound.decide(2), null);
	const unbound = new InventoryEvidence(starsUrl);
	unbound.observePage(page({ kind: "next", url: cursorUrl("c1") }, 1));
	assert.equal(unbound.next, null);
	assert.equal(unbound.decide(1), "unknown_continuation");
	const cycle = new InventoryEvidence(starsUrl);
	cycle.observePage(page({ kind: "next", url: cursorUrl("c1"), cursor: "c1" }, 1));
	cycle.observePage(page({ kind: "next", url: cursorUrl("c1"), cursor: "c1" }, 2));
	assert.equal(cycle.decide(2), "continuation_cycle");
});

for (const matches of [false, true]) {
	test(`starred missing browser pagination needs independent REST reconciliation: matches ${matches}`, async () => {
		const html = owner + '<ul id="user-starred-repos"><li><h3><a href="/sample-user/a">a</a></h3></li></ul>';
		const data = (matches ? ["a"] : ["a", "b"]).map(name => ({ full_name: `sample-user/${name}`, html_url: `https://github.com/sample-user/${name}` }));
		const result = await collect("starred", () => html, () => ({ link: null, data }));
		if (matches) {
			assert.equal(result.records.length, 1);
			assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
		} else {
			assert.deepEqual(result.records, []);
			assert.deepEqual(result.state, { starred: prior });
			assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
		}
	});
}

for (const stream of ["events", "starred"] as const) {
	for (const link of ["unreadable", '<https://api.github.com/items?page=2>; rel="continue"']) {
		test(`${stream} explicit empty data cannot override an unknown pagination header: ${link}`, async () => {
			const result = await collect(stream, () => owner + '<ul id="user-starred-repos"></ul>', () => ({ link, data: [] }));
			assert.deepEqual(result.records, []);
			assert.deepEqual(result.state, { [stream]: prior });
			assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
		});
	}
}

// Full-run replay: synthetic inputs only; no network, parser stubs or collector stubs.
type ReplayApi = { link: string | null; data: unknown };
const replayNow = "2026-01-01T00:00:00.000Z";
const replaySecret = "ghp_SYNTHETIC_SENTINEL_DO_NOT_EMIT";
const replayProfileUrl = "https://github.com/sample-user";
const replayEventsUrl = (page: number) => `https://api.github.com/users/sample-user/events/public?per_page=100&page=${page}`;
// The collector builds page 1 with encodeURIComponent but later pages by re-serializing
// the Link successor, so the same GitHub query can arrive as %20 or +. The offline router
// keys by canonicalUrl, which both forms reduce to.
const canonicalUrl = (url: string) => {
	const parsed = new URL(url);
	parsed.search = new URLSearchParams(parsed.search).toString();
	return parsed.toString();
};
const replayHistoryUrl = (type: string, page: number) =>
	canonicalUrl(`https://api.github.com/search/issues?q=${encodeURIComponent(`author:sample-user type:${type}`)}&sort=created&order=desc&per_page=100&page=${page}`);
const replayYearUrl = (year: number) => `${replayProfileUrl}?from=${year}-01-01&to=${year}-12-31`;
const replayRepoUrl = (page: number) => `${replayProfileUrl}?page=${page}&tab=repositories`;
const replayDates = (start: string, end: string) => {
	const dates: string[] = [];
	for (let date = new Date(start); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1))
		dates.push(date.toISOString().slice(0, 10));
	return dates;
};
const replayCalendar = (dates: string[]) =>
	`<h2 id="js-contribution-activity-description">${dates.length} contributions in the last year</h2><svg class="js-calendar-graph">${dates.map(date => `<rect class="day" data-date="${date}" data-count="1" data-level="1"></rect>`).join("")}</svg>`;

async function replayFixtures() {
	const fixture = async (name: string) => readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8");
	const profile = (await fixture("profile-pinned-listitem-current-github.html"))
		.replace(/<h2 id="js-contribution-activity-description"[\s\S]*?<\/h2>/u, "");
	const row = await fixture("repository-row-current-github.html");
	const event = JSON.parse(await fixture("events.json"))[0];
	const html = new Map<string, string | Error>([
		["https://github.com/", owner],
		[replayProfileUrl, profile + replayCalendar(replayDates("2025-01-02", "2026-01-01"))],
	]);
	for (const year of [2025, 2024, 2023])
		html.set(replayYearUrl(year), owner + replayCalendar(replayDates(`${year}-01-01`, `${year}-12-31`)));
	const names = [["alpha", "beta"], ["gamma", "delta"], ["epsilon"]];
	names.forEach((pageNames, index) => {
		const page = index + 1;
		const previous = page === 1 ? '<span class="previous_page disabled" aria-disabled="true">Previous</span>'
			: `<a class="previous_page" rel="prev" href="${replayRepoUrl(page - 1)}">Previous</a>`;
		const next = page === 3 ? '<span class="next_page disabled" aria-disabled="true">Next</span>'
			: `<a class="next_page" rel="next" href="${replayRepoUrl(page + 1)}">Next</a>`;
		html.set(replayRepoUrl(page), owner + `<div id="user-repositories-list"><ul>${pageNames.map(name => row.replaceAll("REPO", name)).join("")}</ul><div class="paginate-container"><div class="pagination">${previous}${next}</div></div></div>`);
	});
	html.set(starsUrl, starredPage(ids(0), disabledControl("Previous") + cursorNext(cursorUrl("c1"))));
	html.set(cursorUrl("c1"), starredPage(ids(30), cursorPrev("https://github.com/sample-user?before=p1&tab=stars") + cursorNext(cursorUrl("c2"))));
	html.set(cursorUrl("c2"), starredPage(ids(60, 5), cursorPrev("https://github.com/sample-user?before=p2&tab=stars") + disabledControl("Next")));
	const api = new Map<string, ReplayApi | Error>([
		["https://api.github.com/users/sample-user/starred?per_page=100&page=1", restList(ids(0, 65))()],
		[replayEventsUrl(1), { link: `<${replayEventsUrl(2)}>; rel="next"`, data: ids(1, 100).map(id => ({ ...event, id: String(id) })) }],
		[replayEventsUrl(2), { link: `<${replayEventsUrl(1)}>; rel="prev"`, data: ids(101, 2).map(id => ({ ...event, id: String(id) })) }],
	]);
	for (const type of ["issue", "pr"]) for (const page of [1, 2]) {
		api.set(replayHistoryUrl(type, page), {
			link: `<${replayHistoryUrl(type, page === 1 ? 2 : 1)}>; rel="${page === 1 ? "next" : "prev"}"`,
			data: { total_count: 101, incomplete_results: false, items: ids(page === 1 ? 1 : 101, page === 1 ? 100 : 1).map(id => ({
				id, number: id, repository_url: "https://api.github.com/repos/sample-user/demo",
				title: `Synthetic ${type} ${id}`, body: null, state: "open", created_at: replayNow, updated_at: replayNow,
				closed_at: null, html_url: `https://github.com/sample-user/demo/${type === "issue" ? "issues" : "pull"}/${id}`,
				comments: 0, reactions: { total_count: 0 }, labels: [], draft: false, pull_request: { merged_at: null },
			})) },
		});
	}
	return { html, api };
}

async function replayAll(mutate?: (routes: Awaited<ReturnType<typeof replayFixtures>>) => void) {
	const routes = await replayFixtures();
	mutate?.(routes);
	const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
	const requested: string[] = manifest.streams.map((stream: { name: string }) => stream.name);
	assert.deepEqual([...requested].sort(), ["contributions", "events", "history", "profile", "repositories", "starred"]);
	const state: Record<string, unknown> = Object.fromEntries(requested.map(stream => [stream, structuredClone(prior)]));
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string; stream?: string; diagnostics?: unknown }> = [];
	const failures: Array<{ stream: string; message: string; options: unknown }> = [];
	const timeline: Array<{ kind: string; stream?: string; url?: string; milliseconds?: number }> = [];
	const progress: string[] = [];
	const unmapped: string[] = [];
	const read = <T>(map: Map<string, T | Error>, url: string): T => {
		const value = map.get(canonicalUrl(url));
		if (value === undefined) { unmapped.push(url); throw new Error("unmapped offline request"); }
		if (value instanceof Error) throw value;
		return structuredClone(value);
	};
	await collectGitHubBrowser({
		requested: new Set(requested), state,
		emit: async message => { messages.push(structuredClone(message)); timeline.push({ kind: message.type, stream: "stream" in message ? message.stream : undefined }); },
		emitRecord: async (stream, data) => { records.push({ stream, data: structuredClone(data) }); timeline.push({ kind: "record", stream }); },
		reportStreamFailure: async (stream, message, options) => { failures.push({ stream, message, options }); timeline.push({ kind: "failure", stream }); },
		progress: async message => { progress.push(message); },
	}, {
		openPage: async url => { timeline.push({ kind: "html", url: canonicalUrl(url) }); return { requestedUrl: url, currentUrl: url, html: read(routes.html, url) }; },
		fetchPublicJson: async url => { timeline.push({ kind: "json", url: canonicalUrl(url) }); return { requestedUrl: url, responseUrl: url, status: 200, ...read(routes.api, url) }; },
		now: () => new Date(replayNow),
		sleep: async milliseconds => { timeline.push({ kind: "sleep", milliseconds }); },
	});
	// The collector isolates source exceptions, so assert misses outside its catch boundary.
	assert.deepEqual(unmapped, []);
	assert.ok(!JSON.stringify({ records, messages, failures, state, progress }).includes(replaySecret));
	return { requested, records, messages, failures, state, timeline };
}

function assertReplayPublished(result: Awaited<ReturnType<typeof replayAll>>, stream: string) {
	assert.equal(result.records.filter(record => record.stream === stream).length, 1, stream);
	assert.equal(result.messages.filter(message => message.type === "STATE" && message.stream === stream).length, 1, stream);
	assert.ok(result.timeline.findIndex(item => item.kind === "record" && item.stream === stream) <
		result.timeline.findIndex(item => item.kind === "STATE" && item.stream === stream), stream);
	assert.equal((result.state[stream] as { fetched_at: string }).fetched_at, replayNow);
	assert.equal(result.messages.filter(message => message.type === "DETAIL_COVERAGE" && message.stream === stream).length, stream === "profile" ? 0 : 1);
}

test("full GitHub replay publishes every manifest stream in one offline collector call", async () => {
	const result = await replayAll();
	for (const stream of result.requested) assertReplayPublished(result, stream);
	assert.deepEqual(result.failures, []);
	assert.equal(result.messages.filter(message => message.type === "SKIP_RESULT").length, 0);
	const data = (stream: string) => result.records.find(record => record.stream === stream)!.data;
	assert.deepEqual((data("repositories").repositories as Array<{ name: string }>).map(row => row.name), ["alpha", "beta", "gamma", "delta", "epsilon"]);
	assert.deepEqual((data("starred").starred as Array<{ fullName: string }>).map(row => row.fullName), ids(0, 65).map(id => `sample-user/repo${id}`));
	assert.deepEqual((data("events").events as Array<{ id: string }>).map(row => row.id), ids(1, 102).map(String));
	for (const [key, type] of [["issues", "issue"], ["pullRequests", "pr"]])
		assert.deepEqual((data("history")[key] as Array<{ id: string }>).map(row => row.id), ids(1, 101).map(id => `gh-${type}-${id}`));
	assert.deepEqual((data("contributions").days as Array<{ date: string }>).map(day => day.date).sort(), replayDates("2023-01-01", "2026-01-01"));
	assert.equal(data("contributions").totalContributionsLastYear, 365);
	assert.deepEqual(data("contributions").yearTotals, [{ year: 2026, total: 365 }, { year: 2025, total: 365 }, { year: 2024, total: 366 }, { year: 2023, total: 365 }]);
	assert.deepEqual(result.timeline.filter(item => item.kind === "sleep").map(item => item.milliseconds), [6500, 6500]);
	assert.deepEqual(result.timeline.filter(item => item.url).map(({ kind, url }) => [kind, url]), [
		["html", "https://github.com/"], ["html", replayProfileUrl],
		...[1, 2, 3].map(page => ["html", replayRepoUrl(page)]),
		["html", starsUrl], ["html", cursorUrl("c1")], ["html", cursorUrl("c2")],
		["json", "https://api.github.com/users/sample-user/starred?per_page=100&page=1"],
		["json", replayEventsUrl(1)], ["json", replayEventsUrl(2)], ["html", replayProfileUrl],
		...[2025, 2024, 2023].map(year => ["html", replayYearUrl(year)]),
		...["issue", "pr"].flatMap(type => [1, 2].map(page => ["json", replayHistoryUrl(type, page)])),
	]);
});

const replayFailures: Array<{ name: string; stream: string; cause: string; mutate: (routes: Awaited<ReturnType<typeof replayFixtures>>) => void }> = [
	{ name: "unknown event Link", stream: "events", cause: "unreadable_pagination", mutate: ({ api }) => {
		const response = api.get(replayEventsUrl(1)) as ReplayApi;
		api.set(replayEventsUrl(1), { ...response, link: "unreadable" });
	} },
	{ name: "incomplete history search", stream: "history", cause: "search_incomplete_results", mutate: ({ api }) => {
		const response = api.get(replayHistoryUrl("issue", 1)) as ReplayApi;
		api.set(replayHistoryUrl("issue", 1), { ...response, data: { ...(response.data as object), incomplete_results: true } });
	} },
	{ name: "missing contribution year", stream: "contributions", cause: "year_view_unavailable", mutate: ({ html }) => { html.set(replayYearUrl(2024), owner); } },
	{ name: "repeated starred cursor", stream: "starred", cause: "continuation_cycle", mutate: ({ html }) => {
		html.set(cursorUrl("c1"), (html.get(cursorUrl("c1")) as string).replace(cursorUrl("c2"), cursorUrl("c1")));
	} },
	{ name: "secret-looking source exception", stream: "events", cause: "source_request_failed", mutate: ({ api }) => { api.set(replayEventsUrl(1), new Error(replaySecret)); } },
];
for (const scenario of replayFailures) test(`full GitHub replay isolates ${scenario.name}`, async () => {
	const result = await replayAll(scenario.mutate);
	assert.deepEqual(result.state[scenario.stream], prior);
	assert.equal(result.records.filter(record => record.stream === scenario.stream).length, 0);
	assert.equal(result.messages.filter(message => message.type === "STATE" && message.stream === scenario.stream).length, 0);
	assert.equal(result.messages.filter(message => message.type === "DETAIL_COVERAGE" && message.stream === scenario.stream).length, 0);
	const outcomes = [...result.messages.filter(message => message.type === "SKIP_RESULT"), ...result.failures];
	assert.equal(outcomes.length, 1);
	assert.equal(outcomes[0].stream, scenario.stream);
	assert.ok(JSON.stringify(outcomes[0]).includes(`"${scenario.cause}"`));
	assert.ok(JSON.stringify(outcomes[0]).length < 2000, "failure remains bounded");
	for (const stream of result.requested.filter(stream => stream !== scenario.stream)) assertReplayPublished(result, stream);
});
