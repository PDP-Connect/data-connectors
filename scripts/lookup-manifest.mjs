// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Answers ONE question about ONE reference: does `<repository>:<tag>` resolve,
// and to what digest?
//
// It exists because the question has THREE answers and the obvious way to ask
// it only has two. The publish workflow uses this answer to decide whether a
// released version identifier may be moved to newly pushed bytes, so "I could
// not find out" must never be reported as "nothing is there". A first publish
// and an unreachable registry look identical from the outside; only the
// registry's own answer about this exact reference tells them apart.
//
// WHY NOT `oras manifest fetch` PLUS A STRING MATCH. The previous revision ran
// the client and classified absence by grepping its stderr for `not found`,
// `NAME_UNKNOWN` or `MANIFEST_UNKNOWN`. The pinned client (ORAS 1.2.3, oras-go
// v2.5.0) renders a failure ANYWHERE in the exchange through the same formatter:
// `registry/remote/errcode/errors.go` falls back to `http.StatusText(code)` when
// a response carries no parseable distribution error. A 404 from the TOKEN
// endpoint — which says nothing whatever about the manifest — therefore prints
//
//     Error: GET "https://.../token": response status code 404: Not Found
//
// and matched. So did a 403 DENIED or a 500 UNKNOWN whose free-text message
// happened to contain "not found", because the parser preserves registry prose
// verbatim. Each of those authorised moving an existing version tag onto
// different bytes and signing them. Adding those three strings to a blocklist
// does not fix it: the fault is that stderr prose has no provenance, not that
// these particular sentences are unlucky.
//
// WHAT THIS DOES INSTEAD. It performs the manifest request itself and classifies
// from the RESPONSE TO THAT REQUEST — its URL, its HTTP status, and its parsed
// distribution-spec error code. Absence is a claim about a specific endpoint, so
// it is only ever read off that endpoint's own reply:
//
//   present  — HTTP 200 from the manifest endpoint, with a usable sha256 digest
//   absent   — HTTP 404 from the manifest endpoint, AND a distribution-spec
//              error body whose `errors` array is non-empty and EVERY one of
//              whose entries carries a string code, every one of which is
//              MANIFEST_UNKNOWN or NAME_UNKNOWN
//   unknown  — EVERYTHING else, with no exceptions worth carving out:
//              401/403 (auth), 5xx, any token-endpoint failure, transport
//              errors, HTML, unparseable JSON, a 404 whose body does not carry
//              one of those two codes, which mixes one with a code that says
//              something else, or whose array holds any entry without a
//              readable code, a 200 without a usable digest, a request that
//              outruns its deadline or whose body outruns the size a manifest
//              descriptor can be, and a 401 whose challenge names an
//              unparseable token realm or one whose ORIGIN this script will not
//              send the registry credential to.
//
// A token-endpoint 404 cannot reach `absent` here for a structural reason
// rather than a textual one: the token request is a DIFFERENT request, its
// failure is caught where it is made, and the manifest request never happens.
// There is no path by which one request's status is attributed to another's.
//
// The output is one line of JSON on stdout — `{"outcome":...,"digest":...}` —
// and the process exit status is 0 whenever the classification itself
// succeeded, including `unknown`. Refusing is the caller's decision, not this
// script's, so a nonzero exit here would confuse "the lookup failed" with "the
// publish must stop". Diagnostics go to stderr, where they annotate the run
// without ever being parsed.

import { request } from "node:https";
import { request as requestHttp } from "node:http";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

// The only two codes the distribution spec defines for "this reference does not
// exist". Anything else a registry returns with a 404 — including a bare 404
// from a proxy that never reached the registry — stays UNKNOWN.
const ABSENCE_CODES = new Set(["MANIFEST_UNKNOWN", "NAME_UNKNOWN"]);

