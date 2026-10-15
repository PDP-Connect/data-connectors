# Local scenario consumer capture

These files are real outputs from `scenario-record` for an independently authored local reference connector and its loopback site. They demonstrate recorder and replay behavior for `pdpp.connector-scenario/1`. They are labeled `synthetic-spike` and `local-only`; they do not claim integration with a live provider. The site used no account, credentials, tokens, or cookies.

## Pins and environment

- Capture date: 2026-10-15 (UTC).
- Repository source pin: `3ab2238a37741eab9a5458b68707b400ab80b5d7`.
- Scenario CLI contract: `pdpp.connector-scenario-cli/1`, discovered beside the CLI source through `packages/polyfill-connectors/bin/scenario-cli-contract.json`.
- Recorder metadata: `scenario-record/1`; connector id: `scenario-consumer`.
- The reference connector is unversioned. Its exact capture implementation is pinned by the source-file SHA-256 values below; `scenario-record/1` identifies recorder metadata, not a connector version.
- Node `v24.21.0`; npm `12.2.0`; Patchright `1.63.0`; tsx `4.23.15`; connector protocol `2.4.0`.
- Capture browser: preinstalled `/usr/bin/google-chrome`, Google Chrome `155.0.8059.79`, headless, attached over loopback CDP on port 9222 with a new empty profile.
- Host: Ubuntu 26.04.1 LTS x64. The worktree had no installed dependencies and the npm/browser caches were empty before setup. This proves a clean dependency/cache setup on this host, not a pristine-machine setup. The package's optional browser postinstall skips this Ubuntu release. The explicit task-local Patchright Chromium install exited 0 and enabled offline browser replay.

## Reproduction

Run from `packages/polyfill-connectors`. Keep both caches and the fresh Chrome profile in a private, disk-backed task directory. Run setup, both recordings, owned-process cleanup, and successful replays in one shell while holding `flock -x "$HOME/.tmp/connector-build-loop/heavy-local.lock"`; keep the lock for the site and Chrome lifetime. The capture and successful replay batches used this shared lock. One exploratory Playwright install/replay attempt ran outside the lock and is disclosed below. The fixture site binds only to `127.0.0.1:41731`.

```sh
export LOCAL_TASK_DIR="$HOME/.tmp/connector-build-loop/scenario-compatibility"
export LOCAL_NPM_CACHE="$LOCAL_TASK_DIR/npm-cache"
export PLAYWRIGHT_BROWSERS_PATH="$LOCAL_TASK_DIR/browser-cache"
npm ci --ignore-scripts --cache "$LOCAL_NPM_CACHE" --userconfig=/dev/null
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" ../../node_modules/.bin/patchright install chromium

PDPP_SCENARIO_CONSUMER_BASE_URL=http://127.0.0.1:41731 node --import tsx test-fixtures/scenario-consumer/site.ts
```

`npm ci --ignore-scripts` and `patchright install chromium` exited 0. The package postinstall did not install a browser on this Ubuntu release, so the explicit Patchright install is required for replay.

Keep the site running for both recording commands. In another terminal, create a new empty profile and start local headless Chrome:

```sh
profile_dir="$(mktemp -d "$LOCAL_TASK_DIR/chrome-profile.XXXXXX")"
setsid /usr/bin/google-chrome --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$profile_dir" --no-first-run --no-default-browser-check --disable-background-networking about:blank
```

Record the ordinary HTTP scenario, then the same connector's browser entrypoint through the real HAR/CDP recorder path:

```sh
PDPP_SCENARIO_CONSUMER_BASE_URL=http://127.0.0.1:41731 node --import tsx bin/scenario-record.ts scenario-consumer --entrypoint test-fixtures/scenario-consumer/http-connector.ts --runs 2 --out test-fixtures/scenario-consumer/scenario-http.json
PDPP_SCENARIO_CONSUMER_BASE_URL=http://127.0.0.1:41731 PDPP_SCENARIOCONSUMERFIXTURE_REMOTE_CDP_URL=http://127.0.0.1:9222 node --import tsx bin/scenario-record.ts scenario-consumer --entrypoint test-fixtures/scenario-consumer/browser-connector.ts --runs 2 --record-har --out test-fixtures/scenario-consumer/scenario-browser.json
```

Both commands exited 0. The HAR capture wrote two HAR files and two storage-state files. Stop the site and the owned Chrome process, remove the empty profile, and unset the CDP variable before offline verification. The capture batch checked that the site and CDP endpoints no longer answered before replay. A current process/profile check on 2026-10-15 found no matching owned site/Chrome processes, no profile directories, and no response from either loopback endpoint. Historical process wait/termination exit codes were not recorded:

