# Testing data-connectors

Run `npm run test:fast` while you edit, `npm run verify` and `npm test` before you open a PR, and add a test that fails without your fix. The tables below say what each command runs.

## Tiers

| When | Command | What runs | Measured (a 24-core Linux host) |
|---|---|---|---|
| While editing | `npm run test:fast` (in the repo root or in `packages/polyfill-connectors`) | Tests related to files changed since `git merge-base HEAD origin/main`, plus uncommitted and untracked files. | one-connector edit, 42 tests, 4-10 s |
| Same, against any base | `npm run test:related -- <base>` (in `packages/polyfill-connectors`) | The same selection against `<base>`. When the selector cannot trust the import graph, it runs both polyfill lanes. | |
| Before a PR | `npm run verify` (in `packages/polyfill-connectors`) | Typecheck, Biome, library metadata, and the no-await-in-loops, credential-env and condition checks. | |
| Before a PR | `npm test` (root) | Every lane in turn (below). | about 28 min, 16 of them PageShim |

The selector for `test:fast` follows the static import graph and adds every test in the same `connectors/<name>/` directory. Namespace tests run in their own lane. The selector runs the whole sandboxed lane when it cannot trust the graph, for example after a change under `packages/polyfill-connectors/scripts/related-tests/` or a deleted file.

A PR into `main` runs these workflows in `.github/workflows/`. A PR into any other branch runs no CI. Each CI job is its own VM.

1. `polyfill-connectors.yml` runs the `verify` job, six `Test shard` jobs, macOS browser safety, GroupMe mutation and the connector evidence summary. Each `Test shard` job runs `npm test` in `packages/polyfill-connectors` with `TEST_SHARD=<n>/6`.
2. `pageshim.yml` runs four shards, three connector-gate shards and a regressions shard.
3. `connector-artifact-gate.yml` runs six connector build shards.
4. `contract-guardrails.yml` runs the root npm scripts and plain `node --test` steps.
5. `cross-repo-integrity.yml` runs the cross-repo checks.

The `Test shard` jobs run their lanes in the sandbox, and so do the root npm scripts of Contract Guardrails. The `verify` job, the PageShim shards and cross-repo integrity run without it.

The root `npm test` runs these lanes. The index check and `legacy-shapes:check` call `node` directly; the others run in the sandbox.

| Lane | Network | Files | Measured |
|---|---|---|---|
| `connector-implementation-index:check`, `legacy-shapes:check`, `legacy-shapes:test`, `manifest-schema:test`, `cross-repo-integrity:test`, `scripts:test`, `test:tooling` | none | explicit lists in `package.json` | each under 25 s |
| `installer:test` | host (installs packed tarballs from the npm registry) | explicit list | 359 tests, 145 s |
| polyfill `test:sandboxed` | none | every file `packages/polyfill-connectors/scripts/run-tests.mjs` globs, except NAMESPACE_TESTS and EXCLUDED_TESTS (`packages/polyfill-connectors/scripts/test-lanes.mjs`) | 9,995 tests; 416 s at concurrency 4 (the default), 816 s at 2 |
| polyfill `test:namespaces` | host, `--isolate cgroup` (no bwrap, so tests can create their own namespaces) | the five files in NAMESPACE_TESTS, one at a time | 291 tests, 94 s |
| `test:pageshim` | none | the PageShim files listed in the root `test:pageshim` script | 182 tests, 950 s |

`npm run pack-install-run` (network host) is a separate command in `packages/polyfill-connectors`.

## The test sandbox

The lanes above run through `scripts/test-sandbox/test-sandbox`, a vendored copy of the host-wide test governor. `scripts/test-sandbox/README.md` describes it, including what it does on macOS and on GitHub runners. Conformance checks and `npm run verify` call `node` directly.

Each sandboxed run gets a systemd scope under the shared `agent-tests.slice` with 400% CPU, 8 GB and 4096 tasks, one of the host-wide slots, a loopback-only network unless the lane opts out, and a private `/tmp`. Stopping the scope kills every descendant. Each run prints a JSON receipt (wall, CPU, peak memory) on stderr. The receipt names each layer that the host cannot provide and the run skips.

## Test isolation

1. Do not run two suites in one checkout at once. All tests in one run share the checkout, `node_modules`, the Playwright browser cache and the built PageShim bundles, and a few tests write into the checkout (listed below).
2. Each test file gets its own process. node:test uses one child process; Vitest uses an isolated fork, bounded by the same lane concurrency. Module state (PageShim fixture modules with `setLoggedIn`) is per file; tests in one file run one after another.
3. Each test makes its own temp directories (`mkdtemp` under the sandbox's private `/tmp`), local HTTP servers on port 0, iMessage `chat.db` files and PageShim browsers (one Chromium per `runHarness`, about 140 ms to start).
4. The namespaces lane runs one file at a time. Its files share the repository root as global state (`packages/polyfill-connectors/src/scenario/isolation-mechanism.test.ts` plants sockets under it that the isolation scan in `packages/polyfill-connectors/bin/scenario-verify-strict.test.ts` refuses), so they cannot run in parallel. Nothing locks them across two runs in the same checkout.
5. No test calls a provider. Unit lanes have loopback only, and PageShim routes deny every request that no fixture serves. Only `installer:test` (the npm registry), `test:namespaces` and `pack-install-run` use the host network.

These tests write into the checkout.

1. The namespace tests plant and remove sockets under the repository root.
2. PageShim tests build bundles under `.tmp/pageshim/` and `.scratch/`.
3. `packages/polyfill-connectors/bin/connector-dev.test.ts` creates and removes `packages/polyfill-connectors/runs/<id>` and `connectors/<id>/`.
4. `packages/polyfill-connectors/bin/connector-init.test.ts` scaffolds and removes `connectors/zz_init_smoke_<pid>/` and `connectors/zz_init_browser_smoke_<pid>/`. A killed run leaves them, and the manifest tests then fail.
5. `packages/polyfill-connectors/bin/scenario-cli.test.ts` writes fixture connectors under `packages/polyfill-connectors/tmp/`.
6. One consent-time-field test makes a temporary directory inside `node_modules`.

## Rules

1. A fix comes with a test that fails without it. Paste the failing output in the PR.
2. No retries. A test that fails only under load is a bug to fix, not to rerun.
3. Every tracked test file runs in a lane or is listed in `MANUAL` in `scripts/test-lanes-coverage.test.mjs` with a reason. `npm run test:tooling` fails otherwise.
4. A test that needs its own namespaces goes in `NAMESPACE_TESTS`. In the sandboxed lane `namespaceSkip` fails instead of skipping.
5. A connector test that imports from `vitest` must have its repo-relative `connectors/.../*.test.ts` path appended to `VITEST_TESTS` in `packages/polyfill-connectors/scripts/test-lanes.mjs`. The ordinary and related runners dispatch it to pinned Vitest in the same sandbox lane as node:test files, with that lane's worker limit and timeout.
6. Before local package tests that select Vitest files (including the dispatch fixture proof), install the test tools as [AUTHORING.md](AUTHORING.md#before-you-start) says. This private tools package pins Vitest 4.1.12 outside connector artifact inputs. The `verify` and `Test shard` CI jobs install it separately.
7. Do not edit `scripts/test-sandbox/test-sandbox`. Re-vendor it and update its `.sha256`.
