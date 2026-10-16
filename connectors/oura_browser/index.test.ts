// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext, EmittedMessage, RecordData, StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { assertUserFacingProgress, setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { collectOuraBrowser, ensureOuraSession, initialStartDate } from "./index.ts";
import { validateRecord } from "./schemas.ts";

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
    evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { origin: new URL(url).origin },
      });
      try {
        return await fn(arg);
      } finally {
        if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
        else Reflect.deleteProperty(globalThis, "location");
      }
    },
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
    progress: async (message: string, extra?: Record<string, unknown>) => {
      messages.push({ type: "PROGRESS", message, ...extra } as EmittedMessage);
    },
  });
  return { ctx, messages, records, failures };
}

function savedCursor(messages: EmittedMessage[]): { next_day?: string; refresh_from?: string; failed_windows?: Array<{ start: string; end: string }> } {
  const message = messages.find((item) => item.type === "STATE");
  assert.equal(message?.type, "STATE");
  return message.cursor as { next_day?: string; refresh_from?: string; failed_windows?: Array<{ start: string; end: string }> };
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

test("streamed handoff probes Oura on the login page without opening a sibling tab", async () => {
  let authenticated = false;
  const visits: string[] = [];
  const statuses: string[] = [];
  await withBrowser(async () => new Response("{}", { status: authenticated ? 200 : 401 }), async () => {
    await ensureOuraSession(Object.assign(Object.create(null) as EnsureSessionArgs, {
      page: page("about:blank", visits, async () => { throw new Error("unexpected sibling page"); }),
      assist: async () => { authenticated = true; return "assist-1"; },
      completeAssistance: async (_id: string, status: string) => { statuses.push(status); },
    }));
  });
  assert.deepEqual(visits, [HOME, `${HOME}user/sign-in`]);
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
    assert.deepEqual(h.records.map((r) => r.stream), ["sleep", "sleep", "readiness", "activity"]);
    assert.equal(h.records[0]?.data.sleep_score, 88);
    assert.equal(h.records.find((record) => record.stream === "activity")?.data.steps, 7000);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.messages.filter((m) => m.type === "STATE").map((m) => (m.cursor as { next_day: string }).next_day), [next(today), next(today), next(today)]);
  });
  assert.equal(requests.length, 3);
  assert.ok(requests.every((url) => url.includes(`start=${today}`) && url.includes(`end=${today}`)));
});

test("browser schema accepts offset timestamps and preserves every daily score document", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/sleep-score-parity.json", import.meta.url), "utf8")) as {
    sleeps: Array<Record<string, unknown>>;
    daily_sleeps: Array<Record<string, unknown>>;
  };
  await withBrowser(async () => Response.json(fixture), async () => {
    const h = harness(["sleep"], page(HOME), {}, { since: "2026-09-22", until: "2026-09-24" });
    await collectOuraBrowser(h.ctx);
    assert.equal(h.records.length, 4);
    const session = h.records.find((record) => record.data.id === UUID(101));
    assert.equal(session?.data.record_type, "sleep_session");
    assert.equal(session?.data.awake_time, 1200);
    assert.equal(session?.data.daily_sleep_id, UUID(203));
    assert.equal(session?.data.daily_sleep_timestamp, "2026-09-23T09:15:00+00:00");
    const sameDayScores = h.records.filter((record) => record.data.record_type === "daily_score" && record.data.day === "2026-09-23");
    assert.deepEqual(sameDayScores.map((record) => record.data.id), [UUID(201), UUID(203)]);
    assert.deepEqual(sameDayScores.map((record) => record.data.daily_sleep_timestamp), [
      "2026-09-23T08:15:00+00:00",
      "2026-09-23T09:15:00+00:00",
    ]);
    const scoreOnly = h.records.find((record) => record.data.day === "2026-09-22");
    assert.equal(scoreOnly?.data.id, UUID(202));
    assert.equal(scoreOnly?.data.record_type, "daily_score");
    assert.equal(scoreOnly?.data.daily_sleep_id, UUID(202));
    assert.equal(scoreOnly?.data.sleep_score, 76);
    assert.equal(scoreOnly?.data.daily_sleep_timestamp, "2026-09-22T07:45:00+00:00");
  });
});

test("partial-day until includes its UTC date in the daily source window", async () => {
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({ daily_activities: [] });
  }, async () => {
    const h = harness(["activity"], page(HOME), {}, {
      since: "2020-01-01",
      until: "2020-01-03T12:00:00Z",
    });
    await collectOuraBrowser(h.ctx);
    assert.equal(savedCursor(h.messages).next_day, "2020-01-04");
  });
  assert.ok(requests.at(-1)?.includes("start=2020-01-01&end=2020-01-03"));
});

