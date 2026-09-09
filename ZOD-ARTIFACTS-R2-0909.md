# Zod 4.5.4 connector artifact recut

Status: verification complete for PR #87; companion CI pending. This status will be finalized after the remaining checks finish.

## Source selection and merge order

[AUTHORING.md](AUTHORING.md#default-workflow) requires committing canonical source before selecting its exact revision and directs GitHub artifact maintenance to [connectors/github-pdpp/AUTHORING.md](connectors/github-pdpp/AUTHORING.md#maintained-source), whose manifest must remain byte-equal to its pinned upstream source. The repository actually selected by the existing builders is **PDP-Connect/pdpp**. Its canonical manifests are **packages/polyfill-connectors/manifests/{github,chatgpt,whoop}.json**, collector sources are **packages/polyfill-connectors/connectors/{github,chatgpt,whoop}/**, and runtime source is **packages/polyfill-connectors/src/**. These paths and repository are explicit in [the GitHub builder](scripts/build-github-pdpp-artifact.mjs), [the ChatGPT descriptor](connectors/chatgpt-pdpp/artifact.json), and [the WHOOP descriptor](connectors/whoop-pdpp/artifact.json).

The top-level authoring guide names data-connectors as the home of new source. Its migrated packages/polyfill-connectors tree is newer than the published snapshots: GitHub and WHOOP manifests and runtime dependencies differ, and the existing GitHub builder needs runtime files removed during migration. This dependency recut therefore uses historical source maintenance branches in PDP-Connect/pdpp. It does not migrate the published collectors to the newer implementation.

Each selected source commit changes only its manifest version and adds a changelog line stating that bundled Zod 4.5.4 replaces 4.5.2. Collector and runtime source inventories remain byte-identical to the preceding artifact inventories. Later companion commits correct a test-only import order for GitHub and clarify changelog text for ChatGPT and WHOOP; those commits are outside the selected build inputs.

| Artifact | Exact source commit | Companion PR and merge target |
| --- | --- | --- |
| GitHub 0.5.1 | `6d2be0a2a1c052afcffc8ec035190e1dffc3c128` | [#351](https://github.com/PDP-Connect/pdpp/pull/351) → `maintenance/github-pdpp-0.5` |
| ChatGPT 0.1.1 | `2ad6eedce1deecf8e15dcceabe0464ba81d66039` | [#349](https://github.com/PDP-Connect/pdpp/pull/349) → `maintenance/chatgpt-pdpp-0.1` |
| WHOOP 0.1.1 | `4c785e1f5816b09b113f011ab46066f8057d9959` | [#350](https://github.com/PDP-Connect/pdpp/pull/350) → `maintenance/whoop-pdpp-0.1` |

Merge the companion PRs into those maintenance branches first using merge commits, retaining the selected commits and maintenance branches. `gh api repos/PDP-Connect/pdpp` confirmed merge commits are allowed and PR branches are deleted automatically after merge; preserving ancestry keeps the pinned commits reachable. Then merge [data-connectors #87](https://github.com/PDP-Connect/data-connectors/pull/87). No PR was merged during this work. The [release workflow](.github/workflows/publish-connector-release-index.yml) automatically generates release URLs, signs, attests, and publishes after #87 reaches main. No local release signing or workflow dispatch was attempted. Signing after merge is a release step, not a pre-merge blocker.

## Commands and verification

The first command was `timeout 900 git fetch origin main`; it succeeded at main revision `4ce9c0958720651792d65b4fc0b8f5b6f704ddc1`. Before installation or builds, `timeout 900 free -g` reported 124 GiB total, 92 used, 16 free, 32 available, and 15 GiB swap used. `timeout 900 gh pr checkout 87` failed because the branch was checked out elsewhere. `timeout 900 git switch --ignore-other-worktrees deps/zod-4.5.4-artifact-recut` selected the exact PR branch here without changing that other worktree.

All shell commands used `timeout 900`. Scratch clones, separate source checkouts, and logs are under `~/.tmp/zod-artifacts-r2-0909`. No protected checkout was modified. No load generator was used. Full local suites acquired `~/.tmp/suite.lock` with mkdir and released only their acquired lock with an exit trap; suites ran serially. Artifact module tests ran separately.

| Command | Result |
| --- | --- |
| `timeout 900 npm ci` | Exit 0; exact root lockfile installed, including Zod 4.5.4. |
| `timeout 900 node scripts/generate-connector-index.mjs --check` before recut | Exit 1: `chatgpt-pdpp@0.1.0 bundled dependency changed without a version bump: node_modules/zod`. |
| `timeout 900 npm run github-pdpp:build -- --pdpp-root ~/.tmp/zod-artifacts-r2-0909/github-source` | Exit 0; exact GitHub source commit above. |
| `timeout 900 npm run chatgpt-pdpp:build -- --pdpp-root ~/.tmp/zod-artifacts-r2-0909/chatgpt-source` | Exit 0; exact ChatGPT source commit above. |
| `timeout 900 npm run whoop-pdpp:build -- --pdpp-root ~/.tmp/zod-artifacts-r2-0909/whoop-source` | Exit 0; exact WHOOP source commit above. |
| `timeout 900 node scripts/generate-connector-index.mjs` | Generated connector-index.json with 21 connector entries. |
| `timeout 900 node scripts/generate-connector-index.mjs --check` after recut | Connector index and artifacts are up to date. |
| `timeout 900 node ~/.tmp/zod-artifacts-r2-0909/verify-artifacts.mjs "$PWD"` | All three PASS: canonical manifest bytes, unchanged collector/runtime source, registry/index/tarball hashes, bundled Zod 4.5.4 file hashes. |
| `timeout 900 env PDPP_GITHUB_SOURCE_ROOT=$HOME/.tmp/zod-artifacts-r2-0909/github-source npm run github-pdpp:test` | 7 passed, 0 failed, 0 skipped. Includes dirty-source isolation, legacy package preservation, install/verify/tamper detection, and mocked START → RECORD/STATE → DONE collection without credential leakage. |
| `timeout 900 env PDPP_CHATGPT_SOURCE_ROOT=$HOME/.tmp/zod-artifacts-r2-0909/chatgpt-source npm run chatgpt-pdpp:test` | 4 passed, 0 failed, 0 skipped. Includes canonical bytes, dirty-source isolation, installation/provenance tampering, and mutated bundled Zod rejection. |
| `timeout 900 env PDPP_WHOOP_SOURCE_ROOT=$HOME/.tmp/zod-artifacts-r2-0909/whoop-source npm run whoop-pdpp:test` | 3 passed, 0 failed, 0 skipped. Includes byte-equal rebuild from the committed tarball and installation/provenance-tamper detection. |
| `npm run connector-index:test && npm run installer:test && npm run pdpp:authoring:check` inside the timeout/lock wrapper | 12 index/contract tests, 45 installer tests, and 3 authoring tests passed. Log: `~/.tmp/zod-artifacts-r2-0909/full-contract-2.log`. |
| Remaining commands from `.github/workflows/contract-guardrails.yml` inside the timeout/lock wrapper | All passed: manifest validation/normalization, scope coverage, 14 artifact/catalog tests, 54-scope catalog, 12 fixtures, page API compatibility, source ID stability, 74 additive schemas, and 782 SPDX headers. Log: `~/.tmp/zod-artifacts-r2-0909/workflow-checks.log`. |

The lock wrapper was:

```sh
timeout 900 sh -c 'until mkdir "$HOME/.tmp/suite.lock" 2>/dev/null; do sleep 5; done; trap '\''rmdir "$HOME/.tmp/suite.lock"'\'' EXIT; npm run connector-index:test && npm run installer:test && npm run pdpp:authoring:check'
```

The direct artifact verifier invokes `assertBundledDependenciesMatch` against installed packages and checks each contained manifest, entrypoint, and provenance hash against the tarball and local files. Each artifact records Zod 4.5.4 with 94 bundled files. Generated manifests, bundles, provenance, tarballs, and index contents were not hand-edited.

| Artifact | Tarball SHA-256 |
| --- | --- |
| GitHub 0.5.1 | `80ad449bc67780d67b7a9723ecff6f224ea8f5177d524fb1274673e28010ba65` |
| ChatGPT 0.1.1 | `715ff5ad3d23afcb0de6bacacd1e9179640cfdfca21616b8746bf437eb1dc770` |
| WHOOP 0.1.1 | `7594fb2ce0f704b256453739c93bbdf5a7e3e469862b3a9dd24ea1e1b0459dba` |

Published old-version release assets were not changed. Standard index generation pruned old source-tree tarballs and wrote new versioned tarballs. Registry versions, URLs, source metadata, build pins, and test/workflow pins agree.

## Defects reproduced and resolved

Initial dirty-source tests failed because scratch sparse checkouts omitted runtime files. Expanding the sparse paths resolved the fixture problem. ChatGPT’s immutable-version test passed after committing the new artifacts, which gave the test its required committed-version baseline.

GitHub’s legacy-preservation test compared unrelated global icon URL revisions as well as connector entries. Its assertion now compares every complete legacy connector entry; all legacy tarball byte comparisons remain. WHOOP’s pinned test assumed an ignored dist file existed. Moving that file away reproduced the CI failure; reading the baseline from the committed tarball fixed it, with all three WHOOP tests passing from that state. Release URL and tamper-error assertions now use the new versions.

Original companion attempts against PDPP main were unsuitable: GitHub’s historical snapshot has no common history with current main, and the freeze guard compared historical ChatGPT/WHOOP trees with current main. Dedicated maintenance bases keep each PR’s source diff limited to its version bump. Fresh checks use those bases. GitHub’s historical formatter also found an import-order error in an unchanged test; its companion corrects that test-only line. Transforming both revisions with esbuild produced byte-equal JavaScript. The final old-reference scan found only the intentional original-copy commit in GitHub’s README; its manifest paragraph now points to the active provenance commit.

## CI and commit integrity

At code commit `7f80ff67c0d70c50c1553e15dd2cd8e759aef82c`, `timeout 900 gh pr view 87 --json headRefOid,statusCheckRollup,mergeStateStatus` reported CLEAN, 13 successful checks, two skipped checks, and no failures. [Contract Guardrails](https://github.com/PDP-Connect/data-connectors/actions/runs/34353686772) passed all three pinned rebuilds and the full contract workflow. Companion CI status is pending final capture.

All project commits created here used Tim Nunamaker <tnunamak@gmail.com>, `git commit -s -S`, `commit.gpgsign=true`, and an `Assisted-by: AI` trailer. `git log --format='%H %an <%ae> %cn <%ce> %G?%n%B'` confirmed matching author/committer, good signatures (G), and both trailers. Source-version commits and later companion corrections follow the same convention.

Confidence is high in package consistency, reproducibility, source preservation, and installer tamper detection. Live account collection and installation of the future signed release have not been run. PR descriptions received an independent plain-language pass and use neutral prose without hard wrapping. DevSpecs orientation succeeded; local feedback is in `inbox/devspecs-feedback.md` and is excluded from the PR.
