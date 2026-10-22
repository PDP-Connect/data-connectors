// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

import { findDuplicateJsonKeys, normalizeFilesystemInputs, deepEqualJson, isCanonicalWebHost } from "./connector-binding-grammar.mjs";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const root = join(schemaDir, "..");
const schema = JSON.parse(readFileSync(join(schemaDir, "connector-manifest.schema.json"), "utf8"));
const profile = readFileSync(join(root, "docs/spec/collection-profile.md"), "utf8");
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

// A committed snapshot of connector-manifest.schema.json as it stood at
// adc6cf821b, PR #62's head, before this PR's binding instances existed.
// This is a file in the repo, not a `git show` call: a git lookup that fails
// (a shallow clone, a rebase that drops the blob) must not make a
// compatibility test silently pass by skipping, which is what the previous
// version of this test did. `readFileSync` with no try/catch means a missing
// or unreadable fixture fails this whole test file loading, not one test.
const oldSchema = JSON.parse(
  readFileSync(join(schemaDir, "fixtures/pre-binding-instances-manifest-schema.json"), "utf8"),
);
const oldValidate = new Ajv({ strict: true, allErrors: true }).compile(oldSchema);

function manifestWith(bindings) {
  return { runtime_requirements: { bindings } };
}

function connectorManifests() {
  const connectorsDir = join(root, "connectors");
  return readdirSync(connectorsDir)
    .map((name) => join(connectorsDir, name, "manifest.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));
}

/**
 * Returns the first-cell values of the first table under `heading`. Every body
 * row is read, and a first cell that is not exactly one code span fails the
 * test instead of being skipped, so a row written in another spelling cannot
 * escape the exact-set comparison.
 */
function tableRowKeys(heading) {
  const section = profile.split(new RegExp(`^${heading}$`, "m"))[1];
  assert.ok(section, `profile must contain ${heading}`);
  const table = section.match(/\n\| *[A-Za-z`][^\n]*\|\n\| *-[^\n]*\|\n((?:\|[^\n]*\|\n)+)/);
  assert.ok(table, `${heading} must contain a table`);
  return table[1]
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => {
      const firstCell = row.replace(/^\s*\|/, "").split("|")[0].trim();
      const key = firstCell.match(/^`([^`]+)`$/);
      assert.ok(key, `${heading} row must name its value in one code span, got ${JSON.stringify(firstCell)}`);
      return key[1];
    });
}

test("the profile binding table matches the schema registry exactly", () => {
  assert.deepEqual(tableRowKeys("### 3.3 Bindings").sort(), [...schema.$defs.registryBinding.enum].sort());
});

test("the profile feature table matches the schema feature enum exactly", () => {
  assert.deepEqual(
    tableRowKeys("#### 3.3.8 Features").sort(),
    [...schema.$defs.bindingFeature.enum].sort(),
  );
});

test("store evidence states its base profiles in one sentence, and conformance stays a separate claim", () => {
  const section = profile
    .split(/^### 7\.1 Store collection evidence \(RUN_COVERAGE_V1\)$/m)[1]
    ?.split(/^### 7\.2 /m)[0];
  assert.ok(section, "profile must define the store collection evidence extension");
  assert.equal(
    profile.split("This extension applies to manifests whose protocol_version is").length - 1,
    1,
    "the base-profile sentence appears exactly once",
  );
  assert.match(
    section.replace(/\s+/g, " "),
    /This extension applies to manifests whose protocol_version is 0\.1\.0, 0\.2\.0 or 0\.3\.0\. Using this extension never makes a runtime conformant to a base profile version it does not fully implement; conformance to the base profile is a separate claim\./,
  );
});

// These are document regressions, not runtime interoperability tests.
function profileSection(heading, nextHeading) {
  const section = profile.split(heading)[1]?.split(nextHeading)[0];
  assert.ok(section, `profile must contain ${heading}`);
  return section.replace(/\s+/g, " ");
}

test("Section 3.4 preserves pre-spawn refusal of unsupported required capabilities", () => {
  const text = profileSection("### 3.4 Human interaction and protocol capabilities", "### 3.5 ");
  assert.match(text, /It MUST reject a connector with an unsupported required capability before spawn\./);
  assert.match(text, /A runtime that implements profile version 0\.2\.0 MUST advertise and support `OBSERVATION`\./);
});

test("Section 3.4 limits the elective exception to readers implementing it", () => {
  const text = profileSection("### 3.4 Human interaction and protocol capabilities", "### 3.5 ");
  assert.match(text, /A runtime that does not advertise a declared capability MUST NOT start that connector, unless the section that defines the capability makes it elective and the runtime implements that elective exception\./);
  assert.match(text, /This exception does not waive any other placement requirement\./);
  assert.match(text, /`RUN_COVERAGE_V1` \(Section 7\.1, which defines it as elective\)/);
  assert.doesNotMatch(text, /an elective capability never blocks spawn/i);
});

test("an elective-aware runtime lacking coverage support may start only after other placement checks", () => {
  const text = profileSection("### 7.1 Store collection evidence (RUN_COVERAGE_V1)", "#### 7.1.1 ");
  assert.match(text, /`RUN_COVERAGE_V1` is an elective capability for runtimes that implement the elective exception in Section 3\.4\./);
  assert.match(text, /Such a runtime that does not support `RUN_COVERAGE_V1` MAY start the connector only if all other placement requirements pass\./);
  assert.match(text, /It MUST omit `START.run_coverage_version`, and the connector MUST omit `DONE.coverage`\./);
  assert.match(text, /The extension is negotiated per run, so an exchange without the request is an ordinary base-profile exchange\./);
  assert.doesNotMatch(text, /An elective capability never blocks spawn|A runtime that does not support `RUN_COVERAGE_V1` starts the connector/);
});

test("base-profile applicability does not promise unchanged-reader compatibility: roll out runtimes first", () => {
  const text = profileSection("### 7.1 Store collection evidence (RUN_COVERAGE_V1)", "#### 7.1.1 ");
  assert.match(text, /Applicability to base profiles 0\.1\.0 and 0\.2\.0 does not imply interoperability with unchanged readers\./);
  assert.match(text, /Old required-only readers that do not support a declared `RUN_COVERAGE_V1` reject the connector before `START`\./);
  assert.match(text, /Rollout MUST be runtime-first: upgrade readers to implement the elective exception before deploying manifests that declare `RUN_COVERAGE_V1`, as required by Section 8\./);
  const versioning = profileSection("## 8. Profile versioning", "## 9. ");
  assert.match(versioning, /A new optional message that an older fail-closed runtime would reject requires capability negotiation and a runtime-first rollout\./);
});

test("coverage inventory requires unique opaque non-empty strings and exact terminal inventory", () => {
  const declaration = profileSection("#### 7.1.1 Declaration and negotiation", "#### 7.1.2 ");
  assert.match(declaration, /A stream MAY declare `coverage_stores`, a non-empty array of unique, opaque, non-empty string identifiers\./);
  const terminal = profileSection("#### 7.1.2 Optional terminal store collection evidence", "#### 7.1.3 ");
  assert.match(terminal, /Each store MUST contain a non-empty `store` identifier and one status\./);
  assert.match(terminal, /each stream's stores MUST equal its manifest inventory, without duplicates or extras\./);
});

test("a connector that uses the extension declares RUN_COVERAGE_V1, and coverage_stores needs that declaration", () => {
  const section = profile
    .split(/^#### 7\.1\.1 Declaration and negotiation$/m)[1]
    ?.split(/^#### 7\.1\.2 /m)[0];
  assert.ok(section, "profile must define declaration and negotiation");
  const text = section.replace(/\s+/g, " ");
  assert.match(text, /A connector that uses this extension MUST declare `RUN_COVERAGE_V1` in `protocol_capabilities`\./);
  assert.match(text, /Declaring `coverage_stores` on a stream, or emitting `DONE\.coverage`, is a use of this extension\./);
  assert.match(
    text,
    /`coverage_stores` is valid only with that declaration, and a validator MUST reject `coverage_stores` without it\./,
  );
  assert.equal(profile.split("A stream MAY declare `coverage_stores`").length - 1, 1, "the stream rule is stated once");
  const streamFields = profile
    .split(/^### 3\.2 Stream declarations$/m)[1]
    ?.split(/^### 3\.3 /m)[0];
  assert.ok(streamFields, "profile must define stream declarations");
  assert.match(
    streamFields.replace(/\s+/g, " "),
    /`coverage_stores` \| OPTIONAL\. Valid only with the `RUN_COVERAGE_V1` declaration of Section 7\.1\.1\./,
  );
});

test("terminal store evidence defines omission, runtime authority, release binding, and retirement", () => {
  const section = profile
    .split(/^#### 7\.1\.2 Optional terminal store collection evidence$/m)[1]
    ?.split(/^#### 7\.1\.3 /m)[0];
  assert.ok(section, "profile must define terminal store evidence");
  const text = section.replace(/\s+/g, " ");
  assert.match(text, /A failed `DONE` MUST NOT contain `coverage`\./);
  assert.match(
    text,
    /In this extension, durable admission means that the durable write path accepted the effect, and outstanding debt means unrecovered durable detail gaps \(Section 5\.6\)\./,
  );
  assert.match(text, /The connector's assertion MUST NOT override runtime evidence/);
  assert.match(text, /debt settlement still follows the detail-gap accounting of Section 5\.6\./);
  assert.match(text, /`scoped: false` supplies no such assertion and MUST NOT support positive coverage for that stream\./);
  assert.match(text, /The artifact digest and manifest fingerprint MUST match a release pair/);
  assert.match(
    text,
    /An unregistered digest, or a digest paired with a different manifest fingerprint, MUST NOT establish positive coverage/,
  );
  assert.match(text, /Omission of `DONE\.coverage` is a new terminal result/);
  assert.match(text, /MUST retire earlier positive evidence under Section 7\.1\.3, whether or not the run includes `STATE`/);
  // A positive covers only its bound collection_scope, and a different release invalidates it.
  assert.match(
    text,
    /A positive covers only the obligation within its bound collection_scope\. It MUST NOT be presented as coverage of a wider view\./,
  );
  assert.match(text, /A different release MUST invalidate the positive, with no exception\./);
});

test("terminal run records order final outcomes by run sequence and commit revision", () => {
  const section = profile
    .split(/^#### 7\.1\.3 Terminal run records and coverage currency$/m)[1]
    ?.split(/^### 7\.2 /m)[0];
  assert.ok(section, "profile must define terminal run records and coverage currency");
  const text = section.replace(/\s+/g, " ");
  assert.match(text, /Coverage is a fact about one run/);
  assert.match(text, /A runtime that implements store collection evidence MUST commit an orderable terminal run record for every run's final outcome, including failure and omitted evidence/);
  assert.match(text, /whether or not evidence was negotiated or the run changed `STATE`/);
  assert.match(text, /successful `DONE` followed by process failure is not a successful run/);
  // Run sequence decides eligibility; commit revision orders coverage-affecting observations.
  assert.match(text, /Run sequence decides eligibility; commit revision orders observations/);
  assert.match(text, /Run starts \| Assign a strictly increasing run sequence before admitting any effect/);
  assert.match(text, /Assign a strictly increasing commit revision/);
  assert.match(text, /never using wall-clock timestamps to decide currency/);
  assert.match(text, /Missing, unreadable or ambiguous sequence\/revision \| Project unknown, not positive coverage/);
  assert.match(text, /no later-committed coverage-affecting observation of a newer-or-equal run exists; earlier-run records remain history/);
  assert.match(text, /Later coverage-affecting observation of a newer-or-equal run \| Retire the positive to unknown/);
  // Run registration retires nothing; an in-flight run leaves the earlier run's fact standing.
  assert.match(text, /Run registration \(a run start that admits no effect\) does not retire a positive\./);
  assert.match(
    text,
    /An in-flight run does not make the earlier run's fact false\. That run stays shown with its as-of: the commit revision and time of its terminal record \(Section 7\.1\.4\)\./,
  );
  assert.match(text, /Disclosed limit: a run that is registered and then crashes before any terminal record or ingested record leaves the earlier positive standing\./);
  assert.match(text, /A run whose start registration failed, so it has no run sequence, still counts as an observed later attempt\. Its terminal record or ingested records retire earlier positives, and it can never itself be eligible\./);
  // Exact replay is idempotent; a conflicting duplicate writes nothing.
  assert.match(text, /Exact replay of the same terminal record \| Return the stored receipt without changing revision or coverage; reject a conflicting duplicate and write nothing/);
  assert.match(text, /Restore that can regress ordering \| Reset positives to unknown/);
  assert.match(text, /Do not improve coverage while later relevant work is unresolved/);
  // Terminal store projections identify the run and commit, not a source snapshot.
  assert.match(text, /A terminal store coverage projection MUST carry the run identifier and sequence, release artifact digest .* and terminal record commit revision and time/);
  assert.match(text, /Owner-facing text MUST identify that run and commit time, not imply a source snapshot at commit time/);
});

test("the coverage-fact rule is stated once, and the implementer note is linked once", () => {
  assert.equal(profile.split("Coverage is a fact about one run").length - 1, 1);
  const coverageFacts = profile
    .split(/^#### 7\.1\.4 Coverage facts$/m)[1]
    ?.split(/^#### 7\.1\.5 /m)[0];
  assert.ok(coverageFacts, "profile must define the shared coverage facts");
  assert.match(
    coverageFacts.replace(/\s+/g, " "),
    /A coverage projection derived from DETAIL_COVERAGE or STREAM_EVIDENCE SHOULD carry the same facts/,
  );
  const noteUrl =
    "https://github.com/PDP-Connect/data-connect/blob/feat/local-run-coverage-verdict/docs/261021-local-device-coverage-evidence.md";
  assert.equal(profile.split(noteUrl).length - 1, 1, "the implementer note is linked exactly once");
});

test("a runtime requests store evidence only for a scope it can bind into collection_scope", () => {
  const section = profile
    .split(/^#### 7\.1\.1 Declaration and negotiation$/m)[1]
    ?.split(/^#### 7\.1\.2 /m)[0];
  assert.ok(section, "profile must define the START request for store evidence");
  const text = section.replace(/\s+/g, " ");
  assert.match(
    text,
    /A runtime MUST NOT request evidence for a run whose effective scope it cannot fully bind into collection_scope\./,
  );
  // The scope-echo rule stays normative: the connector echoes the string without modification.
  assert.match(
    text,
    /If it emits `DONE\.coverage`, the connector MUST echo that string without modification in `collection_scope`\./,
  );
  assert.match(text, /When `START` omits `run_coverage_version`, a connector MUST omit `DONE\.coverage`/);
});

test("a positive also needs the base profile's own accounting, so a 0.2.0 run gets none where detail accounting is open", () => {
  const section = profile
    .split(/^#### 7\.1\.5 Accounting under the base profile$/m)[1]
    ?.split(/^### 7\.2 /m)[0];
  assert.ok(section, "profile must define accounting under the base profile");
  const text = section.replace(/\s+/g, " ");
  assert.match(text, /This requirement applies under every base profile version that this extension lists\./);
  assert.match(text, /A positive \(`collected`\) also requires that the base profile's own accounting for that run show no contradiction\./);
  assert.match(text, /Any obligation whose accounting the runtime cannot evaluate under its base profile yields no positive\./);
  assert.match(
    text,
    /A 0\.1\.0 or 0\.2\.0 run with legacy detail accounting gets no positive for a stream whose detail accounting is incomplete or unevaluated\./,
  );
  assert.match(text, /Base profiles 0\.1\.0 and 0\.2\.0 define no same-obligation baseline and no change interval\./);
  assert.match(text, /Under 0\.1\.0 and 0\.2\.0, a delta run therefore establishes no full-obligation collection, and unchanged state supports no positive\./);
});

test("a stream that declares coverage_stores is rejected without RUN_COVERAGE_V1 in protocol_capabilities", () => {
  const streams = [{ name: "items", coverage_stores: ["store-a"] }];
  assert.equal(validate({ streams }), false, "a missing protocol_capabilities fails the rule");
  assert.equal(validate({ streams, protocol_capabilities: ["OBSERVATION"] }), false);
  assert.equal(validate({ streams, protocol_capabilities: "RUN_COVERAGE_V1" }), false, "the capability list must be an array");
});

test("a stream that declares coverage_stores is accepted with RUN_COVERAGE_V1, and other streams need no declaration", () => {
  const streams = [{ name: "items", coverage_stores: ["store-a"] }];
  assert.equal(validate({ streams, protocol_capabilities: ["RUN_COVERAGE_V1"] }), true, JSON.stringify(validate.errors));
  assert.equal(validate({ streams: [{ name: "items" }] }), true, JSON.stringify(validate.errors));
});

// The schema owns only the capability-declaration implication here.
// Full inventory validation is outside this schema's responsibility;
// schema acceptance below does not make these inventories protocol-valid.
test("outside-schema responsibility: malformed coverage inventories pass the declaration-only schema boundary", () => {
  for (const coverage_stores of [[], [""], ["store-a", "store-a"], [42]]) {
    const streams = [{ name: "items", coverage_stores }];
    assert.equal(validate({ streams, protocol_capabilities: ["RUN_COVERAGE_V1"] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ streams }), false, "even malformed inventories still require the capability declaration");
  }
});

// Section 3.3.8's one-providing-kind rule is the target shape, not an
// absolute today: `host_http_request` is a named legacy exception, valid on
// both `browser` and `network`, because github_browser and strava_browser
// already declare it on both (also flagged by the binding-model fit test
// against the 51 connectors, item 3 of its "most common gaps" table) and
// scripts/pageshim/capabilities.mjs already supports it on both kinds. This
// is schema.$defs.legacyBrowserFeature, not schema.$defs.browserFeature, so
// a reader can tell the grandfathered case from the rule new features
// follow. It is resolved later through a versioned alias, not performed
// here (Section 3.3.8).

test("every connector manifest validates against the manifest schema, with no exceptions", () => {
  const manifests = connectorManifests();
  assert.ok(manifests.length > 0, "connector manifests must be present");
  for (const { path, manifest } of manifests) {
    assert.equal(validate(manifest), true, `${path}: ${JSON.stringify(validate.errors)}`);
  }
});

test("the legacy dual placement is accepted: host_http_request validates on both browser and network", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["host_http_request"] } })), true);
  assert.equal(validate(manifestWith({ network: { required: true, features: ["host_http_request"] } })), true);
  // github_browser and strava_browser rely on exactly this: both bindings
  // declare host_http_request today.
  for (const name of ["github_browser", "strava_browser"]) {
    const manifest = JSON.parse(readFileSync(join(root, "connectors", name, "manifest.json"), "utf8"));
    assert.deepEqual(
      manifest.runtime_requirements.bindings.browser.features.filter((f) => f === "host_http_request"),
      ["host_http_request"],
      `${name}: expected host_http_request under the browser binding`,
    );
    assert.equal(validate(manifest), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test("a new (non-legacy) feature placed on the wrong kind is still rejected", () => {
  for (const feature of ["page_input", "cookie_read", "page_response_observation", "host_cookie_jar_request"]) {
    assert.equal(validate(manifestWith({ network: { required: true, features: [feature] } })), false, feature);
  }
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["same_origin_page_fetch"] } })), false);
});

test("runtime_requirements without bindings validates", () => {
  assert.equal(validate({ runtime_requirements: {} }), true, JSON.stringify(validate.errors));
});

test("registry and namespaced extension binding names are accepted", () => {
  for (const name of ["browser", "desktop_session", "filesystem", "network", "example.com/scanner", "nvidia.com/gpu"]) {
    assert.equal(validate(manifestWith({ [name]: { required: true } })), true, name);
  }
});

test("unregistered unqualified binding names are rejected", () => {
  for (const name of [
    "browser_automation",
    "browser_profile",
    "loopback_listen",
    "interactive",
    "local_device",
    "Browser",
    "example/scanner",
    "example.com/",
  ]) {
    assert.equal(validate(manifestWith({ [name]: { required: false } })), false, name);
  }
});

test("binding declarations keep binding-specific fields and require the required flag", () => {
  const rationale = "The key unwraps only through the session keyring.";
  assert.equal(validate(manifestWith({ desktop_session: { required: true, rationale } })), true);
  assert.equal(validate(manifestWith({ network: {} })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["goto"] } })), false);
});

const input = (overrides = {}) => ({ env_var: "EXAMPLE_EXPORT_DIR", kind: "dir", access: "read", ...overrides });
const filesystemWith = (declaration) => manifestWith({ filesystem: { required: true, ...declaration } });

test("the profile filesystem input table matches the schema input members exactly", () => {
  assert.deepEqual(
    tableRowKeys("#### 3.3.5 Filesystem inputs").sort(),
    Object.keys(schema.$defs.filesystemInput.properties).sort(),
  );
});

test("the profile filesystem input example validates", () => {
  const section = profile.split(/^#### 3\.3\.5 Filesystem inputs$/m)[1];
  const example = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(example, "Section 3.3.5 must contain a JSON example");
  const bindings = JSON.parse(`{${example[1]}}`);
  assert.equal(validate(manifestWith(bindings)), true, JSON.stringify(validate.errors));
});

test("filesystem inputs accept declared files and directories", () => {
  assert.equal(validate(filesystemWith({ inputs: [input()] })), true);
  assert.equal(
    validate(
      filesystemWith({
        inputs: [
          input({ env_var: "CODEX_SESSIONS_DIR" }),
          input({ env_var: "CODEX_STATE_DB", kind: "file", accepted_extensions: [".sqlite"] }),
          input({ env_var: "TAKEOUT_DIR", accepted_extensions: [".zip", ".tar.gz"] }),
        ],
      }),
    ),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate(filesystemWith({ rationale: "Reads an owner export." })), true);
});

test("filesystem inputs reject undeclared shapes", () => {
  const cases = {
    "empty inputs": { inputs: [] },
    "missing env_var": { inputs: [{ kind: "dir", access: "read" }] },
    "lowercase env_var": { inputs: [input({ env_var: "export_dir" })] },
    "missing kind": { inputs: [{ env_var: "EXAMPLE_DIR", access: "read" }] },
    "unknown kind": { inputs: [input({ kind: "socket" })] },
    "missing access": { inputs: [{ env_var: "EXAMPLE_DIR", kind: "dir" }] },
    "write access": { inputs: [input({ access: "write" })] },
    "unknown member": { inputs: [input({ path: "/home/owner/export" })] },
    "extension without a dot": { inputs: [input({ accepted_extensions: ["zip"] })] },
    "uppercase extension": { inputs: [input({ accepted_extensions: [".ZIP"] })] },
    "duplicate extension": { inputs: [input({ accepted_extensions: [".zip", ".zip"] })] },
    "empty extensions": { inputs: [input({ accepted_extensions: [] })] },
  };
  for (const [name, declaration] of Object.entries(cases)) {
    assert.equal(validate(filesystemWith(declaration)), false, name);
  }
  assert.equal(validate(manifestWith({ filesystem: { inputs: [input()] } })), false, "missing required flag");
});

test("manifest filesystem inputs have unique variables and agree with import_dir_env_var", () => {
  for (const { path, manifest } of connectorManifests()) {
    const inputs = manifest.runtime_requirements?.bindings?.filesystem?.inputs;
    if (inputs === undefined) continue;
    const variables = inputs.map((entry) => entry.env_var);
    assert.equal(new Set(variables).size, variables.length, `${path}: duplicate filesystem input env_var`);
    const importDir = manifest.setup?.manual_or_upload?.import_dir_env_var;
    if (importDir !== undefined) {
      assert.ok(
        inputs.some((entry) => entry.kind === "dir" && entry.env_var === importDir),
        `${path}: import_dir_env_var ${importDir} must name a dir input`,
      );
    }
  }
});

// --- Section 3.3.1: binding instances (shorthand and named) -----------------

test("a shorthand key is equivalent to a named instance with the same kind", () => {
  const shorthand = manifestWith({ browser: { required: true, features: ["page_navigation"] } });
  const named = manifestWith({
    chase_site: { kind: "browser", required: true, features: ["page_navigation"] },
  });
  assert.equal(validate(shorthand), true, JSON.stringify(validate.errors));
  assert.equal(validate(named), true, JSON.stringify(validate.errors));
});

test("a shorthand key MUST NOT also declare kind", () => {
  assert.equal(validate(manifestWith({ browser: { kind: "browser", required: true } })), false);
  assert.equal(validate(manifestWith({ "example.com/scanner": { kind: "example.com/scanner", required: true } })), false);
});

test("a named instance key MUST declare kind, naming a registry or namespaced binding name", () => {
  assert.equal(validate(manifestWith({ chase_site: { required: true } })), false, "missing kind");
  assert.equal(validate(manifestWith({ chase_site: { kind: "not_a_kind", required: true } })), false, "unknown kind");
  assert.equal(
    validate(manifestWith({ chase_site: { kind: "example.com/scanner", required: true } })),
    true,
    "namespaced kind",
  );
});

test("every core kind works as a named instance, with the same constraint and feature shape as its shorthand", () => {
  assert.equal(
    validate(
      manifestWith({
        api: { kind: "network", required: true, features: ["host_http_request"], constraints: { hosts: ["https://api.example.com"] } },
      }),
    ),
    true,
  );
  assert.equal(
    validate(
      manifestWith({
        export_dir: { kind: "filesystem", required: true, constraints: { inputs: [input()] } },
      }),
    ),
    true,
  );
  assert.equal(
    validate(
      manifestWith({
        keyring: {
          kind: "desktop_session",
          required: true,
          constraints: { items: [{ service: "os_keyring", selector: "x", operations: ["unwrap"] }] },
        },
      }),
    ),
    true,
  );
});

test("an interface version must match the instance's kind", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, interface: "browser@1" } })), true);
  assert.equal(validate(manifestWith({ browser: { required: true, interface: "network@1" } })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, interface: "browser@0" } })), false, "no leading zero version, and no zero");
  assert.equal(validate(manifestWith({ browser: { required: true, interface: "browser@01" } })), false, "no leading zero");
});

test("duplicate JSON keys are rejected, including a repeated binding instance key", () => {
  const text = `{"runtime_requirements": {"bindings": {"x": {"kind": "browser", "required": true}, "x": {"kind": "network", "required": false}}}}`;
  const duplicates = findDuplicateJsonKeys(text);
  assert.deepEqual(duplicates, [{ path: "runtime_requirements.bindings.x", key: "x" }]);
});

test("no checked-in connector manifest's raw JSON text contains a duplicate key", () => {
  for (const { path } of connectorManifests()) {
    const duplicates = findDuplicateJsonKeys(readFileSync(path, "utf8"));
    assert.deepEqual(duplicates, [], `${path}: duplicate JSON key(s) ${JSON.stringify(duplicates)}`);
  }
});

// --- Section 3.3.2/3.3.5: empty lists and unknown fields ---------------------

test("every constraint list is rejected when empty; the field is omitted instead", () => {
  const cases = [
    manifestWith({ browser: { required: true, constraints: { navigate: [] } } }),
    manifestWith({ browser: { required: true, constraints: { connect: [] } } }),
    manifestWith({ network: { required: true, constraints: { hosts: [] } } }),
    manifestWith({ filesystem: { required: true, constraints: { outputs: [] } } }),
    manifestWith({ filesystem: { required: true, constraints: { inputs: [] } } }),
    manifestWith({ desktop_session: { required: true, constraints: { items: [] } } }),
  ];
  for (const manifest of cases) assert.equal(validate(manifest), false, JSON.stringify(manifest));
});

test("an unknown field in a constraints object is rejected", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, constraints: { bogus: ["x"] } } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, constraints: { bogus: ["x"] } } })), false);
  assert.equal(validate(manifestWith({ filesystem: { required: true, constraints: { bogus: ["x"] } } })), false);
  assert.equal(validate(manifestWith({ desktop_session: { required: true, constraints: { bogus: ["x"] } } })), false);
});

