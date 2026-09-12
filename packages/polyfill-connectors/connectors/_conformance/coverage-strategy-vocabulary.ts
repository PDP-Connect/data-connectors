// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed pin for the coverage-strategy vocabulary published in the PDPP
 * Collection Profile spec.
 *
 * Why this file exists: the repo-root doc check
 * (`scripts/check-pdpp-authoring-docs.mjs`) asserts that the spec's
 * `coverage_strategy` table lists exactly one set of names. That script is
 * plain JS, so it cannot import `CoverageProofStrategy` — the canonical set is
 * a TYPE union in the vendored contract (`@pdpp/reference-contract/evidence`,
 * `evidence/coherence.ts:38`) and erases at runtime.
 *
 * This array closes that gap the same way
 * `coverage-conformance.test.ts`'s `ALL_COVERAGE_PROOF_STRATEGIES` does: it is
 * typed AGAINST `CoverageProofStrategy[]` and marked exhaustive, so a member
 * added to or removed from the upstream union that this array does not mirror
 * is a COMPILE error here, not silent drift.
 *
 * Scope of the guarantee, stated honestly: this pin proves the list below
 * still matches the upstream union. It does NOT by itself prove the doc check's
 * copy matches — the two lists are kept in sync by the comment reference in
 * `scripts/check-pdpp-authoring-docs.mjs`, which cites this file. Drift between
 * the union and this file fails to compile; drift between this file and the doc
 * fails the doc check's exact-set comparison.
 */

import type { CoverageProofStrategy } from "@pdpp/reference-contract/evidence";

/**
 * Every member of the upstream `CoverageProofStrategy` union.
 *
 * The `Exhaustive` constraint below makes a REMOVED union member a compile
 * error (the literal no longer satisfies the element type) and an ADDED union
 * member a compile error (the mapped-key check no longer covers the union).
 */
export const COVERAGE_STRATEGY_VOCABULARY = [
	"checkpoint_window",
	"full_inventory",
	"parent_detail_accounting",
	"snapshot_import_receipt",
	"singleton_presence",
] as const satisfies readonly CoverageProofStrategy[];

/**
 * Compile-time exhaustiveness proof. If the upstream union gains a member that
 * `COVERAGE_STRATEGY_VOCABULARY` does not list, `Missing` resolves to that
 * member instead of `never` and this assignment fails to compile.
 */
type Missing = Exclude<
	CoverageProofStrategy,
	(typeof COVERAGE_STRATEGY_VOCABULARY)[number]
>;
const _exhaustive: Missing extends never ? true : never = true;
void _exhaustive;
