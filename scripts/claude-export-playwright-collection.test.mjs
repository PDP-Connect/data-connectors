// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the newest committed claude-export-playwright script against a mock
// `page` and checks what it hands the host when the export is and is not
// collected. A scope the connector did not collect must be `omitted` with no
// payload: an empty payload would be ingested as an account with no data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const VERSION = readdirSync(join(root, "artifacts/claude-export-playwright"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^claude-export-playwright-\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name.replace("claude-export-playwright-", ""))
  .sort((a, b) => { const [x, y] = [a, b].map((v) => v.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })
  .at(-1);
const script = readFileSync(
  join(root, `artifacts/claude-export-playwright/claude-export-playwright-${VERSION}/script.js`),
  "utf8",
);

const ALL = ["claude.conversations", "claude.projects"];
const NOT_READY_STATUS = "Export is taking longer than usual to prepare. Re-run shortly to finish.";
const ORG = "org-1";

// Runs the script to completion. `download` answers captureDownload, `extract`
// answers extractZipEntries, `checkpoint` is the nonce left by an earlier run.
const run = async ({ requestedScopes = ALL, download, extract, checkpoint = null, exportRequest = { ok: true, status: 200, nonce: "nonce-1" }, fileText = null }) => {
  let clock = Date.parse("2026-10-10T00:00:00Z");
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock); }
    static now() { return clock; }
  }
  const data = {};
  const calls = { exportRequests: 0, checkpointSets: [], checkpointCleared: 0, downloads: 0, urls: [], extracted: [] };
  const page = {
    requestedScopes: async () => requestedScopes,
    goto: async () => {},
    sleep: async (ms) => { clock += ms; },
    setData: async (key, value) => { data[key] = value; },
    setProgress: async () => {},
    goHeadless: async () => {},
    evaluate: async (source) => {
      if (source.includes("document.body.innerText")) return fileText ?? "";
      if (source.includes("__ckpt.get()")) return checkpoint ?? {};
      if (source.includes("__ckpt.set(")) { calls.checkpointSets.push(source); return true; }
      if (source.includes("__ckpt.clear()")) { calls.checkpointCleared += 1; return true; }
      if (source.includes("/export_data")) { calls.exportRequests += 1; return exportRequest; }
      if (source.includes("/api/organizations'") || source.includes('/api/organizations"')) return { ok: true, status: 200, json: [{ uuid: ORG, capabilities: ["chat"] }] };
      if (source.includes("user-menu-button") && source.includes("textContent")) return { name: "Ada", plan: "Pro" };
      return true; // login check
    },
    captureDownload: async (url) => { calls.downloads += 1; calls.urls.push(url); assert.ok(url.includes(`/export/${ORG}/download/`)); return download(calls.downloads, url); },
    extractZipEntries: async (path, options) => { calls.extracted.push(path); return extract(path, options); },
  };
  const context = vm.createContext({ page, Date: FakeDate, console, JSON, Math, Object, Array, Boolean, Number, String, Promise });
  vm.runInContext(script, context, { filename: "claude-export-playwright.js" });
  // The script's main is an un-awaited async IIFE; let its microtasks settle.
  for (let i = 0; i < 200 && !("status" in data && ("result" in data || "error" in data)); i += 1) await new Promise((r) => setImmediate(r));
  // Plain-realm copy, so deepStrictEqual compares against this realm's prototypes.
  return { data, calls, result: JSON.parse(JSON.stringify(data.result)) };
};

const notReady = async () => ({ ok: false, ready: false });
const readyZip = async () => ({ ok: true, ready: true, path: "/tmp/export.zip", name: "export.zip", size: 1024 });

