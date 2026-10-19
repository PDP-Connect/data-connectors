// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { ensureOuraApiAccess } from "./api-access.ts";

const PORTAL = "https://developer.ouraring.com/applications";

test("synthetic 3.1.2 flow registers an owner app, checks OAuth state and caches the scoped token", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousFetch = globalThis.fetch;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  const calls: string[] = [];
  let current = PORTAL;
  Object.defineProperty(globalThis, "location", { configurable: true, get: () => new URL(current) });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/auth/get-session") return Response.json({ user: { email: "synthetic@example.test" } });
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
      assert.equal(new URL(url).origin, "https://moi.ouraring.com");
      const state = new URL(url).searchParams.get("state");
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
  }
});
