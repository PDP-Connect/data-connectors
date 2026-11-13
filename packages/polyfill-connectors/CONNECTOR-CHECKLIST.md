# Connector checklist

What a connector must satisfy to reach each evidence level, and the exact
command that proves it. Modeled on Home Assistant's Integration Quality
Scale: per-rule, machine-checked where a check can exist, an explicit
written exemption where it can't — never a silent skip.

Run `npm run conformance -- <connector>` from the repository root first. It
runs every check below in order and prints the specific next action for
anything that isn't PASS. CI prints the same steps (without the test run)
in the "Connector evidence summary" job summary of each connector PR. This
document explains what those checks mean and what promotion between levels
requires beyond them.

**Promotion between levels is a human decision, not automatic.** A PASS on
every mechanical check means "nothing mechanical is wrong" — it does not
mean the connector works against a real account. Only a run against a real
account shows that. `conformance` composes evidence; a human still assigns
the manifest's `public_listing.tier`.

## Development — scaffold

The floor. A connector directory exists and the runtime can start it, even
if it only emits `SKIP_RESULT`.

| Rule | Check |
|---|---|
| Manifest exists, declares ≥1 stream | `conformance <connector>` → `manifest` step |
| Connector directory + entry point exist | `conformance <connector>` → `tests` step |
| If not yet collecting, listed in `KNOWN_SCAFFOLD_CONNECTORS` (`src/connector-conformance-roster.ts`) and assigned `public_listing.tier: "development"` | manual roster edit — `connector-conformance.test.ts` enforces the two stay consistent |

## Development — real collector, unverified against a live account

Real collection logic exists — no unconditional `SKIP_RESULT`. This is
where a new connector starts, at version `0.1.0`.

| Rule | Check |
|---|---|
| Test file exists and its suite passes | `conformance <connector>` → `tests` step |
| Emitted records validate against `schemas.ts` | covered by the connector's own test suite via `validateRecord` |
| Every declared `coverage_strategy` is reported by a run, and no required stream is exempt from the shared coverage oracle | `conformance <connector>` → `coverage` step |
| Roster entry in `PRODUCTION_READY_CONNECTORS` or `REAL_UNLISTED_CONNECTORS`, `testFile` points at a real test | `connector-conformance.test.ts` |
| Shared helpers used where the package has one (HTTP governor, coverage messages), and each open semantics decision made or explained in the PR | `conformance <connector>` → `shared helpers` and `semantics` steps (advisory) |
| A new connector starts at version `0.1.0` | `conformance <connector>` → `version` step (advisory) |
| Manifest `public_listing.tier: "development"` | manual — this is the honesty claim, not machine-derived |

## Preview — the author's real run is recorded and bound to the code

These rules apply to each new promotion. Most connectors already at
`preview` were promoted before replay claims existed and have no claim yet.

| Rule | Check | Applies to |
|---|---|---|
| The author recorded a run against their own account, and its replay claim is bound to the current source and manifest | `conformance <connector>` → `evidence` step is PASS (`connectors/<connector>/evidence/claim.json`, written by `bin/scenario-verify.ts --json`; see AUTHORING.md). PASS shows the digests match; CI does not re-run the capture, so read the claim's limitations | every connector. Commit only `claim.json`; the scenario and HAR files stay private |
| Pilot fixture present, locks emitted shape against drift | `conformance <connector>` → `pilot fixture` step (looks for `connectors/<connector>/fixtures/scrubbed/pilot-real-shape/`) | any schema-bearing connector. The rows are synthetic with real field shapes; `connector-init` writes a starter set. Never commit real account rows there |
| Mock-mutation verdict is `PASS` (every path literal in the test suite is load-bearing) | `node --import tsx scripts/mock-mutation-check.ts --connector=<connector>` from `packages/polyfill-connectors/` — see `conformance`'s `mock mutation` step | any connector with a path-asserting mock. A connector with zero HTTP surface reports `UNKNOWN` here permanently and correctly — that is not a gap to close |

**Exemption rule:** if a connector has no HTTP surface at all (file-import —
e.g. WhatsApp, Google Takeout), write that reason in the connector's own
header comment and in `docs/inbox/report-connector-coverage.md`'s
classification table. `UNKNOWN` with a written reason is a legitimate
resting state, not a failure to fix later.

## Supported — a real account run has recorded real data end-to-end

| Rule | Check |
|---|---|
| A maintainer ran this connector against a real account and it collected real data with no errors | no automated check can show this — only a live run proves a live provider serves what the code expects |
| Manifest `public_listing.tier: "supported"` | manual — a deliberate human edit after the run above, never inferred |

## Anti-patterns this checklist exists to prevent

- **Writing a mock to pass the mock-mutation check.** A mock authored by
  the same person, in the same sitting, as the code it mocks can share the
  code's own misunderstanding. `mock-mutation-check` proves a mock is
  *load-bearing*, never that it's *correct*. Only a run against the real
  provider, recorded as a replay claim, can show correctness.
- **Treating `UNKNOWN` as a bug to silence.** For connectors with no HTTP
  surface, `UNKNOWN` on mock-mutation is the permanently correct answer.
  Read `docs/inbox/report-connector-coverage.md`'s classification table
  before assuming a connector's `UNKNOWN` is fixable.
- **Adding a new connector to `KNOWN_UNEXERCISED_COVERAGE`.** That list is
  a ratchet for old connectors. A new connector adds a driver to
  `connectors/_conformance/coverage-conformance-drivers.ts` instead.
- **Promoting `public_listing.tier` because every mechanical check went
  green.** It doesn't mean the connector works. It means nothing
  *mechanical* is wrong. Promotion needs a real run.