// What the host requires of any result: every requested scope is produced or
// marked omitted, and an omitted scope has no payload.
const assertNotCollected = (result, scopes) => {
  for (const scope of scopes) {
    assert.equal(Object.hasOwn(result, scope), false, `${scope}: no payload may be emitted`);
    const entries = result.errors.filter((e) => e.scope === scope);
    assert.equal(entries.length, 1, `${scope}: exactly one error entry`);
    assert.equal(entries[0].disposition, "omitted", `${scope}: must be omitted, not degraded`);
  }
  assert.equal(result.errors.some((e) => e.disposition === "degraded"), false);
  assert.equal(result.errors.some((e) => e.disposition === "fatal"), false);
};

test("export never ready: both scopes omitted, nothing emitted, status kept, checkpoint kept", async () => {
  const { data, calls, result } = await run({ download: notReady });
  assert.ok(calls.downloads > 1, "polls more than once");
  assertNotCollected(result, ALL);
  assert.deepEqual(result.requestedScopes, ALL);
  assert.equal(result.exportSummary.count, 0);
  assert.equal(result.exportSummary.details.pending, true);
  assert.equal(data.status, NOT_READY_STATUS);
  assert.equal("error" in data, false);
  assert.equal(calls.checkpointCleared, 0, "the pending nonce survives for the re-run");
});

test("export request refused: both scopes omitted, nothing emitted", async () => {
  const { data, result } = await run({ download: notReady, exportRequest: { ok: false, status: 429 } });
  assertNotCollected(result, ALL);
  assert.equal(data.status, "Could not start the Claude export. Re-run later.");
});

test("archive unreadable: both scopes omitted, nothing emitted, checkpoint kept", async () => {
  const { data, calls, result } = await run({ download: readyZip, extract: async () => ({ ok: false, error: "bad zip" }) });
  assertNotCollected(result, ALL);
  assert.equal(data.status, "Could not read the downloaded export. Re-run to retry.");
  assert.equal(calls.checkpointCleared, 0);
});

test("only the requested scope is marked omitted when one scope is requested", async () => {
  const { result } = await run({ requestedScopes: ["claude.projects"], download: notReady });
  assertNotCollected(result, ["claude.projects"]);
  assert.equal(result.errors.length, 1);
});

