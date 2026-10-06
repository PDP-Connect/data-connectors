// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for every connector-doctor.ts check, each against an injected
 * `DoctorContext` — no real filesystem, process.env, or os.platform() is
 * touched. See connector-doctor.ts's module docstring for what each check
 * means; this file proves pass/warn/fail branches for each one.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	checkChromiumRevision,
	checkDependenciesInstalled,
	checkDisplayAvailable,
	checkEnvLocalLocation,
	checkNodeVersion,
	checkProfilesWritable,
	type DoctorContext,
	type DoctorFsLike,
	resolveBrowsersCacheDir,
	resolveProfilesRoot,
	runDoctorChecks,
	satisfiesEngineRange,
} from "./connector-doctor.ts";

// ─── Fake fs: in-memory, built from plain maps/sets so each test only
// declares the handful of paths it cares about. ───────────────────────────

interface FakeFsState {
	accessed: string[];
	created: string[];
	dirEntries: Map<string, string[]>;
	existing: Set<string>;
	files: Map<string, string>;
	unwritable: Set<string>;
}

function makeFakeFsState(): FakeFsState {
	return {
		existing: new Set(),
		files: new Map(),
		dirEntries: new Map(),
		unwritable: new Set(),
		created: [],
		accessed: [],
	};
}

function makeFakeFs(state: FakeFsState): DoctorFsLike {
	return {
		existsSync: (path) => state.existing.has(path),
		readFileSync: (path) => {
			const content = state.files.get(path);
			if (content === undefined) {
				throw new Error(`ENOENT: no such file, open '${path}'`);
			}
			return content;
		},
		readdirSync: (path) => {
			const entries = state.dirEntries.get(path);
			if (!entries) {
				throw new Error(`ENOENT: no such directory, scandir '${path}'`);
			}
			return entries;
		},
		mkdirSync: (path) => {
			state.created.push(path);
			state.existing.add(path);
		},
		accessSync: (path) => {
			state.accessed.push(path);
			if (state.unwritable.has(path)) {
				throw new Error(`EACCES: permission denied, access '${path}'`);
			}
		},
	};
}

const PACKAGE_ROOT = "/repo/packages/polyfill-connectors";
const REPO_ROOT = "/repo";

function baseContext(overrides: Partial<DoctorContext> = {}): {
	ctx: DoctorContext;
	state: FakeFsState;
} {
	const state = makeFakeFsState();
	const ctx: DoctorContext = {
		env: {},
		fs: makeFakeFs(state),
		homeDir: "/home/tester",
		nodeVersion: "v24.21.0",
		packageRoot: PACKAGE_ROOT,
		platform: "linux",
		repoRoot: REPO_ROOT,
		...overrides,
	};
	return { ctx, state };
}

function setOwnPackageJson(
	state: FakeFsState,
	pkg: { dependencies?: Record<string, string>; engines?: { node?: string } },
): void {
	const path = join(PACKAGE_ROOT, "package.json");
	state.existing.add(path);
	state.files.set(path, JSON.stringify(pkg));
}

// ─── satisfiesEngineRange ──────────────────────────────────────────────────

test("satisfiesEngineRange: accepts a version inside a >=X <Y range", () => {
	assert.equal(satisfiesEngineRange("v24.21.0", ">=24.15.0 <25"), true);
});

test("satisfiesEngineRange: rejects a version below the floor", () => {
	assert.equal(satisfiesEngineRange("v24.10.0", ">=24.15.0 <25"), false);
});

test("satisfiesEngineRange: rejects a version at/above the exclusive ceiling", () => {
	assert.equal(satisfiesEngineRange("v25.0.0", ">=24.15.0 <25"), false);
});

test("satisfiesEngineRange: boundary floor value satisfies >=", () => {
	assert.equal(satisfiesEngineRange("v24.15.0", ">=24.15.0 <25"), true);
});

// ─── checkNodeVersion ──────────────────────────────────────────────────────

test("checkNodeVersion: pass when the running Node satisfies engines.node", () => {
	const { ctx, state } = baseContext({ nodeVersion: "v24.21.0" });
	setOwnPackageJson(state, { engines: { node: ">=24.15.0 <25" } });
	assert.equal(checkNodeVersion(ctx).status, "pass");
});

