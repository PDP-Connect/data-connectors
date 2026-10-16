# GroupMe mutation evidence

One official Stryker run per admitted change: Stryker 10.0.0 with default operators, `@stryker-mutator/vitest-runner` 10.0.0, Vitest 4.1.12, and `perTest` coverage. The pins live in `tools/package.json`; `vitest.config.mjs` refuses to load if they differ.

## Scope

- Mutated files: `connectors/groupme/index.ts` and `connectors/groupme/schemas.ts`. Ranges come from the zero-context diff between the merge-base and HEAD.
- A changed GroupMe production file outside that list makes the run `unsupported`. No mutation runs.
- Tests, fixtures, docs, and other connectors are not mutated. A supported file renamed or deleted produces no mutants.
- No blanket exclusions, no score threshold, and no custom operators.

## Run

```sh
npm ci --prefix scripts/groupme-mutation/tools --ignore-scripts --no-audit --no-fund
npm run groupme-mutation -- --mode diff --base <sha> --head <sha> --merge-base <sha> [--report <dir>]
```

- `--head` must be the checked-out `HEAD`, and tracked files must be clean. Otherwise the runner refuses before mutating anything.
- `--report` must not exist. The default is `~/.tmp/groupme-mutation/<head12>-<uuid>`.
- The run takes about one minute for the canary alone and about one minute for the 18-mutant slice on this machine. The inner Stryker timeout is 15 minutes.

## The canary

Every run includes one known-killable production mutation: `curr.created_at < prev.created_at` becomes `<=` in `isAscendingByCreatedAt`. The runner finds it by text at `HEAD`, not by line number. It counts as proven only if all of these hold for the same invocation:

1. The Stryker plan activated this mutant at runtime.
2. Stryker's JSON report marks it `Killed`, and its `killedBy` resolves to the owner test in a native GroupMe file: `ordinary resume: equal timestamps with advancing IDs collect and advance across pages`.
3. The owner test's receipt from this run shows its own assertion failed for this mutant (`actual` `true`, `expected` `false`, owner message).

Missing tests, zero completed tests, compile or runtime errors, timeouts, static activation, a foreign runner, or a receipt from another mutant all leave the canary unproven.

## Outcomes

| Status | Exit | Meaning |
| --- | --- | --- |
| `proven` | 0 | Canary proven. Changed-code proof is `mutation` (with counts) or `none` (no mutants in the selected ranges). |
| `unproven` | 1 | Stryker finished but the canary did not verify. The reason is printed. |
| `incomplete` | 1 | Stryker signalled, timed out, or exited nonzero. This is infrastructure, not a kill. |
| `unsupported` | 1 | A changed GroupMe production file is outside scope. No mutation ran. |

Survivors and timeouts are listed in `summary.json`. They do not change the exit code. Timeouts are never counted as kills. Canary-only runs do not prove changed code.

## Artifacts

In the report directory: `summary.json` (outcome, selection, canary proof, counts, survivors, timeouts), `selection.json`, `stryker.log`, `mutation.json` (Stryker's JSON report), `index.html`, `events/` (Stryker's event-recorder files: plan, tested, report), and `owner-receipt.jsonl`.

The runner reconciles the planned, tested, and reported mutant identities and fails on any mismatch or unknown status. It records wall time only, not CPU or RSS.

## CI

The `GroupMe mutation evidence` job in `.github/workflows/polyfill-connectors.yml` runs this command on the PR head. It is visible and red on failure, uploads its artifacts on every run, and is recorded by the gate as `MUTATION_ENFORCEMENT: optional`. It is not required. Promotion is one switch to `required`, which the root makes after hosted CI reproduces the local evidence.

## Pitfall that produced a false survivor

Stryker runs the vitest config from its sandbox copy. With an absolute `configFile`, the first probe reported `static` coverage and every canary mutant survived, even though the owner test fails when the same mutation is applied to the checkout by hand. A sandbox-relative `configFile` restored `runtime` activation and per-test kills on the same mutants. The canary exists to catch this class of failure.

## Survivor triage: 18-mutant slice

Measured with this runner on `index.ts` lines 1487–1495 and 1528–1529 at `ba0611…`. The slice was selected through a disposable scratch commit that appends a marker comment to those lines, so the diff selects the same ranges. The branch's production bytes are unchanged. Result: 18 planned, 18 tested, 18 reported. Killed 13, Survived 3, Timeout 2.

| Mutant (line:col) | Operator and replacement | Status | Disposition |
| --- | --- | --- | --- |
| 1488:18–37 | `i < messages.length` → `i <= messages.length` | Survived | Equivalent for JSON arrays: `messages[messages.length]` is `undefined`, so `prev && curr` is false and nothing changes. A non-array JSON object with an own key equal to its length can differ. Both versions then fail before any record is emitted, though the error type differs. Argued by reading the code, not tested. |
| 1491:7–19 | `prev && curr` → `true` | Survived | Unresolved malformed-input boundary. Equivalent when page elements are objects. By reading the code (not executed), a JSON `null` element makes the original skip the comparison, emit earlier valid records, and fail at conversion. The mutant fails during the order check, before any emission. Both fail the walk; they differ in partial emission. The partial-emission contract is undecided, so no test pins it. |
| 1491:7–19 | `prev && curr` → `prev \|\| curr` | Survived | Same unresolved null boundary as the row above. |
| 1488:18–37 | `i < messages.length` → `i >= messages.length` | Timeout | Not a kill. On a one-message page the loop never ends. Stryker's timeout is nontermination evidence. |
| 1488:39–45 | `i += 1` → `i -= 1` | Timeout | Not a kill. The index descends forever. |

Killed mutants, one line each, by the tests that fail them:
- The canary `<=` at 1491:23–56 is killed only by `ordinary resume: equal timestamps with advancing IDs collect and advance across pages`.
- The `>=` at 1491:23–56 is killed by five tests, including the same owner.
- The empty progress string at 1529:29–54 is killed by `ordinary resume: forward-fetch progress remains nonblank without pinning copy`.
- The other 10 kills are killed by existing tests, including the >200-page regression `>old-cap discriminator: …` and the forward-walk cursor and non-progress tests.

No domain-specific fault is kept. Generic operators express every changed-code mutant in this slice. The >200-page regression stays in the native suite.

**Global claim:** not made. The two null-boundary survivors are unresolved, and the loop-guard survivor is equivalent only for JSON arrays. Responses are not runtime-validated, so TypeScript types do not settle these cases.