// A manifest descriptor is small: an OCI image manifest or index naming a
// handful of layers is a few kilobytes, and the distribution-spec error bodies
// this script classifies from are smaller still. 1 MiB is far above anything
// either can legitimately be, so a response that exceeds it is not a reply this
// script can read — it is a peer sending something else, and the answer to
// "does this reference exist" is then `unknown`. The ceiling exists because the
// body is accumulated in memory: without it, a peer that streams indefinitely
// consumes the runner's memory instead of being classified.
const MAX_BODY_BYTES = 1024 * 1024;

// The token endpoints this script will send the registry Basic credential to.
//
// The credential is the publishing token. The challenge that names its
// destination comes from the 401 — from the peer — so an unconstrained helper
// forwards the token wherever that peer points, which is a credential-exfiltration
// path that needs no compromise of this script at all. The destination is
// therefore checked against policy rather than trusted:
//
//   - the scheme must be https, so the token is not sent in clear text;
//   - the realm's ORIGIN — scheme, host AND port — must either be the
//     registry's own origin, or one of the token origins documented below for
//     a registry whose auth service is a separate name.
//
// The unit is the origin, not the hostname, because a hostname is not a
// service. `https://ghcr.io:9443/token` is a different listener from the
// registry at `ghcr.io`, and a registry published on port 5000 challenging to
// a realm on 6000 is pointing the credential at whatever else is bound on this
// machine. Neither is the peer the credential was issued for, so neither gets
// it. Origins are compared as WHATWG `URL` renders them, which is what makes
// the comparison total: it defaults the port per scheme (`https://ghcr.io:443`
// IS `https://ghcr.io`), lowercases the host, and brackets and compresses IPv6
// literals on both sides identically (`[0:0:0:0:0:0:0:1]` IS `[::1]`), so no
// spelling of an authority slips past by being written differently from the
// registry's.
//
// GHCR is the one split this repository publishes to: ghcr.io challenges with
// a realm on ghcr.io itself, and Docker Hub — kept here because the same helper
// resolves any `<registry>/<name>:<tag>` — uses auth.docker.io. BOTH sides of
// this table are origins and both are https, because a documented auth service
// is a public one reached over TLS on the default port, and the registry it is
// documented for is likewise the public one: `ghcr.io:9443` is not the GHCR
// this table describes and does not inherit its realms. Any other origin,
// including a subdomain of the registry and the registry's own host on another
// port, gets no credential and the lookup returns `unknown`; widening this is a
// deliberate edit, not an accident of a peer's challenge.
const TOKEN_ORIGINS = new Map([
  ["https://ghcr.io", ["https://ghcr.io"]],
  ["https://registry-1.docker.io", ["https://auth.docker.io"]],
  ["https://docker.io", ["https://auth.docker.io"]],
  ["https://index.docker.io", ["https://auth.docker.io"]],
]);

/**
 * The registry authority read as an origin under a given scheme.
 *
 * Both sides of the destination check go through `URL` so they are normalised
 * the same way; returns null when the authority is not one `URL` can read,
 * which the caller turns into a refusal rather than a comparison against a
 * string it had to build by hand.
 */
