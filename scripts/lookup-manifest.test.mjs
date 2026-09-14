// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The lookup's DECISION TABLE, exercised directly.
//
// scripts/publish-tag-guard.test.mjs is the evidence that matters: it runs the
// workflow's real shell against a loopback registry and reads the version tag
// back afterwards. This file is narrower and complements it — the classifier is
// the component whose whole job is to be conservative, and the table has more
// entries than it is worth spawning a shell and a registry for. Every row here
// is a response shape a real registry can produce.
//
// The property under test is one-directional and it is the only one worth
// stating: `absent` is reachable ONLY from a 404 at the manifest endpoint that
// carries MANIFEST_UNKNOWN or NAME_UNKNOWN. Everything else — including every
// response whose prose says "not found" — must be `unknown`, because `absent`
// is what authorises moving a released version tag onto new bytes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyManifestResponse,
  lookupManifest,
  parseBearerChallenge,
  parseDistributionErrorCodes,
} from "./lookup-manifest.mjs";

const DIGEST = "sha256:" + "a".repeat(64);
const errorBody = (code, message) => JSON.stringify({ errors: [{ code, message }] });

test("a 200 with the registry's digest header is present", () => {
  const result = classifyManifestResponse({
    status: 200,
    headers: { "docker-content-digest": DIGEST },
    body: "{}",
  });
  assert.deepEqual(result, { outcome: "present", digest: DIGEST });
});

test("a 404 carrying MANIFEST_UNKNOWN is the only ordinary absence", () => {
  const result = classifyManifestResponse({
    status: 404,
    headers: {},
    body: errorBody("MANIFEST_UNKNOWN", "manifest unknown"),
  });
  assert.equal(result.outcome, "absent");
});

test("a 404 carrying NAME_UNKNOWN is an absence too — the repository has no manifests at all", () => {
  const result = classifyManifestResponse({
    status: 404,
    headers: {},
    body: errorBody("NAME_UNKNOWN", "repository name not known to registry"),
  });
  assert.equal(result.outcome, "absent");
});

// THE TABLE. Each row is a response that a prose match would have accepted, or
// that is otherwise easy to mistake for an answer. None of them establishes
// that this manifest does not exist, so none of them may be `absent`.
for (const { label, response } of [
  {
    label: "a 403 whose message contains 'not found'",
    response: { status: 403, headers: {}, body: errorBody("DENIED", "repository not found or access denied") },
  },
  {
    label: "a 500 whose message contains 'not found'",
    response: { status: 500, headers: {}, body: errorBody("UNKNOWN", "backend error: upstream object not found") },
  },
  {
    label: "a 401 challenge that was never satisfied",
    response: { status: 401, headers: {}, body: errorBody("UNAUTHORIZED", "authentication required") },
  },
  {
    label: "a 404 with no distribution error body at all — a proxy, not the registry",
    response: { status: 404, headers: {}, body: "" },
  },
  {
    label: "a 404 whose body is an HTML error page saying Not Found",
    response: { status: 404, headers: {}, body: "<html><body>404 Not Found</body></html>" },
  },
  {
    label: "a 404 carrying some other distribution code",
    response: { status: 404, headers: {}, body: errorBody("UNSUPPORTED", "not found") },
  },
  {
    label: "a 404 whose MESSAGE says MANIFEST_UNKNOWN but whose CODE does not",
    response: { status: 404, headers: {}, body: errorBody("DENIED", "MANIFEST_UNKNOWN") },
  },
  {
    label: "a 200 with no digest header",
    response: { status: 200, headers: {}, body: "{}" },
  },
  {
    label: "a 200 whose digest header is not a sha256",
    response: { status: 200, headers: { "docker-content-digest": "sha512:" + "b".repeat(128) }, body: "{}" },
  },
  {
    label: "a 429 rate limit",
    response: { status: 429, headers: {}, body: errorBody("TOOMANYREQUESTS", "not found in quota window") },
  },
  {
    label: "a 302 redirect, which is not an answer",
    response: { status: 302, headers: { location: "https://elsewhere.invalid/" }, body: "" },
  },
]) {
  test(`${label} is unknown, never absent`, () => {
    const result = classifyManifestResponse(response);
    assert.equal(
      result.outcome,
      "unknown",
      `${label} must not authorise republication: ${JSON.stringify(result)}`,
    );
  });
}

