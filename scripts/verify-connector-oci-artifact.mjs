#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove a built connector artifact is internally consistent and that its code
 * layer actually loads, BEFORE it is pushed and signed.
 *
 * A signature says the bytes came from us. It says nothing about whether they
 * run. This is the step that answers the second question, and it has to run
 * before the push because an OCI tag can be moved but a digest a consumer has
 * already pinned and verified cannot be recalled.
 *
 * What is checked:
 *
 *   1. The config blob's restatement of the profile matches the profile layer,
 *      INCLUDING the version. The manager performs the same cross-check on the
 *      way in (design §5.2); failing here means a mismatch is caught on a named
 *      connector in CI rather than on every host that installs it.
 *   2. Every tarball unpacks to the members the archive-safety rules allow.
 *   3. The declared entrypoint exists at that path once the code layer is
 *      unpacked, rather than somewhere the manager will not look for it.
 *   4. The entrypoint loads in an INDEPENDENTLY CONSTRUCTED host — an empty
 *      directory with no node_modules and no access to this checkout — and
 *      exposes the interface the artifact itself declares in `config.exports`.
 *
 * Point 4 is the one that carries the weight. It used to symlink the
 * publisher's node_modules into the scratch install and accept any failure whose
 * stderr did not match a list of resolution errors, so an artifact that could
 * not run anywhere else still verified, and a module that threw, exited nonzero
 * or exported nothing verified too.
 *
 * Usage:
 *   node scripts/verify-connector-oci-artifact.mjs --artifact <dir built by
 *     build-connector-oci-artifact.mjs>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deliberately no reference to packages/polyfill-connectors: the verifier must
// not be able to reach the publisher's installed dependency tree, because
// reaching it is exactly how the previous version hid an unusable artifact.

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1])
		throw new Error(`${name} is required`);
	return process.argv[index + 1];
}

function assertSafeMember(member) {
	if (member.startsWith("/")) throw new Error(`Absolute path: ${member}`);
	if (member.split("/").includes("..")) throw new Error(`Traversal: ${member}`);
	if (member.includes("\\")) throw new Error(`Backslash: ${member}`);
	if (member.includes("\0")) throw new Error(`NUL: ${member}`);
}

/**
 * tar -tvzf rather than -tzf: the long listing is what exposes the member TYPE.
 * Symlinks, hardlinks and device nodes are the archive-extraction attacks the
 * installer already refuses (connector-installer-core/index.mjs:259-338), and a
 * name-only listing cannot tell them from regular files.
 */
function listTarballMembers(tarballPath) {
	const listing = execFileSync("tar", ["-tvzf", tarballPath], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	return listing
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const mode = line[0];
			const name = line.slice(line.indexOf(":") + 4).trim() || line.split(/\s+/).pop();
			if (mode !== "-" && mode !== "d") {
				throw new Error(`Refusing non-regular member (mode '${mode}'): ${line}`);
			}
			return { mode, name };
		});
}

/**
 * How long the child gets to load the module and report its interface.
 *
 * An unbounded child is its own failure mode: a bundle with a top-level `await`
 * that never settles would otherwise hang CI rather than failing a gate.
 */
const IMPORT_TIMEOUT_MS = 60_000;

/** Prefix that separates the contract result from whatever a connector prints. */
const EXPORTS_MARKER = "###PDPP-EXPORTS:";

/**
 * Drive the entrypoint through its declared contract and demand positive
 * evidence that it holds.
 *
 * The rule this replaces treated a failed import as a failure only when stderr
 * matched a short list of resolution and syntax strings, and treated everything
 * else as an entrypoint that had "self-started". Under that rule a module that
 * threw at the top level, referenced an undefined identifier, called
 * `process.exit(1)`, killed itself with SIGKILL, or exported nothing at all was
 * reported as a healthy artifact. Nine distinct broken artifacts, all verified.
 *
 * The rule here is the other way round: the child must exit cleanly AND report
 * the interface the artifact itself declares. Anything else — any exception, any
 * nonzero exit, any signal, any timeout, any missing export — fails, without the
 * verifier needing to recognise the specific way it broke.
 *
 * The interface comes from `config.exports`, which the builder derived from the
 * bundle it emitted. The verifier therefore checks every connector without being
 * taught any provider's export names.
 */
