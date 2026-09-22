// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Manifest-declared filesystem input for replay: the manifest read, the
 * presence (non-vacuity) guard, the claim limitation, and the read-only bind.
 * See src/scenario/filesystem-input.ts for the design rationale.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildFilesystemInputLimitation } from "./claims.ts";
import {
	FilesystemInputError,
	readDeclaredFilesystemInput,
	resolveFilesystemInput,
} from "./filesystem-input.ts";
import {
	bwrapArgvForFilesystemClosure,
	isNamespaceIsolationAvailable,
	requiredFilesystemBinds,
	spawnWithNetworkIsolation,
} from "./isolation.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const STRAVA_LIKE = {
	envVar: "STRAVA_EXPORT_DIR",
	acceptedFileExtensions: [".zip", ".csv"],
} as const;

function withDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pdpp-fs-input-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function expectGuardFailure(env: NodeJS.ProcessEnv, pattern: RegExp): void {
	assert.throws(
		() => resolveFilesystemInput("strava", STRAVA_LIKE, env),
		(err: unknown) =>
			err instanceof FilesystemInputError && pattern.test(err.message),
	);
}

// ─── manifest read ──────────────────────────────────────────────────────────

test("readDeclaredFilesystemInput reads the real strava manifest's declaration", () => {
	const manifest = JSON.parse(
		readFileSync(join(PACKAGE_ROOT, "manifests", "strava.json"), "utf8"),
	);
	assert.deepEqual(readDeclaredFilesystemInput(manifest), {
		envVar: "STRAVA_EXPORT_DIR",
		acceptedFileExtensions: [".zip", ".csv"],
	});
});

test("readDeclaredFilesystemInput is undefined for a connector that declares no import directory", () => {
	const manifest = JSON.parse(
		readFileSync(join(PACKAGE_ROOT, "manifests", "reddit.json"), "utf8"),
	);
	assert.equal(readDeclaredFilesystemInput(manifest), undefined);
	assert.equal(readDeclaredFilesystemInput(undefined), undefined);
	assert.equal(
		readDeclaredFilesystemInput({
			setup: { manual_or_upload: { import_dir_env_var: "  " } },
		}),
		undefined,
	);
});

test("readDeclaredFilesystemInput normalizes extensions to a lowercased leading-dot form", () => {
	assert.deepEqual(
		readDeclaredFilesystemInput({
			setup: {
				manual_or_upload: {
					import_dir_env_var: "X_DIR",
					accepted_file_extensions: ["CSV", ".Zip", 7, ""],
				},
			},
		}),
		{ envVar: "X_DIR", acceptedFileExtensions: [".csv", ".zip"] },
	);
});

// ─── presence guard ─────────────────────────────────────────────────────────

test("presence guard: an unset variable fails and names the manifest field", () => {
	expectGuardFailure({}, /import_dir_env_var.*STRAVA_EXPORT_DIR is not set/);
});

test("presence guard: a path that does not exist fails", () => {
	expectGuardFailure(
		{ STRAVA_EXPORT_DIR: "/nonexistent/pdpp-fs-input" },
		/does not exist/,
	);
});

test("presence guard: a file instead of a directory fails", () => {
	withDir((dir) => {
		const file = join(dir, "activities.csv");
		writeFileSync(file, "id\n1\n");
		expectGuardFailure({ STRAVA_EXPORT_DIR: file }, /is not a directory/);
	});
});

test("presence guard: an empty directory fails as vacuous", () => {
	withDir((dir) => {
		expectGuardFailure(
			{ STRAVA_EXPORT_DIR: dir },
			/contains no input.*\.zip or \.csv/,
		);
	});
});

test("presence guard: only non-accepted files (a README) fails as vacuous", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "README.txt"), "not an export");
		expectGuardFailure({ STRAVA_EXPORT_DIR: dir }, /contains no input/);
	});
});

test("presence guard: a zero-byte accepted file does not count as input", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "activities.csv"), "");
		expectGuardFailure({ STRAVA_EXPORT_DIR: dir }, /contains no input/);
	});
});

test("presence guard: a symlinked file is not counted — only the directory itself is bound", () => {
	withDir((dir) => {
		withDir((outside) => {
			writeFileSync(join(outside, "activities.csv"), "id\n1\n");
			symlinkSync(join(outside, "activities.csv"), join(dir, "activities.csv"));
			expectGuardFailure({ STRAVA_EXPORT_DIR: dir }, /contains no input/);
		});
	});
});

test("presence guard: accepted files are found in subdirectories, case-insensitively, and counted", () => {
	withDir((dir) => {
		mkdirSync(join(dir, "activities"));
		writeFileSync(join(dir, "activities.CSV"), "id\n1\n");
		writeFileSync(join(dir, "activities", "export.zip"), "PK");
		writeFileSync(join(dir, "README.txt"), "ignored");
		const resolved = resolveFilesystemInput("strava", STRAVA_LIKE, {
			STRAVA_EXPORT_DIR: dir,
		});
		assert.equal(resolved.envVar, "STRAVA_EXPORT_DIR");
		assert.equal(resolved.acceptedFileCount, 2);
	});
});