test("a token-endpoint failure never becomes an answer about the manifest", async () => {
  // The reviewer's counterexample, at the level where it originates. The
  // manifest request is issued once, is challenged, and the token exchange
  // fails — so the manifest is NEVER successfully queried. The old classifier
  // saw the client render this as `404: Not Found` and republished.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/token")) {
      return { status: 404, headers: {}, body: errorBody("NOT_FOUND", "token service: realm not found") };
    }
    return {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="https://auth.invalid/token",service="registry"' },
      body: errorBody("UNAUTHORIZED", "authentication required"),
    };
  };

  const result = await lookupManifest({
    registry: "registry.invalid",
    name: "connector/ynab",
    tag: "0.3.0",
    fetchImpl,
  });

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /token endpoint/);
  // And it stopped there: no second manifest request was issued on a token it
  // never obtained.
  assert.equal(seen.filter((url) => url.includes("/manifests/")).length, 1);
});

test("a transport failure is unknown, not an absence", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const result = await lookupManifest({
    registry: "registry.invalid",
    name: "connector/ynab",
    tag: "0.3.0",
    fetchImpl,
  });
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /ECONNREFUSED/);
});

test("the happy path completes the token handshake and asks about the right reference", async () => {
  // The control that stops "refuse everything" from passing this file. It also
  // pins the URL: an answer about a different reference is not an answer.
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push(url);
    if (url.includes("/token")) return { status: 200, headers: {}, body: JSON.stringify({ token: "t" }) };
    if (!options.headers.authorization) {
      return {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://auth.invalid/token",service="registry"' },
        body: errorBody("UNAUTHORIZED", "authentication required"),
      };
    }
    return { status: 200, headers: { "docker-content-digest": DIGEST }, body: "{}" };
  };

  const result = await lookupManifest({
    registry: "registry.invalid",
    name: "connector/ynab",
    tag: "0.3.0",
    fetchImpl,
  });

  assert.deepEqual(result, { outcome: "present", digest: DIGEST });
  assert.ok(
    seen.every((url) => !url.includes("/manifests/") || url.endsWith("/v2/connector/ynab/manifests/0.3.0")),
    `every manifest request must name the requested reference: ${seen.join(", ")}`,
  );
});

test("error codes are read from the structure, never from free text", () => {
  assert.deepEqual(parseDistributionErrorCodes(errorBody("MANIFEST_UNKNOWN", "x")), ["MANIFEST_UNKNOWN"]);
  // Lowercase in the wild; the comparison is case-insensitive by normalising.
  assert.deepEqual(parseDistributionErrorCodes('{"errors":[{"code":"name_unknown"}]}'), ["NAME_UNKNOWN"]);
  // None of these are a code, and none may yield one.
  assert.deepEqual(parseDistributionErrorCodes("<html>MANIFEST_UNKNOWN</html>"), []);
  assert.deepEqual(parseDistributionErrorCodes(""), []);
  assert.deepEqual(parseDistributionErrorCodes('{"message":"MANIFEST_UNKNOWN"}'), []);
  assert.deepEqual(parseDistributionErrorCodes('{"errors":"MANIFEST_UNKNOWN"}'), []);
});

test("only a Bearer challenge starts a token exchange", () => {
  assert.equal(parseBearerChallenge('Basic realm="registry"'), null);
  assert.equal(parseBearerChallenge(undefined), null);
  // A Bearer challenge with no realm has nowhere to send the request.
  assert.equal(parseBearerChallenge("Bearer service=registry"), null);
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://auth.invalid/token",service="registry"'), {
    realm: "https://auth.invalid/token",
    service: "registry",
  });
});
