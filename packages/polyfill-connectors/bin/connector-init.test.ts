// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof for bin/connector-init.ts: scaffolding a new connector must produce
 * an immediately-green skeleton — the acceptance bar the module docstring
 * states. This test:
 *
 *   1. Runs init in a private fixture tree through the existing live path
 *      override. The real fleet is linked for acceptance checks;
 *      generated connectors never enter the shared checkout's inventory.
 *   2. Asserts every planned file exists.
 *   3. Runs the scaffolded connector's own pilot-fixture test AND the full
 *      manifest-honesty test family as real `node --test` subprocesses,
 *      and asserts both are green — proving the generated manifest/schema/
 *      fixture shape actually satisfies the fleet's build-time guardrails,
 *      not just that files were written.
 *   4. ALWAYS removes every created file/directory in a `finally`, so the
 *      tree is pristine afterward regardless of pass/fail. Verified against
 *      tracked connector content and this test's owned output paths.
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
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	connectorsDir,
	fixturesDir,
	manifestFileNames,
	packageRoot as PACKAGE_ROOT,
	repoRoot,
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

function withPrivateConnectorTree(
	run: () => void,
	sourceRoot = repoRoot,
): void {
	const realConnectors = join(sourceRoot, "connectors");
	const previousRoot = process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
	const root = mkdtempSync(join(tmpdir(), "connector-init-"));
	try {
		// Git is the inventory authority, not concurrent workers' untracked fixtures.
		const tracked = spawnSync("git", ["ls-files", "-z", "--", "connectors"], {
			cwd: sourceRoot,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		assert.equal(
			tracked.status,
			0,
			`tracked connector inventory unavailable: ${tracked.stderr}`,
		);
		const paths = tracked.stdout.split("\0").filter(Boolean).sort();
		const fingerprint = (path: string): string => {
			const fullPath = join(sourceRoot, path);
			assert.ok(
				existsSync(fullPath),
				`tracked connector input disappeared: ${path}`,
			);
			return `${lstatSync(fullPath).mode}:${createHash("sha256").update(readFileSync(fullPath)).digest("hex")}`;
		};
		const before = paths.map(fingerprint);
		const privateConnectors = join(root, "connectors");
		mkdirSync(privateConnectors);
		for (const path of paths) {
			const target = join(root, path);
			mkdirSync(dirname(target), { recursive: true });
			symlinkSync(join(sourceRoot, path), target);
		}
		// Bare dependencies and generated imports still use the ordinary installation.
		symlinkSync(join(repoRoot, "packages"), join(root, "packages"), "dir");
		symlinkSync(
			join(repoRoot, "node_modules"),
			join(root, "node_modules"),
			"dir",
		);
		symlinkSync(join(repoRoot, "package.json"), join(root, "package.json"));
		process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT = root;
		const manifests = paths
			.filter((path) => /^connectors\/[^/]+\/manifest\.json$/.test(path))
			.map((path) => `${path.split("/")[1]}.json`)
			.sort();
		assert.deepEqual(manifestFileNames(), manifests);
		try {
			run();
		} finally {
			for (const name of [TEMP_NAME, TEMP_NAME_BROWSER]) {
				assert.equal(
					existsSync(join(realConnectors, name)),
					false,
					`connector-init leaked its own output into the real connector inventory: ${name}`,
				);
			}
			assert.deepEqual(
				paths.map(fingerprint),
				before,
				"connector-init changed tracked connector input",
			);
		}
	} finally {
		if (previousRoot === undefined) {
			delete process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
		} else {
			process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT = previousRoot;
		}
		rmSync(root, { recursive: true, force: true });
		assert.equal(
			existsSync(root),
			false,
			"private fixture tree was not removed",
		);
		assert.equal(process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT, previousRoot);
	}
}

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

	try {
		writeScaffold(args);

		// Check the complete owned subtree, including empty directories and links,
		// rather than a moving global git-status snapshot.
		const expected = new Set<string>([plan.connectorDir]);
		for (const path of Object.values(plan.files)) {
			let current = path;
			while (current !== plan.connectorDir) {
				expected.add(current);
				current = dirname(current);
			}
		}
		const actual: string[] = [];
		const visit = (path: string): void => {
			actual.push(path);
			const stat = lstatSync(path);
			assert.equal(
				stat.isSymbolicLink(),
				false,
				"scaffold output must not be a symlink",
			);
			if (stat.isDirectory()) {
				for (const child of readdirSync(path)) {
					visit(join(path, child));
				}
			} else {
				assert.ok(stat.isFile(), "scaffold output must be a regular file");
			}
		};
		visit(plan.connectorDir);
		assert.deepEqual(
			actual.sort(),
			[...expected].sort(),
			"scaffold wrote undeclared private output",
		);
		assert.equal(
			existsSync(join(connectorsDir, args.name)),
			false,
			"scaffold must never appear in the real connector inventory",
		);
		assert.ok(
			manifestFileNames().includes(`${args.name}.json`),
			"the relocated inventory must discover the generated manifest",
		);
		assert.equal(
			childTestEnv().PDPP_CONNECTOR_PATHS_TEST_ROOT,
			process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT,
		);

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
		assert.equal(
			reconcileResult.code,
			0,
			`reconcile-manifests process exited nonzero: ${reconcileResult.stderr}`,
		);
	} finally {
		// ── 4. Always clean up, regardless of pass/fail above ──────────────
		cleanUp(plan.connectorDir, fixtureDir, plan.files.manifestJson);
		assert.deepEqual(
			findCollisions(plan),
			[],
			"cleanup left scaffold file(s) behind",
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
	withPrivateConnectorTree(() => assertScaffoldPassesAcceptanceSuite(args));
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
	withPrivateConnectorTree(() => assertScaffoldPassesAcceptanceSuite(args));
});

test("connector-init: refuses to overwrite an existing target and lists every collision", () => {
	withPrivateConnectorTree(() => {
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
			assert.equal(
				existsSync(join(connectorsDir, args.name)),
				false,
				"collision test must not write into the real connector inventory",
			);
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

function withTrackedSource(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "connector-init-source-"));
	try {
		mkdirSync(join(root, "connectors", "existing"), { recursive: true });
		writeFileSync(join(root, "connectors", "existing", "manifest.json"), "{}");
		writeFileSync(
			join(root, "connectors", "existing", "index.ts"),
			"// tracked input\n",
		);
		for (const args of [
			["init", "--quiet"],
			["add", "--", "connectors"],
		]) {
			const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		}
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("connector-init: unrelated untracked inventory changes do not break private isolation", () => {
	withTrackedSource((root) => {
		const removed = join(root, "connectors", "unrelated_before");
		const added = join(root, "connectors", "unrelated_during");
		mkdirSync(removed);
		writeFileSync(join(removed, "manifest.json"), "{}");
		withPrivateConnectorTree(() => {
			assert.deepEqual(manifestFileNames(), ["existing.json"]);
			rmSync(removed, { recursive: true });
			mkdirSync(added);
			writeFileSync(join(added, "manifest.json"), "{}");
		}, root);
	});
});

test("connector-init: its own leaked output is still rejected", () => {
	withTrackedSource((root) => {
		assert.throws(
			() =>
				withPrivateConnectorTree(() => {
					mkdirSync(join(root, "connectors", TEMP_NAME));
				}, root),
			/real connector/,
		);
	});
});

test("connector-init: mutation of an existing tracked input is still rejected", () => {
	withTrackedSource((root) => {
		assert.throws(
			() =>
				withPrivateConnectorTree(() => {
					writeFileSync(
						join(root, "connectors", "existing", "index.ts"),
						"// changed input\n",
					);
				}, root),
			/tracked connector/,
		);
	});
});

test("connector-init: next steps keep synthetic pilots separate from reviewed real captures", () => {
  withPrivateConnectorTree(() => {
    const name = `zz_init_instructions_${String(process.pid)}`;
    const plan = planTargets(name, "items");
    assert.deepEqual(findCollisions(plan), []);
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "bin/connector-init.ts", name], {
        cwd: PACKAGE_ROOT,
        env: childTestEnv(),
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`connectors/${name}/fixtures/scrubbed/<runId>/`));
      assert.match(result.stdout, /Keep the synthetic pilot-real-shape rows/);
      assert.match(result.stdout, /Never put real owner rows under pilot-real-shape/);
      assert.doesNotMatch(result.stdout, /replace this\s+scaffold's synthetic/);
    } finally {
      cleanUp(plan.connectorDir, fixturesDir(name), plan.files.manifestJson);
    }
  });
});

test("CLI browser scaffold parses unusual display names and orders setup before running", () => {
  withPrivateConnectorTree(() => {
    for (const [suffix, display] of [
      ["quote", 'Acme "Plus"'],
      ["newline", "Acme\nPlus"],
    ]) {
      const name = `zz_init_${suffix}_${process.pid}`;
      const plan = planTargets(name, "items");
      assert.deepEqual(findCollisions(plan), []);
      try {
        const result = spawnSync(
          process.execPath,
          ["--import", "tsx", "bin/connector-init.ts", name, "--browser", "--display-name", display],
          { cwd: PACKAGE_ROOT, env: childTestEnv(), encoding: "utf8" }
        );
        assert.equal(result.status, 0, result.stderr);
        for (const file of [plan.files.indexTs, plan.files.typesTs]) {
          const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
          assert.equal(checked.status, 0, checked.stderr);
        }
        const setup = result.stdout.indexOf("LOGIN_CHECK_URL");
        const run = result.stdout.indexOf("bin/connector-dev.ts");
        assert.ok(setup >= 0 && setup < run, result.stdout);
      } finally {
        cleanUp(plan.connectorDir, fixturesDir(name), plan.files.manifestJson);
      }
    }
  });
});

test("CLI browser scaffold rejects an untouched row selector but accepts configured empty rows", () => {
  withPrivateConnectorTree(() => {
    const name = `zz_init_rows_${process.pid}`;
    const plan = planTargets(name, "items");
    assert.deepEqual(findCollisions(plan), []);
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "bin/connector-init.ts", name, "--browser"], {
        cwd: PACKAGE_ROOT,
        env: childTestEnv(),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      writeFileSync(
        plan.files.indexTs,
        readFileSync(plan.files.indexTs, "utf8").replace('"TODO-rows-container-selector"', '"#rows"')
      );
      writeFileSync(plan.files.indexTs, readFileSync(plan.files.indexTs, "utf8").replace(JSON.stringify(`https://example.invalid/TODO-${name}-items`), JSON.stringify("https://example.invalid/items")));
			const script = `
      import assert from "node:assert/strict";
      import {readFileSync, writeFileSync} from "node:fs";
      import {pathToFileURL} from "node:url";
      const path = ${JSON.stringify(plan.files.indexTs)};
      const url = pathToFileURL(path).href;
      const {collect} = await import(url + "?first");
      let rows = [{getAttribute: () => "value", textContent: "row"}];
      const rowLocator = {evaluateAll: async (extract) => extract(rows)};
      const container = {isVisible: async () => true, locator: () => rowLocator};
      const page = {goto: async (url) => assert.equal(url, "https://example.invalid/items"), locator: () => ({count: async () => 1, nth: () => container}), waitForTimeout: async () => undefined};
      const context = {page, requested: new Set(["items"]), progress: async () => undefined, emitRecord: async () => undefined};
      await assert.rejects(() => collect(context), /ROW_SELECTOR.*placeholder/);
      rows = [];
      writeFileSync(path, readFileSync(path, "utf8").replace('"TODO-row-selector"', '".row"'));
      const configured = await import(url + "?configured");
      await assert.doesNotReject(() => configured.collect(context));
    `;
      const checked = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: PACKAGE_ROOT,
        env: childTestEnv(),
        encoding: "utf8",
      });
      assert.equal(checked.status, 0, checked.stderr);
    } finally {
      cleanUp(plan.connectorDir, fixturesDir(name), plan.files.manifestJson);
    }
  });
});

test("CLI browser instructions configure login before first invocation", () => {
  withPrivateConnectorTree(() => {
    const name = `zz_init_order_${process.pid}`;
    const plan = planTargets(name, "items");
    assert.deepEqual(findCollisions(plan), []);
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "bin/connector-init.ts", name, "--browser"], {
        cwd: PACKAGE_ROOT,
        env: childTestEnv(),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(
        result.stdout.indexOf("LOGIN_CHECK_URL") >= 0 &&
          result.stdout.indexOf("LOGIN_CHECK_URL") < result.stdout.indexOf("bin/connector-dev.ts"),
        result.stdout
      );
    } finally {
      cleanUp(plan.connectorDir, fixturesDir(name), plan.files.manifestJson);
    }
  });
});

