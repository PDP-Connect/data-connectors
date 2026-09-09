# Zod 4.5.4 artifact recut — BLOCKED

2026-09-09. **Not ready to merge.** The dependency update is staged, but the documented build procedure cannot assign new artifact versions to the existing pinned canonical manifests. GitHub 0.5.0, ChatGPT 0.1.0, and WHOOP 0.1.0 all bundle Zod 4.5.2. WHOOP is an additional blocker on current main.

Confidence: high for the versioning and signing blockers. All three connectors successfully build against Zod 4.5.4 and their regenerated dependency inventories pass the installed-package version and file-hash verification. This does not prove live collection or an install from a newly signed release; no new canonical tarballs or release signatures were produced.

## Repository and procedure

The first command was `timeout 900 git fetch origin main`, which advanced `origin/main` to `4ce9c0958720651792d65b4fc0b8f5b6f704ddc1`. `timeout 900 free -g` reported 124 GiB total, 79 used, 16 free, and 45 available; swap was 15 GiB used. `timeout 900 git switch -c deps/zod-4.5.4-artifact-recut origin/main` created the requested branch. `timeout 900 gh pr view 83 --json state,headRefName,url,commits` returned `CLOSED`, so the closed Dependabot branch was not used.

The release procedure and executable checks were read before building:

