// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { type Continuation, InventoryEvidence, type PageObservation } from "./inventory-evidence.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const prior = { fetched_at: "2025-12-01T00:00:00Z" };
const API = "https://api.github.com";
const event = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/events.json", import.meta.url), "utf8"))[0];
const issue = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/history-issue.json", import.meta.url), "utf8")).items[0];

type Api = { link: string | null | undefined; data: unknown };
async function collect(stream: string, api: (url: URL) => Api, html: string | ((url: URL) => string) = owner) {
	const records: object[] = [];
	const messages: Array<{ type: string; diagnostics?: unknown }> = [];
	const requests: string[] = [];
	const browserRequests: string[] = [];
	const state: Record<string, unknown> = { [stream]: structuredClone(prior) };
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set([stream]), state,
	}, {
		openPage: async url => {
			browserRequests.push(url);
			return { requestedUrl: url, currentUrl: url, html: typeof html === "string" ? html : html(new URL(url)) };
		},
		fetchPublicJson: async url => {
			requests.push(url);
			return { requestedUrl: url, responseUrl: url, status: 200, ...api(new URL(url)) };
		},
		now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
	});
	return { records, messages, state, requests, browserRequests };
}

function assertWithheld(result: Awaited<ReturnType<typeof collect>>, stream: string) {
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.state, { [stream]: prior });
	assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
}

const cause = (result: Awaited<ReturnType<typeof collect>>) =>
	(result.messages[0]?.diagnostics as { cause?: string } | undefined)?.cause;

// Each API walk, with the request path GitHub serves and two distinct rows per page
// of a list that is `pages` pages long.
const walks = {
	events: {
		path: "/users/sample-user/events/public", alias: "/user/1001/events/public", selection: "per_page=100",
		rows: (page: number, _pages = 2) => [{ ...event, id: `${page}-a` }, { ...event, id: `${page}-b` }],
		html: (_pages = 2) => owner,
	},
	starred: {
		path: "/users/sample-user/starred", alias: "/user/1001/starred", selection: "per_page=100",
		rows: (page: number, _pages = 2) => [`r${page}a`, `r${page}b`].map(name => ({ full_name: `sample-user/${name}`, html_url: `https://github.com/sample-user/${name}` })),
		// Browser rows without a counter or pagination need the REST enumeration.
		html: (pages = 2) => owner + `<ul id="user-starred-repos">${Array.from({ length: pages }, (_, i) => [`r${i + 1}a`, `r${i + 1}b`]).flat()
			.map(name => `<li><h3><a href="/sample-user/${name}">${name}</a></h3></li>`).join("")}</ul>`,
	},
	history: {
		path: "/search/issues", alias: "/search/issues", selection: "q=author%3Asample-user+type%3Aissue&sort=created&order=desc&per_page=100",
		rows: (page: number, pages = 2) => ({ total_count: pages * 2, incomplete_results: false,
			items: [1, 2].map(i => ({ ...issue, id: page * 10 + i, number: page * 10 + i })) }),
		html: (_pages = 2) => owner,
	},
} as const;
type Walk = keyof typeof walks;

function api(walk: Walk, firstLink: (spec: (typeof walks)[Walk]) => string | null | undefined) {
	const spec = walks[walk];
	return (url: URL): Api => {
		// The other history type is an empty, complete search.
		if (url.searchParams.get("q")?.includes("type:pr")) return { link: null, data: { total_count: 0, incomplete_results: false, items: [] } };
		const page = Number(url.searchParams.get("page"));
		const target = (n: number) => `<${API}${spec.alias}?${spec.selection}&page=${n}>`;
		// Page 2 always answers as a real terminal page, so it can only help a walk that skipped evidence.
		return page === 1
			? { link: firstLink(spec), data: spec.rows(1) }
			: { link: `${target(1)}; rel="prev", ${target(1)}; rel="first"`, data: spec.rows(page) };
	};
}

