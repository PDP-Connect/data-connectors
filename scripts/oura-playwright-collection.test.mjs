// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const script = readFileSync(
  join(root, "artifacts/oura-playwright/oura-playwright-3.1.0/script.js"),
  "utf8",
);

const apiResponse = (status, json = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json,
  headers: {},
});

const record = (id, extra = {}) => ({
  id,
  day: "2026-10-01",
  score: 80,
  timestamp: "2026-10-01T00:00:00Z",
  contributors: {},
  ...extra,
});

async function runConnector({ requestedScopes, collectionResponse }) {
  const data = new Map();
  const calls = [];
  const page = {
    requestedScopes: () => requestedScopes,
    url: async () => "https://developer.ouraring.com/applications",
    evaluate: async (source) => {
      if (source.includes("location.origin ===")) return true;
      if (source.includes("localStorage.getItem")) {
        return { accessToken: "mock-cached-token", expiresAt: Date.now() + 60 * 60 * 1000 };
      }
      return "shown";
    },
    httpFetch: async (url) => {
      const parsed = new URL(url);
      const endpoint = parsed.pathname.split("/").at(-1);
      const nextToken = parsed.searchParams.get("next_token");
      calls.push({ endpoint, nextToken, url });
      if (endpoint === "daily_activity" && parsed.searchParams.get("start_date") === parsed.searchParams.get("end_date")) {
        return apiResponse(200, { data: [] });
      }
      return collectionResponse({ endpoint, nextToken, url, calls });
    },
    setData: async (key, value) => { data.set(key, JSON.parse(JSON.stringify(value))); },
    setProgress: async () => {},
    sleep: async () => {},
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Date,
    console: { error: () => {} },
    page,
    setTimeout,
    clearTimeout,
  });
  await vm.runInContext(script, context, { filename: "oura-playwright-3.1.0/script.js" });
  return { data, calls };
}

test("marks a 50-page cursor cap as degraded while retaining collected rows", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: ({ nextToken }) => {
      const page = nextToken ? Number(nextToken) : 0;
      return apiResponse(200, { data: [record(`readiness-${page}`)], next_token: String(page + 1) });
    },
  });

  assert.equal(data.get("result")["oura.readiness"].days.length, 50);
  assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 50, ok: false } });
  assert.match(data.get("result").errors[0].reason, /incomplete|truncated/i);
  assert.equal(data.get("result").errors[0].code, "api_scope_degraded");
});

test("marks a repeated cursor as degraded while retaining collected rows", async () => {
  const { data, calls } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: ({ nextToken }) =>
      apiResponse(200, { data: [record(nextToken || "first")], next_token: "repeat" }),
  });

  assert.equal(
    calls.filter(({ endpoint }) => endpoint === "daily_readiness").length,
    2,
    "the repeated cursor must not be fetched twice",
  );
  assert.equal(data.get("result")["oura.readiness"].days.length, 2);
  assert.equal(data.get("scopeCounts")["oura.readiness"].ok, false);
  assert.equal(data.get("result").errors[0].code, "api_scope_degraded");
});

test("treats a 200 response without data as a failed request, not an empty account", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: () => apiResponse(200, { foo: "bar" }),
  });

  assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 0, ok: false } });
  assert.equal(data.get("result").errors[0].code, "api_all_failed");
});

test("treats a null row in a 200 response as malformed", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: () => apiResponse(200, { data: [null] }),
  });

  assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 0, ok: false } });
  assert.equal(data.get("result").errors[0].code, "api_all_failed");
});

test("writes scope counts when Oura rejects the token during collection", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: () => apiResponse(401, { data: [] }),
  });

  assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 0, ok: false } });
  assert.equal(data.get("result").errors[0].code, "token_rejected");
});

test("writes scope counts when collection throws", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness"],
    collectionResponse: () => { throw new Error("mock fetch exploded"); },
  });

  assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 0, ok: false } });
  assert.equal(data.get("result").errors[0].code, "unexpected");
});

test("counts sleep daily scores when no sleep periods are returned", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.sleep"],
    collectionResponse: ({ endpoint }) =>
      apiResponse(200, { data: endpoint === "daily_sleep" ? [record("sleep-score")] : [] }),
  });

  assert.equal(data.get("result").exportSummary.count, 1);
});

for (const statuses of [[403, 500], [500, 403]]) {
  test(`classifies mixed sleep endpoint failures ${statuses.join(", ")} as upstream failure`, async () => {
    const { data } = await runConnector({
      requestedScopes: ["oura.sleep"],
      collectionResponse: ({ endpoint }) =>
        apiResponse(endpoint === "daily_sleep" ? statuses[0] : statuses[1]),
    });

    assert.equal(data.get("result").errors[0].code, "api_all_failed");
    assert.equal(data.get("result").errors[0].errorClass, "upstream_error");
  });
}

test("preserves the normal three-scope result", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.readiness", "oura.sleep", "oura.activity"],
    collectionResponse: ({ endpoint }) => apiResponse(200, {
      data: endpoint === "daily_sleep" ? [] : [record(endpoint)],
    }),
  });

  assert.deepEqual(data.get("scopeCounts"), {
    "oura.readiness": { found: 1, ok: true },
    "oura.sleep": { found: 1, ok: true },
    "oura.activity": { found: 1, ok: true },
  });
  assert.deepEqual(data.get("result").exportSummary, {
    count: 3,
    label: "days of Oura data",
    details: { readiness: 1, sleepScores: 0, sleepPeriods: 1, activity: 1 },
  });
  assert.deepEqual(data.get("result").errors, []);
});
