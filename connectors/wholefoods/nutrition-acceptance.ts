// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one place that decides whether a nutrition observation may be emitted.
//
// A nutrition row replaces the stored row under its key (`mutable_state`), so
// emitting is a claim that the observation is at least as good as what is
// stored. An observation that does not state the core rows of a Nutrition
// Facts panel would blank facts read earlier, so it is not emitted.
//
// The connector collects only what the owner's own sources show: the Amazon
// product page and the Whole Foods product pages the order links to. It does
// not look nutrition up anywhere else. A product whose panel could not be read
// has no nutrition row; `SourceAnswer` records why, for the run log.

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

/** What one source read (the Amazon product page, the Whole Foods search, one
 *  Whole Foods tile) said about THIS product's panel. Every read yields
 *  exactly one answer; a complete panel is emitted at once and needs none.
 *  - `panel`: the read showed some core rows of this product's own panel, but
 *    not all: a partial render of a panel that may have been complete;
 *  - `proven_absent`: the read proves there is no panel there, by `proof`;
 *  - `unknown`: the read proves nothing (blocked, failed, ended off-site,
 *    unbound, unfinished, a panel whose owner is unresolved, an empty state
 *    that is not rendered). Its silence says nothing. */
export type SourceAnswer =
	| { readonly kind: "panel" }
	| { readonly kind: "proven_absent"; readonly proof: AbsenceProof }
	| { readonly kind: "unknown"; readonly failure: PageReadFailure };

/** The only ways a read proves absence:
 *  - `gone`: the source's own 404/410 for the page;
 *  - `page_without_panel`: a rendered page bound to this product that shows
 *    no panel at all (not even one whose owner is unresolved);
 *  - `other_product`: a readable page bound to another product;
 *  - `visible_empty_search`: the search page's own rendered empty state.
 *  A search walk is complete only when every result was read: a walk cut
 *  short by the tile budget adds an `unknown` answer. */
export type AbsenceProof =
	| "gone"
	| "page_without_panel"
	| "other_product"
	| "visible_empty_search";

/** What all of this run's page sources said, reduced:
 *  - `none`: every consulted source is `proven_absent`, so the product has no
 *    panel on the pages;
 *  - `partial`: a source showed part of this product's panel;
 *  - `unknown`: a source answered `unknown`. */
export type PageSourceEvidence = "none" | "partial" | "unknown";

export function pageEvidence(
	answers: readonly SourceAnswer[],
): PageSourceEvidence {
	if (answers.some((answer) => answer.kind === "unknown")) return "unknown";
	if (answers.some((answer) => answer.kind === "panel")) return "partial";
	return "none";
}

/** Why there is no row: the strongest unresolved read (a robot check wins,
 *  otherwise the first), else a partial panel, else nothing found.
 *  `not_found` needs every source proven absent. */
export function noMatch(answers: readonly SourceAnswer[]): NutritionNoMatch {
	const failures = answers.flatMap((answer) =>
		answer.kind === "unknown" ? [answer.failure] : [],
	);
	const failure =
		failures.find((reason) => reason.status === "blocked") ?? failures[0];
	if (failure) return failure;
	if (pageEvidence(answers) === "partial") {
		return { status: "error", cause: "panel_partial" };
	}
	return { status: "not_found", cause: "no_match" };
}

/** A nutrition observation that may be emitted. `acceptNutrition` is the only
 *  way to obtain one, and row building takes nothing else. */
export type AcceptedNutrition = NutritionFacts & { readonly accepted: true };

export function acceptNutrition(
	facts: NutritionFacts | null,
): AcceptedNutrition | null {
	if (!(facts && hasCoreNutrition(facts))) return null;
	return { ...facts, accepted: true as const };
}

/** The first of a bound product's panels that may be emitted, or null. The
 *  panels are every observation proven to be this product's; a complete one
 *  wins whatever else the page shows (a partial structured panel does not
 *  hide a complete rendered one). */
export function selectNutrition(
	panels: readonly NutritionFacts[],
): AcceptedNutrition | null {
	for (const panel of panels) {
		const accepted = acceptNutrition(panel);
		if (accepted) return accepted;
	}
	return null;
}

/** The outcome of one product's nutrition lookup, as a split a type can
 *  enforce: a `matched` outcome carries the accepted observation and nothing
 *  else; every other outcome carries a status and a cause code and no facts.
 *  Only a matched outcome becomes a row. The others go to the run log, and
 *  `error` and `blocked` also mark the stream's read as incomplete, because a
 *  later run may read what this one could not.
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
 *  | error     | panel_unresolved    | a bound page shows a panel that cannot be proven this product's |
 *  | error     | search_incomplete   | the search listed more results than the walk reads |
 *  | not_found | no_match            | every source proved it has no usable panel       |
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
				| "panel_unresolved"
				| "search_incomplete";
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
