# Polyfill connector scenario tools

Record a connector run, then replay the captured scenario against the connector subprocess. The verifier compares records, cursor state, and captured completeness messages. It does not start the reference implementation or require a pdpp checkout.

Run commands from this package directory with Node 24:

```sh
npm ci --ignore-scripts
node --import tsx bin/scenario-record.ts oura --out runs/oura/scenario.json
node --import tsx bin/scenario-verify.ts oura runs/oura/scenario.json
```

Recording contacts the provider with your configured credentials and captures two runs by default. Add `--runs 1` for one run, `--streams <names>` to select streams, or `--record-har` to capture a local browser context's HAR and storage state. Browser recording requires the package's browser installation. Remote CDP sessions do not support HAR recording.

Replay uses the current connector source. Add `--require-capture-source` to require the source digest recorded at capture time. A mismatch in replayed output or invalid scenario exits nonzero. The printed `recorded_replay` claim has separate eligibility checks: the isolation-evidence claim remains withheld exactly as in [pdpp #274](https://github.com/PDP-Connect/pdpp/pull/274). Passing replay is not certification that the isolation boundary is closed. Browser replay also reports its driver-specific evidence limitations.

Captures default to the ignored `runs/` directory. They contain account data; browser storage-state files retain live session credentials. Keep captures local and review/redact them before sharing, including captures written elsewhere with `--out`.

`src/scenario/verify.ts` documents the reference runtime's state-merge rule but implements it locally. The scenario CLIs only use the path/manifest helpers from `src/orchestrator.ts`; they never call its embedded-server functions. The existing `bin/orchestrate.ts` remains dependent on the external reference implementation and outside this repository's local test/typecheck coverage.

Validation:

```sh
npm run verify
node scripts/run-tests.mjs
node --test --import tsx bin/scenario-verify-strict.test.ts src/scenario/isolation-mechanism.test.ts
```

The test runner discovers both `bin/**/*.test.ts` and `src/**/*.test.ts`. CI retains its 10-minute verify budget. This port is tracked by [pdpp #337](https://github.com/PDP-Connect/pdpp/issues/337).