test("checkNodeVersion: fail with a nvm fix when Node is too old", () => {
	const { ctx, state } = baseContext({ nodeVersion: "v20.0.0" });
	setOwnPackageJson(state, { engines: { node: ">=24.15.0 <25" } });
	const result = checkNodeVersion(ctx);
	assert.equal(result.status, "fail");
	assert.match(result.fix ?? "", /nvm/);
});

test("checkNodeVersion: warn when engines.node cannot be read", () => {
	const { ctx } = baseContext();
	// package.json never set in state — readFileSync throws, caught as warn.
	assert.equal(checkNodeVersion(ctx).status, "warn");
});

// ─── checkDependenciesInstalled ─────────────────────────────────────────────

test("checkDependenciesInstalled: pass when every declared dependency is found walking up from packageRoot", () => {
	const { ctx, state } = baseContext();
	setOwnPackageJson(state, {
		dependencies: { zod: "^4", patchright: "1.63.0" },
	});
	// Hoisted to the repo-root node_modules, not the package-local one —
	// proves the upward walk, not just a packageRoot-local lookup.
	state.existing.add(join(REPO_ROOT, "node_modules", "zod"));
	state.existing.add(join(REPO_ROOT, "node_modules", "patchright"));
	const result = checkDependenciesInstalled(ctx);
	assert.equal(result.status, "pass");
});

test("checkDependenciesInstalled: fail naming every missing dependency", () => {
	const { ctx, state } = baseContext();
	setOwnPackageJson(state, {
		dependencies: { zod: "^4", patchright: "1.63.0" },
	});
	state.existing.add(join(REPO_ROOT, "node_modules", "zod"));
	// patchright deliberately not added.
	const result = checkDependenciesInstalled(ctx);
	assert.equal(result.status, "fail");
	assert.match(result.message, /patchright/);
	assert.doesNotMatch(result.message, /\bzod\b.*not installed/);
	assert.match(result.fix ?? "", /npm install/);
});

test("checkDependenciesInstalled: a scoped workspace package with no root export still counts as installed", () => {
	const { ctx, state } = baseContext();
	setOwnPackageJson(state, {
		dependencies: { "@pdpp/connector-protocol": "0.0.0" },
	});
	state.existing.add(
		join(REPO_ROOT, "node_modules", "@pdpp/connector-protocol"),
	);
	assert.equal(checkDependenciesInstalled(ctx).status, "pass");
});

// ─── checkChromiumRevision / resolveBrowsersCacheDir ───────────────────────

function withPatchrightCore(state: FakeFsState, revision: string): void {
	const coreDir = join(REPO_ROOT, "node_modules", "patchright-core");
	state.existing.add(coreDir);
	state.files.set(
		join(coreDir, "browsers.json"),
		JSON.stringify({ browsers: [{ name: "chromium", revision }] }),
	);
}

test("checkChromiumRevision: pass when the required revision is present in the cache dir", () => {
	const { ctx, state } = baseContext();
	withPatchrightCore(state, "1243");
	state.existing.add(
		join("/home/tester", ".cache", "ms-playwright", "chromium-1243"),
	);
	const result = checkChromiumRevision(ctx);
	assert.equal(result.status, "pass");
	assert.match(result.message, /1243/);
});

test("checkChromiumRevision: fail with the install command when the revision is missing", () => {
	const { ctx, state } = baseContext();
	withPatchrightCore(state, "1243");
	// Cache dir intentionally left empty.
	const result = checkChromiumRevision(ctx);
	assert.equal(result.status, "fail");
	assert.match(result.fix ?? "", /npx patchright install chromium/);
});

test("checkChromiumRevision: fail when patchright-core itself is not installed", () => {
	const { ctx } = baseContext();
	const result = checkChromiumRevision(ctx);
	assert.equal(result.status, "fail");
	assert.match(result.fix ?? "", /npm install/);
});