test("presence guard: a symlinked directory resolves to its real path — the path that gets bound", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "activities.csv"), "id\n1\n");
		withDir((linkParent) => {
			const link = join(linkParent, "export-link");
			symlinkSync(dir, link);
			const resolved = resolveFilesystemInput("strava", STRAVA_LIKE, {
				STRAVA_EXPORT_DIR: link,
			});
			assert.equal(resolved.path.endsWith("export-link"), false);
			assert.equal(existsSync(join(resolved.path, "activities.csv")), true);
		});
	});
});

test("presence guard: with no accepted extensions declared, any non-empty file counts", () => {
	withDir((dir) => {
		writeFileSync(join(dir, "anything.dat"), "x");
		const resolved = resolveFilesystemInput(
			"x",
			{ envVar: "X_DIR", acceptedFileExtensions: [] },
			{ X_DIR: dir },
		);
		assert.equal(resolved.acceptedFileCount, 1);
	});
});

// ─── claim limitation ───────────────────────────────────────────────────────

test("limitation names path, variable and read-only access when the bind was enforced", () => {
	assert.equal(
		buildFilesystemInputLimitation({
			envVar: "STRAVA_EXPORT_DIR",
			path: "/data/strava",
			readOnlyBind: true,
		}),
		"filesystem input: replay read /data/strava via STRAVA_EXPORT_DIR (read-only bind, manifest-declared); isolation did not exclude this host path",
	);
});

test("limitation never says read-only when isolation was inactive", () => {
	const text = buildFilesystemInputLimitation({
		envVar: "STRAVA_EXPORT_DIR",
		path: "/data/strava",
		readOnlyBind: false,
	});
	assert.doesNotMatch(text, /read-only bind/);
	assert.match(text, /not bound read-only - isolation inactive/);
});

// ─── bind threading ─────────────────────────────────────────────────────────

test("requiredFilesystemBinds adds an extra path as a read-only bind, and adds nothing by default", () => {
	withDir((dir) => {
		const withExtra = requiredFilesystemBinds([dir]);
		assert.deepEqual(
			withExtra.find((b) => b.path === dir),
			{ path: dir, mode: "ro" },
		);
		assert.equal(
			requiredFilesystemBinds().some((b) => b.path === dir),
			false,
		);
	});
});

test("an extra path inside the repo is absorbed by the repo's own read-only bind, not bound twice", () => {
	const inside = join(PACKAGE_ROOT, "manifests");
	const binds = requiredFilesystemBinds([inside]);
	assert.equal(
		binds.some((b) => b.path === inside),
		false,
	);
	assert.equal(requiredFilesystemBinds().length, binds.length);
});

test("bwrap argv binds the extra path with --ro-bind, never --bind", () => {
	withDir((dir) => {
		const argv = bwrapArgvForFilesystemClosure("/bin/true", [], undefined, [
			dir,
		]);
		const idx = argv.indexOf(dir);
		assert.ok(idx > 0, `extra path missing from argv: ${JSON.stringify(argv)}`);
		assert.equal(argv[idx - 1], "--ro-bind");
		assert.equal(argv[idx + 1], dir);
	});
});

// ─── empirical read-only enforcement ────────────────────────────────────────

const isolation = isNamespaceIsolationAvailable();

test("[bwrap] an isolated child can READ the extra path but cannot WRITE to it", {
	skip: !(isolation.available && isolation.mechanism === "bwrap"),
}, async () => {
	// Directories created and removed by hand: the child runs asynchronously,
	// so the synchronous withDir() helper would delete them before it starts.
	const input = mkdtempSync(join(tmpdir(), "pdpp-fs-input-ro-"));
	const workspace = mkdtempSync(join(tmpdir(), "pdpp-fs-input-ws-"));
	const sentinel = join(input, "WRITTEN-FROM-SANDBOX.txt");
	try {
		writeFileSync(join(input, "activities.csv"), "id\n1\n");
		const out = await new Promise<string>((resolveRun, rejectRun) => {
			const child = spawnWithNetworkIsolation(
				"/bin/sh",
				[
					"-c",
					`cat "${join(input, "activities.csv")}" >/dev/null && echo CAN_READ; ` +
						`echo x > "${sentinel}" 2>/dev/null && echo WROTE || echo WRITE_DENIED`,
				],
				{
					isolate: "bwrap",
					filesystemBindPath: workspace,
					extraReadOnlyBinds: [input],
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let collected = "";
			child.stdout?.on("data", (chunk) => {
				collected += String(chunk);
			});
			child.on("error", rejectRun);
			child.on("close", () => resolveRun(collected));
		});
		assert.match(out, /CAN_READ/);
		assert.match(out, /WRITE_DENIED/);
		assert.doesNotMatch(out, /WROTE/);
		assert.equal(existsSync(sentinel), false);
	} finally {
		rmSync(input, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});