test("an unknown top-level field on a binding declaration is preserved, not rejected (unchanged from v0.1)", () => {
  assert.equal(
    validate(manifestWith({ desktop_session: { required: true, rationale: "because" } })),
    true,
    "a connector or runtime that does not understand an extra field ignores it, per Section 3.3",
  );
});

// --- Section 3.3.8: feature ownership ----------------------------------------

test("a feature belongs to exactly one kind, except the named legacy exception; the other kind rejects everything else", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["same_origin_page_fetch"] } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, features: ["page_navigation"] } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, features: ["host_http_request"] } })), true);
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["host_cookie_jar_request"] } })), true);
  // host_http_request is the one named legacy exception (schema.$defs.legacyBrowserFeature): valid on both kinds.
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["host_http_request"] } })), true);
});

test("filesystem and desktop_session instances MUST NOT declare features", () => {
  assert.equal(validate(manifestWith({ filesystem: { required: true, features: [] } })), false);
  assert.equal(validate(manifestWith({ desktop_session: { required: true, features: [] } })), false);
});

// --- Section 3.3.3/3.3.4: constraint grammar acceptance at the schema level --

test("browser.connect accepts ws/wss; browser.navigate does not", () => {
  assert.equal(
    validate(manifestWith({ browser: { required: true, constraints: { connect: ["wss://ws.example.com"] } } })),
    true,
  );
  assert.equal(
    validate(manifestWith({ browser: { required: true, constraints: { navigate: ["wss://ws.example.com"] } } })),
    false,
  );
});

