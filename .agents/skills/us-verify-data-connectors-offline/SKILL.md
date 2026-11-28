---
name: us-verify-data-connectors-offline
description: Verify Data Connectors with the real scenario record and replay CLIs, a two-run synthetic cursor fixture and a tampered-record control. Use after changes to the replay, conformance or PageShim tooling.
---

# Verify Data Connectors offline

Start here when you need evidence from a disposable checkout without signing in. The default proof drives the two scenario CLIs against the repository's synthetic provider. Read the [feature map](features/README.md) for the focused PageShim and conformance recipes.

## Launch

Use a dedicated Git worktree with no local credential file. Run from its root with Node 24.15 or later 24.x. Restore the locked dependencies from your local cache if they are missing.

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm ci --offline --ignore-scripts --no-audit --no-fund --prefix packages/polyfill-connectors/test-tools
```

An offline cache miss blocks setup until you can provide the locked dependencies. The default proof needs no browser, account, display or persistent process.

## Doctor

```sh
node .agents/skills/us-verify-data-connectors-offline/run.mjs --doctor
```

Require exit 0 and `Ready`. The command checks the Node version, test dependency resolution, fixture path and absence of local credential files. The actual run establishes that the permitted loopback socket can bind.

## Drive

```sh
proof_parent="$(mktemp -d)"
node .agents/skills/us-verify-data-connectors-offline/run.mjs "$proof_parent/proof"
```

The runner selects the exact scenario CLI test. Its child provider listens on `127.0.0.1` only while recording two synthetic runs. The fixture proves the first run emits items 1 through 3 and the second uses the saved cursor to emit item 4. The provider stops before both runs replay. Changing the first fixture payload must produce a nonzero verifier exit and a `record_hash` mismatch.

## Evidence

Require exit 0 and `status: "passed"` in the new `result.json`. The receipt records the revision and dirty-worktree state, both replay runs, three replayed interactions, the tamper mismatch and the isolation the CLI reported. `scenario.tap` retains the original recording and verification diagnostics, and `scenario.stderr` retains subprocess diagnostics. Keep these machine-local and outside Git.

The recording CLI opens a real socket to the synthetic provider and reports `loopback_only=true`. During replay, process-local isolation redirects the Node fixture's fetch calls into the scenario matcher. When the owner reports `os-namespace`, the replay has an additional OS network boundary. The proof earns diagnostic replay and withholds recorded replay because it cannot establish that stronger evidence boundary. It uses no real provider or account.

## Cleanup

The fixture closes its own provider and deletes its synthetic scenario. The runner removes its own scratch directory and checks that it is gone before writing a passing receipt. It preserves the proof directory and files. Keep one test suite at a time per worktree. An interrupted run needs a fresh proof directory on retry.

The executable helper is [run.mjs](run.mjs). Maintenance routes to pstack `maintain-verification-skill` after tooling or fixture changes.