test("resolveBrowsersCacheDir: defaults per platform", () => {
	const { ctx: linuxCtx } = baseContext({ platform: "linux" });
	assert.equal(
		resolveBrowsersCacheDir(linuxCtx),
		join("/home/tester", ".cache", "ms-playwright"),
	);
	const { ctx: macCtx } = baseContext({ platform: "darwin" });
	assert.equal(
		resolveBrowsersCacheDir(macCtx),
		join("/home/tester", "Library", "Caches", "ms-playwright"),
	);
	const { ctx: winCtx } = baseContext({ platform: "win32" });
	assert.equal(
		resolveBrowsersCacheDir(winCtx),
		join("/home/tester", "AppData", "Local", "ms-playwright"),
	);
});

test("resolveBrowsersCacheDir: PLAYWRIGHT_BROWSERS_PATH overrides the default", () => {
	const { ctx } = baseContext({
		env: { PLAYWRIGHT_BROWSERS_PATH: "/custom/browsers" },
	});
	assert.equal(resolveBrowsersCacheDir(ctx), "/custom/browsers");
});

test("resolveBrowsersCacheDir: PLAYWRIGHT_BROWSERS_PATH=0 resolves to patchright-core's own .local-browsers", () => {
	const { ctx, state } = baseContext({
		env: { PLAYWRIGHT_BROWSERS_PATH: "0" },
	});
	withPatchrightCore(state, "1243");
	assert.equal(
		resolveBrowsersCacheDir(ctx),
		join(REPO_ROOT, "node_modules", "patchright-core", ".local-browsers"),
	);
});

// ─── checkDisplayAvailable ──────────────────────────────────────────────────

test("checkDisplayAvailable: always passes on macOS regardless of DISPLAY", () => {
	const { ctx } = baseContext({ platform: "darwin", env: {} });
	assert.equal(checkDisplayAvailable(ctx).status, "pass");
});

test("checkDisplayAvailable: always passes on Windows regardless of DISPLAY", () => {
	const { ctx } = baseContext({ platform: "win32", env: {} });
	assert.equal(checkDisplayAvailable(ctx).status, "pass");
});

test("checkDisplayAvailable: pass on Linux when DISPLAY is set", () => {
	const { ctx } = baseContext({ platform: "linux", env: { DISPLAY: ":0" } });
	assert.equal(checkDisplayAvailable(ctx).status, "pass");
});

test("checkDisplayAvailable: pass on Linux when only WAYLAND_DISPLAY is set", () => {
	const { ctx } = baseContext({
		platform: "linux",
		env: { WAYLAND_DISPLAY: "wayland-0" },
	});
	assert.equal(checkDisplayAvailable(ctx).status, "pass");
});

test("checkDisplayAvailable: warn on Linux with no display, naming the ozone-platform hint", () => {
	const { ctx } = baseContext({ platform: "linux", env: {} });
	const result = checkDisplayAvailable(ctx);
	assert.equal(result.status, "warn");
	assert.match(
		result.fix ?? "",
		/PDPP_BROWSER_EXTRA_ARGS=--ozone-platform=x11/,
	);
});

test("checkDisplayAvailable: pass with no warning on Linux with no display when PDPP_BROWSER_HEADLESS=1", () => {
	const { ctx } = baseContext({
		platform: "linux",
		env: { PDPP_BROWSER_HEADLESS: "1" },
	});
	const result = checkDisplayAvailable(ctx);
	assert.equal(result.status, "pass");
	assert.match(result.message, /PDPP_BROWSER_HEADLESS=1/);
});

test("checkDisplayAvailable: still checks DISPLAY when PDPP_BROWSER_HEADLESS is unset", () => {
	const { ctx } = baseContext({
		platform: "linux",
		env: { PDPP_BROWSER_HEADLESS: "0" },
	});
	assert.equal(checkDisplayAvailable(ctx).status, "warn");
});

// ─── checkEnvLocalLocation ───────────────────────────────────────────────

test("checkEnvLocalLocation: pass when .env.local exists at the repo root and nowhere else", () => {
	const { ctx, state } = baseContext();
	state.existing.add(join(REPO_ROOT, ".env.local"));
	state.dirEntries.set(join(REPO_ROOT, "packages"), []);
	state.dirEntries.set(join(REPO_ROOT, "connectors"), []);
	assert.equal(checkEnvLocalLocation(ctx).status, "pass");
});

