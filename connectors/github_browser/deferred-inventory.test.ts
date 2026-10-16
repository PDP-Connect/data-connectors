// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectInventoryPage, parseRepositoriesPage, parseStarredPage } from "./parsers.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const terminal = '<div class="paginate-container"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });

for (const stream of ["repositories", "starred"] as const) {
 const tab = stream === "repositories" ? "repositories" : "stars";
 const list = stream === "repositories" ? "user-repositories-list" : "user-starred-repos";
 const parse = stream === "repositories" ? parseRepositoriesPage : parseStarredPage;
 const wrap = (body: string) => `<div id="${list}">${body}</div>`;
 const count = (value: string) => `<a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">${value}</span></a>`;
 const row = (name: string) => `<ul><li><h3><a href="/sample-user/${name}">${name}</a></h3><span class="Label">Public</span><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></li></ul>`;
 const next = `<div class="pagination"><a rel="next" href="/sample-user?tab=${tab}&page=2">Next</a></div>`;
 async function run(html: (url: string) => string) {
  const prior = { fetched_at: "2020-01-01" };
  const state: Record<string, unknown> = { [stream]: prior };
  const priorSnapshot = { id: `sample-user:${stream}`, [stream]: [{ url: "https://github.com/sample-user/prior" }] };
  let snapshot: Record<string, unknown> = priorSnapshot;
  const records: Record<string, unknown>[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const visits: string[] = [];
  await collectGitHubBrowser({
   state, requested: new Set([stream]), progress: async () => {},
   emitRecord: async (_stream, record) => { records.push(record); snapshot = record; },
   emit: async message => { messages.push(message as unknown as Record<string, unknown>); },
  }, {
   openPage: async url => { if (url !== "https://github.com/") visits.push(url); return page(url, url === "https://github.com/" ? owner : html(url)); },
   fetchPublicJson: async () => { throw new Error("Unexpected REST fallback"); },
   now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
  });
  return { prior, state, priorSnapshot, snapshot, records, messages, visits };
 }
 function incomplete(result: Awaited<ReturnType<typeof run>>) {
  assert.deepEqual(result.records, []);
  assert.equal(result.snapshot, result.priorSnapshot, "preserve the nonempty previous snapshot");
  assert.equal(result.state[stream], result.prior);
  assert.equal(result.messages.some(m => ["RECORD", "STATE", "DETAIL_COVERAGE"].includes(String(m.type))), false);
  assert.ok(result.messages.some(m => m.type === "SKIP_RESULT"));
 }
 for (const marker of [
  `<include-fragment src="/sample-user?tab=${tab}"></include-fragment>`,
  '<div aria-busy="true">Loading</div>',
 ]) {
  test(`${stream}: deferred actual list cannot replace a nonempty snapshot: ${marker}`, async () => {
   const html = owner + wrap(marker) + terminal;
   incomplete(await run(() => html));
   assert.equal(parse(html).entriesComplete, false);
   const proof = inspectInventoryPage(page(`https://github.com/sample-user?tab=${tab}&page=1`, html), stream, "sample-user", 1, 0, 0);
   assert.equal(proof.complete, false);
   assert.equal(proof.reason, "render_incomplete");
  });
 }
 test(`${stream}: deferred list defeats an exact zero counter too`, async () => {
  incomplete(await run(() => owner + count("0") + wrap('<include-fragment></include-fragment>') + terminal));
 });
 test(`${stream}: overlay loading remains unrelated to the actual inventory`, async () => {
  const result = await run(() => owner + wrap(row("demo") + '<dialog><include-fragment aria-busy="true">Loading</include-fragment></dialog>') + terminal);
  assert.equal(result.records.length, 1);
 });
 test(`${stream}: abbreviated counters permit walking to the terminal page`, async () => {
  const result = await run(url => owner + count("1.2k") + wrap(row(new URL(url).searchParams.get("page") === "2" ? "other" : "demo")) +
   (new URL(url).searchParams.get("page") === "2" ? terminal : next));
  assert.equal(result.visits.length, 2);
  assert.equal(result.records.length, 1);
  assert.equal((result.records[0]?.[stream] as unknown[]).length, 2);
  assert.ok(result.messages.some(m => m.type === "STATE"));
  assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE"));
 });
 test(`${stream}: abbreviated counter with disabled next completes`, async () => {
  const result = await run(() => owner + count("1.2k") + wrap(row("demo")) + terminal);
  assert.equal(result.records.length, 1);
  assert.equal(result.visits.length, 1);
 });
 test(`${stream}: approximate counter does not conflict with an exact total`, async () => {
  const result = await run(() => owner + count("1.2k") + count("1") + wrap(row("demo")));
  assert.equal(result.records.length, 1);
 });
 test(`${stream}: distinct exact totals 3 and 4 remain conflicting`, async () => {
  const html = owner + count("3") + count("4") + wrap(row("demo")) + terminal;
  incomplete(await run(() => html));
  const proof = inspectInventoryPage(page(`https://github.com/sample-user?tab=${tab}&page=1`, html), stream, "sample-user", 1, 1, 0);
  assert.deepEqual(proof.exactTotals, [3, 4]);
  assert.equal(proof.totalConflict, true);
 });
}
