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
 * The real Oura artifact is built ONCE and reused: it is the only enabled
 * connector, it is the connector P1-4 actually affects, and building it proves
 * the pipeline works on production bytes rather than on a synthetic stand-in.
 * Synthetic cases then swap ONLY the code layer of that real artifact, so every
 * other layer stays byte-identical and a failure can only come from the code.
 */

import { execFileSync, spawnSync } from "node:child_process";
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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "polyfill-connectors");
const builder = join(repoRoot, "scripts", "build-connector-oci-artifact.mjs");
const verifier = join(repoRoot, "scripts", "verify-connector-oci-artifact.mjs");

// esbuild's postinstall is blocked by this repo's allowScripts policy in some
// environments, so the platform package may be present while the wrapper is not
// executable. Resolving the library path explicitly keeps the gate runnable in
// CI and locally without depending on that.
const esbuildLib = join(packageRoot, "node_modules", "esbuild", "lib", "main.js");

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
		`esbuild is not installed at ${esbuildLib} — run \`npm ci\` in packages/polyfill-connectors first.`,
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

describe("the host-runtime contract is checked, not assumed", () => {
	it("refuses a connector that statically imports a host-provided package", () => {
		// gmail imports imapflow at the top level. imapflow's CommonJS tree cannot
		// be bundled to working ESM, so the artifact cannot carry it — which makes
		// this connector unpublishable until it defers the import. Under the old
		// builder it built, verified against the publisher's node_modules, and
		// would have failed on every consumer.
		const result = build([
			"--connector",
			"gmail",
			"--out",
			join(workspace, "gmail"),
		]);
		assert.notEqual(result.status, 0, "a static host-provided import must not build");
		assert.match(result.stderr, /imported STATICALLY/);
	});

	it("still refuses connectors needing an unbundled native helper", () => {
		// Pre-existing behaviour that must survive: Slack shells out to slackdump.
		const result = build([
			"--connector",
			"slack",
			"--out",
			join(workspace, "slack"),
		]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /resolves an executable from PATH/);
	});
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
			readFileSync(join(packageRoot, "manifests", "oura.json"), "utf8"),
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
		// The reviewer's counterexample: profile 0.1.0 beside config 9.9.9.
		const target = join(workspace, "version-skew");
		rmSync(target, { recursive: true, force: true });
		cpSync(ouraArtifact, target, { recursive: true });
		const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8"));
		config.version = "9.9.9";
		writeFileSync(join(target, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

		const result = verify(target);
		assert.notEqual(result.status, 0, "a version-skewed artifact must not verify");
		assert.match(result.stderr, /config\.version is '9\.9\.9' but the profile says '0\.1\.0'/);
	});
});
