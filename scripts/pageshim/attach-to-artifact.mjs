#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Add a PageShim bundle to a connector artifact after its normal OCI build.
 *
 * PageShim bytes travel inside the existing, installer-supported assets layer.
 * The config records the bundle's path and raw-byte digest, so the catalog can
 * pin that component while the connector manifest digest and its existing
 * Cosign signature cover the complete release.
 *
 * Usage: node scripts/pageshim/attach-to-artifact.mjs --connector <manifest>
 *   --artifact <build-connector-oci-artifact output>
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { buildPageshim } from "./build.mjs";
import { isPageShimCapable } from "./capabilities.mjs";

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) {
		throw new Error(`${name} is required`);
	}
	return process.argv[index + 1];
}

function filesUnder(root, prefix = "") {
	const results = [];
	for (const entry of readdirSync(join(root, prefix), {
		withFileTypes: true,
	})) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) results.push(...filesUnder(root, path));
		else if (entry.isFile()) results.push(path);
		else throw new Error(`Refusing non-regular asset ${path}`);
	}
	return results.sort();
}

function assertSafeArchive(archivePath) {
	const listing = execFileSync("tar", ["-tvzf", archivePath], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	const members = execFileSync("tar", ["-tzf", archivePath], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	})
		.split("\n")
		.filter(Boolean);
	const entries = listing.split("\n").filter(Boolean);
	if (members.length !== entries.length) {
		throw new Error("Could not read every assets archive member");
	}
	for (const [index, line] of entries.entries()) {
		const mode = line[0];
		const member = members[index];
		if (mode !== "-" && mode !== "d") {
			throw new Error(`Refusing non-regular assets archive member: ${member}`);
		}
		if (
			member.startsWith("/") ||
			member.split("/").includes("..") ||
			member.includes("\\") ||
			member.includes("\0")
		) {
			throw new Error(`Refusing unsafe assets archive member: ${member}`);
		}
	}
}

function deterministicTarball(sourceDirectory, members, outputPath) {
	const tar = execFileSync(
		"tar",
		[
			"--sort=name",
			"--mtime=UTC 1970-01-01",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"--no-acls",
			"--no-xattrs",
			"--no-selinux",
			"--format=gnu",
			"-cf",
			"-",
			"-C",
			sourceDirectory,
			...members,
		],
		{ maxBuffer: 512 * 1024 * 1024 },
	);
	const gzipped = execFileSync("gzip", ["-n", "-9"], {
		input: tar,
		maxBuffer: 512 * 1024 * 1024,
	});
	writeFileSync(outputPath, gzipped);
	return gzipped;
}

