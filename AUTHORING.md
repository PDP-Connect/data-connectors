# Build a connector

This page takes you from an empty directory to a connector PR that a maintainer can review. A connector lives in `connectors/<key>/` with its code, `manifest.json`, icon, tests and fixtures.

The maintainer who reviews your PR does not have your account and cannot run your connector. So the PR carries two kinds of evidence. The first is a replay claim, a small file that says your code replayed a run recorded from your own account and produced the same output. The second is a `conformance` report with no open failures.

The rules behind each step are in the [connector authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md). The contract for manifests and messages is the [Collection Profile](docs/spec/collection-profile.md).

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

1. Scaffold the connector. The key and the stream names use lowercase snake_case. Add `--browser` for a browser connector, and read the [browser connector guidelines](CONNECTOR-GUIDELINES.md) before you write one.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-init.ts <key> --display-name "<Name>" --stream <stream>
   ```

   The command creates `connectors/<key>/` and refuses to overwrite a path that exists. It leaves a `TODO` for each stream description and for the request to the platform, and a browser scaffold also leaves one for navigation and extraction. Fill in each `TODO`.

   Where the package already does a job, use its helper instead of your own code. For example, `createConnectorHttpGovernor` paces requests and handles rate limits, and `buildFullScanCoverageMessage` reports coverage for a stream that reads everything on each run. They are in `packages/polyfill-connectors/src/connector-http-governor.ts` and `packages/polyfill-connectors/src/connector-runtime.ts`.

2. Define each stream in `manifest.json`. The scaffold writes one stream with defaults that you must check.

   1. Set `primary_key` to the field that identifies a record, and `cursor_field` to the field a later run continues from. Remove `cursor_field` and set `incremental` to `false` if each run reads everything.
   2. Set `semantics` to `append_only` for events that never change or disappear, such as plays or payments, and to `mutable_state` for anything the user can edit or delete.
   3. Set `consent_time_field` to the record's own time, such as when it was sent or played. A user can share a time range of a stream only through this field, so leave it out only for records that have no time.
   4. Keep `query.search` and `query.aggregations` only for fields the stream really has, because the scaffold declares search on a `title` field.
   5. Set `coverage_strategy` from the table below. It says what a run must report to show that it read the whole stream.
   6. Set `freshness_strategy` from the second table below. It says what sets the time the data is current as of.

   | Your stream | `coverage_strategy` |
   |---|---|
   | Continues from a saved cursor | `checkpoint_window` |
   | Reads everything on each run | `full_inventory` |
   | Holds one record, such as a profile | `singleton_presence` |
   | Comes from a file the user imports | `snapshot_import_receipt` |
   | Holds detail rows read under a parent stream | `parent_detail_accounting` |

   | What sets the time | `freshness_strategy` |
   |---|---|
   | The app runs the connector on a schedule | `scheduled_window` |
   | A person starts each run or imports a file | `manual_as_of` |
   | The platform reports an "as of" time with the data | `source_reported_as_of` |
   | Contact with the user's own device sets the time | `device_heartbeat` |
   | Nothing gives a useful time | `not_trackable` |

   To add another stream, copy the stream entry in `manifest.json`, then add its schema in `schemas.ts` and a pilot record file at `connectors/<key>/fixtures/scrubbed/pilot-real-shape/records/<stream>.jsonl`. Pilot rows are synthetic, with the field formats of real records; never put real account rows there.

3. Choose the refresh policy in `capabilities.refresh_policy`. The app reads it to decide whether to run the connector on a schedule, and it rejects a manifest whose fields contradict each other, so answer these questions in order.

   1. Can a run need a person? Set `interaction_posture` to `none` if the connector uses a stored token or needs no credentials. Set it to `credentials` if the connector signs in with a stored user name and password, such as an app password, and sign-in never asks for more. Set it to `manual_action_likely` if a sign-in page or a bot check can stop a run until a person acts, and to `otp_likely` if sign-in often asks for a one-time code.
   2. Is it safe to run with nobody at the screen? It is when a run cannot stop for a person and its requests stay inside the platform's limits, which the intervals below control. Set `background_safe` to `true` only then.
   3. Should the app schedule runs by default? `recommended_mode` follows from the first two answers, as the table shows.

   | `interaction_posture` | `background_safe` | `recommended_mode` | Also required |
   |---|---|---|---|
   | `none` or `credentials` | `true` | `automatic` | Nothing |
   | `manual_action_likely` or `otp_likely` | `false` | `manual` | Nothing |
   | `manual_action_likely` or `otp_likely` | `true` | `automatic` | `assisted_after_owner_auth: true`. A scheduled run reuses the session saved after the user signed in, and asks the user for help if the site challenges it again |

   The app rejects `none` or `credentials` with `background_safe: false`. For those postures, control the request rate with the intervals below, and make them long if you are not sure of the platform's limits.

   1. `minimum_interval_seconds` is the shortest interval the platform's published or measured rate limits allow.
   2. `recommended_interval_seconds` is the default time between scheduled runs. It must be at least the minimum. The app warns a user who sets a shorter interval than either one.
   3. `maximum_staleness_seconds` is the data age after which the data counts as stale. Make it longer than the recommended interval.
   4. `rate_limit_sensitivity` and `bot_detection_sensitivity` (`low`, `medium` or `high`) say how quickly the platform limits or blocks frequent requests. The app does not read them yet; set them for the reviewer.
   5. `rationale` gives your reasons in one or two sentences, and must not be empty.

4. Give the connector its inputs, then run it against your account.

   The tools on this page read inputs from the environment and from `.env.local` at the repository root. Put each value there once, and every step uses it. Git ignores `.env.local`; never commit it.

   | Input | Where to declare it | Example |
   |---|---|---|
   | A secret (token, key, password) | `auth.required` in the `runConnector` call in `index.ts`, and `capabilities.auth.required` in the manifest | `STEAM_API_KEY` in `connectors/steam/` |
   | A setting that is not secret and that the connector needs (user ID, server URL) | Read `process.env` in the connector. Keep it out of `auth.required`, which would prompt the user for it as a credential | `STEAM_USER_ID` in `connectors/steam/index.ts`, `JELLYFIN_BASE_URL` in `connectors/jellyfin/index.ts` |
   | An option the user can change (lookback, include list) | `options_schema` in the manifest, read with `readOptions` | `connectors/claude_code/manifest.json` |

   1. An API scaffold declares one token, `<KEY>_API_TOKEN`. Rename it to the platform's own term in both places.
   2. If the platform needs no credentials, delete the `auth` entry from the `runConnector` call in `index.ts` and from the manifest's `capabilities`. Otherwise each run asks the user for a token that does not exist, then fails.
   3. A browser scaffold declares no token, because the user signs in to the browser.

   [Connector options](packages/polyfill-connectors/docs/connector-authoring-guide.md#connector-options) describes `options_schema` and `readOptions`. When the inputs are in place, run the connector.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/connector-dev.ts <key>
   ```

   The command prints each record and progress message as the connector emits them. Fix the connector until a run ends without an error and the records hold what you expect. This output holds your account data, so keep it on your machine.