for (const walk of Object.keys(walks) as Walk[]) {
	const spec = walks[walk];
	test(`${walk} follows GitHub's real id-aliased Link through a bound terminal page`, async () => {
		const result = await collect(walk, api(walk, s => `<${API}${s.alias}?${s.selection}&page=2>; rel="next", <${API}${s.alias}?${s.selection}&page=2>; rel="last"`), spec.html());
		assert.equal(result.records.length, 1);
		assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
		// The walk requests its own owner-bound successor, not the header's id alias.
		assert.ok(result.requests.some(url => new URL(url).pathname === spec.path && new URL(url).searchParams.get("page") === "2"));
	});

	// Finding 1: the continuation a page names must be the walk's next request.
	for (const [label, next] of [
		["skipped page", (s: typeof spec) => `<${API}${s.alias}?${s.selection}&page=3>; rel="next"`],
		["cursor", (s: typeof spec) => `<${API}${s.alias}?${s.selection}&after=Y3Vyc29y>; rel="next"`],
		["foreign owner", (s: typeof spec) => `<${API}${s.path.replace("sample-user", "other-user").replace("/search/issues", "/search/commits")}?${s.selection}&page=2>; rel="next"`],
		["changed selection", (s: typeof spec) => `<${API}${s.alias}?${s.selection.replace("per_page=100", "per_page=50")}&page=2>; rel="next"`],
		["foreign terminal", () => `<${API}/repositories/1/contributors?page=1>; rel="prev", <${API}/repositories/1/contributors?page=1>; rel="first"`],
		["first-only header", (s: typeof spec) => `<${API}${s.alias}?${s.selection}&page=1>; rel="first"`],
	] as const) {
		test(`${walk} never certifies a walk whose page names a ${label} continuation`, async () => {
			const result = await collect(walk, api(walk, next), spec.html());
			assertWithheld(result, walk);
			assert.equal(result.requests.filter(url => !url.includes("type%3Apr")).length, 1);
		});
	}

	// Finding 2: unknown metadata stays binding even when a later page looks terminal.
	for (const [label, link] of [
		["unreadable", "unreadable"],
		["unsupported relation", `<${API}/users/sample-user/events/public?page=2>; rel="continue"`],
		["unobserved", undefined],
		["last without next", `<${API}${spec.alias}?${spec.selection}&page=1>; rel="last"`],
	] as const) {
		test(`${walk} keeps ${label} pagination evidence after a later terminal page`, async () => {
			const result = await collect(walk, api(walk, () => link), spec.html());
			assertWithheld(result, walk);
			assert.equal(result.requests.filter(url => !url.includes("type%3Apr")).length, 1);
			assert.match(String(cause(result)), /pagination/u);
		});
	}
}

for (const walk of Object.keys(walks) as Walk[]) {
	test(`${walk} withholds when the last page's header is unreadable, even with every row collected`, async () => {
		const spec = walks[walk];
		const result = await collect(walk, url => url.searchParams.get("q")?.includes("type:pr")
			? { link: null, data: { total_count: 0, incomplete_results: false, items: [] } }
			: url.searchParams.get("page") === "1"
				? { link: `<${API}${spec.alias}?${spec.selection}&page=2>; rel="next"`, data: spec.rows(1) }
				: { link: "unreadable", data: spec.rows(2) }, spec.html());
		assertWithheld(result, walk);
		assert.equal(cause(result), "unreadable_pagination");
	});
}

test("an absent Link header ends only a first page", async () => {
	const result = await collect("events", url => url.searchParams.get("page") === "1"
		? { link: `<${API}/user/1001/events/public?per_page=100&page=2>; rel="next"`, data: walks.events.rows(1) }
		: { link: null, data: walks.events.rows(2) });
	assertWithheld(result, "events");
	assert.equal(cause(result), "missing_pagination");
});

