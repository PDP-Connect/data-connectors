// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof for bin/connector-init.ts: scaffolding a new connector must produce
 * an immediately-green skeleton — the acceptance bar the module docstring
 * states. This test:
 *
 *   1. Runs init for a temp-named connector (zz_init_smoke_<pid>) directly
 *      against the real package tree (writeScaffold has no dry-run mode;
 *      there is nowhere safer to prove "init produces files the fleet's
 *      real test discovery picks up" than the real tree the fleet's tests
 *      already scan).
 *   2. Asserts every planned file exists.
 *   3. Runs the scaffolded connector's own pilot-fixture test AND the full
 *      manifest-honesty test family as real `node --test` subprocesses,
 *      and asserts both are green — proving the generated manifest/schema/
 *      fixture shape actually satisfies the fleet's build-time guardrails,
 *      not just that files were written.
 *   4. ALWAYS removes every created file/directory in a `finally`, so the
 *      tree is pristine afterward regardless of pass/fail. Verified with a
 *      `git status --porcelain` diff against a pre-run snapshot.
 *
 * `assertScaffoldPassesAcceptanceSuite` runs steps 2-4 for any `InitArgs`;
 * it is exercised once for the default API-mode scaffold and once for
 * `--browser` (zz_init_browser_smoke_<pid>) — same acceptance bar, same
 * honesty suite (`src/browser-manifest-honesty.test.ts` is already in the
 * list below for both, since it must accept every manifest in the tree,
 * API-mode or browser-mode).
 *
 * The temp connector names are prefixed `zz_` and suffixed with the test's
 * own PID so concurrent runs (or a leftover from a prior crashed run) can
 * never collide with a real connector name or with each other.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	fixturesDir,
	packageRoot as PACKAGE_ROOT,
} from "../src/connector-paths.ts";
import { reconcileFromDisk } from "../src/manifest-reconcile.ts";
import {
	findCollisions,
	type InitArgs,
	InitArgsError,
	parseArgs,
	planTargets,
	writeScaffold,
} from "./connector-init.ts";

const TEMP_NAME = `zz_init_smoke_${String(process.pid)}`;
const TEMP_NAME_BROWSER = `zz_init_browser_smoke_${String(process.pid)}`;
const TEMP_STREAM = "items";

interface CliResult {
	code: number | null;
	stderr: string;
	stdout: string;
}

/**
 * This test file itself runs under `node --test`, which sets
 * `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` in its own process env. Node's
 * test runner detects those in a CHILD process and silently no-ops
 * "recursive" `node --test` invocations ("run() is being called recursively
 * within a test file. skipping running files.") rather than actually running
 * the requested files — so the nested `node --test` subprocesses this test
 * spawns must NOT inherit them.
 */
const RECURSIVE_TEST_ENV_KEYS = new Set([
	"NODE_TEST_CONTEXT",
	"NODE_TEST_WORKER_ID",
]);

function childTestEnv(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !RECURSIVE_TEST_ENV_KEYS.has(key),
		),
	);
}

