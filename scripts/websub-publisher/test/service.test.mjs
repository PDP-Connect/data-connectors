// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { test, before, after } from "node:test";
import { setTimeout as cooldown } from "node:timers/promises";
import { declareReady } from "../declare-catalog-ready.mjs";
import assert from "node:assert/strict";
import { readFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { DOMParser } from "@xmldom/xmldom";
import { ISSUER, JWKS_URL, WORKFLOW } from "../config.mjs";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(packageDir, ".runtime/tests");
const sha = "b".repeat(40),
  digest = (n) => "sha256:" + n.repeat(64);
const record = (n) => ({
  schema: "pdpp.catalog.ready.v1",
  repository: "ghcr.io/pdp-connect/connector-catalog",
  digest: digest(n),
  source_commit: sha,
  generated_at: "2026-10-29T12:00:00.000Z",
});
const audience = "catalog-publisher-production";
const bindings = {
  TOPIC_URL: "https://publisher.example/topic",
  HUB_URL: "https://hub.example/",
  OIDC_AUDIENCE: audience,
};
let key, jwk, bundle;
before(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  key = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(key.publicKey)), alg: "RS256", kid: "local-test-root" };
  const result = await build({
    entryPoints: [resolve(packageDir, "test/harness.mjs")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    write: false,
  });
  bundle = result.outputFiles[0].text;
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});
async function token(overrides = {}, privateKey = key.privateKey, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISSUER,
    aud: audience,
    sub: "repo:PDP-Connect@306241814/data-connectors@1304197983:ref:refs/heads/main",
    repository: "PDP-Connect/data-connectors",
    repository_owner_id: "306241814",
    repository_id: "1304197983",
    ref: "refs/heads/main",
    workflow_ref: WORKFLOW,
    sha,
    run_id: "100",
    run_number: "1",
    run_attempt: "1",
    iat: now,
    nbf: now,
    exp: now + 300,
    ...overrides,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: jwk.kid, ...header }).sign(privateKey);
}
let serial = 0;
async function runtime(options = {}) {
  const path = options.persist ?? resolve(root, String(++serial));
  const calls = [];
  let hub = options.hub ?? (() => new Response("unavailable", { status: 503 }));
  let keys = [jwk];
  const jwks = options.jwks ?? (() => Response.json({ keys }));
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: "2026-07-30",
    log: new Log(LogLevel.NONE),
    bindings: { ...bindings, ...options.bindings },
    durableObjects: { PUBLISHER: { className: "PublisherState", useSQLite: true } },
    durableObjectsPersist: path,
    outboundService: async (request) => {
      if (request.url === JWKS_URL) return jwks(request);
      assert.equal(request.url, bindings.HUB_URL, "no unconfigured outbound destination");
      calls.push({ url: request.url, body: await request.text(), redirect: request.redirect });
      return hub(request);
    },
  });
  const ns = await mf.getDurableObjectNamespace("PUBLISHER");
  const stub = ns.get(ns.idFromName("catalog"));
  return {
    mf,
    calls,
    path,
    setHub: (fn) => {
      hub = fn;
    },
    setKeys: (value) => {
      keys = value;
    },
    fetch: (path, init) => mf.dispatchFetch(`https://publisher.example${path}`, init),
    ready: async (r = record("a"), claims = {}, auth) =>
      mf.dispatchFetch("https://publisher.example/ready", {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth ?? (await token(claims))}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(r),
      }),
    inspect: async () => (await stub.fetch("https://state/__inspect")).json(),
    alarm: () => stub.fetch("https://state/__alarm"),
  };
}
function semantic(xml) {
  const errors = [];
  const doc = new DOMParser({ onError: (level, msg) => errors.push(`${level}: ${msg}`) }).parseFromString(
    xml,
    "application/xml",
  );
  assert.deepEqual(errors, []);
  const elements = (parent, name) =>
    [...parent.childNodes].filter(
      (n) => n.nodeType === 1 && n.namespaceURI === "http://www.w3.org/2005/Atom" && n.localName === name,
    );
  const text = (p, name) => elements(p, name)[0]?.textContent;
  const feed = doc.documentElement;
  assert.equal(feed.namespaceURI, "http://www.w3.org/2005/Atom");
  assert.equal(feed.localName, "feed");
  return {
    id: text(feed, "id"),
    title: text(feed, "title"),
    updated: text(feed, "updated"),
    links: elements(feed, "link").map((n) => ({ rel: n.getAttribute("rel"), href: n.getAttribute("href") })),
    entries: elements(feed, "entry").map((e) => ({
      id: text(e, "id"),
      title: text(e, "title"),
      updated: text(e, "updated"),
      type: elements(e, "content")[0].getAttribute("type"),
      content: JSON.parse(text(e, "content")),
    })),
  };
}

