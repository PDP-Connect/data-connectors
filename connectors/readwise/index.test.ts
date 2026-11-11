import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectReadwise } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const fixture = JSON.parse(
	readFileSync(
		new URL("./fixtures/synthetic-export.json", import.meta.url),
		"utf8",
	),
);
const listing = {
	count: 1,
	next: null,
	results: [
		{
			id: 11,
			num_highlights: 1,
			title: "Synthetic Book",
			source: "kindle",
			category: "books",
		},
	],
};
function harness(responses: unknown[]) {
	const records: unknown[] = [];
	const messages: unknown[] = [];
	const urls: URL[] = [];
	const ctx = {
		requested: new Map([["kindle_highlights", {}]]),
		credentials: { READWISE_API_TOKEN: "synthetic-token" },
		emittedAt: "2026-01-02T00:00:00Z",
		state: {},
		progress: async () => {},
		emit: async (m: unknown) => {
			messages.push(m);
		},
		emitRecord: async (s: string, r: Record<string, unknown>) => {
			assert.equal(validateRecord(s, r).ok, true);
			records.push(r);
		},
	} as unknown as CollectContext;
	const deps = {
		pause: async () => {},
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			urls.push(url);
			assert.equal(init?.redirect, "error");
			assert.equal(
				new Headers(init?.headers).get("Authorization"),
				"Token synthetic-token",
			);
			const body = responses.shift();
			if (body instanceof Response) return body;
			if (!body) throw new Error("unexpected_request");
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch,
	};
	return { ctx, deps, records, messages, urls };
}
test("selects Kindle book ids, preserves text/null dates and completes snapshot", async () => {
	const h = harness([listing, fixture]);
	await collectReadwise(h.ctx, h.deps);
	assert.equal(h.records.length, 1);
	assert.equal(h.messages.length, 1);
	assert.equal(h.urls[0]?.pathname, "/api/v2/books/");
	assert.equal(h.urls[1]?.pathname, "/api/v2/export/");
	assert.equal(h.urls[0]?.searchParams.get("source"), "kindle");
	assert.equal(h.urls[1]?.searchParams.get("ids"), "11");
	assert.equal(h.urls[1]?.searchParams.get("includeDeleted"), "true");
});
test("walks both listing and export pagination", async () => {
	const h = harness([
		{ ...listing, count: 2, next: "https://readwise.io/api/v2/books/?page=2" },
		{ ...listing, count: 2, results: [{ ...listing.results[0], id: 12 }] },
		{ ...fixture, nextPageCursor: "second" },
		{ ...fixture, results: [{ ...fixture.results[0], user_book_id: 12 }] },
	]);
	await collectReadwise(h.ctx, h.deps);
	assert.equal(h.records.length, 2);
	assert.equal(h.urls[3]?.searchParams.get("pageCursor"), "second");
});
test("never forwards token to a foreign pagination origin", async () => {
	const h = harness([
		{ ...listing, next: "https://attacker.invalid/api/v2/books/" },
	]);
	await assert.rejects(collectReadwise(h.ctx, h.deps), /unsafe_pagination/);
	assert.equal(h.urls.length, 1);
	assert.equal(h.messages.length, 0);
});
test("rejects unrelated source data and does not checkpoint", async () => {
	const h = harness([
		listing,
		{ ...fixture, results: [{ ...fixture.results[0], source: "reader" }] },
	]);
	await assert.rejects(collectReadwise(h.ctx, h.deps), /scope_mismatch/);
	assert.equal(h.messages.length, 0);
});
test("failed later page retains no successful checkpoint; no retry", async () => {
	const h = harness([
		listing,
		{ ...fixture, nextPageCursor: "second" },
		new Response("denied", { status: 403 }),
	]);
	await assert.rejects(collectReadwise(h.ctx, h.deps), /access_denied/);
	assert.equal(h.records.length, 1);
	assert.equal(h.messages.length, 0);
	assert.equal(h.urls.length, 3);
});
test("repeated cursor fails boundedly", async () => {
	const h = harness([
		listing,
		{ ...fixture, nextPageCursor: "same" },
		{ ...fixture, nextPageCursor: "same" },
	]);
	await assert.rejects(collectReadwise(h.ctx, h.deps), /pagination_cycle/);
	assert.equal(h.messages.length, 0);
});
test("malformed provider highlight fails rather than silently disappearing", async () => {
	const bad = structuredClone(fixture);
	bad.results[0].highlights[0].text = null;
	const h = harness([listing, bad]);
	await assert.rejects(collectReadwise(h.ctx, h.deps));
	assert.equal(h.messages.length, 0);
	assert.equal(h.records.length, 0);
});
test("snapshot replay keeps stable highlight identities", async () => {
	const a = harness([listing, fixture]);
	const b = harness([listing, fixture]);
	await collectReadwise(a.ctx, a.deps);
	await collectReadwise(b.ctx, b.deps);
	assert.deepEqual(a.records, b.records);
});

test("refuses a truncated export even when pagination says complete", async () => {
	const h = harness([listing, { ...fixture, results: [] }]);
	await assert.rejects(
		collectReadwise(h.ctx, h.deps),
		/incomplete_highlight_export/,
	);
	assert.equal(h.messages.length, 0);
});

test("accepts numeric export cursors including zero and forwards them as strings", async () => {
	await Promise.all(
		[0, 12345].map(async (cursor) => {
			const h = harness([
				listing,
				{ ...fixture, results: [], nextPageCursor: cursor },
				fixture,
			]);
			await collectReadwise(h.ctx, h.deps);
			assert.equal(h.urls[2]?.searchParams.get("pageCursor"), String(cursor));
			assert.equal(h.records.length, 1);
			assert.equal(h.messages.length, 1);
		}),
	);
});
