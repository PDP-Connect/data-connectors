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
import { createServer } from "node:http";
import test from "node:test";

import {
  checkTokenRealm,
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
  // The realm is the registry's own host, so the credential-destination policy
  // permits the exchange and the containment below is what is actually under
  // test — not a refusal that happened earlier for a different reason.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/token")) {
      return { status: 404, headers: {}, body: errorBody("NOT_FOUND", "token service: realm not found") };
    }
    return {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="https://registry.invalid/token",service="registry"' },
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
        headers: { "www-authenticate": 'Bearer realm="https://registry.invalid/token",service="registry"' },
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
  // An entry without a readable code poisons the array rather than being
  // dropped from it: `null` is "this array cannot be read", which is a
  // different thing from `[]`'s "this body carried no error structure", and
  // the difference is the one the caller needs to refuse absence.
  assert.equal(parseDistributionErrorCodes('{"errors":[{"code":"MANIFEST_UNKNOWN"},{}]}'), null);
  assert.equal(parseDistributionErrorCodes('{"errors":[{"code":"MANIFEST_UNKNOWN"},{"code":404}]}'), null);
  assert.equal(parseDistributionErrorCodes('{"errors":[{"code":"MANIFEST_UNKNOWN"},null]}'), null);
  // The control: a well-formed companion entry is still read, so the rule
  // above is about READABILITY and not about arrays longer than one.
  assert.deepEqual(
    parseDistributionErrorCodes('{"errors":[{"code":"MANIFEST_UNKNOWN"},{"code":"NAME_UNKNOWN"}]}'),
    ["MANIFEST_UNKNOWN", "NAME_UNKNOWN"],
  );
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

// THE HTTP CLIENT ITSELF.
//
// Everything above tests the decision table through an injected `fetchImpl`.
// The four checks below are about the real client — its deadline, its memory
// bound, and where it will send the registry credential — so they use the
// shipped `fetchOnce` against a loopback server, which is the only way a
// stub-driven test cannot reach. A misbehaving peer is the thing under test,
// so the peer has to be real.

/**
 * Run `body` against a loopback HTTP server, always closing it afterwards.
 *
 * `LOOKUP_ALLOW_INSECURE_TOKEN_REALM` has no bearing here — these call
 * `lookupManifest` directly and pass `allowInsecureLoopback` where it is
 * needed, so the env hook stays the entrypoint's concern.
 */
async function withLoopback(handler, body) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registry = `127.0.0.1:${server.address().port}`;
  try {
    return await body(registry);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// FINDING 1a: the deadline must bound the WHOLE request, not inactivity.
test("a peer that trickles bytes past the deadline is unknown, not an answer", async () => {
  // The distinction this pins: the peer is NEVER idle. It writes one byte every
  // 40ms until the client disconnects — it never stops on its own and never
  // exhausts a payload — so an inactivity timer is reset before it can ever fire
  // and the request would run forever. Only a deadline on elapsed time cuts it
  // off. That is why the assertions below bound the CLOCK and not just the
  // reason string: a test that only matched /deadline/ would also pass with the
  // deadline disabled (the peer would eventually go quiet) or with the timer
  // converted to inactivity semantics.
  //
  // The bytes it dribbles are a perfectly good MANIFEST_UNKNOWN, which is what
  // makes this the dangerous shape: the outcome that hangs forever is the one
  // that authorises republication. At 40ms/byte the ~62-byte body would take
  // ~2.5s to arrive, so an answer inside `deadlineTolerance` cannot be the
  // peer's body — it can only be the deadline.
  const timeoutMs = 120;
  const deadlineTolerance = 400;
  const payload = JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] });
  const bodyWouldTake = payload.length * 40; // ~2.5s — far past the tolerance above
  assert.ok(bodyWouldTake > deadlineTolerance * 4, "the peer's body must be far slower than the deadline");

  const started = process.hrtime.bigint();
  const result = await withLoopback(
    (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      let i = 0;
      // Cycles through the payload forever: there is no exhaustion point at
      // which this peer falls silent.
      const timer = setInterval(() => {
        res.write(payload[i++ % payload.length]);
      }, 40);
      res.on("close", () => clearInterval(timer));
    },
    (registry) =>
      lookupManifest({
        registry,
        name: "connector/ynab",
        tag: "0.3.0",
        scheme: "http",
        timeoutMs,
      }),
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(result.outcome, "unknown", `a peer that never finishes must not answer: ${JSON.stringify(result)}`);
  assert.match(result.reason, /deadline/);
  assert.ok(
    elapsedMs < deadlineTolerance,
    `the ${timeoutMs}ms deadline must bound the whole exchange, but it took ${elapsedMs.toFixed(0)}ms`,
  );
});