function runNodeTest(testFiles: readonly string[]): CliResult {
	const result = spawnSync(
		process.execPath,
		["--test", "--import", "tsx", "--test-reporter=tap", ...testFiles],
		{
			cwd: PACKAGE_ROOT,
			env: childTestEnv(),
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	return {
		code: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** Parse the TAP reporter's `# fail N` summary line. Throws if absent (malformed run). */
function tapFailCount(tapOutput: string): number {
	const match = /^# fail (\d+)$/m.exec(tapOutput);
	assert.ok(match, `TAP output missing "# fail N" summary line:\n${tapOutput}`);
	return Number(match[1]);
}

function gitStatusPorcelain(): string {
	const result = spawnSync("git", ["status", "--porcelain"], {
		cwd: PACKAGE_ROOT,
		encoding: "utf8",
	});
	// Not every checkout of this package is inside a git repo the CLI can see
	// (e.g. a worktree-less copy) — treat a git failure as "nothing to check"
	// rather than failing the whole test on an environment quirk.
	return result.status === 0 ? result.stdout : "";
}

function cleanUp(
	connectorDir: string,
	fixtureDir: string,
	manifestPath: string,
): void {
	rmSync(connectorDir, { recursive: true, force: true });
	rmSync(fixtureDir, { recursive: true, force: true });
	rmSync(manifestPath, { force: true });
}

/**
 * Steps 2-4 of this file's module docstring, for any `InitArgs`. Shared by
 * the API-mode and `--browser`-mode acceptance tests below so both run the
 * exact same bar — a passing API-mode scaffold proves nothing about
 * `--browser` mode, since `writeScaffold` branches on `args.browser` to an
 * entirely different set of file builders (see connector-init.ts).
 */
function assertScaffoldPassesAcceptanceSuite(args: InitArgs): void {
	const plan = planTargets(args.name, args.stream);
	const fixtureDir = fixturesDir(args.name);

	// Precondition: nothing pre-existing for this temp name (would falsely
	// pass "collisions are refused" and also risk clobbering real state).
	assert.deepEqual(
		findCollisions(plan),
		[],
		`unexpected pre-existing path(s) for ${args.name}; clean up manually`,
	);

	const preStatus = gitStatusPorcelain();

	try {
		writeScaffold(args);

		// ── 2. Every planned file exists ──────────────────────────────────
		assert.ok(
			existsSync(plan.connectorDir),
			"connector directory was not created",
		);
		for (const [label, path] of Object.entries(plan.files)) {
			assert.ok(existsSync(path), `${label} was not created at ${path}`);
		}
		const reconciliation = reconcileFromDisk({
			connector: args.name,
			manifestPath: plan.files.manifestJson,
			schemaPath: plan.files.schemasTs,
			emitSourcePaths: [plan.files.indexTs, plan.files.parsersTs],
		});
		assert.equal(
			reconciliation.ok,
			true,
			`scaffold does not reconcile: ${JSON.stringify(reconciliation, null, 2)}`,
		);

		// Re-running init against the now-populated tree must refuse (collision
		// list is non-empty) rather than silently overwrite.
		const collisionsAfter = findCollisions(plan);
		assert.ok(
			collisionsAfter.length > 0,
			"init must refuse to overwrite existing scaffold files",
		);

		// ── 3a. The scaffolded connector's own pilot-fixture test is green ──
		const pilotResult = runNodeTest([plan.files.pilotFixtureTestTs]);
		assert.equal(
			tapFailCount(pilotResult.stdout),
			0,
			`pilot-fixture test for ${args.name} failed:\n${pilotResult.stdout}\n${pilotResult.stderr}`,
		);
		assert.equal(
			pilotResult.code,
			0,
			`pilot-fixture test process exited nonzero: ${pilotResult.stderr}`,
		);

		// ── 3b. The full manifest-honesty test family accepts the new manifest ──
		// These tests glob manifests/*.json and connectors/*/ at run time, so
		// they pick up the freshly-written scaffold with no wiring required.
		const honestyFiles = [
			"src/collector-scope-manifest-honesty.test.ts",
			"src/semantic-time-manifest-honesty.test.ts",
			"src/setup-repair-manifest-honesty.test.ts",
			"src/presentation-role-manifest-honesty.test.ts",
			"src/browser-manifest-honesty.test.ts",
			"src/search-affordance-manifest-honesty.test.ts",
			"src/coverage-policy-manifest-honesty.test.ts",
			"src/query-affordance-manifest-honesty.test.ts",
			"src/external-tool-manifest-honesty.test.ts",
			// public-listing-manifest-honesty.test.ts hard-codes the fleet's exact
			// manifest count (`assert.equal(names.length, 43)`), which the scaffold
			// deliberately perturbs for the duration of this test — see the
			// dedicated assertion below instead of including it here.
		].map((relative) => join(PACKAGE_ROOT, relative));
		const honestyResult = runNodeTest(honestyFiles);
		assert.equal(
			tapFailCount(honestyResult.stdout),
			0,
			`manifest-honesty suite failed against the scaffolded manifest:\n${honestyResult.stdout}\n${honestyResult.stderr}`,
		);
		assert.equal(
			honestyResult.code,
			0,
			`manifest-honesty test process exited nonzero: ${honestyResult.stderr}`,
		);

		// ── 3c. manifest/schema/emit reconciliation accepts the scaffold ──
		const reconcileResult = runNodeTest([
			join(PACKAGE_ROOT, "bin", "reconcile-manifests.test.ts"),
		]);
		assert.equal(
			tapFailCount(reconcileResult.stdout),
			0,
			`reconcile-manifests suite failed against the scaffolded connector:\n${reconcileResult.stdout}\n${reconcileResult.stderr}`,
		);
	} finally {
		// ── 4. Always clean up, regardless of pass/fail above ──────────────
		cleanUp(plan.connectorDir, fixtureDir, plan.files.manifestJson);
		assert.deepEqual(
			findCollisions(plan),
			[],
			"cleanup left scaffold file(s) behind",
		);

		const postStatus = gitStatusPorcelain();
		assert.equal(
			postStatus,
			preStatus,
			"connector-init test left the working tree dirty after cleanup",
		);
	}
}

test("connector-init: scaffolds a connector whose pilot-fixture and manifest-honesty tests pass immediately", () => {
	const args = parseArgs([
		TEMP_NAME,
		"--display-name",
		"ZZ Init Smoke",
		"--stream",
		TEMP_STREAM,
	]);
	assertScaffoldPassesAcceptanceSuite(args);
});

test("connector-init --browser: scaffolds a browser connector whose pilot-fixture and manifest-honesty tests pass immediately", () => {
	const args = parseArgs([
		TEMP_NAME_BROWSER,
		"--display-name",
		"ZZ Init Browser Smoke",
		"--stream",
		TEMP_STREAM,
		"--browser",
	]);
	assert.equal(args.browser, true);
	assertScaffoldPassesAcceptanceSuite(args);
});

test("connector-init: refuses to overwrite an existing target and lists every collision", () => {
	const args = parseArgs([TEMP_NAME, "--stream", TEMP_STREAM]);
	const plan = planTargets(args.name, args.stream);
	const fixtureDir = fixturesDir(args.name);
	assert.deepEqual(
		findCollisions(plan),
		[],
		`unexpected pre-existing path(s) for ${TEMP_NAME}`,
	);

	try {
		writeScaffold(args);
		const collisions = findCollisions(plan);
		// Every real target file plus the connector directory itself should be
		// reported — a partial collision list would let a second init silently
		// clobber files it didn't list.
		assert.ok(collisions.includes(plan.connectorDir));
		assert.ok(collisions.includes(plan.files.manifestJson));
		assert.ok(collisions.includes(plan.files.indexTs));
		assert.ok(collisions.includes(plan.files.schemasTs));
		assert.ok(collisions.includes(plan.files.pilotFixtureTestTs));
		assert.ok(collisions.includes(plan.files.fixtureJsonl));
		assert.ok(collisions.includes(plan.files.provenanceJson));
	} finally {
		cleanUp(plan.connectorDir, fixtureDir, plan.files.manifestJson);
	}
});

test("connector-init: rejects a non-snake_case connector name before touching disk", () => {
	assert.throws(
		() => parseArgs(["NotSnakeCase"]),
		(err: unknown) =>
			err instanceof InitArgsError &&
			/invalid connector name/i.test(err.message),
		"should reject on invalid name shape",
	);
});
