# IMPL-263 — implementation and evidence report

Status: **DRAFT / acceptance incomplete**. This is an implementation record, not a SHIP verdict.
PR URL: pending creation on `PDP-Connect/data-connectors`, base `port/scenario-274`.
Recorded implementation head: `fbaf81683df46e29d10df8e816f0f1a72cde09d3`.
Prerequisite and merge-base: `3f41ef9b18c18818745ecfb7a389657c231634a4` (live PR #81 tip rechecked).
Source pins: H `62473d87bce933c2ad7486b372031922472e4ae9`; M `7acd4bac24d9898aac745bf70bc8d0a6a4f1e1f6`.
Node24.15.0/npm11.12.1. All contribution commits use Tim Nunamaker <tnunamak@gmail.com>, DCO, OpenPGP signing and final `Assisted-by: AI` trailer. No merge, issue closure, repository or gist creation.

## Preserved outcome and scope

> Written per design.md Decision #8 and tasks.md section 3. Recommendation: **NARROW**.
>
> **Do not yet claim:** that the GroupMe domain pilot's own operator-level killed/survived evidence (tasks.md 2.6/2.7) is complete. It is not — no operator attempt ran.
>
> No independent reviewer was available in this single-operator session to review this adapter's evidence before the domain pilot began, as tasks.md 1.6 calls for. Recorded honestly as a limitation, not fabricated.

Destination: **NARROW, no destination operator-level batch evidence**. Historical tasks2.6/2.7 and qualified1.6 remain verbatim. Decision records have short provenance headers and destination addenda under `docs/decisions/mutation-falsification/`. Proposed defaults: no scenario bins; docs/decisions placement; repository-wide canonical-entrypoint ratchet; no AppArmor relaxation. The scenario production claim remains false; two positive CLI WITHHELD tests passed. Clone isolation is not a sandbox. Hashes do not authenticate issuers. Failed full-backstop authority stays inconclusive; no end-to-end selector-miss attribution is claimed.

## N1–N4 corrections

- N1: tracked design explicitly assigns the consumed/configured skip join to the destination runner, notes authority/adapted-receipt coupling, and requires its reverted-fix probe. Runtime join rejects stale mappings; removing it fails its owning real-child contract, restoration passes.
- N2: enumerated55 metadata sites,36 direct capability sites plus15 indirect loop sites; converted predicates to reason-or-false before calibration. Inverse substitution restores original file bytes exactly. Two outside network skip sites were already explicit. Five pathname skip bodies remain unchanged. Local isolation96total44pass52skip0fail; hosted exact calibration remains open.
- N3: retained argument assertions and added actual four-child execution showing maximum two concurrent children. Five concurrency tests pass; no reduction claimed.
- N4: tracked design labels the cited417-second ordinary CI time cited-not-reproduced. It is not this port's measured accounted time.

## Baseline and timing outputs

Baseline normal command, independent clean checkout at merge-base:
```text
npm --prefix packages/polyfill-connectors test
exit_code=0; wall_seconds=389.45366678992286
ℹ tests 5162
ℹ suites 39
ℹ pass 5099
ℹ fail 0
ℹ cancelled 0
ℹ skipped 63
ℹ todo 0
ℹ duration_ms 389274.19567
```

Frozen external diagnostic reporter supplemental run preserves baseline discovery/flags, separately labelled:
```text
ℹ tests 5162
ℹ suites 39
ℹ pass 5099
ℹ fail 0
ℹ cancelled 0
ℹ skipped 63
ℹ todo 0
ℹ duration_ms 370175.234963
terminal events=5201 (includes39 suite containers)
failures=[]; ambiguous identities=[]
```

Original raw commands/logs, reporter bytes/digest and selections are retained in `.mutation-falsification-evidence/baseline-*`. Initial baseline verify attempts were contaminated by generated capture/build files from overlapping supplemental/pack work. Fresh independent baseline verification before tests passed; contaminated outputs remain labelled and are not attributed to baseline code. Baseline pack/install/run exit0,12.690722504165024s; all79 public export subpaths and45 manifest IDs resolve. Root connector tests exit0. Root tooling baseline138tests131pass7fail; source-layout/conformance failures retained.

Candidate complete-suite, diagnostic failure-set diff, accounted preflight and local wall time are running; no clean package receipt is claimed yet. Exact commands and intermediate heads remain in ignored evidence JSON. Final report will replace this pending statement with measured outcomes.

## Executed falsification outputs

```text
Primitive/migration run:216pass0fail0skip0cancel0todo,12.173s
Hermetic differential: legacy/structured byte equality twice in EACH of two HOME/TMPDIR/cwd fixtures; seven cases/control/rollback preserved
Primitive reverted guards: root-loader,surrogate,selectorMiss,normalized contradiction,receipt digest,strict receipt validation
Each mutant exit1; each restored exit0
Accounting runner real children:6pass0fail; ordinary/authority fixture both11assertions5pass6skip
N1 consumed/configured join: reverted owning test exit1; restored exit0
F1 smoke-policy reintroduction: owning suffix test exit1; restored exit0
Accounting unit subset:32pass0fail0skip
Accounting closure:6pass0fail; N→N−1 orphan rejects before spawn; failed protocol statuses agree; actual direct child quartet validates
GroupMe focused clean:23passes
Exact page-ceiling mutant:1 intended >200-page assertion failure,exit1
Exact nonprogress mutant:1 intended ascending-order assertion failure,exit1
Restored focused file:23passes,exit0
Two CLI WITHHELD-owning tests:2pass0fail0skip
Workflow gate:192 worker result combinations correct;3 changes failures rejected
Reverted required-skipped-job guard: relevant skipped accounted job incorrectly exits0,expectation FAIL; restored exits1,expectation PASS
Actionlint:exit0
```

Required root loaders all emitted real nonzero terminal counts. Clean/throw authority exits:

| Suite | Files | Pass | Fail | Skip | Clean authority | Throw authority |
|---|---:|---:|---:|---:|---:|---:|
|root-anthropic|3|3|0|0|0|1|
|root-openai|1|1|0|0|0|1|
|root-installer|1|44|0|0|0|1|
|root-runner|4|3|1|0|1|1|
|root-schemas|2|2|0|0|0|1|
|root-tooling|8|82|6|0|1|1|
|root-openai-browser, locally provisioned|1|1|0|0|0|1|

Each injected throwing sibling's unique sentinel appears in its transcript, including already-red suites. Issued argv exactly matches independently exercised leaf argv. Three optional artifact profiles remain unexecuted because pinned source/data prerequisites were not provisioned. Standalone scripts count at file granularity. Root loader initial raw reporter failure was a probe error: unchanged authority already resolves that path; no product repair is claimed.

Full bounded probe outputs and assertion failures are retained in `.mutation-falsification-evidence/`: `primitives-agent.md`, `accounting-agent.md`, `groupme-agent.md`, `root-loader-probes.md`, `workflow-probes.txt`, and their named logs. Final report will append remaining probe outputs and dispositions.

## Deviations and open requirements

1. Design §3 scope amendment adds only the existing runner-location row in `packages/polyfill-connectors/scripts/no-await-in-loops-allowlist.ts`: imports move the same loop34→36. Unchanged package verify failed on the stale row, then passed after the location update. No new exception was added.
2. Strict failing-test-first history was not achieved for every repair. Several new tests were added after code, then falsified through reverted-fix probes. This is a process deviation, not evidence retroactively labelled test-first.
3. A delegated lane initially ran11 reverted probes transiently in assigned destination harness files, restoring each, contrary to §8 disposable-only instructions. No pdpp or production GroupMe files were changed. Those results are superseded by independent-clone reruns; restoration does not erase the deviation. Final report records the replacement matrix.
4. Repository-wide canonical-entrypoint contract is still being completed. Hosted exact skip calibration, valid clean package receipt, final-head full baseline diff, green required CI and independent exact-head Claude/Astra reviews remain open. No historical source SHIP verdict is reused.
5. Fourteen Postgres membership tests are deliberately dropped per §3; six destination mappings and neutral generic fixtures do not replace absent server coverage. Full exact-title ledger is in the accounting evidence report and will be included in final report.
6. The complete real prepared dependency/browser/cache materialization and actual GroupMe batch remain unproven. Fixture orchestration now demonstrates a forced focused survivor invokes real complete authority; a failing authority result remains inconclusive. Filesystem copying/hashing/cleanup are observed operations, not a hard cancellable resource quota.

Confidence: high on pinned imports, tested primitives and observed fixture rejection; acceptance confidence remains insufficient until the open integration/review requirements close.
