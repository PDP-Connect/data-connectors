// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectInventoryEnd, inspectProfilePage } from "./page-evidence.ts";
import type { BrowserServices } from "./types.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });
const fixture = async (name: string) => readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8");
async function collect(streams: string[], overrides: Partial<BrowserServices> = {}) {
 const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
 const messages: Array<{ type: string; stream?: string }> = [];
 const state: Record<string, unknown> = {};
 await collectGitHubBrowser({
  emit: async (message) => { messages.push(message); },
  emitRecord: async (stream, data) => { records.push({ stream, data }); },
  progress: async () => {}, requested: new Set(streams), state,
 }, {
  openPage: async (url) => page(url, owner),
  fetchPublicJson: async (url) => ({ requestedUrl: url, responseUrl: url, status: 200, data: [] }),
  now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {}, ...overrides,
 });
 return { records, messages, state };
}
test("homepage meta-only signed-in dashboard remains compatible with main", async () => {
 const result = await collect(["events"], {
  openPage: async (url) => page(url, '<meta name="user-login" content="sample-user">'),
 });
 assert.equal(result.records.length, 1);
 assert.equal(result.records[0]?.data.id, "sample-user:events");
 assert.deepEqual(result.records[0]?.data.events, []);
 assert.ok(result.messages.some((message) => message.type === "STATE"));
});
test("profile blocking evidence vetoes intact owner chrome", async () => {
 const url = "https://github.com/sample-user";
 const html = await fixture("profile.html");
 assert.equal(inspectProfilePage(page(url, html + "<main>Rate limit exceeded</main>"), "sample-user", url), false);
});
test("inventory continuation cannot change selection or duplicate parameters", () => {
 for (const suffix of ["&q=demo", "&type=public", "&tab=stars", "&page=3", "&after=", "&after=a&after=b"]) {
  const url = "https://github.com/sample-user?page=1&tab=repositories";
  const result = inspectInventoryEnd({
   page: page(url, owner), username: "sample-user", stream: "repositories",
   pageNumber: 1, parsedRows: 1, rejectedRows: 0, noProgress: false,
   explicitEmpty: false, hasRecognizedList: true,
   nextUrl: "https://github.com/sample-user?page=2&tab=repositories" + suffix,
  });
  assert.equal(result.nextUrl, null, suffix);
  assert.equal(result.complete, false, suffix);
 }
});
test("300 events remain one legacy snapshot without completion at the cap", async () => {
 const source = JSON.parse(await fixture("events.json"))[0];
 let calls = 0;
 const result = await collect(["events"], {
  fetchPublicJson: async (url) => ({
   requestedUrl: url, responseUrl: url, status: 200,
   data: Array.from({ length: 100 }, (_, index) => ({ ...source, id: `${calls++}-${index}` })),
  }),
 });
 assert.equal(result.records.length, 1);
 assert.equal(result.records[0]?.data.id, "sample-user:events");
 assert.equal((result.records[0]?.data.events as unknown[]).length, 300);
 assert.equal(result.state.events, undefined);
 assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
});
test("900 of 1000 history rows never acquire completion at an empty tenth page", async () => {
 const source = JSON.parse(await fixture("history-issue.json")).items[0];
 let issuePage = 0;
 const result = await collect(["history"], {
  fetchPublicJson: async (url) => {
   const isPr = url.includes("type%3Apr");
   const pageNumber = isPr ? 0 : ++issuePage;
   return { requestedUrl: url, responseUrl: url, status: 200, data: {
    items: isPr || pageNumber === 10 ? [] : Array.from({ length: 100 }, (_, index) => ({
     ...source, id: pageNumber * 100 + index, number: pageNumber * 100 + index,
    })), total_count: isPr ? 0 : 1000, incomplete_results: false,
   } };
  },
 });
 assert.equal(issuePage, 10);
 assert.equal(result.records.length, 1);
 assert.equal(result.records[0]?.data.id, "sample-user:history");
 assert.equal((result.records[0]?.data.issues as unknown[]).length, 900);
 assert.equal(result.state.history, undefined);
 assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
});

test("contribution blocker vetoes intact calendar cells before admitting rows", async () => {
 const calendar = (start: string, end: string) => {
  let html = owner + '<main>Rate limit exceeded</main><h2 class="f4 text-normal mb-2">0 contributions</h2>';
  for (let date = new Date(start + "T00:00:00Z"); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1))
   html += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="0" data-level="0"></td>`;
  return html;
 };
 const result = await collect(["contributions"], {
  openContributionPage: async (url) => {
   const year = Number(/from=(\d{4})/u.exec(url)?.[1] ?? 2026);
   return page(url, year === 2026 ? calendar("2025-01-02", "2026-01-01") : calendar(`${year}-01-01`, `${year}-12-31`));
  },
 });
 assert.equal(result.records.length, 0);
 assert.equal(result.state.contributions, undefined);
 assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
});

test("unreadable API fields are retained only as a partial legacy aggregate", async () => {
 for (const stream of ["history", "events"]) {
  const result = await collect([stream], {
   fetchPublicJson: async (url) => ({
    requestedUrl: url, responseUrl: url, status: 200,
    data: stream === "events"
     ? [{ id: "10", type: "PushEvent", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" } }]
     : { items: url.includes("type%3Apr") ? [] : [{ id: 10, number: 2, repository_url: "https://api.github.com/repos/sample-user/demo" }], total_count: url.includes("type%3Apr") ? 0 : 1, incomplete_results: false },
   }),
  });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0]?.data.id, `sample-user:${stream}`);
  const items = result.records[0]?.data[stream === "events" ? "events" : "issues"] as Record<string, unknown>[];
  assert.equal(items.length, 1);
  assert.equal(items[0]?.[stream === "events" ? "isPublic" : "comments"], undefined);
  assert.equal(result.state[stream], undefined);
  assert.equal(result.messages.some(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE"), false);
  assert.ok(result.messages.some(({ type }) => type === "SKIP_RESULT"));
 }
});
test("profile Loading counts cannot become a destructive zero snapshot", async () => {
 const html = (await fixture("profile.html")).replace("<span>42</span>", "<span>Loading</span>");
 const result = await collect(["profile"], { openPage: async (url) => page(url, html) });
 assert.equal(result.records.length, 1);
 assert.equal(result.records[0]?.data.id, "sample-user:profile");
 assert.equal(result.records[0]?.data.followers, undefined);
 assert.equal(result.state.profile, undefined);
 assert.equal(result.messages.some(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE"), false);
});
