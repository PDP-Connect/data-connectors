# Build a connector

This page takes you from an empty directory to a connector PR that a maintainer can review. A connector lives in `connectors/<key>/` with its code, `manifest.json`, icon, tests and fixtures.

The maintainer who reviews your PR does not have your account and cannot run your connector. So the PR carries two kinds of evidence. The first is a replay claim, a small file that says your code replayed a run recorded from your own account and produced the same output. The second is a `conformance` report with no open failures.

The rules behind each step are in [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md). The contract for manifests and messages is the [Collection Profile](docs/spec/collection-profile.md).

## Before you start

1. Install Node.js 24.15 or a later 24.x release, and npm. Then install the dependencies from the repository root. Run every command on this page from the root.

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

3. List what the platform holds, from its API reference or its data export. A connector emits records in streams, one stream per kind of record, such as `orders` or `messages`. Your streams cover what a user expects to find. Add `account_profile`, `account_plan` or `usage_summary` streams where the platform has that data, and keep the fields the API returns unless you have a reason to drop them.

## Steps

1. Scaffold the connector. The key and the stream names use lowercase snake_case. Add `--browser` for a browser connector.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-init.ts <key> --display-name "<Name>" --stream <stream>
   ```

   The command creates `connectors/<key>/` and refuses to overwrite a path that exists. It leaves a `TODO` for each stream description and for the request to the platform. A browser scaffold also leaves one for navigation and extraction. Fill in each `TODO`.

   Where the package already does a job, use its helper instead of your own code. For example, `createConnectorHttpGovernor` paces requests and handles rate limits, and `buildFullScanCoverageMessage` reports coverage for a stream that reads everything on each run. They are in `packages/polyfill-connectors/src/connector-http-governor.ts` and `packages/polyfill-connectors/src/connector-runtime.ts`.

2. Give the connector its inputs, then run it against your account.

   The tools on this page read inputs from the environment and from `.env.local` at the repository root. Put each value there once, and every step uses it. Git ignores `.env.local`; never commit it.

   | Input | Where to declare it | Example |
   |---|---|---|
   | A secret (token, key, password) | `auth.required` in the `runConnector` call in `index.ts` | `STEAM_API_KEY` in `connectors/steam/index.ts` |
   | A setting that is not secret and that the connector needs (user ID, server URL) | Read `process.env` in the connector. Keep it out of `auth.required`, which would prompt the user for it as a credential | `STEAM_USER_ID` in `connectors/steam/index.ts` |
   | An option the user can change (lookback, include list) | `options_schema` in the manifest, read with `readOptions` | `connectors/claude_code/manifest.json` |

   An API scaffold declares one token, `<KEY>_API_TOKEN`. If the platform needs no credentials, delete the `auth` entry from `index.ts` and from the manifest's `capabilities`. A browser scaffold declares none; the user signs in to the browser. [Connector options](packages/polyfill-connectors/docs/connector-authoring-guide.md#connector-options) describes `options_schema` and `readOptions`.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-dev.ts <key>
   ```

   The command prints each record and progress message as the connector emits them. Fix the connector until a run ends without an error and the records hold what you expect. This output holds your account data, so keep it on your machine.

3. Record a scenario. The command runs the connector twice against your account. The first run starts from empty state, and the second starts from the state the first run saved.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-record.ts <key>
   ```

   It prints the path of the scenario file, under `packages/polyfill-connectors/runs/<key>/`. The scenario holds your account data and stays on your machine. For a browser connector, add `--record-har`. It also saves the HTTP archive (HAR) and the browser's storage state, and without them a browser scenario cannot replay.

4. Replay the scenario against your code.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path>
   ```

   A pass prints `streams exercised: <n> of <m> declared` and names each declared stream the scenario did not reach. Copy that line into your PR.

   Replay gives the connector the clock values recorded during capture, in the order it reads them. If replay reads the clock a different number of times, a time read late in the run gets a different value, and a `STATE` that holds it fails with a `final_state` mismatch. So put `emittedAt`, which `collect()` receives and which is read once per run, in `STATE` instead of `nowIso()` or `Date.now()`.

   If your connector reads everything on each run, the second run repeats the first, and the verifier prints that it did not see incremental behavior. That is expected; say so in the PR.

5. Write the claim.

   ```bash
   mkdir -p connectors/<key>/evidence
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path> --json connectors/<key>/evidence/claim.json
   ```

   1. Commit `claim.json`, and nothing else from steps 3 to 5. It holds digests and timestamps, not account data.
   2. After each change to the code or the manifest, do steps 3 to 5 again. A claim from older code reads as stale.
   3. If the verifier cannot write the file, it prints a warning and still exits with the replay's result. Check that `verified_at` in the claim is the time of this run.

   [Scenario replay evidence](packages/polyfill-connectors/docs/connector-authoring-guide.md#92-scenario-replay-evidence-claimjson) describes each field.

6. Run the conformance report.

   ```bash
   npm run conformance -- <key>
   ```

   The report has one line per check, and each check line starts with a mark.

   | Mark | Meaning | What you do |
   |---|---|---|
   | `✔` | pass | Nothing |
   | `✖` | fail | Fix it |
   | `?` | unknown | Fix it. A connector that makes no HTTP requests keeps `?` on `mock mutation`; say so in the PR |
   | `⚠` | weak | Fix it, or give the reason it does not apply in the PR |
   | `·` | advisory | Fix it, or give the reason it does not apply in the PR |

   The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) explains each check and what each tier needs.

7. Open the PR. Set the version in `manifest.json` to `0.1.0` and the tier to `development`, then run `npm run connector-implementation-index:generate` and commit `connector-implementation-index.json`. The description states:

   1. What the connector collects.
   2. What it leaves out, and why.
   3. How you tested it, with the `streams exercised` line from step 4.
   4. Each `conformance` line you left open, with its reason.

   Describe the connector, not the tools that helped you write it. On the PR, the "Connector evidence summary" job runs `conformance` with `--static`, which skips the tests and the mock-mutation check, so run the full report locally.

## Change an existing connector

Make the change, then do steps 2 to 6 for that connector. A change to the code or the manifest needs a higher version in `manifest.json`; [docs/publishing.md](docs/publishing.md) gives the rule.
