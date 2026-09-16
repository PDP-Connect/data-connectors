// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The registry half of OCI connector consumption: turn a reference into bytes,
// and say honestly when it could not.
//
// The classification core — present / absent / unknown — is carried over from
// the publisher's `scripts/lookup-manifest.mjs`, and the reason it is carried
// over rather than re-derived is that the distinction it draws is the whole
// point of the module. A publisher asks "may I move this version tag onto new
// bytes?"; a consumer asks "should I install these bytes?". Both questions are
// answered wrongly, and in the same direction, by any client that reports "I
// could not find out" as "nothing is there". The publisher's version of this
// bug authorised re-signing a released tag; the consumer's would let a sick
// registry look like a withdrawn connector. One rule, two callers.
//
// What the publisher's copy classified from is kept exactly: THE RESPONSE TO
// THE REQUEST THAT WAS MADE. Absence is a claim about one endpoint, so it is
// only ever read off that endpoint's own reply, never off a token exchange's
// failure and never off registry prose. `parseDistributionErrorCodes` and
// `classifyManifestResponse` below are that rule, and their tests come with
// them (`oci-registry.test.mjs`).
//
// WHAT IS NEW HERE, AND WHY. The publisher only ever needed a digest. A
// consumer needs the bytes too, so this module adds blob fetch, and with it
// two obligations the publisher never had:
//
//   - a blob is verified against the digest that NAMED it before any caller
//     sees it (`fetchBlob`). A registry that serves the wrong bytes for a
//     content-addressed name is not trusted to say so itself.
//   - a fetch by digest never falls back to a tag. Re-resolution is the defect
//     the publisher documents at its own push step, and the consumer's version
//     of it is installing something other than what the lock pinned.

import { createHash } from "node:crypto";

import { fetchWithRetry } from "./retry.mjs";

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

// A manifest descriptor is small, and so are the distribution-spec error bodies
// classified from it. 1 MiB is far above anything either can legitimately be, so
// a response past it is not a reply this module can read. The ceiling exists
// because the body is accumulated in memory.
const MAX_MANIFEST_BYTES = 1024 * 1024;

// A connector artifact's layers are code and a brand icon, not container images.
// 64 MiB bounds a single blob well above anything the builder emits while still
// refusing to buffer an unbounded stream from a peer.
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

export const DEFAULT_OCI_REGISTRY = "ghcr.io";

// The registry this consumer will talk to at all. C1.3: a lock entry naming any
// other host is refused before a socket is opened, which is the fail-closed
// analogue of the tarball path's URL→identity origin policy. Widening this is a
// deliberate edit, not something an artifact or a lock file can ask for.
const ALLOWED_REGISTRIES = new Set([DEFAULT_OCI_REGISTRY]);

// The same predicate the publisher enforces when it derives a repository name
// from a manifest's `connector_key`. Checked here so a key that could never
// have been published is refused before any network call (C1.1).
const CONNECTOR_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isValidConnectorKey(key) {
  return typeof key === "string" && CONNECTOR_KEY_PATTERN.test(key);
}

export function isValidDigest(digest) {
  return typeof digest === "string" && DIGEST_PATTERN.test(digest.trim());
}

export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256Digest(buffer) {
  return `sha256:${sha256Hex(buffer)}`;
}

/**
 * The cosign tag that holds the signature for a manifest digest.
 *
 * `sha256:<hex>` is not a legal tag — `:` is a separator — so cosign rewrites
 * the separator and suffixes `.sig`. Observed against cosign v2.4.3, which is
 * the version the publish workflow pins.
 */
export function cosignSignatureTag(digest) {
  if (!isValidDigest(digest)) {
    throw new Error(`Cannot derive a cosign signature tag from "${digest}"`);
  }
  return `${digest.trim().replace(":", "-")}.sig`;
}

/**
 * A refusal that carries WHICH failure it was.
 *
 * C6.1 requires unknown / absent / denied / tampered / misidentified /
 * unverifiable to be distinguishable, and a caller that has to regex an error
 * message to tell them apart cannot act on the difference. The `reason` tag is
 * the machine-readable half; the message stays human-readable.
 */
export class OciRegistryError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "OciRegistryError";
    this.reason = reason;
  }
}