test("network.hosts accepts a literal host, a non-HTTP endpoint, and a setup_field reference", () => {
  assert.equal(
    validate(manifestWith({ network: { required: true, constraints: { hosts: ["https://api.example.com"] } } })),
    true,
  );
  assert.equal(
    validate(manifestWith({ network: { required: true, constraints: { hosts: ["imaps://imap.example.com"] } } })),
    true,
  );
  assert.equal(
    validate(manifestWith({ network: { required: true, constraints: { hosts: [{ setup_field: "base_url" }] } } })),
    true,
  );
  assert.equal(
    validate(manifestWith({ network: { required: true, constraints: { hosts: [{ setup_field: "base_url", allow_private: true }] } } })),
    true,
  );
});

test("network.hosts rejects ws/wss: those schemes are reserved for browser.connect, not a network endpoint", () => {
  assert.equal(validate(manifestWith({ network: { required: true, constraints: { hosts: ["wss://example.com"] } } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, constraints: { hosts: ["ws://example.com"] } } })), false);
});

test("a structurally non-canonical constraint string is rejected at the schema level (uppercase, path, bad wildcard)", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, constraints: { navigate: ["https://EXAMPLE.com"] } } })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, constraints: { navigate: ["https://example.com/path"] } } })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, constraints: { navigate: ["https://*.com"] } } })), false);
});

