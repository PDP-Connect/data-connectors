// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { PublisherState } from "../worker.mjs";
import { atom } from "../catalog.mjs";
import { DOMParser } from "@xmldom/xmldom";

test("the public Atom feed identifies its author for both empty and populated feeds", () => {
  const config = { topic: "https://publisher.example/topic", hub: "https://hub.example/" };
  const record = {
    schema: "pdpp.catalog.ready.v1",
    repository: "ghcr.io/pdp-connect/connector-catalog",
    digest: `sha256:${"a".repeat(64)}`,
    source_commit: "b".repeat(40),
    generated_at: "2026-10-29T12:00:00.000Z",
  };
  for (const value of [null, record]) {
    const doc = new DOMParser().parseFromString(atom(value, config), "application/xml");
    const authors = doc.documentElement.getElementsByTagNameNS("http://www.w3.org/2005/Atom", "author");
    assert.ok(authors.length > 0);
    assert.ok(authors[0].getElementsByTagNameNS("http://www.w3.org/2005/Atom", "name")[0].textContent);
  }
});

test("a ready declaration schedules publication immediately after its durable write", async () => {
  const values = new Map();
  let alarm;
  const tx = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, value),
    setAlarm: async (value) => {
      alarm = value;
    },
  };
  const storage = { transaction: async (callback) => callback(tx) };
  const env = {
    TOPIC_URL: "https://publisher.example/topic",
    HUB_URL: "https://hub.example/",
    OIDC_AUDIENCE: "catalog-audience",
    PUBLISHER: {},
  };
  const publisher = new PublisherState({ storage }, env);
  const record = {
    schema: "pdpp.catalog.ready.v1",
    repository: "ghcr.io/pdp-connect/connector-catalog",
    digest: `sha256:${"a".repeat(64)}`,
    source_commit: "b".repeat(40),
    generated_at: "2026-10-29T12:00:00.000Z",
  };
  const identity = { run: 1, attempt: 1, runId: "1" };
  const before = Date.now();
  const result = await publisher.fetch(
    new Request("https://state/ready", { method: "POST", body: JSON.stringify({ record, identity }) }),
  );
  const after = Date.now();
  assert.equal(result.status, 202);
  assert.equal(values.get("state").pending, true);
  assert.ok(alarm >= before && alarm <= after);
});
