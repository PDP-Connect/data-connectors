# Connector checklist

What a connector must satisfy to reach each evidence tier, and the command
that checks it. Each rule is machine-checked where a check can exist, and
has a written exemption where it cannot.

Run `npm run conformance -- <connector>` from the repository root first. It
runs every check below in order and prints the next action for each step
that is not PASS. CI runs it with `--static`, which skips the test run and
mock mutation, and prints the result in the "Connector evidence summary"
job of each connector PR. This document explains what those checks mean
and what promotion between tiers needs beyond them.

A maintainer decides each promotion between tiers. A PASS on every
mechanical check means that nothing mechanical is wrong. Only a run against
a real account shows that the connector works. `conformance` collects the
evidence; a maintainer sets the manifest's `public_listing.tier`.

## Development: scaffold

The floor. A connector directory exists and the runtime can start it, even
if it only emits `SKIP_RESULT`.

| Rule | Check |
|---|---|
| Manifest exists, declares ≥1 stream | `conformance <connector>` → `manifest` step |
| Connector directory and at least one `*.test.ts` file exist | `conformance <connector>` → `tests` step |
| If not yet collecting, listed in `KNOWN_SCAFFOLD_CONNECTORS` (`src/connector-conformance-roster.ts`) and assigned `public_listing.tier: "development"` | Manual roster edit. `connector-conformance.test.ts` checks that the two agree |

## Development: real collector, not run against a live account

Real collection logic exists, with no unconditional `SKIP_RESULT`. This is
where a new connector starts, at version `0.1.0`.

| Rule | Check |
|---|---|
| Test file exists and its suite passes | `conformance <connector>` → `tests` step |
| Emitted records validate against `schemas.ts` | covered by the connector's own test suite via `validateRecord` |
| Every declared `coverage_strategy` is reported by a run, and no required stream is exempt from the shared coverage oracle | `conformance <connector>` → `coverage` step |
| Roster entry in `PRODUCTION_READY_CONNECTORS` or `REAL_UNLISTED_CONNECTORS`, `testFile` points at a real test | `connector-conformance.test.ts` |
| Shared helpers used where the package has one (HTTP governor, coverage messages), and each open semantics decision made or explained in the PR | `conformance <connector>` → `shared helpers` and `semantics` steps (advisory) |
| A new connector starts at version `0.1.0` | `conformance <connector>` → `version` step (advisory) |
| Manifest `public_listing.tier: "development"` | Manual. The tier is a claim a person makes; no tool derives it |

## Preview: the author's run is recorded and bound to the code

These rules apply to each new promotion. Most connectors already at
`preview` were promoted before replay claims existed and have no claim yet.

| Rule | Check | Applies to |
|---|---|---|
| The author recorded a run against their own account, and its replay claim is bound to the current source and manifest | `conformance <connector>` → `evidence` step is PASS (`connectors/<connector>/evidence/claim.json`, written by `bin/scenario-verify.ts --json`; see AUTHORING.md). PASS shows the digests match; CI does not re-run the capture, so read the claim's limitations | every connector. Commit only `claim.json`; the scenario and HAR files stay private |
| Pilot fixture present, locks emitted shape against drift | `conformance <connector>` → `pilot fixture` step (looks for `connectors/<connector>/fixtures/scrubbed/pilot-real-shape/`) | any schema-bearing connector. The rows are synthetic with real field shapes; `connector-init` writes a starter set. Never commit real account rows there |
| Mock-mutation verdict is `PASS` (every path literal in the test suite is load-bearing) | `node --import tsx scripts/mock-mutation-check.ts --connector=<connector>` from `packages/polyfill-connectors/`, or the `mock mutation` step of `conformance` | any connector with a path-asserting mock. A connector with zero HTTP surface always reports `UNKNOWN` here, and that is correct |

Exemption: if a connector makes no HTTP requests (a file import such as
WhatsApp or Google Takeout), write that reason in the connector's header
comment and in the PR. `UNKNOWN` on mock mutation with a written reason is
the correct final state for such a connector.

## Supported: a maintainer ran it against a real account

| Rule | Check |
|---|---|
| A maintainer ran this connector against a real account and it collected real data with no errors | No automated check. Only a live run shows that the platform serves what the code expects |
| Manifest `public_listing.tier: "supported"` | Manual. A maintainer edits it after the run above |

## Anti-patterns this checklist prevents

1. Writing a mock to pass the mock-mutation check. A mock written by the
   same person, at the same time, as the code it mocks can share the code's
   misunderstanding. `mock-mutation-check` shows that a mock is
   load-bearing. Only a replay claim from a run against the real provider
   shows that it is correct.
2. Treating `UNKNOWN` as a bug to silence. For a connector that makes no
   HTTP requests, `UNKNOWN` on mock mutation is the permanently correct
   answer. Check the connector's header comment for that reason before you
   try to fix it.
3. Adding a new connector to `KNOWN_UNEXERCISED_COVERAGE`. That list holds
   old connectors only. A new connector adds a driver to
   `connectors/_conformance/coverage-conformance-drivers.ts`.
4. Promoting `public_listing.tier` because every mechanical check passed.
   Promotion needs a real run.