test("the schema's pattern is a structural approximation, not full canonical-form equivalence: an explicit default port is accepted by the schema but rejected by the reference canonicalizer", () => {
  const nonCanonical = "https://example.com:443";
  assert.equal(
    validate(manifestWith({ browser: { required: true, constraints: { navigate: [nonCanonical] } } })),
    true,
    "documented schema limitation: see schemas/connector-binding-grammar.mjs and the webHostString description",
  );
  assert.equal(
    isCanonicalWebHost(nonCanonical),
    false,
    "the reference canonicalizer is the ground truth that a publish-time lint MUST use (Section 3.3.2)",
  );
});

test("filesystem output slots: scratch must not be durable, a named slot may be", () => {
  assert.equal(
    validate(manifestWith({ filesystem: { required: true, constraints: { outputs: [{ slot: "scratch", access: "write", durable: true }] } } })),
    false,
  );
  assert.equal(
    validate(manifestWith({ filesystem: { required: true, constraints: { outputs: [{ slot: "scratch", access: "write" }] } } })),
    true,
  );
  assert.equal(
    validate(
      manifestWith({
        filesystem: { required: true, constraints: { outputs: [{ slot: "statements", access: "write", durable: true }] } },
      }),
    ),
    true,
  );
});

// --- filesystem.inputs alias (top-level vs. constraints.inputs) -------------