/**
 * Validate and split `ghcr.io/pdp-connect/connector/<key>` style coordinates.
 *
 * Every field a caller can influence is checked here, before anything is sent,
 * so that a malformed lock entry fails as a refusal rather than as a request to
 * somewhere unintended.
 */
export function parseOciReference({
  registry,
  repository,
  digest = null,
  version = null,
  // The behavioural tests' hook, and nothing else. It exists because the
  // acceptance suite serves a real registry on a loopback port, and a test
  // registry cannot be `ghcr.io`. It is passed explicitly by a caller that
  // already decided to trust it — never read from the environment, never
  // inferred, and never reachable from a lock file, so no artifact or lock can
  // talk the installer into widening the policy.
  allowedRegistries = ALLOWED_REGISTRIES,
} = {}) {
  if (typeof registry !== "string" || registry.length === 0) {
    throw new OciRegistryError("OCI entry is missing a registry", "invalid-reference");
  }
  if (!allowedRegistries.has(registry)) {
    throw new OciRegistryError(
      `Refusing connector artifact from unsupported registry "${registry}"; only ${[...allowedRegistries].join(", ")} is trusted`,
      "untrusted-registry"
    );
  }
  if (typeof repository !== "string" || !/^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$/.test(repository)) {
    throw new OciRegistryError(
      `Invalid OCI repository "${repository}"`,
      "invalid-reference"
    );
  }
  if (digest !== null && !isValidDigest(digest)) {
    throw new OciRegistryError(`Invalid OCI manifest digest "${digest}"`, "invalid-reference");
  }
  if (digest === null && (typeof version !== "string" || version.length === 0)) {
    throw new OciRegistryError(
      `OCI entry for ${repository} carries neither a digest nor a version`,
      "invalid-reference"
    );
  }
  return {
    registry,
    repository,
    digest: digest === null ? null : digest.trim(),
    version,
  };
}

/**
 * Parse a user-typed reference — `ghcr.io/pdp-connect/connector/ynab@sha256:…`
 * or `…/ynab:0.3.0` — into coordinates.
 *
 * The `@digest` form is parsed before the `:tag` form, because a digest
 * contains a colon and reading the reference right-to-left for a tag would
 * split `sha256:abc…` in the middle. The connector key is the last path
 * segment, and it is validated here so a reference that could never name a
 * published artifact is refused before it becomes a request (C1.1).
 */
export function parseConnectorOciReference(reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new OciRegistryError("No OCI reference given", "invalid-reference");
  }

  const at = reference.indexOf("@");
  let body = reference;
  let digest = null;
  let version = null;

  if (at !== -1) {
    body = reference.slice(0, at);
    digest = reference.slice(at + 1);
    if (!isValidDigest(digest)) {
      throw new OciRegistryError(`Invalid digest in OCI reference "${reference}"`, "invalid-reference");
    }
  } else {
    const lastColon = body.lastIndexOf(":");
    const lastSlash = body.lastIndexOf("/");
    if (lastColon > lastSlash) {
      version = body.slice(lastColon + 1);
      body = body.slice(0, lastColon);
    }
  }

  const firstSlash = body.indexOf("/");
  if (firstSlash === -1) {
    throw new OciRegistryError(
      `OCI reference "${reference}" names no repository`,
      "invalid-reference"
    );
  }
  const registry = body.slice(0, firstSlash);
  const repository = body.slice(firstSlash + 1);
  const connectorKey = repository.slice(repository.lastIndexOf("/") + 1);

  if (!isValidConnectorKey(connectorKey)) {
    throw new OciRegistryError(
      `OCI reference "${reference}" names an invalid connector key "${connectorKey}"`,
      "invalid-reference"
    );
  }

  // Runs the same registry and repository checks a lock entry gets, so the
  // command line is not a way around the origin policy.
  parseOciReference({ registry, repository, digest, version });

  return { registry, repository, connectorKey, digest, version };
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
 * Read a distribution-spec error code out of a response body.
 *
 * Strict on purpose, and carried over verbatim in intent from the publisher's
 * lookup. The body must be JSON, must carry an `errors` array, and codes are
 * taken ONLY from that structure — never from a free-text `message`, which is
 * where the publisher's original defect lived.
 *
 * An entry WITHOUT a string `code` is not skipped, it poisons the whole array:
 * `[{"code":"MANIFEST_UNKNOWN"},{}]` must not reduce to a clean absence, because
 * the unreadable second error may be the one saying the request was not allowed
 * to ask. `null` is that verdict — distinct from `[]`, which says the body
 * carried no error structure — and both land on `unknown`.
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
 * The registry's own words for a failure, for the diagnostic line only.
 *
 * Deliberately NEVER consulted by the classifier: this text is precisely the
 * prose whose promotion to a decision was the defect being avoided. A 403 whose
 * message reads "not found" is still a 403.
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
 * Classify the response to THE manifest request.
 *
 * Split out from the I/O so the decision table is testable without a socket. A
 * token failure never reaches this function; it is handled where the token is
 * requested, which is what makes "a token 404 cannot become an absence" a
 * structural property rather than a filtered one.
 */