function runEntrypointContract({ entrypoint, installRoot, kind, expected }) {
	if (kind === "executable") {
		return runExecutableContract({ entrypoint, installRoot });
	}
	if (!Array.isArray(expected) || expected.length === 0) {
		throw new Error(
			"config.exports is missing or empty, so the artifact declares no interface to check. " +
				"A connector that exposes nothing cannot be driven by a runner.",
		);
	}

	const probe = [
		`const mod = await import(${JSON.stringify(`file://${entrypoint}`)});`,
		"const names = Object.keys(mod).sort();",
		`process.stdout.write(${JSON.stringify(EXPORTS_MARKER)} + JSON.stringify(names) + "\\n");`,
	].join("\n");

	const child = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", probe],
		{
			cwd: installRoot,
			encoding: "utf8",
			timeout: IMPORT_TIMEOUT_MS,
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "pipe"],
			// An explicit environment keeps the check from depending on NODE_PATH
			// or NODE_OPTIONS that happen to be set on the build machine.
			env: { PATH: process.env.PATH ?? "" },
		},
	);

	const stderr = (child.stderr ?? "").trim();
	const detail = stderr ? `\n${stderr}` : "";

	if (child.error?.code === "ETIMEDOUT") {
		throw new Error(
			`entrypoint did not finish loading within ${IMPORT_TIMEOUT_MS}ms. ` +
				`An entrypoint that cannot be loaded and inspected cannot be driven by a runner.${detail}`,
		);
	}
	if (child.error) {
		throw new Error(`could not run the entrypoint: ${child.error.message}`);
	}
	if (child.signal) {
		throw new Error(
			`entrypoint terminated by signal ${child.signal} while loading.${detail}`,
		);
	}
	if (child.status !== 0) {
		throw new Error(
			`entrypoint exited ${child.status} while loading; a loadable module must evaluate cleanly.${detail}`,
		);
	}

	const marker = (child.stdout ?? "")
		.split("\n")
		.find((line) => line.startsWith(EXPORTS_MARKER));
	if (!marker) {
		throw new Error(
			`entrypoint exited 0 but never reported its exports, so the module did not finish evaluating.${detail}`,
		);
	}

	const actual = JSON.parse(marker.slice(EXPORTS_MARKER.length));
	const missing = expected.filter((name) => !actual.includes(name));
	if (missing.length) {
		throw new Error(
			`entrypoint loaded but does not expose its declared interface. Missing: ${missing.join(", ")}. ` +
				`Present: ${actual.length ? actual.join(", ") : "(nothing)"}.`,
		);
	}

	return { exports: actual };
}

/**
 * Drive an executable connector through its real protocol.
 *
 * A connector without an `isMainModule` guard starts collecting the moment it
 * is loaded, so importing it proves nothing and exporting nothing is normal.
 * The old verifier used exactly that as its excuse for treating any unrecognised
 * failure as healthy.
 *
 * The protocol gives a better handle. The runtime reads a START message from
 * stdin before it does anything, so feeding it a message that is well-formed
 * JSONL but is NOT a START drives it down a deterministic path with no network,
 * no credentials and no collection: it must answer with a DONE message saying
 * it expected a START. That answer is positive evidence — the bundle loaded,
 * every import resolved, the runtime wired itself up, and the wire format is
 * intact. A module that crashes, exports nothing, or was never a connector
 * cannot produce it.
 */
function runExecutableContract({ entrypoint, installRoot }) {
	const child = spawnSync(process.execPath, [entrypoint], {
		cwd: installRoot,
		encoding: "utf8",
		input: `${JSON.stringify({ type: "VERIFY_NOT_A_START" })}\n`,
		timeout: IMPORT_TIMEOUT_MS,
		killSignal: "SIGKILL",
		env: { PATH: process.env.PATH ?? "" },
	});

	const stderr = (child.stderr ?? "").trim();
	const detail = stderr ? `\n${stderr}` : "";

	if (child.error?.code === "ETIMEDOUT") {
		throw new Error(
			`entrypoint did not answer the protocol within ${IMPORT_TIMEOUT_MS}ms.${detail}`,
		);
	}
	if (child.error) {
		throw new Error(`could not run the entrypoint: ${child.error.message}`);
	}
	if (child.signal) {
		throw new Error(
			`entrypoint terminated by signal ${child.signal} while answering the protocol.${detail}`,
		);
	}

	// Refusing a non-START is a protocol-level rejection, so a nonzero exit is
	// the CORRECT outcome here; what matters is the message it emitted.
	const messages = (child.stdout ?? "")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});

	const done = messages.find((message) => message?.type === "DONE");
	if (!done) {
		throw new Error(
			"entrypoint did not emit a DONE message when driven with a non-START input, so it did not reach its " +
				`protocol runtime. A connector that cannot answer the protocol cannot be run by a host.${detail}`,
		);
	}
	if (done.status !== "failed") {
		throw new Error(
			`entrypoint answered a non-START input with status '${done.status}'; it must refuse the message rather than report success.`,
		);
	}

	return { exports: [`protocol: DONE/${done.status}`] };
}

