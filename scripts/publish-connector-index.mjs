#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Push and sign a platform-bearing connector artifact — an OCI image INDEX
 * with one child manifest per platform (OCI-TOOL-LAYER-0918.md §5) — with the
 * same discipline `publish-polyfill-connectors.yml`'s inline "Push and sign"
 * step already applies to a single-manifest artifact:
 *
 *   1. push every object UNTAGGED first (content-addressed, nothing mutable
 *      moves yet).
 *   2. a REPUBLICATION check against the version tag — present/absent/unknown,
 *      never "empty reads as go ahead" — refuses before anything is signed if
 *      the version is already published under a DIFFERENT digest.
 *   3. sign, then tag. Signing first means an interrupted run leaves an
 *      unreferenced signed object, not a visible, unverifiable tag.
 *
 * What's structurally different from the single-manifest case: there are
 * N+1 objects to push and sign (N platform children plus the index), not
 * one, and each child manifest carries its OWN independent Cosign signature
 * — a consumer resolves the index digest, picks its platform's child, and
 * verifies THAT child's signature (packages/connector-installer-core's
 * `resolveIndexPlatformChild`/`fetchOciArtifact` do exactly this on the
 * consumer side). Signing only the index would leave every child unsigned by
 * this workflow's identity, which the installer's own child-signature check
 * (I-T4 in oci.test.mjs) refuses.
 *
 * Kept as a SEPARATE script from the inline bash rather than folded into it,
 * because the existing single-manifest step is itself a hardened, carefully
 * comment-documented sequence guarding real historical defects (silent
 * republication, tag re-resolution between sign and verify) — this mirrors
 * its guarantees for the index case without touching or re-deriving them for
 * the 43 JS-only connectors that never take this path.
 *
 * Usage:
 *   GH_TOKEN=... node scripts/publish-connector-index.mjs \
 *     --artifact "$RUNNER_TEMP/artifact" \
 *     --repository ghcr.io/pdp-connect/connector/slack \
 *     --version 0.6.0 \
 *     --connector slack
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookupManifest } from "./lookup-manifest.mjs";

const REQUIRED = Symbol("required");

function argument(name, fallback = REQUIRED) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) {
		if (fallback === REQUIRED) throw new Error(`${name} is required`);
		return fallback;
	}
	return process.argv[index + 1];
}