test("failed required window reports runtime failure and saves retry state", async () => {
  const today = new Date().toISOString().slice(0, 10);
  let retryState: unknown;
  const diagnostics: string[] = [];
  setConnectorDiagnosticSink((line) => diagnostics.push(line));
  await withBrowser(async () => { throw new Error("network unavailable"); }, async () => {
    const h = harness(["activity"], page(HOME), {}, { since: today });
    try {
      await collectOuraBrowser(h.ctx);
    } finally {
      setConnectorDiagnosticSink(undefined);
    }
    assert.deepEqual(h.failures, [{ stream: "activity", retryable: true }]);
    // Owner text is plain; the raw error detail moved to a diagnostic line.
    const progress = h.messages.filter((m) => m.type === "PROGRESS");
    assert.deepEqual(progress.map((m) => (m as { message: string }).message), [
      `Fetching activity: ${today} to ${today}`,
      `Could not fetch Oura activity data for ${today} to ${today}`,
    ]);
    assertUserFacingProgress(h.messages);
    assert.deepEqual(diagnostics, [
      `[oura_browser-diagnostic] chunk_failed {"stream":"activity","from":"${today}","to":"${today}","detail":"network unavailable","retryable":true}`,
    ]);
    assert.ok(h.messages.some((m) => m.type === "SKIP_RESULT" && m.reason === "stream_collection_failed"));
    assert.deepEqual(h.messages.find((m) => m.type === "STATE")?.cursor, {
      next_day: today, refresh_from: today, requested_since: today, failed_windows: [{ start: today, end: today }],
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
    const skip = h.messages.find(
      (m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
        m.type === "SKIP_RESULT" && m.reason === "oura_browser_window_deferred",
    );
    assert.ok(skip);
    // Without a retry hint the host reads the deferral as final and drops the stream.
    assert.deepEqual(skip.recovery_hint, { action: "retry_by_runtime", retryable: true });
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

test("seven-day sleep consent requests and emits only its seven source days", async () => {
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    const url = new URL(String(input), HOME);
    const days: string[] = [];
    for (let day = url.searchParams.get("start")!; day <= url.searchParams.get("end")!; day = next(day)) days.push(day);
    days.unshift("2020-01-01");
    days.push("2020-01-09");
    return Response.json({ daily_sleeps: days.map((day, i) => ({ id: UUID(i + 1), day, score: 80 })) });
  }, async () => {
    const h = harness(["sleep"], page(HOME), {}, { since: "2020-01-02", until: "2020-01-09" });
    await collectOuraBrowser(h.ctx);
    assert.deepEqual(h.records.map((r) => r.data.day), ["2020-01-02", "2020-01-03", "2020-01-04", "2020-01-05", "2020-01-06", "2020-01-07", "2020-01-08"]);
    assert.deepEqual(h.failures, []);
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes("start=2020-01-02&end=2020-01-08"));
});

test("one failed window preserves successful records but reports failure and a safe retry cursor", async () => {
  let requests = 0;
  await withBrowser(async (input) => {
    if (++requests === 2) return new Response("{}", { status: 500 });
    const day = new URL(String(input), HOME).searchParams.get("start")!;
    return Response.json({ daily_sleeps: [{ id: UUID(requests), day, score: 80 }] });
  }, async () => {
    const h = harness(["sleep"], page(HOME), {}, { since: "2020-01-01", until: "2020-03-31" });
    await collectOuraBrowser(h.ctx);
    assert.equal(requests, 3);
    assert.equal(h.records.length, 2);
    assert.deepEqual(h.failures, [{ stream: "sleep", retryable: true }]);
    assert.equal(savedCursor(h.messages).next_day, "2020-01-31");
  });
});

test("readiness and activity enforce full-date consent on returned calendar days", async () => {
  for (const stream of ["readiness", "activity"]) {
    await withBrowser(async () => Response.json({
      [stream === "readiness" ? "daily_readinesses" : "daily_activities"]:
        ["2020-01-01", "2020-01-02", "2020-01-08", "2020-01-09"].map((day, i) => ({ id: UUID(i + 1), day, score: 80 })),
    }), async () => {
      const h = harness([stream], page(HOME), {}, { since: "2020-01-02", until: "2020-01-09" });
      await collectOuraBrowser(h.ctx);
      assert.deepEqual(h.records.map((r) => r.data.day), ["2020-01-02", "2020-01-08"]);
      assert.deepEqual(h.failures, []);
    });
  }
});

function shifted(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("consecutive runs refresh mutable rows for today and the previous two days in every stream", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const since = shifted(today, -2);
  const days = [since, shifted(today, -1), today];
  let version = 1;
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({
      daily_sleeps: days.map((day, i) => ({ id: UUID(i + 1), day, score: 70 + version })),
      daily_readinesses: days.map((day, i) => ({ id: UUID(i + 11), day, score: 60 + version })),
      daily_activities: days.map((day, i) => ({ id: UUID(i + 21), day, steps: 1000 * version })),
    });
  }, async () => {
    const streams = ["sleep", "readiness", "activity"];
    const first = harness(streams, page(HOME), {}, { since });
    await collectOuraBrowser(first.ctx);
    const state = Object.fromEntries(first.messages.filter((message) => message.type === "STATE")
      .map((message) => [message.stream, message.cursor]));
    version = 2;
    const second = harness(streams, page(HOME), state, { since });
    await collectOuraBrowser(second.ctx);
    for (const stream of streams) {
      const records = second.records.filter((record) => record.stream === stream);
      assert.deepEqual(records.map((record) => record.data.day), days);
      const field = stream === "activity" ? "steps" : stream === "sleep" ? "sleep_score" : "score";
      const value = stream === "activity" ? 2000 : stream === "sleep" ? 72 : 62;
      assert.ok(records.every((record) => record.data[field] === value));
    }
    for (const message of second.messages) {
      if (message.type !== "STATE") continue;
      assert.equal((message.cursor as { next_day: string }).next_day, next(today));
      assert.equal((message.cursor as { refresh_from: string }).refresh_from, since);
    }
  });
  assert.equal(requests.length, 6);
  assert.ok(requests.every((url) => url.includes(`start=${since}&end=${today}`)));
});

test("a row arriving after an empty current-day response is collected on the next run", async () => {
  const today = new Date().toISOString().slice(0, 10);
  let synced = false;
  await withBrowser(async () => Response.json({
    daily_sleeps: synced ? [{ id: UUID(1), day: today, score: 84 }] : [],
  }), async () => {
    const first = harness(["sleep"], page(HOME), {}, { since: today });
    await collectOuraBrowser(first.ctx);
    assert.equal(first.records.length, 0);
    const cursor = savedCursor(first.messages);
    assert.equal(cursor.next_day, next(today));
    assert.equal(cursor.refresh_from, today);
    synced = true;
    const second = harness(["sleep"], page(HOME), { sleep: cursor }, { since: today });
    await collectOuraBrowser(second.ctx);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]?.data.sleep_score, 84);
    assert.equal(savedCursor(second.messages).next_day, next(today));
  });
});

test("historical backfill and mutable refresh have separate progress within a 90-day budget", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const refreshFrom = shifted(today, -2);
  const requests: Array<{ start: string; end: string }> = [];
  let version = 1;
  await withBrowser(async (input) => {
    const params = new URL(String(input), HOME).searchParams;
    requests.push({ start: params.get("start")!, end: params.get("end")! });
    return Response.json({ daily_activities: [{ id: UUID(1), day: today, steps: version * 1000 }] });
  }, async () => {
    const first = harness(["activity"], page(HOME), {}, { since: "2020-01-01" });
    await collectOuraBrowser(first.ctx);
    const cursor = savedCursor(first.messages);
    assert.equal(cursor.next_day, shifted("2020-01-01", 87));
    assert.equal(cursor.refresh_from, refreshFrom);
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0]?.data.steps, 1000);
    const firstRequests = requests.splice(0);
    assert.equal(firstRequests.reduce((days, window) =>
      days + (Date.parse(window.end) - Date.parse(window.start)) / 86_400_000 + 1, 0), 90);
    assert.deepEqual(firstRequests.at(-1), { start: refreshFrom, end: today });
    version = 2;
    const second = harness(["activity"], page(HOME), { activity: cursor }, { since: "2020-01-01" });
    await collectOuraBrowser(second.ctx);
    assert.equal(requests[0]?.start, cursor.next_day);
    assert.deepEqual(requests.at(-1), { start: refreshFrom, end: today });
    assert.equal(savedCursor(second.messages).next_day, shifted("2020-01-01", 174));
    assert.equal(savedCursor(second.messages).refresh_from, refreshFrom);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]?.data.steps, 2000);
    assert.ok(second.messages.some((message) =>
      message.type === "SKIP_RESULT" && message.reason === "oura_browser_window_deferred"));
  });
});