async function main() {
	const connector = argument("--connector");
	const artifactRoot = argument("--artifact");
	if (!/^[a-z0-9][a-z0-9_]*$/.test(connector)) {
		throw new Error(`Invalid connector directory name ${connector}`);
	}
	const configPath = join(artifactRoot, "config.json");
	const layersPath = join(artifactRoot, "layers.json");
	const provenancePath = join(artifactRoot, "provenance.json");
	for (const path of [configPath, layersPath, provenancePath]) {
		if (!existsSync(path))
			throw new Error(`Missing built artifact file ${path}`);
	}
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	const layersDocument = JSON.parse(readFileSync(layersPath, "utf8"));
	const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
	const profile = JSON.parse(
		readFileSync(join(artifactRoot, "collection-profile.json"), "utf8"),
	);
	const sourceManifest = JSON.parse(
		readFileSync(join(process.cwd(), "connectors", connector, "manifest.json"), "utf8"),
	);
	if (
		config.connector_key !== sourceManifest.connector_key ||
		profile.connector_key !== sourceManifest.connector_key
	) {
		throw new Error(
			`requested connector ${connector.replaceAll("_", "-")} does not match artifact connector ${config.connector_key}`,
		);
	}
	if (
		config.connector_id !== sourceManifest.connector_id ||
		profile.connector_id !== sourceManifest.connector_id
	) {
		throw new Error(
			`${sourceManifest.connector_key} artifact connector ID does not match manifest connector ID`,
		);
	}
	if (
		config.version !== sourceManifest.version ||
		profile.version !== sourceManifest.version
	) {
		throw new Error(
			`${config.connector_key} artifact version ${config.version} does not match manifest version ${sourceManifest.version}`,
		);
	}
	if (!isPageShimCapable(sourceManifest)) {
		console.log(`${connector} has no PageShim bundle`);
		return;
	}
	if (config.mobile?.pageshim) {
		throw new Error(`${connector} artifact already declares a PageShim bundle`);
	}
	if (
		config.connector_key !== profile.connector_key ||
		config.version !== profile.version
	) {
		throw new Error(
			`${connector} artifact config identity or version disagrees with its profile`,
		);
	}
	if (!provenance.outputs || typeof provenance.outputs !== "object") {
		throw new Error(`${connector} artifact provenance has no outputs object`);
	}
	const assetsLayers = layersDocument.layers.filter(
		(layer) =>
			layer.mediaType === "application/vnd.pdpp.connector.assets.v1.tar+gzip",
	);
	if (assetsLayers.length > 1) {
		throw new Error(
			`${connector} artifact declares more than one assets layer`,
		);
	}
	const otherAssetsLayer = layersDocument.layers.find(
		(layer) =>
			layer.file === "assets.tar.gz" &&
			layer.mediaType !== "application/vnd.pdpp.connector.assets.v1.tar+gzip",
	);
	if (otherAssetsLayer) {
		throw new Error(
			`${connector} artifact declares assets.tar.gz with an unexpected media type`,
		);
	}

	const work = mkdtempSync(join(artifactRoot, ".pageshim-"));
	try {
		const assetsRoot = join(work, "assets");
		mkdirSync(assetsRoot, { recursive: true });
		const assetsArchive = join(artifactRoot, "assets.tar.gz");
		if (assetsLayers.length === 1) {
			assertSafeArchive(assetsArchive);
			execFileSync("tar", ["-xzf", assetsArchive, "-C", assetsRoot]);
		}

		const bundlePath = `pageshim/${connector}.js`;
		const bundleFile = join(assetsRoot, bundlePath);
		mkdirSync(dirname(bundleFile), { recursive: true });
		await buildPageshim({ connector, outfile: bundleFile });
		const bundleBytes = readFileSync(bundleFile);
		const assetMembers = filesUnder(assetsRoot);
		const archivedAssets = deterministicTarball(
			assetsRoot,
			assetMembers,
			assetsArchive,
		);

		if (assetsLayers.length === 0) {
			const codeIndex = layersDocument.layers.findIndex(
				(layer) =>
					layer.mediaType === "application/vnd.pdpp.connector.code.v1.tar+gzip",
			);
			if (codeIndex === -1)
				throw new Error(`${connector} artifact has no code layer`);
			layersDocument.layers.splice(codeIndex + 1, 0, {
				file: "assets.tar.gz",
				mediaType: "application/vnd.pdpp.connector.assets.v1.tar+gzip",
			});
		}

		config.mobile = {
			...(config.mobile ?? {}),
			pageshim: {
				layer: "assets",
				path: bundlePath,
				media_type: "text/javascript",
				digest: sha256(bundleBytes),
				size: bundleBytes.length,
			},
		};
		provenance.outputs["assets.tar.gz"] = sha256(archivedAssets);
		provenance.outputs["pageshim.bundle.js"] = sha256(bundleBytes);
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
		writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
		writeFileSync(layersPath, `${JSON.stringify(layersDocument, null, 2)}\n`);
		console.log(
			`Attached ${config.connector_key}@${config.version} PageShim bundle (${bundleBytes.length} bytes)`,
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

await main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
