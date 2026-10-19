// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { ensureOuraApiAccess, probeOuraCachedApiAccess, probeOuraSignInInProgress } from "./api-access.ts";

const PORTAL = "https://developer.ouraring.com/applications";

test("synthetic 3.1.2 flow registers an owner app, checks OAuth state and caches the scoped token", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const storage = new Map<string, string>();
  const calls: string[] = [];
  let current = PORTAL;
  let signedIn = false;
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => new URL(current) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null, querySelectorAll: () => [] } });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/auth/get-session") return Response.json(signedIn ? { user: { email: "synthetic@example.test" } } : null);
    if (path === "/api/extapi/v2/oauth/applications") return Response.json(
      calls.some((call) => call.startsWith("POST /api/extapi/v2/oauth/registration"))
        ? [{ client_id: "synthetic-app", client_secret: "synthetic-secret", application_name: "Personal access", redirect_uris: ["https://vana.org/oauth/oura/callback"], scopes: ["extapi:daily"] }]
        : [],
    );
    if (path === "/api/extapi/v2/oauth/registration") return Response.json({ ok: true });
    return Response.json({}, { status: 404 });
  };
  const page = Object.assign(Object.create(null) as Page, {
    goto: async (url: string) => { current = url; },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    context: () => ({ request: {
      get: async () => ({ status: () => 200, dispose: async () => {} }),
      post: async (_url: string, options: { data: string }) => {
        assert.match(options.data, /code_verifier=/);
        assert.match(options.data, /code=synthetic-code/);
        return { ok: () => true, status: () => 200,
          json: async () => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 }),
          dispose: async () => {} };
      },
    } }),
  });
  try {
    const token = await ensureOuraApiAccess(page, async (url, _message, ready) => {
      if (url === PORTAL) {
        current = "https://moi.ouraring.com/authn/authentication/default";
        assert.equal(await ready(), false);
        current = "https://moi.ouraring.com/authn/enter-otp";
        assert.equal(await ready(), false);
        signedIn = true;
        current = PORTAL;
        assert.equal(await ready(), true);
        return;
      }
      assert.equal(new URL(url).origin, "https://moi.ouraring.com");
      const state = new URL(url).searchParams.get("state");
      current = "https://moi.ouraring.com/authn/authentication/default_ext";
      assert.equal(await ready(), false);
      current = "https://moi.ouraring.com/authn/enter-otp";
      assert.equal(await probeOuraCachedApiAccess(page), null);
      assert.equal(current, "https://moi.ouraring.com/authn/enter-otp");
      assert.equal(await ready(), false);
      current = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize?consent=1";
      assert.equal(await ready(), false);
      current = `https://vana.org/oauth/oura/callback?code=synthetic-code&state=${state}`;
      assert.equal(await ready(), true);
    });
    assert.equal(token, "synthetic-access");
    assert.ok(calls.includes("POST /api/extapi/v2/oauth/registration"));
    assert.equal(JSON.parse(storage.get("vana:oura-connector:token") ?? "null").accessToken, token);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("a stale portal session signs out and offers a fresh sign-in", { timeout: 120_000 }, async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  let current = PORTAL;
  let signedIn = true;
  let stale = true;
  let signOuts = 0;
  let signIns = 0;
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => new URL(current) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/auth/get-session")
      return Response.json(signedIn ? { user: { email: "synthetic@example.test" } } : null);
    if (path === "/api/extapi/v2/oauth/applications")
      return stale ? Response.json({}, { status: 401 }) : Response.json([{
        client_id: "synthetic-app", client_secret: "synthetic-secret", application_name: "Personal access",
        redirect_uris: ["https://vana.org/oauth/oura/callback"], scopes: ["extapi:daily"],
      }]);
    if (path === "/api/auth/sign-out") {
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/json");
      signOuts++;
      signedIn = false;
      return Response.json({});
    }
    return Response.json({}, { status: 404 });
  };
  const page = Object.assign(Object.create(null) as Page, {
    goto: async (url: string) => { current = url; },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => {
      try { return await fn(arg); }
      catch (error) { throw new Error(`PageShim evaluation failed: ${String(error)}`); }
    },
    context: () => ({ request: {
      get: async () => ({ status: () => 200, dispose: async () => {} }),
      post: async () => ({ ok: () => true, status: () => 200,
        json: async () => ({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
        dispose: async () => {} }),
    } }),
  });
  try {
    const access = await ensureOuraApiAccess(page, async (url, _message, ready) => {
      if (url.startsWith("https://developer.ouraring.com")) {
        signIns++;
        assert.equal(signOuts, 1, "stale session is ended before asking for sign-in");
        current = url;
        assert.equal(await ready(), false);
        current = "https://moi.ouraring.com/authn/authentication/default";
        assert.equal(await ready(), false);
        current = "https://moi.ouraring.com/authn/enter-otp";
        assert.equal(await ready(), false);
        signedIn = true;
        stale = false;
        current = PORTAL;
        assert.equal(await ready(), true);
      } else {
        const state = new URL(url).searchParams.get("state");
        current = `https://vana.org/oauth/oura/callback?code=synthetic-code&state=${state}`;
        assert.equal(await ready(), true);
      }
    });
    assert.equal(access, "fresh-access");
    assert.equal(signOuts, 1);
    assert.equal(signIns, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("an OTP page survives a cached-token probe during sign-in", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  let current = "https://moi.ouraring.com/authn/enter-otp";
  const visits: string[] = [];
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => new URL(current) });
  const page = Object.assign(Object.create(null) as Page, {
    goto: async (url: string) => { visits.push(url); current = url; },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
  });
  try {
    assert.equal(await probeOuraSignInInProgress(page), true);
    assert.equal(await probeOuraCachedApiAccess(page), null);
    assert.equal(current, "https://moi.ouraring.com/authn/enter-otp");
    assert.deepEqual(visits, []);
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
