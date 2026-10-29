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

type Answer = { data?: Array<Record<string, unknown>>; next_token?: string | null; status?: number };
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
  const sessions = [{ ...replay.sleep[0], id: id(601), day: BOUNDARY }];
  const scores = [{ ...replay.daily_sleep[0], id: id(602), day: BOUNDARY }];
  const h = harness({ streams: ["sleep"], ...WINDOW, answers: (endpoint, token, window) =>
    inclusiveWindow(endpoint === "sleep" ? sessions : scores)(endpoint, token, window) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.records.map(({ data }) => [data.record_type, data.id]),
    [["sleep_session", id(601)], ["daily_score", id(602)]]);
  noSkip(h);
});

test("of two copies of one id, the copy with more filled fields is kept", async () => {
  const sparse = { ...replay.daily_readiness[0], id: id(502), day: BOUNDARY, timestamp: `${BOUNDARY}T08:15:00+00:00`, score: null };
  const full = { ...sparse, score: 77 };
  // The first chunk returns the sparse copy; the second chunk returns the full copy.
  const h = harness({ streams: ["readiness"], ...WINDOW, answers: (_endpoint, _token, window) =>
    ({ data: [window.start === "2026-08-01" ? sparse : full], next_token: null }) });
  await collectOuraBrowser(h.ctx, ACCESS);
  assert.deepEqual(h.records.map(({ data }) => [data.id, data.score]), [[id(502), 77]]);
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
