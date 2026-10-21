// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { type Continuation, InventoryEvidence } from "./inventory-evidence.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const prior = { fetched_at: "2025-12-01T00:00:00Z" };
const API = "https://api.github.com";
const event = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/events.json", import.meta.url), "utf8"))[0];
const issue = JSON.parse(await readFile(new URL("./__fixtures__/synthetic/history-issue.json", import.meta.url), "utf8")).items[0];

type Api = { link: string | null | undefined; data: unknown };
async function collect(stream: string, api: (url: URL) => Api, html = owner) {
	const records: object[] = [];
	const messages: Array<{ type: string; diagnostics?: unknown }> = [];
	const requests: string[] = [];
	const state: Record<string, unknown> = { [stream]: structuredClone(prior) };
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set([stream]), state,
	}, {
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html }),
		fetchPublicJson: async url => {
			requests.push(url);
			return { requestedUrl: url, responseUrl: url, status: 200, ...api(new URL(url)) };
		},
		now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
	});
	return { records, messages, state, requests };
}

function assertWithheld(result: Awaited<ReturnType<typeof collect>>, stream: string) {
	assert.deepEqual(result.records, []);
	assert.deepEqual(result.state, { [stream]: prior });
	assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
}

const cause = (result: Awaited<ReturnType<typeof collect>>) =>
	(result.messages[0]?.diagnostics as { cause?: string } | undefined)?.cause;

// Each API walk, with the request path GitHub serves and a page of two distinct rows.
const walks = {
	events: {
		path: "/users/sample-user/events/public", alias: "/user/1001/events/public", selection: "per_page=100",
		rows: (page: number) => [{ ...event, id: `${page}-a` }, { ...event, id: `${page}-b` }],
		html: owner,
	},
	starred: {
		path: "/users/sample-user/starred", alias: "/user/1001/starred", selection: "per_page=100",
		rows: (page: number) => [`r${page}a`, `r${page}b`].map(name => ({ full_name: `sample-user/${name}`, html_url: `https://github.com/sample-user/${name}` })),
		// Browser rows without a counter or pagination need the REST enumeration.
		html: owner + `<ul id="user-starred-repos">${["r1a", "r1b", "r2a", "r2b"].map(name => `<li><h3><a href="/sample-user/${name}">${name}</a></h3></li>`).join("")}</ul>`,
	},
	history: {
		path: "/search/issues", alias: "/search/issues", selection: "q=author%3Asample-user+type%3Aissue&sort=created&order=desc&per_page=100",
		rows: (page: number) => ({ total_count: 4, incomplete_results: false,
			items: [1, 2].map(i => ({ ...issue, id: page * 10 + i, number: page * 10 + i })) }),
		html: owner,
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
		const result = await collect(walk, api(walk, s => `<${API}${s.alias}?${s.selection}&page=2>; rel="next", <${API}${s.alias}?${s.selection}&page=2>; rel="last"`), spec.html);
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
			const result = await collect(walk, api(walk, next), spec.html);
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
			const result = await collect(walk, api(walk, () => link), spec.html);
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
				: { link: "unreadable", data: spec.rows(2) }, spec.html);
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
