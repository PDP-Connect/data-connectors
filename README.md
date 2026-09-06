# Data Connectors

This repository is the source home for PDPP Collection Profile connectors. Each implementation lives in `connectors/<key>/` with its `manifest.json`, code, icon, tests, and reviewed scrubbed fixtures. `packages/polyfill-connectors/` contains shared runtime libraries and local development tools. New connector work starts with [Connector authoring](AUTHORING.md). The [PDPP Collection Profile](docs/spec/collection-profile.md) defines the normative connector manifest and protocol.

## Build and verify

Install from the repository root so TypeScript and runtime imports resolve the declared workspace dependencies:

```bash
npm ci
npm run verify --workspace @pdpp/polyfill-connectors
npm test --workspace @pdpp/polyfill-connectors
npm run connector-implementation-index:check
npm run historical-contract:check
```

The package's `npm run pack-install-run` builds a tarball, installs it in an isolated project, and imports every remaining library export. `scripts/build-connector-oci-artifact.mjs` bundles an individual root connector into an OCI artifact. The [connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) covers source, manifest, and fixture review.

## Distribution

Collection Profiles are published as individually versioned, signed OCI artifacts. The source manifest at `connectors/<key>/manifest.json` owns its version and runtime bindings. The root [`connector-implementation-index.json`](connector-implementation-index.json) is generated from these implementations; `npm run connector-implementation-index:check` verifies it.

The legacy Playwright source, runner, and registry have been retired. [`scope-catalog.json`](scope-catalog.json), [`SCOPES.md`](SCOPES.md), [`connector-index.json`](connector-index.json), and [`fixture-index.json`](fixture-index.json) remain as historical public contracts. They are frozen along with the schemas and fixtures they reference. `npm run historical-contract:check` verifies their bytes and references. Do not regenerate them from the new Collection Profile manifests or reuse their legacy scope IDs for raw connector streams.

The root layout changes the private `@pdpp/polyfill-connectors` workspace API: connector implementations, manifest discovery, source-dependent registries, and the local device exporter are no longer shipped in its tarball. Consumers of the previous package must migrate those imports before repinning. The existing data-connect tarball pin and signed legacy artifacts are separate release inputs; changing this source tree does not establish replacement Desktop projections by itself.

## Further references

- [Collection Profile cutover contracts](docs/migration/connector-cutover/CONTRACTS.md)
- [Connector capability map](docs/migration/connector-cutover/capability-map.json)

## Mutation falsification evidence

A passing suite does not show which faults it can detect. The port from
[pdpp #263](https://github.com/PDP-Connect/pdpp/pull/263) carries the evidence
ledger, conservative outcome projection, migration oracle, and two registered
GroupMe faults. It is stacked on [scenario #81](https://github.com/PDP-Connect/data-connectors/pull/81).

Use Node **24.15.0** and npm **11.12.1**. Install the root and package dependencies
separately with `npm ci --ignore-scripts` and
`npm --prefix packages/polyfill-connectors ci --ignore-scripts`. Provision Chromium
from the package with `npx playwright install chromium` before browser tests.

```sh
npm run typecheck:mutation-falsification
npm run test:mutation-falsification
npm run test:accounting
npm run test:migration-oracle
npm run test:polyfill-accounted
npm --prefix packages/polyfill-connectors run verify
npm --prefix packages/polyfill-connectors test
npm --prefix packages/polyfill-connectors run pack-install-run
npm run mutation:groupme-preflight
```

The four accounted aliases route through the authority, which validates global test
ownership, issues an exact selection and verifies the resulting receipt. The
ordinary package command retains its existing output. The manifest catalogs root
suites too; an unselected optional browser or artifact profile is an unexecuted
coverage obligation. The local package suite still excludes its GitHub cross-repo
ingest test. Aggregate accounting does not certify every individual passing event.

Preflight records the complete clean accounted-suite cost before deciding whether
a local GroupMe batch may begin. A missing prerequisite or measured cost above
300 seconds refuses admission to the unchanged 600-second batch budget. Stock CI
runs preflight and unit contracts; it runs no GroupMe operator batch.
`npm run mutation:groupme-pilot` requires the separately prepared, identity-bound
private cache, native dependencies and browser prerequisites described in the
[port design](DESIGN-263-PORT.md). A clone isolates source and writable state for
trusted code; it is not a sandbox.

**NARROW: no destination operator-level batch evidence.** The historical
[decision memo](docs/decisions/mutation-falsification/DECISION-MEMO.md) and
[tasks](docs/decisions/mutation-falsification/tasks.md) preserve the incomplete
GroupMe run/triage (2.6/2.7) and the missing independent review within 1.6.
`recorded_replay` remains withheld; this does not close the broader isolation
evidence boundary. Failed complete-backstop authority remains inconclusive.

Retain `.mutation-falsification-evidence/` outside disposable clones, including
failed/incomplete observations. Keep evidence for at least 30 days after independent
memo review, with a separately retained digest; CI artifacts expire after 90 days,
so archive them before expiry if review is delayed. Hashes bind retained bytes but
do not authenticate their issuer. See [IMPL-263.md](IMPL-263.md) for measured
results, source coverage losses, deviations, and pending acceptance gates.

Owner-reserved defaults: decision records live in `docs/decisions/`; the repository
rejects new direct-test front doors while grandfathering exact existing commands;
scenario bins remain undeclared; AppArmor relaxation remains prohibited.
