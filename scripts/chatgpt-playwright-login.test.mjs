// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// chatgpt-playwright's login check must not depend on the page's language.
// Up to 4.0.1 it read English button labels ("log in", "sign up") and took any
// <nav> as the signed-in sidebar, so a signed-out visitor on a localized page
// was treated as signed in and the run failed with "Could not extract email".
// These tests run the connector's own helpers against a fake page.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
// The newest committed chatgpt-playwright source directory.
const VERSION = readdirSync(join(root, "artifacts/chatgpt-playwright"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^chatgpt-playwright-\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name.replace("chatgpt-playwright-", ""))
  .sort((a, b) => { const [x, y] = [a, b].map((v) => v.split(".").map(Number)); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })
  .at(-1);
const script = readFileSync(
  join(root, `artifacts/chatgpt-playwright/chatgpt-playwright-${VERSION}/script.js`),
  "utf8",
);

const helperSource = (() => {
  const start = script.indexOf("// Dismiss interrupting popups");
  const end = script.indexOf("// ─── Checkpoint store");
  assert.notEqual(start, -1, "missing helper block start");
  assert.notEqual(end, -1, "missing helper block end");
  return script.slice(start, end);
})();

// A fake host page: `evaluate` runs the connector's in-page code against a
// fake document, location and fetch.
function fakePage({ hostname = "chatgpt.com", session, navs = 0, selectors = [], scripts = [] }) {
  return {
    async evaluate(code) {
      const location = { hostname };
      const document = {
        querySelector: (selector) => (selectors.includes(selector) ? {} : null),
        querySelectorAll: (selector) => {
          if (selector === "script") return scripts.map((textContent) => ({ textContent }));
          if (selector === "nav") return new Array(navs).fill({});
          return [];
        },
        getElementById: () => null,
        cookie: "oai-did=device-1",
      };
      const window = {};
      const fetch = async () => {
        if (session instanceof Error) throw session;
        return { ok: session.ok, json: async () => session.body };
      };
      void location; void document; void window; void fetch;
      return eval(code);
    },
  };
}

function helpers(options) {
  const build = new Function(
    "page",
    `${helperSource}; return { checkLoginStatus, extractEmail, getAuthCredentials };`,
  );
  return build(fakePage(options));
}

const signedOut = { ok: true, body: {} };
const signedIn = { ok: true, body: { accessToken: "token-1", user: { email: "person@example.com" } } };
const blocked = { ok: false, body: null };

test(`chatgpt-playwright@${VERSION}: a signed-out localized page is not signed in`, async () => {
  // No English "log in" label, and a <nav> on the landing page.
  const { checkLoginStatus } = helpers({ session: signedOut, navs: 2 });
  assert.equal(await checkLoginStatus(), false);
});

test(`chatgpt-playwright@${VERSION}: the session endpoint signs in and yields email and token`, async () => {
  const api = helpers({ session: signedIn, navs: 1 });
  assert.equal(await api.checkLoginStatus(), true);
  assert.equal(await api.extractEmail(), "person@example.com");
  assert.deepEqual(await api.getAuthCredentials(), { userToken: "token-1", deviceId: "device-1" });
});

test(`chatgpt-playwright@${VERSION}: an inline-script email still wins`, async () => {
  const filler = "x".repeat(120);
  const api = helpers({ session: signedIn, scripts: [`${filler}"email":"inline@example.com"`] });
  assert.equal(await api.extractEmail(), "inline@example.com");
});

test(`chatgpt-playwright@${VERSION}: the session is trusted only on chatgpt.com`, async () => {
  for (const hostname of ["auth.openai.com", "evilchatgpt.com"]) {
    const api = helpers({ hostname, session: signedIn });
    assert.equal(await api.checkLoginStatus(), false, hostname);
    assert.equal(await api.extractEmail(), null, hostname);
  }
  assert.equal(await helpers({ hostname: "www.chatgpt.com", session: signedIn }).checkLoginStatus(), true);
});

test(`chatgpt-playwright@${VERSION}: an unreadable session falls back to positive page signals only`, async () => {
  assert.equal(await helpers({ session: blocked, navs: 3 }).checkLoginStatus(), false);
  assert.equal(
    await helpers({ session: blocked, selectors: ['nav a[href^="/c/"]'] }).checkLoginStatus(),
    true,
  );
  assert.equal(
    await helpers({ session: new Error("network"), selectors: ['[data-testid="profile-button"]'] }).checkLoginStatus(),
    true,
  );
});
