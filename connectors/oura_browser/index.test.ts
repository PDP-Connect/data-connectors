// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext, EmittedMessage, RecordData, StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectOuraBrowser, initialStartDate } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const DAY = "2026-09-23";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ACCESS = { accessToken: "synthetic-access", account: "account-a" };
const replay = JSON.parse(readFileSync(new URL("./fixtures/api-v2-replay.json", import.meta.url), "utf8")) as {
  sleep: Array<Record<string, unknown>>;
  daily_sleep: Array<Record<string, unknown>>;
  daily_readiness: Array<Record<string, unknown>>;
  daily_activity: Array<Record<string, unknown>>;
};

type Answer = { data?: Array<Record<string, unknown>>; next_token?: string | null; status?: number; error?: Error };
function harness(options: {
  streams?: string[];
  since?: string;
  until?: string;
  answers?: (endpoint: string, token: string | null, window: { start: string | null; end: string | null }) => Answer;
  state?: Record<string, unknown>;
  /** Omit the requested time range, so a stored cursor decides the start. */
  openRange?: boolean;
} = {}) {
  const calls: Array<{ endpoint: string; start: string | null; end: string | null; token: string | null }> = [];
  const records: Array<{ stream: string; data: RecordData }> = [];
  const messages: EmittedMessage[] = [];
  const page = Object.assign(Object.create(null) as Page, {
    context: () => ({ request: { get: async (raw: string) => {
      const url = new URL(raw);
      const endpoint = url.pathname.split("/").at(-1) ?? "";
      const token = url.searchParams.get("next_token");
      calls.push({ endpoint, start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date"), token });
      const window = { start: url.searchParams.get("start_date"), end: url.searchParams.get("end_date") };
      const answer = options.answers?.(endpoint, token, window) ?? { data: replay[endpoint as keyof typeof replay] ?? [], next_token: null };
      if (answer.error) throw answer.error;
      const status = answer.status ?? 200;
      return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => answer, dispose: async () => {} };
    } } }),
  });
  const streams = options.streams ?? ["sleep", "readiness", "activity"];
  const ctx = Object.assign(Object.create(null) as BrowserCollectContext, {
    page,
    requested: new Map(streams.map((stream) => [stream, (options.openRange ? { name: stream } : { name: stream, time_range: {
      since: options.since ?? `${DAY}T00:00:00Z`, until: options.until ?? "2026-09-24T00:00:00Z",
    } }) as StreamScope])),
    state: options.state ?? {},
    emit: async (message: EmittedMessage) => { messages.push(message); },
    emitRecord: async (stream: string, data: RecordData) => {
      assert.equal(validateRecord(stream, data).ok, true, JSON.stringify(data));
      records.push({ stream, data });
    },
    progress: async () => {},
  });
  return { ctx, calls, records, messages };
}

test("API v2 replay preserves every legacy document and mapped field", async () => {
  const h = harness();
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map((call) => call.endpoint), ["daily_sleep", "sleep", "daily_readiness", "daily_activity"]);
  assert.ok(h.calls.every((call) => call.start === DAY && call.end === "2026-09-24"));
  assert.deepEqual(h.records.map((record) => record.data.id), [id(101), id(201), id(301), id(401)]);
  const session = h.records[0]?.data;
  assert.equal(session?.awake_time, 1200);
  assert.equal(session?.average_hrv, 42);
  assert.equal(session?.restless_periods, 3);
  const score = h.records[1]?.data;
  assert.equal(score?.record_type, "daily_score");
  assert.equal(score?.daily_sleep_timestamp, "2026-09-23T08:15:00+00:00");
  assert.deepEqual(score?.contributors, { efficiency: 91 });
  assert.equal(h.records[2]?.data.timestamp, "2026-09-23T08:15:00+00:00");
  assert.equal(h.records[3]?.data.timestamp, "2026-09-23T08:15:00+00:00");
  assert.equal(h.records[3]?.data.inactivity_alerts, 2);
  assert.equal(h.messages.filter((message) => message.type === "STATE").length, 3);
  assert.equal(h.messages.some((message) => message.type === "SKIP_RESULT"), false);
});

