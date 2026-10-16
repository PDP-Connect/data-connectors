// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { parseContributionHtml } from "./parsers.ts";
import { fullInventoryCoverage } from "./inventory-coverage.ts";
import type { BrowserServices } from "./types.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });
const fixture = (name: string) => readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8");
const terminal = '<div class="paginate-container"><span class="next_page" aria-disabled="true">Next</span></div>';
async function run(stream: string, overrides: Partial<BrowserServices>) {
 const records: Record<string, unknown>[] = [];
 const messages: Array<Record<string, unknown>> = [];
 const prior = { fetched_at: "2020-01-01" };
 const state: Record<string, unknown> = { [stream]: prior };
 await collectGitHubBrowser({
  emit: async message => { messages.push(message as unknown as Record<string, unknown>); },
  emitRecord: async (_stream, record) => { records.push(record); },
  progress: async () => {}, requested: new Set([stream]), state,
 }, {
  now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
  openPage: async url => page(url, owner),
  fetchPublicJson: async url => ({ requestedUrl: url, responseUrl: url, status: 200, data: [] }),
  ...overrides,
 });
 return { records, messages, state, prior };
}
function assertIncomplete(result: Awaited<ReturnType<typeof run>>, stream: string) {
 assert.deepEqual(result.records, [], "an incomplete aggregate must preserve the prior snapshot");
 assert.equal(result.state[stream], result.prior);
 assert.equal(result.messages.some(m => m.type === "STATE" || m.type === "DETAIL_COVERAGE" || m.op === "delete"), false);
 const skip = result.messages.find(m => m.type === "SKIP_RESULT");
 assert.equal(skip?.reason, "inventory_not_proven_complete");
 assert.deepEqual(skip?.recovery_hint, { action: "retry_by_runtime", retryable: true });
}
for (const stream of ["repositories", "starred"] as const) {
 const tab = stream === "repositories" ? "repositories" : "stars";
 const list = stream === "repositories" ? "user-repositories-list" : "user-starred-repos";
 const rows = `<div id="${list}"><ul><li><h3><a href="/sample-user/demo">demo</a></h3><span class="Label">Public</span><relative-time datetime="2026-01-01T00:00:00Z"></relative-time></li></ul></div>`;
 const count = (value: string) => `<a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">${value}</span></a>`;
 for (const [label, evidence, complete] of [
  ["exact total", count("1"), true],
  ["mismatched total", count("2") + terminal, false],
  ["no evidence", "", false],
  ["abbreviated total", count("1.2k"), false],
  ["explicit disabled next", terminal, true],
  ["pagination without next", '<div class="pagination"><span class="current">1</span></div>', true],
  ["empty layout is not an end", '<div class="blankslate">Empty</div>', false],
 ] as const) {
  test(`${stream}: ${label}`, async () => {
   const result = await run(stream, { openPage: async url => page(url, owner + rows + evidence) });
   if (!complete) { assertIncomplete(result, stream); return; }
   assert.equal(result.records.length, 1);
   assert.equal(result.records[0]?.id, `sample-user:${stream}`);
   assert.equal((result.records[0]?.[stream] as unknown[]).length, 1);
   assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE"));
  });
 }
 test(`${stream}: cumulative total counts distinct items across pages`, async () => {
  const urls: string[] = [];
  const result = await run(stream, { openPage: async url => {
   if (url === "https://github.com/") return page(url, owner);
   urls.push(url);
   const second = new URL(url).searchParams.get("page") === "2";
   return page(url, owner + (second ? rows.replaceAll("demo", "other") : rows) + count("2") +
    (second ? "" : `<div class="pagination"><a rel="next" href="/sample-user?page=2&tab=${tab}">Next</a></div>`));
  } });
  assert.equal(urls.length, 2);
  assert.equal(result.records.length, 1);
  assert.equal((result.records[0]?.[stream] as unknown[]).length, 2);
 });
 test(`${stream}: layout diagnostics do not veto a source total`, async () => {
  const result = await run(stream, { openPage: async url => page(url,
   owner + rows + count("1") + '<main>Rate limit exceeded</main><div>Unknown text</div><include-fragment></include-fragment>') });
  assert.equal(result.records.length, 1);
 });
 test(`${stream}: terminal pagination cannot hide a rejected second entry`, async () => {
  const broken = rows.replace("</ul>", '<li><h3><a href="/missing">Unread entry</a></h3></li></ul>');
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + broken + terminal) }), stream);
 });
 test(`${stream}: terminal pagination cannot certify an absent list`, async () => {
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + terminal) }), stream);
 });
 test(`${stream}: rejected entries on earlier pages remain a veto`, async () => {
  const broken = rows.replace("</ul>", '<li><h3><a href="/missing">Unread entry</a></h3></li></ul>');
  const result = await run(stream, { openPage: async url => page(url, owner +
   (new URL(url).searchParams.get("page") === "2" ? rows.replaceAll("demo", "other") + terminal :
    broken + `<div class="pagination"><a rel="next" href="/sample-user?page=2&tab=${tab}">Next</a></div>`)) });
  assertIncomplete(result, stream);
 });
 test(`${stream}: an earlier unrelated paginator cannot hide the list continuation`, async () => {
  const visits: string[] = [];
  const result = await run(stream, { openPage: async url => {
   visits.push(url);
   return page(url, owner + '<aside><div class="pagination"><span>1</span></div></aside>' + rows +
    (new URL(url).searchParams.get("page") === "2" ? "" :
     `<div class="pagination"><a rel="next" href="/sample-user?page=2&tab=${tab}">Next</a></div>`));
  } });
  assertIncomplete(result, stream);
  assert.ok(visits.some(url => new URL(url).searchParams.get("page") === "2"));
 });
 for (const other of [
  count("1").replaceAll("/sample-user?", "/other-user?"),
  count("1").replace(`tab=${tab}"`, `tab=${tab}&q=partial"`),
  count("1").replace("data-tab-item", "data-unrelated"),
 ]) test(`${stream}: unrelated or filtered counters do not certify the list: ${other}`, async () => {
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + other + rows) }), stream);
 });
 test(`${stream}: conflicting profile counters defeat terminal evidence`, async () => {
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + count("1") + count("2") + rows + terminal) }), stream);
 });
 test(`${stream}: ambiguous list paginators defeat exact counters`, async () => {
  const ambiguous = rows.replace("</ul></div>", `</ul>${terminal}</div>`);
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + count("1") + ambiguous +
   `<div class="pagination"><a rel="next" href="/sample-user?page=2&tab=${tab}">Next</a></div>`) }), stream);
 });
 test(`${stream}: list chrome and best-effort fields do not veto exact totals`, async () => {
  const chrome = rows.replace("</ul></div>", '</ul><div>Sort options</div><span></span><a href="/settings/profile">Settings</a></div>');
  const result = await run(stream, { openPage: async url => page(url, owner + count("1") + chrome) });
  assert.equal(result.records.length, 1);
 });

 test(`${stream}: two adjacent candidate paginators are ambiguous`, async () => {
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + count("1") + rows + terminal +
   `<div class="pagination"><a rel="next" href="/sample-user?page=2&tab=${tab}">Next</a></div>`) }), stream);
 });
 test(`${stream}: foreign pagination links cannot certify the list`, async () => {
  assertIncomplete(await run(stream, { openPage: async url => page(url, owner + rows +
   '<div class="pagination"><a href="/other-user?tab=repositories&page=1">Previous</a></div>') }), stream);
 });
 test(`${stream}: paginator chrome inside the list is not an entry`, async () => {
  const result = await run(stream, { openPage: async url => page(url, owner + rows.replace("</ul></div>",
   '</ul><div class="pagination"><ul><li><span class="next_page disabled">Next</span></li></ul></div></div>')) });
  assert.equal(result.records.length, 1);
 });

}
function calendar(start: string, end: string, evidence: "match" | "mismatch" | "absent") {
 let cells = "";
 for (let date = new Date(start + "T00:00:00Z"); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1))
  cells += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="0" data-level="0"></td>`;
 return owner + (evidence === "absent" ? "" : `<h2 id="js-contribution-activity-description">${evidence === "match" ? 0 : 1} contributions</h2>`) + cells;
}
for (const evidence of ["match", "mismatch", "absent"] as const) {
 test(`contributions: ${evidence} source total`, async () => {
  const result = await run("contributions", { openContributionPage: async url => {
   const year = Number(/from=(\d{4})/u.exec(url)?.[1] ?? 2026);
   return page(url, year === 2026 ? calendar("2025-01-02", "2026-01-01", evidence) : calendar(`${year}-01-01`, `${year}-12-31`, evidence));
  } });
  if (evidence !== "match") assertIncomplete(result, "contributions");
  else { assert.equal(result.records.length, 1); assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE")); }
 });
 test(`history: ${evidence} source total`, async () => {
  const source = JSON.parse(await fixture("history-issue.json")).items[0];
  const result = await run("history", { fetchPublicJson: async url => {
   const pr = url.includes("type%3Apr");
   return { requestedUrl: url, responseUrl: url, status: 200, data: {
    items: pr ? [] : [source], incomplete_results: false,
    ...(evidence === "absent" ? {} : { total_count: pr ? 0 : evidence === "match" ? 1 : 2 }),
   } };
  } });
  if (evidence !== "match") assertIncomplete(result, "history");
  else { assert.equal(result.records.length, 1); assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE")); }
 });
}
// Singleton presence never certifies embedded lists, regardless of counters.
for (const count of ["8", "999", "1.2k"]) {
 test(`profile: unrelated counter ${count} cannot certify embedded lists`, async () => {
  const html = (await fixture("profile-current-github.html")).replace(">8<", `>${count}<`);
  const result = await run("profile", { openPage: async url => page(url, html) });
  assert.equal(result.records.length, 1);
  assert.equal(result.messages.some(m => m.type === "DETAIL_COVERAGE" || m.op === "delete"), false);
 });
}
for (const length of [1, 100]) {
 test(`events: REST page length ${length} is not source end evidence`, async () => {
  const event = JSON.parse(await fixture("events.json"))[0];
  assertIncomplete(await run("events", { fetchPublicJson: async url => ({
   requestedUrl: url, responseUrl: url, status: 200,
   data: Array.from({length}, (_, i) => ({ ...event, id: `${url}-${i}` })),
  }) }), "events");
 });
}
test("contribution abbreviated header is not an exact total", () => {
 assert.equal(parseContributionHtml('<h2 id="js-contribution-activity-description">1.2k contributions</h2>').complete, false);
});
test("source helper rejects incomplete or inconsistent enumerations", () => {
 for (const enumeration of [
  { kind: "enumerated" as const, complete: false, considered: 1, covered: 1 },
  { kind: "enumerated" as const, complete: true, considered: 2, covered: 1 },
 ]) assert.equal(fullInventoryCoverage("test", enumeration).type, "SKIP_RESULT");
 assert.equal(fullInventoryCoverage("test", {kind: "enumerated", complete: true, considered: 0, covered: 0}).type, "DETAIL_COVERAGE");
});

test("contribution source totals are independent of loading layout diagnostics", () => {
 const html = '<h2 id="js-contribution-activity-description" aria-busy="true">3 contributions</h2><td class="ContributionCalendar-day" data-date="2026-01-01" data-count="3" data-level="2"></td>';
 assert.equal(parseContributionHtml(html).complete, true);
});
