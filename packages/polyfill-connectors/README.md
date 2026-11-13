# Polyfill connector scenario tools

Reference for the two commands that record a connector run and replay it. The command sequence for building a connector is in [AUTHORING.md](../../AUTHORING.md). The replay verifier compares records, cursor state and captured completeness messages against the connector subprocess. It starts no reference server.

Run the commands from `packages/polyfill-connectors` with Node 24 after `npm ci --ignore-scripts` in the repo root:

```sh
node --import tsx bin/scenario-record.ts oura --out runs/oura/scenario.json
node --import tsx bin/scenario-verify.ts oura runs/oura/scenario.json
```

## scenario-record

Recording contacts the provider with your configured credentials. It captures two runs by default: a full refresh, then an incremental run seeded with the first run's committed state.

| Option | Effect |
|---|---|
| `--runs 1` | Capture only the first run. |
| `--out <path>` | Write the scenario file to `<path>`. The default is `runs/<connector>/<iso>-scenario.json`. |
| `--streams <names>` | Capture only the comma-separated streams. |
| `--answer <id-or-index>=<value>`, `--answers <json-file>` | Answer connector prompts without a terminal. |
| `--persist-otp` | Store one-time-code answers in the scenario. |
| `--timeout <seconds>` | Set the inactivity limit. The recorder kills a connector subprocess that is silent for that long. |
| `--record-har` | Capture the HAR and storage state of a local browser context. Browser recording needs the package's browser installation. |

With `PDPP_<NAME>_REMOTE_CDP_URL` set, `--record-har` records the attached browser. The recording covers the whole attached browser context, including traffic and cookies from tabs the connector did not open. Attach a dedicated browser or profile that is signed in to a test account.

With an attached browser under load, the HAR can miss the first navigation of a popup. A missing popup request alone does not show a connector defect.

Captures go to the git-ignored `runs/` directory. They contain account data, and storage-state files hold live session credentials. Keep captures local and redact them before sharing, including captures written elsewhere with `--out`.

## scenario-verify

Replay uses the current connector source.

| Option | Effect |
|---|---|
| `--require-capture-source` | Require the source and declaration digests recorded at capture time to match. |
| `--json <path>` | Write the claim record to `<path>`. The directory must exist. |

A mismatch in replayed output, or an invalid scenario, exits with a nonzero code. The printed `recorded_replay` claim has its own eligibility checks, and no driver earns it, because the isolation-evidence boundary is not proven (`isolationEvidenceBoundaryProven` is `false` in `bin/scenario-verify.ts`). A passing replay therefore does not certify that the isolation boundary is closed. Browser replay also reports the evidence limits of its driver.

`src/scenario/verify.ts` implements the runtime's state-merge rule locally. The scenario commands use only the path and manifest helpers of `src/orchestrator.ts`.

## Validate changes to the tools

Run these from `packages/polyfill-connectors`:

```sh
npm run verify
npm test
```

`npm test` runs the sandboxed lane and the namespaces lane. [TESTING.md](../../TESTING.md) describes both lanes and the faster `npm run test:fast`.
