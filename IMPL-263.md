# IMPL-263 — implementation and evidence report

Status: **DRAFT / NARROW; implementation delivered, exact-head acceptance incomplete**. This is an implementation record, not a SHIP verdict. Report snapshot: 2026-09-06 14:51 UTC.
Repaired implementation head: `59be16318d1fb787be21e506861713169569939d`. The final report commit is a descendant; validation snapshots and the signed-history map below remain explicit.
PR URL: https://github.com/PDP-Connect/data-connectors/pull/82 — draft, base `port/scenario-274`, stacked on #81; retarget to main only after #81 merges and rebaseline/review.
Recorded full-suite implementation head: `3f9e190360fca045b6823683aa9ed5b4ae18a483`.
Later full local validation head: `86e394e4441a1a47f51b82139b8e5143e543e8e2` (before interruption repair and signed-history correction). This report distinguishes tested snapshots; it does not certify a later report commit by inference.
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
- N2: enumerated55 metadata sites,36 direct capability sites plus15 indirect loop sites; converted predicates to reason-or-false before calibration. Inverse substitution restores original file bytes exactly. Two outside network skip sites were already explicit. Five pathname skip bodies remain unchanged. Local isolation96total44pass52skip0fail. Hosted calibration was subsequently measured and source-reconciled:94 skips across15 exact reasons; see the retained hosted output below.
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

Candidate ordinary run at `3f9e190360fca045b6823683aa9ed5b4ae18a483`: exit0, wall389.91527441795915s,5168tests5105pass0fail63skip0cancel0todo. Sorted supplemental also passed; the later86e full comparison is appended below. The earlier ordinary Slack failure is retained in the complete comparison below; later passes do not establish its root cause.

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

Full bounded probe outputs and assertion failures are retained in `.mutation-falsification-evidence/`: `primitives-agent.md`, `accounting-agent.md`, `groupme-agent.md`, `root-loader-probes.md`, `workflow-probes.txt`, and their named logs. Paste-ready outputs and explicit coverage gaps follow below. These ignored local artifacts are not public attachments; hosted run artifacts are attached to this PR’s workflow runs.

## Deviations and open requirements

1. Design §3 scope amendment adds only the existing runner-location row in `packages/polyfill-connectors/scripts/no-await-in-loops-allowlist.ts`: imports move the same loop34→36. Unchanged package verify failed on the stale row, then passed after the location update. No new exception was added.
2. Strict failing-test-first history was not achieved for every repair. Several new tests were added after code, then falsified through reverted-fix probes. This is a process deviation, not evidence retroactively labelled test-first.
3. A delegated lane initially ran11 reverted probes transiently in assigned destination harness files, restoring each, contrary to §8 disposable-only instructions. No pdpp or production GroupMe files were changed. Those results are superseded by independent-clone reruns; restoration does not erase the deviation. Final report records the replacement matrix.
4. Repository-wide canonical-entrypoint contract is implemented and its direct, compound, alias, literal/computed wrapper and YAML negatives pass. It is a bounded lexical check: existing grandfathered tuples do not freeze implementation bytes; arbitrary generated code or remote/composite actions are not statically certified. Hosted calibration is complete; fresh verification is recorded separately below. Final same-head baseline/CI/reviews remain acceptance gates; no historical source SHIP verdict is reused.
5. Fourteen Postgres membership tests are deliberately dropped per §3; six destination mappings and neutral generic fixtures do not replace absent server coverage. Full exact-title ledger is reproduced below.
6. Real two-lock offline materialization, SQLite execution and Chromium launch now pass with retained identities at an explicitly recorded snapshot. The actual GroupMe batch remains unproven. Fixture orchestration now demonstrates a forced focused survivor invokes real complete authority; a failing authority result remains inconclusive. Filesystem copying/hashing/cleanup are observed operations, not a hard cancellable resource quota.

Confidence: high on pinned imports, tested primitives and observed fixture rejection; acceptance confidence remains insufficient until the open integration/review requirements close.


## Additional adaptations and process limits

- Design §10 requires CI evidence at the reviewed full destination head. Initial GitHub PR jobs checked out synthetic merge commits. The workflow now explicitly selects the PR head (or event SHA outside PRs), and artifact names use that same identity. Owning contract clean0 / reverted default-merge ref1 / restored0; actionlint and scoped typecheck pass. This implements §10 without changing contribution scope.
- Design §§4–5 require truthful complete commands and execution identities. Real socket `listen EINVAL` traced to the UUID-length preflight TMPDIR. Atomic short `p-XXXXXX` directories retain private state while allowing the unchanged scenario bridge path. A real socket fixture fails with the old path and passes with the repair. Logical identity excludes randomized private paths; digest-bound execution observations retain actual paths, argv, cwd and allowed environment.
- Design §8 changed-judge refusal needed a destination repair: an actual focused fixture changed tracked judge bytes and could previously produce `killed`. Before/after isolated Git-status checks now yield `focused_source_changed` and `inconclusive`; reverted guard fails again. This is evidence integrity, not an arbitrary-source mutation feature.
- The first paired candidate supplemental runner retained common baseline order instead of the candidate’s intentional sorted order. It proves population comparison but does not meet the full ordered-command equivalence obligation. Separately labelled sorted supplemental runs at3f9 and86e use the same frozen reporter and passed; the initial observation is preserved below, not silently relabelled.
- Ordinary candidate snapshot2dcb showed a newly observed Slack timeout. Three focused checks at each revision and later full-run passes did not prove its cause. No unrelated Slack production change was made.
- PR writing received independent context-free grades5/10,6/10,7/10 over three rounds; targeted clarity repairs followed. Those are writing reviews, not code acceptance reviews.

## Hosted calibration and measured local cost

Initial local accounted attempt at2dcb: exit1,335.894880220294s wall; authority elapsed330639ms, stalled after Unix socket failures; no successful quartet. Initial hosted run34037655390: authority elapsed340778ms, same socket-path failure. Both retained as failed observations.

After the socket fix, the local complete preflight atd666 exited1 after385.1498841657303s wall. Local observations were5168 assertions5102pass0fail66skip,365 completed files, child0, enclosing authority1 because its then-current11-skip expectation did not match. Internal authority elapsed380827ms; no socket failure remained. Local capabilities also differ from the later94-skip hosted profile; this is not relabelled hosted evidence. The complete hosted calibration at branchd666 / synthetic merge01b85e9b6cc18339b1a2b28b6babac22081e7444 returned:

