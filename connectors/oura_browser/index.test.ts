// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import type { BrowserCollectContext, EmittedMessage, RecordData, StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "../oura/schemas.ts";
import { collectOuraBrowser, ensureOuraSession, initialStartDate } from "./index.ts";

const HOME = "https://cloud.ouraring.com/";
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const next = (value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

function withBrowser<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const savedFetch = globalThis.fetch;
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: new URL(HOME).origin } });
  globalThis.fetch = fetcher;
  return run().finally(() => {
    globalThis.fetch = savedFetch;
    if (savedLocation) Object.defineProperty(globalThis, "location", savedLocation);
    else Reflect.deleteProperty(globalThis, "location");
  });
}

function page(initial = "about:blank", visits: string[] = [], sibling?: () => Promise<Page>): Page {
  let url = initial;
  return {
    url: () => url,
    goto: async (target: string) => { url = target; visits.push(target); return null; },
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
    close: async () => {},
    context: () => ({ newPage: sibling ?? (async () => page()) }),
  } as Page;
}

function harness(names: string[], browserPage: Page, state: Record<string, unknown> = {}, timeRange: { since?: string; until?: string } = {}) {
  const messages: EmittedMessage[] = [];
  const records: Array<{ stream: string; data: RecordData }> = [];
  const failures: Array<{ stream: string; retryable: boolean }> = [];
  const ctx = Object.assign(Object.create(null) as BrowserCollectContext, {
    page: browserPage, state,
    requested: new Map(names.map((name) => [name, { name, time_range: timeRange } as StreamScope])),
    emit: async (message: EmittedMessage) => { messages.push(message); },
    emitRecord: async (stream: string, data: RecordData) => {
      const parsed = validateRecord(stream, data);
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      records.push({ stream, data });
    },
    reportStreamFailure: async (stream: string, message: string, options?: { retryable?: boolean }) => {
      failures.push({ stream, retryable: options?.retryable === true });
      messages.push({ type: "SKIP_RESULT", stream, reason: "stream_collection_failed", message });
    },
    progress: async () => {},
  });
  return { ctx, messages, records, failures };
}

function savedCursor(messages: EmittedMessage[]): { next_day?: string } {
  const message = messages.find((item) => item.type === "STATE");
  assert.equal(message?.type, "STATE");
  return message.cursor as { next_day?: string };
}

test("browser profile uses a publishable identity and keeps PAT setup separate", () => {
  const pat = JSON.parse(readFileSync(new URL("../oura/manifest.json", import.meta.url), "utf8"));
  const browser = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.equal(pat.connector_key, "oura");
  assert.deepEqual(pat.capabilities.auth.required, ["OURA_PERSONAL_ACCESS_TOKEN"]);
  assert.equal(browser.connector_key, "oura-browser");
  assert.ok(browser.connector_id.endsWith(`/${browser.connector_key}`));
  assert.equal(browser.setup, undefined);
  assert.deepEqual(browser.streams.map((s: { name: string }) => s.name), pat.streams.map((s: { name: string }) => s.name));
});

test("stored session navigates the blank run page before probing", async () => {
  const visits: string[] = [];
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({});
  }, async () => {
    await ensureOuraSession(Object.assign(Object.create(null) as EnsureSessionArgs, { page: page("about:blank", visits), assist: async () => { throw new Error("unexpected assistance"); } }));
  });
  assert.deepEqual(visits, [HOME]);
  assert.deepEqual(requests, ["/api/me"]);
});

test("streamed handoff navigates its separate readiness page to Oura", async () => {
  let authenticated = false;
  const visits: string[] = [];
  const statuses: string[] = [];
  const sibling = page("about:blank", visits);
  await withBrowser(async () => new Response("{}", { status: authenticated ? 200 : 401 }), async () => {
    await ensureOuraSession(Object.assign(Object.create(null) as EnsureSessionArgs, {
      page: page("about:blank", [], async () => sibling),
      assist: async () => { authenticated = true; return "assist-1"; },
      completeAssistance: async (_id: string, status: string) => { statuses.push(status); },
    }));
  });
  assert.deepEqual(visits, [HOME]);
  assert.deepEqual(statuses, ["resolved"]);
});

test("all three streams produce schema-valid UUID records and day checkpoints", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({
      sleeps: [{ id: UUID(1), day: today, total_sleep_duration: 28000 }],
      daily_sleeps: [{ id: UUID(2), day: today, score: 88, contributors: { efficiency: 91 } }],
      daily_readinesses: [{ id: UUID(3), day: today, score: 82 }],
      daily_activities: [{ id: UUID(4), day: today, steps: 7000 }],
    });
  }, async () => {
    const h = harness(["sleep", "readiness", "activity"], page(HOME), {}, { since: today });
    await collectOuraBrowser(h.ctx);
    assert.deepEqual(h.records.map((r) => r.stream), ["sleep", "readiness", "activity"]);
    assert.equal(h.records[0]?.data.sleep_score, 88);
    assert.equal(h.records[2]?.data.steps, 7000);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.messages.filter((m) => m.type === "STATE").map((m) => (m.cursor as { next_day: string }).next_day), [next(today), next(today), next(today)]);
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((url) => url.includes(`start=${today}`) && url.includes(`end=${today}`)));
});

