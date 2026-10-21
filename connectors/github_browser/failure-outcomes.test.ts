// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import type { BrowserCollectionPort } from "./collector.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { BrowserServices } from "./types.ts";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8"));
const secret = "Bearer private-token https://example.test/?token=secret";
const prior = { fetched_at: "2025-12-01T00:00:00Z" };
async function collect(fetchPublicJson: BrowserServices["fetchPublicJson"], overrides: Partial<BrowserCollectionPort> = {}, stream = "history") {
 const messages: EmittedMessage[] = [];
 const records: unknown[] = [];
 const state = { [stream]: prior };
 await collectGitHubBrowser({
  requested: new Set([stream]), state, progress: async () => {},
  emit: async message => { messages.push(message); },
  emitRecord: async (_stream, data) => { records.push(data); }, ...overrides,
 }, {
  openPage: async url => ({ requestedUrl: url, currentUrl: url, html: '<meta name="user-login" content="sample-user">' }),
  fetchPublicJson, sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
 });
 return { messages, records, state };
}
const response = (url: string, data: unknown, extra = {}) => ({ requestedUrl: url, responseUrl: url, status: 200, data, ...extra });
const body = (items: unknown[] = [], total_count = items.length) => ({ items, total_count, incomplete_results: false });
function failure(result: Awaited<ReturnType<typeof collect>>) {
 const skip = result.messages.find(message => message.type === "SKIP_RESULT");
 assert.ok(skip?.type === "SKIP_RESULT");
 assert.equal(JSON.stringify(result.messages).includes(secret), false);
 return skip.diagnostics as Record<string, unknown>;
}

for (const [cause, change] of [
 ["http_rate_limited", { status: 429 }],
 ["http_status_failed", { status: 503 }],
 ["wrong_navigation", { responseUrl: "https://github.com/login" }],
 ["search_incomplete_results", { data: { ...body(), incomplete_results: true } }],
 ["malformed_search_response", { data: { items: [] } }],
] as const) {
 test(`history retains safe source cause: ${cause}`, async () => {
  const result = await collect(async url => response(url, body(), url.includes("type%3Apr") ? {} : change));
  assert.deepEqual(result.records, []);
  assert.equal(result.state.history, prior);
  assert.equal(failure(result).cause, cause);
  assert.equal(failure(result).origin, "source");
  if ("status" in change) assert.equal(failure(result).status, change.status);
 });
}
for (const cause of ["source_request_failed", "total_drift", "malformed_rows", "duplicate_rows", "end_not_proven"] as const) {
 test(`history preserves counts after prior page: ${cause}`, async () => {
  const item = (await fixture("history-issue.json")).items[0];
  let calls = 0;
  const result = await collect(async url => {
   if (url.includes("type%3Apr")) return response(url, body());
   if (++calls === 1) return response(url, body([item], 3));
   if (cause === "source_request_failed") throw new Error(secret);
   if (cause === "total_drift") return response(url, body([], 4));
   if (cause === "malformed_rows") return response(url, body([{}], 3));
   if (cause === "duplicate_rows") return response(url, body([item], 3));
   return response(url, body([], 3), { link: null });
  });
  const diagnostics = failure(result);
  assert.equal(diagnostics.cause, cause);
  assert.equal(diagnostics.origin, "source");
  assert.deepEqual(diagnostics.enumeration, { kind: "enumerated", complete: false, considered: 3, covered: 1 });
  assert.deepEqual(result.records, []);
  assert.equal(result.state.history, prior);
 });
}
for (const stream of ["history", "events", "profile"]) {
 for (const operation of ["record", "state"] as const) {
  test(`${stream} ${operation} sink failure preserves checkpoint and origin`, async () => {
   const messages: EmittedMessage[] = [];
   const profile = await readFile(new URL("./__fixtures__/synthetic/profile.html", import.meta.url), "utf8");
   // The profile read needs fixture HTML; keep the same port setup for every stream.
   const state = { [stream]: prior };
   await collectGitHubBrowser({
    requested: new Set([stream]), state, progress: async () => {},
    emitRecord: async () => { if (operation === "record") throw new Error(secret); },
    emit: async message => { if (operation === "state" && message.type === "STATE") throw new Error(secret); messages.push(message); },
   }, {
    openPage: async url => ({ requestedUrl: url, currentUrl: url, html: url.endsWith("/") ? '<meta name="user-login" content="sample-user">' : profile }),
    fetchPublicJson: async url => response(url, stream === "events" ? [] : body(), { link: null }),
    sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
   });
   const diagnostics = failure({ messages, records: [], state });
   assert.equal(diagnostics.origin, "sink");
   assert.equal(diagnostics.cause, operation === "record" ? "record_emit_failed" : "state_emit_failed");
   assert.equal(state[stream], prior);
   assert.equal(messages.some(message => message.type === "STATE" || message.type === "DETAIL_COVERAGE"), false);
  });
 }
}
test("diagnostic sink failure propagates safely instead of becoming a source failure", async () => {
 await assert.rejects(collect(async () => { throw new Error(secret); }, {
  emit: async () => { throw new Error(secret); },
 }), error => {
  assert.equal(JSON.stringify(error).includes(secret), false);
  assert.equal((error as { failure?: { origin: string; cause: string } }).failure?.origin, "sink");
  assert.equal((error as { failure?: { cause: string } }).failure?.cause, "message_emit_failed");
  return true;
 });
});

test("history stops requesting search types after the first failed type", async () => {
 let calls = 0;
 const result = await collect(async url => { calls += 1; return response(url, body(), { status: 429 }); });
 assert.equal(calls, 1);
 assert.equal(failure(result).cause, "http_rate_limited");
});

test("events keep the HTTP rate-limit cause instead of reporting an unproven end", async () => {
 const result = await collect(async url => response(url, [], { status: 429 }), {}, "events");
 assert.equal(failure(result).cause, "http_rate_limited");
 assert.equal(failure(result).status, 429);
});

test("starred REST fallback keeps the HTTP rate-limit cause", async () => {
 const messages: EmittedMessage[] = [];
 await collectGitHubBrowser({
  requested: new Set(["starred"]), state: {}, progress: async () => {},
  emit: async message => { messages.push(message); }, emitRecord: async () => { assert.fail("must withhold"); },
 }, {
  openPage: async url => ({ requestedUrl: url, currentUrl: url, html: '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><ul id="user-starred-repos"></ul>' }),
  fetchPublicJson: async url => response(url, [], { status: 429 }),
  sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"),
 });
 const skip = messages.find(message => message.type === "SKIP_RESULT");
 assert.ok(skip?.type === "SKIP_RESULT");
 assert.equal((skip.diagnostics as { cause?: string }).cause, "http_rate_limited");
});
