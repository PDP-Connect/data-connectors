#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Download slackdump's own tagged GitHub release binaries for every platform
 * slack.json's `external_tools[]` declares, and print the
 * `--tool-binary`-shaped output line build-connector-oci-artifact.mjs's
 * `--tool-binary` flag expects, one per platform.
 *
 * WHY THIS EXISTS, AND WHY AT BUILD TIME RATHER THAN COLLECTION TIME. This is
 * NOT the "fetch at collection time" pattern OCI-TOOL-LAYER-0918.md §3.5
 * warns against (the esbuild postinstall lesson) — it runs in CI, once, at
 * PUBLISH time, and its output becomes bytes INSIDE a signed, digest-pinned
 * artifact. A consumer's install never reaches the network for slackdump;
 * it reads the artifact's own `tools/` layer. What differs from a vendored
 * binary checked into the repo is only where the CI runner gets the bytes
 * from — upstream's own tagged release, pinned by tag, not a mutable branch
 * or "latest".
 *
 * The tag is pinned here, not derived from "latest", so a publish is
 * reproducible against a named upstream release and a supply-chain change on
 * slackdump's side cannot silently change what PDPP ships without a diff to
 * this file.
 *
 * Usage:
 *   node scripts/fetch-slackdump-release-binaries.mjs --out /tmp/slackdump-bin
 *   prints one line per platform: slackdump=<os>/<arch>=<path>
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Bump deliberately, not automatically: see the module comment.
const SLACKDUMP_RELEASE_TAG = "v4.4.5";

// Maps this repo's `os/arch` platform spec to the exact asset name in
// slackdump's own release, and to the member name inside that archive.
const RELEASE_ASSETS = {
	"linux/amd64": { asset: "slackdump_Linux_x86_64.tar.gz", member: "slackdump", kind: "tar.gz" },
	"linux/arm64": { asset: "slackdump_Linux_arm64.tar.gz", member: "slackdump", kind: "tar.gz" },
	"darwin/arm64": { asset: "slackdump_macOS_arm64.tar.gz", member: "slackdump", kind: "tar.gz" },
	"windows/amd64": { asset: "slackdump_Windows_x86_64.zip", member: "slackdump.exe", kind: "zip" },
};

function argument(name, fallback = null) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) {
		if (fallback === null) throw new Error(`${name} is required`);
		return fallback;
	}
	return process.argv[index + 1];
}

async function downloadAsset(assetName) {
	const url = `https://github.com/rusq/slackdump/releases/download/${SLACKDUMP_RELEASE_TAG}/${assetName}`;
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

async function main() {
	const outputRoot = argument("--out");
	mkdirSync(outputRoot, { recursive: true });

	const lines = [];
	for (const [platformSpec, spec] of Object.entries(RELEASE_ASSETS)) {
		const archiveBytes = await downloadAsset(spec.asset);
		const archivePath = join(outputRoot, spec.asset);
		writeFileSync(archivePath, archiveBytes);

		const extractDir = join(outputRoot, platformSpec.replace("/", "-"));
		mkdirSync(extractDir, { recursive: true });
		if (spec.kind === "tar.gz") {
			execFileSync("tar", ["-xzf", archivePath, "-C", extractDir, spec.member]);
		} else {
			execFileSync("unzip", ["-o", archivePath, spec.member, "-d", extractDir]);
		}

		const extractedPath = join(extractDir, spec.member);
		const finalPath = join(extractDir, spec.member);
		if (extractedPath !== finalPath) renameSync(extractedPath, finalPath);
		if (!existsSync(finalPath)) {
			throw new Error(`Expected ${spec.member} after extracting ${spec.asset}, found nothing at ${finalPath}`);
		}

		lines.push(`slackdump=${platformSpec}=${finalPath}`);
	}

	for (const line of lines) console.log(line);
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
