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
 * Layout written to <out>/, for a JS-only connector (43 of 46) — one OCI
 * image MANIFEST, unchanged from before this file existed:
 *
 *   collection-profile.json   the manifest the runner consumes  (profile layer)
 *   code.tar.gz               esbuild single-file ESM bundle    (code layer)
 *   assets.tar.gz             brand icon, when the manifest declares one
 *   licenses.tar.gz           licence texts that must travel with the bytes
 *   provenance.json           what was built, from what, with what
 *   config.json               the small metadata blob a resolve reads (config)
 *   layers.json               media types + titles, for `oras push` to consume
 *
 * A connector that declares `provisioning: "bundled"` on a
 * `runtime_requirements.external_tools[]` entry (today: only `slack`) instead
 * gets an OCI image INDEX, per OCI-TOOL-LAYER-0918.md §5: the five files above
 * are still built once and shared, plus one child manifest per platform the
 * tool supports:
 *
 *   platforms/<os>-<arch>/config.json    restates profile + this platform
 *   platforms/<os>-<arch>/layers.json    this child's own layer list
 *   platforms/<os>-<arch>/tools.tar.gz   this platform's tool binaries (+config)
 *   index.json                           the OCI image index tying it together
 *
 * Each child manifest carries the SAME common layers (profile/code/assets/
 * licenses/provenance) plus its own `tools.tar.gz`, so a consumer that
 * resolves the wrong child still gets a self-consistent, importable artifact
 * — it is simply missing the binary for a platform it was never going to run
 * on. The index's `manifests[].platform` uses the spec's real `os`/
 * `architecture` fields (OCI-TOOL-LAYER-0918.md §1); nothing finer is needed
 * because slackdump is a static, `CGO_ENABLED=0` build with no glibc or
 * keyring variance (EXTERNAL-TOOL-DESIGN-0918.md).
 *
 * Why the code layer is a bundle rather than the source tree: a connector in
 * packages/polyfill-connectors is NOT self-contained. connectors/oura/index.ts
 * imports ../../src/connector-runtime.ts and four more siblings, so shipping
 * `connectors/oura/` alone ships something that cannot run. Bundling resolves
 * the in-tree graph and leaves only genuine npm packages external, which the
 * declared-externals gate below then forces us to enumerate rather than
 * discover at install time.
 *
 * Usage:
 *   node scripts/build-connector-oci-artifact.mjs --connector oura --out /tmp/oura
 *   [--version 0.1.0]     override the manifest's version (CI passes the tag)
 *   [--esbuild <path>]    resolve esbuild from elsewhere (sandboxes without a
 *                         workspace install)
 *   [--tool-binary <tool>=<platform>=<path>]   a locally-built or downloaded
 *                         tool binary to embed for one platform (repeatable).
 *                         `<tool>` matches an external_tools[].name declaring
 *                         `provisioning: "bundled"`; `<platform>` is one of
 *                         its declared `platforms[]` entries (`os/arch`). CI
 *                         passes one per platform in the release matrix; a
 *                         platform with no `--tool-binary` fails the build
 *                         rather than publish an index missing a promised
 *                         child.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyExternals,
	HOST_PROVIDED,
	HOST_RUNTIME_CONTRACT_VERSION,
	hostNodeRange,
	packageNameOf,
} from "./connector-host-runtime-contract.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "polyfill-connectors");

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * The connector package's declared dependencies, used for provenance only.
 *
 * This used to be the bundler's `external` list, which is what made the
 * artifact unable to stand on its own: every dependency was left out of the
 * bytes, and provenance recorded version RANGES and repository-relative
 * `file:./vendor/*.tgz` paths in their place. Neither is an installable set for
 * anyone who is not standing in this checkout. What travels in the artifact is
 * now decided by the host-runtime contract, not by this list.
 */
function declaredDependencies() {
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	return new Map(Object.entries(manifest.dependencies ?? {}));
}

