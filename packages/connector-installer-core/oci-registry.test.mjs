// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The classification rules that came with `lookup-manifest.mjs` when its logic
// moved into installer-core, plus the consumer-only additions.
//
// These travel WITH the rule rather than staying with the publisher, because
// the rule is now enforced in two repositories' worth of callers and a rule
// whose tests live somewhere else drifts. The publisher's copy keeps its own.

import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyManifestResponse,
  cosignSignatureTag,
  isValidConnectorKey,
  parseBearerChallenge,
  parseConnectorOciReference,
  parseDistributionErrorCodes,
  parseOciReference,
  sha256Digest,
} from "./oci-registry.mjs";

/** A 200 whose header agrees with its body, which is the only present shape. */
function present(bodyText) {
  return {
    status: 200,
    headers: { "docker-content-digest": sha256Digest(Buffer.from(bodyText, "utf8")) },
    body: bodyText,
  };
}

test("a 200 whose digest header matches its bytes is present", () => {
  const result = classifyManifestResponse(present('{"schemaVersion":2}'));
  assert.equal(result.outcome, "present");
  assert.match(result.digest, /^sha256:[0-9a-f]{64}$/);
});

test("a 200 whose digest header contradicts its bytes is unknown", () => {
  // Two independent claims about one content-addressed object. A registry that
  // disagrees with itself has not answered the question, and picking either
  // claim over the other would be inventing an answer.
  const result = classifyManifestResponse({
    status: 200,
    headers: { "docker-content-digest": sha256Digest(Buffer.from("different", "utf8")) },
    body: '{"schemaVersion":2}',
  });
  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /does not match/);
});

test("a 404 carrying MANIFEST_UNKNOWN is the only ordinary absence", () => {
  assert.equal(
    classifyManifestResponse({
      status: 404,
      body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "unknown" }] }),
    }).outcome,
    "absent"
  );
});

test("a 404 carrying NAME_UNKNOWN is an absence too", () => {
  assert.equal(
    classifyManifestResponse({
      status: 404,
      body: JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }),
    }).outcome,
    "absent"
  );
});

test("error codes are read from the structure, never from free text", () => {
  // The defect this rule exists to prevent: promoting registry prose to a
  // decision. A 403 that happens to say "not found" is still a 403.
  assert.equal(
    classifyManifestResponse({
      status: 403,
      body: JSON.stringify({ errors: [{ code: "DENIED", message: "manifest not found" }] }),
    }).outcome,
    "unknown"
  );
  assert.deepEqual(parseDistributionErrorCodes('{"message":"MANIFEST_UNKNOWN"}'), []);
  assert.deepEqual(parseDistributionErrorCodes("<html>not found</html>"), []);
});

test("a 404 mixing an absence code with a denial is unknown, not absent", () => {
  // The reply asserts two things, one of which says the request was not
  // allowed to ask. A self-contradicting reply has established nothing.
  assert.equal(
    classifyManifestResponse({
      status: 404,
      body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }, { code: "DENIED" }] }),
    }).outcome,
    "unknown"
  );
});

test("a 404 mixing a clean absence code with an unreadable entry is unknown", () => {
  // An entry without a string code poisons the array rather than being
  // skipped: the error that could not be read may be the important one.
  assert.equal(parseDistributionErrorCodes(JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }, {}] })), null);
  assert.equal(
    classifyManifestResponse({
      status: 404,
      body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }, {}] }),
    }).outcome,
    "unknown"
  );
});

test("a 404 whose errors array is empty establishes nothing", () => {
  assert.equal(
    classifyManifestResponse({ status: 404, body: JSON.stringify({ errors: [] }) }).outcome,
    "unknown"
  );
});

test("only a Bearer challenge starts a token exchange", () => {
  assert.equal(parseBearerChallenge('Basic realm="registry"'), null);
  assert.equal(parseBearerChallenge(undefined), null);
  assert.equal(parseBearerChallenge("Bearer service=nope"), null);
  assert.deepEqual(parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io"'), {
    realm: "https://ghcr.io/token",
    service: "ghcr.io",
  });
});

test("the cosign signature tag is the digest with its separator rewritten", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(cosignSignatureTag(digest), `sha256-${"a".repeat(64)}.sig`);
  assert.throws(() => cosignSignatureTag("not-a-digest"));
});

test("a connector key that could never have been published is refused", () => {
  // The publisher's own predicate. `apple_contacts` is a real manifest key that
  // is not a legal OCI path component, so it is refused here rather than
  // becoming a request to a repository that cannot exist.
  assert.ok(isValidConnectorKey("apple-health"));
  assert.ok(!isValidConnectorKey("apple_contacts"));
  assert.ok(!isValidConnectorKey("-leading"));
  assert.ok(!isValidConnectorKey("Upper"));
  assert.ok(!isValidConnectorKey(""));
});

test("only GHCR is accepted, and a lock cannot widen that", () => {
  assert.throws(
    () => parseOciReference({ registry: "evil.example", repository: "pdp-connect/connector/ynab", version: "1.0.0" }),
    (error) => error.reason === "untrusted-registry"
  );
  assert.throws(
    () => parseOciReference({ registry: "ghcr.io", repository: "pdp-connect/connector/ynab" }),
    (error) => error.reason === "invalid-reference"
  );
});

test("a reference is split on @digest before :tag", () => {
  // A digest contains a colon, so a right-to-left tag split would cut
  // `sha256:abc…` in half and produce a repository that does not exist.
  const digest = `sha256:${"b".repeat(64)}`;
  const byDigest = parseConnectorOciReference(`ghcr.io/pdp-connect/connector/ynab@${digest}`);
  assert.deepEqual(byDigest, {
    registry: "ghcr.io",
    repository: "pdp-connect/connector/ynab",
    connectorKey: "ynab",
    digest,
    version: null,
  });

  const byTag = parseConnectorOciReference("ghcr.io/pdp-connect/connector/ynab:0.3.0");
  assert.equal(byTag.version, "0.3.0");
  assert.equal(byTag.digest, null);
  assert.equal(byTag.repository, "pdp-connect/connector/ynab");

  assert.throws(
    () => parseConnectorOciReference("ghcr.io/pdp-connect/connector/ynab@sha256:short"),
    (error) => error.reason === "invalid-reference"
  );
});
