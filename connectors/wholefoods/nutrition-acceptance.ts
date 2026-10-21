// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one place that decides whether a nutrition observation may be emitted.
//
// A nutrition row replaces the stored row under its key (`mutable_state`), so
// emitting is a claim that the observation is at least as good as what is
// stored. Two things make an observation unfit, whatever its parse:
//   - it does not state the core rows of a Nutrition Facts panel, so it would
//     blank facts read earlier; and
//   - it is a fuzzy USDA text match, which names another product, made while
//     the product's own pages could still be speaking for it: one was blocked,
//     failed or was not recognised, or one showed part of this product's panel.
//     That is a degraded or partial read of this product, not "no panel".
// The connector keeps no per-key record of which source produced the stored
// row, so the second rule is stated against what this run's page sources said.

import type { CoreNutritionRow, NutritionFacts } from "./types.ts";

const CORE_ROWS: readonly CoreNutritionRow[] = [
	"calories",
	"carbs",
	"fat",
	"protein",
];

/** True when the source stated calories (with an amount) and every other core
 *  row. A "<1 g" row counts as stated; an absent row does not. */
export function hasCoreNutrition(facts: NutritionFacts): boolean {
	return (
		typeof facts.calories === "number" &&
		CORE_ROWS.every((row) => facts.coreStated.includes(row))
	);
}

/** What this run's page sources (Amazon product page, Whole Foods search and
 *  product pages) said about THIS product's panel, when none of them gave a
 *  complete one:
 *  - `none`: every page source answered and none showed a core row, so the
 *    product has no panel on the pages;
 *  - `partial`: a source showed some core rows for this product but not all,
 *    a partial render of a panel that may have been complete before;
 *  - `unknown`: a source was blocked, failed, or showed no recognisable
 *    product, so its silence says nothing. */
export type PageSourceEvidence = "none" | "partial" | "unknown";

/** A nutrition observation that may be emitted. `acceptNutrition` is the only
 *  way to obtain one, and row building takes nothing else. */
export type AcceptedNutrition = NutritionFacts & { readonly accepted: true };

export function acceptNutrition(
	facts: NutritionFacts | null,
	pages: PageSourceEvidence,
): AcceptedNutrition | null {
	if (!(facts && hasCoreNutrition(facts))) return null;
	const fuzzyUsda =
		facts.source === "usda_fdc" && facts.usdaMatchMethod !== "upc";
	if (fuzzyUsda && pages !== "none") return null;
	return { ...facts, accepted: true as const };
}
