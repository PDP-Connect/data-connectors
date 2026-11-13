# Reviewing a connector PR

This page is for the maintainer who reviews, merges and publishes a connector PR. You can also give it, with the PR diff, to a review agent. Most connector PRs come from people whose accounts you do not have, so you review the evidence the PR carries and the code; you do not run the connector against the platform.

## What you can check without an account

| Check | Where | What a pass shows |
|---|---|---|
| Tests, types, lint, manifest schema | CI on the PR | The code builds and its own tests pass. |
| Readiness steps | The "Connector readiness" section of the "Connector evidence summary" job, or `npm run conformance -- <key> --static` | Mechanical gaps: coverage that the code never reports, a stream with no coverage driver, a hand-rolled helper, an unset option, the version. |
| Replay claim | The `evidence` step, which reads `connectors/<key>/evidence/claim.json` | The author recorded a run and replayed it against this exact code and manifest. The recording stays on the author's machine. Read the claim's `limitations`. |
| Pilot fixture | `connectors/<key>/fixtures/scrubbed/pilot-real-shape/` | The emitted record shape is locked against drift. Its rows are synthetic. |
| Mock mutation | `npm run conformance -- <key>` (full run) | Each path the test mocks assert on is load-bearing. |

No check shows that the platform serves what the code expects for an account you have not seen. For that, read the `streams exercised` line the author pasted from `scenario-verify`, and the code paths in the questions below. If the `evidence` step is not PASS, nobody has shown that this code ran against a real account: the PR text must say so, and the tier stays `development`.

## Questions no check answers

1. Does a real run survive the platform? Read every `throw` and every early exit. A rate limit, a 5xx or a timeout must end the run as retryable through `retryablePattern`. A count that changes during the run, or a field the platform does not document, must become a coverage shortfall (`considered` greater than `covered`) and leave the run successful. Look for strict equality on counts, hard caps lower than a large account, and pagination with no guard against cycles.
2. Does it cover the platform? Open the platform's API reference or its data export and list what it holds. Compare that list with the manifest's streams and with the fields each API response returns. A connector key named after the platform needs streams for the platform's main data; a connector that collects one source needs a narrower key. Each part left out needs a reason in the PR.
3. Does it use the Collection Profile fully? Each `semantics` line the author left open needs a reason that holds. Check that `coverage_strategy` matches what the code reports; a stream that emits only `STATE` reports no coverage. Check time fields against [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md): `consent_time_field` is the field a grant's time range applies to, and charts use `query.aggregations.group_by_time`.
4. Does it reuse what exists? Compare it with the closest connector of the same kind. Code that does a job the package already does uses the shared helper: `createConnectorHttpGovernor`, the coverage builders in `packages/polyfill-connectors/src/connector-runtime.ts`, `walkPagesWithCeiling`, `createRepairBudget`. If the PR solves a problem that other connectors share, ask whether to move it into `packages/polyfill-connectors/src/`.
5. Are the tier and version honest? A new connector is `0.1.0`. The tier follows [the connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md): `development` until a replay claim bound to the code exists.
6. Can a stranger understand the PR text? It states what the connector collects, what it leaves out and why, how it was tested, and the reason for each open `conformance` line. It describes the connector, and names no tool or company that produced the PR. If the text is unclear, ask the author for a rewrite.

## Post the review

Post two lists. First the changes the proposed tier needs, each with `file:line` and the failure it causes. Then follow-ups. Ask only for what the proposed tier needs.

When you find a defect that a check could have caught, add the check: a rule in `SHARED_HELPER_RULES` or a new step in `packages/polyfill-connectors/scripts/conformance-readiness.ts`, with a test. The next reviewer then finds it without reading the code.

## Merge and publish

1. Merge when CI is green, the evidence meets the proposed tier, and each change you asked for is done. Share only reviewed, scrubbed or synthetic examples in the PR.
2. For a connector that publishes, check its entry in `scripts/connector-publish-allowlist.mjs` and the version in its manifest. Merging to `main` publishes it through `.github/workflows/publish-polyfill-connectors.yml`. [docs/publishing.md](docs/publishing.md) describes the pipeline.
3. Open the workflow run for the merge. Check that it signed the connector version and that the catalog lists the same version and digest. Post the run link and the digest in the PR. If publication fails or the entry is missing, post the failed step or the missing entry, and name the maintainer who takes it from there.
