# Build a connector

This page takes you from an empty directory to a connector PR that a maintainer can review. A connector lives in `connectors/<key>/` with its code, `manifest.json`, icon, tests and fixtures. The maintainer who reviews your PR does not have your account and cannot run your connector, so the PR carries the proof: a replay claim recorded from your own account, and a `conformance` report with no open failures.

The rules behind each step are in [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md). The contract for manifests and messages is the [Collection Profile](docs/spec/collection-profile.md).

## Before you start

1. Install the dependencies from the repository root. Run every command on this page from the root.

   ```bash
   npm ci
   npm ci --ignore-scripts --prefix packages/polyfill-connectors/test-tools
   ```

   npm can warn that it blocked install scripts for some packages. The steps on this page do not need them.

2. Choose the existing connector closest to yours, and read it before you write code.

   | Your source | Start from |
   |---|---|
   | An API with a token or key, or with no credentials | `connectors/steam/` |
   | A server the user hosts, at a URL they give | `connectors/jellyfin/` |
   | A website that needs a signed-in browser | `connectors/chatgpt/` |
   | A file the user exports and imports | `connectors/apple_health/` |

3. List what the platform holds, from its API reference or its data export. Your streams cover what a user expects to find. Add `account_profile`, `account_plan` or `usage_summary` streams where the platform has that data, and keep the fields the API returns unless you have a reason to drop them.

## Steps

1. Scaffold the connector. The key and the stream names use lowercase snake_case. Add `--browser` for a browser connector.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-init.ts <key> --display-name "<Name>" --stream <stream>
   ```

   The command creates `connectors/<key>/` and refuses to overwrite a path that exists. Fill in each `TODO` it leaves: stream descriptions, the request to the platform and, for `--browser`, navigation and extraction. Use the shared helpers in `packages/polyfill-connectors/src/` for work they already do, for example `createConnectorHttpGovernor` for rate limits and `buildFullScanCoverageMessage` for coverage.

2. Give the connector its inputs, then run it against your account.

   The tools on this page read inputs from the environment and from `.env.local` at the repository root. Put each value there once, and every step uses it. Never commit `.env.local`.

   | Input | Where to declare it | Example |
   |---|---|---|
   | A secret (token, key, password) | `auth.required` in the `runConnector` call in `index.ts` | `STEAM_API_KEY` in `connectors/steam/index.ts` |
   | A setting that is not secret and that the connector needs (user ID, server URL) | Read `process.env` in the connector. Keep it out of `auth.required`, which would prompt the user for it as a credential | `STEAM_USER_ID` in `connectors/steam/index.ts` |
   | An option the user can change (lookback, include list) | `options_schema` in the manifest, read with `readOptions` | `connectors/claude_code/manifest.json` |

   The scaffold declares one token, `<KEY>_API_TOKEN`. If the platform needs no credentials, delete the `auth` entry from `index.ts` and from the manifest's `capabilities`. [Connector options](packages/polyfill-connectors/docs/connector-authoring-guide.md#connector-options) describes `options_schema` and `readOptions`.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-dev.ts <key>
   ```

   The command prints each record and progress message as the connector emits them. Fix the connector until a run ends without an error and the records hold what you expect. This output holds your account data, so keep it on your machine.

3. Record a scenario. The command runs the connector twice against your account: once from empty state, and once from the state the first run saved.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-record.ts <key>
   ```

   It prints the path of the scenario file, under `packages/polyfill-connectors/runs/<key>/`. The scenario holds your account data and stays on your machine. For a browser connector, add `--record-har`; without the HAR and storage-state files it writes, the scenario cannot replay.

4. Replay the scenario against your code.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path>
   ```

   A pass prints `streams exercised: <n> of <m> declared` and names each declared stream the scenario did not reach. Copy that line into your PR. Replay runs on a faster clock than the recording, so state that holds the current time differs between the two and fails the replay. Put the run's `emittedAt` in `STATE`, not `nowIso()`.

   If your connector reads everything on each run, the second run repeats the first, and the verifier prints that it did not see incremental behavior. That is expected; say so in the PR.

5. Write the claim. The claim records that this code replayed your scenario, and it holds no account data.

   ```bash
   mkdir -p connectors/<key>/evidence
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path> --json connectors/<key>/evidence/claim.json
   ```

   Commit `claim.json`, and nothing else from steps 3 to 5. After each change to the code or the manifest, do steps 3 to 5 again: a claim from older code reads as stale. If the verifier cannot write the file, it prints a warning and keeps the replay's exit code, so check the `verified_at` time in the claim. [Scenario replay evidence](packages/polyfill-connectors/docs/connector-authoring-guide.md#92-scenario-replay-evidence-claimjson) describes each field.

6. Run the conformance report.

   ```bash
   npm run conformance -- <key>
   ```

   Each line starts with a mark: `✔` pass, `⚠` weak, `·` advisory, `✖` fail, `?` unknown. Fix every `✖` and `?` line. Fix each `⚠` and `·` line, or give the reason it does not apply in the PR. A connector that makes no HTTP requests keeps `?` on `mock mutation`; say so in the PR. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) explains each step of the report and what each tier needs.

7. Open the PR. Set the version in `manifest.json` to `0.1.0` and the tier to `development`. The description states:

   1. What the connector collects.
   2. What it leaves out, and why.
   3. How you tested it, with the `streams exercised` line from step 4.
   4. Each `conformance` line you left open, with its reason.

   Describe the connector, not the tools that helped you write it. CI runs the same report in the "Connector evidence summary" job. A maintainer reviews the PR with [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md); read it before you open the PR.

## Change an existing connector

Make the change, then do steps 2 to 6 for that connector. A change to the code or the manifest needs a higher version in `manifest.json`; [docs/publishing.md](docs/publishing.md) gives the rule.