// Every negative observation, then every event a walk accepts. None may clear it.
test("InventoryEvidence is append-only: no later event erases an unknown or ambiguous observation", () => {
	const start = "https://github.com/sample-user?page=1&tab=repositories";
	const page = (ids: string[], continuation: Continuation, rows = { rowsComplete: true, rejectedRows: 0 }) =>
		({ ids, ...rows, continuation });
	const negatives: Array<[string, (evidence: InventoryEvidence) => void]> = [
		["unknown_continuation", e => e.observePage(page(["a"], { kind: "unknown", reason: "unknown_continuation" }))],
		["unreadable_pagination", e => e.observePage(page(["a"], { kind: "unknown", reason: "unreadable_pagination" }))],
		["ambiguous_boundary", e => e.observePage(page(["a"], InventoryEvidence.boundaryEnd({ kind: "ambiguous", unclaimedCandidates: 0 })))],
		["unclaimed_candidates", e => e.observePage(page(["a"], InventoryEvidence.boundaryEnd({ kind: "located", unclaimedCandidates: 1 })))],
		["wrong_owner", e => e.observePage(page(["a"], { kind: "unbound", reason: "wrong_owner" }))],
		["discarded_rows", e => e.observePage(page(["a"], { kind: "next", url: `${start}&x` }, { rowsComplete: false, rejectedRows: 0 }))],
		["duplicate_rows", e => e.observePage(page(["a", "a"], { kind: "next", url: `${start}&x` }))],
		["source_total_changed", e => e.addTotals({ exactTotals: [1, 2], totalConflict: false })],
		["malformed_search_response", e => e.fail("malformed_search_response")],
		["page_limit_reached", e => e.observePage(page(["a"], { kind: "next", url: `${start}&x` }))],
		["end_before_advertised_last", e => {
			e.observePage({ ...page(["a"], { kind: "next", url: `${start}&x` }), lastPage: 3 });
			e.observePage(page(["b"], { kind: "end" }));
		}],
		["pagination_bound_changed", e => {
			e.observePage({ ...page(["a"], { kind: "next", url: `${start}&x` }), lastPage: 3 });
			e.observePage({ ...page(["b"], { kind: "next", url: `${start}&y` }), lastPage: 4 });
		}],
		["end_before_linked_page", e => {
			e.observePage({ ...page(["a"], { kind: "next", url: `${start}&x` }), linkedPage: 3 });
			e.observePage(page(["b"], { kind: "end" }));
		}],
		["continuation_beyond_advertised_last", e => {
			e.observePage({ ...page(["a"], { kind: "next", url: `${start}&x` }), lastPage: 2 });
			e.observePage(page(["b"], { kind: "next", url: `${start}&y` }));
		}],
	];
	const positives: Array<[string, (evidence: InventoryEvidence) => void]> = [
		["end page", e => e.observePage(page(["z"], { kind: "end" }))],
		["next page", e => e.observePage(page(["y"], { kind: "next", url: `${start}&y` }))],
		["unproven page", e => e.observePage(page(["x"], { kind: "unproven" }))],
		["located boundary", e => e.observePage(page(["w"], InventoryEvidence.boundaryEnd({ kind: "located", unclaimedCandidates: 0 })))],
		["matching total", e => e.addTotals({ exactTotals: [e.identities.size], totalConflict: false })],
		["clean enumeration", e => {
			const enumeration = new InventoryEvidence("https://api.github.com/users/sample-user/starred?per_page=100&page=1");
			enumeration.observePage(page(Array.from(e.identities), { kind: "end" }));
			e.reconcile(enumeration);
		}],
	];
	for (const [reason, negative] of negatives) {
		const evidence = new InventoryEvidence(start, { pages: reason === "page_limit_reached" ? 1 : 60 });
		negative(evidence);
		assert.equal(evidence.next, null, `${reason} must stop the walk`);
		for (const [label, positive] of positives) {
			positive(evidence);
			assert.equal(evidence.decide(evidence.identities.size), reason, `${label} erased ${reason}`);
		}
	}
});

