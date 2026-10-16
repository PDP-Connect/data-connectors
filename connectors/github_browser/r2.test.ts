// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { collectGitHubBrowser } from "./collector.ts";
import { parseProfilePage } from "./parsers.ts";
import { inspectInventoryEnd } from "./page-evidence.ts";
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
 assert.equal((result.records[0]?.data.events as unknown[]).length, 0);
});
test("inventory continuation cannot change selection or duplicate parameters", () => {
 for (const suffix of ["&q=demo", "&type=public", "&tab=stars", "&page=3", "&after=", "&after=a&after=b"]) {
  const url = "https://github.com/sample-user?page=1&tab=repositories";
  const result = inspectInventoryEnd({
   page: page(url, owner), username: "sample-user", stream: "repositories",
   pageNumber: 1, parsedRows: 1, rejectedRows: 0, noProgress: false,
   explicitEmpty: false, hasRecognizedList: true, renderComplete: true, hasUnknownContinuation: false, terminalProof: null,
   nextUrl: "https://github.com/sample-user?page=2&tab=repositories" + suffix,
  });
  assert.equal(result.nextUrl, null, suffix);
  assert.equal(result.complete, false, suffix);
 }
});
test("300 events withhold the legacy snapshot without completion at the cap", async () => {
 const source = JSON.parse(await fixture("events.json"))[0];
 let calls = 0;
 const result = await collect(["events"], {
  fetchPublicJson: async (url) => ({
   requestedUrl: url, responseUrl: url, status: 200,
   data: Array.from({ length: 100 }, (_, index) => ({ ...source, id: `${calls++}-${index}` })),
  }),
 });
 assert.equal(result.records.length, 0);
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
 assert.equal(result.records.length, 0);
 assert.equal(result.state.history, undefined);
 assert.ok(result.messages.some((message) => message.type === "SKIP_RESULT"));
});