```sh
PDPP_SCENARIO_CONSUMER_BASE_URL=http://127.0.0.1:41731 node --import tsx bin/scenario-verify.ts scenario-consumer test-fixtures/scenario-consumer/scenario-http.json --entrypoint test-fixtures/scenario-consumer/http-connector.ts --json "$LOCAL_TASK_DIR/claim-http.json"
env -u PDPP_SCENARIOCONSUMERFIXTURE_REMOTE_CDP_URL PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" PDPP_BROWSER_HEADLESS=1 PDPP_SCENARIO_CONSUMER_BASE_URL=http://127.0.0.1:41731 node --import tsx bin/scenario-verify.ts scenario-consumer test-fixtures/scenario-consumer/scenario-browser.json --entrypoint test-fixtures/scenario-consumer/browser-connector.ts --json "$LOCAL_TASK_DIR/claim-browser-patchright.json"
```

The HTTP replay exited 0 and wrote `$LOCAL_TASK_DIR/claim-http.json`. The successful browser replay command exited 0; its exit receipt is `$LOCAL_TASK_DIR/verify-browser-patchright.exit` and its fresh claim is `$LOCAL_TASK_DIR/claim-browser-patchright.json`. That claim reports schema `pdpp.connector-claim/1`, `diagnostic_replay`, driver `recorded-browser`, two runs, empty coverage, candidate-oracle status, and null source/declaration digests. It has no entrypoint digest. This is diagnostic replay evidence only; it does not establish canonical provider or browser integration.

The earlier browser attempts remain distinct. An exploratory `PLAYWRIGHT_BROWSERS_PATH="$LOCAL_TASK_DIR/browser-cache" ../../node_modules/.bin/playwright install chrome` ran outside the shared lock and exited 0; the associated replay exited 1, recorded in `$LOCAL_TASK_DIR/verify-browser.exit`, and did not write `claim-browser.json`. A later Playwright install/replay attempt ran under the lock but also exited 1, recorded in `$LOCAL_TASK_DIR/verify-browser-final.exit`, without `claim-browser-final.json`. The successful Patchright install and replay used separate commands and receipts. These attempts are not treated as successful claims.

The scenarios contain successful terminal `done` traces, non-empty final state, and both upsert and delete operations. Run 2 starts from run 1 state; HTTP interactions differ between runs. Browser requests are in the HAR (three entries in run 1, two in run 2). HAR and storage-state references in the browser scenario are relative sibling paths. The storage-state files contain empty cookies and origins.

## Privacy review

Before commit, scan both scenario files, both HAR files, and both storage-state files. The focused checker reports field paths and categories, never values. It checks cookie data; Cookie/Set-Cookie, Authorization/Proxy-Authorization, and auth headers; access, refresh, session, and other named tokens; URL userinfo and sensitive or token-like query values; credential assignments, bearer/JWT strings, and private browser-profile paths. Run it and its fake-secret negative control with:

```sh
python3 test-fixtures/scenario-consumer/check-capture-privacy.py \
  test-fixtures/scenario-consumer/scenario-http.json \
  test-fixtures/scenario-consumer/scenario-browser.json \
  test-fixtures/scenario-consumer/scenario-browser.run1.har \
  test-fixtures/scenario-consumer/scenario-browser.run2.har \
  test-fixtures/scenario-consumer/scenario-browser.run1.storage-state.json \
  test-fixtures/scenario-consumer/scenario-browser.run2.storage-state.json
python3 test-fixtures/scenario-consumer/check-capture-privacy.py --self-test
```

The six-file scan reported zero findings. The checker walks HAR request/response header arrays, parses JSON in response content and request postData text, scans named postData parameters, strictly decodes declared base64 bodies and scans decoded text, checks storage-origin names, and fails closed on malformed or undecodable declared base64. Its 20 fake-secret controls reject those cases plus the existing map-header, storage-cookie, query, and private-profile cases. Manual review confirmed loopback-only URLs, no authentication or account flow, and empty browser storage state. No captured values were removed, so replay bytes and semantics are unchanged. Re-run offline verification if any future scrub changes a fixture.

## Immutable capture digests

SHA-256 of the six reviewed capture artifacts:

| File | SHA-256 |
| --- | --- |
| `scenario-http.json` | `12e6397d53f1e52dba497b21d549fb5051771fc5cc8db58b4139f8f3ef44def8` |
| `scenario-browser.json` | `ec84aaf45ba8d3920171a2b6134f4bbf5e657efa4166bcacdef0bc1da1ed5d74` |
| `scenario-browser.run1.har` | `4d22b21ec7399ce4a0edd31c23918e5efc2dcf3fe4c68008b7d1bde4c9a142a0` |
| `scenario-browser.run2.har` | `80873b8ce90dcb8d31f2be4b2747d1f7e1c94a385fe3d89cf958ab26faffc01f` |
| `scenario-browser.run1.storage-state.json` | `dcbfcdab9989eddcd68fdfe131c719283e1960b866b600a3d36d6daff254f32b` |
| `scenario-browser.run2.storage-state.json` | `dcbfcdab9989eddcd68fdfe131c719283e1960b866b600a3d36d6daff254f32b` |

## Capture input digests

SHA-256 of the local site, connector entrypoints, checker, and dependency lockfile used for this capture:

