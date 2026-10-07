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

const credentialSource = (start, end) => {
  const startAt = script.indexOf(start);
  const endAt = script.indexOf(end, startAt);
  assert.notEqual(startAt, -1, `missing credential source starting with ${start}`);
  assert.notEqual(endAt, -1, `missing credential source ending with ${end}`);
  return script.slice(startAt, endAt);
};

const credentialHarness = (page) => {
  const source = [
    "let currentStep = null;",
    "const STEPS = { portalApp: 'portal_app', token: 'token' };",
    "const CODES = { appListFailed: 'portal_app_list_failed', tokenRequestFailed: 'token_request_failed' };",
    "const TOKEN_URL = 'https://api.example.test/token';",
    "const makeFatalRunError = (errorClass, code, reason, step) => {",
    "  const error = new Error(reason);",
    "  error.telemetryError = { errorClass, code, reason, step };",
    "  return error;",
    "};",
    credentialSource("const portalApi =", "// The authorization-code flow"),
    credentialSource("const findApiApplication =", "// One step of submitting"),
    credentialSource("const requestTokens =", "// On Oura's consent screen"),
    "globalThis.connector = { portalApi, findApiApplication, requestTokens };",
  ].join("\n");
  const context = vm.createContext({ URLSearchParams, page });
  vm.runInContext(source, context, { filename: "oura-playwright-credentials.js" });
  return context.connector;
};

const assertPayloadsHide = (payloads, forbidden) => {
  assert.doesNotMatch(JSON.stringify(payloads), new RegExp(forbidden));
};

const captureCredentialFailure = async (page, error) => {
  const telemetryError = error.telemetryError;
  await page.setData("result", { errors: [telemetryError] });
  await page.setData("errorDetail", {
    errorClass: telemetryError.errorClass,
    code: telemetryError.code,
    step: telemetryError.step,
  });
  await page.setData("error", telemetryError.reason);
};

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

test("uses no Math.random in the connector source", () => {
  assert.doesNotMatch(script, /Math\.random/);
});

test("creates a cryptographic, prefixed OAuth state with each PKCE pair", async () => {
  const createPkcePair = credentialSource("const createPkcePair =", "const buildAuthorizeUrl");
  const templateContext = vm.createContext({ page: { evaluate: (source) => source } });
  vm.runInContext(`${createPkcePair}\nglobalThis.evaluateString = createPkcePair();`, templateContext);
  const evaluateString = await templateContext.evaluateString;
  assert.equal(typeof evaluateString, "string", "createPkcePair must evaluate a page-side PKCE generator");
  assert.ok(globalThis.crypto, "Node must expose WebCrypto globally");
  assert.ok(globalThis.btoa, "Node must expose btoa globally");

  const context = { crypto: globalThis.crypto, btoa: globalThis.btoa, TextEncoder: globalThis.TextEncoder };
  const first = await vm.runInNewContext(evaluateString, context);
  const second = await vm.runInNewContext(evaluateString, context);

  assert.match(first.state, /^vana-[A-Za-z0-9_-]{22,}$/);
  assert.match(second.state, /^vana-[A-Za-z0-9_-]{22,}$/);
  assert.notEqual(first.state, second.state);
});

test("does not propagate raw token failures while keeping a whitelisted OAuth code", async () => {
  const canary = "CANARY_SECRET_xyz";
  const payloads = [];
  const page = {
    httpFetch: async () => ({
      ok: false,
      status: 400,
      json: { error: "invalid_grant", error_description: canary },
      error: canary,
    }),
    setData: async (key, value) => { payloads.push({ key, value }); },
  };
  const { requestTokens } = credentialHarness(page);

  let error;
  await assert.rejects(
    () => requestTokens({ grant_type: "authorization_code", code: "mock-code" }, "client-id", "client-secret"),
    (caught) => {
      error = caught;
      return caught?.telemetryError?.code === "token_request_failed";
    },
  );
  assert.match(error.message, /invalid_grant/);
  assert.doesNotMatch(error.message, new RegExp(canary));
  await captureCredentialFailure(page, error);
  assertPayloadsHide(payloads, canary);
});

test("does not propagate raw portal application-list failure text", async () => {
  const canary = "CANARY_SECRET_xyz";
  const payloads = [];
  const page = {
    evaluate: async (source) => vm.runInNewContext(source, {
      fetch: async () => ({
        ok: false,
        status: 502,
        text: async () => JSON.stringify({ detail: canary }),
      }),
    }),
    setData: async (key, value) => { payloads.push({ key, value }); },
  };
  const { portalApi, findApiApplication } = credentialHarness(page);

  assert.deepEqual(JSON.parse(JSON.stringify(await portalApi("GET", "/applications"))), {
    ok: false,
    status: 502,
    apps: null,
    detail: null,
  });
  let error;
  await assert.rejects(
    () => findApiApplication(),
    (caught) => {
      error = caught;
      return caught?.telemetryError?.code === "portal_app_list_failed";
    },
  );
  assert.doesNotMatch(error.message, new RegExp(canary));
  await captureCredentialFailure(page, error);
  assertPayloadsHide(payloads, canary);
});

test("does not interpolate a raw OAuth redirect error into its failure reason", () => {
  const redirectFailure = credentialSource("if (redirect?.error)", "if (!redirect?.code)");
  assert.doesNotMatch(redirectFailure, /\$\{redirect\.error\}/);
  assert.match(redirectFailure, /\^\[a-z_\]\{1,40\}\$/);
});

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