test("InventoryEvidence cannot be certified by abandoning a walk mid-way", () => {
	const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=repositories");
	evidence.observePage({ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "next", url: "https://github.com/sample-user?page=2&tab=repositories" } });
	evidence.addTotals({ exactTotals: [1], totalConflict: false });
	assert.equal(evidence.decide(1), "walk_incomplete");
});

// The last page a header advertises is walk evidence; a later page may not discard it.
function linked(walk: Walk, pages: number, header: (page: number, target: (n: number) => string) => string | null) {
	const spec = walks[walk];
	return (url: URL): Api => {
		if (url.searchParams.get("q")?.includes("type:pr")) return { link: null, data: { total_count: 0, incomplete_results: false, items: [] } };
		const page = Number(url.searchParams.get("page"));
		return { link: header(page, n => `<${API}${spec.alias}?${spec.selection}&page=${n}>`), data: spec.rows(page, pages) };
	};
}

for (const walk of Object.keys(walks) as Walk[]) {
	const spec = walks[walk];
	// Two pages of rows that agree with every count, but page 1 advertised a third page.
	test(`${walk} withholds a walk that ends before the last page it advertised`, async () => {
		const result = await collect(walk, linked(walk, 2, (page, target) => page === 1
			? `${target(2)}; rel="next", ${target(3)}; rel="last"`
			: `${target(1)}; rel="prev", ${target(1)}; rel="first"`), spec.html(2));
		assertWithheld(result, walk);
		assert.equal(cause(result), "end_before_advertised_last");
	});
	test(`${walk} withholds a walk whose advertised last page changes`, async () => {
		const result = await collect(walk, linked(walk, 3, (page, target) => page === 1
			? `${target(2)}; rel="next", ${target(3)}; rel="last"`
			: `${target(1)}; rel="prev", ${target(3)}; rel="next", ${target(4)}; rel="last", ${target(1)}; rel="first"`), spec.html(3));
		assertWithheld(result, walk);
		assert.equal(cause(result), "pagination_bound_changed");
		assert.equal(result.requests.filter(url => !url.includes("type%3Apr")).length, 2);
	});
	test(`${walk} publishes GitHub's real three-page walk through its advertised last page`, async () => {
		const result = await collect(walk, linked(walk, 3, (page, target) => page < 3
			? [...(page > 1 ? [`${target(page - 1)}; rel="prev"`] : []), `${target(page + 1)}; rel="next"`, `${target(3)}; rel="last"`,
				...(page > 1 ? [`${target(1)}; rel="first"`] : [])].join(", ")
			: `${target(2)}; rel="prev", ${target(1)}; rel="first"`), spec.html(3));
		assert.equal(result.records.length, 1);
		assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
	});
}

// A nested entry inside a claimed row is a candidate the parser must account for.
for (const stream of ["starred", "repositories"] as const) {
	for (const nested of ["li", 'div role="listitem"', "article", "h4", 'div role="row"'] as const) {
		test(`${stream} withholds a terminal inventory hiding a nested ${nested} entry`, async () => {
			const tag = nested.split(" ")[0];
			const row = (name: string, extra = "") => `<li><h3><a href="/sample-user/${name}">${name}</a></h3>${extra}</li>`;
			const list = `<ul id="${stream === "starred" ? "user-starred-repos" : "user-repositories-list"}">${row("first", `<ul><${nested}><a href="/sample-user/second">second</a></${tag}></ul>`)}</ul>`;
			const terminal = '<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
			const result = await collect(stream, () => ({ link: null, data: [] }), owner + list + terminal);
			assertWithheld(result, stream);
		});
	}
}