test("HTTP Worker + SQLite DO start empty; Atom matches shared fixture semantically", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  const empty = await r.fetch("/topic");
  assert.match(empty.headers.get("content-type"), /application\/atom\+xml/);
  assert.equal(semantic(await empty.text()).entries.length, 0);
  assert.equal((await r.ready()).status, 202);
  const actual = semantic(await (await r.fetch("/topic")).text());
  const fixture = semantic(
    await readFile(resolve(packageDir, "test/fixtures/catalog-ready.atom"), "utf8"),
  );
  fixture.id = bindings.TOPIC_URL;
  fixture.links.find((l) => l.rel === "self").href = bindings.TOPIC_URL;
  assert.deepEqual(actual, fixture);
  const state = await r.inspect();
  assert.equal(state.state.pending, true);
  assert.equal(typeof state.alarm, "number");
});

test("OIDC signature and every policy claim fail closed through actual Worker HTTP", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  const wrongKey = await generateKeyPair("RS256");
  assert.equal((await r.ready(record("a"), {}, await token({}, wrongKey.privateKey))).status, 401);
  const wrongAlgorithm = await generateKeyPair("RS512");
  assert.equal(
    (await r.ready(record("a"), {}, await token({}, wrongAlgorithm.privateKey, { alg: "RS512" }))).status,
    401,
  );
  assert.equal((await r.ready(record("a"), {}, "unsigned.invalid.jwt")).status, 401);
  assert.equal((await r.fetch("/ready", { method: "POST" })).status, 401);
  const now = Math.floor(Date.now() / 1000);
  const bad = {
    iss: "https://evil.example",
    aud: "wrong",
    sub: "repo:PDP-Connect/data-connectors:ref:refs/heads/main",
    repository: "PDP-Connect/evil",
    repository_owner_id: "1",
    repository_id: "2",
    ref: "refs/heads/feature",
    workflow_ref: WORKFLOW.replace("refs/heads/main", "refs/tags/main"),
    sha: "invalid",
    run_id: "0",
    run_number: "-1",
    run_attempt: "1e2",
    exp: now - 20,
    iat: now + 100,
    nbf: now + 100,
  };
  for (const [claim, value] of Object.entries(bad)) {
    assert.equal((await r.ready(record("a"), { [claim]: value })).status, 401, `rejected ${claim}`);
    assert.equal((await r.ready(record("a"), { [claim]: undefined })).status, 401, `missing ${claim}`);
  }
  assert.equal((await r.ready(record("a"), { aud: [audience, "other"] })).status, 401);
  assert.equal((await r.ready(record("a"), { sha: [sha] })).status, 401);
  assert.equal((await r.ready(record("a"), { exp: now + 1000 })).status, 401);
  assert.equal(
    (await r.ready(record("a"), {}, await token({}, key.privateKey, { kid: "missing" }))).status,
    401,
  );
  assert.equal((await r.fetch("/topic")).status, 200);
  assert.equal((await r.inspect()).state, undefined);
});