test("a filesystem instance may declare inputs at the top level, at constraints.inputs, or both when equal", () => {
  const topLevel = manifestWith({ filesystem: { required: true, inputs: [input()] } });
  const nested = manifestWith({ filesystem: { required: true, constraints: { inputs: [input()] } } });
  const both = manifestWith({ filesystem: { required: true, inputs: [input()], constraints: { inputs: [input()] } } });
  for (const manifest of [topLevel, nested, both]) {
    assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  }
  // The schema accepts both forms independently; normalizeFilesystemInputs is
  // the cross-field check that they agree (JSON Schema cannot express that).
  const instance = both.runtime_requirements.bindings.filesystem;
  assert.deepEqual(normalizeFilesystemInputs(instance), [input()]);
});

test("a filesystem instance with disagreeing top-level and constraints.inputs validates at the schema level, and normalizeFilesystemInputs is what rejects it", () => {
  const instance = {
    required: true,
    inputs: [input({ env_var: "A_DIR" })],
    constraints: { inputs: [input({ env_var: "B_DIR" })] },
  };
  assert.equal(validate(manifestWith({ filesystem: instance })), true, "JSON Schema alone cannot see the conflict");
  assert.throws(() => normalizeFilesystemInputs(instance));
});

// --- Old-reader / new-reader compatibility -----------------------------------
//
// "Compatible" means two readers derive the same INTERPRETATION of a binding
// map, not merely that both validate it. The functions below model what each
// reader resolves a binding declaration to: kind, required, features, and
// the effective filesystem inputs (after the import_dir_env_var precedence
// rule, which this PR does not change). The old reader only ever saw
// shorthand keys and the top-level `inputs` member; the new reader also
// understands an explicit `kind` and `constraints.inputs`.