```text
365 issued files;365 unique completed files
5168 assertions;5074 passed;0 failed;94 skipped;0 cancelled;0 todo
test child exit_code=0
accounting verification: skips do not exactly match profile baseline
authority elapsed_ms=429463; namespaceAvailable=false
```

This failed verification supplied observations for manual calibration, not a valid clean receipt. The updated exact map was checked against source predicates and an independent literal test; no counts were auto-learned. The subsequent exact-branch-head accounted job in run34038751216 succeeded and its complete quartet independently revalidated; its full output follows. Run34039651759 at86e also passed all required Polyfill jobs. These approvals do not certify the later interruption repair or re-signed head.

The CI jobs retain the designed limits: ordinary verify/test10 minutes; accounted-suite20 minutes; evidence-tests20 minutes. The unchanged600-second pilot budget uses a300-second clean-cost admission threshold. A verified clean suite may succeed while its pilot admission refuses cost/capability. No host AppArmor change was made.

## Real prepared materialization output

Source head96e2e3030535a1b02a9a2058fbb95b2ffec127c9; actual runtime source workspace.ts unchanged through3f9. A new declared npm cache was populated from the two locks, then copied and verified into an independent clone; both installs ran offline with lifecycle scripts suppressed. The browser source contains only prepared browser binaries, not user profiles. Actual output:

```text
exitCode:0; signal:null; deadlineFired:false; outputLimitExceeded:false
SQLITE { x: 263 }
CHROMIUM Prepared browser
wall_seconds:8.66158829
root lock inode independent:true
package lock inode independent:true
native module inode independent:true
source git status:""
cleanup:"destroyed"
```

Full command, allowed private environment, runtime/cache/browser/native/lock digests and inode numbers: `real-materialization-result.json`. This proves real prerequisite operability. It is not a production operator batch, a successful complete-suite receipt, or a claim that a clone is a sandbox.

## GroupMe disposable guard outputs

The superseding no-hardlink-clone matrix has19 registered reverted guards. Each row below exited1 with its owning assertion; the restored55-test snapshot passed55/55. The earlier11 shared-worktree probes remain disclosed above and are not the evidence relied upon.

```json
[
  {
    "probe": "f7-tabs",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "unique-preimage",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "private-env",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "output-cap",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "authority-env",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "raw-identity",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "cost-boundary",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "attribution",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "deadline",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "materializer",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "preflight-marker",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "survivor-backstop",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "clean-focused",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "judge-reuse",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "native-symlink",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "long-private-path",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "actual-plan-retention",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "logical-path-identity",
    "revertedExit": 1,
    "specificAssertionFailed": true
  },
  {
    "probe": "focused-source",
    "revertedExit": 1,
    "specificAssertionFailed": true
  }
]
```

Additional baseline/clock fixture at the later regression-only head: real clean authority precedes changed retained bytes, missing retained bytes, and virtual +600001ms. Each stops before both operators: exactly one clean issued/completed receipt, zero operator admissions, clean clone already disposed. `groupme-baseline-boundary-probes.json`: retained-byte-loop mutant1/restored0;600-second-gate mutant1/restored0. Full GroupMe56tests56pass0fail0skip0cancel0todo,17.148s. A fourth virtual +7200001ms scenario also refuses through the stricter600-second gate, with neither operator issued. The independent two-hour reuse branch is not claimed exercised.

Destination workflow head binding: clean0/mutant1/restored0. Scoped TypeScript0. Canonical destination contracts7/7 pass. Actual child concurrency observes at most2 children across4files. New accounting aliases at3f9 all verify: mutation-falsification exit0/23.308791918680072s; accounting exit0/18.457092217169702s; migration-oracle exit0/2.055922830943018s. Their retained quartets remain snapshot-specific.

## Source-port coverage loss, not resolved baseline failures

Fourteen instance-specific server title-membership tests dropped per F2; these do not become resolved BASE failures or offset against new destination counts:

- keeps every candidate-added PostgreSQL skip title in the exact receipt mapping
- keeps the unscoped fold deadline PostgreSQL skip title in the exact receipt mapping
- keeps the source-revision projection-fault PostgreSQL skip title in the exact receipt mapping
- keeps the manifest-receipt PostgreSQL skip title in the exact receipt mapping
- keeps the checkpoint-dependency parity PostgreSQL skip title in the exact receipt mapping
- keeps the source-revision stale-publication PostgreSQL skip title in the exact receipt mapping
- keeps the source-revision trigger-omission PostgreSQL skip title in the exact receipt mapping
- keeps every active-run-summary-zero-spine PostgreSQL skip title in the exact receipt mapping
- keeps every browser-surface PostgreSQL skip title in the exact receipt mapping
- keeps every fleet-migration and scheduler-upgrade PostgreSQL skip title in the exact receipt mapping
- keeps the device-ack-semantic-capacity device-ingest PostgreSQL skip title in the exact receipt mapping
- keeps the setup-binding promotion PostgreSQL skip title in the exact receipt mapping
- keeps the Explore upcoming PostgreSQL skip titles in the exact receipt mapping
- keeps every run-history-interrupted-migration-reconciliation PostgreSQL skip title in the exact receipt mapping

Re-expressed assertion-level obligations:
- Suffix classification: former MCP suffixless path now helper-or-fixture; suffix execution remains. Generic synthetic reference-implementation path normalization remains unchanged.
- Named profile baseline uses neutral fixture reasons; duplicate mapping rows call production validator; shared/scoped fixture-default/fixture-optional rows exercise exact stale/unconfigured/unknown-profile rejection. Structured skip mapping now uses actual retained Amazon title; string/suffix/exact precedence retained.
- Graph: direct tooling leaves plus exactly polyfill-connectors authority-runner; recursive authority leaves forbidden, public canonical aliases permitted. Ownership covers actual suites and overlap rejects; absent site/scratch-suite assertions removed.
- Environment: FIXTURE_PARENT_TOKEN/ROOT are stripped, unrelated sentinel retained, malformed/duplicate/set-unset conflicts reject; omitted environment_unset on former scratch path is allowed. Dropped omitted/partial-five-pdpp-name rejection by intentional policy removal.
- Six literal destination fixture mapping names asserted exactly. Default skip baseline pending real stock-host measurement; no observed local count copied into hosted contract.
- N3 adds a real spawned4-file concurrency assertion to M's four argument contract tests; no real-child coverage reduction. Generated prerequisite fixture replaces absent apps/site alias instance, proving import failure before prepare and success after prepare plus ignored-write and failure propagation.


