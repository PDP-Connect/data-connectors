#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build the OCI artifact payload for one Collection Profile connector.
 *
 * This produces the files that `oras push` turns into an OCI image manifest,
 * per OCI-ARTIFACT-DESIGN-0911.md §1. It does NOT push and does NOT sign;
 * those are the workflow's job (.github/workflows/publish-polyfill-connectors.yml),
 * so that the bytes an artifact contains are decided by a script that can be
 * run and tested locally, while credentials stay in CI.
 *
 * Layout written to <out>/:
 *
 *   collection-profile.json   the manifest the runner consumes  (profile layer)
 *   code.tar.gz               esbuild single-file ESM bundle    (code layer)
 *   assets.tar.gz             brand icon, when the manifest declares one
 *   licenses.tar.gz           licence texts that must travel with the bytes
 *   provenance.json           what was built, from what, with what
 *   config.json               the small metadata blob a resolve reads (config)
 *   layers.json               media types + titles, for `oras push` to consume
 *
 * Why the code layer is a bundle rather than the source tree: a connector in
 * packages/polyfill-connectors is NOT self-contained. connectors/oura/index.ts
 * imports ../../src/connector-runtime.ts and four more siblings, so shipping
 * `connectors/oura/` alone ships something that cannot run. Bundling resolves
 * the in-tree graph and leaves only genuine npm packages external, which the
 * declared-externals gate below then forces us to enumerate rather than
 * discover at install time. This mirrors scripts/build-pdpp-artifact.mjs,
 * which solved the same problem for the two PDPP-upstream artifacts.
 *
 * Usage:
 *   node scripts/build-connector-oci-artifact.mjs --connector oura --out /tmp/oura
 *   [--version 0.1.0]     override the manifest's version (CI passes the tag)
 *   [--esbuild <path>]    resolve esbuild from elsewhere (sandboxes without a
 *                         workspace install)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "polyfill-connectors");

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * Every npm package a Collection Profile connector is allowed to leave
 * external, taken from packages/polyfill-connectors/package.json dependencies.
 *
 * This list is an allowlist, not a description. A bundle that reaches for
 * something absent here fails the build rather than becoming an artifact that
 * installs and then throws at collection time on a host that happens not to
 * have it. That is the same invariant build-pdpp-artifact.mjs:87-91 enforces.
 */
function runtimeDependencyAllowlist() {
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	return new Map(Object.entries(manifest.dependencies ?? {}));
}

/**
 * Refuse to build a connector whose code needs something the artifact does not
 * carry.
 *
 * The obvious check — `if (profile.external_tools)` — does not work, and
 * believing it did would be the expensive mistake here. NONE of the 46
 * manifests declares `external_tools`; the field does not exist in the tree.
 * Slack nonetheless shells out to a `slackdump` binary it expects on `PATH`,
 * and its bundle builds and imports perfectly cleanly, because a missing
 * subprocess is a RUN-time failure, not a load-time one. Trusting the absent
 * field would therefore have published a Slack artifact that verifies, signs,
 * installs, and then fails on the first collection against a host that happens
 * not to have slackdump installed — the precise failure this distribution path
 * exists to eliminate.
 *
 * So the check is positive: look at what the code actually reaches for.
 *
 *   1. A binary resolved from PATH or an env override. Bundling the binary is
 *      the fix (design §2.5), and it needs a per-platform tool layer plus a
 *      manifest that declares it — neither of which exists yet.
 *   2. A code-relative asset that escapes the install root once the entrypoint
 *      is flattened to `code/collection-profile.mjs`. Slack reads
 *      `new URL("../../config/slackdump-api-config.toml", import.meta.url)`,
 *      which resolves ABOVE the connector's own install root. That is design
 *      §1.3's rewrite obligation, and until the bundler performs the rewrite,
 *      the artifact would be missing a file the code opens.
 *
 * Both are lifted the moment the tool-layer path is implemented. Until then
 * this fails loudly, on a named connector, at build time.
 */
function assertNoUnbundledNativeDependency(connectorKey, profile, connectorDirectory) {
	const declaresBundledTools = (profile.external_tools ?? []).some(
		(tool) => tool.provisioning === "bundled",
	);
	if (declaresBundledTools) {
		throw new Error(
			`${connectorKey} declares a bundled external tool, but the per-platform tool layer is not implemented.`,
		);
	}

	const source = readFileSync(join(connectorDirectory, "index.ts"), "utf8");

	const pathResolvedBinary = source.match(/\b([A-Z][A-Z0-9_]*_BIN)\b/);
	if (pathResolvedBinary) {
		throw new Error(
			`${connectorKey} resolves an executable from PATH or $${pathResolvedBinary[1]}, which the artifact does not carry. ` +
				"A bundled per-platform tool layer must land first — see OCI-PUBLISH-0911.md, 'What Slack additionally needs'.",
		);
	}

	const escapingAsset = source.match(
		/new URL\(\s*"(\.\.\/[^"]*)"\s*,\s*import\.meta\.url/,
	);
	if (escapingAsset) {
		throw new Error(
			`${connectorKey} reads '${escapingAsset[1]}' relative to its module, which escapes the install root once the ` +
				"entrypoint is flattened to code/collection-profile.mjs. The bundler must rewrite that specifier first (design §1.3).",
		);
	}
}