test("accepts the repository immutable GitHub OIDC subject and IDs", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  const claims = {
    sub: "repo:PDP-Connect@306241814/data-connectors@1304197983:ref:refs/heads/main",
    repository_owner_id: "306241814",
    repository_id: "1304197983",
  };
  assert.equal((await r.ready(record("a"), claims)).status, 202);
});

test("JWKS roots are injected only at outbound HTTP; production config cannot replace them", async (t) => {
  const r = await runtime({
    bindings: { GITHUB_JWKS: JSON.stringify({ keys: [jwk] }), TEST_AUTH_BYPASS: "true" },
  });
  t.after(() => r.mf.dispose());
  r.setKeys([]);
  assert.equal((await r.ready()).status, 401);
  // Exercise rotation in one live isolate after jose's configured cooldown.
  const rotated = await generateKeyPair("RS256");
  const rotatedJwk = { ...(await exportJWK(rotated.publicKey)), alg: "RS256", kid: "rotated" };
  r.setKeys([rotatedJwk]);
  await cooldown(5100); // test-only remote-JWKS cooldown, never a publisher sleep
  assert.equal(
    (await r.ready(record("a"), {}, await token({}, rotated.privateKey, { kid: "rotated" }))).status,
    202,
  );
});

test("JWKS availability failures return 503 for bounded client retry; invalid identities stay 401", async (t) => {
  const clientEnv = {
    CATALOG_PUBLISHER_URL: "https://publisher.example/ready",
    CATALOG_PUBLISHER_AUDIENCE: audience,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://vstoken.actions.githubusercontent.com/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-actions-request-token",
  };
  const delays = [];
  let jwksCalls = 0;
  const r = await runtime({
    jwks: async () => {
      if (++jwksCalls === 1) throw new TypeError("network unavailable");
      return Response.json({ keys: [jwk] });
    },
  });
  t.after(() => r.mf.dispose());
  const signedToken = await token();
  const fetcher = async (url, init) =>
    new URL(url).hostname.startsWith("vstoken")
      ? Response.json({ value: signedToken })
      : r.fetch("/ready", init);

  const accepted = await declareReady(record("a"), clientEnv, fetcher, async (ms) => delays.push(ms));
  assert.deepEqual(accepted, { status: 202, accepted: true });
  assert.equal(jwksCalls, 2);
  assert.deepEqual(delays, [1000]);
  assert.equal((await r.inspect()).state.pending, true);

  const wrongKey = await generateKeyPair("RS256");
  assert.equal((await r.ready(record("b"), {}, await token({}, wrongKey.privateKey))).status, 401);

  let bodyFailureCalls = 0;
  const brokenBody = await runtime({
    jwks: async () => {
      bodyFailureCalls++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"keys":'));
            setTimeout(() => controller.error(new Error("JWKS body connection interrupted")), 20);
          },
        }),
        { headers: { "content-length": "100" } },
      );
    },
  });
  t.after(() => brokenBody.mf.dispose());
  assert.equal((await brokenBody.ready()).status, 503);
  assert.equal(bodyFailureCalls, 1);

  let malformedCalls = 0;
  const malformed = await runtime({
    jwks: async () => {
      malformedCalls++;
      return new Response("not JSON");
    },
  });
  t.after(() => malformed.mf.dispose());
  const malformedDelays = [];
  await assert.rejects(
    declareReady(
      record("d"),
      clientEnv,
      async (url, init) =>
        new URL(url).hostname.startsWith("vstoken")
          ? Response.json({ value: signedToken })
          : malformed.fetch("/ready", init),
      async (ms) => malformedDelays.push(ms),
    ),
    /publisher declaration HTTP 401/,
  );
  assert.equal(malformedCalls, 1);
  assert.deepEqual(malformedDelays, []);

  const cancelFailure = await runtime({
    jwks: async () =>
      new Response(
        new ReadableStream({ cancel() { throw new Error("broken response cancellation"); } }),
        { status: 503 },
      ),
  });
  t.after(() => cancelFailure.mf.dispose());
  assert.equal((await cancelFailure.ready()).status, 503);

  let unavailableCalls = 0;
  const unavailable = await runtime({
    jwks: async () => {
      unavailableCalls++;
      return new Response("unavailable", { status: 503 });
    },
  });
  t.after(() => unavailable.mf.dispose());
  const retryDelays = [];
  await assert.rejects(
    declareReady(
      record("c"),
      clientEnv,
      async (url, init) =>
        new URL(url).hostname.startsWith("vstoken")
          ? Response.json({ value: signedToken })
          : unavailable.fetch("/ready", init),
      async (ms) => retryDelays.push(ms),
    ),
    /publisher declaration HTTP 503/,
  );
  assert.equal(unavailableCalls, 3);
  assert.deepEqual(retryDelays, [1000, 2000]);
  assert.equal((await unavailable.inspect()).state, undefined);
});