## Complete earlier baseline comparison

# Baseline versus candidate observation comparison

**Scope:** B `3f41ef9b18c18818745ecfb7a389657c231634a4` versus package-suite snapshot `2dcb56b7d99479855ec7d64bb9b82698929f30ca`. Both source checkouts were queried with `git rev-parse HEAD` and matched those values. This is NOT a comparison against later candidate commits or the final PR head. Inputs are retained local logs and frozen-reporter JSONL; no new suite execution was performed by this comparison. These are not authority receipts.

## Observed outcomes

| Run | Revision | Tests | Pass | Fail | Cancel | Skip | Todo |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| normal | baseline | 5162 | 5099 | 0 | 0 | 63 | 0 |
| normal | head | 5168 | 5104 | 1 | 0 | 63 | 0 |
| supplemental | baseline | 5162 | 5099 | 0 | 0 | 63 | 0 |
| supplemental | head | 5168 | 5105 | 0 | 0 | 63 | 0 |
| root-tooling | baseline | 138 | 131 | 7 | 0 | 0 | 0 |
| root-tooling | head | 138 | 131 | 7 | 0 | 0 | 0 |

Ordinary baseline exited0 in389.454s; candidate ordinary exited1 in403.796s. Candidate normal failure remains visible: `packages/polyfill-connectors/connectors/slack/slackdump-runtime.test.ts` → **runSlackdump: a steadily-progressing dump outlives its budget (stall, not total runtime)**, error `slackdump_timeout`, multiplicity1. This is a newly observed failure relative to the ordinary baseline. It is not erased by later passing observations and is not labelled a proved pre-existing failure.

Both supplemental runs exited0 (baseline370.220s, candidate376.176s). Their file-qualified failure multisets are empty: introduced0, resolved0, unchanged0. This narrower observation does **not** establish that the ordinary candidate had no introduced failures. Three focused repetitions on B and three on the candidate each passed one test; `slack-timing-probe.json` and six `slack-timing-*.log` files retain them. These show nonreproduction in those focused runs, not a proved scheduling/flakiness root cause or resolution. No source repair is attributed to those passes.

## Selection and identity accounting

The frozen supplemental runner used all five package globs, the exact GitHub exclusion, Node24.15.0, tsx, file concurrency2 and120000-ms timeout on both revisions. Both retained commands use the same frozen reporter digest `822114b13dc7739643de0026844be9cff4d5f4486adb82fe226b60ff6a6f604e`; that digest was independently recomputed from retained reporter bytes. Input/output paths and cwd differ by the named revisions. The supplemental plan preserves common-file order; the candidate ordinary runner intentionally sorts, so supplemental execution order is not claimed identical to candidate ordinary order.

Selected files:364→365. Added only `packages/polyfill-connectors/scripts/run-tests-accounting.test.mjs`; removed0. The existing `packages/polyfill-connectors/connectors/github/index.test.ts` exclusion stays outside the selection. Terminal identity multisets use `(root-relative file, full_name including emitted ancestors, local name, type, nesting)` and preserve multiplicity; they do not key by test ordinal or source positions. There are no missing identity fields or duplicate identity tuples in either recorded stream. Baseline has5201 terminal events (5162test+39suite); candidate5207 (5168test+39suite). Added6 test terminals, each multiplicity1, all in the new runner contract file; removed0. Exact ordered file lists and every added identity are retained in `baseline-comparison.json`.

Added tests, all under `packages/polyfill-connectors/scripts/run-tests-accounting.test.mjs` with no parent suite (nesting0):

- authority and ordinary modes execute the same five-pattern real children and preserve exact counts (multiplicity1)
- diagnostics preserve nested sibling names, todo and cancellation from real children (multiplicity1)
- missing or malformed accounting reporter output fails closed (multiplicity1)
- real assertion failure, loader failure and signal cannot become a successful runner result (multiplicity1)
- the destination-authored consumed/configured join rejects a stale mapping after a real run (multiplicity1)
- zero, omitted, extra, duplicate, reordered selection and wrong profile reject before a child executes (multiplicity1)

## Skip metadata is not new coverage

Both supplemental streams have63 skips. Exactly52 shared test identities changed only from boolean skip `true` to explicit reason strings, all in `packages/polyfill-connectors/src/scenario/isolation-mechanism.test.ts`; their terminal event remains `test:pass` with skip truthy and todo false. These are intentionally relabelled existing skips, not52 newly skipped or exercised tests. No shared test changed executed/skipped status. The remaining11 skips are unchanged, including6 boolean fixture skips which the accounting mapping layer names separately. Exact before/after reason values and full per-test identities are preserved without normalization in `baseline-comparison.json`.

Converted skip reason counts:

- `requires usable bwrap and unshare bind mounts`: 5
- `requires usable bwrap prerequisites`: 1
- `requires usable unshare bind mounts`: 23
- `requires usable unshare prerequisites`: 19
- `requires usable unshare`: 4

The skip labels describe this local nonroot environment; they are not hosted stock-CI calibration. Earlier inverse-substitution evidence (`primitives-skip-preservation.txt`) separately proves that the55 source metadata changes preserve all original predicates and test bodies. Runtime52 skips differs from55 source sites because predicates and loops have different populations.

## Existing root failures remain failures

The exact15-file root tooling/runner/installer/schema argv is identical in `baseline-root-tooling.json` and `head-root-tooling.json`. Both exit1 with138tests,131pass,7fail,0skip/cancel/todo,7suite containers. Leaf failure multisets: introduced0, resolved0, unchanged7, each multiplicity1:

