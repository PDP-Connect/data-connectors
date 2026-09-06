// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyOperator,
  findGroupMeOperator,
  GROUPME_NONPROGRESS_WEAKENING_V1,
  GROUPME_OPERATORS,
  GROUPME_PAGE_CEILING_V1,
  PreimageMismatchError,
} from "./groupme-operators.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

async function readRealGroupMeIndex(): Promise<string> {
  return readFile(resolve(REPO_ROOT, "packages/polyfill-connectors/connectors/groupme/index.ts"), "utf8");
}

test("exactly 2 operators are registered (design.md permits two or three; two is enough here)", () => {
  assert.equal(GROUPME_OPERATORS.length, 2);
});

test("findGroupMeOperator: resolves both registered ids and rejects an unregistered one", () => {
  assert.equal(findGroupMeOperator("groupme-page-ceiling-dc-v1").id, "groupme-page-ceiling-dc-v1");
  assert.equal(findGroupMeOperator("groupme-nonprogress-weakening-dc-v1").id, "groupme-nonprogress-weakening-dc-v1");
  assert.throws(() => findGroupMeOperator("some-other-operator/v1"));
});

test("groupme-page-ceiling-dc-v1: preimage matches the real live target file exactly once", async () => {
  const content = await readRealGroupMeIndex();
  const occurrences = content.split(GROUPME_PAGE_CEILING_V1.preimage).length - 1;
  assert.equal(occurrences, 1, "preimage must match exactly once in the real file, never zero or more than once");
});

test("groupme-nonprogress-weakening-dc-v1: preimage matches the real live target file exactly once", async () => {
  const content = await readRealGroupMeIndex();
  const occurrences = content.split(GROUPME_NONPROGRESS_WEAKENING_V1.preimage).length - 1;
  assert.equal(occurrences, 1, "preimage must match exactly once in the real file, never zero or more than once");
});

test("applyOperator: page-ceiling operator applies cleanly against the real file and inserts a bounded counter", async () => {
  const content = await readRealGroupMeIndex();
  const mutated = applyOperator(GROUPME_PAGE_CEILING_V1, content);
  assert.notEqual(mutated, content);
  assert.ok(mutated.includes("__MUTATION_FALSIFICATION_MAX_PAGES"));
  assert.ok(mutated.includes("groupme-page-ceiling-dc-v1: reintroduced 200-page cap exceeded"));
});

test("applyOperator: nonprogress-weakening operator applies cleanly and always returns true", async () => {
  const content = await readRealGroupMeIndex();
  const mutated = applyOperator(GROUPME_NONPROGRESS_WEAKENING_V1, content);
  assert.notEqual(mutated, content);
  assert.ok(mutated.includes("groupme-nonprogress-weakening-dc-v1: never detects a non-ascending page"));
  assert.ok(!mutated.includes("curr.created_at < prev.created_at"));
});

test("applyOperator: page-ceiling operator throws PreimageMismatchError against content where the preimage is absent", () => {
  assert.throws(() => applyOperator(GROUPME_PAGE_CEILING_V1, "some unrelated file content"), PreimageMismatchError);
});

test("applyOperator: nonprogress-weakening operator throws PreimageMismatchError against content where the preimage is absent", () => {
  assert.throws(
    () => applyOperator(GROUPME_NONPROGRESS_WEAKENING_V1, "some unrelated file content"),
    PreimageMismatchError
  );
});

test("applyOperator: throws PreimageMismatchError when the target function has already been altered (e.g. by a prior/different mutation)", () => {
  const alreadyMutated = `function isAscendingByCreatedAt(messages: readonly GroupMeMessage[]): boolean {
  return true; // already hand-edited, no longer matches the real preimage
}`;
  assert.throws(() => applyOperator(GROUPME_NONPROGRESS_WEAKENING_V1, alreadyMutated), PreimageMismatchError);
});

test("both operators declare the same target file (packages/polyfill-connectors/connectors/groupme/index.ts)", () => {
  assert.equal(GROUPME_PAGE_CEILING_V1.targetFile, "packages/polyfill-connectors/connectors/groupme/index.ts");
  assert.equal(GROUPME_NONPROGRESS_WEAKENING_V1.targetFile, "packages/polyfill-connectors/connectors/groupme/index.ts");
});

test("both operators carry a non-empty risk description", () => {
  assert.ok(GROUPME_PAGE_CEILING_V1.riskDescription.length > 0);
  assert.ok(GROUPME_NONPROGRESS_WEAKENING_V1.riskDescription.length > 0);
});

test("F7-1 FIRST: replacing exact B tabs with spaces refuses before mutation", async () => {
  const content = await readRealGroupMeIndex();
  for (const operator of GROUPME_OPERATORS) {
    assert.throws(() => applyOperator(operator, content.replaceAll("\t", "  ")), PreimageMismatchError);
  }
});

for (const operator of GROUPME_OPERATORS) {
  test(`applyOperator rejects whitespace-only preimage drift and accepts exact bytes: ${operator.id}`, async () => {
    const content = await readRealGroupMeIndex();
    const spacedPreimage = operator.preimage.replaceAll("\t", "  ");
    assert.notEqual(spacedPreimage, operator.preimage);
    assert.ok(!content.includes(spacedPreimage));

    // Keep the real target and postimage transform unchanged: a normalizing
    // outer guard would accept this stale declaration and apply the mutation.
    assert.throws(
      () => applyOperator({ ...operator, preimage: spacedPreimage }, content),
      PreimageMismatchError
    );
    const mutated = applyOperator(operator, content);
    assert.notEqual(mutated, content);
    assert.equal(mutated, operator.applyPostimage(content));
  });
}

test("applyOperator rejects duplicate exact preimages", () => {
  for (const operator of GROUPME_OPERATORS) {
    assert.throws(() => applyOperator(operator, operator.preimage + "\n" + operator.preimage), PreimageMismatchError);
  }
});