function resolveImportDirPrecedence(inputs, manifest) {
  const importDir = manifest.setup?.manual_or_upload?.import_dir_env_var;
  if (inputs !== undefined) return inputs;
  if (importDir !== undefined) return [{ env_var: importDir, kind: "dir", access: "read" }];
  return undefined;
}

function sortedInputs(inputs) {
  if (inputs === undefined) return undefined;
  return [...inputs].sort((a, b) => a.env_var.localeCompare(b.env_var));
}

function interpretOldReaderBindings(bindings, manifest) {
  const result = {};
  for (const [key, declaration] of Object.entries(bindings ?? {})) {
    result[key] = {
      kind: key, // the old reader has no `kind` member; the key was always the kind.
      required: declaration.required,
      features: declaration.features ? [...declaration.features].sort() : undefined,
      inputs: sortedInputs(resolveImportDirPrecedence(declaration.inputs, manifest)),
    };
  }
  return result;
}

function interpretNewReaderBindings(bindings, manifest) {
  const result = {};
  for (const [key, declaration] of Object.entries(bindings ?? {})) {
    result[key] = {
      kind: declaration.kind ?? key,
      required: declaration.required,
      features: declaration.features ? [...declaration.features].sort() : undefined,
      inputs: sortedInputs(resolveImportDirPrecedence(normalizeFilesystemInputs(declaration), manifest)),
    };
  }
  return result;
}