function oras(args, options = {}) {
	return execFileSync("oras", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

/** Push one manifest directory's layers, untagged, and return its digest. */
function pushManifest(directory, repository, { platform = null, annotations = {} } = {}) {
	const spec = JSON.parse(readFileSync(join(directory, "layers.json"), "utf8"));
	const layerArgs = spec.layers.map((layer) => `${layer.file}:${layer.mediaType}`);
	const annotationArgs = Object.entries({ ...spec.annotations, ...annotations }).flatMap(
		([key, value]) => ["--annotation", `${key}=${value}`],
	);
	const args = [
		"push",
		repository,
		"--artifact-type",
		spec.artifactType,
		"--config",
		`config.json:${spec.config.mediaType}`,
		...annotationArgs,
		...(platform ? ["--annotation", `dev.pdpp.platform=${platform.os}/${platform.architecture}`] : []),
		"--format",
		"json",
		...layerArgs,
	];
	const result = JSON.parse(oras(args, { cwd: directory }));
	if (!/^sha256:[0-9a-f]{64}$/.test(result.digest)) {
		throw new Error(`oras push in ${directory} did not report a sha256 digest (got '${result.digest}')`);
	}
	return { digest: result.digest, size: result.size };
}

function signDigest(repository, digest, { key = null, allowInsecureRegistry = false } = {}) {
	// `--key` and `--allow-insecure-registry-tls` exist ONLY for the local
	// `--scheme http` test path — see `scheme`'s own comment in `main`.
	// Production always signs keylessly against a real GHCR TLS endpoint.
	execFileSync(
		"cosign",
		[
			"sign",
			"--yes",
			...(key ? ["--key", key, "--tlog-upload=false"] : []),
			...(allowInsecureRegistry ? ["--allow-insecure-registry"] : []),
			`${repository}@${digest}`,
		],
		{ stdio: "inherit" },
	);
}

async function checkNotAlreadyPublishedDifferently({ registry, name, version, digest, ghToken, actor, scheme }) {
	const credential = ghToken ? Buffer.from(`${actor}:${ghToken}`).toString("base64") : undefined;
	const result = await lookupManifest({ registry, name, tag: version, credential, scheme });

	if (result.outcome !== "present" && result.outcome !== "absent") {
		throw new Error(
			`${registry}/${name}:${version} could not be resolved: the manifest lookup returned '${result.outcome}' ` +
				`rather than a definite present/absent answer (${result.reason ?? "no reason given"}). Refusing to publish.`,
		);
	}
	if (result.outcome === "present" && result.digest !== digest) {
		throw new Error(
			`${registry}/${name}:${version} already published as ${result.digest}; refusing to redefine it as ${digest}.`,
		);
	}
}

async function main() {
	const artifactRoot = argument("--artifact");
	const repository = argument("--repository");
	const version = argument("--version");
	const connector = argument("--connector");
	// `--scheme http` exists ONLY for testing against a local, unauthenticated
	// `registry:2` the way OCI-PUBLISH-0911.md's own build report did for the
	// single-manifest path. Production never passes it: GHCR is always
	// `https`, and GH_TOKEN/GH_ACTOR are required whenever it is not set.
	const scheme = argument("--scheme", "https");
	// `--cosign-key` exists ONLY for the local test path, same as `--scheme
	// http`: production always signs keylessly (no key exists to pass).
	const cosignKey = argument("--cosign-key", null);
	const ghToken = process.env.GH_TOKEN ?? null;
	const actor = process.env.GH_ACTOR ?? null;
	if (scheme === "https" && (!ghToken || !actor)) {
		throw new Error("GH_TOKEN and GH_ACTOR must be set in the environment");
	}

	const indexPath = join(artifactRoot, "index.json");
	const index = JSON.parse(readFileSync(indexPath, "utf8"));
	if (!Array.isArray(index.manifests) || index.manifests.length === 0) {
		throw new Error(`${indexPath} declares no platform manifests`);
	}

	const registry = repository.split("/")[0];
	const name = repository.slice(registry.length + 1);

	// Step 1: push every CHILD first, untagged. Each child directory carries
	// its own config.json/layers.json but the common layers (profile/code/
	// licenses/provenance) at the artifact root — layers.json lists filenames
	// only, so `oras push` is run from the CHILD directory with those common
	// files also present there via a relative reference. Rather than copy
	// them, the push runs from the artifact root with layer paths qualified.
	const childResults = [];
	for (const entry of index.manifests) {
		const childDir = join(artifactRoot, entry.directory);
		// layers.json's file list mixes common-layer filenames (which live at
		// the artifact root) and this child's own tools.tar.gz/config.tar.gz
		// (which live in childDir). oras push takes one --cwd; the common
		// files are the ones NOT already present in childDir, so they are
		// referenced by relative path FROM childDir back to the root.
		const spec = JSON.parse(readFileSync(join(childDir, "layers.json"), "utf8"));
		for (const layer of spec.layers) {
			if (!existsSync(join(childDir, layer.file)) && existsSync(join(artifactRoot, layer.file))) {
				writeFileSync(join(childDir, layer.file), readFileSync(join(artifactRoot, layer.file)));
			}
		}

		const { digest, size } = pushManifest(childDir, repository, { platform: entry.platform });
		childResults.push({ platform: entry.platform, digest, size, directory: entry.directory });
		console.log(`pushed ${repository}@${digest} (${entry.platform.os}/${entry.platform.architecture})`);
	}

	// Step 2: assemble and push the INDEX itself, referencing each child by
	// the exact digest AND size `oras push` just reported for it (never by
	// re-deriving either locally, and never by a second round trip to the
	// registry — the push result already carries the size of the bytes the
	// registry now holds under that digest).
	//
	// `oras manifest index create` does not exist in the ORAS version this
	// workflow pins (1.2.3) — confirmed locally against a real install, not
	// assumed from the docs. This is precisely the tooling-maturity gap
	// OCI-TOOL-LAYER-0918.md §4 found in OpenTofu's own index implementation
	// ("OpenTofu hand-rolled its own index construction rather than using
	// ORAS's command directly"); the fix here is the same one: construct the
	// index JSON directly and push it as a raw manifest via
	// `oras manifest push`, which DOES exist and accepts an arbitrary
	// manifest file plus its declared mediaType.
	const indexManifest = {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.index.v1+json",
		artifactType: index.artifactType,
		manifests: childResults.map((child) => ({
			mediaType: "application/vnd.oci.image.manifest.v1+json",
			digest: child.digest,
			size: child.size,
			platform: child.platform,
		})),
		annotations: index.annotations,
	};

	const indexManifestPath = join(artifactRoot, "index-manifest.json");
	writeFileSync(indexManifestPath, JSON.stringify(indexManifest));

	const indexPushResult = oras([
		"manifest",
		"push",
		"--media-type",
		indexManifest.mediaType,
		"--descriptor",
		repository,
		indexManifestPath,
	]);
	const indexDescriptor = JSON.parse(indexPushResult);
	const indexDigest = indexDescriptor.digest;
	if (!/^sha256:[0-9a-f]{64}$/.test(indexDigest ?? "")) {
		throw new Error(`oras manifest push did not report a sha256 digest for the index:\n${indexPushResult}`);
	}
	console.log(`pushed index ${repository}@${indexDigest}`);

	// Step 3: republication check on the INDEX digest — the object the lock
	// pins and the tag will name — exactly as the single-manifest path checks
	// before tagging.
	await checkNotAlreadyPublishedDifferently({
		registry,
		name,
		version,
		digest: indexDigest,
		ghToken,
		actor,
		scheme,
	});

	// Step 4: sign, then tag — every child independently, then the index.
	// Order (children before index) does not matter for correctness (each
	// signature covers only its own digest), but children are signed first so
	// an interrupted run's failure mode is "some children signed, index not
	// yet pushed/tagged" rather than a tagged-but-partially-unsigned index.
	const signOptions = { key: cosignKey, allowInsecureRegistry: scheme === "http" };
	for (const child of childResults) {
		signDigest(repository, child.digest, signOptions);
	}
	signDigest(repository, indexDigest, signOptions);

	oras(["tag", `${repository}@${indexDigest}`, version]);

	console.log(`published ${connector} ${repository}@${indexDigest} as ${version}`);
	process.stdout.write(`digest=${indexDigest}\n`);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