// FINDING 1b: the accumulated body needs a ceiling.
test("a response body past the size a manifest descriptor can be is unknown", async () => {
  // A manifest descriptor is kilobytes. This peer answers 404 and then streams
  // megabytes, which without a ceiling is accumulated in memory in full. The
  // ceiling turns it into a classification instead of a memory cost.
  const chunk = Buffer.alloc(256 * 1024, 0x20);
  const result = await withLoopback(
    (req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      let sent = 0;
      const pump = () => {
        while (sent < 8 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      pump();
    },
    (registry) =>
      lookupManifest({
        registry,
        name: "connector/ynab",
        tag: "0.3.0",
        scheme: "http",
        timeoutMs: 15000,
      }),
  );

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /exceeded .* bytes/);
});

// FINDING 2: where the Basic credential is allowed to go.
test("the Basic credential is never sent to a token realm off the registry's authority", async () => {
  // The exfiltration shape, end to end. TWO loopback servers: the registry,
  // and a collector standing in for a host the peer controls. The registry's
  // 401 points the token request — which carries the publishing credential —
  // at the collector.
  //
  // The collector is a REAL, REACHABLE server on purpose. A realm on an
  // unresolvable name would make this pass without any policy at all, because
  // DNS would refuse the connection before the credential went anywhere; that
  // proves nothing about what this script will do when the attacker's host is
  // actually up. The assertion is on what the collector RECEIVED.
  const collectorSawCredential = [];
  const collector = createServer((req, res) => {
    collectorSawCredential.push(req.headers.authorization ?? "(none)");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "t" }));
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const collectorHost = `127.0.0.1:${collector.address().port}`;

  try {
    const result = await withLoopback(
      (req, res) => {
        res.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${collectorHost}/token",service="registry"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }));
      },
      (registry) =>
        lookupManifest({
          registry,
          name: "connector/ynab",
          tag: "0.3.0",
          credential: Buffer.from("user:publishing-token").toString("base64"),
          scheme: "http",
          timeoutMs: 5000,
          // Even with the loopback hook ON — the most permissive this script
          // ever gets — a realm on a DIFFERENT authority is still refused.
          allowInsecureLoopback: true,
        }),
    );

    assert.deepEqual(
      collectorSawCredential,
      [],
      `the publishing credential must never reach a realm off the registry's authority: ${collectorSawCredential.join(", ")}`,
    );
    assert.equal(result.outcome, "unknown");
    assert.match(result.reason, /neither the registry origin/);
  } finally {
    collector.closeAllConnections?.();
    await new Promise((resolve) => collector.close(resolve));
  }
});

test("the credential-destination policy admits the registry's own origin and the documented GHCR realm", () => {
  // The control that stops "refuse every realm" from passing the check above.
  // The documented GHCR shape — the one this repository actually publishes
  // through — must keep working, or the strictness below is just an outage.
  assert.equal(checkTokenRealm(new URL("https://ghcr.io/token"), "ghcr.io", {}), null);
  assert.equal(checkTokenRealm(new URL("https://registry.example/token"), "registry.example", {}), null);
  assert.equal(checkTokenRealm(new URL("https://auth.docker.io/token"), "registry-1.docker.io", {}), null);
  // The default port is not a different origin from no port: `URL` normalises
  // both sides, so the policy is about the authority and not its spelling.
  assert.equal(checkTokenRealm(new URL("https://ghcr.io:443/token"), "ghcr.io", {}), null);
  assert.equal(checkTokenRealm(new URL("https://registry.example:5000/token"), "registry.example:5000", {}), null);

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
  // A subdomain of the registry is NOT the registry. Widening to one is an
  // edit to the policy, not something a peer can arrange with a challenge.
  assert.match(
    checkTokenRealm(new URL("https://auth.ghcr.io/token"), "ghcr.io", {}),
    /neither the registry origin/,
  );

  // The test hook widens the policy to loopback plaintext and no further.
  assert.equal(checkTokenRealm(new URL("http://127.0.0.1:5000/token"), "127.0.0.1:5000", { allowInsecureLoopback: true }), null);
  assert.match(
    checkTokenRealm(new URL("http://registry.example/token"), "registry.example", { allowInsecureLoopback: true }),
    /non-HTTPS/,
    "the hook must not permit plaintext to a routable host",
  );
  // On loopback the PORT is part of the authority. Two ports on 127.0.0.1 are
  // two different servers, so the hook must not turn "it's loopback" into
  // "send the credential anywhere on this machine".
  assert.match(
    checkTokenRealm(new URL("http://127.0.0.1:6001/token"), "127.0.0.1:5000", { allowInsecureLoopback: true }),
    /neither the registry origin/,
    "the hook must not forward the credential to a different loopback port",
  );
});