const inventoryPage = (stream: "repositories" | "starred", names: string[], pager = "", total?: number) => {
	const tab = stream === "starred" ? "stars" : "repositories";
	return owner + (total === undefined ? "" : `<nav><a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">${total}</span></a></nav>`) +
		`<div id="${stream === "starred" ? "user-starred-repos" : "user-repositories-list"}"><ul>${names.map(name => `<li><h3><a href="/sample-user/${name}">${name}</a></h3></li>`).join("")}</ul>${pager}</div>`;
};
const disabledNext = '<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>';

for (const stream of ["repositories", "starred"] as const) {
	test(`${stream} cannot use a retained total or REST reconciliation to erase a linked-page floor`, async () => {
		const tab = stream === "starred" ? "stars" : "repositories";
		const result = await collect(stream, () => ({ link: null, data: ["a", "b", "c"].map(name => ({ full_name: `sample-user/${name}`, html_url: `https://github.com/sample-user/${name}` })) }), url => {
			if (!url.searchParams.has("page")) return owner;
			const page = Number(url.searchParams.get("page"));
			const pager = page === 3 ? "" : `<div class="pagination"><a rel="next" href="/sample-user?page=${page + 1}&amp;tab=${tab}">Next</a>${page === 1 ? `<a href="/sample-user?page=7&amp;tab=${tab}">7</a>` : ""}</div>`;
			return inventoryPage(stream, [["a"], ["b"], ["c"]][page - 1] ?? [], pager, stream === "repositories" && page === 1 ? 3 : undefined);
		});
		assertWithheld(result, stream);
		assert.equal(cause(result), "end_before_linked_page");
	});
}

test("a terminal starred fallback cannot drop an identity observed on the primary route", async () => {
	const result = await collect("starred", () => ({ link: null, data: [] }), url => url.pathname.startsWith("/stars/")
		? inventoryPage("starred", ["a"], disabledNext)
		: inventoryPage("starred", ["a", "b"]));
	assertWithheld(result, "starred");
	assert.equal(cause(result), "identity_mismatch");
});

test("a starred fallback cannot erase a primary page that claims empty beside a readable row", async () => {
	const result = await collect("starred", () => ({ link: null, data: [] }), url => url.pathname.startsWith("/stars/")
		? inventoryPage("starred", ["a"], disabledNext)
		: inventoryPage("starred", ["a"]).replace("</ul>", '</ul><div class="blankslate">No starred repositories</div>'));
	assertWithheld(result, "starred");
	assert.equal(cause(result), "discarded_rows");
});

test("an alternate cannot erase an unbound primary observation at the walk interface", () => {
	const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=stars");
	evidence.observeRoutes(
		{ ids: [], rowsComplete: false, rejectedRows: 0, continuation: { kind: "unbound", reason: "wrong_owner" } },
		{ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } },
	);
	assert.equal(evidence.decide(1), "wrong_owner");
});

test("generated alternate-route sequences cannot clear a negative source observation", () => {
	const negatives: Array<{ page: PageObservation; reason: string }> = [
		{ page: { ids: [], rowsComplete: false, rejectedRows: 0, continuation: { kind: "unbound", reason: "wrong_owner" } }, reason: "wrong_owner" },
		{ page: { ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "unknown", reason: "unknown_continuation" } }, reason: "unknown_continuation" },
		{ page: { ids: ["a"], rowsComplete: false, rejectedRows: 0, continuation: { kind: "unproven" } }, reason: "discarded_rows" },
	];
	for (const { page, reason } of negatives) {
		for (const witness of ["end", "total", "reconcile"] as const) {
			const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=stars");
			evidence.observeRoutes(page, { ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: witness === "end" ? "end" : "unproven" } });
			if (witness === "total") evidence.addTotals({ exactTotals: [1], totalConflict: false });
			if (witness === "reconcile") {
				const independent = new InventoryEvidence("https://api.github.com/users/sample-user/starred?page=1");
				independent.observePage({ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
				evidence.reconcile(independent);
			}
			assert.equal(evidence.decide(1), reason, `${reason} was erased by ${witness}`);
		}
	}
	// A missing list is availability evidence, rather than a contradictory recognized list.
	const absent = new InventoryEvidence("https://github.com/sample-user?page=1&tab=stars");
	absent.observeRoutes(
		{ ids: [], rowsComplete: false, rejectedRows: 0, continuation: { kind: "unknown", reason: "unreadable_list" } },
		{ ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } },
	);
	assert.equal(absent.decide(1), null);
});