test("sleep preserves daily score-only days, score identity and timestamp, and awake time", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/sleep-score-parity.json", import.meta.url), "utf8")) as {
    sleeps: Array<Record<string, unknown>>;
    daily_sleeps: Array<Record<string, unknown>>;
  };
  await withBrowser(async () => Response.json(fixture), async () => {
    const h = harness(["sleep"], page(HOME), {}, { since: "2026-09-22", until: "2026-09-24" });
    await collectOuraBrowser(h.ctx);
    assert.equal(h.records.length, 2);
    const session = h.records.find((record) => record.data.id === UUID(101));
    assert.equal(session?.data.record_type, "sleep_session");
    assert.equal(session?.data.awake_time, 1200);
    assert.equal(session?.data.daily_sleep_id, UUID(201));
    assert.equal(session?.data.daily_sleep_timestamp, "2026-09-23T08:15:00+00:00");
    const scoreOnly = h.records.find((record) => record.data.day === "2026-09-22");
    assert.equal(scoreOnly?.data.id, UUID(202));
    assert.equal(scoreOnly?.data.record_type, "daily_score");
    assert.equal(scoreOnly?.data.daily_sleep_id, UUID(202));
    assert.equal(scoreOnly?.data.sleep_score, 76);
    assert.equal(scoreOnly?.data.daily_sleep_timestamp, "2026-09-22T07:45:00+00:00");
  });
});

test("failed required window reports runtime failure and saves retry state", async () => {
  const today = new Date().toISOString().slice(0, 10);
  let retryState: unknown;
  await withBrowser(async () => { throw new Error("network unavailable"); }, async () => {
    const h = harness(["activity"], page(HOME), {}, { since: today });
    await collectOuraBrowser(h.ctx);
    assert.deepEqual(h.failures, [{ stream: "activity", retryable: true }]);
    assert.ok(h.messages.some((m) => m.type === "SKIP_RESULT" && m.reason === "stream_collection_failed"));
    assert.deepEqual(h.messages.find((m) => m.type === "STATE")?.cursor, {
      next_day: today, requested_since: today, failed_windows: [{ start: today, end: today }],
    });
    retryState = savedCursor(h.messages);
  });
  await withBrowser(async () => Response.json({ daily_activities: [] }), async () => {
    const retry = harness(["activity"], page(HOME), { activity: retryState }, { since: today });
    await collectOuraBrowser(retry.ctx);
    assert.deepEqual(retry.failures, []);
    assert.equal(savedCursor(retry.messages).next_day, next(today));
  });
});

test("empty window advances; explicit older range overrides forward cursor and honors exclusive until", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({ sleeps: [], daily_sleeps: [], daily_readinesses: [], daily_activities: [] });
  }, async () => {
    const first = harness(["activity"], page(HOME), {}, { since: today });
    await collectOuraBrowser(first.ctx);
    const cursor = savedCursor(first.messages);
    assert.equal(cursor?.next_day, next(today));
    const backfill = harness(["activity"], page(HOME), { activity: cursor }, { since: "2020-01-01", until: "2020-01-03" });
    await collectOuraBrowser(backfill.ctx);
    assert.equal(savedCursor(backfill.messages).next_day, "2020-01-03");
  });
  assert.ok(requests.at(-1)?.includes("start=2020-01-01&end=2020-01-02"));
});

test("long requested ranges stop at 90 days and declare deferred coverage", async () => {
  assert.equal(initialStartDate(new Date("2026-09-23T00:00:00.000Z")), "2026-06-26");
  await withBrowser(async () => Response.json({ daily_activities: [] }), async () => {
    const h = harness(["activity"], page(HOME), {}, { since: "2020-01-01", until: "2021-01-01" });
    await collectOuraBrowser(h.ctx);
    assert.ok(h.messages.some((m) => m.type === "SKIP_RESULT" && m.reason === "oura_browser_window_deferred"));
    assert.equal(savedCursor(h.messages).next_day, "2020-03-31");
  });
});

test("wrong-origin page cannot make an authenticated data request", async () => {
  const today = new Date().toISOString().slice(0, 10);
  let requests = 0;
  await withBrowser(async () => { requests += 1; return Response.json({ daily_activities: [] }); }, async () => {
    const h = harness(["activity"], page("https://example.com/"), {}, { since: today });
    await assert.rejects(collectOuraBrowser(h.ctx), /oura_auth_failed/);
    assert.deepEqual(h.failures, []);
  });
  assert.equal(requests, 0);
});

test("lost authentication fails the run without attempting later windows", async () => {
  let requests = 0;
  await withBrowser(async () => {
    requests += 1;
    return new Response("{}", { status: 401 });
  }, async () => {
    const h = harness(["activity"], page(HOME), {}, { since: "2020-01-01", until: "2020-04-01" });
    await assert.rejects(collectOuraBrowser(h.ctx), /oura_auth_failed/);
    assert.deepEqual(h.failures, []);
  });
  assert.equal(requests, 1);
});

test("changed response shape is a non-retryable failed window", async () => {
  const today = new Date().toISOString().slice(0, 10);
  await withBrowser(async () => Response.json({ unexpected: [] }), async () => {
    const h = harness(["activity"], page(HOME), {}, { since: today });
    await collectOuraBrowser(h.ctx);
    assert.deepEqual(h.failures, [{ stream: "activity", retryable: false }]);
    assert.equal(savedCursor(h.messages).next_day, today);
  });
});
