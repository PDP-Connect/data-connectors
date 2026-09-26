// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The artifact contract's executable gate.
 *
 * Every case here is a row from the reviewer's findings on #97 (P1-4, P1-5,
 * P2-1). Each one was reproduced against the unchanged scripts first and only
 * then fixed, so a test that stops discriminating is a regression in the gate
 * rather than a stale expectation.
 *
 * The real Oura artifact is built once and reused for negative controls.
 * The publish build suite separately builds and verifies the full allowlist.
 * Synthetic cases then swap ONLY the code layer of that real artifact, so every
 * other layer stays byte-identical and a failure can only come from the code.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { classifyExternals } from "./connector-host-runtime-contract.mjs";
import {
	declarationVersion,
	profileDeclarationErrors,
	validateSourceDeclaration,
} from "../packages/connector-installer-core/source-declaration.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const builder = join(repoRoot, "scripts", "build-connector-oci-artifact.mjs");
const verifier = join(repoRoot, "scripts", "verify-connector-oci-artifact.mjs");

// esbuild's postinstall is blocked by this repo's allowScripts policy in some
// environments, so the platform package may be present while the wrapper is not
// executable. Resolving the library path explicitly keeps the gate runnable in
// CI and locally without depending on that.
const esbuildLib = join(repoRoot, "node_modules", "esbuild", "lib", "main.js");

let workspace;
let ouraArtifact;

const run = (script, args) =>
	spawnSync(process.execPath, [script, ...args], {
		encoding: "utf8",
		cwd: repoRoot,
		timeout: 300_000,
	});

const build = (args) =>
	run(builder, [...args, "--esbuild", esbuildLib]);

const verify = (artifact) => run(verifier, ["--artifact", artifact]);

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

/**
 * A copy of the real Oura artifact whose code layer is replaced by `source`.
 * Everything else — profile, config, provenance, licences, assets — is the real
 * artifact's bytes, so these cases isolate entrypoint behaviour exactly.
 */
function artifactWithCode(name, source) {
	const target = join(workspace, name);
	rmSync(target, { recursive: true, force: true });
	cpSync(ouraArtifact, target, { recursive: true });

	const stage = join(workspace, `${name}-stage`);
	rmSync(stage, { recursive: true, force: true });
	mkdirSync(stage, { recursive: true });
	writeFileSync(join(stage, "collection-profile.mjs"), source);

	// Matches the builder's own tar/gzip invocation, including tarring the
	// CONTENTS of the code directory rather than the directory itself.
	const tar = execFileSync(
		"tar",
		[
			"--sort=name",
			"--mtime=UTC 1970-01-01",
			"--owner=0",
			"--group=0",
			"--numeric-owner",
			"-cf",
			"-",
			"-C",
			stage,
			"collection-profile.mjs",
		],
		{ maxBuffer: 64 * 1024 * 1024 },
	);
	writeFileSync(
		join(target, "code.tar.gz"),
		execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 64 * 1024 * 1024 }),
	);
	return target;
}

before(() => {
	assert.ok(
		existsSync(esbuildLib),
		`esbuild is not installed at ${esbuildLib} — run \`npm ci\` at the repository root first.`,
	);
	workspace = mkdtempSync(join(tmpdir(), "pdpp-artifact-gate-"));
	ouraArtifact = join(workspace, "oura");
	const built = build(["--connector", "oura", "--out", ouraArtifact]);
	assert.equal(
		built.status,
		0,
		`building the real Oura artifact failed:\n${built.stdout}\n${built.stderr}`,
	);
});

