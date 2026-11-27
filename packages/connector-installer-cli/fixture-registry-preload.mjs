// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only `node --import` preload for cli.test.mjs. It lets the unmodified
// CLI run as a real subprocess against the in-process fixture registry of
// oci-fixture.mjs, without any CLI flag:
//
// - every `https://ghcr.io/...` request is sent to CLI_FIXTURE_REGISTRY over
//   http; a request to any other host fails the run;
// - the `sigstore` module resolves to the fixture verifier, which trusts only
//   the key in CLI_FIXTURE_PUBLIC_KEY under the pinned publish identity.
//
// Everything else, including the default identity resolver, is production.

import { createPublicKey } from "node:crypto";
import { register } from "node:module";
import { PINNED_IDENTITY, createFixtureVerifier } from "../connector-installer-core/oci-fixture.mjs";

const registryHost = process.env.CLI_FIXTURE_REGISTRY;
const publicKeyPem = process.env.CLI_FIXTURE_PUBLIC_KEY;
if (!registryHost || !publicKeyPem) {
  throw new Error("CLI_FIXTURE_REGISTRY and CLI_FIXTURE_PUBLIC_KEY are required");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.host !== "ghcr.io") {
    throw new Error(`fixture preload refused a request to ${url.host}`);
  }
  url.protocol = "http:";
  url.host = registryHost;
  return realFetch(url, init);
};

globalThis.__cliFixtureVerifier = createFixtureVerifier({
  identity: PINNED_IDENTITY,
  publicKey: createPublicKey(publicKeyPem),
});

const sigstoreShim = `data:text/javascript,${encodeURIComponent(
  "export const verify = (...args) => globalThis.__cliFixtureVerifier(...args);"
)}`;
register(
  `data:text/javascript,${encodeURIComponent(
    `export async function resolve(specifier, context, next) {
      if (specifier === "sigstore") return { url: ${JSON.stringify(sigstoreShim)}, shortCircuit: true };
      return next(specifier, context);
    }`
  )}`
);