test("page floors remain binding when advertised only by the non-selected route", () => {
	const page: PageObservation = { ids: ["a"], rowsComplete: true, rejectedRows: 0, continuation: { kind: "unproven" } };
	for (const missingAlternate of [false, true]) {
		const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=stars");
		if (missingAlternate) evidence.observeRoutes(page,
			{ ids: [], rowsComplete: false, rejectedRows: 0, linkedPage: 2, continuation: { kind: "unknown", reason: "unreadable_list" } });
		else evidence.observeRoutes({ ...page, linkedPage: 2 }, { ...page, continuation: { kind: "end" } });
		evidence.addTotals({ exactTotals: [1], totalConflict: false });
		assert.equal(evidence.decide(1), "end_before_linked_page");
	}
});

for (const stream of ["repositories", "starred"] as const) {
	for (const starsRoute of stream === "starred" ? [false, true] : [false]) {
		for (const total of [undefined, 1]) {
			for (const numericPage of [false, true]) {
				test(`${stream} rejects ${numericPage ? "page plus cursor" : "cursor-only"} Next on ${starsRoute ? "stars" : "profile"} route with total ${total}`, async () => {
					const result = await collect(stream, () => ({ link: null, data: [] }), url => {
						if (!url.searchParams.has("page")) return owner;
						if (starsRoute && !url.pathname.startsWith("/stars/")) return inventoryPage(stream, ["a"]);
						const target = starsRoute ? "/stars/sample-user?" : `/sample-user?tab=${stream === "starred" ? "stars" : "repositories"}&amp;`;
						return Number(url.searchParams.get("page")) === 1
							? inventoryPage(stream, ["a"], `<div class="pagination"><a rel="next" class="next_page" href="${target}${numericPage ? "page=2&amp;" : ""}after=SKIP">Next</a></div>`, total)
							: inventoryPage(stream, ["c"], disabledNext);
					});
					assertWithheld(result, stream);
					assert.ok(result.browserRequests.every(url => !new URL(url).searchParams.has("after")));
				});
			}
		}
	}
}

