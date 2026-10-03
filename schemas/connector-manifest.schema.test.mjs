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
