# Reviewing a connector PR

This page is for the maintainer who reviews, merges and publishes a connector PR. Most connector PRs come from people whose accounts you do not have, so you review the evidence the PR carries and the code; you do not run the connector against the platform.

## What you can check without an account

| Check | Where | What a pass shows |
|---|---|---|
| Tests, types, lint, manifest schema | CI on the PR | The code builds and its own tests pass. |
| Readiness steps | The "Connector readiness" section of the "Connector evidence summary" job, or `npm run conformance -- <key> --static` | Problems visible in the code without a run, such as unreported coverage, a missing `retryablePattern` or a hand-written copy of a shared helper. |
| Replay claim | The `evidence` step, which reads `connectors/<key>/evidence/claim.json` | The committed claim is well formed, and its code and manifest digests match this PR. The check does not re-run the replay, and the recording stays on the author's machine. Read the claim's `limitations`. |
| Pilot fixture | `connectors/<key>/fixtures/scrubbed/pilot-real-shape/` | The directory has at least one `.jsonl` record file. The step does not read the rows. Check that the connector has a `pilot-fixture.test.ts` that calls `registerPilotFixtureTests`, which validates the rows against the schemas. The rows are synthetic. |
| Mock mutation | `npm run conformance -- <key>` (full run) | The check corrupts each request-path literal it finds in the test files, one at a time. A pass means a test failed each time, so the tests depend on those paths. The check does not change the connector code, and it can miss a path it does not detect. |

No check shows that the platform serves what the code expects for an account you have not seen. For that, read the `streams exercised` line the author pasted from `scenario-verify`, and the code paths in the questions below. If the `evidence` step is not PASS, the PR carries no claim bound to this code. The PR text must say so, and the tier stays `development`.

## Questions no check answers

1. Does a real run survive the platform? Read every `throw` and every early exit. A rate limit, a 5xx or a timeout must end the run as retryable through `retryablePattern`. A count that changes during the run, or a field the platform does not document, must become a coverage shortfall (`considered` greater than `covered`) and leave the run successful. Look for strict equality on counts, hard caps lower than a large account, and pagination with no guard against cycles.
2. Does it cover the platform? Open the platform's API reference or its data export and list what it holds. Compare that list with the manifest's streams and with the fields each API response returns. A connector key named after the platform needs streams for the platform's main data; a connector that collects one source needs a narrower key. Each part left out needs a reason in the PR.
3. Does it use the Collection Profile fully? Each `semantics` line the author left open needs a reason that holds. Check that `coverage_strategy` matches what the code reports; a stream that emits only `STATE` reports no coverage. Check the time fields against [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md). `consent_time_field` is the field a grant's time range applies to, and charts use `query.aggregations.group_by_time`.
4. Does it reuse what exists? Compare it with the closest connector of the same kind. Code that does a job the package already does uses the shared helper, such as `createConnectorHttpGovernor`, the coverage builders in `packages/polyfill-connectors/src/connector-runtime.ts`, `walkPagesWithCeiling`, `createRepairBudget`. If the PR solves a problem that other connectors share, ask whether to move it into `packages/polyfill-connectors/src/`.
5. Are the tier and version honest? A new connector is `0.1.0`. The tier follows [the connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md): `development` until the connector meets the `preview` rules there, and `supported` only after a maintainer's run against a real account. A connector that makes no HTTP requests can be `preview` with `?` on `mock mutation`, if its header comment and the PR give that reason.
6. Can a stranger understand the PR text? It covers each item that [AUTHORING.md](AUTHORING.md#steps) step 10 asks for, and it describes the connector, not the tools that produced it. If the text is unclear, ask the author for a rewrite.

## Post the review

Post two lists. First the changes the proposed tier needs, each with `file:line` and the failure it causes. Then follow-ups. Ask only for what the proposed tier needs.

If you find a defect that other connectors can also have, and a check can find it in the code, add a follow-up to write the check in `packages/polyfill-connectors/scripts/conformance-readiness.ts` with a test. A rule about a shared helper goes in `SHARED_HELPER_RULES` there. The check does not block the merge.

## Merge and publish

1. Merge when CI is green, the evidence meets the proposed tier, the code answers the questions above, and each change you asked for is done. Share only reviewed, scrubbed or synthetic examples in the PR.
2. For a connector that publishes, check its entry in `scripts/connector-publish-allowlist.mjs` and the version in its manifest. Merging to `main` publishes it through `.github/workflows/publish-polyfill-connectors.yml`. [docs/publishing.md](docs/publishing.md) describes the pipeline.
3. Open the workflow run for the merge. Check that it signed the connector version and that the catalog lists the same version and digest. Post the run link and the digest in the PR. If publication fails or the entry is missing, post the failed step or the missing entry, and name the maintainer who takes it from there.