5. Record a scenario. The command runs the connector twice against your account. The first run starts from empty state, and the second starts from the state the first run saved.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-record.ts <key>
   ```

   It prints the path of the scenario file, under `packages/polyfill-connectors/runs/<key>/`. The scenario holds your account data and stays on your machine. For a browser connector, add `--record-har`. It also saves the HTTP archive (HAR) and the browser's storage state, and without them a browser scenario cannot replay.

6. Replay the scenario against your code.

   ```bash
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path>
   ```

   A pass prints `streams exercised: <n> of <m> declared` and names each declared stream the scenario did not reach. Copy that line into your PR.

   Put `emittedAt`, which `collect()` receives, in `STATE` instead of `nowIso()` or `Date.now()`. Replay gives the connector the clock values recorded during capture, in the order it reads them. If replay reads the clock a different number of times, a time read late in the run gets a different value, and a `STATE` that holds it fails with a `final_state` mismatch. `emittedAt` is read once per run, so it always matches.

   If your connector reads everything on each run, the second run repeats the first, and the verifier prints that it did not see incremental behavior. That is expected; say so in the PR.

7. Write the claim.

   ```bash
   mkdir -p connectors/<key>/evidence
   node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path> --json connectors/<key>/evidence/claim.json
   ```

   1. Commit `claim.json`, and nothing else from steps 5 to 7. It holds digests and timestamps, not account data.
   2. After each change to the code or the manifest, do steps 5 to 7 again. A claim from older code reads as stale.
   3. If the verifier cannot write the file, it prints a warning and still exits with the replay's result. Check that `verified_at` in the claim is the time of this run.

   [Scenario replay evidence](packages/polyfill-connectors/docs/connector-authoring-guide.md#92-scenario-replay-evidence-claimjson) describes each field.

8. Run the conformance report.

   ```bash
   npm run conformance -- <key>
   ```

   The report has one line per check, and each check line starts with a mark.

   | Mark | Meaning | What you do |
   |---|---|---|
   | `✔` | pass | Nothing |
   | `✖` | fail | Fix it |
   | `?` | unknown | Fix it. A connector that makes no HTTP requests keeps `?` on `mock mutation`; say why in its header comment and in the PR |
   | `⚠` | weak | Fix it, or give the reason it does not apply in the PR |
   | `·` | advisory | Fix it, or give the reason it does not apply in the PR |

   The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) explains each check and what each tier needs.

9. Register the connector in the shared files. A new connector also changes these files outside its directory.

   1. Add `brand` to the manifest, with an `icon.svg` in the connector directory that is the platform's real mark (`connectors/character_ai/` is an example). If the platform has no mark you can use, leave `brand` out and add the manifest name to `CONNECTORS_WITHOUT_A_BRAND_MARK` in `scripts/brand-icon-fleet.test.mjs`.
   2. Add `["<key>", "<public-key>"]` to `CONNECTOR_PUBLISH_INVENTORY` in `scripts/connector-publish-allowlist.mjs`. The public key is the directory name with hyphens in place of underscores. Add a third item, the reason, only if the connector cannot be published yet.
   3. Add a coverage driver to `connectors/_conformance/coverage-conformance-drivers.ts`.
   4. Run `npm run connector-implementation-index:generate` and commit `connector-implementation-index.json`.

   Then run `npm test`. It fails until the brand, the publish entry and the index are done, and each failing test names the file to change.

10. Open the PR. Keep the version at `0.1.0` and choose the tier in `capabilities.public_listing.tier`.

    | Tier | Who sees the connector in the app | When to use it |
    |---|---|---|
    | `development` | Only users who turn on Developer mode | Every new connector starts here |
    | `preview` | Every user, with a warning to use data that is not critical | Propose it in the PR when `evidence`, `pilot fixture` and `mock mutation` show `✔`. A connector that makes no HTTP requests can keep `?` on `mock mutation` |
    | `supported` | Every user, with no tier warning | Only a maintainer sets it, after a run against a real account |

    The maintainer decides the tier. The PR description states these four things.

    1. What the connector collects.
    2. What it leaves out, and why.
    3. How you tested it, with the `streams exercised` line from step 6.
    4. Each `conformance` line you left open, with its reason.

    Describe the connector, not the tools that helped you write it. On the PR, the "Connector evidence summary" job runs `conformance` with `--static`, which skips the tests and the mock-mutation check, so run the full report locally.

## Change an existing connector

Make the change, then do steps 4 to 8 for that connector. A change to the code or the manifest needs a higher version in `manifest.json`, and a new `connector-implementation-index.json`; [docs/publishing.md](docs/publishing.md) gives the rule.
