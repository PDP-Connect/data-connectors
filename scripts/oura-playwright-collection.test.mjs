// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
// The newest committed oura-playwright source directory, so a new version is
// covered the moment its directory lands beside the tarball.
const OURA_VERSION = readdirSync(join(root, "artifacts/oura-playwright"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^oura-playwright-\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name.replace("oura-playwright-", ""))
  .sort((a, b) => { const [x, y] = [a, b].map((v) => v.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })
  .at(-1);
const script = readFileSync(
  join(root, `artifacts/oura-playwright/oura-playwright-${OURA_VERSION}/script.js`),
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
    credentialSource("const PORTAL_API_ATTEMPTS =", "const VEIL_SOURCE ="),
    "const evaluateSettled = (source) => page.evaluate(source);",
    credentialSource("const PORTAL_FETCH_SOURCE =", "const portalApi ="),
    credentialSource("const portalApi =", "// The authorization-code flow"),
    credentialSource("const findApiApplication =", "// One step of submitting"),
    credentialSource("const requestTokens =", "// On Oura's consent screen"),
    "globalThis.connector = { portalApi, findApiApplication, requestTokens };",
  ].join("\n");
  const context = vm.createContext({ URLSearchParams, page, console: { error: () => {} } });
  vm.runInContext(source, context, { filename: "oura-playwright-credentials.js" });
  return context.connector;
};

// A page whose fetch answers from a scripted status sequence; the in-page
// retry's setTimeout runs without delay. Returns the page and the call log.
const sequencedPage = (statuses, body) => {
  const calls = [];
  const page = {
    evaluate: async (source) => vm.runInNewContext(source, {
      setTimeout: (fn) => fn(),
      fetch: async (path, init) => {
        const status = statuses[Math.min(calls.length, statuses.length - 1)];
        calls.push({ path, headers: init?.headers, credentials: init?.credentials });
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
      },
    }),
    setData: async () => {},
  };
  return { page, calls };
};

const authorizeAttemptHarness = (redirectError) => {
  const source = [
    "let currentStep = null;",
    "const STEPS = { authorize: 'authorize' };",
    "const CODES = { authorizeDeclined: 'authorize_declined' };",
    "const createPkcePair = async () => ({ state: 'expected-state', challenge: 'challenge', verifier: 'verifier' });",
    "const workingState = () => ({});",
    "const showOverlay = async () => {};",
    "const buildAuthorizeUrl = () => 'https://moi.ouraring.com/oauth/authorize';",
    "const safeGoto = async () => true;",
    "const APP_REDIRECT_URI = 'https://app.example.test/redirect';",
    "const isOnRedirect = (url) => url.startsWith(APP_REDIRECT_URI);",
    "const currentUrl = async () => APP_REDIRECT_URI;",
    "const waitFor = async (check) => check();",
    "const INTERACTION_TIMEOUT_MS = 1;",
    "const readRedirectParams = async () => ({ error: redirectError });",
    "const makeFatalRunError = (errorClass, code, reason, step) => {",
    "  const error = new Error(reason);",
    "  error.telemetryError = { errorClass, code, reason, step };",
    "  return error;",
    "};",
    credentialSource("const runAuthorizeAttempt =", "// ── Auth orchestration"),
    "globalThis.connector = { runAuthorizeAttempt };",
  ].join("\n");
  const context = vm.createContext({ console: { error: () => {} }, redirectError });
  vm.runInContext(source, context, { filename: "oura-playwright-authorize.js" });
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

async function runConnector({ requestedScopes, collectionResponse, failCachedTokenRead = false }) {
  const data = new Map();
  const calls = [];
  const setDataCalls = [];
  const page = {
    requestedScopes: () => requestedScopes,
    url: async () => "https://developer.ouraring.com/applications",
    evaluate: async (source) => {
      if (source.includes("location.origin ===")) return true;
      if (source.includes("localStorage.getItem")) {
        if (failCachedTokenRead) throw new Error("mock cached-token read failed");
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
    setData: async (key, value) => {
      setDataCalls.push(key);
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
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
  await vm.runInContext(script, context, { filename: `oura-playwright-${OURA_VERSION}/script.js` });
  return { data, calls, setDataCalls };
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
    attempts: 1,
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

test("does not propagate a raw OAuth redirect error into its failure reason", async () => {
  const canary = "CANARY_SECRET_xyz";
  const { runAuthorizeAttempt } = authorizeAttemptHarness(canary);

  let error;
  await assert.rejects(
    () => runAuthorizeAttempt("client-id", "person@example.test", null, false),
    (caught) => {
      error = caught;
      return true;
    },
  );
  assert.ok(error?.telemetryError, error?.stack || String(error));
  assert.equal(error.telemetryError.code, "authorize_declined");
  assert.doesNotMatch(error?.message || "", new RegExp(canary));
  assert.match(error?.message || "", /OAuth error/);
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
  assert.equal(
    data.get("result").errors[0].reason,
    "pagination was truncated for daily_readiness; oura.readiness data is incomplete.",
  );
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

for (const [label, row] of [
  ["array", [1]],
  ["class instance", new (class OuraRow {})()],
]) {
  test(`treats a ${label} row in a 200 response as malformed`, async () => {
    const { data } = await runConnector({
      requestedScopes: ["oura.readiness"],
      collectionResponse: () => apiResponse(200, { data: [row] }),
    });

    assert.deepEqual(data.get("scopeCounts"), { "oura.readiness": { found: 0, ok: false } });
    assert.equal(data.get("result").errors[0].code, "api_all_failed");
  });
}

for (const [label, options] of [
  ["requested scope validation fails", { requestedScopes: ["oura.bogus"] }],
  ["cached-token access fails before collection starts", {
    requestedScopes: ["oura.readiness"],
    failCachedTokenRead: true,
  }],
]) {
  test(`does not write scope counts when ${label}`, async () => {
    const { setDataCalls } = await runConnector({
      ...options,
      collectionResponse: () => apiResponse(200, { data: [] }),
    });

    assert.equal(setDataCalls.filter((key) => key === "scopeCounts").length, 0);
  });
}

test("labels a failed endpoint as a request failure, not a truncation", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.sleep"],
    collectionResponse: ({ endpoint }) =>
      endpoint === "daily_sleep" ? apiResponse(500) : apiResponse(200, { data: [record("sleep")] }),
  });

  assert.equal(
    data.get("result").errors[0].reason,
    "Oura API request failed for daily_sleep; oura.sleep data is incomplete.",
  );
  assert.equal(data.get("result").errors[0].code, "api_scope_degraded");
});

test("names both failed and truncated endpoints in a degraded scope", async () => {
  const { data } = await runConnector({
    requestedScopes: ["oura.sleep"],
    collectionResponse: ({ endpoint, nextToken }) => {
      if (endpoint === "daily_sleep") return apiResponse(500);
      return apiResponse(200, { data: [record(nextToken || "first")], next_token: "repeat" });
    },
  });

  assert.equal(
    data.get("result").errors[0].reason,
    "Oura API request failed for daily_sleep and pagination was truncated for sleep; oura.sleep data is incomplete.",
  );
  assert.equal(data.get("result").errors[0].code, "api_scope_degraded");
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

// The portal's CDN answers a share of API calls with an edge-generated 401
// for a valid session (2026-10-08). The in-page fetch retries those before
// the connector reads the session as stale.
test("portal API retries edge 401s and reads the first real answer", async () => {
  const app = { client_id: "cid", application_name: "Personal access", redirect_uris: ["https://vana.org/oauth/oura/callback"], scopes: ["daily"], application_status: "active" };
  const { page, calls } = sequencedPage([401, 401, 403, 200], [app]);
  const { portalApi } = credentialHarness(page);
  const listed = JSON.parse(JSON.stringify(await portalApi("GET", "/applications")));
  assert.equal(listed.status, 200);
  assert.equal(listed.attempts, 4);
  assert.equal(listed.apps[0].clientId, "cid");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.path === "/api/extapi/v2/oauth/applications" && call.credentials === "include"));
});

test("portal API gives up on a 401 that survives every attempt", async () => {
  const { page, calls } = sequencedPage([401], []);
  const { portalApi, findApiApplication } = credentialHarness(page);
  const listed = JSON.parse(JSON.stringify(await portalApi("GET", "/applications")));
  assert.equal(listed.status, 401);
  assert.equal(listed.attempts, 12);
  assert.equal(calls.length, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(await findApiApplication())), { clientId: null, unauthorized: true });
});

// The portal bounces /applications -> /signin -> /applications right after a
// sign-in; a page call made during the bounce is destroyed and made again.
const settledHarness = (page, settles) => {
  const source = [
    "const PORTAL_CALL_RETRIES = 3;",
    credentialSource("const isDestroyedContext =", "// ── Page state detection"),
    "globalThis.connector = { evaluateSettled };",
  ].join("\n");
  const context = vm.createContext({
    page,
    console: { error: () => {} },
    waitForPortalSettled: async () => { settles.push(1); return true; },
  });
  vm.runInContext(source, context, { filename: "oura-playwright-settled.js" });
  return context.connector;
};

test("a page call destroyed by the portal's navigation is made again once the page settles", async () => {
  const settles = [];
  let calls = 0;
  const page = {
    evaluate: async () => {
      calls += 1;
      if (calls < 3) throw new Error("page.evaluate: Execution context was destroyed, most likely because of a navigation.");
      return "answer";
    },
  };
  const { evaluateSettled } = settledHarness(page, settles);
  assert.equal(await evaluateSettled("1"), "answer");
  assert.equal(calls, 3);
  assert.equal(settles.length, 2, "waited for the portal to settle after each destroyed call");
});

test("a page call that keeps dying, or dies for another reason, is not retried forever", async () => {
  const settles = [];
  let calls = 0;
  const dying = { evaluate: async () => { calls += 1; throw new Error("Execution context was destroyed"); } };
  await assert.rejects(() => settledHarness(dying, settles).evaluateSettled("1"), /Execution context was destroyed/);
  assert.equal(calls, 3);
  assert.equal(settles.length, 2, "no settle wait after the final attempt");
  calls = 0;
  const other = { evaluate: async () => { calls += 1; throw new Error("ReferenceError: nope"); } };
  await assert.rejects(() => settledHarness(other, settles).evaluateSettled("1"), /nope/);
  assert.equal(calls, 1, "a script error is not a navigation and is not retried");
});

// The document-start veil runs before Oura's page exists. It must never
// append to a document without a root element (that would make the veil the
// root and drop the page), and it must leave non-Oura hosts alone.
const veilSource = () => {
  const consts = script.match(/const VEIL_SAFETY_MS = \d+;/)[0];
  const def = script.match(/const VEIL_SOURCE = `[\s\S]*?`;\n/)[0];
  return vm.runInNewContext(`${consts}\n${def}\nVEIL_SOURCE`, {});
};

const fakeDocument = (hostname) => {
  const appended = [];
  const timers = [];
  const root = { appendChild: (el) => appended.push(el) };
  const element = () => ({ id: "", attrs: {}, children: [], textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  const document = { documentElement: null, getElementById: () => null, createElement: element, addEventListener: () => {} };
  const context = { document, location: { hostname }, sessionStorage: { getItem: () => null }, window: {}, setTimeout: (fn, ms) => timers.push({ fn, ms }) };
  return { context, document, root, appended, timers };
};

test("the veil waits for the root element instead of appending to the document", () => {
  const { context, document, root, appended, timers } = fakeDocument("moi.ouraring.com");
  vm.runInNewContext(veilSource(), context);
  assert.equal(appended.length, 0, "nothing appended while the document has no root");
  const deferred = timers.filter((t) => t.ms === 0);
  assert.equal(deferred.length, 1, "one deferred redraw scheduled");
  document.documentElement = root;
  deferred[0].fn();
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, "vana-oura-veil");
  assert.match(appended[0].attrs.style, /position:fixed;inset:0;z-index:2147483647/);
  assert.equal(typeof context.window.__vanaOuraRemoveVeil, "function");
});

test("the veil draws at once when the root exists and stays off other hosts", () => {
  const ready = fakeDocument("moi.ouraring.com");
  ready.document.documentElement = ready.root;
  vm.runInNewContext(veilSource(), ready.context);
  assert.equal(ready.appended.length, 1);
  const other = fakeDocument("vana.org");
  other.document.documentElement = other.root;
  vm.runInNewContext(veilSource(), other.context);
  assert.equal(other.appended.length, 0, "no veil on the redirect host");
  assert.equal(other.context.window.__vanaOuraRemoveVeil, undefined);
});