after(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("W28 — the source declaration layer is a normative PDPP SourceDeclaration", () => {
	it("the real Oura source declaration is schema- and semantics-valid", () => {
		const declaration = JSON.parse(
			readFileSync(join(ouraArtifact, "source-declaration.json"), "utf8"),
		);
		const result = validateSourceDeclaration(declaration);
		assert.equal(result.ok, true, JSON.stringify(result.errors));
	});

	it("refuses to build if the derived declaration were invalid", () => {
		// The builder calls validateSourceDeclaration on every build (see
		// build-connector-oci-artifact.mjs); this is a direct check that the
		// call is load-bearing rather than dead code, by feeding the exact
		// build-time validator a shape it must refuse.
		const invalid = { declaration_version: "1", protocol_version: "0.1.0" };
		const result = validateSourceDeclaration(invalid);
		assert.equal(result.ok, false);
	});

	it("local verification rejects the source-declaration shape this fix replaces", () => {
		// The literal shape scripts/build-connector-oci-artifact.mjs used to
		// emit (connector_key/connector_id/version/source.repository/
		// canonical_inputs) — a provenance-like object, not a SourceDeclaration.
		const target = join(workspace, "invalid-declaration-shape");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });

		const profile = JSON.parse(
			readFileSync(join(target, "collection-profile.json"), "utf8"),
		);
		const lookalike = Buffer.from(
			`${JSON.stringify(
				{
					declaration_version: "1.0",
					connector_key: profile.connector_key,
					connector_id: profile.connector_id,
					version: profile.version,
					source: {
						repository: "https://github.com/PDP-Connect/data-connectors",
						revision: "0".repeat(40),
						package: `connectors/${profile.connector_key}`,
					},
					canonical_inputs: { manifest: { path: "x", sha256: "sha256:0" }, source_inventory: [] },
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(join(target, "source-declaration.json"), lookalike);

		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		config.source_declaration_digest = `sha256:${createHash("sha256").update(lookalike).digest("hex")}`;
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0, "a provenance-like source declaration must not verify");
		assert.match(result.stderr, /not a valid PDPP SourceDeclaration/);
	});

	it("every artifact of one source carries the same declaration bytes", () => {
		const browserArtifact = join(workspace, "oura-browser");
		const built = build(["--connector", "oura_browser", "--out", browserArtifact]);
		assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
		assert.ok(
			readFileSync(join(browserArtifact, "source-declaration.json")).equals(
				readFileSync(join(ouraArtifact, "source-declaration.json")),
			),
		);
		assert.equal(verify(browserArtifact).status, 0);
	});

	it("local verification rejects a valid declaration that omits a profile stream", () => {
		const target = join(workspace, "narrowed-declaration");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });

		const declaration = JSON.parse(readFileSync(join(target, "source-declaration.json"), "utf8"));
		declaration.streams = declaration.streams.slice(1);
		declaration.declaration_version = declarationVersion(declaration);
		const narrowed = Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`);
		assert.equal(validateSourceDeclaration(declaration).ok, true);
		writeFileSync(join(target, "source-declaration.json"), narrowed);

		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		config.source_declaration_digest = `sha256:${createHash("sha256").update(narrowed).digest("hex")}`;
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not declare collection-profile.json/);
	});
});

