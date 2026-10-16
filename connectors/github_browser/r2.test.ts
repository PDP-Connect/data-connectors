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
 assert.equal(result.records.length, 0);
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
test("profile Loading counts cannot become a destructive zero snapshot", async () => {
 const html = (await fixture("profile.html")).replace("<span>42</span>", "<span>Loading</span>");
 const result = await collect(["profile"], { openPage: async (url) => page(url, html) });
 assert.equal(result.records.length, 0);
 assert.equal(result.state.profile, undefined);
 assert.equal(result.messages.some(({ type }) => type === "STATE" || type === "DETAIL_COVERAGE"), false);
});
test("profile is read through the loader that waits for the late contribution heading", async () => {
 const shell = (await fixture("profile-current-github.html")).replace(/<h2 id="js-contribution-activity-description"[\s\S]*?<\/h2>/u, "");
 const loaded: string[] = [];
 const result = await collect(["profile"], {
  openPage: async (url) => page(url, url === "https://github.com/" ? owner : shell),
  openContributionPage: async (url) => { loaded.push(url); return page(url, owner + shell.replace("</main>", '<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">1,234 contributions in the last year</h2></main>')); },
 });
 assert.deepEqual(loaded, ["https://github.com/sample-user"]);
});
