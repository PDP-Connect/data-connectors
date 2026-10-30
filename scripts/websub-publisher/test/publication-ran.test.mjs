// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { publicationRan } from "../publication-ran.mjs";

const name = "Publish and verify the connector catalog";
const job = (conclusion, steps = []) => ({ name, status: "completed", conclusion, steps });
const step = (conclusion) => ({ name, status: "completed", conclusion });

test("a completed catalog job without step metadata triggers safe reconciliation", () => {
  assert.equal(publicationRan([{ jobs: [job("success", [])] }]), true);
});

test("skipped catalog jobs do not trigger a Pages build", () => {
  assert.equal(publicationRan([{ jobs: [job("skipped")] }]), false);
  assert.equal(publicationRan([{ jobs: [job("success", [step("skipped")])] }]), true);
});

test("a catalog attempt triggers reconciliation even if it failed after moving latest", () => {
  for (const outcome of ["success", "failure", "cancelled", "timed_out"]) {
    assert.equal(publicationRan([{ jobs: [] }, { jobs: [job(outcome)] }]), true);
  }
});

test("missing, ambiguous, malformed or unfinished job evidence fails visibly", () => {
  for (const pages of [
    [], [{}], [{ jobs: [] }],
    [{ jobs: [job("skipped"), job("skipped")] }],
    [{ jobs: [{ ...job("success", [step("success")]), status: "in_progress" }] }],
    [{ jobs: [job("unknown")] }],
  ]) assert.throws(() => publicationRan(pages));
});
