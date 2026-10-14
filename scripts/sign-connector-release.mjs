#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Signs the subjects of one legacy artifact release with Sigstore, keyless,
// using the GitHub Actions OIDC identity of the workflow that runs it. The
// Vana Desktop installer and its in-app updater pin that identity
// (`DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY` in connector-installer-core), so
// this script only produces usable bundles when run by
// `.github/workflows/publish-connector-release-index.yml` on `main`.
//
// Subjects: the release index written by build-connector-release-index.mjs,
// the frozen `scope-catalog.json` and `schemas/scope-catalog.schema.json`
// (republished unchanged with fresh bundles), and every tarball listed in
// `<output>/published.json`. Each bundle is written to `<output>/` under the
// name the installer derives from the asset URL: `<asset>.sigstore.json`.
//
// `signSubjects` is pure over an injected signer, so the subject list is
// testable without an OIDC token.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");

/** The subjects of a release: `[{ path, bundlePath }]`, index first. */
export function releaseSubjects({ root = repositoryRoot, output }) {
  const published = JSON.parse(readFileSync(join(output, "published.json"), "utf8")).published;
  const subjects = [
    { path: join(output, "connector-index.json"), bundlePath: join(output, "connector-index.json.sigstore.json") },
    { path: join(root, "scope-catalog.json"), bundlePath: join(output, "scope-catalog.json.sigstore.json") },
    { path: join(root, "schemas/scope-catalog.schema.json"), bundlePath: join(output, "scope-catalog.schema.json.sigstore.json") },
    ...published.map((entry) => ({
      path: join(root, entry.artifactPath),
      bundlePath: join(output, `${entry.assetName}.sigstore.json`),
    })),
  ];
  for (const subject of subjects) {
    if (!existsSync(subject.path)) throw new Error(`release subject is missing: ${subject.path}`);
    if (basename(subject.bundlePath) !== `${basename(subject.path)}.sigstore.json`) {
      throw new Error(`bundle name must be <asset>.sigstore.json: ${subject.bundlePath}`);
    }
  }
  return subjects;
}

/** Signs every subject with `sign(bytes) -> bundle` and writes the bundles. */
export async function signSubjects(subjects, sign) {
  let count = 0;
  for (const subject of subjects) {
    const bundle = await sign(readFileSync(subject.path));
    writeFileSync(subject.bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    count += 1;
  }
  return count;
}

// Rekor answers slowly at times. sigstore's sign() gives each request 5 s and
// retries a timed-out request; when Rekor had already logged the first one,
// the retry gets 409 "an equivalent entry already exists" and sign() does not
// fetch that entry (its fetchOnConflict is fixed to false), so the lane fails.
// A longer timeout avoids most of those retries. A 409 that still comes back is
// signed again: every sign() call has its own key and certificate, so the new
// entry is distinct and the earlier one is simply unused.
export const SIGN_TIMEOUT_MS = 30000;
export const SIGN_ATTEMPTS = 3;

const isTlogConflict = (error) => /\(409\)/.test(String(error?.message ?? ""));

/** Wraps `sign(bytes)` so a transparency-log 409 is signed again. */
export function retryOnTlogConflict(sign, { attempts = SIGN_ATTEMPTS, log = console.error } = {}) {
  return async (bytes) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await sign(bytes);
      } catch (error) {
        if (attempt >= attempts || !isTlogConflict(error)) throw error;
        log(`[sign-connector-release] transparency log answered 409 (attempt ${attempt}/${attempts}); signing again`);
      }
    }
  };
}

async function main() {
  const output = resolve(process.env.CONNECTOR_RELEASE_OUTPUT?.trim() || join(repositoryRoot, "release"));
  const subjects = releaseSubjects({ output });
  const { sign } = await import("sigstore");
  const count = await signSubjects(subjects, retryOnTlogConflict((bytes) => sign(bytes, { timeout: SIGN_TIMEOUT_MS })));
  console.log(`[sign-connector-release] signed ${count} release subject(s) into ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sign-connector-release] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