export function classifyManifestResponse(response) {
  const { status, headers = {}, body = "" } = response;

  if (status === 200) {
    const digest = headers["docker-content-digest"];
    const computed = sha256Digest(Buffer.from(body, "utf8"));
    if (typeof digest === "string" && isValidDigest(digest)) {
      // C2.1: the header and the bytes must agree. They are two independent
      // claims about the same object, and a registry that contradicts itself
      // about a content-addressed name has not answered the question.
      if (digest.trim() !== computed) {
        return {
          outcome: "unknown",
          reason:
            `the manifest endpoint's Docker-Content-Digest (${digest.trim()}) does not match ` +
            `the digest of the bytes it returned (${computed})`,
        };
      }
      return { outcome: "present", digest: digest.trim(), body };
    }
    if (digest === undefined) {
      // A registry that omits the header entirely is still answerable: the
      // digest is a property of the bytes, and they are in hand.
      return { outcome: "present", digest: computed, body };
    }
    return {
      outcome: "unknown",
      reason: "the manifest endpoint returned 200 with a malformed Docker-Content-Digest header",
    };
  }

  if (status === 404) {
    const codes = parseDistributionErrorCodes(body);
    const said = registryMessage(body);

    if (codes === null) {
      return {
        outcome: "unknown",
        reason:
          `the manifest endpoint returned 404 with an errors array carrying an entry that has no ` +
          `string code, so the reply cannot be read as absence and only absence` +
          `${said ? ` (registry said: ${said})` : ""}`,
      };
    }

    // EVERY code must be an absence code, and there must be at least one. A
    // body mixing MANIFEST_UNKNOWN with DENIED asserts two different things,
    // one of which says the request was not allowed to ask; a reply that
    // contradicts itself has not established that this manifest is missing.
    if (codes.length > 0 && codes.every((code) => ABSENCE_CODES.has(code))) {
      return { outcome: "absent" };
    }
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
  // 5xx says the registry failed. Both are unknown, and the STATUS takes
  // precedence over any message text.
  const said = registryMessage(body);
  return {
    outcome: "unknown",
    reason: `the manifest endpoint returned HTTP ${status}${said ? ` (registry said: ${said})` : ""}`,
  };
}

/**
 * One HTTP round trip with the body collected, bounded by ONE deadline for the
 * whole exchange.
 *
 * `AbortSignal.timeout` measures elapsed time, not socket inactivity, which is
 * the property needed: a peer dribbling a byte every few seconds must not be
 * able to hold an install open indefinitely.
 */
async function fetchOnce(
  url,
  {
    method = "GET",
    headers = {},
    timeoutMs = 30000,
    maxBytes = MAX_MANIFEST_BYTES,
    fetchImpl = fetch,
    redirect = "follow",
    retryOptions = {},
  } = {}
) {
  const response = await fetchWithRetry(url, {
    ...retryOptions,
    fetchImpl,
    fetchOptions: () => ({
      method,
      headers: { "user-agent": "pdpp-connector-installer/1", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect,
    }),
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) {
    // Refused rather than truncated: a half-read JSON body parses to nothing,
    // which is indistinguishable from a registry that sent no error code.
    //
    // Note what this does and does not bound. The body is already buffered by
    // the time it is measured, so this caps what a CALLER can be handed, not
    // peak memory during the read. What bounds an endlessly streaming peer is
    // the elapsed-time deadline above, not this. Stating it because a reader
    // who assumed otherwise would be relying on a guarantee that is not here.
    throw new Error(`response body exceeded ${maxBytes} bytes`);
  }

  const headerObject = {};
  response.headers?.forEach?.((value, key) => {
    headerObject[key.toLowerCase()] = value;
  });

  return { status: response.status, headers: headerObject, buffer, body: buffer.toString("utf8") };
}

// A 3xx this consumer will follow by hand. 304 is not a redirect to a location.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Enough hops for a realm that redirects once or twice; a chain longer than this
// is a loop or a service this consumer should not be chasing.
const MAX_TOKEN_REDIRECTS = 3;

/**
 * The token request, following redirects MANUALLY so every hop is checked.
 *
 * `redirect: "follow"` let the origin policy be satisfied once and then left
 * behind: an allowed realm could answer 302 to any origin and the runtime would
 * fetch it without the challenge check ever seeing that second origin. Since the
 * realm is supplied by the peer in its own 401, that made the check advisory —
 * the registry chose the final destination, including a port on the machine
 * running the install.
 *
 * So the redirect is not followed by the runtime; each `Location` is resolved
 * and put through the SAME `checkTokenRealm` the first realm passed, and a hop
 * that fails is a refusal rather than a request. This is the token exchange
 * only. Blob and manifest reads keep `redirect: "follow"`, because a registry
 * redirecting a blob to its CDN is the documented way that transport works and
 * those responses are pinned by digest rather than trusted by origin.
 */
async function fetchTokenFollowingRedirects(
  startUrl,
  { registry, timeoutMs, fetchImpl, allowInsecureLoopback, retryOptions }
) {
  let url = startUrl;

  for (let hop = 0; hop <= MAX_TOKEN_REDIRECTS; hop += 1) {
    const response = await fetchOnce(url.toString(), {
      timeoutMs,
      fetchImpl,
      redirect: "manual",
      retryOptions,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return { response };
    }

    const location = response.headers.location;
    if (!location) {
      return { error: `the token endpoint returned HTTP ${response.status} without a location` };
    }

    let next;
    try {
      // Resolved against the current URL, so a relative location is read the
      // same way the runtime would have read it.
      next = new URL(location, url);
    } catch {
      return { error: "the token endpoint redirected to a location that cannot be read as a URL" };
    }

    const refusal = checkTokenRealm(next, registry, { allowInsecureLoopback });
    if (refusal) {
      return { error: `the token endpoint redirected to a refused origin: ${refusal}` };
    }
    url = next;
  }

  return { error: `the token endpoint redirected more than ${MAX_TOKEN_REDIRECTS} times` };
}

// The token realms this consumer will talk to, keyed by registry origin. Moved
// from the publisher's `lookup-manifest.mjs` (#97) rather than rewritten, so
// both sides of the same handshake apply the same policy.
//
// The unit is the ORIGIN — scheme, host AND port — because a hostname is not a
// service. `https://ghcr.io:9443/token` is a different listener from the
// registry at `ghcr.io`, and a registry on port 5000 challenging to a realm on
// 6000 is naming whatever else is bound on that machine. Origins are compared
// as WHATWG `URL` renders them, which is what makes the comparison total: it
// defaults the port per scheme (`https://ghcr.io:443` IS `https://ghcr.io`),
// lowercases the host, and brackets and compresses IPv6 literals identically on
// both sides (`[0:0:0:0:0:0:0:1]` IS `[::1]`), so no spelling of an authority
// slips past by differing from the registry's.
//
// GHCR is the split this repository pulls from: ghcr.io challenges with a realm
// on ghcr.io itself. Docker Hub is kept because the same helper resolves any
// `<registry>/<name>:<tag>`. Both sides are https origins, because a documented
// auth service is a public one reached over TLS on the default port —
// `ghcr.io:9443` is not the GHCR this table describes and does not inherit its
// realms. Widening this is a deliberate edit, not an accident of a challenge.
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
 * May this consumer make the token request to this realm?
 *
 * Returns null when it may, or a diagnostic sentence when it may not. Callers
 * turn a refusal into `unknown`: the manifest question is unanswered, and an
 * unanswered question must never read as absence.
 *
 * The publisher checks this to protect a credential. This consumer sends none —
 * the pull is anonymous — so what the check is worth here is smaller and worth
 * stating exactly: the realm comes from the PEER, in its own 401, so without
 * the check a registry chooses an arbitrary origin this process will then issue
 * a GET to, including a port on the machine running the install. That is a
 * request forgery with the registry as the author, not a credential leak. It is
 * a narrow exposure, and it costs one comparison to close.
 *
 * `allowInsecureLoopback` is the tests' hook and nothing else — off unless the
 * caller passes it, so the fixture registry's plaintext realm is reachable in a
 * test and no loopback carve-out exists in production. What it waives is the
 * TRANSPORT requirement, for a loopback host only; the destination check still
 * runs, so a test registry cannot be talked into a different loopback port than
 * the one it is published on.
 */
export function checkTokenRealm(realmUrl, registry, { allowInsecureLoopback = false } = {}) {
  const registryAuthority = registry.split("/")[0].toLowerCase();
  // `URL` keeps the brackets on an IPv6 literal, so the loopback test is
  // written against the bracketed spelling rather than the bare address.
  const realmHost = realmUrl.hostname.toLowerCase();
  const loopback = realmHost === "127.0.0.1" || realmHost === "[::1]" || realmHost === "localhost";

  if (realmUrl.protocol !== "https:") {
    // The hook waives the TRANSPORT requirement for loopback and nothing more.
    // Deliberately not an early `return null`: the origin check below still
    // runs.
    const waived = allowInsecureLoopback && realmUrl.protocol === "http:" && loopback;
    if (!waived) {
      return (
        `the 401 challenge points at a non-HTTPS token realm ` +
        `(${realmUrl.protocol}//${realmUrl.host})`
      );
    }
  }

  // The registry is read under the REALM'S scheme, so the comparison is between
  // two origins of the same kind. Under the hook that scheme is http, which is
  // the only way a plaintext loopback realm can match at all; on the ordinary
  // path it is https, so a registry written without a port compares equal to a
  // realm written with `:443` and to nothing else.
  const registryOrigin = originOf(realmUrl.protocol, registryAuthority);
  const refusal =
    `the 401 challenge points at ${realmUrl.origin}, which is neither the registry ` +
    `origin (${registryOrigin ?? registryAuthority}) nor a token origin documented for it`;

  if (registryOrigin === null) return refusal;
  if (realmUrl.origin === registryOrigin) return null;

  // The documented split-auth table is keyed by the registry's https origin, so
  // it is consulted with that origin whatever scheme the realm proposed.
  const documented = TOKEN_ORIGINS.get(originOf("https:", registryAuthority)) ?? [];
  if (documented.includes(realmUrl.origin)) return null;

  return refusal;
}

/**
 * Anonymous pull of a public GHCR repository still requires a token exchange.
 *
 * C2.4: a failure ANYWHERE in this handshake is the caller's `unknown`, and it
 * is reported as a token failure so it can never be mistaken for the manifest
 * endpoint's answer.
 */
async function requestToken(
  challenge,
  {
    registry,
    repository,
    timeoutMs,
    fetchImpl,
    allowInsecureLoopback = false,
    retryOptions,
  }
) {
  let tokenUrl;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch (error) {
    return { error: `the 401 challenge names an unparseable token realm (${error.message})` };
  }
  const refusal = checkTokenRealm(tokenUrl, registry, { allowInsecureLoopback });
  if (refusal) {
    return { error: refusal };
  }

  if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
  tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);

  let response;
  try {
    const followed = await fetchTokenFollowingRedirects(tokenUrl, {
      registry,
      timeoutMs,
      fetchImpl,
      allowInsecureLoopback,
      retryOptions,
    });
    if (followed.error) {
      return { error: followed.error };
    }
    response = followed.response;
  } catch (error) {
    return { error: `token request failed: ${error.message}` };
  }
  if (response.status !== 200) {
    return {
      error:
        `the token endpoint returned HTTP ${response.status}; ` +
        `this says nothing about whether the manifest exists`,
    };
  }
  let token;
  try {
    const parsed = JSON.parse(response.body);
    token = parsed?.token ?? parsed?.access_token;
  } catch {
    return { error: "the token endpoint returned a body that is not JSON" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { error: "the token endpoint returned no token" };
  }
  return { token };
}

/**
 * GET one registry path, completing a Bearer handshake if challenged.
 *
 * Returns the raw response so the caller can classify it. Token failures are
 * returned as a `tokenFailure` rather than thrown, so the caller can report
 * them as what they are.
 */
async function registryGet(
  {
    registry,
    repository,
    path,
    accept,
    scheme = "https",
    timeoutMs = 30000,
    maxBytes,
    fetchImpl = fetch,
    allowInsecureLoopback = false,
    retryOptions = {},
  }
) {
  const url = `${scheme}://${registry}/v2/${repository}/${path}`;
  const headers = accept ? { accept } : {};

  let response = await fetchOnce(url, {
    headers,
    timeoutMs,
    maxBytes,
    fetchImpl,
    retryOptions,
  });
  if (response.status !== 401) return { response };

  const challenge = parseBearerChallenge(response.headers["www-authenticate"]);
  if (!challenge) {
    return { tokenFailure: "the registry returned 401 without a usable Bearer challenge" };
  }
  const { token, error } = await requestToken(challenge, {
    registry,
    repository,
    timeoutMs,
    fetchImpl,
    retryOptions,
    // `scheme` is ALREADY the explicit, caller-supplied hook this module uses to
    // reach a test registry: production never sets it, so it is `https` on every
    // real path and a plaintext realm is refused there whatever this resolves
    // to. Deriving the waiver from it keeps one hook instead of two that must be
    // set together, and no artifact, lock entry or registry challenge can reach
    // it. The destination check still runs either way, so even under `http` the
    // realm must be the test registry's own origin, port included.
    allowInsecureLoopback: allowInsecureLoopback || scheme === "http",
  });
  if (error) return { tokenFailure: error };

  response = await fetchOnce(url, {
    headers: { ...headers, authorization: `Bearer ${token}` },
    timeoutMs,
    maxBytes,
    fetchImpl,
    retryOptions,
  });
  return { response };
}

/**
 * Resolve `<repository>:<tag>` to one of present / absent / unknown.
 *
 * This is the consumer's copy of the publisher's guard, and it exists for the
 * same reason: a first publish and an unreachable registry look identical from
 * the outside, and only the registry's own answer about this exact reference
 * tells them apart. Returns the classification; refusing is the caller's
 * decision (C2.2), which is why nothing here throws on `unknown`.
 */
export async function lookupManifest({
  registry,
  repository,
  reference,
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  let result;
  try {
    result = await registryGet({
      registry,
      repository,
      path: `manifests/${encodeURIComponent(reference)}`,
      accept: MANIFEST_ACCEPT,
      scheme,
      timeoutMs,
      maxBytes: MAX_MANIFEST_BYTES,
      fetchImpl,
      retryOptions,
    });
  } catch (error) {
    return { outcome: "unknown", reason: `manifest request failed: ${error.message}` };
  }
  if (result.tokenFailure) {
    return { outcome: "unknown", reason: result.tokenFailure };
  }
  return classifyManifestResponse(result.response);
}

/**
 * Resolve a version tag to the digest it currently names.
 *
 * C2.1/C2.2: `present` yields a digest, `absent` and `unknown` both refuse, and
 * they refuse with different reasons because the operator's next question
 * differs. This is a FIRST-PIN operation only; once a digest is in the lock,
 * installs go through `fetchManifestByDigest` and never come back here (C2.3).
 */
export async function resolveVersionToDigest({
  registry,
  repository,
  version,
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  const result = await lookupManifest({
    registry,
    repository,
    reference: version,
    scheme,
    timeoutMs,
    fetchImpl,
    retryOptions,
  });

  if (result.outcome === "present") return result.digest;
  if (result.outcome === "absent") {
    throw new OciRegistryError(
      `${registry}/${repository}:${version} is not published`,
      "absent"
    );
  }
  throw new OciRegistryError(
    `Refusing to resolve ${registry}/${repository}:${version}: ${result.reason}`,
    "unverifiable"
  );
}

/**
 * Fetch a manifest BY DIGEST and prove the bytes hash to the digest asked for.
 *
 * The self-check is not ceremony. A digest is a content address, so bytes that
 * do not hash to it are not the object requested however the registry labelled
 * them, and this is the one check that makes every later layer-digest check
 * meaningful — the layer descriptors live inside these bytes.
 */
export async function fetchManifestByDigest({
  registry,
  repository,
  digest,
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  if (!isValidDigest(digest)) {
    throw new OciRegistryError(`Invalid OCI manifest digest "${digest}"`, "invalid-reference");
  }

  let result;
  try {
    result = await registryGet({
      registry,
      repository,
      path: `manifests/${digest}`,
      accept: MANIFEST_ACCEPT,
      scheme,
      timeoutMs,
      maxBytes: MAX_MANIFEST_BYTES,
      fetchImpl,
      retryOptions,
    });
  } catch (error) {
    throw new OciRegistryError(
      `Failed to fetch ${registry}/${repository}@${digest}: ${error.message}`,
      "unverifiable"
    );
  }
  if (result.tokenFailure) {
    throw new OciRegistryError(
      `Failed to fetch ${registry}/${repository}@${digest}: ${result.tokenFailure}`,
      "unverifiable"
    );
  }

  const { response } = result;
  if (response.status !== 200) {
    const classification = classifyManifestResponse(response);
    throw new OciRegistryError(
      `Failed to fetch ${registry}/${repository}@${digest}: ${classification.reason ?? `HTTP ${response.status}`}`,
      classification.outcome === "absent" ? "absent" : "unverifiable"
    );
  }

  const actual = sha256Digest(response.buffer);
  if (actual !== digest.trim()) {
    throw new OciRegistryError(
      `${registry}/${repository}@${digest} returned bytes whose digest is ${actual}`,
      "tampered"
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(response.buffer.toString("utf8"));
  } catch (error) {
    throw new OciRegistryError(
      `${registry}/${repository}@${digest} is not a JSON manifest: ${error.message}`,
      "tampered"
    );
  }

  return { manifest, bytes: response.buffer, digest: digest.trim() };
}

/**
 * Fetch a blob and verify it against the digest that named it (C4.1).
 *
 * Verification happens HERE rather than in the caller so that no code path can
 * obtain unverified blob bytes: the only way to get a blob out of this module
 * is to have proved it already.
 */
export async function fetchBlob({
  registry,
  repository,
  digest,
  scheme = "https",
  timeoutMs = 30000,
  maxBytes = MAX_BLOB_BYTES,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  if (!isValidDigest(digest)) {
    throw new OciRegistryError(`Invalid OCI blob digest "${digest}"`, "invalid-reference");
  }

  let result;
  try {
    result = await registryGet({
      registry,
      repository,
      path: `blobs/${digest}`,
      scheme,
      timeoutMs,
      maxBytes,
      fetchImpl,
      retryOptions,
    });
  } catch (error) {
    throw new OciRegistryError(
      `Failed to fetch blob ${digest} from ${registry}/${repository}: ${error.message}`,
      "unverifiable"
    );
  }
  if (result.tokenFailure) {
    throw new OciRegistryError(
      `Failed to fetch blob ${digest} from ${registry}/${repository}: ${result.tokenFailure}`,
      "unverifiable"
    );
  }

  const { response } = result;
  if (response.status !== 200) {
    throw new OciRegistryError(
      `Failed to fetch blob ${digest} from ${registry}/${repository}: HTTP ${response.status}`,
      response.status === 401 || response.status === 403 ? "denied" : "unverifiable"
    );
  }

  const actual = sha256Digest(response.buffer);
  if (actual !== digest.trim()) {
    throw new OciRegistryError(
      `Blob ${digest} from ${registry}/${repository} hashes to ${actual}`,
      "tampered"
    );
  }

  return response.buffer;
}

/**
 * Fetch the cosign signature manifest for a digest, if one is published.
 *
 * Returns null when the signature tag is genuinely absent, and throws on
 * `unknown` — the same three-outcome rule, applied to the object whose absence
 * would otherwise read as "this artifact is unsigned" (C2.2, C6.4).
 */
export async function fetchSignatureManifest({
  registry,
  repository,
  digest,
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  const tag = cosignSignatureTag(digest);
  const result = await lookupManifest({
    registry,
    repository,
    reference: tag,
    scheme,
    timeoutMs,
    fetchImpl,
    retryOptions,
  });

  if (result.outcome === "absent") return null;
  if (result.outcome === "unknown") {
    throw new OciRegistryError(
      `Could not determine whether ${registry}/${repository}:${tag} exists: ${result.reason}`,
      "unverifiable"
    );
  }

  try {
    return { manifest: JSON.parse(result.body), digest: result.digest };
  } catch (error) {
    throw new OciRegistryError(
      `The cosign signature manifest at ${registry}/${repository}:${tag} is not JSON: ${error.message}`,
      "tampered"
    );
  }
}