function main() {
	const artifactRoot = argument("--artifact");

	const config = JSON.parse(
		readFileSync(join(artifactRoot, "config.json"), "utf8"),
	);
	const profileBytes = readFileSync(join(artifactRoot, "collection-profile.json"));
	const profile = JSON.parse(profileBytes);

	// 1. Config/profile cross-check.
	if (config.profile_digest !== sha256(profileBytes)) {
		throw new Error(
			`config.profile_digest ${config.profile_digest} does not match the profile layer ${sha256(profileBytes)}`,
		);
	}
	// `version` is in this list because the builder copies the profile layer
	// byte-for-byte while accepting a `--version` override: without this check a
	// config claiming 9.9.9 verifies happily beside a profile saying 0.1.0, and
	// the artifact carries two answers to "which version is this?" under one digest.
	for (const field of [
		"connector_key",
		"connector_id",
		"protocol_version",
		"version",
	]) {
		if (config[field] !== profile[field]) {
			throw new Error(
				`config.${field} is '${config[field]}' but the profile says '${profile[field]}'`,
			);
		}
	}

	// 2. Archive safety, on every tarball present.
	const layers = JSON.parse(readFileSync(join(artifactRoot, "layers.json"), "utf8"));
	for (const layer of layers.layers) {
		if (!layer.file.endsWith(".tar.gz")) continue;
		const path = join(artifactRoot, layer.file);
		if (!existsSync(path)) throw new Error(`Declared layer missing: ${layer.file}`);
		for (const member of listTarballMembers(path)) assertSafeMember(member.name);
	}

	// 3 + 4. Unpack the code layer and import it for real.
	const scratch = mkdtempSync(join(tmpdir(), "pdpp-artifact-verify-"));
	try {
		const installRoot = join(scratch, "install");
		const codeRoot = join(installRoot, "code");
		execFileSync("mkdir", ["-p", codeRoot]);
		execFileSync("tar", ["-xzf", join(artifactRoot, "code.tar.gz"), "-C", codeRoot]);

		const entrypoint = join(installRoot, config.entrypoint);
		if (!existsSync(entrypoint)) {
			throw new Error(
				`config.entrypoint '${config.entrypoint}' does not exist once code.tar.gz is unpacked`,
			);
		}

		// The install root gets NO node_modules.
		//
		// This used to symlink the publisher's own
		// packages/polyfill-connectors/node_modules here, which made every
		// artifact appear self-sufficient: the bundle left all its dependencies
		// external, and the symlink quietly supplied them from the checkout the
		// build happened to run in. That proves the connector works on the
		// publisher's machine. It cannot prove a consumer can run the release,
		// which is the only thing worth verifying before signing.
		//
		// So the host is constructed independently. Whatever the artifact needs
		// at load time, it must carry. The host-runtime contract's packages are
		// deliberately still absent: the contract says they are reached only
		// through dynamic imports, so a module that cannot LOAD without them has
		// broken the contract and must fail here rather than on a consumer's host.
		const contract = config.runtime?.host_runtime_contract;
		if (!contract) {
			throw new Error(
				"config.runtime.host_runtime_contract is missing. The artifact does not state which packages it " +
					"expects the host to provide, so there is no claim to check — rebuild with a builder that records it.",
			);
		}

		const kind = config.entrypoint_kind;
		if (kind !== "import-safe" && kind !== "executable") {
			throw new Error(
				`config.entrypoint_kind is '${kind}', so the verifier cannot tell whether importing this entrypoint is ` +
					"safe or whether it must be driven through the protocol. Rebuild with a builder that records it.",
			);
		}

		const result = runEntrypointContract({
			entrypoint,
			installRoot,
			kind,
			expected: config.exports,
		});

		console.log(`${config.connector_key}@${config.version} verified`);
		console.log(`  profile digest cross-check   ok`);
		console.log(`  archive members safe         ok`);
		console.log(`  version agrees with profile  ok`);
		console.log(`  entrypoint ${config.entrypoint}`);
		console.log(
			`  host contract v${contract.version}            ${contract.packages.length ? contract.packages.join(", ") : "nothing required"}`,
		);
		console.log(
			`  runs with no node_modules    ok (${kind}; ${result.exports.join(",")})`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
