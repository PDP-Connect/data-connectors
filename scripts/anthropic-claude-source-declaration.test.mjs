// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Publication contract for the one public source `/claude`, acquired by two
 * artifacts: the published `anthropic` export and the `anthropic-live`
 * browser connector. Both must carry one declaration, and every record each
 * emits must satisfy the shared stream schemas.
 *
 * The pair is built straight from the two manifests, with the live artifact's
 * publish exclusion lifted in memory (CANDIDATE). The repo's allowlist stays
 * untouched, and these checks do not pass merely because the live artifact is
 * excluded from `sourceDeclarationMembers`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { CONNECTOR_PUBLISH_INVENTORY } from "./connector-publish-allowlist.mjs";
import {
  buildSourceDeclaration,
  profileDeclarationErrors,
  serializeSourceDeclaration,
  validateSourceDeclaration,
} from "../packages/connector-installer-core/source-declaration.mjs";
import { validateRecord as validateExportRecord } from "../connectors/anthropic/schemas.ts";
import { validateRecord as validateLiveRecord } from "../connectors/anthropic_live/schemas.ts";

const SOURCE = "https://registry.pdpp.dev/sources/claude";
const SHARED = ["conversations", "messages"];

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const readJsonl = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const exportProfile = () => readJson("connectors/anthropic/manifest.json");
const liveProfile = () => readJson("connectors/anthropic_live/manifest.json");

