// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { declareReady, main } from "../declare-catalog-ready.mjs";

const env = {
  CATALOG_PUBLISHER_URL: "https://publisher.example/ready",
  CATALOG_PUBLISHER_AUDIENCE: "catalog-publisher",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://vstoken.actions.githubusercontent.com/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-actions-request-token",
};
const record = {
  schema: "pdpp.catalog.ready.v1",
  repository: "ghcr.io/pdp-connect/connector-catalog",
  digest: `sha256:${"a".repeat(64)}`,
  source_commit: "b".repeat(40),
  generated_at: "2026-10-29T12:00:00.000Z",
};
const token = "eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0Ijp0cnVlfQ.c2lnbmF0dXJl";

function brokenBodyResponse(status = 200, failure = new TypeError("connection lost while reading body")) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      controller.error(failure);
    },
  }), { status });
}

test("a lost declaration response is retried and an idempotent acknowledgement succeeds", async () => {
  let calls = 0;
  const delays = [];
  const fetcher = async () => {
    calls++;
    if (calls === 1) return Response.json({ value: token });
    if (calls === 2) throw new TypeError("connection lost");
    return Response.json({ duplicate: true }, { status: 200 });
  };
  assert.equal((await declareReady(record, env, fetcher, async (ms) => delays.push(ms))).duplicate, true);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1000]);
});

test("a token response body transport failure is retried", async () => {
  for (const failure of [
    new TypeError("connection lost while reading body"),
    Object.assign(new Error("request timed out while reading body"), { name: "AbortError" }),
  ]) {
    let calls = 0;
    const delays = [];
    const fetcher = async () => {
      calls++;
      if (calls === 1) return brokenBodyResponse(200, failure);
      if (calls === 2) return Response.json({ value: token });
      return Response.json({ accepted: true }, { status: 202 });
    };
    assert.equal((await declareReady(record, env, fetcher, async (ms) => delays.push(ms))).accepted, true);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [1000]);
  }
});

test("a declaration response body transport failure is retried idempotently", async () => {
  for (const failure of [
    new TypeError("connection lost while reading body"),
    Object.assign(new Error("request timed out while reading body"), { name: "AbortError" }),
  ]) {
    let calls = 0;
    const delays = [];
    const fetcher = async () => {
      calls++;
      if (calls === 1) return Response.json({ value: token });
      if (calls === 2) return brokenBodyResponse(202, failure);
      return Response.json({ duplicate: true }, { status: 200 });
    };
    assert.equal((await declareReady(record, env, fetcher, async (ms) => delays.push(ms))).duplicate, true);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [1000]);
  }
});

test("body-read failures stop after three attempts", async () => {
  for (const declaration of [false, true]) {
    let calls = 0;
    const delays = [];
    await assert.rejects(declareReady(record, env, async () => {
      calls++;
      if (declaration && calls === 1) return Response.json({ value: token });
      return brokenBodyResponse(declaration ? 202 : 200);
    }, async (ms) => delays.push(ms)), /response body read failed/);
    assert.equal(calls, declaration ? 4 : 3);
    assert.deepEqual(delays, [1000, 2000]);
  }
});

test("invalid or oversized success bodies are explicit failures without retries", async () => {
  for (const [response, declaration] of [
    [new Response("not-json"), false],
    [new Response(`{"value":"${"x".repeat(33_000)}"}`), false],
    [new Response("not-json"), true],
  ]) {
    let calls = 0;
    await assert.rejects(declareReady(record, env, async () => {
      calls++;
      if (declaration && calls === 1) return Response.json({ value: token });
      return response;
    }));
    assert.equal(calls, declaration ? 2 : 1);
  }
});

test("success is immediate, permanent rejections are not retried, and transient retries are bounded", async () => {
  for (const status of [202, 403, 503]) {
    let calls = 0;
    const delays = [];
    const fetcher = async () => {
      calls++;
      if (calls === 1) return Response.json({ value: token });
      return status === 202 ? Response.json({ accepted: true }, { status }) : new Response("", { status });
    };
    const result = declareReady(record, env, fetcher, async (ms) => delays.push(ms));
    if (status === 202) await assert.doesNotReject(result);
    else await assert.rejects(result);
    assert.equal(calls, status === 503 ? 4 : 2);
    assert.deepEqual(delays, status === 503 ? [1000, 2000] : []);
  }
});

test("publisher configuration is checked before a release, without making a request", async () => {
  await assert.doesNotReject(main(["--check-config"], {}));
  await assert.doesNotReject(main(["--check-config"], env));
  await assert.rejects(main(["--check-config"], { CATALOG_PUBLISHER_URL: env.CATALOG_PUBLISHER_URL }));
});
