// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { collectGitHubBrowser } from "./collector.ts";
import { githubLink } from "./api-link-fixture.ts";
import { parseProfilePage } from "./parsers.ts";
import { inspectInventoryEnd } from "./page-evidence.ts";
import type { BrowserServices } from "./types.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const page = (url: string, html: string) => ({ requestedUrl: url, currentUrl: url, html });
const fixture = async (name: string) => readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8");
async function collect(streams: string[], overrides: Partial<BrowserServices> = {}, initialState: Record<string, unknown> = {}) {
 const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
 const messages: Array<{ type: string; stream?: string }> = [];
 const state: Record<string, unknown> = structuredClone(initialState);
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
   requestedUrl: url, responseUrl: url, status: 200, link: githubLink(url, true),
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
   return { requestedUrl: url, responseUrl: url, status: 200, link: isPr ? null : githubLink(url, true), data: {
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

test("profile partial embedded lists withhold singleton snapshots", async () => {
 const html = (await fixture("profile-current-github.html")) + '<div><h2>Organizations</h2><ul><li></li></ul></div>';
 assert.equal(parseProfilePage(html, "https://github.com/sample-user").complete, false);
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(result.records.length, 0);
 assert.deepEqual(result.state, {});
 assert.ok(result.messages.some(m => m.type === "SKIP_RESULT"));
 assert.equal(result.messages.some(m => m.type === "DETAIL_COVERAGE"), false);
});

for (const pages of [1, 2]) {
 test(`events finish on an observed source-end Link after ${pages} page(s)`, async () => {
  const event = JSON.parse(await fixture("events.json"))[0];
  let calls = 0;
  const result = await collect(["events"], { fetchPublicJson: async url => {
   calls += 1;
   return { requestedUrl: url, responseUrl: url, status: 200, link: githubLink(url, calls < pages), data: [{ ...event, id: String(calls) }] };
  } });
  assert.equal(calls, pages);
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
   link: githubLink(url, true),
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
for (const end of ["link", "empty", "cap", "unread"] as const) {
 test(`history above 1000 reconciles the documented window: ${end}`, async () => {
  const source = JSON.parse(await fixture("history-issue.json")).items[0];
  const prior = { history: { fetched_at: "2025-12-01T00:00:00Z" } };
  let calls = 0;
  const result = await collect(["history"], { fetchPublicJson: async url => {
   const pr = url.includes("type%3Apr");
   const pageNumber = pr ? 0 : ++calls;
   const last = end === "link" ? 2 : end === "empty" ? 1 : 10;
   const size = end === "empty" ? 0 : end === "unread" ? 1 : 100;
   return { requestedUrl: url, responseUrl: url, status: 200,
    // GitHub's capped tenth search page links back with neither next nor last.
    link: pr ? null : githubLink(url, !(pageNumber === last && end !== "unread")),
    data: { total_count: pr ? 0 : 1500, incomplete_results: false,
     items: pr ? [] : Array.from({ length: size }, (_, i) => ({ ...source, id: pageNumber * 100 + i, number: pageNumber * 100 + i })) } };
  } }, prior);
  assert.equal(calls, end === "link" ? 2 : end === "empty" ? 1 : 10);
  if (end === "cap") {
   assert.equal(result.records.length, 1);
   assert.equal((result.records[0]?.data.issues as unknown[]).length, 1000);
   assert.match(String(result.records[0]?.data.windowDescription), /1,000 items per type/);
   assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
  } else {
   assert.deepEqual(result.records, []);
   assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
   assert.deepEqual(result.state, prior);
  }
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

test("events retain legacy null details when a PushEvent omits its commits list", async () => {
 const result = await collect(["events"], {
  fetchPublicJson: async (url) => ({
   requestedUrl: url, responseUrl: url, status: 200, link: null,
   data: [{ id: "push-without-commits", type: "PushEvent", public: true,
    created_at: "2026-01-01T00:00:00Z", repo: { name: "sample-user/demo" },
    payload: { ref: "refs/heads/main", head: "abc123" } }],
  }),
 });
 assert.equal(result.records.length, 1);
 const events = result.records[0]?.data.events as Array<Record<string, unknown>>;
 assert.equal(events[0]?.title, null);
 assert.equal(events[0]?.commits, null);
 assert.equal(events[0]?.branch, "main");
 assert.ok(result.messages.some((message) => message.type === "DETAIL_COVERAGE"));
 assert.ok(!result.messages.some((message) => message.type === "SKIP_RESULT"));
});

test("profile absent optional details do not prevent a successful checkpoint", async () => {
 const html = (await fixture("profile.html"))
  .replace('<span itemprop="worksFor"></span><span itemprop="homeLocation"></span><a itemprop="url" href=""></a>', '<ul class="vcard-details"></ul>');
 const parsed = parseProfilePage(html, "https://github.com/sample-user");
 assert.equal(parsed.complete, true);
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(result.records.length, 1);
 for (const field of ["company", "location", "website"]) {
  assert.equal(field in (result.records[0]?.data ?? {}), false);
 }
 assert.ok(result.state.profile);
 assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
});

test("recorded profile shape with pinned marker on list item publishes nested data", async () => {
 const html = await fixture("profile-pinned-listitem-current-github.html");
 const parsed = parseProfilePage(html, "https://github.com/sample-user");
 assert.equal(parsed.rejectedEntries, 0);
 assert.deepEqual(parsed.unreadableFields, []);
 assert.equal(parsed.complete, true);
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(result.records.length, 1);
 const record = result.records[0]?.data;
 assert.deepEqual(record?.pinnedRepositories, [{ fullName: "sample-owner/demo", url: "https://github.com/sample-owner/demo", description: "Synthetic pinned repository", language: "TypeScript", stars: 5, forks: 2 }]);
 assert.equal((record?.organizations as unknown[])?.length, 1);
 assert.equal((record?.achievements as unknown[])?.length, 1);
 assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
});

test("recorded contribution overview and activity repository links are separate from pins", async () => {
 const base = await fixture("profile-current-github.html");
 for (const section of [
  '<div class="js-yearly-contributions"><div id="user-activity-overview"><a href="/activity-owner/overview">activity-owner/overview</a></div></div>',
  '<div id="js-contribution-activity"><div class="contribution-activity-listing"><h4><a href="/activity-owner/recent">activity-owner/recent</a></h4></div></div>',
 ]) {
  const parsed = parseProfilePage(base.replace("</main>", `${section}</main>`), "https://github.com/sample-user");
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.unreadableFields, []);
  assert.equal(parsed.rejectedEntries, 0);
  assert.equal(parsed.row?.pinnedRepositories?.length, 1);
 }
});


test("profile README repository links do not veto readable pinned collections", async () => {
 const html = await fixture("profile-with-readme-links.html");
 const parsed = parseProfilePage(html, "https://github.com/sample-user");
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(result.records.length, 1);
 assert.deepEqual(result.records[0]?.data.pinnedRepositories, parsed.row?.pinnedRepositories);
 assert.equal(parsed.row?.pinnedRepositories?.length, 1);
 assert.equal(parsed.complete, true);
 assert.deepEqual(parsed.unreadableFields, []);
 assert.equal(parsed.rejectedEntries, 0);
 assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
});

test("renamed pinned headings and containers still account for recognizable cards", async () => {
 const html = (await fixture("profile-pinned-listitem-current-github.html"))
  .replace("Popular repositories", "Featured work")
  .replace("js-pinned-items-reorder-container", "new-pinned-container");
 const parsed = parseProfilePage(html, "https://github.com/sample-user");
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.ok(parsed.unreadableFields.includes("pinnedRepositories"));
 assert.deepEqual(result.records, []);
 assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
});

for (const marker of ["pinned-item-list-item-content", "pinned-item-desc", "pinned-item-meta"]) {
 test(`drifted pin retains incomplete evidence from ${marker}`, async () => {
  let html = (await fixture("profile-pinned-listitem-current-github.html"))
   .replace("Popular repositories", "Featured work")
   .replace("js-pinned-items-reorder-container", "new-pinned-container");
  for (const name of ["pinned-item-list-item", "js-pinned-item-list-item", "pinned-item-list-item-content", "pinned-item-desc", "pinned-item-meta"]) {
   if (name !== marker) html = html.replaceAll(new RegExp(`(?<=["\\s])${name}(?=["\\s])`, "gu"), "changed-pin-class");
  }
  const parsed = parseProfilePage(html, "https://github.com/sample-user");
  const prior = { profile: { fetched_at: "2025-12-01T00:00:00Z" } };
  const result = await collect(["profile"], { openPage: async url => page(url, html) }, prior);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.unreadableFields.includes("pinnedRepositories"));
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.messages.map(message => message.type), ["SKIP_RESULT"]);
  assert.deepEqual(result.state, prior);
 });
}

for (const heading of ["Pinned", "Popular repositories", "Organizations", "Achievements"]) {
 test(`README heading ${heading} does not claim real profile collections`, async () => {
  const html = (await fixture("profile-with-readme-links.html")).replace("Profile README", heading);
  const parsed = parseProfilePage(html, "https://github.com/sample-user");
  const result = await collect(["profile"], { openPage: async url => page(url, html) });
  assert.equal(parsed.complete, true);
  assert.equal(parsed.rejectedEntries, 0);
  assert.deepEqual(parsed.unreadableFields, []);
  assert.equal(result.records.length, 1);
  assert.equal(parsed.row?.pinnedRepositories?.length, 1);
  assert.equal(parsed.row?.organizations?.length, 1);
  assert.equal(parsed.row?.achievements?.length, 1);
  assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
 });
}

test("profile bio headings and repository links are prose rather than pinned entries", async () => {
 const html = (await fixture("profile-current-github.html")).replace('<div class="p-note user-profile-bio"></div>', '<div class="p-note user-profile-bio"><h3>Pinned</h3><a href="/bio-owner/demo">My work</a></div>');
 const parsed = parseProfilePage(html, "https://github.com/sample-user");
 const result = await collect(["profile"], { openPage: async url => page(url, html) });
 assert.equal(parsed.complete, true);
 assert.equal(parsed.rejectedEntries, 0);
 assert.equal(result.records.length, 1);
 assert.equal(parsed.row?.pinnedRepositories?.length, 1);
 assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
});

for (const wrapped of [false, true]) {
 test(`README after pinned container stays outside collection ownership: ${wrapped ? "wrapped" : "direct"}`, async () => {
  const article = '<article class="markdown-body"><p>My <a href="/readme-owner/project">project</a></p></article>';
  const html = (await fixture("profile-current-github.html")).replace('<h2 id="js-contribution-activity-description"', `${wrapped ? `<div>${article}</div>` : article}<h2 id="js-contribution-activity-description"`);
  const parsed = parseProfilePage(html, "https://github.com/sample-user");
  const result = await collect(["profile"], { openPage: async url => page(url, html) });
  assert.equal(parsed.complete, true);
  assert.equal(parsed.rejectedEntries, 0);
  assert.equal(parsed.row?.pinnedRepositories?.length, 1);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
 });
}