test("cleanup leaves unrelated changes in a private fixture alone", () => {
  const root = mkdtempSync(join(tmpdir(), "init-owned-"));
  const connector = join(root, "connector");
  const fixture = join(root, "fixture");
  const manifest = join(root, "manifest.json");
  const unrelated = join(root, "unrelated.txt");
  try {
    writeFileSync(unrelated, "before");
    writeFileSync(manifest, "owned");
    writeFileSync(unrelated, "changed during generation");
    cleanUp(connector, fixture, manifest);
    assert.equal(readFileSync(unrelated, "utf8"), "changed during generation");
    assert.equal(existsSync(manifest), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI collision refuses pre-existing targets without changing their bytes", () => {
  withPrivateConnectorTree(() => {
    const name = `zz_init_collision_${process.pid}`;
    const plan = planTargets(name, "items");
    mkdirSync(plan.connectorDir, { recursive: true });
    writeFileSync(plan.files.indexTs, "// sentinel source\n");
    writeFileSync(plan.files.manifestJson, '{"sentinel":true}\n');
    const files = [plan.files.indexTs, plan.files.manifestJson];
    const before = files.map((path) => readFileSync(path));
    const names = readdirSync(plan.connectorDir).sort();
    const result = spawnSync(process.execPath, ["--import", "tsx", "bin/connector-init.ts", name], {
      cwd: PACKAGE_ROOT,
      env: childTestEnv(),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    for (const path of [plan.connectorDir, ...files]) assert.ok((result.stderr + result.stdout).includes(path));
    assert.deepEqual(
      files.map((path) => readFileSync(path)),
      before
    );
    assert.deepEqual(readdirSync(plan.connectorDir).sort(), names);
  });
});