// Promotion candidate: the publishable members of the source if the live
// artifact were no longer excluded, discovered through the real inventory.
function candidateMembers() {
  const keys = CONNECTOR_PUBLISH_INVENTORY.filter(
    ({ connectorKey }) => connectorKey === "anthropic" || connectorKey === "anthropic-live",
  ).map(({ manifest }) => manifest);
  assert.deepEqual(keys.sort(), ["anthropic", "anthropic_live"]);
  const members = keys.map((manifest) => readJson(`connectors/${manifest}/manifest.json`));
  assert.ok(members.every((member) => member.source.id === SOURCE));
  return members;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
function sharedValidators(declaration) {
  return Object.fromEntries(
    declaration.streams.map((stream) => [stream.name, ajv.compile(stream.schema)]),
  );
}

describe("claude source: anthropic + anthropic-live publication pair", () => {
  it("builds one valid declaration, whichever order the members arrive in", () => {
    const [a, b] = candidateMembers();
    const forward = serializeSourceDeclaration(buildSourceDeclaration([a, b]));
    const reverse = serializeSourceDeclaration(buildSourceDeclaration([b, a]));
    assert.ok(forward.equals(reverse));
    const declaration = JSON.parse(forward);
    assert.deepEqual(validateSourceDeclaration(declaration), { ok: true, errors: [] });
    for (const member of [a, b]) {
      assert.deepEqual(profileDeclarationErrors(member, declaration), [], member.connector_key);
    }
    assert.equal(declaration.source.id, SOURCE);
  });

  it("declares the union of both artifacts' streams", () => {
    const declaration = buildSourceDeclaration(candidateMembers());
    assert.deepEqual(
      declaration.streams.map((stream) => stream.name).sort(),
      [
        "account_plan",
        "account_profile",
        "conversations",
        "messages",
        "project_documents",
        "projects",
        "usage_limits",
      ],
    );
  });

  it("takes shared-stream prose from the published anthropic member, so its wording is stable", () => {
    const declaration = buildSourceDeclaration(candidateMembers());
    const published = exportProfile();
    for (const name of SHARED) {
      const stream = declaration.streams.find((s) => s.name === name);
      const own = published.streams.find((s) => s.name === name);
      assert.equal(stream.description, own.description, name);
      assert.deepEqual(stream.display, own.display, name);
    }
  });

  it("gives shared streams identical schema, query, cursor and semantics in both manifests", () => {
    const exportStreams = exportProfile().streams;
    const liveStreams = liveProfile().streams;
    for (const name of SHARED) {
      const left = exportStreams.find((s) => s.name === name);
      const right = liveStreams.find((s) => s.name === name);
      for (const member of [
        "schema",
        "query",
        "cursor_field",
        "consent_time_field",
        "primary_key",
        "relationships",
        "selection",
        "semantics",
        "views",
      ]) {
        assert.deepEqual(left[member], right[member], `${name}.${member}`);
      }
    }
  });

  it("keeps blob_ref optional and model_source declared in the shared contract", () => {
    const declaration = buildSourceDeclaration(candidateMembers());
    const conversations = declaration.streams.find((s) => s.name === "conversations").schema;
    const messages = declaration.streams.find((s) => s.name === "messages").schema;
    assert.ok(conversations.properties.blob_ref);
    assert.deepEqual(conversations.required, ["id"]);
    assert.deepEqual(messages.properties.model_source, { type: ["string", "null"] });
    assert.deepEqual(messages.required, ["id", "conversation_id"]);
  });

  it("accepts every export and live fixture record under the shared schema and each connector's own validator", () => {
    const validators = sharedValidators(buildSourceDeclaration(candidateMembers()));
    const cases = [
      ["anthropic", validateExportRecord],
      ["anthropic_live", validateLiveRecord],
    ];
    let checked = 0;
    for (const [connector, ownValidator] of cases) {
      const dir = `connectors/${connector}/fixtures/scrubbed/pilot-real-shape/records`;
      const files = readdirSync(new URL(`../${dir}/`, import.meta.url)).filter((name) => name.endsWith(".jsonl"));
      for (const name of SHARED) assert.ok(files.includes(`${name}.jsonl`), `${connector}.${name} fixture is required`);
      for (const file of files) {
        const stream = file.slice(0, -".jsonl".length);
        const records = readJsonl(`${dir}/${file}`);
        assert.ok(validators[stream], `${connector}.${stream} must be declared`);
        for (const record of records) {
          assert.ok(validators[stream](record), `${connector}.${stream}: ${ajv.errorsText(validators[stream].errors)}`);
          assert.equal(ownValidator(stream, record).ok, true, `${connector}.${stream} own validator`);
          checked += 1;
        }
      }
    }
    assert.ok(checked >= 15, `only ${checked} fixture records checked`);
  });

  it("keeps each artifact's own honesty: export carries blob_ref, live carries none and flags model_source", () => {
    const exportConversations = readJsonl("connectors/anthropic/fixtures/scrubbed/pilot-real-shape/records/conversations.jsonl");
    assert.ok(exportConversations.every((record) => record.blob_ref?.size_bytes >= 0));
    const liveConversations = readJsonl("connectors/anthropic_live/fixtures/scrubbed/pilot-real-shape/records/conversations.jsonl");
    assert.ok(liveConversations.every((record) => !("blob_ref" in record)));
    const liveMessages = readJsonl("connectors/anthropic_live/fixtures/scrubbed/pilot-real-shape/records/messages.jsonl");
    assert.ok(liveMessages.some((record) => record.model_source === "conversation"));
  });

  it("still rejects a conversation whose blob_ref is present but malformed", () => {
    const validators = sharedValidators(buildSourceDeclaration(candidateMembers()));
    assert.equal(validators.conversations({ id: "c1", blob_ref: { blob_id: "x" } }), false);
    assert.equal(validators.conversations({ id: "c1" }), true);
  });

  it("refuses the pair when a shared-stream contract conflicts", () => {
    const [a, b] = candidateMembers();
    const conflicts = [
      (m) => (m.streams.find((s) => s.name === "conversations").schema.required = ["id", "blob_ref"]),
      (m) => delete m.streams.find((s) => s.name === "messages").schema.properties.model_source,
      (m) => (m.streams.find((s) => s.name === "messages").query.search.lexical_fields = ["content", "model"]),
      (m) => (m.streams.find((s) => s.name === "conversations").cursor_field = "update_time"),
    ];
    for (const mutate of conflicts) {
      const drifted = structuredClone(b);
      mutate(drifted);
      assert.throws(() => buildSourceDeclaration([a, drifted]), /stream "(conversations|messages)" differs/);
    }
  });

  it("scopes the canonical-member mapping to /claude: other unmatched sources still fail", () => {
    const [a, b] = candidateMembers();
    const rehome = (member, key, id) => ({
      ...structuredClone(member),
      connector_key: key,
      source: { ...member.source, id },
    });
    const other = "https://registry.pdpp.dev/sources/elsewhere";
    // Same connector keys, different source: no key matches "elsewhere".
    assert.throws(
      () => buildSourceDeclaration([rehome(a, "anthropic", other), rehome(b, "anthropic-live", other)]),
      /no member artifact's connector key matches "elsewhere"/,
    );
    // /claude with neither the named canonical key nor a "claude" key.
    assert.throws(
      () => buildSourceDeclaration([rehome(a, "claude-export", SOURCE), rehome(b, "anthropic-live", SOURCE)]),
      /no member artifact's connector key matches "claude"/,
    );
    // Strict equality: a near-miss key is not the named canonical member.
    assert.throws(
      () => buildSourceDeclaration([rehome(a, "anthropic-2", SOURCE), rehome(b, "anthropic-live", SOURCE)]),
      /no member artifact's connector key matches "claude"/,
    );
  });
});