test("a failed mutable refresh preserves the prior refresh watermark and safe historical cursor", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const refreshFrom = shifted(today, -2);
  const priorRefresh = shifted(today, -3);
  await withBrowser(async () => new Response("{}", { status: 500 }), async () => {
    const h = harness(["activity"], page(HOME), {
      activity: { next_day: next(today), refresh_from: priorRefresh, requested_since: "2020-01-01" },
    }, { since: "2020-01-01" });
    await collectOuraBrowser(h.ctx);
    assert.deepEqual(h.failures, [{ stream: "activity", retryable: true }]);
    assert.equal(savedCursor(h.messages).next_day, next(today));
    assert.equal(savedCursor(h.messages).refresh_from, priorRefresh);
    assert.deepEqual(savedCursor(h.messages).failed_windows,
      [{ start: refreshFrom, end: today }]);
  });
});

test("legacy forward cursors still refresh recent days, and consent clips the overlap", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const since = shifted(today, -1);
  const requests: string[] = [];
  await withBrowser(async (input) => {
    requests.push(String(input));
    return Response.json({ daily_activities: [] });
  }, async () => {
    const h = harness(["activity"], page(HOME), {
      activity: { next_day: next(today), requested_since: since },
    }, { since, until: today });
    await collectOuraBrowser(h.ctx);
    assert.equal(savedCursor(h.messages).refresh_from, since);
    assert.equal(savedCursor(h.messages).next_day, next(today));
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes(`start=${since}&end=${since}`));
});