- `playwright-runner/result-classifier.conformance.test.cjs` → playwright-runner/result-classifier.conformance.test.cjs (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > chatgpt-pdpp: metadata file exists and has scopes (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > chatgpt-pdpp: script file exists (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > github-pdpp: metadata file exists and has scopes (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > github-pdpp: script file exists (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > whoop-pdpp: metadata file exists and has scopes (multiplicity1)
- `scripts/test-connectors.test.cjs` → connector metadata > whoop-pdpp: script file exists (multiplicity1)

The root logs additionally report the failed `connector metadata` suite container and `schema files` suite construction failure; those are kept distinct from the seven leaf tests. The schema-files failure appears as an eighth failure-detail block in both logs and must not be turned into an eighth counted test. Exact file/line/column/name/type observations are in the JSON companion. Ancestor `connector metadata` was confirmed from the unchanged test source and the logs' suite headings; root runs did not retain structured diagnostic streams, so this is a bounded source/log join, not a claimed complete per-assertion root diagnostic trace. Failures remain out of scope, not resolved by this port.

## Retained inputs and limits

Read `baseline-normal.log`, `head-normal.log`, their command JSON, `baseline-supplemental.json`, `head-supplemental.json`, `baseline-diagnostics.jsonl`, `head-diagnostics.jsonl`, both root-tooling logs/JSON, `frozen-diagnostics-reporter.mjs`, and Slack probe artifacts. Exact comparison data is `baseline-comparison.json`; reproduction script is `compare-baseline.py`.

Ordinary logs provide terminal totals and the named failure, not the frozen reporter's complete per-file event stream. Supplemental selected argv and diagnostics supply the exact identity comparison; they do not retroactively add missing diagnostics to ordinary runs. Passing later-head CI or focused reruns must be reported separately at their own heads. Confidence is high in the computed retained-data differences; the cause of the ordinary Slack timeout remains unproven.

## File attribution detail

All364 baseline and365 candidate selected files have corresponding file-summary events. Terminal event source locations cover356 and357 distinct files respectively: nine pilot-fixture entry files register tests through `packages/polyfill-connectors/src/pilot-fixture-test-helper.ts`, so Node attributes those terminals to that helper. This is unchanged across revisions. The comparison preserves that actual helper path and connector-qualified names; it does not fabricate entrypoint attribution. Exact nine-file lists are in the JSON companion. Summary coverage is not a claim of independent per-file authority certification.

The current unsorted candidate supplemental result is explicitly weaker than a candidate ordinary-order reproduction. Parent plans a separate final-head sorted supplemental run with the same reporter. It must be reported at its own head and cannot overwrite the retained baseline or retroactively replace the ordinary Slack failure.

## Transaction guard outputs and limits

# Bounded transaction and retention guard falsification

Executed2026-09-06 with Node24.15.0 in a disposable, no-hardlink Git clone of `ee6f5ee83bc59e14fb5b78832d683298e0c12581`. The clone used the already installed root dependency bytes via an explicit local symlink; this is test isolation, not a workspace-containment claim. No source checkout files were mutated. The clone was removed after exact logs were retained. Source `scripts/mutation-falsification/evidence-store.ts` SHA-256 before and after the experiment is `22b0d91a5dc57dbc5c85c3cb91d8d6132c24db145a6d22aea920f8ee9baa340c`, byte-identical to H62473d87b.

Four independent production-guard reversions were tested against the unchanged owning source tests. Every selected test set passed before its mutation, exited1 with the mutation, and passed after restoration. Exact commands, substitutions, output, source digest and clone identity are retained in `transactional-guard-probes.json` and `transactional-reverted-*.log`. Reproduction script: `transactional-guard-probes.py`.

| Guard reverted in disposable clone | Specific observed failure | Before / mutant / restored |
| --- | --- | --- |
| Exclusive ledger admission: `open(lockPath,"wx")` → `"w"` | The real two-process admission test observed **2 admitted attempts**, expected1. |0 /1 /0 |
| Atomic replacement of the transaction marker: staged temp+rename → direct `"w"` overwrite | At the existing injected crash cutpoint, retained marker phase was **receipt_committed**, expected the prior **started** phase. |0 /1 /0 |
| Recovery receipt's required observations validator | A forged recovery missing observations was accepted; `assert.rejects` failed with **Missing expected rejection**. |0 /1 /0 |
| Retained-byte admission limit | An over-budget planned attempt was accepted; `assert.rejects` failed with **Missing expected rejection**. |0 /1 /0 |

The lock probe selected both the real two-process admission test and concurrent publication test. Admission failed under the mutant; concurrent publication **passed in that one mutated run**. Therefore this is falsification of the admission guard, not proof that the concurrent-publication test reliably detects every removed-lock schedule. Neither test is hidden or dropped; raw output records1pass/1fail in the mutated run and2pass in each clean/restored run.

The transaction-marker probe failed at the marker-preservation assertion before its later admission assertion. It proves the atomic replacement regression is detected at that simulated cutpoint. It does not claim the mutated scanner admitted a half-commit, actual power-loss durability, or that every transaction boundary has independently been guard-reverted. This cutpoint is implemented by the source test's injected exception, not an actual host crash.

The forged-recovery probe independently demonstrates false retirement when the shared writer/reader observations validator is removed. Other recovery fields and all interrupted-transaction reconciliation branches are still covered by carried tests; they are **not all independently mutation-tested by this bounded run**.

Earlier independently retained same-H-runtime probes `primitives-reverted-receipt-digest.txt` and `primitives-reverted-receipt-validation.txt` demonstrate that rewriting a chained completed receipt or adding an unknown receipt field is detected; those records have their own fixture identities and outputs. The full carried test run also exercises crash boundaries, replay, corruption and recovery. Passing that suite is not relabelled proof that every guard can fail. No mutation score, exhaustive-falsification claim, or new GroupMe operator evidence is produced here.

Confidence is high in the four observed failure/restoration results and the unchanged source digest. Broader filesystem crash behavior and exhaustive transactional falsification remain outside this bounded evidence.

## Earlier §8 coverage audit (snapshot; superseded additions follow)

# DESIGN §8 executed coverage audit

2026-09-06; bounded maker-side audit, not independent acceptance. Paths below are relative to `.mutation-falsification-evidence/`. This is an evidence inventory, not a mutation score or pilot result. “1/0” means mutated/reverted-guard test exit 1, restored test exit 0. GroupMe individual mutant exits are in `groupme-disposable/groupme-reverted-results.json`; restoration is the common `groupme-disposable/groupme-disposable-final-restored.log` (55/55), not a separate restored run per mutation. Seven owned source hashes match ee6f5ee in `groupme-disposable/assigned-source-identity.json`. Later parent HEAD validation is a separate obligation.

| §8 row | Retained executed evidence and exits | Gap or strength limit |
|---|---|---|
| F7-1 FIRST exact tabs | `groupme-f7-first-before.log`; `groupme-disposable/groupme-reverted-f7-tabs.log` 1 / common restored 0; unique preimage counterpart also 1/0. | First exact mismatch was observed against imported H. Original shared-source reverted probes violated fixture-only instruction; all 11 were superseded with disposable reruns, without erasing deviation. |
| M byte identity and removed policy | `destination-contract-reverted-identity.log`, `destination-contract-reverted-policy.log` each 1/0; `accounting-F1-reintroduced.log` / `accounting-F1-restored.log` 1/0; `destination-contract.log` 6 pass. | Authority byte mutation executed; reporter equality positive executed but no separate reporter-byte mutant located. Contract test covers removed policy, former MCP helper, unknown profiles and old title. Not every adapted policy branch has separate reverted evidence. |
| F7-3 actual root leaves | `root-loader-probes/results.json`, `root-browser-loader-probes/results.json`, `root-loader-probes/issued-leaf-equality.txt`; six required plus local browser have real nonzero events. Each throwing run exit1 with unique sentinel. Clean exits: anthropic0/openai0/installer0/runner1/schemas0/tooling1/browser0. | Runner/tooling baseline failures persist; throw sentinel, not red exit alone, proves loader reach. Optional artifact-chatgpt/github/whoop unexecuted. Local symlink-provisioned probes do not prove isolated materialization. |
| F7-4 cost | `groupme-disposable/groupme-reverted-cost-boundary.log` 1/0; current-head suite covers missing/stale/wrong identity, 300000 admit, 300001 refuse and changed artifact. `head-accounted-preflight.log`, `short-accounted-preflight.log` retain real failed measurements. | Latest inspected short preflight is failed authority, not a clean reusable cost. Parent owns final receipt/cost; no elapsed inferred from file count. |
| F7-5 differential | `primitives-hermetic.tap` 3 pass; `primitives-final.tap` 216 pass. Two independent HOME/TMPDIR/cwd fixtures, twice each, legacy/structured byte equality. `primitives-reverted-root-loader.txt` 1/0. | Actual hermetic comparisons executed; no separate human-output-byte mutation found. |
| Backstop env passthrough | `groupme-disposable/groupme-reverted-authority-env.log` 1/0; current-head owning real-child sentinel passes. | Real private HOME/TMPDIR/cache and absent ambient secret observed. |
| Discovery and issued population | `accounting-runner-final.log` 6 pass; `accounting-closure-final.log` 6 pass; `accounting-unit-final.log` 32 pass. Real five-pattern ordinary/authority population, zero/omitted/extra/duplicate/reordered selection, unowned file and empty include negatives. | No separate final-source reverted guard for each scripts pattern or selection permutation located. Negative input fixtures execute real children or prove no child spawn. |
| Authority identity/protocol/skip | `accounting-unit-final.log`, `accounting-closure-final.log`, `accounting-runner-final.log` pass real-child and protocol-negative fixtures. Protocol error after child0 has nonzero matching terminal/completion/receipt. N1 `accounting-N1-reverted.log` / `accounting-N1-restored.log` 1/0. | N1 consumed/configured join is destination-authored and exercised. Generic identity mutations execute in unit fixtures; not a separate reverted guard for every nonce/tree/profile/command/count/replay field. |
| Canonical frontdoors | `destination-contract-reverted-final-ratchet.log`, `destination-contract-reverted-yaml-field-order.log`, `destination-contract-reverted-yaml-defaults.log`, `destination-contract-reverted-computed-wrapper.log` each 1/0. | Lexical supported-command policy; arbitrary obfuscation, generated code, remote/composite actions not certified. Earlier two-hop/direct-suffix results can be masked by overlapping final guards. |
| Missing prerequisites; clean/mutant npm | `groupme-disposable/groupme-reverted-materializer.log`, `groupme-disposable/groupme-reverted-native-symlink.log`, `primitives-reverted-root-loader.txt` 1/0. `accounting-unit-final.log` generated import before/after prepare. `real-materialization-result.json` real both npm roots, SQLite query, Chromium launch exit0. Survivor whole-batch fixture executes clean and mutant npm paths. | Cold package-cache refusal and scripts-suppressed paths executed. Survivor uses fixture tsx/playwright and real SQLite bytes. No complete per-prerequisite removal matrix located for reporter/parser/native/browser in both clean and mutant full production paths. Actual materialization source is recorded earlier HEAD, not final pilot. |
| Byte identity, credentials and writable sharing | `groupme-disposable/groupme-reverted-raw-identity.log`, `groupme-disposable/groupme-reverted-private-env.log`, `groupme-disposable/groupme-reverted-judge-reuse.log`, native-symlink, actual-plan-retention, logical-path-identity all 1/0. `real-materialization-result.json` source unchanged and independent inode observations. | Binary/judge tampering and secret sentinel real; not separate final guard removals for every lock/cache/policy digest. |
| Transaction/crash/recovery | `transactional-guard-probes.json`: ledger-lock, atomic-transaction-marker, forged-recovery-observations all before0/mutant1/restored0; corresponding `.log` files. `primitives-reverted-receipt-digest.txt`, receipt-validation 1/0. `primitives-final.tap` real two-process admission, crash boundaries, corrupt markers, half-commit refusal and complete-only reconciliation. | Strong real-process and on-disk fixture coverage; no production pilot claim. |
| Retention/budget/cleanup | `transactional-guard-probes.json` retained-byte-budget before0/mutant1/restored0. `primitives-reverted-receipt-digest.txt` 1/0. `groupme-current-head-final.log` cleanup failure/quarantine/helper await tests pass; retained mutant authority bytes read after clone disposal in survivor fixture. | Cleanup failure is dependency-injected helper fixture, not real OS deletion failure through whole batch. Whole-batch changed/deleted clean-focused artifact scenarios now pass after real clean authority, with only one clean receipt and no operator admission; `groupme-baseline-boundary-final.log`, `groupme-reverted-baseline-bytes-disposable.log` 1/0. |
| Structured output/control/judge | `primitives-final.tap`: each missing case, duplicate/extra/renamed cases, wrong caughtBy, missing controls, contradictory ok, real seven-case/control/rollback and differential all pass. | Negative structured input fixtures are executed; no separate reverted validator guard for every case, forged judge inventory, or altered human stdout located. |
| Real GroupMe discriminators | `discriminator-clean.log` 23 pass exit0; `discriminator-groupme-page-ceiling-dc-v1.log` and `discriminator-groupme-nonprogress-weakening-dc-v1.log` exit1 each exactly intended existing full-file assertion. `groupme-disposable/groupme-reverted-unique-preimage.log` 1/0. | Disposable production package fixture with target-only mutation and restored clean file; not isolated production pilot, independent repetitions, or end-to-end selectorMiss evidence. |
| Focused conservative attribution/survivor | `groupme-disposable/groupme-reverted-{attribution,survivor-backstop,clean-focused,judge-reuse,focused-source}.log` all 1/0. `primitives-reverted-selector-miss.txt`, normalized-outcome 1/0. | Actual real complete authority rejects forced survivor and remains inconclusive. Loader/signal/timeout/truncation classifier cases partly synthetic result objects; real timeout/output-child probes supplement. |
| 600s/reuse/two hours/abandoned | `groupme-disposable/groupme-reverted-deadline.log` 1/0 real short child deadline; judge-reuse and cost-boundary 1/0; quarantine later-scan tests pass. | No actual two-hour whole-batch elapsed probe. Whole-batch virtual clock advances +600001ms at a real clean authority child marker; `groupme-baseline-boundary-final.log` proves both registered operators remain unissued. `groupme-reverted-batch-600-disposable.log` mutant1/restored0. Missing/changed baseline bytes also refuse before first operator. Two-hour branch is not independently demonstrated (600s gate preempts it). Filesystem copy/hash/cleanup lack hard cancellation. |

Strict chronology: multiple semantic tests were added after implementation; reverted sensitivity does not retroactively satisfy failing-test-first. The GroupMe journal documents the original 11 shared-runtime mutation deviations and the complete compliant replacement matrix. Current coverage is substantial but the full literal §8 plan is not wholly demonstrated. Final clean complete-suite receipt, baseline comparison, normal commands, hosted profile calibration and independent SHIP judgment remain parent-owned gates.


## F1–F10 implementation disposition

| Resolution | What the implementation proves |
|---|---|
|F1|M authority/reporter byte pins; pdpp inventory/receipt policy removed, six destination mappings retained; actual reverted-policy and mapping-join failures.|
|F2|Destination global ownership and real N→N−1 orphan rejection; fourteen omitted Postgres titles and all instance-assertion dispositions carried above.|
|F3|Separate20-minute jobs; actual local and hosted accounted measurements; verified430.781-second cost refuses the300-second admission threshold.|
|F4|Destination-authored five-pattern runner executes real children, checks issued selection before spawning, drains output, propagates failure and emits one actual accounting result.|
|F5|All23 root executable paths catalogued; six required leaves plus browser executed and throwing siblings detected; three optional artifact profiles explicitly unexecuted.|
|F6|All five source Markdown records preserved byte-for-byte after provenance headers; omitted YAML's schema/created fields and link relocation map retained.|
|F7|Whitespace FIRST, root loaders, cost boundaries, hermetic differential, actual env sentinel and guard-reversion outputs retained; remaining scope limits listed below.|
|F8|Stock profile retains namespace refusal; no CI operator batch or AppArmor change; zero interpreted trials.|
|F9|Owner defaults remain visible: no scenario bins, docs/decisions placement, exact-grandfathered command ratchet, no AppArmor relaxation.|
|F10|Live #81 head rechecked repeatedly, including14:39 UTC, still3f41ef9b18c18818745ecfb7a389657c231634a4; merge-base equals that SHA.|

## Successful hosted receipt, with exact scope

# Independent hosted receipt audit

PASS: GitHub run34038751216 artifact9991127030, exact tested HEAD `3f9e190360fca045b6823683aa9ed5b4ae18a483`. Current branch at audit `a5b53afc09ebf9854f4324ed348443f7a6ad1671` is newer and is not covered by this receipt.

Full `verifyReceipts` passed with consume:false against an independent no-hardlink clone checked out at the tested HEAD: polyfill-connectors/default verified and required. Verifier checked source and selected tree hashes, exact manifest, authority/completion/transcript SHA256 bindings, nonce/run identity, transcript result, timing, full selection and exact expected skip map. Included artifact manifest SHA256 `f8a8fa9ebcd622d1fefe2c1e79b99ca36b538d854fa2bd2b9162da66f4ea4a86` matches receipt.

Independent diagnostics:365 unique terminal files exactly equal issued files;5168 assertions5074pass0fail94skip0cancelled0todo. The complete fifteen-reason skip map exactly equals the hosted manifest. All retained clean-cost artifacts independently pass byte-size and SHA256 checks.

Clean cost: 430781ms; verified=true; namespaceAvailable=false. Admission remains false with reason clean_backstop_exceeds_300_seconds, blockedPilotCount1, operatorAttempts0, interpretedTrials0, and both operators explicitly not run. This successful test receipt does not admit the mutation batch.

Local short-path run `6268fce4-0877-40e1-ad08-d059ba40bd76` at `d6660214b6d3a3001ca1017ac17cca120e79551e`: 5168assertions 5102pass 0fail 66skip;365 unique terminal files exactly match its selection; clean elapsed380827ms. Child exit0; enclosing authority process exit1 reports exact skip-baseline mismatch. No failing diagnostic terminal and no ENAMETOOLONG observation. This local run is not a hosted-profile verification and has no accepted clean receipt. Full maps and aggregates retained in hosted-3f9-valid.json.

## Latest complete local baseline comparison

# Sorted candidate baseline comparison

```json
{
  "baseline": "3f41ef9b18c18818745ecfb7a389657c231634a4",
  "candidate": "86e394e4441a1a47f51b82139b8e5143e543e8e2",
  "reporter_sha256": "822114b13dc7739643de0026844be9cff4d5f4486adb82fe226b60ff6a6f604e",
  "baseline_normal": {
    "tests": 5162,
    "suites": 39,
    "pass": 5099,
    "fail": 0,
    "cancelled": 0,
    "skipped": 63,
    "todo": 0,
    "duration_ms": 389274.19567
  },
  "candidate_normal": {
    "tests": 5168,
    "suites": 39,
    "pass": 5105,
    "fail": 0,
    "cancelled": 0,
    "skipped": 63,
    "todo": 0,
    "duration_ms": 387788.465332
  },
  "baseline_supplemental": {
    "tests": 5162,
    "suites": 39,
    "pass": 5099,
    "fail": 0,
    "cancelled": 0,
    "skipped": 63,
    "todo": 0,
    "duration_ms": 370175.234963
  },
  "candidate_supplemental": {
    "tests": 5168,
    "suites": 39,
    "pass": 5105,
    "fail": 0,
    "cancelled": 0,
    "skipped": 63,
    "todo": 0,
    "duration_ms": 366623.519901
  },
  "selected_before": 364,
  "selected_after": 365,
  "added_files": [
    "scripts/run-tests-accounting.test.mjs"
  ],
  "removed_files": [],
  "candidate_order_sorted": true,
  "completed_files": 365,
  "removed_terminals": [],
  "failures_introduced": [],
  "failures_resolved": [],
  "failures_unchanged": [],
  "ambiguous_identity_count": 0,
  "shared_helper_note": "Source-location identities may reference shared pilot-fixture-test-helper.ts; selected-file summaries independently prove completion, no fabricated test owner.",
  "added_test_terminals": 6,
  "boolean_to_named_existing_skips": 52
}
```

Ordinary and supplemental commands are separate observations. Baseline retains its original unsorted discovery; candidate follows its current sorted discovery. Both use the frozen external reporter only for the separately labelled supplemental run. The earlier ordinary Slack timeout at2dcb remains a newly observed failure with unproven cause, not erased by this passing run. Root seven-failure multiset remains visible in baseline-comparison.md.

`npm test` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall387.939314s.

`node /home/tnunamak/code/data-connectors-waspflow-impl-263-0906/.mutation-falsification-evidence/run-supplemental.mjs published --sort` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall366.714176s.

`npm run verify` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall2.893658s.

`npm run pack-install-run` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall12.170207s.

`npm run test:mutation-falsification` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall22.152657s.

`npm run test:accounting` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall18.688662s.

`npm run test:migration-oracle` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall2.175778s.

`npm run typecheck:mutation-falsification` at `86e394e4441a1a47f51b82139b8e5143e543e8e2`: exit0, wall0.206152s.

The86e accounting aliases verified real retained receipts: mutation-falsification224/224 across9files; accounting48/48 across6files; migration-oracle48/48 across7files; zero skips/failures. The later interruption repair adds owning tests and is separately validated below. No files under packages/polyfill-connectors changed between86e and repaired59be; that byte comparison does not invent a same-full-head execution or review.

## Additional prerequisite and differential probes

# Final bounded identity and differential probes

Executed 2026-09-06 with Node 24.15.0 in a disposable no-hardlink clone of `a5b53afc09ebf9854f4324ed348443f7a6ad1671`. Root dependency bytes were supplied through an explicit local symlink. The source checkout and pdpp were not mutated. The fixture was deleted after the exact command/output logs were retained.

| Independent mutation | Owning unchanged test | Clean / mutant / restored exit |
| --- | --- | --- |
| Append one comment to M node-reporter.ts | `scripts/test-accounting/node-reporter.ts is byte-identical to M7acd4bac2` | 0 / 1 / 0 |
| Add one human stdout line only inside migration-oracle's structured branch | `legacy and structured modes produce byte-identical human-readable output (structured mode is strictly additive)` | 0 / 1 / 0 |

Each selected test ran once in each phase: one pass before, one failure under the mutation, one pass after restoration. The reporter mutant changed its SHA-256 from `08eceb3aba1fc9f5c997dab11919cb257a785d663fd4fbbf922ba7ce88e605fd` to `19f06b6d0ebadfe1316567bcbb5ef2fba04d430ad55b1b38b3d7b782e22d148e`. The stdout mutant failed on the exact additional `DISPOSABLE EXTRA STRUCTURED HUMAN OUTPUT` line. None of the seven oracle cases, the positive control, or rollback logic was changed to force differential failure. This targets stdout additivity; the separate existing two-environment/two-repetition positive proof remains separately recorded.

Exact reproduction and outputs: `final-small-probes.py`, `final-small-probes.json`, `final-small-reporter-byte-identity.log`, `final-small-structured-human-stdout.log`.

## Private prerequisite removal probes

First inspected the existing real materialization proof, loader probes, workspace materialization tests and GroupMe survivor fixture. The existing survivor uses a fixture browser and does not supply a complete actual-prerequisite removal matrix. To add bounded actual evidence, created a fresh private workspace from source snapshot `a5b53afc09ebf9854f4324ed348443f7a6ad1671`, then ran the production materializer with the already recorded declared cache/browser/native preparation. Both locked npm roots completed offline with scripts disabled. These dependencies were private materialized copies, not source-node_modules symlinks. Exact preparation digests, isolated environment, commands and outputs are retained in `final-prerequisite-removals.json`; the successful root/package install results are `final-removal-root-install.json` and `final-removal-package-install.json`.

Each removal below was independent, followed by restoration. Removal touched only private workspace bytes. The private workspace was destroyed at the end.

| Removed private prerequisite | Actual check | Present / absent / restored exit |
| --- | --- | --- |
| Root `node_modules/@babel/parser` directory | Unchanged `scripts/test-migration/babel-ast-walk.test.ts` | 0 / 1 / 0 |
| Root `scripts/test-accounting/node-reporter.ts` | Exact root-anthropic manifest leaf argv with sorted selected files and absolute reporter resolution | 0 / 7 / 0 |
| SQLite `prebuilds/linux-x64.node` | Actual better-sqlite3 in-memory database query | 0 / 1 / 0 |
| Entire private Playwright browser directory | Actual headless Chromium launch and DOM text read | 0 / 1 / 0 |

The absent parser reports module resolution failure; the absent reporter reports loader resolution failure; the absent native binary reports missing bindings; the absent browser reports the headless-shell executable does not exist. Individual records are `final-removal-root-parser.json`, `final-removal-root-reporter.json`, `final-removal-sqlite-native.json` and `final-removal-chromium-browser-directory.json`. Reproduction script and aggregate output are `final-prerequisite-removals.mjs` and `final-prerequisite-removals.log`.

The initial browser experiment removed only the path returned by `chromium.executablePath()`. Default headless launch still passed using Playwright's separate headless-shell executable. This is retained in `final-removal-chromium-main-only-initial.json` and `final-prerequisite-removals-initial.log`; it is a corrected probe-selection assumption, not presented as a production fix or a successful negative probe. The final experiment removed the complete private browser directory and observed the expected launch failure.

Limits: these are actual dependency/runtime and one manifest-leaf removal checks after materialization. They do not execute a complete clean and mutated GroupMe operator batch for each missing prerequisite, do not establish a valid final complete-suite authority receipt, and do not fill the whole requested clean/mutant removal matrix. The parser/native/browser checks are owning test/runtime failures, not newly claimed operator outcomes. No production source or test files were added or modified for these experiments.

## Independent review findings and repairs

Independent reviewer: **Codex gpt-6-astra, medium**, separate agent `independent_alignment`, initial exact head86e394e4441a1a47f51b82139b8e5143e543e8e2. Verdict **REVISE**, not SHIP. It found two P1 issues:

1. Backstop interruptions lost their quarantine requirement; failed cleanup could permit a later operator or batch. The destination now retains raw interrupted clean/mutant/focused observations with incomplete markers, quarantines their clones, stops later operators, and refuses unresolved attempt-/quarantined- directories. Preflight p- directories remain allowed. A materialization-failure detail was also corrected to satisfy the receipt schema, after the owning fixture exposed the empty detail. This completes the §5/§8 lifecycle obligation; no source evidence-store behavior was rewritten.
2. The latest seven previously published commits placed DCO after Assisted-by; one later local documentation commit initially duplicated DCO for the same reason. The earlier report's blanket final-trailer claim was wrong. The history was repaired using normal signed `git commit --amend -s -S --trailer 'Assisted-by: AI'` during rebase, with no hook bypass. All18 implementation contribution commits now independently verify correct author/committer, exactly one DCO, good OpenPGP signature and final AI trailer. Nine rewritten source trees compare identical to their pre-rebase trees; old evidence stays labelled with old hashes.

Parent review caught an overbroad first repair that rejected the driver's own preflight directory. An owning fixture first failed, the owned-prefix check fixed it, and a disposable reversion failed again. A focused SIGTERM fixture initially produced exit1 because Node handles that signal; the corrected fixture uses actual focused-parent SIGKILL and preserves the failed intermediate observation as a probe correction.

Final owning suite:58tests58pass0fail0skip0cancel,28.499s; scoped TypeScript0. Six independent disposable guard reversions each fail1 and restore0:

```json
[
  {
    "probe": "backstop-interruption",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  },
  {
    "probe": "mutant-interruption",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  },
  {
    "probe": "unresolved-workspace",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  },
  {
    "probe": "stop-after-cleanup",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  },
  {
    "probe": "preflight-entry",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  },
  {
    "probe": "focused-incomplete",
    "mutantExit": 1,
    "restoredExit": 0,
    "specificAssertionFailed": true
  }
]
```

Re-signed contribution mapping (every listed tree unchanged by the signature/trailer rewrite):

```json
[
  {
    "old": "d6660214b6d3a3001ca1017ac17cca120e79551e",
    "new": "0ffecdf2dc76287c076621dd4bc81d7ef5ddda1c",
    "tree_unchanged": true
  },
  {
    "old": "96e2e3030535a1b02a9a2058fbb95b2ffec127c9",
    "new": "c45faffb14d73e372e186a96ea06263a856b2a88",
    "tree_unchanged": true
  },
  {
    "old": "ee6f5ee83bc59e14fb5b78832d683298e0c12581",
    "new": "07e24a657fcc18a5ca4b4952965b2e5588fb79af",
    "tree_unchanged": true
  },
  {
    "old": "8f3ef75510ff03d65a6fadfddc0a672530af1101",
    "new": "c14c8c36a2a6d03427f12386482eb70476239d5b",
    "tree_unchanged": true
  },
  {
    "old": "3f9e190360fca045b6823683aa9ed5b4ae18a483",
    "new": "684fd4f0e26a07a52eaa574b95630b2a557e2339",
    "tree_unchanged": true
  },
  {
    "old": "a5b53afc09ebf9854f4324ed348443f7a6ad1671",
    "new": "b4b2d1a42b75ffd289186d7bf72ce12876b81bed",
    "tree_unchanged": true
  },
  {
    "old": "86e394e4441a1a47f51b82139b8e5143e543e8e2",
    "new": "6d1c72f56a253214848d902f7d7813e35a0edb2f",
    "tree_unchanged": true
  },
  {
    "old": "6b15932e888f115ae64bc36ac632acae58c142b5",
    "new": "c3fbb45e2ca9905a5582d962139ea3c2269606b8",
    "tree_unchanged": true
  },
  {
    "old": "589fb63a79f0a37ed7b2ea4f060bf22804710e26",
    "new": "59be16318d1fb787be21e506861713169569939d",
    "tree_unchanged": true
  }
]
```

The signing key verified is2E2DA1F8D3D96241ADBAF15FC872885042DA5EBB. Full per-commit outputs are `identity-audit.json`; history repair output and old messages remain local evidence. Fresh required CI and independent delta alignment are requested for the repaired published head; prior approvals remain snapshot-specific.

## Final open items and limitations

1. Require fresh required CI and a valid clean complete-package receipt on the final published head, then independent Claude red-team SHIP and Codex gpt-6-astra medium alignment at that same head. The owner routes the external Claude reviewer and owns merge. Initial independent Codex REVISE and the repairs are explicitly recorded; no Claude verdict is fabricated.
2. The full literal §8 plan is not exhaustively demonstrated: prerequisite removals were actual isolated owning-leaf/runtime checks plus clean/mutant npm-path fixtures, not a full production clean/mutant operator batch for every missing byte. Real OS cleanup failure remains represented by injected cleanup fixtures and actual interrupted-clone quarantine, not a forced host filesystem deletion error. Not every redundant policy/validator guard has its own independent reversion. These limits are not mutation scores or upgraded tasks.
3. The final package-byte-preserving interruption repair and signed/report commits are newer than the last full local before/after comparison. Fresh CI tests the new head; a strict identical-local-environment final-full-head baseline repetition remains an acceptance obligation if the reviewer requires the literal §7/§10 conjunction. No earlier head is silently renamed.
4. Historical qualified1.6 and unchecked2.6/2.7 remain verbatim. No destination production GroupMe operator-level batch or independent survivor triage ran. A valid ordinary/accounted suite never substitutes for those tasks.
5. Three optional root artifact profiles remain unexecuted; seven pre-existing root leaf failures remain visible. The early candidate ordinary Slack timeout has an unproven cause despite later whole-suite passes; no unrelated fix or proven-flake claim is made.
6. Archive local evidence and the PR’s hosted artifacts before90-day expiry, and retain for at least30 days after independent memo review. Review timing is unknown; execution-date retention alone does not guarantee that interval.

Process deviations remain explicit: eleven initial working-tree guard reversions violated disposable-only scope and were superseded by compliant probes; strict failing-test-first was not followed for every repair; the initial candidate supplemental order was wrong and later sorted runs supersede it; the runner allowlist line amendment and exact-head CI checkout adaptation are justified against design§3/§10. Source pdpp was never modified.

No merge, repository/gist creation, pdpp deletion, or #117/#337 closure. Confidence is high in source preservation and recorded deterministic failure/restoration results; full design acceptance is not claimed while these items remain open.
