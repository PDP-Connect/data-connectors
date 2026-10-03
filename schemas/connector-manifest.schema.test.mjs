// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { execFileSync } from "node:child_process";
import Ajv from "ajv/dist/2020.js";

import { findDuplicateJsonKeys, normalizeFilesystemInputs, isCanonicalWebHost } from "./connector-binding-grammar.mjs";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const root = join(schemaDir, "..");
const schema = JSON.parse(readFileSync(join(schemaDir, "connector-manifest.schema.json"), "utf8"));
const profile = readFileSync(join(root, "docs/spec/collection-profile.md"), "utf8");
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

// The commit this PR's branch is stacked on (PR #62's head). Used only to
// load the pre-binding-instances schema for the old-reader compatibility
// test below; it never changes once #62 is merged.
const BASE_COMMIT = "adc6cf821b";

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

// Section 3.3.8 gives each feature exactly one providing kind:
// `host_http_request` belongs to `network`, not `browser`. github_browser and
// strava_browser already declare it on both bindings today (also flagged by
// the binding-model fit test against the 51 connectors, item 3 of its
// "most common gaps" table). That is real drift between those two manifests
// and their own declared reach, not a schema defect, and this PR does not
// edit connector manifests to paper over it. These two are the only
// pre-existing manifests this stricter rule affects; every other manifest
// still validates unchanged.
const KNOWN_FEATURE_OWNERSHIP_VIOLATIONS = new Set(["github_browser", "strava_browser"]);

test("every connector manifest validates against the manifest schema, except two known, reported exceptions", () => {
  const manifests = connectorManifests();
  assert.ok(manifests.length > 0, "connector manifests must be present");
  const failing = new Set();
  for (const { path, manifest } of manifests) {
    const name = path.split("/").at(-2);
    const ok = validate(manifest);
    if (!ok) failing.add(name);
    if (KNOWN_FEATURE_OWNERSHIP_VIOLATIONS.has(name)) continue;
    assert.equal(ok, true, `${path}: ${JSON.stringify(validate.errors)}`);
  }
  assert.deepEqual(
    failing,
    KNOWN_FEATURE_OWNERSHIP_VIOLATIONS,
    "the set of manifests failing validation must be exactly the known, reported exceptions; " +
      "update KNOWN_FEATURE_OWNERSHIP_VIOLATIONS (and report it) if this changes",
  );
});

test("the two known exceptions fail for the expected reason: host_http_request declared on both browser and network", () => {
  for (const { path, manifest } of connectorManifests()) {
    const name = path.split("/").at(-2);
    if (!KNOWN_FEATURE_OWNERSHIP_VIOLATIONS.has(name)) continue;
    assert.equal(validate(manifest), false, `${path} was expected to fail validation`);
    const errors = validate.errors ?? [];
    assert.ok(
      errors.every((e) => e.schemaPath === "#/$defs/browserFeature/enum"),
      `${path}: expected only a browserFeature enum violation, got ${JSON.stringify(errors)}`,
    );
    assert.deepEqual(
      manifest.runtime_requirements.bindings.browser.features.filter((f) => f === "host_http_request"),
      ["host_http_request"],
      `${path}: expected host_http_request under the browser binding`,
    );
  }
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

test("a feature belongs to exactly one kind; the other kind rejects it", () => {
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["host_http_request"] } })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["same_origin_page_fetch"] } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, features: ["page_navigation"] } })), false);
  assert.equal(validate(manifestWith({ network: { required: true, features: ["host_http_request"] } })), true);
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["host_cookie_jar_request"] } })), true);
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

test("new-reader compatibility: a pre-binding-instances schema (PR #62's head) rejects a manifest that uses a named instance", () => {
  let oldSchemaText;
  try {
    oldSchemaText = execFileSync("git", ["show", `${BASE_COMMIT}:schemas/connector-manifest.schema.json`], {
      cwd: root,
      encoding: "utf8",
    });
  } catch {
    // The base commit is unreachable in this checkout (for example a shallow
    // clone with no history). This is a regression lock, not a correctness
    // requirement that must run everywhere, so skip rather than fail closed
    // on an environment limitation.
    return;
  }
  const oldSchema = JSON.parse(oldSchemaText);
  const oldValidate = new Ajv({ strict: true, allErrors: true }).compile(oldSchema);

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
  for (const { path, manifest } of connectorManifests()) {
    if (KNOWN_FEATURE_OWNERSHIP_VIOLATIONS.has(path.split("/").at(-2))) continue;
    assert.equal(oldValidate(manifest), true, `${path}: expected the pre-PR schema to accept this unmodified manifest`);
    assert.equal(validate(manifest), true, `${path}: expected the new schema to still accept this unmodified manifest`);
  }
});