/**
 * A connector's declared `external_tools[]`, wherever the manifest actually
 * puts it.
 *
 * The three manifests that declare one (`google_messages`, `signal`, `slack`)
 * spell it `runtime_requirements.external_tools`; `profile.external_tools`
 * itself is empty on all 46. Reading the top-level key — the obvious check —
 * silently passes every native-tool connector, which is how Slack's bundle
 * used to build and import cleanly while shelling out to a `slackdump` binary
 * the artifact did not carry (OCI-PUBLISH-0911.md §4a).
 */
function declaredExternalTools(profile) {
	return profile.runtime_requirements?.external_tools ?? [];
}

/**
 * Refuse to build a connector whose code needs something the artifact does not
 * carry, UNLESS the manifest declares `provisioning: "bundled"` for that tool
 * — in which case the caller builds an OCI image index with a per-platform
 * tool layer instead of a single manifest, and this guard's job shrinks to
 * catching the two failures bundling does not fix on its own.
 *
 * The check stays positive: look at what the code actually reaches for.
 *
 *   1. A binary resolved from PATH or an env override, on a connector that
 *      does NOT declare `provisioning: "bundled"` for the matching tool. A
 *      connector that does declare it is expected to still reference the env
 *      override as a local-development escape hatch (see
 *      `resolveSlackdumpBin` in connectors/slack/index.ts) — what changes is
 *      that the primary path is now an in-artifact absolute path the
 *      installer resolves, not a bare `PATH` lookup, so this refusal is
 *      scoped to connectors that never bundle at all (today: signal,
 *      google_messages).
 *   2. A code-relative asset that escapes the install root once the
 *      entrypoint is flattened to `code/collection-profile.mjs`. A path is
 *      "escaping" only if it climbs OUT of the connector's own install root
 *      — `../x` from `code/collection-profile.mjs` lands at `<install
 *      root>/x`, which is inside it; `../../x` climbs one level further, out
 *      of the artifact entirely. Slack originally read
 *      `../../config/slackdump-api-config.toml` (escaping); the fix ships the
 *      config file as a `config/` layer sibling to `code/` and reads
 *      `../config/slackdump-api-config.toml` (inside).
 */
function assertNoUnbundledNativeDependency(connectorKey, profile, connectorDirectory) {
	const bundledToolNames = new Set(
		declaredExternalTools(profile)
			.filter((tool) => tool.provisioning === "bundled")
			.map((tool) => tool.name),
	);

	const source = readFileSync(join(connectorDirectory, "index.ts"), "utf8");

	const pathResolvedBinary = source.match(/\b([A-Z][A-Z0-9_]*_BIN)\b/);
	if (pathResolvedBinary) {
		const envOverride = pathResolvedBinary[1];
		const toolsWithThisOverride = declaredExternalTools(profile).filter(
			(tool) => tool.detect?.executable_env_override === envOverride,
		);
		const bundled = toolsWithThisOverride.some((tool) => bundledToolNames.has(tool.name));
		if (!bundled) {
			throw new Error(
				`${connectorKey} resolves an executable from PATH or $${envOverride}, which the artifact does not carry. ` +
					'Declare provisioning: "bundled" plus platforms[] on the matching runtime_requirements.external_tools[] ' +
					"entry, or provisioning: \"host_provided\" if it structurally cannot be bundled.",
			);
		}
	}

	const escapingAsset = source.match(
		/new URL\(\s*"(\.\.\/\.\.\/[^"]*)"\s*,\s*import\.meta\.url/,
	);
	if (escapingAsset) {
		throw new Error(
			`${connectorKey} reads '${escapingAsset[1]}' relative to its module, which escapes the install root once the ` +
				"entrypoint is flattened to code/collection-profile.mjs. Rewrite it to climb at most one level " +
				"(e.g. '../config/…') and ship the target as a layer sibling to code/.",
		);
	}
}

