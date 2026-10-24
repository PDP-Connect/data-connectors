// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const profile = readFileSync(new URL("../docs/spec/collection-profile.md", import.meta.url), "utf8");
const corpus = JSON.parse(readFileSync(new URL("../docs/spec/vectors/collection-profile-0.3.0-strict-accounting.json", import.meta.url), "utf8"));
// Trace the complete rewritten sections and unchanged versioning. Keep this
// list explicit: changing corpus metadata must not shrink the traceability gate.
const rewritten = ["5.6", "5.7", "5.8.1", "6.3", "8"];
const normalize = (text) => text.replace(/\s+/g, " ").trim();

function mustSentences() {
  let section;
  const sentences = [];
  for (const block of profile.split(/\n\s*\n/)) {
    const heading = block.match(/^#{2,4} (\d+(?:\.\d+)*)\.? /);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!rewritten.some((id) => section === id || section?.startsWith(`${id}.`))) continue;
    // Inline code can contain punctuation followed by spaces. Protect code spans
    // before splitting prose, then restore their exact text for comparison.
    const code = [];
    const prose = normalize(block).replace(/`[^`]*`/g, (value) => `\u0000${code.push(value) - 1}\u0000`);
    for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
      const text = sentence.replace(/\u0000(\d+)\u0000/g, (_, index) => code[index]);
      if (/\bMUST\b/.test(text)) sentences.push({ section, text });
    }
  }
  return sentences;
}

function uniqueIds(entries, kind) {
  assert.ok(entries.length > 0, `${kind} must not be empty`);
  const ids = entries.map(({ id }) => id);
  assert.ok(ids.every((id) => typeof id === "string" && id.trim()), `${kind} needs nonempty ids`);
  assert.equal(new Set(ids).size, ids.length, `duplicate ${kind} id`);
  return new Map(entries.map((entry) => [entry.id, entry]));
}

test("vector corpus parses, has unique ids and resolves requirement links in both directions", () => {
  const requirements = uniqueIds(corpus.requirements, "requirement");
  const vectors = uniqueIds(corpus.vectors, "vector");
  assert.equal(new Set([...requirements.keys(), ...vectors.keys()]).size, requirements.size + vectors.size);
  for (const requirement of requirements.values()) {
    assert.ok(typeof requirement.failure === "string" && requirement.failure.trim(), requirement.id);
    assert.ok(requirement.vectors.length > 0, `${requirement.id}: no failure vector`);
    assert.equal(new Set(requirement.vectors).size, requirement.vectors.length);
    for (const id of requirement.vectors) {
      assert.ok(vectors.get(id)?.requirements.includes(requirement.id), `${requirement.id} -> ${id}`);
    }
  }
  for (const vector of vectors.values()) {
    assert.ok(vector.title && vector.from_case && vector.given && vector.when && vector.then, vector.id);
    assert.ok(vector.requirements.length > 0, `${vector.id}: untraced vector`);
    assert.equal(new Set(vector.requirements).size, vector.requirements.length);
    for (const id of vector.requirements) {
      assert.ok(requirements.get(id)?.vectors.includes(vector.id), `${vector.id} -> ${id}`);
    }
  }
});

test("at least 67 distinct original conformance cases survive", () => {
  assert.ok(new Set(corpus.vectors.map(({ from_case }) => from_case)).size >= 67);
});

test("every rewritten MUST sentence is traced verbatim, with no invented requirements", () => {
  const actual = mustSentences().map(({ section, text }) => `${section}: ${text}`).sort();
  const traced = corpus.requirements.map(({ section, text }) => `${section}: ${text}`).sort();
  assert.equal(new Set(traced).size, traced.length, "duplicate normative text");
  assert.deepEqual(traced, actual);
});

test("vector expectations use controlled protocol results", () => {
  const enums = {
    checkpoint: ["committed", "withheld"],
    receipt: ["minted", "none", "invalidated", "kept"],
    debt: ["admitted", "kept", "settled", "refused", "none"],
    effect: ["admitted", "refused"],
    run: ["continues", "terminated"],
    spawn: ["allowed", "refused"],
  };
  for (const vector of corpus.vectors) {
    for (const [field, value] of Object.entries(vector.then)) {
      if (field === "note") {
        assert.equal(typeof value, "string", vector.id);
      } else if (field === "outcome") {
        for (const outcome of Object.values(value)) {
          assert.ok(["complete", "empty", "unchanged", "gap", "unaccounted"].includes(outcome), vector.id);
        }
      } else {
        assert.ok(enums[field]?.includes(value), `${vector.id}: ${field}=${value}`);
      }
    }
  }
});
