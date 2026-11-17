# Connector checklist

This page lists what a connector must satisfy to reach each evidence tier, and the command that checks it. Each rule has a machine check where one can exist, and a written exemption where it cannot.

Run `npm run conformance -- <connector>` from the repository root first. It runs every check below in order and prints the next action for each step that is not PASS. CI runs it with `--static`, which skips the test run and mock mutation, and prints the result in the "Connector evidence summary" job of each connector PR.

A maintainer decides each promotion between tiers and sets the manifest's `public_listing.tier`. The mechanical checks show that the connector's files, tests and claims are consistent with each other. They cannot show that the connector works against the real platform. Only a run against a real account shows that.

## Development, scaffold only

A connector directory exists and the runtime can start it, even if it only emits `SKIP_RESULT`.

| Rule | Check |
|---|---|
| Manifest exists and declares at least one stream | The `manifest` step of `conformance <connector>` |
| Connector directory and at least one `*.test.ts` file exist | The `tests` step of `conformance <connector>` |
| If the connector does not collect yet, it is listed in `KNOWN_SCAFFOLD_CONNECTORS` (`src/connector-conformance-roster.ts`) and has `public_listing.tier: "development"` | Manual roster edit. `connector-conformance.test.ts` checks that the two agree |

## Development, real collector not run against a live account

Real collection logic exists, with no unconditional `SKIP_RESULT`.

| Rule | Check |
|---|---|
| Test file exists and its suite passes | The `tests` step of `conformance <connector>` |
| Emitted records validate against `schemas.ts` | The connector's own test suite, through `validateRecord` |
| Every declared `coverage_strategy` is reported by a run, and no required stream is exempt from the shared coverage oracle | The `coverage` step of `conformance <connector>` |
| Roster entry in `PRODUCTION_READY_CONNECTORS` or `REAL_UNLISTED_CONNECTORS`, and `testFile` points at a real test | `connector-conformance.test.ts` |
| Shared helpers are used where the package has one (HTTP governor, coverage messages), and the PR makes or explains each open semantics decision | The `shared helpers` and `semantics` steps of `conformance <connector>` (advisory) |
| A new connector has the version that the [version rule](../../docs/publishing.md#version-rule) gives it | The `version` step of `conformance <connector>` (advisory) |
| Manifest `public_listing.tier` is `"development"` | Manual. A person makes the claim, and no tool derives it |

## Preview, the author's run is recorded and bound to the code

Each new promotion to `preview` needs all three rules below. A connector that was promoted before replay claims existed has no claim yet.

| Rule | Check |
|---|---|
| The author recorded a run against their own account. The replay claim stores digests of the connector source and manifest, and they match the current files | The `evidence` step of `conformance <connector>` is PASS. The claim is `connectors/<connector>/evidence/claim.json`, which `bin/scenario-verify.ts --json` writes (see [AUTHORING.md](../../AUTHORING.md)) |
| A pilot fixture exists and locks the emitted record format against drift | The `pilot fixture` step of `conformance <connector>`. It looks for `connectors/<connector>/fixtures/scrubbed/pilot-real-shape/` |
| The mock-mutation verdict is `PASS`, meaning the test suite fails when any one request-path literal in it is corrupted | `node --import tsx scripts/mock-mutation-check.ts --connector=<connector>` from `packages/polyfill-connectors/`, or the `mock mutation` step of `conformance` |

1. The claim rule applies to every connector. CI does not re-run the capture, so read the claim's limitations. Commit only `claim.json`. The scenario and HAR files stay private.
2. The pilot fixture rule applies to any connector that has a schema. The rows are synthetic with real field formats, and `connector-init` writes a starter set. Never commit real account rows there.
3. The mock-mutation rule applies to any connector with a mock that asserts request paths.

A connector that makes no HTTP requests, such as a file import like WhatsApp or Google Takeout, is exempt from the mock-mutation rule. Its `mock mutation` step reports `UNKNOWN`. Write that reason in the connector's header comment and in the PR. `UNKNOWN` with a written reason is the correct final state for such a connector. Do not try to silence it.

## Supported, a maintainer ran it against a real account

| Rule | Check |
|---|---|
| A maintainer ran this connector against a real account and it collected real data with no errors | No automated check. Only a live run shows that the platform serves what the code expects |
| Manifest `public_listing.tier` is `"supported"` | Manual. A maintainer edits it after the run above |

## Anti-patterns this checklist prevents

1. Writing a mock only to pass the mock-mutation check. A mock written by the same person, at the same time, as the code it mocks can share the code's misunderstanding. A replay claim from a run against the real provider checks the mock against real responses.
2. Adding a new connector to `KNOWN_UNEXERCISED_COVERAGE`. That list holds old connectors only. A new connector adds a driver to `connectors/_conformance/coverage-conformance-drivers.ts`.