test("unreadable API fields never replace a complete aggregate", async () => {
 for (const stream of ["history", "events"]) {
  const result = await collect([stream], {
   fetchPublicJson: async (url) => ({
    requestedUrl: url, responseUrl: url, status: 200,
    data: stream === "events"
     ? [{ id: "10", type: "PushEvent", created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" } }]
     : { items: url.includes("type%3Apr") ? [] : [{ id: 10, number: 2, repository_url: "https://api.github.com/repos/sample-user/demo" }], total_count: url.includes("type%3Apr") ? 0 : 1, incomplete_results: false },
   }),
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.state[stream], undefined);
  assert.equal(result.messages.some(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE"), false);
  assert.ok(result.messages.some(({ type }) => type === "SKIP_RESULT"));
 }
});
test("profile Loading counts are omitted from its singleton snapshot", async () => {
 const html = (await fixture("profile.html")).replace("<span>42</span>", "<span>Loading</span>");
 const result = await collect(["profile"], { openPage: async (url) => page(url, html) });
 assert.equal(result.records.length, 1);
 assert.equal("followers" in (result.records[0]?.data ?? {}), false);
 assert.equal(result.messages.some(({ type }) => type === "DETAIL_COVERAGE"), false);
});
test("profile is read through the loader that waits for the late contribution heading", async () => {
 const shell = (await fixture("profile-current-github.html")).replace(/<h2 id="js-contribution-activity-description"[\s\S]*?<\/h2>/u, "");
 const loaded: string[] = [];
 const result = await collect(["profile"], {
  openPage: async (url) => page(url, url === "https://github.com/" ? owner : shell),
  openContributionPage: async (url) => { loaded.push(url); return page(url, owner + shell.replace("</main>", '<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">1,234 contributions in the last year</h2></main>')); },
 });
 assert.deepEqual(loaded, ["https://github.com/sample-user"]);
 assert.equal(result.records.length, 1);
});

test("profile partial embedded lists still emit singleton presence without inventory authority", async () => {
 const html = (await fixture("profile-current-github.html")) + '<div><h2>Organizations</h2><ul><li></li></ul></div>';
 assert.equal(parseProfilePage(html, "https://github.com/sample-user").complete, false);
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(result.records.length, 1);
 assert.equal(result.records[0]?.data.id, "sample-user:profile");
 assert.equal(result.messages.some(m => m.type === "DETAIL_COVERAGE"), false);
});

for (const link of [null, '<https://api.github.com/example?page=1>; rel="prev"']) {
 test(`events finish on an observed source-end Link: ${link}`, async () => {
  const event = JSON.parse(await fixture("events.json"))[0];
  let calls = 0;
  const result = await collect(["events"], { fetchPublicJson: async url => {
   calls += 1;
   return { requestedUrl: url, responseUrl: url, status: 200, link, data: [event] };
  } });
  assert.equal(calls, 1);
  assert.equal(result.records.length, 1);
  assert.match(String(result.records[0]?.data.windowDescription), /300.*90 days/);
  assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE"));
 });
}
test("events follow short pages while rel=next remains and withhold unread continuation", async () => {
 const event = JSON.parse(await fixture("events.json"))[0];
 let calls = 0;
 const result = await collect(["events"], { fetchPublicJson: async url => {
  calls += 1;
  return { requestedUrl: url, responseUrl: url, status: 200,
   link: `<https://api.github.com/users/sample-user/events/public?per_page=100&page=${calls + 1}>; rel="next"`,
   data: [{ ...event, id: String(calls) }] };
 } });
 assert.equal(calls, 3);
 assert.equal(result.records.length, 0);
 assert.equal(result.state.events, undefined);
 assert.ok(result.messages.some(m => m.type === "SKIP_RESULT"));
});
test("events complete on an empty page without relying on short-page length", async () => {
 const result = await collect(["events"]);
 assert.equal(result.records.length, 1);
 assert.deepEqual(result.records[0]?.data.events, []);
});
for (const end of ["link", "cap", "unread"] as const) {
 test(`history above 1000 respects documented window: ${end}`, async () => {
  const source = JSON.parse(await fixture("history-issue.json")).items[0];
  let calls = 0;
  const result = await collect(["history"], { fetchPublicJson: async url => {
   const pr = url.includes("type%3Apr");
   const pageNumber = pr ? 0 : ++calls;
   const last = end === "link" ? 2 : 10;
   const size = end === "unread" ? 1 : 100;
   return { requestedUrl: url, responseUrl: url, status: 200,
    link: end === "cap" ? undefined : pr || pageNumber === last && end === "link" ? null : '<https://api.github.com/search/issues?page=99>; rel="next"',
    data: { total_count: pr ? 0 : 1500, incomplete_results: false,
     items: pr ? [] : Array.from({ length: size }, (_, i) => ({ ...source, id: pageNumber * 100 + i, number: pageNumber * 100 + i })) } };
  } });
  assert.equal(calls, end === "link" ? 2 : 10);
  assert.equal(result.records.length, end === "unread" ? 0 : 1);
  if (end !== "unread") {
   assert.equal((result.records[0]?.data.issues as unknown[]).length, end === "link" ? 200 : 1000);
   assert.match(String(result.records[0]?.data.windowDescription), /1,000 items per type/);
   assert.ok(result.messages.some(m => m.type === "DETAIL_COVERAGE"));
  } else assert.equal(result.state.history, undefined);
 });
}

test("PageShim fixtures prove all six snapshots without relaxing omitted-stream regressions", async () => {
 const fixtureModule = "../../scripts/pageshim/fixtures/github_browser.mjs";
 const { resolveFixture, pageshimCase } = await import(fixtureModule);
 const result = await collect(["profile", "repositories", "starred", "events", "contributions", "history"], {
  now: () => new Date(),
  openPage: async url => page(url, resolveFixture(url).body),
  fetchPublicJson: async url => {
   const response = resolveFixture(url);
   return { requestedUrl: url, responseUrl: url, status: response.status,
    link: response.headers?.Link ?? null, data: JSON.parse(response.body) };
  },
 });
 assert.deepEqual(result.records.map(r => r.stream).sort(),
  ["contributions", "events", "history", "profile", "repositories", "starred"]);
 assert.equal(result.messages.some(m => m.type === "SKIP_RESULT"), false);
 const contributions = result.records.find(r => r.stream === "contributions");
 assert.equal(contributions?.data.totalContributionsLastYear, pageshimCase.exportSummary.details.contributions);
 assert.equal(result.messages.filter(m => m.type === "DETAIL_COVERAGE").length, 5);
});