function originOf(scheme, authority) {
  try {
    const url = new URL(`${scheme}//${authority}`);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

/**
 * May the Basic credential be sent to this token realm?
 *
 * Returns null when it may, or a diagnostic sentence when it may not. Callers
 * turn a refusal into `unknown`: the manifest question is unanswered, and an
 * unanswered question must never read as absence.
 *
 * `allowInsecureLoopback` is the behavioural tests' hook and nothing else. It
 * is off unless the caller passes it, and the entrypoint only sets it from
 * LOOKUP_ALLOW_INSECURE_TOKEN_REALM. What it waives is the TRANSPORT
 * requirement, for a loopback host only; the destination check still runs, so
 * under the hook the realm must still be the registry's own origin, port
 * included. A plaintext realm on a routable address stays refused, because a
 * test needing one would be a test of something this script must not do.
 */
export function checkTokenRealm(realmUrl, registry, { allowInsecureLoopback = false } = {}) {
  const registryAuthority = registry.split("/")[0].toLowerCase();
  // `URL` keeps the brackets on an IPv6 literal, so the loopback test is
  // written against the bracketed spelling rather than the bare address.
  const realmHost = realmUrl.hostname.toLowerCase();
  const loopback = realmHost === "127.0.0.1" || realmHost === "[::1]" || realmHost === "localhost";

  if (realmUrl.protocol !== "https:") {
    // The hook waives the TRANSPORT requirement for loopback and nothing more.
    // It is deliberately not an early `return null`: the origin check below
    // still runs, so a test registry cannot be talked into forwarding its
    // credential to a different loopback port than the one it is published to.
    const waived = allowInsecureLoopback && realmUrl.protocol === "http:" && loopback;
    if (!waived) {
      return (
        `the 401 challenge points the credential at a non-HTTPS token realm ` +
        `(${realmUrl.protocol}//${realmUrl.host}); the registry credential is not sent in clear text`
      );
    }
  }

  // The registry is read under the REALM'S scheme, so the comparison is
  // between two origins of the same kind. Under the hook that scheme is http,
  // which is the only way a plaintext loopback realm can match at all; on the
  // ordinary path it is https, so a registry written without a port compares
  // equal to a realm written with `:443` and to nothing else.
  const registryOrigin = originOf(realmUrl.protocol, registryAuthority);
  const refusal =
    `the 401 challenge points the credential at ${realmUrl.origin}, which is neither the registry ` +
    `origin (${registryOrigin ?? registryAuthority}) nor a token origin documented for it; ` +
    `the credential is not forwarded there`;

  if (registryOrigin === null) return refusal;
  if (realmUrl.origin === registryOrigin) return null;

  // The documented split-auth table is keyed by the registry's https origin, so
  // it is consulted with that origin whatever scheme the realm proposed.
  const documented = TOKEN_ORIGINS.get(originOf("https:", registryAuthority)) ?? [];
  if (documented.includes(realmUrl.origin)) return null;

  return refusal;
}

/**
 * One HTTP round trip, with the body collected as a string.
 *
 * Deliberately low-level: the classification depends on the status line and the
 * body of a SPECIFIC request, so nothing here may retry onto a different URL,
 * follow a redirect to a different host, or collapse two exchanges into one
 * result. A redirect is returned as the redirect it is and classified as
 * unknown unless it is the registry's own blob/manifest redirect, which this
 * caller does not follow because it only needs the status and the digest header.
 */
function fetchOnce(url, { method = "GET", headers = {}, timeoutMs = 30000, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(new Error(`unparseable URL: ${error.message}`));
      return;
    }
    // Plain HTTP is supported only so the behavioural tests can run against a
    // loopback registry without a certificate. Real publication is https.
    const impl = target.protocol === "http:" ? requestHttp : request;

    // ONE deadline for the WHOLE exchange — connect, headers and body. The
    // timer starts before the request is issued and is never restarted, so a
    // peer cannot hold the publish job open by dribbling a byte every few
    // seconds. `request.setTimeout` alone could not do this: it measures
    // INACTIVITY on the socket, so any traffic resets it and a slow-drip peer
    // stays under it forever. The publish workflow blocks on this call, so the
    // bound has to be on elapsed time, not on quiet time.
    let settled = false;
    let req = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (error) => {
      finish(reject, error);
      // Tear the socket down so a peer that is still sending cannot keep the
      // process alive after its answer has already been decided.
      req?.destroy();
    };

    const timer = setTimeout(() => {
      fail(new Error(`request exceeded its ${timeoutMs}ms deadline`));
    }, timeoutMs);
    // The deadline must not itself keep the process alive once an answer is in.
    timer.unref?.();

    req = impl(
      target,
      { method, headers: { "user-agent": "pdpp-manifest-lookup/1", ...headers } },
      (res) => {
        const chunks = [];
        let received = 0;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBodyBytes) {
            // Refused rather than truncated. A truncated body would be
            // classified — and a half-read JSON body parses to nothing, which
            // is indistinguishable from a registry that sent no error code.
            // Failing the request keeps that on the `unknown` path explicitly.
            fail(new Error(`response body exceeded ${maxBodyBytes} bytes`));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end();
  });
}

/**
 * Parse a `WWW-Authenticate: Bearer realm="...",service="...",scope="..."`
 * challenge. Returns null for any other scheme, which keeps an unexpected
 * challenge on the unknown path rather than guessing at a token exchange.
 */
export function parseBearerChallenge(header) {
  if (typeof header !== "string") return null;
  if (!/^bearer\s/i.test(header)) return null;
  const params = {};
  for (const match of header.slice(7).matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    params[match[1]] = match[2];
  }
  return params.realm ? params : null;
}

/**
 * The registry's own words for a failure, for the diagnostic line only.
 *
 * Included because an operator reading a refused run needs to know what the
 * registry actually said, and `HTTP 403` alone does not tell them. It is
 * deliberately NEVER consulted by the classifier: this text is precisely the
 * prose whose promotion to a decision was the defect, and the behavioural tests
 * pin that a message saying "not found" still refuses.
 */
function registryMessage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "";
  }
  const message = parsed?.errors?.[0]?.message;
  return typeof message === "string" ? message : "";
}

