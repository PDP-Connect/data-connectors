#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * connector-doctor — environment preflight for driving a connector locally,
 * especially a browser-class one (real Patchright Chromium, a persistent
 * profile, a real display).
 *
 * Usage:
 *   node --import tsx bin/connector-doctor.ts
 *
 * Checks, each printing the exact fix on failure instead of a generic
 * "something's wrong":
 *   - Node version satisfies this package's declared `engines.node` range.
 *   - Every dependency this package declares is actually installed.
 *   - The Chromium revision the installed Patchright build needs is
 *     present in the browser cache (prints the install command otherwise).
 *   - Display availability for a headed run (Linux only — DISPLAY/
 *     WAYLAND_DISPLAY, plus the PDPP_BROWSER_EXTRA_ARGS=--ozone-platform=x11
 *     hint for the common tmux/SSH GPU-init failure; macOS/Windows don't
 *     need a check, so this always passes there). Skipped entirely (passes
 *     with no DISPLAY/XAUTHORITY warning) when PDPP_BROWSER_HEADLESS=1 is
 *     set — a deliberately headless run has nothing to render and a display
 *     warning there is noise, not signal.
 *   - `.env.local` exists at the REPO ROOT — connector-dev.ts and every
 *     connector's own dotenv load only ever read that one file. Warns
 *     (never fails) if one exists only in a subdirectory instead — a known
 *     trap where a tool run from inside that subdirectory silently picks
 *     up the nearer file.
 *   - `~/.pdpp/profiles` (or `PDPP_BROWSER_PROFILE_ROOT`) exists and is
 *     writable — every browser connector's persistent session lives there.
 *
 * Exit code: 0 unless a HARD BLOCKER check fails (wrong Node version, a
 * missing dependency, a missing Chromium revision, an unwritable profile
 * root). No display and no root `.env.local` are both legitimate postures
 * (a headless CI box; credentials exported another way) — they print as
 * warnings and never flip the exit code.
 *
 * Every check is a pure function of an injected `DoctorContext` (env,
 * platform, home dir, a small fs seam, repo/package roots) — see
 * `connector-doctor.test.ts` for the unit tests this makes possible without
 * touching the real filesystem or process.env.
 */

import {
	accessSync,
	existsSync,
	constants as fsConstants,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	packageRoot as PACKAGE_ROOT,
	repoRoot as REPO_ROOT,
} from "../src/connector-paths.ts";

// ─── Context: the one seam every check is written against ────────────────

export interface DoctorFsLike {
	accessSync: (path: string, mode: number) => void;
	existsSync: (path: string) => boolean;
	mkdirSync: (path: string) => void;
	readdirSync: (path: string) => string[];
	readFileSync: (path: string) => string;
}

export interface DoctorContext {
	env: NodeJS.ProcessEnv;
	fs: DoctorFsLike;
	homeDir: string;
	nodeVersion: string;
	packageRoot: string;
	platform: NodeJS.Platform;
	repoRoot: string;
}

export function defaultDoctorContext(): DoctorContext {
	return {
		env: process.env,
		fs: {
			accessSync: (path, mode) => accessSync(path, mode),
			existsSync,
			mkdirSync: (path) => mkdirSync(path, { recursive: true }),
			readdirSync: (path) => readdirSync(path),
			readFileSync: (path) => readFileSync(path, "utf8"),
		},
		homeDir: homedir(),
		nodeVersion: process.version,
		packageRoot: PACKAGE_ROOT,
		platform: process.platform,
		repoRoot: REPO_ROOT,
	};
}

export type DoctorCheckStatus = "fail" | "pass" | "warn";

export interface DoctorCheckResult {
	fix?: string;
	message: string;
	name: string;
	status: DoctorCheckStatus;
}

// ─── Tiny engines-range comparator (no "semver" dep: it's only ever a
// transitive dependency here, not a declared one — see this package's
// package.json. The one real-world shape this repo's engines.node uses is
// ">=X.Y.Z <A"; this handles exactly that grammar, nothing more.) ─────────

interface SemverTuple {
	major: number;
	minor: number;
	patch: number;
}