test("checkEnvLocalLocation: warn (never fail) when no .env.local exists anywhere", () => {
	const { ctx, state } = baseContext();
	state.dirEntries.set(join(REPO_ROOT, "packages"), []);
	state.dirEntries.set(join(REPO_ROOT, "connectors"), []);
	assert.equal(checkEnvLocalLocation(ctx).status, "warn");
});

test("checkEnvLocalLocation: warns and points at the trap when only a subdirectory has one", () => {
	const { ctx, state } = baseContext();
	state.dirEntries.set(join(REPO_ROOT, "packages"), ["polyfill-connectors"]);
	state.dirEntries.set(join(REPO_ROOT, "connectors"), []);
	const trap = join(REPO_ROOT, "packages", "polyfill-connectors", ".env.local");
	state.existing.add(trap);
	const result = checkEnvLocalLocation(ctx);
	assert.equal(result.status, "warn");
	assert.match(result.message, /only ever read the repo-root file/);
	assert.match(result.fix ?? "", new RegExp(trap.replace(/[/]/g, "\\/")));
});

test("checkEnvLocalLocation: warns even when the root ALSO exists, since the subdir copy can still shadow it", () => {
	const { ctx, state } = baseContext();
	state.existing.add(join(REPO_ROOT, ".env.local"));
	state.dirEntries.set(join(REPO_ROOT, "packages"), ["polyfill-connectors"]);
	state.dirEntries.set(join(REPO_ROOT, "connectors"), []);
	state.existing.add(
		join(REPO_ROOT, "packages", "polyfill-connectors", ".env.local"),
	);
	assert.equal(checkEnvLocalLocation(ctx).status, "warn");
});

// ─── checkProfilesWritable / resolveProfilesRoot ───────────────────────────

test("resolveProfilesRoot: defaults to ~/.pdpp/profiles", () => {
	const { ctx } = baseContext();
	assert.equal(
		resolveProfilesRoot(ctx),
		join("/home/tester", ".pdpp", "profiles"),
	);
});

test("resolveProfilesRoot: PDPP_BROWSER_PROFILE_ROOT overrides the default", () => {
	const { ctx } = baseContext({
		env: { PDPP_BROWSER_PROFILE_ROOT: "/var/lib/pdpp/browser-profiles" },
	});
	assert.equal(resolveProfilesRoot(ctx), "/var/lib/pdpp/browser-profiles");
});

test("checkProfilesWritable: pass when the directory already exists and is writable", () => {
	const { ctx, state } = baseContext();
	state.existing.add(join("/home/tester", ".pdpp", "profiles"));
	assert.equal(checkProfilesWritable(ctx).status, "pass");
	assert.deepEqual(state.created, []);
});

test("checkProfilesWritable: creates the directory when missing, then passes", () => {
	const { ctx, state } = baseContext();
	const result = checkProfilesWritable(ctx);
	assert.equal(result.status, "pass");
	assert.deepEqual(state.created, [join("/home/tester", ".pdpp", "profiles")]);
});

test("checkProfilesWritable: fail with a permissions fix when access is denied", () => {
	const { ctx, state } = baseContext();
	const root = join("/home/tester", ".pdpp", "profiles");
	state.existing.add(root);
	state.unwritable.add(root);
	const result = checkProfilesWritable(ctx);
	assert.equal(result.status, "fail");
	assert.match(result.fix ?? "", /PDPP_BROWSER_PROFILE_ROOT/);
});

// ─── runDoctorChecks ────────────────────────────────────────────────────

test("runDoctorChecks: runs all six checks in a stable order", () => {
	const { ctx, state } = baseContext();
	setOwnPackageJson(state, {
		engines: { node: ">=24.15.0 <25" },
		dependencies: {},
	});
	state.dirEntries.set(join(REPO_ROOT, "packages"), []);
	state.dirEntries.set(join(REPO_ROOT, "connectors"), []);
	const results = runDoctorChecks(ctx);
	assert.deepEqual(
		results.map((r) => r.name),
		[
			"node-version",
			"dependencies",
			"chromium-revision",
			"display",
			"env-local",
			"profiles-writable",
		],
	);
});