/**
 * Read a distribution-spec error code out of a response body.
 *
 * Strict on purpose. The body must be JSON, must carry an `errors` array, and
 * the codes are taken ONLY from that structure — never from a free-text
 * `message`, which is where the previous revision's defect lived. Returns an
 * empty array for HTML, for empty bodies, and for JSON of any other shape, all
 * of which therefore fail to establish absence.
 *
 * An entry WITHOUT a string `code` is not skipped, it poisons the whole array.
 * Dropping it silently was a real hole: `[{"code":"MANIFEST_UNKNOWN"},{}]` then
 * reduced to a single clean absence code and read as absence, even though the
 * registry sent a second error this script could not read at all. An error it
 * cannot read may be the one that says the request was not allowed to ask, so
 * the array as a whole has not established absence. `null` is that verdict —
 * distinct from `[]`, which says the body carried no error structure — and both
 * land on `unknown`.
 */
export function parseDistributionErrorCodes(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.errors)) return [];
  const codes = [];
  for (const entry of parsed.errors) {
    if (!entry || typeof entry.code !== "string") return null;
    codes.push(entry.code.toUpperCase());
  }
  return codes;
}

/**
 * Classify the response to THE manifest request.
 *
 * Split out from the I/O so the decision table is testable without a socket,
 * and so that every branch is visible in one place. `response` here is always
 * the manifest endpoint's own reply; a token failure never reaches this
 * function because it is handled where the token is requested.
 */
