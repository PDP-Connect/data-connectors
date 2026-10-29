# Testing data-connectors

Every local test command runs through `scripts/test-sandbox/test-sandbox`, a vendored copy of the host-wide test governor (see `scripts/test-sandbox/README.md`). It gives each run a systemd scope under the shared `agent-tests.slice` with 400% CPU, 8 GB and 4096 tasks, one of the host-wide slots, a loopback-only network unless the lane opts out, and a private `/tmp`. Stopping the scope kills every descendant. Each run prints a JSON receipt (wall, CPU, peak memory) on stderr. Each layer it cannot use on a host is skipped and named in the receipt; see `scripts/test-sandbox/README.md` for what that means on macOS and on GitHub runners.

## Tiers

| When | Command | What runs | Measured (a 24-core Linux host) |
|---|---|---|---|
| While editing | `npm run test:fast` (root or packages/polyfill-connectors) | Tests related to files changed since `git merge-base HEAD origin/main`, plus uncommitted and untracked files: the static import graph, plus every test in the same `connectors/<name>/` directory. Namespace tests run in their own lane. When the selector cannot trust the graph (for example a change under `scripts/related-tests/` or a deleted file), it runs the whole sandboxed lane. | one-connector edit: 42 tests, 4-10 s |
| Same, against any base | `npm run test:related -- <base>` (in packages/polyfill-connectors) | Same selection; on FULL_SUITE it runs both polyfill lanes. | |
| Before a PR | `npm test` (root) | Every lane in turn (below). | about 28 min, 16 of them PageShim |
| PR into main | GitHub Actions | `verify + test`, PageShim shards, connector shards, Contract Guardrails, cross-repo integrity. PRs into other branches run no CI. `verify + test` runs its lanes in the sandbox with cgroup limits and network isolation, and Contract Guardrails with cgroup limits only; the PageShim and connector shards and cross-repo integrity run without it (each CI job is its own VM). | `verify + test` Test step 699 s (was 15-18 min at concurrency 2); PageShim shards 588 s and 835 s |

The root `npm test` runs these lanes, each in its own sandbox:

| Lane | Network | Files | Measured |
|---|---|---|---|
| `connector-implementation-index:check`, `manifest-schema:test`, `cross-repo-integrity:test`, `scripts:test`, `test:tooling` | none | explicit lists in package.json | each under 25 s |
| `installer:test` | host (installs packed tarballs from the npm registry) | explicit list | 359 tests, 145 s |
| polyfill `test:sandboxed` | none | every file `scripts/run-tests.mjs` globs, except NAMESPACE_TESTS and EXCLUDED_TESTS (`scripts/test-lanes.mjs`) | 9,995 tests; 416 s at concurrency 4 (the default), 816 s at 2 |
| polyfill `test:namespaces` | host, `--isolate cgroup` (no bwrap, so tests can create their own namespaces) | the five scenario-isolation files in NAMESPACE_TESTS, one at a time | 291 tests, 94 s |
| `test:pageshim` | none | the files the two PageShim CI shards run | 182 tests, 950 s |

`npm run pack-install-run` (network: host) and `npm run verify` (typecheck, biome, conformance checks) are separate commands in packages/polyfill-connectors; run `verify` before every PR.

## What is shared, per-worker, per-test, locked