test("a terminal token is required; a partial page is upserted without STATE", async () => {
  const h = harness({ streams: ["readiness"], answers: () => ({ data: replay.daily_readiness }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.records.length, 1);
  assert.equal(h.messages.some((message) => message.type === "STATE"), false);
  assert.deepEqual(h.messages.filter((message) => message.type === "SKIP_RESULT").map((message) => message.reason), ["inventory_not_proven_complete"]);
  assert.deepEqual(h.messages.find((message) => message.type === "SKIP_RESULT")?.recovery_hint,
    { action: "retry_by_runtime", retryable: true });
});

test("a malformed row does not discard valid rows from the same page", async () => {
  const h = harness({ streams: ["readiness"], answers: () => ({
    data: [...replay.daily_readiness, { id: id(999) }], next_token: null,
  }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.records.length, 1);
  assert.equal(h.messages.some((message) => message.type === "STATE"), false);
  assert.equal(h.messages.find((message) => message.type === "SKIP_RESULT")?.reason, "inventory_not_proven_complete");
});

test("repeated page tokens retain read rows but cannot complete inventory", async () => {
  const h = harness({ streams: ["activity"], answers: (_endpoint, token) =>
    token ? { data: [], next_token: "again" } : { data: replay.daily_activity, next_token: "again" } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 2);
  assert.equal(h.records.length, 1);
  assert.equal(h.messages.some((message) => message.type === "STATE"), false);
});

for (const status of [401, 403]) {
  test(`page-two HTTP ${status} retains page-one rows without STATE`, async () => {
    const h = harness({ streams: ["readiness"], answers: (_endpoint, token) =>
      token ? { status } : { data: replay.daily_readiness, next_token: "page-two" } });
    await collectOuraBrowser(h.ctx, ACCESS);
    assert.deepEqual(h.records.map(({ data }) => data.id), [id(301)]);
    assert.deepEqual(h.messages.filter((message) => message.type === "SKIP_RESULT").map((message) =>
      [message.reason, message.recovery_hint]), [["inventory_not_proven_complete",
        { action: "retry_by_runtime", retryable: true }]]);
    assert.equal(h.messages.some((message) => message.type === "STATE"), false);
  });
}

for (const terminal of [false, true]) {
  test(`a nonempty page wholly outside the inventory window is retryable (terminal=${terminal})`, async () => {
    const h = harness({ streams: ["readiness"], since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z",
      answers: (_endpoint, continuation) => ({
        data: [{ ...replay.daily_readiness[0], id: id(continuation ? 702 : 701), day: "2026-07-10" }],
        next_token: terminal || continuation ? null : "more-outside",
      }),
    });
    await collectOuraBrowser(h.ctx, ACCESS);
    assert.equal(h.records.length, 0);
    assert.equal(h.messages.some((message) => message.type === "STATE"), false);
    assert.deepEqual(h.messages.filter((message) => message.type === "SKIP_RESULT").map((message) =>
      [message.reason, message.recovery_hint]), [["inventory_not_proven_complete",
        { action: "retry_by_runtime", retryable: true }]]);
  });
}

test("an in-window page proves progress and the same window still completes", async () => {
  const row = { ...replay.daily_readiness[0], id: id(703), day: "2026-06-15", timestamp: "2026-06-15T08:15:00+00:00" };
  const h = harness({ streams: ["readiness"], since: "2026-06-01T00:00:00Z", until: "2026-06-30T00:00:00Z",
    answers: () => ({ data: [row], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.records.map(({ data }) => data.id), [id(703)]);
  noSkip(h);
});

test("an exclusive until and a lower bound constrain requests and emitted records", async () => {
  const h = harness({ streams: ["readiness"], since: "2026-09-23T12:00:00Z", until: "2026-09-24T00:00:00Z",
    answers: () => ({ data: [...replay.daily_readiness, { ...replay.daily_readiness[0], id: id(302), day: "2026-09-25" }], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.records.length, 1);
  assert.equal(h.calls[0]?.start, DAY);
  assert.equal(h.calls[0]?.end, "2026-09-24");
});

function noSkip(h: ReturnType<typeof harness>) {
  assert.equal(h.messages.some((message) => message.type === "SKIP_RESULT"), false);
  assert.equal(h.messages.filter((message) => message.type === "STATE").length, 1);
}

const today = new Date(Date.now()).toISOString().slice(0, 10);
const cursor = { api_v2: true, next_day: "2999-01-01", refresh_from: "2999-01-01", requested_since: null };
for (const [label, stored, start] of [
  ["a cursor from the same account resumes at its overlap", { ...cursor, account: "account-a" },
    new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10)],
  ["a cursor from another account is ignored; a fresh snapshot starts", { ...cursor, account: "account-b" },
    initialStartDate(new Date(`${today}T00:00:00Z`))],
  ["a cursor without an account is ignored; a fresh snapshot starts", cursor,
    initialStartDate(new Date(`${today}T00:00:00Z`))],
] as const) {
  test(label, async () => {
    const h = harness({ streams: ["readiness"], openRange: true, state: { readiness: stored },
      answers: () => ({ data: [], next_token: null }) });
    await collectOuraBrowser(h.ctx, ACCESS);
    assert.equal(h.calls[0]?.start, start);
    noSkip(h);
    const state = h.messages.find((message) => message.type === "STATE") as { cursor?: { account?: string } } | undefined;
    assert.equal(state?.cursor?.account, "account-a");
  });
}

// Oura's end_date is inclusive: a chunk asking for [from, to] also returns the day after `to`.
function inclusiveWindow(rows: Array<Record<string, unknown>>) {
  return (_endpoint: string, _token: string | null, window: { start: string | null; end: string | null }): Answer => ({
    data: rows.filter((row) => String(row.day) >= String(window.start) && String(row.day) <= String(window.end)),
    next_token: null,
  });
}
// A 31-day window splits into a 30-day chunk (08-01..08-30) and a 1-day chunk (08-31).
const WINDOW = { since: "2026-08-01T00:00:00Z", until: "2026-09-01T00:00:00Z" };
const BOUNDARY = "2026-08-31";

test("a boundary day returned by two chunks is emitted once per id", async () => {
  const rows = [
    { ...replay.daily_readiness[0], id: id(501), day: "2026-08-10", timestamp: "2026-08-10T08:15:00+00:00" },
    { ...replay.daily_readiness[0], id: id(502), day: BOUNDARY, timestamp: `${BOUNDARY}T08:15:00+00:00` },
  ];
  const h = harness({ streams: ["readiness"], ...WINDOW, answers: inclusiveWindow(rows) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map((call) => [call.start, call.end]), [["2026-08-01", "2026-08-31"], ["2026-08-31", "2026-09-01"]]);
  assert.deepEqual(h.records.map(({ data }) => data.id), [id(501), id(502)]);
  noSkip(h);
});

test("a boundary day shared by sleep sessions and daily scores is emitted once per id", async () => {
  const sessions = [{ ...replay.sleep[0], id: id(600), day: "2026-08-10" }, { ...replay.sleep[0], id: id(601), day: BOUNDARY }];
  const scores = [{ ...replay.daily_sleep[0], id: id(603), day: "2026-08-10" }, { ...replay.daily_sleep[0], id: id(602), day: BOUNDARY }];
  const h = harness({ streams: ["sleep"], ...WINDOW, answers: (endpoint, token, window) =>
    inclusiveWindow(endpoint === "sleep" ? sessions : scores)(endpoint, token, window) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.records.map(({ data }) => [data.record_type, data.id]),
    [["sleep_session", id(600)], ["sleep_session", id(601)], ["daily_score", id(603)], ["daily_score", id(602)]]);
  noSkip(h);
});

test("of two copies of one id, the copy with more filled fields is kept", async () => {
  const sparse = { ...replay.daily_readiness[0], id: id(502), day: BOUNDARY, timestamp: `${BOUNDARY}T08:15:00+00:00`, score: null };
  const full = { ...sparse, score: 77 };
  const inside = { ...sparse, id: id(503), day: "2026-08-10", timestamp: "2026-08-10T08:15:00+00:00", score: 61 };
  // The first chunk returns the sparse copy; the second chunk returns the full copy.
  const h = harness({ streams: ["readiness"], ...WINDOW, answers: (_endpoint, _token, window) =>
    ({ data: window.start === "2026-08-01" ? [inside, sparse] : [full], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.records.map(({ data }) => [data.id, data.score]), [[id(503), 61], [id(502), 77]]);
});

test("a window inside one chunk emits each row once, as before", async () => {
  const rows = [
    { ...replay.daily_readiness[0], id: id(501), day: "2026-08-10", timestamp: "2026-08-10T08:15:00+00:00" },
    { ...replay.daily_readiness[0], id: id(502), day: "2026-08-11", timestamp: "2026-08-11T08:15:00+00:00" },
  ];
  const h = harness({ streams: ["readiness"], since: "2026-08-10T00:00:00Z", until: "2026-08-12T00:00:00Z",
    answers: inclusiveWindow(rows) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.records.map(({ data }) => data.id), [id(501), id(502)]);
  noSkip(h);
});

test("a session takes a daily score only when that score is the only one for its day", async () => {
  const session = (n: number) => ({ ...replay.sleep[0], id: id(n) });
  const score = (n: number, value: number) => ({ ...replay.daily_sleep[0], id: id(n), score: value });
  const links = async (sleep: Array<Record<string, unknown>>, dailySleep: Array<Record<string, unknown>>) => {
    const h = harness({ streams: ["sleep"], answers: (endpoint) =>
      ({ data: endpoint === "sleep" ? sleep : dailySleep, next_token: null }) });
    await collectOuraBrowser(h.ctx, ACCESS);
    noSkip(h);
    // Score documents always stand alone, whatever the sessions link to.
    assert.equal(h.records.filter(({ data }) => data.record_type === "daily_score").length,
      new Set(dailySleep.map((score) => score.id)).size);
    return h.records.filter(({ data }) => data.record_type === "sleep_session")
      .map(({ data }) => [data.id, data.daily_sleep_id, data.sleep_score, data.daily_sleep_timestamp, data.contributors]);
  };
  // One score for the day: every session that day carries it.
  assert.deepEqual(await links([session(101), session(102)], [score(201, 88)]), [
    [id(101), id(201), 88, "2026-09-23T08:15:00+00:00", { efficiency: 91 }],
    [id(102), id(201), 88, "2026-09-23T08:15:00+00:00", { efficiency: 91 }],
  ]);
  // Two score documents for one day: no session claims either, in any page order.
  const unlinked = [[id(101), null, null, null, {}]];
  assert.deepEqual(await links([session(101)], [score(201, 88), score(202, 61)]), unlinked);
  assert.deepEqual(await links([session(101)], [score(202, 61), score(201, 88)]), unlinked);
  // The same document repeated is still one score.
  assert.deepEqual(await links([session(101)], [score(201, 88), score(201, 88)]),
    [[id(101), id(201), 88, "2026-09-23T08:15:00+00:00", { efficiency: 91 }]]);
});

for (const malformed of ["", "not-a-day", "2026-02-30", "2026-9-23", "2026-09-23T00:00:00Z"]) {
  test(`a terminal page with day ${JSON.stringify(malformed)} keeps valid rows and withholds STATE`, async () => {
    const h = harness({ streams: ["readiness"], answers: () => ({
      data: [...replay.daily_readiness, { ...replay.daily_readiness[0], id: id(999), day: malformed }], next_token: null,
    }) });
    await collectOuraBrowser(h.ctx, ACCESS);
    assert.deepEqual(h.records.map(({ data }) => data.id), [id(301)]);
    assert.equal(h.messages.some((message) => message.type === "STATE"), false);
    assert.equal(h.messages.find((message) => message.type === "SKIP_RESULT")?.reason, "inventory_not_proven_complete");
  });
}

test("a terminal page with an empty id withholds STATE", async () => {
  const h = harness({ streams: ["readiness"], answers: () => ({
    data: [...replay.daily_readiness, { ...replay.daily_readiness[0], id: "" }], next_token: null,
  }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.records.map(({ data }) => data.id), [id(301)]);
  assert.equal(h.messages.some((message) => message.type === "STATE"), false);
});

test("a fresh run walks from 2015 and emits history older than 90 days", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-23T12:00:00Z"));
  const row = { ...replay.daily_readiness[0], id: id(701), day: "2016-03-01", timestamp: "2016-03-01T08:15:00+00:00" };
  const h = harness({ streams: ["readiness"], openRange: true, answers: inclusiveWindow([row]) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls[0]?.start, "2015-01-01");
  assert.equal(h.calls[0]?.end, "2015-01-31");
  assert.equal(h.calls.at(-1)?.end, "2026-09-24");
  assert.ok(h.calls.length > 100);
  h.calls.forEach((call, index) => {
    assert.ok(call.start && call.end);
    assert.ok(Date.parse(call.end) - Date.parse(call.start) <= 30 * 86_400_000);
    if (index > 0) assert.equal(call.start, h.calls[index - 1]?.end);
  });
  assert.deepEqual(h.records.map(({ data }) => [data.id, data.day]), [[id(701), "2016-03-01"]]);
  noSkip(h);
});

test("a same-account cursor retains the existing two-day overlap", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-23T12:00:00Z"));
  const h = harness({ streams: ["readiness"], openRange: true,
    state: { readiness: { api_v2: true, account: "account-a", next_day: DAY, requested_since: null } },
    answers: () => ({ data: [], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map(({ start, end }) => [start, end]), [["2026-09-21", "2026-09-24"]]);
  noSkip(h);
});

test("an explicit range wins over the full-history floor and stored cursor", async (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-09-23T12:00:00Z"));
  const h = harness({ streams: ["readiness"], ...WINDOW,
    state: { readiness: { api_v2: true, account: "account-a", next_day: DAY, requested_since: null } },
    answers: () => ({ data: [], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map(({ start, end }) => [start, end]),
    [["2026-08-01", "2026-08-31"], ["2026-08-31", "2026-09-01"]]);
  noSkip(h);
});

test("terminal page after 50 continuing pages completes instead of truncating", async () => {
  let requests = 0;
  const h = harness({ streams: ["activity"], answers: () => {
    requests += 1;
    assert.ok(requests <= 51);
    return {
      data: [{ ...replay.daily_activity[0], id: id(1000 + requests) }],
      next_token: requests === 51 ? null : `synthetic-page-${requests}`,
    };
  } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(requests, 51);
  assert.equal(h.records.length, 51);
  assert.equal(h.messages.some((m) => m.type === "STATE"), true);
});

test("empty page with fresh activity token reaches new rows and terminal coverage", async () => {
  const h = harness({ streams: ["activity"], answers: (_endpoint, token) =>
    token === null ? { data: [], next_token: "empty-first" }
      : { data: replay.daily_activity, next_token: null } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 2);
  assert.equal(h.records.length, replay.daily_activity.length);
  assert.equal(h.messages.some((m) => m.type === "STATE"), true);
  assert.equal(h.messages.some((m) => m.type === "SKIP_RESULT"), false);
});

test("17 consecutive fresh activity tokens with no new IDs refuse the window retryably", async () => {
  let pages = 0;
  const h = harness({ streams: ["activity"], answers: () => {
    if (++pages > 18) return { data: [], next_token: null };
    return { data: replay.daily_activity, next_token: `activity-${pages}` };
  } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(pages, 18, "one initial page plus 17 consecutive pages without a new ID");
  assert.equal(h.messages.some((m) => m.type === "STATE"), false);
  const skip = h.messages.find((m) => m.type === "SKIP_RESULT");
  assert.equal(skip?.reason, "inventory_not_proven_complete");
  assert.deepEqual(skip?.recovery_hint, { action: "retry_by_runtime", retryable: true });
});

test("a last page that only repeats seen activity IDs does not complete the window", async () => {
  const h = harness({ streams: ["activity"], answers: (_endpoint, token) =>
    ({ data: replay.daily_activity, next_token: token === null ? "last" : null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 2);
  assert.equal(h.messages.some((m) => m.type === "STATE"), false);
  assert.equal(h.messages.find((m) => m.type === "SKIP_RESULT")?.reason, "inventory_not_proven_complete");
});

test("a second-page 429 reports pressure and emits a continuation-only STATE", async () => {
  const h = harness({ streams: ["readiness"], answers: (_endpoint, token) =>
    token ? { status: 429 } : { data: replay.daily_readiness, next_token: "next" } });
  await collectOuraBrowser(h.ctx, ACCESS);
  const skip = h.messages.find((m) => m.type === "SKIP_RESULT");
  assert.equal(skip?.reason, "upstream_pressure");
  assert.deepEqual(skip?.recovery_hint, { action: "retry_by_runtime", retryable: true });
  assert.deepEqual(continuationOnly(h.messages)?.resume, { start: DAY, end: DAY, nextToken: "next", lastIds: [id(301)] });
});

test("a default scan after a narrower since cursor starts full history", async () => {
  const h = harness({ streams: ["activity"], openRange: true, state: { activity: {
    account: ACCESS.account, api_v2: true, next_day: "2026-09-25",
    refresh_from: DAY, requested_since: DAY,
  } }, answers: () => ({ data: [], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls[0]?.start, initialStartDate());
});

test("a second-page request timeout is disclosed as retryable source pressure", async () => {
  const timeout = new Error("synthetic request deadline");
  timeout.name = "TimeoutError";
  const h = harness({ streams: ["activity"], answers: (_endpoint, token) =>
    token ? { error: timeout } : { data: replay.daily_activity, next_token: "next" } });
  await collectOuraBrowser(h.ctx, ACCESS);
  const skip = h.messages.find((m) => m.type === "SKIP_RESULT");
  assert.equal(skip?.reason, "upstream_pressure");
  assert.deepEqual(skip?.recovery_hint, { action: "retry_by_runtime", retryable: true });
  assert.deepEqual(continuationOnly(h.messages)?.resume, { start: DAY, end: DAY, nextToken: "next", lastIds: [id(401)] });
});

function continuationOnly(messages: EmittedMessage[]) {
  return (messages.find((m) => m.type === "STATE") as { cursor?: {
    next_day?: string; resume?: { start: string; end: string; nextToken: string; lastIds: string[] }
  } } | undefined)?.cursor;
}

test("page three pressure persists the exact readiness window and resumes the saved provider page", async () => {
  const p1 = replay.daily_readiness;
  const p2 = p1.map((row) => ({ ...row, id: id(302) }));
  const p3 = p1.map((row) => ({ ...row, id: id(303) }));
  const stopped = harness({ streams: ["readiness"], answers: (_endpoint, token) =>
    token === null ? { data: p1, next_token: "p2" } :
      token === "p2" ? { data: p2, next_token: "p3" } : { status: 429 } });
  await collectOuraBrowser(stopped.ctx, ACCESS);
  const cursor = continuationOnly(stopped.messages);
  assert.deepEqual(cursor?.resume, { start: DAY, end: DAY, nextToken: "p3", lastIds: [id(302)] });
  assert.equal(cursor?.next_day, undefined);
  assert.equal(stopped.messages.some((m) => m.type === "DETAIL_COVERAGE"), false);

  const recovered = harness({ streams: ["readiness"], state: { readiness: cursor }, answers: (_endpoint, token) =>
    token === "p3" ? { data: p3, next_token: null } : { status: 404 } });
  await collectOuraBrowser(recovered.ctx, ACCESS);
  assert.deepEqual(recovered.calls.map((call) => call.token), ["p3"]);
  assert.deepEqual([...stopped.records, ...recovered.records].map(({ data }) => data.id), [id(301), id(302), id(303)]);
  assert.equal(continuationOnly(recovered.messages)?.resume, undefined);
  assert.equal(continuationOnly(recovered.messages)?.next_day, "2026-09-24");
});

test("a refused saved token restarts exactly once from the same window head", async () => {
  const cursor = { account: ACCESS.account, api_v2: true, requested_since: DAY,
    resume: { start: DAY, end: DAY, nextToken: "expired", lastIds: [id(302)] } };
  const h = harness({ streams: ["readiness"], state: { readiness: cursor }, answers: (_endpoint, token) =>
    token ? { status: 400 } : { data: replay.daily_readiness, next_token: null } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map((call) => call.token), ["expired", null]);
  assert.equal(continuationOnly(h.messages)?.resume, undefined);
  assert.equal(continuationOnly(h.messages)?.next_day, "2026-09-24");
});

test("a saved token with partial page-identity overlap restarts before emitting that page", async () => {
  const cursor = { account: ACCESS.account, api_v2: true, requested_since: DAY,
    resume: { start: DAY, end: DAY, nextToken: "inconsistent", lastIds: [id(302), id(304)] } };
  const shifted = [302, 303].map((n) => ({ ...replay.daily_readiness[0], id: id(n) }));
  const h = harness({ streams: ["readiness"], state: { readiness: cursor }, answers: (_endpoint, token) =>
    token ? { data: shifted, next_token: "should-not-be-read" } : { data: replay.daily_readiness, next_token: null } });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.calls.map((call) => call.token), ["inconsistent", null]);
  assert.deepEqual(h.records.map(({ data }) => data.id), [id(301)]);
  assert.equal(continuationOnly(h.messages)?.resume, undefined);
});