export function classifyManifestResponse(response) {
  const { status, headers = {}, body = "" } = response;

  if (status === 200) {
    // The digest the registry itself attributes to this reference. Preferring
    // the header over a hash of the body keeps this correct for a manifest the
    // registry may re-serialise, and the strict shape test means a missing or
    // malformed header is unknown rather than an empty "present".
    const digest = headers["docker-content-digest"];
    if (typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest.trim())) {
      return { outcome: "present", digest: digest.trim() };
    }
    return {
      outcome: "unknown",
      reason: `the manifest endpoint returned 200 without a usable sha256 Docker-Content-Digest header`,
    };
  }

  if (status === 404) {
    const codes = parseDistributionErrorCodes(body);
    const said = registryMessage(body);

    // `null` means the array held an entry this script could not read. It is
    // reported separately from "no absence code", because the operator's next
    // question is different: the registry did answer in the right shape, and
    // one of the things it said was unreadable.
    if (codes === null) {
      return {
        outcome: "unknown",
        reason:
          `the manifest endpoint returned 404 with an errors array carrying an entry that has no ` +
          `string code, so the reply cannot be read as absence and only absence` +
          `${said ? ` (registry said: ${said})` : ""}`,
      };
    }

    // EVERY code must be an absence code, and there must be at least one.
    //
    // `some()` was wrong in a way that matters: a body carrying both
    // MANIFEST_UNKNOWN and DENIED asserts two different things, one of which
    // says the request was not allowed to ask. A reply that contradicts itself
    // has not established that this manifest is missing — it has established
    // that this registry's answer cannot be read — and `absent` is the outcome
    // that authorises moving a released version tag. An empty array falls out
    // of the same test, since `every()` over nothing is vacuously true and the
    // length check is what rejects it.
    if (codes.length > 0 && codes.every((code) => ABSENCE_CODES.has(code))) {
      return { outcome: "absent" };
    }
    // A 404 alone is NOT an absence. An intercepting proxy, a wrong path, a
    // misrouted request and a token-service failure can all produce one, and
    // none of them has looked at this manifest.
    const contradictory = codes.some((code) => ABSENCE_CODES.has(code));
    return {
      outcome: "unknown",
      reason:
        `the manifest endpoint returned 404 but its body does not state absence and only absence: ` +
        (contradictory
          ? `it mixes an absence code with ${codes.filter((code) => !ABSENCE_CODES.has(code)).join(", ")}, ` +
            `so the reply contradicts itself`
          : `it carries no MANIFEST_UNKNOWN or NAME_UNKNOWN distribution error`) +
        ` (codes: ${codes.length ? codes.join(", ") : "none"}${said ? `; registry said: ${said}` : ""})`,
    };
  }

  // 401/403 say the request was not allowed to ask, not that the answer is no.
  // 5xx says the registry failed. Both are unknown, and giving the STATUS
  // precedence over any message text is the point: a 403 whose prose contains
  // "not found" is still a 403. The message is quoted for the operator and
  // has no bearing on the outcome above.
  const said = registryMessage(body);
  return {
    outcome: "unknown",
    reason: `the manifest endpoint returned HTTP ${status}${said ? ` (registry said: ${said})` : ""}`,
  };
}

/**
 * Resolve `<registry>/<name>:<tag>` to one of present/absent/unknown.
 *
 * The auth flow is the standard two-legged token handshake, and its failures
 * are contained: if the challenge is unusable, if its realm is unparseable or
 * fails the credential-destination policy, or if the token request does not
 * return 200 with a token, this returns UNKNOWN and never issues the second
 * manifest request. That containment is what makes the reviewer's token-404
 * counterexample structurally impossible rather than merely filtered.
 */