function argument(name, fallback = null) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1]) {
		if (fallback === null) throw new Error(`${name} is required`);
		return fallback;
	}
	return process.argv[index + 1];
}

/**
 * A deterministic gzipped tar.
 *
 * `--sort=name`, a zeroed mtime, fixed owner and `--no-acls/--no-xattrs` exist
 * so that building the same input twice yields the same digest. Without them
 * the artifact digest changes on every build, which makes "is this the release
 * I verified" unanswerable and makes the reproducibility obligation in the
 * design doc (§7.4) impossible to meet. gzip -n drops the timestamp gzip would
 * otherwise write into its own header.
 */
function deterministicTarball(sourceDirectory, members, outputPath) {
	// tar and gzip are separate calls rather than tar -z: tar's own -z writes a
	// timestamp into the gzip header, gzip -n does not.
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

/**
 * The archive-safety rules from packages/connector-installer-core/index.mjs:259-338,
 * applied at BUILD time as well as install time.
 *
 * The installer already refuses these on the way in. Checking here too means a
 * connector that would produce an unsafe member fails in CI, on a named
 * connector, instead of shipping and failing on every host that installs it.
 */
function assertSafeMembers(members) {
	for (const member of members) {
		if (member.startsWith("/")) throw new Error(`Absolute path: ${member}`);
		if (member.split("/").includes(".."))
			throw new Error(`Parent traversal: ${member}`);
		if (member.includes("\\")) throw new Error(`Backslash: ${member}`);
		if (member.includes("\0")) throw new Error(`NUL: ${member}`);
	}
}

function filesUnder(root, prefix = "") {
	const results = [];
	for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) results.push(...filesUnder(root, path));
		else if (entry.isFile()) results.push(path);
		else throw new Error(`Refusing non-regular file ${path}`);
	}
	return results.sort();
}