- Shared: the checkout, `node_modules`, the Playwright browser cache, the built PageShim bundles of one run. Tests write into the checkout in a few places: the namespace tests plant and remove sockets under the repository root (see below); PageShim tests build bundles under `.tmp/pageshim/` and `.scratch/`; `bin/connector-dev.test.ts` creates and removes `packages/polyfill-connectors/runs/<id>` and `connectors/<id>/`; `bin/connector-init.test.ts` scaffolds and removes `connectors/zz_init_smoke_<pid>/` and `connectors/zz_init_browser_smoke_<pid>/` (a killed run leaves them, and the manifest tests then fail); `bin/scenario-cli.test.ts` writes fixture connectors under `packages/polyfill-connectors/tmp/`; and one consent-time-field test makes a temporary directory inside `node_modules`. Do not run two suites in one checkout at once.
- Per test file: node:test uses one child process; Vitest uses an isolated fork, bounded by the same lane concurrency. Module state (PageShim fixture modules with `setLoggedIn`) is per file; tests in one file run one after another.
- Per test: temp directories (`mkdtemp` under the sandbox's private `/tmp`), local HTTP servers on port 0, iMessage `chat.db` files, PageShim browsers (one Chromium per `runHarness`, about 140 ms to start).
- Locked (serial): the namespaces lane. Its files share the repository root as global state (`isolation-mechanism.test.ts` plants sockets under it that `scenario-verify-strict.test.ts`'s isolation scan refuses), so one run executes them one at a time. Nothing locks them across two runs in the same checkout.
- Never shared: the network. Unit lanes have loopback only; PageShim routes deny every request that no fixture serves.

## Rules

- A fix comes with a test that fails without it. Paste the failing output in the PR.
- No retries. A test that fails only under load is a bug to fix, not to rerun.
- Every tracked test file runs in a lane or is listed in `MANUAL` in `scripts/test-lanes-coverage.test.mjs` with a reason; `test:tooling` fails otherwise.
- A test that needs its own namespaces goes in `NAMESPACE_TESTS`; in the sandboxed lane `namespaceSkip` fails instead of skipping.
- A connector test that imports from `vitest` must have its repo-relative `connectors/.../*.test.ts` path appended to `VITEST_TESTS` in `packages/polyfill-connectors/scripts/test-lanes.mjs`. The ordinary and related runners dispatch it to pinned Vitest in the same sandbox lane as node:test files, with that lane's worker limit and timeout.
- Before local package tests that select Vitest files (including the dispatch fixture proof), run `npm ci --prefix packages/polyfill-connectors/test-tools` from the repo root. This private tools package pins Vitest 4.1.12 outside connector artifact inputs; the polyfill CI job installs and caches it separately. The dispatcher names this install command if the package is missing.
- Do not edit `scripts/test-sandbox/test-sandbox`; re-vendor it and update its `.sha256`.

## Gap to excellence

The exemplar practices come from the published testing practice of large projects (Kubernetes, Google, CPython, Django, Shopify, SQLite and others).

| Exemplar practice | Here | Number | State |
|---|---|---|---|
| Fast pre-merge tier in seconds (Google presubmit, OpenJDK tier1) | `test:fast` | 4-10 s for a one-connector edit, against 1,265 s for the whole package suite | closed |
| Select by change, keep a full-run backstop (Shopify, Meta) | `test:fast` plus full CI on every PR into main | recall not measured | partly open |
| Test the integrated candidate (bors, Tide) | batch PR from the integration branch into main runs full CI | no merge queue | partly open |
| Ban automatic retries (Kubernetes) | no retries configured | 0 | closed |
| Flakes owned and tracked (Go watchflakes, Chromium) | fixed the one known load flake ("REPLAY TIME SCALING"); no tracker or quarantine owner | | open |
| Regression test per fix (Django, TypeScript, Bun) | rule above and in AGENTS.md | | closed |
| Test the tests (CPython discovery count, SQLite) | runner contract, NAMESPACE_TESTS guard, lane-coverage guard, vendored-hash check | 2 orphan test files found and put in lanes | closed |
| Hermetic runs under a host budget | `test-sandbox` on every lane | | closed |
| Security isolation tested in CI | `verify + test` lifts the runner's namespace restriction and fails if namespaces stay unavailable | CI skipped 96 tests before, 48 after | closed |
| Seeded randomized testing (Dropbox, Zed) | none; no randomized generators in use | | open, not needed yet |
| Sampled mutation testing | GroupMe Stryker pilot PRs | | open (other owner) |
| Coverage ratchet | none | | not adopted (contested practice) |
| Published cost per tier | this file | | closed |
