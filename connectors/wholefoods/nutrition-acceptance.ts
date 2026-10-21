// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one place that decides whether a nutrition observation may be emitted.
//
// A nutrition row replaces the stored row under its key (`mutable_state`), so
// emitting is a claim that the observation is at least as good as what is
// stored. Two things make an observation unfit, whatever its parse:
//   - it does not state the core rows of a Nutrition Facts panel, so it would
//     blank facts read earlier; and
//   - it is a fuzzy USDA text match made while a page source was blocked or
//     failed, so it would put another product's facts under this product's key
//     on the strength of a lookup that could not check the real page.
// The connector keeps no per-key record of which source produced the stored
// row, so the second rule is stated against this run's page-source health.

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

/** Whether the page sources (Amazon product page, Whole Foods search and
 *  product pages) answered this run. `degraded` means one was blocked, returned
 *  an HTTP error, or threw: its silence is not "no panel on the page". */
export interface PageSourceHealth {
	readonly degraded: boolean;
}

/** A nutrition observation that may be emitted. `acceptNutrition` is the only
 *  way to obtain one, and row building takes nothing else. */
export type AcceptedNutrition = NutritionFacts & { readonly accepted: true };

export function acceptNutrition(
	facts: NutritionFacts | null,
	pages: PageSourceHealth,
): AcceptedNutrition | null {
	if (!(facts && hasCoreNutrition(facts))) return null;
	const fuzzyUsda =
		facts.source === "usda_fdc" && facts.usdaMatchMethod !== "upc";
	if (fuzzyUsda && pages.degraded) return null;
	return { ...facts, accepted: true as const };
}