test("old-reader and new-reader interpretations agree for all 51 manifests: same kind, required, features, and effective filesystem inputs", () => {
  const manifests = connectorManifests();
  assert.ok(manifests.length > 0, "connector manifests must be present");
  for (const { path, manifest } of manifests) {
    const bindings = manifest.runtime_requirements?.bindings;
    if (!bindings) continue;
    const oldInterpretation = interpretOldReaderBindings(bindings, manifest);
    const newInterpretation = interpretNewReaderBindings(bindings, manifest);
    assert.deepEqual(Object.keys(newInterpretation).sort(), Object.keys(oldInterpretation).sort(), `${path}: same binding keys`);
    for (const key of Object.keys(oldInterpretation)) {
      assert.ok(
        deepEqualJson(oldInterpretation[key], newInterpretation[key]),
        `${path}: ${key} interpretation differs; old=${JSON.stringify(oldInterpretation[key])} new=${JSON.stringify(newInterpretation[key])}`,
      );
    }
  }
});

test("interpretOldReaderBindings/interpretNewReaderBindings actually detect a real interpretation difference (the comparison is not vacuous)", () => {
  const manifest = { setup: {} };
  const bindings = { chase_site: { kind: "browser", required: true } };
  // A key with an explicit `kind` different from the key itself is read
  // differently: the old reader (no `kind` concept) takes the key as the
  // kind; the new reader takes the declared `kind`.
  const oldInterpretation = interpretOldReaderBindings(bindings, manifest);
  const newInterpretation = interpretNewReaderBindings(bindings, manifest);
  assert.notEqual(oldInterpretation.chase_site.kind, newInterpretation.chase_site.kind);
  assert.equal(oldInterpretation.chase_site.kind, "chase_site");
  assert.equal(newInterpretation.chase_site.kind, "browser");
});

