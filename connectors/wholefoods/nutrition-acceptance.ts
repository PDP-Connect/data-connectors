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

/** The first of a bound product's panels that may be emitted, or null. The
 *  panels are every observation proven to be this product's; a complete one
 *  wins whatever else the page shows (a partial structured panel does not
 *  hide a complete rendered one). */
export function selectNutrition(
	panels: readonly NutritionFacts[],
	pages: PageSourceEvidence,
): AcceptedNutrition | null {
	for (const panel of panels) {
		const accepted = acceptNutrition(panel, pages);
		if (accepted) return accepted;
	}
	return null;
}

/** The outcome of one product's nutrition lookup, as a split a type can
 *  enforce: a `matched` outcome carries the accepted observation and nothing
 *  else; every other outcome carries a status and a cause code and no facts.
 *  The cause codes are stable; they are documented in the manifest.
 *
 *  | status    | cause               | meaning                                          |
 *  |-----------|---------------------|--------------------------------------------------|
 *  | blocked   | robot_check         | a page was a captcha / robot check               |
 *  | error     | http_error          | a page answered HTTP 4xx/5xx (not 404/410)       |
 *  | error     | navigation_failed   | a page read threw                                |
 *  | error     | unrecognized_page   | a 200 page that is not a known product/search page |
 *  | error     | identity_conflict   | a page that cannot be this product: another ASIN, order or origin, an ambiguous main product, or a product page whose structured data and heading name different products |
 *  | error     | identity_unbound    | a page with no identity evidence to bind it to this product |
 *  | error     | panel_partial       | this product's panel was seen but not fully read |
 *  | error     | usda_request_failed | the USDA lookup failed                           |
 *  | not_found | no_match            | every source answered; none had a usable panel   |
 *
 *  When several sources fail, `robot_check` wins; otherwise the first failure. */
export type NutritionNoMatch =
	| { readonly status: "blocked"; readonly cause: "robot_check" }
	| {
			readonly status: "error";
			readonly cause:
				| "http_error"
				| "navigation_failed"
				| "unrecognized_page"
				| "identity_conflict"
				| "identity_unbound"
				| "panel_partial"
				| "usda_request_failed";
	  }
	| { readonly status: "not_found"; readonly cause: "no_match" };

export type NutritionLookup =
	| { readonly status: "matched"; readonly facts: AcceptedNutrition }
	| NutritionNoMatch;

/** Failures a page read can report; a subset of `NutritionNoMatch`. */
export type PageReadFailure = Extract<
	NutritionNoMatch,
	{ status: "blocked" | "error" }
>;
