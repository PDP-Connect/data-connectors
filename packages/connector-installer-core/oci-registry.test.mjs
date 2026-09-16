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
  checkTokenRealm,
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

// The token-realm destination policy, moved from the publisher's
// `lookup-manifest.test.mjs` with the function it tests. The publisher checks
// this to protect a credential; this consumer sends none, so what it protects
// against is narrower — a registry naming an arbitrary origin, including a
// local port, that this process then issues a GET to on the peer's say-so.
// The policy is the same either way, and so are the cases.

test("the token-realm policy admits the registry's own origin and the documented GHCR realm", () => {
  // The control that stops "refuse every realm" from passing the checks below.
  // The documented GHCR shape — the one this repository actually pulls from —
  // must keep working, or the strictness below is just an outage.
  assert.equal(checkTokenRealm(new URL("https://ghcr.io/token"), "ghcr.io", {}), null);
  assert.equal(checkTokenRealm(new URL("https://registry.example/token"), "registry.example", {}), null);
  assert.equal(checkTokenRealm(new URL("https://auth.docker.io/token"), "registry-1.docker.io", {}), null);
  // The default port is not a different origin from no port: `URL` normalises
  // both sides, so the policy is about the authority and not its spelling.
  assert.equal(checkTokenRealm(new URL("https://ghcr.io:443/token"), "ghcr.io", {}), null);
  assert.equal(
    checkTokenRealm(new URL("https://registry.example:5000/token"), "registry.example:5000", {}),
    null,
  );

  // And the refusals, each for its own reason.
  assert.match(
    checkTokenRealm(new URL("http://ghcr.io/token"), "ghcr.io", {}),
    /non-HTTPS/,
    "plaintext is refused even on the right host",
  );
  assert.match(
    checkTokenRealm(new URL("https://evil.invalid/token"), "ghcr.io", {}),
    /neither the registry origin/,
  );
  // A subdomain of the registry is NOT the registry. Widening to one is an edit
  // to the policy, not something a peer can arrange with a challenge.
  assert.match(
    checkTokenRealm(new URL("https://auth.ghcr.io/token"), "ghcr.io", {}),
    /neither the registry origin/,
  );

  // The test hook widens the policy to loopback plaintext and no further.
  assert.equal(
    checkTokenRealm(new URL("http://127.0.0.1:5000/token"), "127.0.0.1:5000", {
      allowInsecureLoopback: true,
    }),
    null,
  );
  assert.match(
    checkTokenRealm(new URL("http://registry.example/token"), "registry.example", {
      allowInsecureLoopback: true,
    }),
    /non-HTTPS/,
    "the hook must not permit plaintext to a routable host",
  );
  // On loopback the PORT is part of the authority. Two ports on 127.0.0.1 are
  // two different servers, so the hook must not turn "it's loopback" into
  // "reach anything on this machine".
  assert.match(
    checkTokenRealm(new URL("http://127.0.0.1:6001/token"), "127.0.0.1:5000", {
      allowInsecureLoopback: true,
    }),
    /neither the registry origin/,
    "the hook must not redirect the request to a different loopback port",
  );
});

test("a token realm on the registry's host but a different PORT is a different service", () => {
  // The port is part of the authority everywhere, not only on loopback. A
  // hostname is not a service: whatever is listening on ghcr.io:9443 is not the
  // registry, and a registry published on :5000 challenging to :6000 is naming
  // whatever else happens to be bound on that host. Comparing hostnames — which
  // is what this module did before the policy was carried over — accepted both.
  assert.match(
    checkTokenRealm(new URL("https://ghcr.io:9443/token"), "ghcr.io", {}),
    /neither the registry origin/,
    "a non-default port on the registry's own host is a different origin",
  );
  assert.match(
    checkTokenRealm(new URL("https://registry.example:6000/token"), "registry.example:5000", {}),
    /neither the registry origin/,
    "a registry on :5000 must not accept a realm on :6000",
  );
  // And the other direction of the same mistake: a registry addressed WITH a
  // port must not accept a realm that drops it.
  assert.match(
    checkTokenRealm(new URL("https://registry.example/token"), "registry.example:5000", {}),
    /neither the registry origin/,
    "a registry on :5000 must not accept a realm on the default port",
  );
});

test("an IPv6 loopback realm is compared as the URL parser spelled it", () => {
  // `URL` brackets and compresses IPv6 literals on both sides, so the two
  // spellings of the same address compare equal and a different port does not.
  assert.equal(
    checkTokenRealm(new URL("http://[::1]:5000/token"), "[::1]:5000", {
      allowInsecureLoopback: true,
    }),
    null,
  );
  assert.equal(
    checkTokenRealm(new URL("http://[0:0:0:0:0:0:0:1]:5000/token"), "[::1]:5000", {
      allowInsecureLoopback: true,
    }),
    null,
  );
  assert.match(
    checkTokenRealm(new URL("http://[::1]:6001/token"), "[::1]:5000", {
      allowInsecureLoopback: true,
    }),
    /neither the registry origin/,
  );
});