test("export ready with zero conversations and projects: both scopes emitted empty and collected", async () => {
  const { data, calls, result } = await run({
    download: readyZip,
    extract: async () => ({ ok: true, json: { "conversations.json": [] } }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result["claude.conversations"].total, 0);
  assert.deepEqual(result["claude.conversations"].conversations, []);
  assert.equal(result["claude.conversations"].source, "official-export");
  assert.deepEqual(result["claude.projects"].projects, []);
  assert.equal(result.exportSummary.details.pending, false);
  assert.match(data.status, /^Complete! Imported 0 conversations/);
  assert.equal(calls.checkpointCleared, 1);
});

test("export ready with data: scopes carry the data", async () => {
  const { result } = await run({
    download: readyZip,
    extract: async () => ({
      ok: true,
      json: {
        "conversations.json": [{ uuid: "c1", name: "Hello", chat_messages: [{ uuid: "m1", sender: "human", text: "hi", created_at: "2026-01-01T00:00:00Z" }] }],
        "projects/p1.json": { uuid: "p1", name: "Proj" },
        "users.json": [{ full_name: "Ada L" }],
      },
    }),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result["claude.conversations"].total, 1);
  assert.equal(result["claude.conversations"].messageTotal, 1);
  assert.equal(result["claude.projects"].total, 1);
  assert.equal(result["claude.conversations"].profile.name, "Ada L");
});

test("a pending export from an earlier run is resumed, not requested again", async () => {
  const { calls, result } = await run({
    checkpoint: { organizationId: ORG, nonce: "nonce-from-last-run" },
    download: readyZip,
    extract: async () => ({ ok: true, json: { "conversations.json": [] } }),
  });
  assert.equal(calls.exportRequests, 0);
  assert.deepEqual(result.errors, []);

  const fresh = await run({ download: notReady });
  assert.equal(fresh.calls.exportRequests, 1, "no checkpoint: one export is requested");
  assert.equal(fresh.calls.checkpointSets.length, 1, "and its nonce is checkpointed");
});

// ─── Split export (manifest plus one ZIP per category) ───────────────
// Built from the synthetic fixture connectors/anthropic/__fixtures__/split-export:
// the same layout the Collection Profile connector reads. A "ZIP" here is the
// fixture directory named after it; the mock reads it the way the runner's
// extractZipEntries does (every .json entry whose name contains an include).

const fixtureDir = join(root, "connectors/anthropic/__fixtures__/split-export");
const fixtureManifest = JSON.parse(readFileSync(join(fixtureDir, "manifest.json"), "utf8"));
const walk = (dir, base = dir) => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  return statSync(full).isDirectory() ? walk(full, base) : [full.slice(base.length + 1)];
});
const loadZip = (name) => {
  const dir = join(fixtureDir, name.replace(/\.zip$/, ""));
  return Object.fromEntries(walk(dir).filter((n) => n.endsWith(".json")).map((n) => [n, JSON.parse(readFileSync(join(dir, n), "utf8"))]));
};
const urlFor = (filename) => `https://claude.ai/export/${ORG}/download/synthetic-${filename}`;
const manifestOf = (files) => ({
  ...fixtureManifest,
  data_files: files.map((f, i) => ({ batch_index: i, category: f.category, part: f.part ?? 0, filename: f.filename, export_url: urlFor(f.filename) })),
});
const FIXTURE_FILES = fixtureManifest.data_files.map((f) => ({ category: f.category, part: f.part, filename: f.filename }));
const conv = (id) => ({ uuid: id, name: id, chat_messages: [{ uuid: `${id}-m`, sender: "human", text: "hi", created_at: "2026-01-01T00:00:00Z" }] });

// A mock host for a split export. `zips` maps a ZIP filename to its entries
// (default: the fixture); `failing` lists ZIP filenames whose download fails.
const splitHost = ({ files = FIXTURE_FILES, zips = {}, failing = [], viaNonce = true, savedAs = "manifest-org.json", fileText } = {}) => {
  const manifest = manifestOf(files);
  const entries = (filename) => zips[filename] ?? loadZip(filename);
  const select = (json, include) => Object.fromEntries(Object.entries(json).filter(([n]) => include.some((s) => n.includes(s))));
  const download = (_n, url) => {
    if (url.endsWith(`/download/nonce-1`)) return { ok: true, ready: true, path: `/raw/${savedAs}`, name: savedAs, size: 900 };
    const filename = url.slice(url.lastIndexOf("synthetic-") + "synthetic-".length);
    if (failing.includes(filename)) return { ok: false, ready: false };
    return { ok: true, ready: true, path: `/raw/${filename}`, name: filename, size: 100 };
  };
  const extract = (path, options) => {
    const filename = path.slice(path.lastIndexOf("/") + 1);
    if (filename === savedAs) return { ok: false, error: "not a zip (no EOCD)" };
    return { ok: true, names: Object.keys(entries(filename)), json: select(entries(filename), options.include) };
  };
  return viaNonce
    ? { download, extract, fileText: fileText ?? JSON.stringify(manifest) }
    : { download, extract, exportRequest: { ok: true, status: 200, nonce: null, manifest } };
};

test("split export delivered by the nonce download: both scopes collected with the right counts", async () => {
  const { data, calls, result } = await run(splitHost());
  assert.deepEqual(result.errors, []);
  assert.equal(result["claude.conversations"].total, 2);
  assert.equal(result["claude.conversations"].messageTotal, 3);
  assert.equal(result["claude.projects"].total, 2);
  assert.equal(result["claude.conversations"].profile.name, "Synthetic User");
  assert.equal(result.exportSummary.details.exportFormat, "split-manifest");
  assert.match(data.status, /^Complete! Imported 2 conversations \(3 messages\) and 2 projects/);
  assert.equal(calls.checkpointCleared, 1);
  assert.equal(calls.exportRequests, 1);
  // Only the categories the connector uses are downloaded (plus the account name).
  assert.equal(calls.urls.some((u) => u.endsWith("memories-000.zip") || u.endsWith("design_chats-000.zip")), false);
});

test("split export in the export_data response: collected without polling or a checkpoint", async () => {
  const { calls, result } = await run(splitHost({ viaNonce: false }));
  assert.deepEqual(result.errors, []);
  assert.equal(result["claude.conversations"].total, 2);
  assert.equal(result["claude.projects"].total, 2);
  assert.equal(calls.checkpointSets.length, 0, "one-shot links are not checkpointed");
});

test("a category with several parts is merged", async () => {
  const files = [
    { category: "conversations", part: 1, filename: "conversations-001.zip" },
    { category: "conversations", part: 0, filename: "conversations-000.zip" },
    { category: "projects", part: 0, filename: "projects-000.zip" },
    { category: "projects", part: 1, filename: "projects-001.zip" },
  ];
  const zips = {
    "conversations-001.zip": { "conversations.json": [conv("c-extra-1"), conv("c-extra-2"), conv("c-extra-3")] },
    "projects-001.zip": { "projects/p-extra.json": { uuid: "p-extra", name: "Extra", docs: [] } },
  };
  const { calls, result } = await run(splitHost({ files, zips }));
  assert.deepEqual(result.errors, []);
  assert.equal(result["claude.conversations"].total, 5);
  assert.deepEqual(result["claude.conversations"].conversations.map((c) => c.id).slice(0, 2).sort(), ["00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c2"].sort());
  assert.equal(result["claude.projects"].total, 3);
  assert.ok(calls.urls.some((u) => u.endsWith("conversations-001.zip")));
});

test("projects part fails to download: projects omitted, conversations still collected, checkpoint kept", async () => {
  const { data, calls, result } = await run(splitHost({ failing: ["projects-000.zip"] }));
  assertNotCollected(result, ["claude.projects"]);
  assert.equal(result["claude.conversations"].total, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(calls.checkpointCleared, 0);
  assert.doesNotMatch(data.status, /^Complete/);
});

test("conversations part fails to download: conversations omitted, projects still collected", async () => {
  const { result } = await run(splitHost({ failing: ["conversations-000.zip"] }));
  assertNotCollected(result, ["claude.conversations"]);
  assert.equal(result["claude.projects"].total, 2);
});

test("manifest without a conversations category: conversations omitted, not emitted empty", async () => {
  const files = FIXTURE_FILES.filter((f) => f.category !== "conversations");
  const { result } = await run(splitHost({ files }));
  assertNotCollected(result, ["claude.conversations"]);
  assert.equal(result["claude.projects"].total, 2);
});

test("conversations part holding no conversations.json: omitted; holding a literal [] : collected empty", async () => {
  const none = await run(splitHost({ zips: { "conversations-000.zip": { "something-else.json": {} } } }));
  assertNotCollected(none.result, ["claude.conversations"]);

  const empty = await run(splitHost({ zips: { "conversations-000.zip": { "conversations.json": [] } } }));
  assert.deepEqual(empty.result.errors, []);
  assert.equal(empty.result["claude.conversations"].total, 0);
  assert.deepEqual(empty.result["claude.conversations"].conversations, []);
});

test("manifest file that cannot be read: nothing emitted", async () => {
  const { result, calls } = await run(splitHost({ fileText: "<html>not json</html>" }));
  assertNotCollected(result, ALL);
  assert.equal(calls.checkpointCleared, 0);
});

test("single ZIP without conversations.json is an unknown layout: both scopes omitted", async () => {
  const { result } = await run({
    download: readyZip,
    extract: async () => ({ ok: true, names: ["something.json"], json: { "projects/p1.json": { uuid: "p1", name: "P" } } }),
  });
  assertNotCollected(result, ALL);
});