// Exhaust all short walk lengths, advertised floors, and independent end witnesses.
// The oracle describes source obligations, independently of the walk's decision.
test("generated walks satisfy every advertised page on every successful decision", () => {
	let successes = 0;
	let contradictions = 0;
	for (let length = 1; length <= 4; length += 1) {
		for (let floor = 1; floor <= 5; floor += 1) {
			for (const witness of ["end", "total", "reconcile"] as const) {
				const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=repositories");
				for (let page = 1; page <= length; page += 1) {
					evidence.observePage({ ids: [`r${page}`], rowsComplete: true, rejectedRows: 0,
						...(page === 1 ? { linkedPage: floor } : {}),
						continuation: page < length ? { kind: "next", url: `https://github.com/sample-user?page=${page + 1}&tab=repositories` }
							: { kind: witness === "end" ? "end" : "unproven" } });
				}
				if (witness === "total") evidence.addTotals({ exactTotals: [length], totalConflict: false });
				if (witness === "reconcile") {
					const independent = new InventoryEvidence("https://api.github.com/users/sample-user/starred?page=1");
					independent.observePage({ ids: Array.from({ length }, (_, i) => `r${i + 1}`), rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
					evidence.reconcile(independent);
				}
				const decision = evidence.decide(length);
				if (length < floor) {
					assert.equal(decision, "end_before_linked_page", JSON.stringify({ length, floor, witness }));
					contradictions += 1;
				} else {
					assert.equal(decision, null, JSON.stringify({ length, floor, witness }));
					successes += 1;
				}
			}
		}
	}
	assert.ok(successes > 0 && contradictions > 0);
});

test("generated fallback sequences conserve every observed identity without unioning payloads", () => {
	const start = "https://github.com/sample-user?page=1&tab=stars";
	const names = ["a", "b", "c"];
	const subset = (mask: number) => names.filter((_, i) => (mask & (1 << i)) !== 0);
	let complete = 0;
	let withheld = 0;
	for (let primaryMask = 1; primaryMask < 8; primaryMask += 1) {
		for (let alternateMask = 1; alternateMask < 8; alternateMask += 1) {
			for (const witness of ["end", "total", "reconcile", "later-page"] as const) {
				const evidence = new InventoryEvidence(start);
				const primary = subset(primaryMask);
				const alternate = subset(alternateMask);
				const missing = primary.filter(id => !alternate.includes(id));
				const { selected, added } = evidence.observeRoutes(
					{ ids: primary, rowsComplete: true, rejectedRows: 0, continuation: { kind: "unproven" } },
					{ ids: alternate, rowsComplete: true, rejectedRows: 0, continuation: witness === "later-page"
						? { kind: "next", url: "https://github.com/stars/sample-user?page=2" }
						: { kind: witness === "end" ? "end" : "unproven" } },
				);
				assert.deepEqual(selected.ids, alternate);
				assert.deepEqual([...added], alternate, "an omitted primary identity must not be invented in the selected payload");
				let covered = alternate.length;
				if (witness === "later-page") {
					const tail = missing.length > 0 ? missing : ["d"];
					evidence.observePage({ ids: tail, rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
					covered += tail.length;
				}
				if (witness === "total") evidence.addTotals({ exactTotals: [covered], totalConflict: false });
				if (witness === "reconcile") {
					const independent = new InventoryEvidence("https://api.github.com/users/sample-user/starred?page=1");
					independent.observePage({ ids: alternate, rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
					evidence.reconcile(independent);
				}
				const shouldComplete = witness === "later-page" || missing.length === 0;
				assert.equal(evidence.decide(covered), shouldComplete ? null : "identity_mismatch", JSON.stringify({ primary, alternate, witness }));
				if (shouldComplete) complete += 1;
				else withheld += 1;
			}
		}
	}
	assert.ok(complete > 0 && withheld > 0);
});

test("generated cursor contradictions stop the owner before another request, despite later witnesses", () => {
	for (let length = 1; length <= 4; length += 1) {
		for (let cursorPage = 1; cursorPage <= length; cursorPage += 1) {
			for (const key of ["after", "before", "cursor"]) {
				for (const value of ["", "SKIP"]) {
					const evidence = new InventoryEvidence("https://github.com/sample-user?page=1&tab=stars");
					for (let page = 1; page <= cursorPage; page += 1) {
						const next = `https://github.com/sample-user?page=${page + 1}&tab=stars${page === cursorPage ? `&${key}=${value}` : ""}`;
						evidence.observePage({ ids: [`r${page}`], rowsComplete: true, rejectedRows: 0, continuation: { kind: "next", url: next } });
					}
					assert.equal(evidence.next, null);
					const independent = new InventoryEvidence("https://api.github.com/users/sample-user/starred?page=1");
					independent.observePage({ ids: Array.from(evidence.identities), rowsComplete: true, rejectedRows: 0, continuation: { kind: "end" } });
					evidence.addTotals({ exactTotals: [evidence.identities.size], totalConflict: false });
					evidence.reconcile(independent);
					assert.equal(evidence.decide(evidence.identities.size), "unknown_continuation");
				}
			}
		}
	}
});
