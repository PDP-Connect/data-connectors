// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the newest committed claude-export-playwright script against a mock
// `page` and checks what it hands the host when the export is and is not
// collected. A scope the connector did not collect must be `omitted` with no
// payload: an empty payload would be ingested as an account with no data.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
const run = async ({ requestedScopes = ALL, download, extract, checkpoint = null, exportRequest = { ok: true, status: 200, nonce: "nonce-1" } }) => {
  let clock = Date.parse("2026-10-10T00:00:00Z");
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock); }
    static now() { return clock; }
  }
  const data = {};
  const calls = { exportRequests: 0, checkpointSets: [], checkpointCleared: 0, downloads: 0 };
  const page = {
    requestedScopes: async () => requestedScopes,
    goto: async () => {},
    sleep: async (ms) => { clock += ms; },
    setData: async (key, value) => { data[key] = value; },
    setProgress: async () => {},
    goHeadless: async () => {},
    evaluate: async (source) => {
      if (source.includes("__ckpt.get()")) return checkpoint ?? {};
      if (source.includes("__ckpt.set(")) { calls.checkpointSets.push(source); return true; }
      if (source.includes("__ckpt.clear()")) { calls.checkpointCleared += 1; return true; }
      if (source.includes("/export_data")) { calls.exportRequests += 1; return exportRequest; }
      if (source.includes("/api/organizations'") || source.includes('/api/organizations"')) return { ok: true, status: 200, json: [{ uuid: ORG, capabilities: ["chat"] }] };
      if (source.includes("user-menu-button") && source.includes("textContent")) return { name: "Ada", plan: "Pro" };
      return true; // login check
    },
    captureDownload: async (url) => { calls.downloads += 1; assert.ok(url.includes(`/export/${ORG}/download/`)); return download(calls.downloads); },
    extractZipEntries: async () => extract(),
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