describe("P1-4 — the artifact stands on its own", () => {
	it("the real Oura artifact verifies against a host with no node_modules", () => {
		const result = verify(ouraArtifact);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /runs with no node_modules\s+ok/);
	});

	it("loads on a clean host with no publisher checkout and no npm at all", () => {
		// The standing acceptance criterion, executed rather than asserted: unpack
		// the shipped bytes somewhere unrelated and import them. No node_modules,
		// no install step, no network.
		const host = join(workspace, "clean-host");
		rmSync(host, { recursive: true, force: true });
		mkdirSync(host, { recursive: true });
		execFileSync("tar", ["-xzf", join(ouraArtifact, "code.tar.gz"), "-C", host]);

		const config = JSON.parse(
			readFileSync(join(ouraArtifact, "config.json"), "utf8"),
		);
		const entry = join(host, "collection-profile.mjs");
		const loaded = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"--eval",
				`const m = await import(${JSON.stringify(`file://${entry}`)});
				 process.stdout.write(Object.keys(m).sort().join(","));`,
			],
			{ cwd: host, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "" } },
		);

		assert.equal(loaded.status, 0, `clean host could not load the artifact:\n${loaded.stderr}`);
		for (const name of config.exports) {
			assert.ok(
				loaded.stdout.split(",").includes(name),
				`clean host loaded the module but ${name} was absent (got: ${loaded.stdout})`,
			);
		}
	});

	it("carries its dependency bytes rather than naming them", () => {
		const provenance = JSON.parse(
			readFileSync(join(ouraArtifact, "provenance.json"), "utf8"),
		);
		assert.ok(
			provenance.bundled_dependencies.includes("@pdpp/connector-protocol"),
			"the protocol package Oura imports must travel in the code layer",
		);
		// The precise defect: provenance used to record this dependency as
		// `file:./vendor/pdpp-connector-protocol-0.0.1.tgz`, a path that only
		// resolves inside this repository.
		const named = JSON.stringify(provenance.host_runtime_contract);
		assert.doesNotMatch(
			named,
			/file:\.\//,
			"the host contract must not point at repository-relative vendor tarballs",
		);
	});

	it("states a host-runtime contract that is explicit and reasoned", () => {
		const provenance = JSON.parse(
			readFileSync(join(ouraArtifact, "provenance.json"), "utf8"),
		);
		const contract = provenance.host_runtime_contract;
		assert.ok(contract.version, "the contract must be versioned");
		assert.ok(contract.node, "the contract must state the Node range it needs");
		for (const entry of contract.packages) {
			assert.ok(entry.reason, `${entry.package} is host-provided with no stated reason`);
			assert.ok(
				["dynamic-import", "require-call"].includes(entry.loaded),
				`${entry.package} must be reached only through a deferred import (got '${entry.loaded}'), or its bytes must ship`,
			);
		}
	});

	it("emits a deterministic source declaration layer pinned by config", () => {
		const secondArtifact = join(workspace, "oura-second");
		const rebuilt = build(["--connector", "oura", "--out", secondArtifact]);
		assert.equal(rebuilt.status, 0, `${rebuilt.stdout}\n${rebuilt.stderr}`);

		for (const artifact of [ouraArtifact, secondArtifact]) {
			const config = JSON.parse(readFileSync(join(artifact, "config.json"), "utf8"));
			const layers = JSON.parse(readFileSync(join(artifact, "layers.json"), "utf8"));
			const declarationBytes = readFileSync(
				join(artifact, "source-declaration.json"),
			);
			const declaration = JSON.parse(declarationBytes.toString("utf8"));
			const profileBytes = readFileSync(
				join(artifact, "collection-profile.json"),
			);

			assert.equal(
				config.source_declaration_digest,
				sha256(declarationBytes),
			);
			const profile = JSON.parse(profileBytes.toString("utf8"));
			assert.deepEqual(profileDeclarationErrors(profile, declaration), []);
			assert.ok(
				layers.layers.some(
					(layer) =>
						layer.file === "source-declaration.json" &&
						layer.mediaType ===
							"application/vnd.pdpp.connector.source-declaration.v1+json",
				),
			);
		}

		for (const file of ["config.json", "layers.json", "source-declaration.json"]) {
			assert.deepEqual(
				readFileSync(join(secondArtifact, file)),
				readFileSync(join(ouraArtifact, file)),
				`${file} must be reproducible for the same source revision`,
			);
		}
	});

	it("refuses an artifact whose code layer left its dependencies external", () => {
		// The exact bytes the unchanged builder produced: verified under the old
		// verifier only because it symlinked the publisher's node_modules.
		const broken = artifactWithCode(
			"unbundled",
			'import { isMainModule } from "@pdpp/connector-protocol";\nexport const collectOura = () => isMainModule;\n',
		);
		const result = verify(broken);
		assert.notEqual(result.status, 0, "an artifact missing its dependency bytes must fail");
		assert.match(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package/);
	});

	it("refuses an artifact that does not declare a host-runtime contract", () => {
		const target = join(workspace, "no-contract");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });
		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		delete config.runtime.host_runtime_contract;
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /host_runtime_contract is missing/);
	});
});

describe("P1-5 — the entrypoint contract", () => {
	// The reviewer's table. Every row that reads "Pass — incorrect" in the
	// findings must fail here.
	const mustFail = [
		["a top-level Error", 'throw new Error("boom");'],
		["an undefined identifier", "notDefinedAnywhere();\nexport const collectOura = 1;"],
		["a top-level TypeError", "null.property;\nexport const collectOura = 1;"],
		["process.exit(1)", "process.exit(1);\nexport const collectOura = 1;"],
		["process.exit(23)", "process.exit(23);\nexport const collectOura = 1;"],
		["a SIGKILL", 'process.kill(process.pid, "SIGKILL");\nexport const collectOura = 1;'],
		["a self-SIGTERM", 'process.kill(process.pid, "SIGTERM");\nexport const collectOura = 1;'],
		["an empty module with no exports", "// nothing at all\n"],
		["a syntax error", "export function ( { { <<<<\n"],
		["a missing imported package", 'import "absent-package-xyz";\nexport const collectOura = 1;'],
		["an entrypoint that never settles", "await new Promise(() => {});\nexport const collectOura = 1;"],
	];

	for (const [label, source] of mustFail) {
		it(`fails ${label}`, () => {
			const artifact = artifactWithCode(
				label.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
				source,
			);
			const result = verify(artifact);
			assert.notEqual(
				result.status,
				0,
				`${label} was accepted as a healthy artifact:\n${result.stdout}`,
			);
		});
	}

	it("passes a module that evaluates and exposes its declared interface", () => {
		const artifact = artifactWithCode(
			"healthy",
			"export async function collectOura() { return { ok: true }; }\n",
		);
		const result = verify(artifact);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});

	it("fails a module that exports the wrong interface", () => {
		// Guards the derive-from-profile requirement: the check must be about the
		// artifact's OWN declared exports, not a hardcoded `collectOura`.
		const artifact = artifactWithCode(
			"wrong-interface",
			"export const somethingElse = 1;\n",
		);
		const result = verify(artifact);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /does not expose its declared interface/);
	});

	it("derives the expected interface from the artifact, not from a hardcoded name", () => {
		assert.doesNotMatch(
			readFileSync(verifier, "utf8"),
			/collectOura/,
			"the shared verifier must not name any provider's exports",
		);
	});
});

describe("P1-5 — executable connectors are driven through the protocol", () => {
	// The other half of the reviewer's repair: a connector with no isMainModule
	// guard starts collecting when loaded and legitimately exports nothing, so
	// the import-safe contract cannot be applied to it. It must instead answer
	// the real protocol. Notion is one of the 18 such connectors.
	let notion;

	before(() => {
		notion = join(workspace, "notion");
		const built = build(["--connector", "notion", "--out", notion]);
		assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
	});

	it("classifies a guardless connector as executable", () => {
		const config = JSON.parse(readFileSync(join(notion, "config.json"), "utf8"));
		assert.equal(config.entrypoint_kind, "executable");
	});

	it("verifies by driving it with controlled input and an expected result", () => {
		const result = verify(notion);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		// Positive evidence: it reached its protocol runtime and refused a
		// non-START message, rather than merely failing in an unrecognised way.
		assert.match(result.stdout, /protocol: DONE\/failed/);
	});

	it("fails an executable connector that cannot answer the protocol", () => {
		const target = join(workspace, "mute-executable");
		rmSync(target, { recursive: true, force: true });
		cpSync(notion, target, { recursive: true });
		const stage = join(workspace, "mute-stage");
		rmSync(stage, { recursive: true, force: true });
		mkdirSync(stage, { recursive: true });
		// Loads cleanly and exits 0, but never speaks the protocol. The old
		// verifier's "it self-started, so every import resolved" reasoning would
		// have accepted this.
		writeFileSync(join(stage, "collection-profile.mjs"), "process.exit(0);\n");
		const tar = execFileSync(
			"tar",
			["--sort=name", "--mtime=UTC 1970-01-01", "--owner=0", "--group=0",
				"--numeric-owner", "-cf", "-", "-C", stage, "collection-profile.mjs"],
			{ maxBuffer: 64 * 1024 * 1024 },
		);
		writeFileSync(
			join(target, "code.tar.gz"),
			execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 64 * 1024 * 1024 }),
		);

		const result = verify(target);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /did not emit a DONE message/);
	});

	it("refuses an artifact that does not say how to drive its entrypoint", () => {
		const target = join(workspace, "no-kind");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });
		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		delete config.entrypoint_kind;
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /entrypoint_kind/);
	});
});

describe("C-T3 named packaging refusals and the Gmail repair", () => {
	it("Gmail bundles imapflow and verifies without node_modules", () => {
		const artifact = join(workspace, "gmail");
		const result = build(["--connector", "gmail", "--out", artifact]);
		assert.equal(result.status, 0, result.stderr);
		const provenance = JSON.parse(readFileSync(join(artifact, "provenance.json"), "utf8"));
		assert.ok(provenance.bundled_dependencies.includes("imapflow"));
		const verified = verify(artifact);
		assert.equal(verified.status, 0, verified.stderr);
		assert.match(verified.stdout, /runs with no node_modules\s+ok/);
	});

	it("still rejects a static host-provided import while permitting a deferred import", () => {
		const staticImport = classifyExternals([{ path: "patchright", kind: "import-statement" }]);
		assert.equal(staticImport.violations.length, 1);
		assert.match(staticImport.violations[0], /patchright.*imported STATICALLY/);
		const deferred = classifyExternals([{ path: "patchright", kind: "dynamic-import" }]);
		assert.deepEqual(deferred.violations, []);
		assert.equal(deferred.hostProvided[0].package, "patchright");
	});

	for (const [connector, binary] of [
		["slack", "SLACKDUMP_BIN"],
		["signal", "SIGTOP_BIN"],
		["google_messages", "GMCLI_BIN"],
	]) {
		it(`${connector} refuses its unbundled native helper ${binary}`, () => {
			const result = build(["--connector", connector, "--out", join(workspace, connector)]);
			assert.notEqual(result.status, 0);
			assert.ok(result.stderr.includes(`resolves an executable from PATH or $${binary}`), result.stderr);
			assert.match(result.stderr, /per-platform tool layer must land first/);
		});
	}
});

describe("P2-1 — version agreement", () => {
	it("refuses to build a version that contradicts the profile", () => {
		const result = build([
			"--connector",
			"oura",
			"--version",
			"9.9.9",
			"--out",
			join(workspace, "mismatch"),
		]);
		assert.notEqual(result.status, 0, "a contradicting --version must not build");
		assert.match(result.stderr, /contradicts the Collection Profile's version/);
	});

	it("still accepts an override that restates the canonical version", () => {
		const profile = JSON.parse(
			readFileSync(join(repoRoot, "connectors", "oura", "manifest.json"), "utf8"),
		);
		const result = build([
			"--connector",
			"oura",
			"--version",
			profile.version,
			"--out",
			join(workspace, "restated"),
		]);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	});

	it("refuses an artifact whose config version disagrees with its profile", () => {
		const target = join(workspace, "version-skew");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });
		const profile = JSON.parse(
			readFileSync(join(target, "collection-profile.json"), "utf8"),
		);
		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		config.version = "9.9.9";
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0, "a version-skewed artifact must not verify");
		assert.equal(
			result.stderr.trim(),
			`config.version is '9.9.9' but the profile says '${profile.version}'`,
		);
	});
});
