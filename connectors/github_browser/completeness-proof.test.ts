// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";
import { InventoryEvidence } from "./inventory-evidence.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectInventoryPage, parseProfilePage } from "./parsers.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const terminal = '<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
const prior = { fetched_at: "2025-12-01T00:00:00Z" };

async function collect(stream: string, htmlFor: (url: string) => string, api?: (url: string) => { link: string | null | undefined; data: unknown }) {
	const records: object[] = [];
	const messages: Array<{ type: string; reason?: string; diagnostics?: unknown }> = [];
	const state: Record<string, unknown> = { [stream]: structuredClone(prior) };
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set([stream]), state,
	}, {
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html: htmlFor(url) }),
		fetchPublicJson: async url => ({ requestedUrl: url, responseUrl: url, status: api === undefined ? 500 : 200, data: null, ...api?.(url) }),
		now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
	});
	return { records, messages, state };
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
			assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "inventory_not_proven_complete"]]);
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
		assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "github_browser_incomplete"]]);
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
		assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "github_browser_incomplete"]]);
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

for (const disabled of [false, true]) {
	test(`starred real BtnGroup pagination, disabled Next ${disabled}, cannot certify end`, async () => {
		const list = `<ul id="user-starred-repos">${Array.from({ length: 30 }, (_, i) => `<li><h3><a href="/sample-user/repo${i}">repo${i}</a></h3></li>`).join("")}</ul>`;
		const control = disabled ? '<button class="btn BtnGroup-item" disabled="disabled">Next</button>'
			: '<a rel="nofollow" class="btn BtnGroup-item" href="https://github.com/sample-user?after=Y3Vyc29y&tab=stars">Next</a>';
		const html = owner + list + `<div class="paginate-container"><div class="BtnGroup" data-test-selector="pagination"><button class="btn BtnGroup-item" disabled="disabled">Previous</button>${control}</div></div>`;
		const url = "https://github.com/sample-user?page=1&tab=stars";
		const proof = inspectInventoryPage({ requestedUrl: url, currentUrl: url, html }, "starred", "sample-user", 1, 30, 0);
		assert.equal(proof.complete, false);
		assert.equal(proof.reason, disabled ? "terminal_unverified" : "unknown_continuation");
		const result = await collect("starred", () => html);
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.state, { starred: prior });
		assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
	});
}

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