test("old-reader compatibility: a manifest using only shorthand instances means exactly what it meant before this PR", () => {
  for (const { manifest } of connectorManifests()) {
    const bindings = manifest.runtime_requirements?.bindings;
    if (!bindings) continue;
    for (const [key, declaration] of Object.entries(bindings)) {
      assert.ok(schema.$defs.registryBinding.enum.includes(key), `${key}: every checked-in manifest uses only shorthand (registry-named) instances`);
      assert.ok(!("kind" in declaration), `${key}: a shorthand instance must not carry kind`);
    }
  }
});

test("new-reader compatibility: the committed pre-binding-instances schema fixture rejects a manifest that uses a named instance", () => {
  const namedInstanceManifest = manifestWith({
    chase_site: { kind: "browser", required: true, constraints: { navigate: ["https://secure.chase.com"] } },
  });
  // An old validator fails closed: it does not recognize "chase_site" as a
  // registry or namespaced binding name, so it rejects the manifest outright
  // rather than silently accepting or misinterpreting the new instance shape.
  assert.equal(oldValidate(namedInstanceManifest), false);
  // The new schema (this PR) understands the same manifest.
  assert.equal(validate(namedInstanceManifest), true, JSON.stringify(validate.errors));

  // Every manifest the old schema already accepted (pure shorthand) is still
  // accepted by the new schema: the additive direction of compatibility.
  // No try/catch here: if the fixture is missing or malformed, module load
  // already failed above and this whole file fails, which is the point.
  for (const { path, manifest } of connectorManifests()) {
    assert.equal(oldValidate(manifest), true, `${path}: expected the pre-PR schema to accept this unmodified manifest`);
    assert.equal(validate(manifest), true, `${path}: expected the new schema to still accept this unmodified manifest`);
  }
});

// Optional store evidence can be rolled out per stream; malformed declared
// inventories must fail even though unrelated manifest fields stay extensible.
test("run coverage advertisement and stream inventories are optional and versioned", () => {
  assert.equal(validate({}), true);
  assert.equal(validate({ run_coverage: { version: 1 }, streams: [{ name: "items", coverage_stores: ["metadata"] }, { name: "uninstrumented" }] }), true);
  for (const invalid of [
    { run_coverage: { version: 2 } },
    { run_coverage: {} },
    { run_coverage: { version: 1, required: true } },
    ...[[], [""], ["   "], ["store", "store"]].map((coverage_stores) => ({ streams: [{ name: "items", coverage_stores }] })),
  ]) assert.equal(validate(invalid), false, JSON.stringify(invalid));
});
