# Polyfill connector scenario tools

Reference for the two commands that record a connector run and replay it. The steps to build a connector are in [AUTHORING.md](../../AUTHORING.md). The replay verifier runs the connector again and compares its records, its cursor state and the coverage reports it sent against the recorded run.

Install the dependencies as [AUTHORING.md](../../AUTHORING.md#before-you-start) says. Then run the commands from `packages/polyfill-connectors`.

```sh
node --import tsx bin/scenario-record.ts oura --out runs/oura/scenario.json
node --import tsx bin/scenario-verify.ts oura runs/oura/scenario.json
```

## scenario-record

Recording contacts the provider with your configured credentials. It captures two runs by default. The first is a full refresh. The second is an incremental run that starts from the state the first run committed.

| Option | Effect |
|---|---|
| `--runs 1` | Capture only the first run. |
| `--out <path>` | Write the scenario file to `<path>`. The default is `runs/<connector>/<iso>-scenario.json`. |
| `--streams <names>` | Capture only the comma-separated streams. |
| `--answer <id-or-index>=<value>`, `--answers <json-file>` | Answer connector prompts without a terminal. |
| `--persist-otp` | Store one-time-code answers in the scenario. |
| `--timeout <seconds>` | Set the inactivity limit. The recorder kills a connector subprocess that is silent for that long. |
| `--record-har` | Capture the HAR and storage state of a local browser context. Browser recording needs the Playwright browsers installed (`npx playwright install chromium`). |

With `PDPP_<NAME>_REMOTE_CDP_URL` set, `--record-har` records the attached browser. The recording covers the whole attached browser context, including traffic and cookies from tabs the connector did not open. Attach a dedicated browser or profile that is signed in to a test account.

With an attached browser under load, the HAR can miss the first navigation of a popup. A missing popup request alone does not show a connector defect.

Captures go to the git-ignored `runs/` directory. They contain account data, and storage-state files hold live session credentials. Keep captures local and redact them before sharing, including captures written elsewhere with `--out`.

## scenario-verify

Replay uses the current connector source.

| Option | Effect |
|---|---|
| `--require-capture-source` | Require the source and declaration digests recorded at capture time to match. |
| `--json <path>` | Write the claim record to `<path>`. The directory must exist. |

A passing replay does not prove that the sandbox around the replay isolates the connector. The tool does not treat that isolation boundary as proven, so no driver earns the printed `recorded_replay` claim (`isolationEvidenceBoundaryProven` is `false` in `bin/scenario-verify.ts`). Browser replay also reports the evidence limits of its driver.

A mismatch in replayed output, or an invalid scenario, exits with a nonzero code.

## Validate changes to the tools

Run these from `packages/polyfill-connectors`:

```sh
npm run verify
npm test
```

[TESTING.md](../../TESTING.md) describes what these commands run, and the faster `npm run test:fast`.