1. [AUTHORING.md](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/AUTHORING.md#L7) requires selecting an exact source commit, building the pinned artifact, verifying its manifest, bundle, provenance and installer path, and publishing only after host bindings are available. Its [generated-file contract](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/AUTHORING.md#L23) prohibits hand-editing generated outputs.
2. [GitHub maintenance](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/connectors/github-pdpp/AUTHORING.md#L41) requires the manifest to remain byte-equal to the pinned upstream manifest. [The GitHub builder](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/build-github-pdpp-artifact.mjs#L16) pins commit `597cc012611df90d07edbed187ba3e3212dbf258` and [rejects manifest differences](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/build-github-pdpp-artifact.mjs#L84). [The generic builder](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/build-pdpp-artifact.mjs#L61) copies the pinned manifest verbatim. Neither builder accepts a version override.
3. [Index generation](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/generate-connector-index.mjs#L496) requires registry and canonical manifest versions to match. It [rejects changed committed versions](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/generate-connector-index.mjs#L525). The [unpublished-draft exception](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/connectors/github-pdpp/AUTHORING.md#L56) does not apply to previously published artifacts, despite source-tree `releaseId: "unpublished"` placeholders.
4. [Bundled dependency verification](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/scripts/pdpp-bundled-dependencies.mjs#L55) compares the installed package version, package metadata hash, each bundled file hash, and the closure hash against provenance.
5. [The release workflow](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/.github/workflows/publish-connector-release-index.yml#L49) generates `connectors-<commit12>` URLs and signature metadata, then [signs and attests](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/.github/workflows/publish-connector-release-index.yml#L70) before [publishing immutable assets and the latest signed index](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/.github/workflows/publish-connector-release-index.yml#L88). [Installer verification](https://github.com/PDP-Connect/data-connectors/blob/4ce9c0958720651792d65b4fc0b8f5b6f704ddc1/packages/connector-installer-core/index.mjs#L29) pins the GitHub OIDC issuer and that workflow's identity at `refs/heads/main`.

`timeout 900 gh release view connectors-48440fead534 --json assets` confirmed published GitHub 0.5.0 and ChatGPT 0.1.0 tarballs and detached Sigstore bundles in the [documented immutable release](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-48440fead534). The tarball digests returned by GitHub were `sha256:685b35ee84e84c287cf4bd6df548b984699de84db7bf69966b5bda54a94aa47b` and `sha256:0188385dbb782cf23a5331f0b05a4dddbab422cc21113b0ba8b5c1f72b42772f`, respectively. Those published assets were not replaced.

`timeout 900 gh release download connectors-latest --repo PDP-Connect/data-connectors --pattern connector-index.json --dir /home/tnunamak/.tmp/zod-artifacts-0909/release-latest` also confirmed that the latest listing includes all three versions, including WHOOP 0.1.0, with Sigstore metadata and asset URLs in [connectors-a39f33e6bbd3](https://github.com/PDP-Connect/data-connectors/releases/tag/connectors-a39f33e6bbd3). WHOOP cannot use the unpublished-draft exception either.

## Verification evidence

All shell commands used `timeout 900`. Scratch source and build outputs are under `/home/tnunamak/.tmp/zod-artifacts-0909`, on disk. No protected checkout was modified. No release was published or merged. No load generator was used.

| Command | Observed output |
| --- | --- |
| `timeout 900 npm view zod version dist-tags --json` | Version and `latest` are `4.5.4`. |
| `timeout 900 npm install --save-dev --save-exact zod@4.5.4` | Exit 0; only Zod version, URL, and integrity changed in the dependency files. |
| `timeout 900 node scripts/generate-connector-index.mjs --check` before rebuild | Exit 1: `chatgpt-pdpp@0.1.0 bundled dependency changed without a version bump: node_modules/zod`. |
| `timeout 900 npm run chatgpt-pdpp:build -- --pdpp-root /home/tnunamak/.tmp/zod-artifacts-0909/pdpp` | Built successfully from `76effa378dc40b269095db6f85682d6a10920f68`. |
| `timeout 900 npm run github-pdpp:build -- --pdpp-root /home/tnunamak/.tmp/zod-artifacts-0909/pdpp-source` | Built successfully from `597cc012611df90d07edbed187ba3e3212dbf258`. |
| `timeout 900 npm run whoop-pdpp:build -- --pdpp-root /home/tnunamak/.tmp/zod-artifacts-0909/pdpp-source` | Built successfully from `4f50aa21c6abd9f796b51b82e408224ee75a0048`. |
| Direct `assertBundledDependenciesMatch` invocation after each rebuild | All three pass against installed `zod@4.5.4`, including file and closure hashes. |
| `timeout 900 node scripts/generate-connector-index.mjs --check` after rebuilding all three | Exit 1: `chatgpt-pdpp@0.1.0 source changed without a version bump`. |
| `timeout 900 git diff --exit-code origin/main -- registry.json connector-index.json artifacts connectors` after restoring experiments | Exit 0; committed artifacts, manifests, provenance, registry and index remain unchanged and mutually consistent. They are incompatible with the newly installed Zod. |
| Final `timeout 900 node scripts/generate-connector-index.mjs --check` | Exit 1: bundled Zod mismatch, as expected with immutable artifacts restored. **The final bundled-dependency/index gate is red.** |

A separate `timeout 900 node --input-type=module` assertion script read each PDPP registry entry, selected its matching index version, verified the tarball SHA-256, extracted the manifest, entrypoint and provenance with `tar -xOf`, and checked each extracted file against both its recorded hash and the local source file. It also compared the manifest version to the registry version. Output: `chatgpt-pdpp@0.1.0: registry/index/tarball hashes PASS`, `github-pdpp@0.5.0: registry/index/tarball hashes PASS`, and `whoop-pdpp@0.1.0: registry/index/tarball hashes PASS`.

The candidate generated bundles and provenance are preserved at `~/.tmp/zod-artifacts-0909/rebuilt/{github-pdpp,chatgpt-pdpp,whoop-pdpp}/`. They retain the old manifest versions and are diagnostic outputs, not releasable artifacts. No generated provenance was hand-edited. Their entrypoint hashes are:

| Connector | Rebuilt `dist/collection-profile.mjs` SHA-256 |
| --- | --- |
| GitHub | `eccb2e15feb322d2786bbb857d29a0ed4e24db96240886706b500cfd2c3e7438` |
| ChatGPT | `b4f0f6aed03d91ceef3e2867421fad2dde561f9170300becd2253270e33537be` |
| WHOOP | `56454ba88d70f462dabce336a118dcd4aa948cb92df72d422e2ec2965db63545` |

To repeat the direct check against the saved candidate provenance with the installed Zod 4.5.4:

```sh
timeout 900 node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { assertBundledDependenciesMatch } from './scripts/pdpp-bundled-dependencies.mjs';
for (const id of ['github-pdpp', 'chatgpt-pdpp', 'whoop-pdpp']) {
  const provenance = JSON.parse(readFileSync(`/home/tnunamak/.tmp/zod-artifacts-0909/rebuilt/${id}/provenance.json`));
  assertBundledDependenciesMatch({ repoRoot: process.cwd(), dependencies: provenance.source_inventory.bundled_dependencies, artifactLabel: id });
  console.log(`${id}: PASS zod@4.5.4`);
}
JS
```

A first shared clone from an existing partial clone lacked some GitHub source objects and failed `git archive`. A fresh filtered remote clone with a sparse checkout under `pdpp-source` resolved that environment issue; the subsequent build succeeded. Build logs are `github-build.log`, `chatgpt-build.log`, and `whoop-build.log` in the scratch directory.

## Exact remaining steps

The first blocker is **AUTHORING step 3: select exact canonical source commits containing new manifest versions**. The existing pinned manifests still declare GitHub 0.5.0, ChatGPT 0.1.0 and WHOOP 0.1.0. Their versions cannot be changed through the documented local build interface. New upstream source commits must be available to CI, or an explicit change to the versioning contract must be agreed. A question about version-only packaging support is pending; no such contract change was made.

For the existing contract, supply canonical source commits with new versions, update the GitHub builder's pinned commit and matching local manifest, update ChatGPT and WHOOP `artifact.json` pins, and update the corresponding registry versions, artifact URLs and source metadata. Update pinned rebuild tests and the ChatGPT source checkout in `.github/workflows/contract-guardrails.yml` to the same exact commits. Suggested next versions are GitHub 0.5.1, ChatGPT 0.1.1 and WHOOP 0.1.1; these are not published or reserved by this draft.

With separate source checkouts at those exact commits, run:

```sh
timeout 900 npm ci
timeout 900 npm run github-pdpp:build -- --pdpp-root /path/to/github-source
timeout 900 npm run chatgpt-pdpp:build -- --pdpp-root /path/to/chatgpt-source
timeout 900 npm run whoop-pdpp:build -- --pdpp-root /path/to/whoop-source
timeout 900 node scripts/generate-connector-index.mjs
timeout 900 node scripts/generate-connector-index.mjs --check
```

Run each relevant suite serially, acquiring `~/.tmp/suite.lock` with `mkdir` and releasing only the acquired lock with an exit trap. Verify pinned rebuilds, installer tamper detection, registry/index consistency and the full contract workflow before removing draft status. Do not use `--allow-unpublished-rebuild` for the old published versions.

The later blocker is **release-workflow signing and publication**. A local key cannot impersonate the `main` workflow identity trusted by the installer. Once valid recuts are on canonical `main`, the release workflow runs automatically for these changed paths. If a manual run is needed, the maintainer must run:

```sh
timeout 900 gh workflow run publish-connector-release-index.yml --repo PDP-Connect/data-connectors --ref main
timeout 900 gh run list --repo PDP-Connect/data-connectors --workflow publish-connector-release-index.yml --limit 5
timeout 900 gh run watch RUN_ID --repo PDP-Connect/data-connectors --exit-status
```

Replace `RUN_ID` with the run for the exact source commit. That workflow generates release metadata, signatures, attestations and the `connectors-<commit12>` release, then updates the latest signed index. Do not dispatch it on the dependency branch: that identity is not accepted by the installer.

## CI state

The existing [main Contract Guardrails run](https://github.com/PDP-Connect/data-connectors/actions/runs/34346959779) passed at `4ce9c0958720651792d65b4fc0b8f5b6f704ddc1`. The closed [PR #83 run](https://github.com/PDP-Connect/data-connectors/actions/runs/34175970200) failed its pinned ChatGPT rebuild.

[Draft PR #87](https://github.com/PDP-Connect/data-connectors/pull/87) supersedes #83. Its dependency commit is `8a62e2ee3b5b607001335403a88a33f8c3d3dbce`. `timeout 900 git log -1 --format='%H%n%an <%ae>%n%cn <%ce>%n%G?%n%B'` confirmed Tim Nunamaker `<tnunamak@gmail.com>` as author and committer, a good signature (`G`), `Signed-off-by`, and `Assisted-by: AI`. The branch was pushed with `timeout 900 git push -u origin deps/zod-4.5.4-artifact-recut`; the draft was created with `gh pr create --draft --body-file` under `timeout 900`.

`timeout 900 gh pr view 87 --json statusCheckRollup` returned 11 successful checks, 3 skipped checks, and 1 failed check at the dependency commit. [Contract Guardrails](https://github.com/PDP-Connect/data-connectors/actions/runs/34350784952) passed manifest validation, normalization, scope coverage, catalog/artifact tests, and installer tests. It failed the ChatGPT pinned rebuild: 4 tests, 3 pass, 1 fail. The successful ChatGPT tests covered the manifest contract, installation with provenance-tamper detection, and rejection of bundled-dependency tampering. `timeout 900 gh run view 34350784952 --log-failed` records the provenance byte mismatch at `test/chatgpt-pdpp/chatgpt-pdpp.test.mjs:120`; the saved log is `~/.tmp/zod-artifacts-0909/pr-87-failure.log`. Later steps in that job were skipped, not passed.

A local installer/contract suite was queued using `timeout 900 sh -c` with `until mkdir "$HOME/.tmp/suite.lock"; do sleep 5; done` and a post-acquisition exit trap to release it. After more than seven minutes, no suite log existed and the command was still waiting for the shared lock. Its exact timeout process was terminated; no tests started and the existing lock was not removed. The successful CI installer/contract steps above provide the test evidence. No local suite pass is claimed.

Final status: **BLOCKED at canonical source version selection, before release signing.** The draft must remain unmergeable until valid new artifacts replace the old-version dependency mismatch. DevSpecs orientation feedback is saved locally in `inbox/devspecs-feedback.md` and is excluded from the dependency PR.