async function main() {
	// `--connector` names the on-disk directory and manifest FILE, which is
	// snake_case throughout the tree. It is not necessarily the connector's
	// identity: 11 of the 46 manifests spell `connector_key` in kebab-case
	// (`apple_health.json` declares `apple-health`), and `connector_id`
	// consistently follows `connector_key` rather than the filename.
	//
	// The manifest wins. `connector_key` is what the design makes the OCI
	// repository name a total function of, so deriving the repository from the
	// filename instead would publish `connector/apple_health` while every
	// manifest, lock and catalog entry says `apple-health` — a split identity
	// baked into immutable digests. Naming the input by filename and the
	// artifact by manifest keeps the CLI usable without letting the tree's
	// directory convention leak into the distribution format.
	const connectorDirectoryName = argument("--connector");
	const outputRoot = argument("--out");
	if (!/^[a-z0-9][a-z0-9_]*$/.test(connectorDirectoryName)) {
		throw new Error(`Invalid connector directory name ${connectorDirectoryName}`);
	}

	const manifestPath = join(
		packageRoot,
		"manifests",
		`${connectorDirectoryName}.json`,
	);
	if (!existsSync(manifestPath)) {
		throw new Error(`No Collection Profile manifest at ${manifestPath}`);
	}
	const profileBytes = readFileSync(manifestPath);
	const profile = JSON.parse(profileBytes);

	const connectorKey = profile.connector_key;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(connectorKey ?? "")) {
		throw new Error(
			`${connectorDirectoryName}: connector_key '${connectorKey}' is not a valid OCI repository path component`,
		);
	}
	// The repository name is derived from connector_key alone, so a key that
	// collides across two manifests would publish two connectors to one
	// repository. Cheap to check, impossible to undo once digests are pinned.
	if (profile.connector_id && !profile.connector_id.endsWith(`/${connectorKey}`)) {
		throw new Error(
			`${connectorDirectoryName}: connector_id '${profile.connector_id}' does not end in connector_key '${connectorKey}'`,
		);
	}

	const connectorDirectory = join(
		packageRoot,
		"connectors",
		connectorDirectoryName,
	);
	const entrySource = join(connectorDirectory, "index.ts");
	if (!existsSync(entrySource)) {
		throw new Error(`No connector entrypoint at ${entrySource}`);
	}

	assertNoUnbundledNativeDependency(connectorKey, profile, connectorDirectory);

	const version = argument("--version", profile.version);
	if (!/^\d+\.\d+\.\d+/.test(version)) {
		throw new Error(`Version must be semver, got ${version}`);
	}

	const revision = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).trim();

	rmSync(outputRoot, { recursive: true, force: true });
	mkdirSync(outputRoot, { recursive: true });
	const staging = join(outputRoot, ".staging");

	// ---- code layer -------------------------------------------------------
	const esbuildPath = argument("--esbuild", "esbuild");
	const esbuild = await import(
		esbuildPath === "esbuild" ? "esbuild" : `file://${esbuildPath}`
	);
	const allowlist = runtimeDependencyAllowlist();
	const codeStaging = join(staging, "code");
	mkdirSync(codeStaging, { recursive: true });

	const build = await esbuild.build({
		absWorkingDir: packageRoot,
		banner: {
			js: `/* GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-connector-oci-artifact.mjs --connector ${connectorDirectoryName}. */`,
		},
		bundle: true,
		entryPoints: [entrySource],
		external: [...allowlist.keys()],
		format: "esm",
		metafile: true,
		minifyWhitespace: true,
		outfile: join(codeStaging, "collection-profile.mjs"),
		platform: "node",
		sourcemap: false,
		target: "node24",
	});

	const externalImports = [
		...new Set(
			Object.values(build.metafile.outputs)
				.flatMap((output) => output.imports)
				.filter(
					(entry) => entry.external && !entry.path.startsWith("node:"),
				)
				.map((entry) => entry.path),
		),
	].sort();

	// A subpath import like "@pdpp/connector-protocol/auth" is satisfied by the
	// "@pdpp/connector-protocol" dependency, so the allowlist check compares
	// package names, not specifiers.
	const packageNameOf = (specifier) =>
		specifier.startsWith("@")
			? specifier.split("/").slice(0, 2).join("/")
			: specifier.split("/")[0];
	const undeclared = externalImports.filter(
		(specifier) => !allowlist.has(packageNameOf(specifier)),
	);
	if (undeclared.length) {
		throw new Error(
			`Undeclared external imports remain: ${undeclared.join(", ")}`,
		);
	}

	const codeMembers = filesUnder(codeStaging);
	assertSafeMembers(codeMembers);
	const codeTarball = deterministicTarball(
		codeStaging,
		codeMembers,
		join(outputRoot, "code.tar.gz"),
	);

	// ---- assets layer -----------------------------------------------------
	// Optional per the design doc's layer cardinality table. The brand icon is
	// the only asset any of the 46 manifests declares today.
	let assetsTarball = null;
	const iconRelative = profile.brand?.icon;
	if (iconRelative) {
		const iconSource = join(packageRoot, "manifests", iconRelative);
		if (!existsSync(iconSource)) {
			throw new Error(`Manifest declares brand.icon ${iconRelative}, missing at ${iconSource}`);
		}
		const assetsStaging = join(staging, "assets");
		mkdirSync(join(assetsStaging, dirname(iconRelative)), { recursive: true });
		writeFileSync(join(assetsStaging, iconRelative), readFileSync(iconSource));
		const assetMembers = filesUnder(assetsStaging);
		assertSafeMembers(assetMembers);
		assetsTarball = deterministicTarball(
			assetsStaging,
			assetMembers,
			join(outputRoot, "assets.tar.gz"),
		);
	}

	// ---- licences layer ---------------------------------------------------
	// Required unconditionally, not only for AGPL tools: an artifact is
	// distribution, and the Apache-2.0 licence and NOTICE have to travel with
	// the bytes rather than being reachable only from the repository.
	const licenseStaging = join(staging, "licenses");
	mkdirSync(licenseStaging, { recursive: true });
	writeFileSync(
		join(licenseStaging, "LICENSE"),
		readFileSync(join(repoRoot, "LICENSE")),
	);
	writeFileSync(
		join(licenseStaging, "NOTICE"),
		readFileSync(join(repoRoot, "NOTICE")),
	);
	const licenseMembers = filesUnder(licenseStaging);
	assertSafeMembers(licenseMembers);
	const licensesTarball = deterministicTarball(
		licenseStaging,
		licenseMembers,
		join(outputRoot, "licenses.tar.gz"),
	);

	// ---- profile layer ----------------------------------------------------
	writeFileSync(join(outputRoot, "collection-profile.json"), profileBytes);

	// ---- provenance layer -------------------------------------------------
	const inputInventory = Object.keys(build.metafile.inputs)
		.filter((input) => !input.includes("node_modules"))
		.sort()
		.map((input) => ({
			path: input,
			sha256: sha256(readFileSync(join(packageRoot, input))),
		}));

	const provenance = {
		generated_file_notice:
			"GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-connector-oci-artifact.mjs.",
		connector_key: connectorKey,
		connector_id: profile.connector_id,
		version,
		protocol_version: profile.protocol_version,
		source: {
			repository: "https://github.com/PDP-Connect/data-connectors",
			revision,
			package: "packages/polyfill-connectors",
		},
		source_inventory: inputInventory,
		build: {
			esbuild_version: esbuild.version,
			options: {
				bundle: true,
				format: "esm",
				minifyWhitespace: true,
				platform: "node",
				target: "node24",
			},
		},
		runtime_requirements: profile.runtime_requirements ?? null,
		external_runtime_packages: externalImports.map((specifier) => ({
			specifier,
			package: packageNameOf(specifier),
			version: allowlist.get(packageNameOf(specifier)),
		})),
		outputs: {
			"collection-profile.json": sha256(profileBytes),
			"code.tar.gz": sha256(codeTarball),
			"assets.tar.gz": assetsTarball ? sha256(assetsTarball) : null,
			"licenses.tar.gz": sha256(licensesTarball),
		},
	};
	const provenanceBytes = Buffer.from(
		`${JSON.stringify(provenance, null, 2)}\n`,
	);
	writeFileSync(join(outputRoot, "provenance.json"), provenanceBytes);

	// ---- config blob ------------------------------------------------------
	// Deliberately a restatement of a few manifest facts, not a pointer to
	// them. The manager reads this before deciding to pull, then cross-checks
	// it against the layers it actually received (design §5.2) — a check that
	// only means something because the two are stored separately.
	const config = {
		config_version: "1.0",
		connector_key: connectorKey,
		connector_id: profile.connector_id,
		version,
		protocol_version: profile.protocol_version,
		display_name: profile.display_name,
		tier: profile.capabilities?.public_listing?.tier ?? "development",
		platform: { os: "any", architecture: "any" },
		profile_digest: sha256(profileBytes),
		entrypoint: "code/collection-profile.mjs",
		runtime: {
			node: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
				.engines?.node,
			bindings: Object.keys(profile.runtime_requirements?.bindings ?? {}).sort(),
		},
		bundled_tools: [],
		licenses: "Apache-2.0",
		source: {
			repository: "https://github.com/PDP-Connect/data-connectors",
			revision,
		},
	};
	writeFileSync(
		join(outputRoot, "config.json"),
		`${JSON.stringify(config, null, 2)}\n`,
	);

	// ---- layer descriptor list -------------------------------------------
	// `oras push` takes file:mediaType pairs; emitting them here keeps the
	// media types beside the bytes they describe rather than duplicated in YAML.
	const layers = [
		{
			file: "collection-profile.json",
			mediaType: "application/vnd.pdpp.connector.profile.v1+json",
		},
		{
			file: "code.tar.gz",
			mediaType: "application/vnd.pdpp.connector.code.v1.tar+gzip",
		},
		...(assetsTarball
			? [
					{
						file: "assets.tar.gz",
						mediaType: "application/vnd.pdpp.connector.assets.v1.tar+gzip",
					},
				]
			: []),
		{
			file: "licenses.tar.gz",
			mediaType: "application/vnd.pdpp.connector.licenses.v1.tar+gzip",
		},
		{
			file: "provenance.json",
			mediaType: "application/vnd.pdpp.connector.provenance.v1+json",
		},
	];
	writeFileSync(
		join(outputRoot, "layers.json"),
		`${JSON.stringify({ artifactType: "application/vnd.pdpp.connector.v1+json", config: { file: "config.json", mediaType: "application/vnd.pdpp.connector.config.v1+json" }, layers, annotations: { "org.opencontainers.image.source": "https://github.com/PDP-Connect/data-connectors", "org.opencontainers.image.revision": revision, "org.opencontainers.image.version": version, "org.opencontainers.image.licenses": "Apache-2.0", "dev.pdpp.connector.key": connectorKey, "dev.pdpp.connector.id": profile.connector_id, "dev.pdpp.protocol.version": profile.protocol_version } }, null, 2)}\n`,
	);

	rmSync(staging, { recursive: true, force: true });

	console.log(
		`Built ${connectorKey}@${version} into ${relative(repoRoot, outputRoot) || outputRoot}`,
	);
	for (const layer of layers) {
		console.log(`  ${layer.file}  ${layer.mediaType}`);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
