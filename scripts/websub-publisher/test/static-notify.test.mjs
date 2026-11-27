// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { notifyHub, HUB_URL } from "../static-notify.mjs";
import { TOPIC_URL } from "../static-feed.mjs";

const feed = "<feed>signed catalog hint</feed>";
const digest = createHash("sha256").update(feed).digest("hex");

test("the hub is notified only after the canonical topic matches the deployed bytes", async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === TOPIC_URL) return new Response(feed, { headers: { "content-type": "application/atom+xml" } });
    if (url === HUB_URL) return new Response(null, { status: 202 });
    assert.fail(`unexpected URL ${url}`);
  };
  await notifyHub({ expectedSha256: digest, fetcher });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, TOPIC_URL);
  assert.equal(calls[1].url, HUB_URL);
  const body = new URLSearchParams(calls[1].options.body);
  assert.equal(body.get("hub.mode"), "publish");
  assert.equal(body.get("hub.url"), TOPIC_URL);
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(calls[1].options.redirect, "manual");
});

test("stale, invalid, redirected or oversized topic responses never notify the hub", async () => {
  for (const response of [
    () => new Response("stale", { headers: { "content-type": "application/atom+xml" } }),
    () => new Response(feed, { headers: { "content-type": "text/html" } }),
    () => new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
    () => new Response("x".repeat(65537), { headers: { "content-type": "application/atom+xml" } }),
  ]) {
    let calls = 0;
    await assert.rejects(notifyHub({ expectedSha256: digest, fetcher: async () => { calls++; return response(); } }));
    assert.equal(calls, 1);
  }
});

test("a bad expected hash or a rejected hub request fails visibly", async () => {
  let calls = 0;
  await assert.rejects(notifyHub({ expectedSha256: "invalid", fetcher: async () => { calls++; } }));
  assert.equal(calls, 0);
  await assert.rejects(notifyHub({ expectedSha256: digest, fetcher: async (url) => {
    calls++;
    return url === TOPIC_URL
      ? new Response(feed, { headers: { "content-type": "application/atom+xml" } })
      : new Response(null, { status: 503 });
  } }));
  assert.equal(calls, 2);
});