test("JWKS buffering accepts the byte limit and rejects the next byte", async (t) => {
  const prefix = JSON.stringify({ keys: [jwk], padding: "" });
  for (const [bytes, status] of [[65_536, 202], [65_537, 401]]) {
    const body = JSON.stringify({ keys: [jwk], padding: "x".repeat(bytes - Buffer.byteLength(prefix)) });
    assert.equal(Buffer.byteLength(body), bytes);
    const r = await runtime({ jwks: async () => new Response(body) });
    t.after(() => r.mf.dispose());
    assert.equal((await r.ready()).status, status);
  }
});

test("bounded body, strict schema, missing/invalid config and missing credentials", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  for (const bad of [
    null,
    [],
    {},
    { ...record("a"), repository: "ghcr.io/evil/catalog" },
    { ...record("a"), digest: "sha256:abc" },
    { ...record("a"), source_commit: "x" },
    { ...record("a"), generated_at: "2026-02-30T12:00:00.000Z" },
    { ...record("a"), hub: "https://evil.example/" },
  ])
    assert.equal((await r.ready(bad)).status, 400);
  const auth = await token();
  assert.equal(
    (
      await r.fetch("/ready", {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: " ".repeat(3000),
      })
    ).status,
    413,
  );
  const chunks = new ReadableStream({
    start(controller) {
      for (let n = 0; n < 3; n++) controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
      controller.close();
    },
  });
  assert.equal(
    (
      await r.fetch("/ready", {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: chunks,
        duplex: "half",
      })
    ).status,
    413,
  );
  assert.equal(
    (await r.fetch("/ready", { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: "{}" }))
      .status,
    415,
  );
  assert.equal(
    (
      await r.fetch("/ready", {
        method: "POST",
        headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  for (const invalid of [
    { OIDC_AUDIENCE: "" },
    { OIDC_AUDIENCE: "SET_AUDIENCE" },
    { HUB_URL: "http://hub.example/" },
    { HUB_URL: "" },
    { TOPIC_URL: "https://user:password@publisher.example/topic" },
    { TOPIC_URL: "" },
  ]) {
    const other = await runtime({ bindings: invalid });
    try {
      assert.equal((await other.ready()).status, 503);
      assert.equal((await other.fetch("/topic")).status, 503);
    } finally {
      await other.mf.dispose();
    }
  }
});

test("duplicate and stale/collision races are serialized; unchanged newer run advances ordering fence", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  const responses = await Promise.all(Array.from({ length: 8 }, () => r.ready()));
  assert.equal(responses.filter((x) => x.status === 202).length, 1);
  assert.equal(responses.filter((x) => x.status === 200).length, 7);
  assert.equal(
    (await r.ready({ ...record("a"), source_commit: "c".repeat(40) }, { run_number: "2", run_id: "101" }))
      .status,
    409,
  );
  assert.equal((await r.ready(record("c"))).status, 409);
  assert.equal((await r.ready(record("a"), { run_number: "3", run_id: "103" })).status, 200);
  assert.equal((await r.ready(record("c"), { run_number: "2", run_id: "102" })).status, 409);
  const concurrent = await Promise.all([
    r.ready(record("c"), { run_number: "4", run_id: "104" }),
    r.ready(record("d"), { run_number: "5", run_id: "105" }),
  ]);
  assert.ok(concurrent.every((x) => [202, 409].includes(x.status)));
  assert.equal((await r.inspect()).state.record.digest, digest("d"));
  assert.equal((await r.ready(record("a"), { run_number: "6", run_id: "106" })).status, 409);
  assert.equal((await r.ready(record("e"), { run_number: "5", run_id: "999" })).status, 409);
  assert.equal(
    (await r.ready(record("e"), { run_number: "5", run_id: "105", run_attempt: "2" })).status,
    202,
  );
  assert.equal(
    (await r.ready(record("d"), { run_number: "5", run_id: "105", run_attempt: "1" })).status,
    409,
  );
});

test("failed hub keeps durable work+alarm across runtime restart; success stops retry", async (t) => {
  let r = await runtime();
  const persist = r.path;
  try {
    assert.equal((await r.ready()).status, 202);
    await r.alarm();
    const failed = await r.inspect();
    assert.equal(failed.state.pending, true);
    assert.ok(failed.state.attempts >= 1);
    assert.equal(typeof failed.alarm, "number");
    for (let n = 0; n < 8; n++) await r.alarm();
    assert.ok(
      (await r.inspect()).state.attempts >= 9,
      "persistent failures outlive platform automatic retry limit",
    );
    assert.equal(typeof (await r.inspect()).alarm, "number");
    assert.equal(new URLSearchParams(r.calls[0].body).get("hub.url"), bindings.TOPIC_URL);
    assert.equal(new URLSearchParams(r.calls[0].body).get("hub.mode"), "publish");
    await r.mf.dispose();
    r = await runtime({ persist, bindings: { HUB_URL: "" } });
    await r.alarm();
    assert.equal((await r.inspect()).state.pending, true);
    assert.equal(typeof (await r.inspect()).alarm, "number", "bad redeploy retains a future retry");
    assert.equal((await r.fetch("/topic")).status, 503);
    await r.mf.dispose();
    r = await runtime({ persist });
    assert.equal((await r.inspect()).state.pending, true);
    r.setHub(() => new Response(null, { status: 204 }));
    await r.alarm();
    const done = await r.inspect();
    assert.equal(done.state.pending, false);
    assert.equal(done.alarm, null);
    assert.equal((await r.ready()).status, 200);
    await r.alarm();
    assert.equal((await r.inspect()).state.pending, false);
  } finally {
    await r.mf.dispose();
  }
});

test("in-flight hub acceptance cannot erase a newer declaration", { timeout: 15000 }, async (t) => {
  let release, started;
  const onStarted = new Promise((resolve) => {
    started = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const r = await runtime({
    hub: async () => {
      started();
      await gate;
      return new Response("", { status: 202 });
    },
  });
  t.after(() => r.mf.dispose());
  await r.ready();
  const alarm = r.alarm();
  await onStarted;
  assert.equal((await r.ready(record("c"), { run_id: "102", run_number: "2" })).status, 202);
  release();
  await alarm;
  const state = await r.inspect();
  assert.equal(state.state.record.digest, digest("c"));
  assert.equal(state.state.pending, true);
  assert.equal(typeof state.alarm, "number");
  r.setHub(() => {
    throw new Error("connection reset");
  });
  await r.alarm();
  assert.equal((await r.inspect()).state.pending, true);
});

test("Actions declaration client completes the real Worker/DO HTTP journey", async (t) => {
  const r = await runtime();
  t.after(() => r.mf.dispose());
  const env = {
    CATALOG_PUBLISHER_URL: "https://publisher.example/ready",
    CATALOG_PUBLISHER_AUDIENCE: audience,
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://vstoken.actions.githubusercontent.com/request?api-version=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret-actions-request-token",
  };
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (new URL(url).hostname === "vstoken.actions.githubusercontent.com") {
      assert.equal(new URL(url).searchParams.get("audience"), audience);
      assert.equal(new URL(url).searchParams.get("api-version"), "1");
      return Response.json({ value: await token() });
    }
    return r.mf.dispatchFetch(String(url), init);
  };
  assert.equal((await declareReady(record("a"), env, fetcher)).accepted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal((await declareReady(record("a"), env, fetcher)).duplicate, true);
  assert.equal((await r.inspect()).state.record.digest, digest("a"));
});

test(
  "restart after external hub acceptance but before response retries safely",
  { timeout: 15000 },
  async (t) => {
    let accepted, release;
    const acceptance = new Promise((resolve) => {
      accepted = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let count = 0;
    let r = await runtime({
      hub: async () => {
        count++;
        accepted();
        await gate;
        return new Response("", { status: 202 });
      },
    });
    let disposed = false;
    t.after(async () => {
      release();
      if (!disposed) await r.mf.dispose();
    });
    await r.ready();
    const inFlight = r.alarm().catch(() => null);
    await acceptance;
    const before = await r.inspect();
    assert.equal(before.state.pending, true);
    assert.equal(typeof before.alarm, "number");
    const persist = r.path;
    // Terminate workerd with the outbound response unresolved. The external system
    // has accepted the publish but no local completion transition can have committed.
    await r.mf.dispose();
    disposed = true;
    release();
    await inFlight;
    r = await runtime({
      persist,
      hub: () => {
        count++;
        return new Response("", { status: 202 });
      },
    });
    disposed = false;
    await r.alarm();
    assert.ok(count >= 2);
    assert.equal((await r.inspect()).state.pending, false);
    assert.equal((await r.inspect()).alarm, null);
  },
);

test("hub redirects fail closed without following event-independent destinations", async (t) => {
  const r = await runtime({
    hub: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
  });
  t.after(() => r.mf.dispose());
  await r.ready();
  await r.alarm();
  assert.equal((await r.inspect()).state.pending, true);
  assert.equal(r.calls.length, 1);
});

test("missing DO binding fails closed over HTTP", async () => {
  const mf = new Miniflare({
    modules: true,
    script: bundle,
    compatibilityDate: "2026-07-30",
    log: new Log(LogLevel.NONE),
    bindings,
  });
  try {
    const response = await mf.dispatchFetch("https://publisher.example/topic");
    assert.equal(response.status, 503);
  } finally {
    await mf.dispose();
  }
});

test("DO failures become visible 503 responses rather than false acceptance", async (t) => {
  const r = await runtime({ bindings: { TEST_DO_FAILURE: "1" } });
  t.after(() => r.mf.dispose());
  assert.equal((await r.ready()).status, 503);
  assert.equal((await r.fetch("/topic")).status, 503);
});

test(
  "unmodified production bundle automatically delivers its persisted alarm",
  { timeout: 10000 },
  async () => {
    const script = await readFile(resolve(packageDir, "dist/worker.mjs"), "utf8");
    let delivered;
    const publication = new Promise((resolve) => {
      delivered = resolve;
    });
    const mf = new Miniflare({
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      log: new Log(LogLevel.NONE),
      bindings,
      durableObjects: { PUBLISHER: { className: "PublisherState", useSQLite: true } },
      outboundService: async (request) => {
        if (request.url === JWKS_URL) return Response.json({ keys: [jwk] });
        assert.equal(request.url, bindings.HUB_URL);
        delivered({ method: request.method, body: await request.text() });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const response = await mf.dispatchFetch("https://publisher.example/ready", {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
        body: JSON.stringify(record("a")),
      });
      assert.equal(response.status, 202);
      // Await the runtime's actual alarm event, without invoking the handler or polling.
      const sent = await publication;
      assert.equal(sent.method, "POST");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(sent.body)), {
        "hub.mode": "publish",
        "hub.url": bindings.TOPIC_URL,
      });
    } finally {
      await mf.dispose();
    }
  },
);