test("a token realm on the registry's host but a different PORT is a different service", () => {
  // The port is part of the authority everywhere, not only on loopback. A
  // hostname is not a service: whatever is listening on ghcr.io:9443 is not
  // the registry the publishing credential was issued for, and a registry
  // published on :5000 challenging to :6000 is pointing the credential at
  // whatever else happens to be bound on that host. Comparing hostnames
  // accepted both.
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

test("the publishing credential never reaches a realm on the registry's host but another port", async () => {
  // The end-to-end form of the case above, because the unit assertion alone
  // cannot show that a refusal actually stops the request. Two loopback
  // servers on the SAME host and different ports: the registry, and a
  // collector. Comparing hostnames, this pair was same-host and the collector
  // would have been handed the Basic credential.
  const collectorSawCredential = [];
  const collector = createServer((req, res) => {
    collectorSawCredential.push(req.headers.authorization ?? "(none)");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "t" }));
  });
  await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));

  try {
    const result = await withLoopback(
      (req, res) => {
        res.writeHead(401, {
          "www-authenticate": `Bearer realm="http://127.0.0.1:${collector.address().port}/token",service="registry"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }));
      },
      (registry) =>
        lookupManifest({
          registry,
          name: "connector/ynab",
          tag: "0.3.0",
          credential: Buffer.from("user:publishing-token").toString("base64"),
          scheme: "http",
          timeoutMs: 5000,
          allowInsecureLoopback: true,
        }),
    );

    assert.deepEqual(
      collectorSawCredential,
      [],
      `the publishing credential must never reach another port on the registry's host: ${collectorSawCredential.join(", ")}`,
    );
    assert.equal(result.outcome, "unknown");
    assert.match(result.reason, /neither the registry origin/);
  } finally {
    collector.closeAllConnections?.();
    await new Promise((resolve) => collector.close(resolve));
  }
});

test("an IPv6 loopback realm is compared as the URL parser spells it", async () => {
  // `new URL("http://[::1]:5000/").hostname` is `[::1]`, brackets retained.
  // The policy compared that against a bare `::1` and against an authority it
  // had split on `:`, so the registry's OWN realm was refused: the documented
  // loopback exception did not actually cover IPv6. Both sides now go through
  // `URL`, so the two spellings meet.
  //
  // The accepted direction is proved against a real IPv6 loopback server, not
  // just the policy function: the credential must reach the registry's own
  // token endpoint and the handshake must complete.
  const seen = { authorization: null, manifestRequests: 0 };
  const server = createServer((req, res) => {
    if (req.url.startsWith("/token")) {
      seen.authorization = req.headers.authorization ?? "(none)";
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ token: "t" }));
      return;
    }
    seen.manifestRequests += 1;
    if (!req.headers.authorization) {
      res.writeHead(401, {
        "www-authenticate": `Bearer realm="http://[::1]:${server.address().port}/token",service="registry"`,
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }] }));
  });

  try {
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch (error) {
    // A host with no IPv6 loopback cannot run this fixture. Skipping is
    // honest; silently passing would not be.
    server.close();
    assert.fail(`this host has no IPv6 loopback to bind: ${error.message}`);
  }

  try {
    const registry = `[::1]:${server.address().port}`;
    const result = await lookupManifest({
      registry,
      name: "connector/ynab",
      tag: "0.3.0",
      credential: Buffer.from("user:publishing-token").toString("base64"),
      scheme: "http",
      timeoutMs: 5000,
      allowInsecureLoopback: true,
    });

    assert.equal(
      seen.authorization,
      `Basic ${Buffer.from("user:publishing-token").toString("base64")}`,
      "the registry's own IPv6 token endpoint must receive the credential",
    );
    assert.equal(seen.manifestRequests, 2, "the handshake must retry the manifest with the token");
    assert.equal(result.outcome, "absent", `the completed handshake must classify: ${JSON.stringify(result)}`);

    // The refused direction, on the same host: another port on `[::1]` is
    // another server, exactly as it is on 127.0.0.1.
    assert.match(
      checkTokenRealm(new URL(`http://[::1]:${server.address().port + 1}/token`), registry, {
        allowInsecureLoopback: true,
      }),
      /neither the registry origin/,
      "a different port on [::1] must not receive the credential",
    );
    // And a compressed spelling of the same address is the same origin, so
    // the comparison is about the address and not about how it was written.
    assert.equal(
      checkTokenRealm(new URL(`http://[0:0:0:0:0:0:0:1]:${server.address().port}/token`), registry, {
        allowInsecureLoopback: true,
      }),
      null,
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// FINDING 3: a reply that says two things has not established absence.
test("a 404 mixing an absence code with a denial is unknown, not absent", () => {
  const result = classifyManifestResponse({
    status: 404,
    headers: {},
    body: JSON.stringify({
      errors: [
        { code: "MANIFEST_UNKNOWN", message: "manifest unknown" },
        { code: "DENIED", message: "requested access to the resource is denied" },
      ],
    }),
  });
  assert.equal(
    result.outcome,
    "unknown",
    `a self-contradicting reply must not authorise republication: ${JSON.stringify(result)}`,
  );
  assert.match(result.reason, /contradicts itself/);
});

test("a 404 whose errors array is empty establishes nothing", () => {
  // `every()` over an empty array is vacuously true, so this is the case the
  // length check exists for. A registry that sends `{"errors":[]}` has told us
  // nothing about this manifest.
  const result = classifyManifestResponse({ status: 404, headers: {}, body: JSON.stringify({ errors: [] }) });
  assert.equal(result.outcome, "unknown");
});

test("a 404 whose error entries carry no usable code establishes nothing", () => {
  // Entries are present but shapeless: no entry yields a code at all, which
  // must land on unknown rather than on an empty-set absence.
  const result = classifyManifestResponse({
    status: 404,
    headers: {},
    body: JSON.stringify({ errors: [{ message: "manifest unknown" }, { code: 404 }] }),
  });
  assert.equal(result.outcome, "unknown");
});

test("a 404 mixing a clean absence code with an unreadable entry is unknown, not absent", () => {
  // The partially-malformed shape. The array says MANIFEST_UNKNOWN AND says
  // something else this script cannot read — and an error it cannot read may
  // be the one that says the request was never allowed to ask. Filtering the
  // unreadable entry away left a single clean absence code behind and read as
  // absence, which is the outcome that authorises moving a released version
  // tag onto new bytes. Both spellings of unreadable are pinned: a companion
  // with no `code` key at all, and one whose `code` is not a string.
  for (const errors of [
    [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }, {}],
    [{ code: "MANIFEST_UNKNOWN", message: "manifest unknown" }, { code: 404, message: "not found" }],
  ]) {
    const result = classifyManifestResponse({
      status: 404,
      headers: {},
      body: JSON.stringify({ errors }),
    });
    assert.equal(
      result.outcome,
      "unknown",
      `an errors array this script cannot fully read must not authorise republication: ${JSON.stringify(result)}`,
    );
    assert.match(result.reason, /entry that has no string code/);
  }
});

test("a 404 whose errors array is wholly readable and wholly absence is still absent", () => {
  // The control for the rule above: strictness about unreadable COMPANIONS
  // must not have turned every multi-entry array into unknown. Two readable
  // absence codes still agree, and agreement is absence.
  const result = classifyManifestResponse({
    status: 404,
    headers: {},
    body: JSON.stringify({
      errors: [
        { code: "MANIFEST_UNKNOWN", message: "manifest unknown" },
        { code: "NAME_UNKNOWN", message: "repository name not known to registry" },
      ],
    }),
  });
  assert.equal(result.outcome, "absent");
});

// FINDING 4: a realm that is not a URL is an outcome, not an exception.
test("an unparseable token realm is unknown, not a thrown error", async () => {
  // `new URL` throws on this, and the throw sits outside the try/catch around
  // the request. The caller must get a classification it can act on — the
  // publish shell reads an outcome, and a crashed lookup is not one.
  const fetchImpl = async () => ({
    status: 401,
    headers: { "www-authenticate": 'Bearer realm="not a url",service="registry"' },
    body: errorBody("UNAUTHORIZED", "authentication required"),
  });

  const result = await lookupManifest({
    registry: "registry.invalid",
    name: "connector/ynab",
    tag: "0.3.0",
    fetchImpl,
  });

  assert.equal(result.outcome, "unknown");
  assert.match(result.reason, /unparseable token realm/);
});