/**
 * A manifest declaring `provisioning: "bundled"` is a PROMISE, not a build.
 * `assertNoUnbundledNativeDependency` stops refusing Slack's PATH lookup the
 * moment the manifest says "bundled" — that guard only ever asked what the
 * MANIFEST claims, on purpose, because it runs before `--tool-binary` is even
 * parsed. This is the second half: for every platform a bundled tool
 * declares, a `--tool-binary` for exactly that tool and platform must have
 * been given, and the path it names must exist. Without this, a build run
 * with the manifest edited but no binaries supplied would silently publish
 * an index with a missing child rather than fail loudly on a named platform.
 */
function assertToolBinariesSupplied(connectorKey, profile, toolBinaries) {
	for (const tool of declaredExternalTools(profile)) {
		if (tool.provisioning !== "bundled") continue;
		if (!Array.isArray(tool.platforms) || tool.platforms.length === 0) {
			throw new Error(
				`${connectorKey} declares ${tool.name} as provisioning: "bundled" but no platforms[]`,
			);
		}
		for (const platform of tool.platforms) {
			const supplied = toolBinaries.find(
				(entry) => entry.tool === tool.name && entry.platform === platform,
			);
			if (!supplied) {
				throw new Error(
					`${connectorKey} declares ${tool.name} for ${platform} but no matching ` +
						`--tool-binary ${tool.name}=${platform}=<path> was given`,
				);
			}
			if (!existsSync(supplied.path)) {
				throw new Error(
					`${connectorKey}: --tool-binary ${tool.name}=${platform}=${supplied.path} does not exist`,
				);
			}
		}
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

/** Every occurrence of a repeatable `--flag value` argument, in order given. */
function repeatedArgument(name) {
	const values = [];
	for (let index = 0; index < process.argv.length - 1; index += 1) {
		if (process.argv[index] === name) values.push(process.argv[index + 1]);
	}
	return values;
}

/**
 * Parse `--tool-binary <tool>=<os>/<arch>=<path>` into `{ tool, platform, path
 * }`. Three `=`-separated fields rather than three flags: CI's release matrix
 * already produces exactly this triple per job, and one flag per triple keeps
 * `--tool-binary` trivially repeatable without needing positional pairing
 * across three different flag names.
 */
function parseToolBinaryArgument(raw) {
	const match = /^([a-z0-9][a-z0-9_-]*)=([a-z0-9]+\/[a-z0-9]+)=(.+)$/.exec(raw);
	if (!match) {
		throw new Error(
			`--tool-binary must be <tool>=<os>/<arch>=<path>, got "${raw}"`,
		);
	}
	const [, tool, platform, path] = match;
	return { tool, platform, path };
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
	// identity: 11 of the 45 manifests spell `connector_key` in kebab-case
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

	const toolBinaries = repeatedArgument("--tool-binary").map(parseToolBinaryArgument);
	assertToolBinariesSupplied(connectorKey, profile, toolBinaries);
	const bundledTools = declaredExternalTools(profile).filter(
		(tool) => tool.provisioning === "bundled",
	);

	// `--version` exists so CI can assert the tag it is publishing under, not so
	// it can relabel the artifact. The profile layer is copied byte-for-byte, so
	// an override that disagrees with it would ship a config saying 9.9.9 beside
	// a profile saying 0.1.0 — two answers to "which version is this?" inside
	// one immutable digest. The override may only CONFIRM the canonical value.
	const version = argument("--version", profile.version);
	if (!/^\d+\.\d+\.\d+/.test(version)) {
		throw new Error(`Version must be semver, got ${version}`);
	}
	if (version !== profile.version) {
		throw new Error(
			`--version ${version} contradicts the Collection Profile's version ${profile.version}. ` +
				"The profile layer ships unchanged, so the override may only restate the canonical version; " +
				`to publish ${version}, change ${relative(repoRoot, manifestPath)} first.`,
		);
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
	const declared = declaredDependencies();
	const codeStaging = join(staging, "code");
	mkdirSync(codeStaging, { recursive: true });

	// Only the host-runtime contract's packages stay external. Everything else
	// the entrypoint can reach is bundled, so the code layer carries the bytes
	// it needs instead of expecting to find them in the publisher's node_modules.
	const build = await esbuild.build({
		absWorkingDir: packageRoot,
		banner: {
			js: `/* GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-connector-oci-artifact.mjs --connector ${connectorDirectoryName}. */\nimport { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`,
		},
		bundle: true,
		entryPoints: [entrySource],
		external: [...HOST_PROVIDED.keys()],
		format: "esm",
		metafile: true,
		minifyWhitespace: true,
		outfile: join(codeStaging, "collection-profile.mjs"),
		platform: "node",
		sourcemap: false,
		target: "node24",
	});

	// Classify what the finished bundle still references against the contract.
	//
	// The metafile's INPUT graph is what carries the import kind, and the kind
	// decides the verdict: a static import of a host-provided package makes
	// loading impossible without bytes the artifact lacks, while a dynamic one
	// cannot run before the host has already provisioned the capability. Reading
	// only the output imports would lose that distinction.
	const externalEdges = Object.values(build.metafile.inputs)
		.flatMap((input) => input.imports ?? [])
		.filter((entry) => entry.external);

	const { violations, hostProvided } = classifyExternals(externalEdges);
	if (violations.length) {
		throw new Error(
			`${connectorKey} violates the host-runtime contract (scripts/connector-host-runtime-contract.mjs):\n  - ${violations.join("\n  - ")}`,
		);
	}

	// The entrypoint's declared interface, taken from what esbuild actually
	// emitted rather than from a name this script knows in advance. Hardcoding
	// `collectOura` would make a shared builder accumulate one provider-specific
	// export name per connector; deriving it means the artifact carries its own
	// answer and the verifier can check any connector without being taught about it.
	const expectedExports = [
		...new Set(
			Object.values(build.metafile.outputs)
				.flatMap((output) => output.exports ?? []),
		),
	].sort();

	// Connectors come in two shapes, and conflating them is how a verifier ends
	// up either rejecting healthy artifacts or accepting broken ones.
	//
	//   import-safe: guards its startup with `isMainModule`, so importing it is
	//     side-effect free and its exports ARE its interface. Oura is one.
	//   executable:  no guard. Importing it starts collection, which then exits
	//     because stdin carries no START message. 18 of the 45 are like this,
	//     and they legitimately export nothing.
	//
	// The kind is derived from the source, not assumed, and recorded in the
	// artifact so the verifier knows which contract to hold the entrypoint to.
	const entrypointKind = readFileSync(entrySource, "utf8").includes(
		"isMainModule",
	)
		? "import-safe"
		: "executable";

	if (entrypointKind === "import-safe" && !expectedExports.length) {
		throw new Error(
			`${connectorKey} guards its startup with isMainModule but its bundle exports nothing, so importing it ` +
				"does nothing and exposes no interface. There would be no way to tell a working artifact from an empty one.",
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
	// the only asset any of the 45 manifests declares today.
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
		// What the artifact does NOT carry, and what the host must therefore
		// provide. This replaces the old `external_runtime_packages`, which
		// listed every declared dependency against a version range or a
		// `file:./vendor/*.tgz` path — values that describe this repository's
		// checkout rather than anything a consumer could install.
		host_runtime_contract: {
			version: HOST_RUNTIME_CONTRACT_VERSION,
			node: hostNodeRange(
				JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
			),
			// Empty for a connector like Oura, which is fully self-contained.
			packages: hostProvided.map((entry) => ({
				specifier: entry.specifier,
				package: entry.package,
				declared_version: declared.get(entry.package) ?? null,
				reason: HOST_PROVIDED.get(entry.package),
				loaded: entry.kind,
			})),
		},
		bundled_dependencies: [
			...new Set(
				Object.keys(build.metafile.inputs)
					.filter((input) => input.includes("node_modules"))
					.map((input) =>
						packageNameOf(
							input.slice(input.lastIndexOf("node_modules/") + 13),
						),
					),
			),
		].sort(),
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
			// The contract a consumer must satisfy, carried in the blob the
			// manager reads BEFORE it pulls, so an unsupportable artifact can be
			// declined rather than installed and discovered at collection time.
			host_runtime_contract: {
				version: HOST_RUNTIME_CONTRACT_VERSION,
				packages: hostProvided.map((entry) => entry.package).sort(),
			},
		},
		// How the entrypoint must be driven, and what it must expose. The verifier
		// derives its expectation from THESE, rather than hardcoding `collectOura`
		// and growing a per-provider list in a shared script.
		entrypoint_kind: entrypointKind,
		exports: expectedExports,
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

	// ---- platform children + index, only for a connector that bundles a
	// native tool (OCI-TOOL-LAYER-0918.md §5) ------------------------------
	//
	// Every JS-only connector returns here: `bundledTools` is empty, so
	// nothing below this point runs and the five files above are the whole
	// artifact — byte-for-byte the single-manifest shape that existed before
	// this function had an index path at all.
	const platformIndexEntries = [];
	if (bundledTools.length > 0) {
		const platforms = [
			...new Set(bundledTools.flatMap((tool) => tool.platforms)),
		].sort();

		for (const platformSpec of platforms) {
			const [os, architecture] = platformSpec.split("/");
			const platformDir = join(outputRoot, "platforms", platformSpec.replace("/", "-"));
			mkdirSync(platformDir, { recursive: true });
			const platformStaging = join(staging, "platforms", platformSpec.replace("/", "-"));

			// ---- tools layer: one binary per bundled tool that supports this
			// platform, at `tools/<name>` (or `tools/<name>.exe` for windows,
			// matching the extension slackdump's own release archives use). ----
			const toolsStaging = join(platformStaging, "tools");
			mkdirSync(toolsStaging, { recursive: true });
			for (const tool of bundledTools) {
				if (!tool.platforms.includes(platformSpec)) continue;
				const supplied = toolBinaries.find(
					(entry) => entry.tool === tool.name && entry.platform === platformSpec,
				);
				const memberName = os === "windows" ? `${tool.name}.exe` : tool.name;
				const bytes = readFileSync(supplied.path);
				writeFileSync(join(toolsStaging, memberName), bytes);
				chmodSync(join(toolsStaging, memberName), 0o755);
			}
			const toolsMembers = filesUnder(toolsStaging);
			assertSafeMembers(toolsMembers);
			// `deterministicTarball` passes no `--mode` flag to `tar`, so it
			// already records each member's REAL on-disk mode — the `chmodSync`
			// above is what makes the emitted tools.tar.gz carry the executable
			// bit, with no change needed to the tarball helper itself.
			deterministicTarball(
				toolsStaging,
				toolsMembers,
				join(platformDir, "tools.tar.gz"),
			);

			// ---- tool-config layer: code-relative assets a bundled tool's own
			// connector code needs at runtime, staged as a `config/` layer
			// sibling to `code/` so `../config/<file>` from
			// `code/collection-profile.mjs` resolves INSIDE the install root.
			// Named by TOOL, not by connector: `<tool-name>-api-config.toml`
			// under packages/polyfill-connectors/config/, matching the file
			// that already exists there (`slackdump-api-config.toml`). A tool
			// with no such file — most of them — gets no toolConfig layer,
			// same optionality rule as `assets`. ----
			const toolConfigStaging = join(platformStaging, "config");
			let anyToolConfig = false;
			for (const tool of bundledTools) {
				if (!tool.platforms.includes(platformSpec)) continue;
				const toolConfigName = `${tool.name}-api-config.toml`;
				const toolConfigSource = join(packageRoot, "config", toolConfigName);
				if (!existsSync(toolConfigSource)) continue;
				mkdirSync(toolConfigStaging, { recursive: true });
				writeFileSync(
					join(toolConfigStaging, toolConfigName),
					readFileSync(toolConfigSource),
				);
				anyToolConfig = true;
			}
			let toolConfigTarball = null;
			if (anyToolConfig) {
				const toolConfigMembers = filesUnder(toolConfigStaging);
				assertSafeMembers(toolConfigMembers);
				toolConfigTarball = deterministicTarball(
					toolConfigStaging,
					toolConfigMembers,
					join(platformDir, "config.tar.gz"),
				);
			}

			// ---- platform child's own config.json: the common config restated
			// with a REAL platform (not "any"), plus bundled_tools naming where
			// the installer will find each binary once it writes the tools
			// layer to the `tools/` sibling of `code/`. ----
			const platformConfig = {
				...config,
				platform: { os, architecture },
				bundled_tools: bundledTools
					.filter((tool) => tool.platforms.includes(platformSpec))
					.map((tool) => ({
						name: tool.name,
						path: `tools/${os === "windows" ? `${tool.name}.exe` : tool.name}`,
					})),
			};
			writeFileSync(
				join(platformDir, "config.json"),
				`${JSON.stringify(platformConfig, null, 2)}\n`,
			);

			// ---- platform child's own layer list: the common layers plus
			// `tools.tar.gz` and, when present, `config.tar.gz`. ----
			const platformLayers = [
				...layers,
				{ file: "tools.tar.gz", mediaType: "application/vnd.pdpp.connector.tools.v1.tar+gzip" },
				...(toolConfigTarball
					? [{ file: "config.tar.gz", mediaType: "application/vnd.pdpp.connector.tool-config.v1.tar+gzip" }]
					: []),
			];
			writeFileSync(
				join(platformDir, "layers.json"),
				`${JSON.stringify(
					{
						artifactType: "application/vnd.pdpp.connector.v1+json",
						config: { file: "config.json", mediaType: "application/vnd.pdpp.connector.config.v1+json" },
						layers: platformLayers,
						platform: { os, architecture },
						annotations: {
							"org.opencontainers.image.source": "https://github.com/PDP-Connect/data-connectors",
							"org.opencontainers.image.revision": revision,
							"org.opencontainers.image.version": version,
							"org.opencontainers.image.licenses": "Apache-2.0",
							"dev.pdpp.connector.key": connectorKey,
							"dev.pdpp.connector.id": profile.connector_id,
							"dev.pdpp.protocol.version": profile.protocol_version,
						},
					},
					null,
					2,
				)}\n`,
			);

			platformIndexEntries.push({
				platform: { os, architecture },
				commonLayerFiles: layers.map((layer) => join(outputRoot, layer.file)),
				commonConfigFile: join(outputRoot, "config.json"),
				directory: platformDir,
			});
		}

		// ---- the index itself: the object the lock pins and the workflow
		// signs. `manifests[].platform` uses the spec's real os/architecture
		// fields (image-index.md) — the shape OpenTofu's own provider indexes
		// use for the identical problem (OCI-TOOL-LAYER-0918.md §4). ----
		writeFileSync(
			join(outputRoot, "index.json"),
			`${JSON.stringify(
				{
					mediaType: "application/vnd.oci.image.index.v1+json",
					artifactType: "application/vnd.pdpp.connector.v1+json",
					schemaVersion: 2,
					manifests: platformIndexEntries.map((entry) => ({
						platform: entry.platform,
						directory: relative(outputRoot, entry.directory),
					})),
					annotations: {
						"org.opencontainers.image.source": "https://github.com/PDP-Connect/data-connectors",
						"org.opencontainers.image.revision": revision,
						"org.opencontainers.image.version": version,
						"dev.pdpp.connector.key": connectorKey,
						"dev.pdpp.connector.id": profile.connector_id,
					},
				},
				null,
				2,
			)}\n`,
		);
	}

	rmSync(staging, { recursive: true, force: true });

	console.log(
		`Built ${connectorKey}@${version} into ${relative(repoRoot, outputRoot) || outputRoot}`,
	);
	for (const layer of layers) {
		console.log(`  ${layer.file}  ${layer.mediaType}`);
	}
	for (const entry of platformIndexEntries) {
		console.log(
			`  platform ${entry.platform.os}/${entry.platform.architecture} -> ${relative(repoRoot, entry.directory)}`,
		);
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