function parseSemver(raw: string): SemverTuple {
	const [major = "0", minor = "0", patch = "0"] = raw
		.replace(/^v/, "")
		.split(".");
	return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareSemver(a: SemverTuple, b: SemverTuple): number {
	if (a.major !== b.major) {
		return a.major - b.major;
	}
	if (a.minor !== b.minor) {
		return a.minor - b.minor;
	}
	return a.patch - b.patch;
}

const ENGINE_CLAUSE_RE = /^(>=|<=|>|<|=)?(\d+(?:\.\d+(?:\.\d+)?)?)$/;

/** Exported for its own unit tests. Unknown clause shapes are ignored
 *  (treated as satisfied) rather than failing a check on a range grammar
 *  this parser doesn't understand — a false "fail" from a parser bug would
 *  be a worse outcome than a missed hard-blocker here. */
export function satisfiesEngineRange(version: string, range: string): boolean {
	const current = parseSemver(version);
	const clauses = range.trim().split(/\s+/).filter(Boolean);
	return clauses.every((clause) => {
		const match = ENGINE_CLAUSE_RE.exec(clause);
		if (!match) {
			return true;
		}
		const [, op, verRaw] = match;
		if (!verRaw) {
			return true;
		}
		const cmp = compareSemver(current, parseSemver(verRaw));
		switch (op ?? ">=") {
			case ">=":
				return cmp >= 0;
			case ">":
				return cmp > 0;
			case "<=":
				return cmp <= 0;
			case "<":
				return cmp < 0;
			case "=":
				return cmp === 0;
			default:
				return true;
		}
	});
}

// ─── Shared: read this package's own package.json ─────────────────────────

interface PackageJsonShape {
	dependencies?: Record<string, string>;
	engines?: { node?: string };
}

function readOwnPackageJson(ctx: DoctorContext): PackageJsonShape {
	try {
		return JSON.parse(
			ctx.fs.readFileSync(join(ctx.packageRoot, "package.json")),
		) as PackageJsonShape;
	} catch {
		return {};
	}
}

/**
 * Finds `<dir>/node_modules/<name>` by walking upward from `startDir` to the
 * filesystem root — the same directory chain Node's own module resolution
 * walks. Deliberately NOT `require.resolve`: a workspace-local package
 * (e.g. `@pdpp/connector-protocol`) can declare an `exports` map with no
 * bare `"."` entry, which makes `require.resolve(name)` throw even though
 * the package is correctly installed — this only needs "is it on disk",
 * not "does its root entrypoint resolve".
 */
function findInstalledPackageDir(
	ctx: DoctorContext,
	name: string,
): string | undefined {
	let dir = ctx.packageRoot;
	for (let i = 0; i < 8; i += 1) {
		const candidate = join(dir, "node_modules", name);
		if (ctx.fs.existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return;
}

// ─── Check 1: Node version ─────────────────────────────────────────────────

export function checkNodeVersion(ctx: DoctorContext): DoctorCheckResult {
	const range = readOwnPackageJson(ctx).engines?.node;
	if (!range) {
		return {
			name: "node-version",
			status: "warn",
			message:
				"Could not read this package's engines.node range from package.json.",
		};
	}
	if (satisfiesEngineRange(ctx.nodeVersion, range)) {
		return {
			name: "node-version",
			status: "pass",
			message: `Node ${ctx.nodeVersion} satisfies the required range "${range}".`,
		};
	}
	return {
		name: "node-version",
		status: "fail",
		message: `Node ${ctx.nodeVersion} does not satisfy the required range "${range}".`,
		fix: "Install a matching Node version, e.g. with nvm: nvm install 24 && nvm use 24",
	};
}

// ─── Check 2: dependencies installed ───────────────────────────────────────

export function checkDependenciesInstalled(
	ctx: DoctorContext,
): DoctorCheckResult {
	const deps = Object.keys(readOwnPackageJson(ctx).dependencies ?? {});
	if (deps.length === 0) {
		return {
			name: "dependencies",
			status: "warn",
			message:
				"Could not read this package's declared dependencies from package.json.",
		};
	}
	const missing = deps.filter(
		(dep) => findInstalledPackageDir(ctx, dep) === undefined,
	);
	if (missing.length === 0) {
		return {
			name: "dependencies",
			status: "pass",
			message: `All ${String(deps.length)} declared dependencies resolve.`,
		};
	}
	return {
		name: "dependencies",
		status: "fail",
		message: `${String(missing.length)} declared dependency(ies) are not installed: ${missing.join(", ")}.`,
		fix: "Run: npm install   (from the repository root)",
	};
}

// ─── Check 3: Patchright/Playwright Chromium revision present ─────────────

interface PatchrightBrowsersManifest {
	browsers?: Array<{ name?: string; revision?: string }>;
}

function readRequiredChromiumRevision(ctx: DoctorContext): string | undefined {
	const coreDir = findInstalledPackageDir(ctx, "patchright-core");
	if (!coreDir) {
		return;
	}
	try {
		const manifest = JSON.parse(
			ctx.fs.readFileSync(join(coreDir, "browsers.json")),
		) as PatchrightBrowsersManifest;
		return manifest.browsers?.find((b) => b.name === "chromium")?.revision;
	} catch {
		return;
	}
}

function defaultBrowsersCacheDir(ctx: DoctorContext): string {
	if (ctx.platform === "darwin") {
		return join(ctx.homeDir, "Library", "Caches", "ms-playwright");
	}
	if (ctx.platform === "win32") {
		return join(ctx.homeDir, "AppData", "Local", "ms-playwright");
	}
	return join(ctx.homeDir, ".cache", "ms-playwright");
}

/** Honors `PLAYWRIGHT_BROWSERS_PATH` (patchright-core reads the same env var
 *  stock Playwright does — it's a Playwright fork, not a reimplementation).
 *  `PLAYWRIGHT_BROWSERS_PATH=0` is Playwright's own documented "package-
 *  local" mode: browsers install under the patchright-core package's own
 *  `.local-browsers/` instead of the shared user cache. */
export function resolveBrowsersCacheDir(ctx: DoctorContext): string {
	const override = ctx.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
	if (override && override !== "0") {
		return override;
	}
	if (override === "0") {
		const coreDir = findInstalledPackageDir(ctx, "patchright-core");
		if (coreDir) {
			return join(coreDir, ".local-browsers");
		}
	}
	return defaultBrowsersCacheDir(ctx);
}

export function checkChromiumRevision(ctx: DoctorContext): DoctorCheckResult {
	const revision = readRequiredChromiumRevision(ctx);
	if (!revision) {
		return {
			name: "chromium-revision",
			status: "fail",
			message:
				"Could not determine the Chromium revision patchright needs — patchright-core does not appear to be installed.",
			fix: "Run: npm install   (from the repository root), then re-run connector-doctor.",
		};
	}
	const cacheDir = resolveBrowsersCacheDir(ctx);
	const revisionDir = join(cacheDir, `chromium-${revision}`);
	if (ctx.fs.existsSync(revisionDir)) {
		return {
			name: "chromium-revision",
			status: "pass",
			message: `Chromium revision ${revision} is present at ${revisionDir}.`,
		};
	}
	return {
		name: "chromium-revision",
		status: "fail",
		message: `Chromium revision ${revision} (required by the installed patchright) is missing at ${revisionDir}.`,
		fix: "Run: npx patchright install chromium",
	};
}

// ─── Check 4: display availability (headed runs) ──────────────────────────

/** Same truthiness check `browser-launch.ts`/`connector-runtime.ts` use for
 *  `PDPP_BROWSER_HEADLESS` — keep this in lockstep with those. */
function headlessRequested(ctx: DoctorContext): boolean {
	return ctx.env.PDPP_BROWSER_HEADLESS?.trim() === "1";
}

export function checkDisplayAvailable(ctx: DoctorContext): DoctorCheckResult {
	if (headlessRequested(ctx)) {
		return {
			name: "display",
			status: "pass",
			message:
				"PDPP_BROWSER_HEADLESS=1 is set — headless runs render nothing, so DISPLAY/WAYLAND_DISPLAY and XAUTHORITY are irrelevant here. Skipping the display check.",
		};
	}
	if (ctx.platform !== "linux") {
		const osName = ctx.platform === "darwin" ? "macOS" : "Windows";
		return {
			name: "display",
			status: "pass",
			message: `${osName} does not need a DISPLAY check for headed browser runs.`,
		};
	}
	const display = ctx.env.DISPLAY?.trim() || ctx.env.WAYLAND_DISPLAY?.trim();
	if (display) {
		return {
			name: "display",
			status: "pass",
			message: `DISPLAY/WAYLAND_DISPLAY is set (${display}) — headed browser runs can render. If Chromium still fails to initialize its GPU process under tmux/SSH, try PDPP_BROWSER_EXTRA_ARGS=--ozone-platform=x11.`,
		};
	}
	return {
		name: "display",
		status: "warn",
		message:
			"No DISPLAY/WAYLAND_DISPLAY detected — a headed browser run has nowhere to render on this Linux host (browser-class connectors fall back to headless, with no attach surface from connector-dev).",
		fix: "Export DISPLAY for a real X/Xvfb session, or set PDPP_BROWSER_HEADLESS=1 to run headless deliberately. If DISPLAY IS set elsewhere but Chromium's GPU process still fails to init (common under tmux/SSH), try PDPP_BROWSER_EXTRA_ARGS=--ozone-platform=x11.",
	};
}

// ─── Check 5: .env.local at the repo root ──────────────────────────────────

/** Shallow scan of `packages/*` and `connectors/*` for a `.env.local` —
 *  the two places closest to a connector's own working directory, so the
 *  two places a tool run from inside one would silently pick up instead of
 *  the repo root (dotenv resolves relative to `process.cwd()` by default;
 *  every real reader in this repo, e.g. connector-dev.ts, explicitly points
 *  at the repo root instead — a subdirectory `.env.local` only ever matters
 *  to ad hoc `dotenv -e .env.local` style invocations). */
function findEnvLocalInSubdirectories(ctx: DoctorContext): string[] {
	const found: string[] = [];
	for (const parentName of ["packages", "connectors"]) {
		const parentDir = join(ctx.repoRoot, parentName);
		let entries: string[];
		try {
			entries = ctx.fs.readdirSync(parentDir);
		} catch {
			continue;
		}
		for (const name of entries) {
			const candidate = join(parentDir, name, ".env.local");
			if (ctx.fs.existsSync(candidate)) {
				found.push(candidate);
			}
		}
	}
	return found;
}

export function checkEnvLocalLocation(ctx: DoctorContext): DoctorCheckResult {
	const rootPath = join(ctx.repoRoot, ".env.local");
	const rootExists = ctx.fs.existsSync(rootPath);
	const subdirHits = findEnvLocalInSubdirectories(ctx);

	if (rootExists && subdirHits.length === 0) {
		return {
			name: "env-local",
			status: "pass",
			message: `${rootPath} exists.`,
		};
	}
	if (subdirHits.length > 0) {
		const trap = subdirHits.join(", ");
		return {
			name: "env-local",
			status: "warn",
			message: rootExists
				? `${rootPath} exists, but so does ${trap} — a subdirectory .env.local is a known trap: a tool run from inside that directory may load it instead of the repo-root one.`
				: `No .env.local at the repo root (${rootPath}), but found ${trap} — connector-dev.ts and this tool only ever read the repo-root file.`,
			fix: `Move or merge ${trap} into ${rootPath}.`,
		};
	}
	return {
		name: "env-local",
		status: "warn",
		message: `No .env.local at the repo root (${rootPath}). Fine if your credentials are exported another way.`,
		fix: `Copy .env.example to ${rootPath} and fill in real values, if a connector you're running needs env credentials.`,
	};
}

// ─── Check 6: ~/.pdpp/profiles writable ────────────────────────────────────

export function resolveProfilesRoot(ctx: DoctorContext): string {
	const override = ctx.env.PDPP_BROWSER_PROFILE_ROOT?.trim();
	return override || join(ctx.homeDir, ".pdpp", "profiles");
}

export function checkProfilesWritable(ctx: DoctorContext): DoctorCheckResult {
	const root = resolveProfilesRoot(ctx);
	try {
		if (!ctx.fs.existsSync(root)) {
			ctx.fs.mkdirSync(root);
		}
		ctx.fs.accessSync(root, fsConstants.W_OK);
		return {
			name: "profiles-writable",
			status: "pass",
			message: `${root} exists and is writable.`,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			name: "profiles-writable",
			status: "fail",
			message: `${root} is not writable: ${reason}`,
			fix: `Fix permissions on ${root}, or set PDPP_BROWSER_PROFILE_ROOT to a writable directory.`,
		};
	}
}

// ─── Run everything ─────────────────────────────────────────────────────

export function runDoctorChecks(ctx: DoctorContext): DoctorCheckResult[] {
	return [
		checkNodeVersion(ctx),
		checkDependenciesInstalled(ctx),
		checkChromiumRevision(ctx),
		checkDisplayAvailable(ctx),
		checkEnvLocalLocation(ctx),
		checkProfilesWritable(ctx),
	];
}

const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
	pass: "PASS",
	warn: "WARN",
	fail: "FAIL",
};

function printResult(result: DoctorCheckResult): void {
	process.stdout.write(
		`[${STATUS_LABEL[result.status]}] ${result.name} — ${result.message}\n`,
	);
	if (result.fix) {
		process.stdout.write(`       fix: ${result.fix}\n`);
	}
}

function main(): void {
	const results = runDoctorChecks(defaultDoctorContext());
	for (const result of results) {
		printResult(result);
	}
	const failed = results.filter((r) => r.status === "fail");
	const warned = results.filter((r) => r.status === "warn");
	if (failed.length > 0) {
		process.stdout.write(
			`\nconnector-doctor: ${String(failed.length)} check(s) failed, ${String(warned.length)} warning(s).\n`,
		);
		process.exitCode = 1;
		return;
	}
	process.stdout.write(
		`\nconnector-doctor: all hard-blocker checks passed (${String(warned.length)} warning(s)).\n`,
	);
	process.exitCode = 0;
}

if (isMainModule(import.meta.url)) {
	main();
}