| File | SHA-256 |
| --- | --- |
| `data.ts` | `5f8780e84eeb0252df92c96a7f9d08b8faf0fabc1d86ea20a7c1985c2cc3b8a3` |
| `site.ts` | `6f7508a683761c5d4be0c80585f631643021b0a9f92cafebb81ab8ce7ddbd9d1` |
| `http-connector.ts` | `3e778739607d08f331ddf7ceee19bafebc3e6ab4858bc03878b86f6d8837c3a8` |
| `browser-connector.ts` | `02e65bd04a0c26c5bf6ef8d042d96376a7ddcb7477bd6df72d9859a75341aa5b` |
| `check-capture-privacy.py` | `30f7016d03fd7a9693b29ff22377a7b4679b54ea20d9ce64455d591cf1bc4475` |
| `packages/polyfill-connectors/package-lock.json` | `37ebf87ef4563cbc70919a4e626541dd6cd61cd0819f4e14c1311a63b151bb89` |

## Frozen compatibility check

The focused `Scenario Compatibility` workflow replays these unchanged bytes with the current validator and `scenario-verify`. Its first corpus is pinned to bootstrap commit `c0c6f1e4faa7015cf6447230b0c17a5f9769b09b`; the accepted claims in `scenario-compatibility-baseline.json` record the real replay outcomes from that capture. Later runs read the fixture and expected outcomes from the PR base or push-before commit, then require the checked-out copies to match those bytes. A missing or partial old corpus fails closed. The check does not record again, start the reference site or CDP browser, or contact a provider. Browser verification replays the committed HAR in headless Chromium through the existing verifier isolation path. Its expected result remains `diagnostic_replay`, with empty coverage and no entrypoint digest; it is not canonical provider or browser-integration proof.

The separate 20-minute workflow job covers the full `src/` implementation tree, all `bin/scenario-*` entrypoints/helpers, the consumer contract, fixture/checker files, its own compatibility scripts/workflow, and dependency inputs. It compares the full PR merge-base-to-head or push before-to-head range. NUL-delimited Git records preserve unusual filenames and include both sides of renames and deleted paths; invalid refs fail closed. A stable gate rejects failed admission and a skipped focused check when a relevant path changed.

The focused suites are named `*.check.mjs`, so the existing package runner's `scripts/**/*.test.mjs` discovery does not include them. The focused admission suite reads the runner's actual glob list and checks that both focused files stay excluded. The workflow invokes them explicitly. It does not add work to the ordinary package test job.

The workflow fetches the reviewed bootstrap object from the pushed `t3/public-connector-scenarios` branch before replay. This makes the exact `c0c6f1e4faa7015cf6447230b0c17a5f9769b09b` tree available even when the contract-base branch has no capture corpus and the bootstrap is not in the new branch's ancestry.

The focused test checks capture/source SHA-256 pins before and after replay and runs the structural privacy scanner's self-test and six-file scan. It runs heterogeneous optional root metadata through both real verifier entrypoints and compares stable claim fields, allowing only the generated `verified_at` to vary. A temporary Git worktree mutates the actual validator to require a new root field, then runs both unchanged historical scenarios through the real CLI; each must fail specifically on that injected requirement, while the unmodified validator passes. The caller worktree stays unchanged and the temporary worktree is removed in `finally`.

The test also rejects altered operations, record hashes, final state, protocol trace, HAR, or storage data. It replays the legacy HTTP scenario with `capture.captured_at` removed and requires the claim key to stay absent. A successful process exit is not accepted unless a fresh, parseable claim artifact exists; stale paths are refused and the current best-effort claim-write failure is covered.

Format `/1` remains explicitly supported. After a future version bump, the old corpus can remain supported and replayed. A deliberate drop must change `format_disposition` to `dropped` in the baseline metadata, include `format_migration`, and produce `unsupported_format` from both the ordinary and HAR CLI checks without writing either claim. The same run must also replay both controls with the current format and pass the format-independent privacy, mutation, metadata, semantic-corruption, and claim checks. If a new format changes the scenario structure, the compatibility test must be updated to pin and replay a real current-format scenario; it does not synthesize one. The frozen old bytes remain in the test and cannot be silently regenerated or skipped. No multi-version runtime was added.

After the dependencies and Patchright Chromium are installed by the commands above, the focused local check is:

```sh
SCENARIO_COMPAT_BASE_SHA=c0c6f1e4faa7015cf6447230b0c17a5f9769b09b \
SCENARIO_COMPAT_TMPDIR="$HOME/.tmp/scenario-compat" \
PLAYWRIGHT_BROWSERS_PATH="$HOME/.tmp/scenario-compat-browsers" \
node --import tsx --test scripts/scenario-compatibility-admission.check.mjs scripts/scenario-compatibility.check.mjs
```

Keep `SCENARIO_COMPAT_TMPDIR` short enough for the existing replay UDS socket path limit. The check asserts this before launching replay. Both local and workflow commands use task-owned directories, leave `HOME` unchanged, and remove replay outputs after the check.