export async function lookupManifest({
  registry,
  name,
  tag,
  credential,
  scheme = "https",
  timeoutMs,
  allowInsecureLoopback = false,
  fetchImpl = fetchOnce,
}) {
  const manifestUrl = `${scheme}://${registry}/v2/${name}/manifests/${encodeURIComponent(tag)}`;
  const accept = { accept: MANIFEST_ACCEPT };
  const budget = timeoutMs ? { timeoutMs } : {};

  let response;
  try {
    response = await fetchImpl(manifestUrl, { method: "GET", headers: accept, ...budget });
  } catch (error) {
    return { outcome: "unknown", reason: `manifest request failed: ${error.message}` };
  }

  if (response.status === 401) {
    const challenge = parseBearerChallenge(response.headers?.["www-authenticate"]);
    if (!challenge) {
      return {
        outcome: "unknown",
        reason: "the manifest endpoint returned 401 without a usable Bearer challenge",
      };
    }

    // The realm is peer-supplied text. `new URL` throws on anything that is not
    // a URL, and a throw HERE — outside the protected request — would have
    // escaped `lookupManifest` as an exception rather than becoming an outcome,
    // so the caller would see a crashed lookup instead of `unknown`.
    let tokenUrl;
    try {
      tokenUrl = new URL(challenge.realm);
    } catch (error) {
      return {
        outcome: "unknown",
        reason: `the 401 challenge names an unparseable token realm (${error.message})`,
      };
    }

    // WHERE the credential goes is policy, not the peer's choice. Checked
    // before the request is built, so a refused destination is never contacted
    // at all.
    const refusal = checkTokenRealm(tokenUrl, registry, { allowInsecureLoopback });
    if (refusal) return { outcome: "unknown", reason: refusal };

    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${name}:pull`);

    let tokenResponse;
    try {
      tokenResponse = await fetchImpl(tokenUrl.toString(), {
        method: "GET",
        headers: credential ? { authorization: `Basic ${credential}` } : {},
        ...budget,
      });
    } catch (error) {
      // A TOKEN failure. It is reported as a token failure and stops here; it
      // is never allowed to stand in for the manifest endpoint's answer.
      return { outcome: "unknown", reason: `token request failed: ${error.message}` };
    }

    if (tokenResponse.status !== 200) {
      const said = registryMessage(tokenResponse.body);
      return {
        outcome: "unknown",
        reason:
          `the token endpoint returned HTTP ${tokenResponse.status}` +
          `${said ? ` (${said})` : ""}; this says nothing about whether the manifest exists`,
      };
    }

    let token;
    try {
      const parsed = JSON.parse(tokenResponse.body);
      token = parsed?.token ?? parsed?.access_token;
    } catch {
      return { outcome: "unknown", reason: "the token endpoint returned a body that is not JSON" };
    }
    if (typeof token !== "string" || token.length === 0) {
      return { outcome: "unknown", reason: "the token endpoint returned no token" };
    }

    try {
      response = await fetchImpl(manifestUrl, {
        method: "GET",
        headers: { ...accept, authorization: `Bearer ${token}` },
        ...budget,
      });
    } catch (error) {
      return { outcome: "unknown", reason: `authenticated manifest request failed: ${error.message}` };
    }
  }

  return classifyManifestResponse(response);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) break;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

// Entrypoint. `--reference ghcr.io/owner/name:tag`, with the credential taken
// from the environment so no token ever appears in a process listing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const reference = args.reference;
  if (!reference) {
    process.stderr.write("usage: lookup-manifest.mjs --reference <registry>/<name>:<tag>\n");
    process.exit(2);
  }

  const slash = reference.indexOf("/");
  const colon = reference.lastIndexOf(":");
  if (slash === -1 || colon < slash) {
    process.stderr.write(`unparseable reference: ${reference}\n`);
    process.exit(2);
  }
  const registry = reference.slice(0, slash);
  const name = reference.slice(slash + 1, colon);
  const tag = reference.slice(colon + 1);

  const username = process.env.LOOKUP_USERNAME ?? "";
  const password = process.env.LOOKUP_PASSWORD ?? "";
  const credential = password
    ? Buffer.from(`${username}:${password}`).toString("base64")
    : undefined;

  const result = await lookupManifest({
    registry,
    name,
    tag,
    credential,
    scheme: process.env.LOOKUP_SCHEME === "http" ? "http" : "https",
    // A registry that never answers — or one that answers a byte at a time —
    // must not hold the job open indefinitely. This bounds the WHOLE request.
    // The default is generous; the behavioural tests shorten it so the
    // never-answered case does not cost thirty seconds per run.
    timeoutMs: Number(process.env.LOOKUP_TIMEOUT_MS) || undefined,
    // The behavioural tests' hook, and the only way to reach a plaintext token
    // realm. Off unless set, opt-in by name rather than inferred from
    // LOOKUP_SCHEME, and even when set it permits loopback only. A CI run that
    // publishes for real never sets it.
    allowInsecureLoopback: process.env.LOOKUP_ALLOW_INSECURE_TOKEN_REALM === "1",
  });

  if (result.reason) process.stderr.write(`${reference}: ${result.outcome}: ${result.reason}\n`);
  process.stdout.write(`${JSON.stringify({ outcome: result.outcome, digest: result.digest ?? null })}\n`);
}
