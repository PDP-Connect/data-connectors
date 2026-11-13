# Reviewing a connector PR

Most connector PRs come from people whose accounts the reviewer does not have, so the reviewer cannot run the connector. CI and `npm run conformance -- <key>` find the mechanical gaps; the "Connector readiness" section of the "Connector evidence summary" job lists them for each touched connector. This page covers the judgment calls that remain. A maintainer can work through it, or give it to a review agent together with the PR diff.

Read the readiness section first. If the `evidence` step is not PASS, nobody has shown that this code ran against a real account: the PR text must say so, and the tier stays `development`.

Then answer six questions.

1. **Does a real run survive the platform?** Read every `throw` and every early exit. A rate limit, a 5xx or a timeout should end the run as retryable (`retryablePattern`), not terminal. A count that changes during the run, or a field the platform does not document, should become a coverage shortfall (`considered` greater than `covered`), not a failed run. Look for strict equality on counts, hard caps that are lower than a large account, and pagination with no guard against cycles.
2. **Does it cover the platform?** Open the platform's API reference or its data export and list what it holds. Compare that list with the manifest's streams and with the fields each API response returns. The connector key should match the scope: a key named after the platform that collects one source needs more streams or a narrower name. Each part left out needs a reason in the PR.
3. **Does it use the Collection Profile fully?** Each `semantics` line that the author left open needs a reason that holds. Check that `coverage_strategy` matches what the code reports: a stream that emits only `STATE` proves nothing. Check time semantics against [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md): `consent_time_field` is the field a grant's time range applies to, and charts use `query.aggregations.group_by_time`, not an `event-time` role.
4. **Does it reuse what exists?** Compare it with the closest peer connector of the same kind, not with the whole fleet. Code that does a job the package already does should use the shared helper: the HTTP governor, coverage builders, `walkPagesWithCeiling`, `createRepairBudget`. If the PR solves a problem well that other connectors share, ask whether to extract it into `packages/polyfill-connectors/src/`.
5. **Are the tier and version honest?** A new connector is `0.1.0`. The tier follows [the connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md): `development` until a replay claim bound to the code exists.
6. **Can a stranger understand the PR text?** It states what the connector collects, what it leaves out and why, how it was tested, and the reason for each open `conformance` line. It describes the connector, not the tool or company that produced the PR. If the text is unclear, ask for a rewrite; do not rewrite it yourself.

Post the review as two lists: changes needed for the proposed tier (each with `file:line` and the failure it causes), then follow-ups. Do not ask for more than the proposed tier needs.

When a review finds a defect that a check could have caught, add the check: a rule in `SHARED_HELPER_RULES` or a new step in `packages/polyfill-connectors/scripts/conformance-readiness.ts`, with a test. Each review should leave less for the next reviewer to find by hand.
