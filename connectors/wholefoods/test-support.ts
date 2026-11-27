// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only helpers. Production code does not import this module: identity is
// decided by `bindProduct`, never by reading a page's facts without it.

import { mainSubject } from "./binding.ts";
import { hasCoreNutrition } from "./nutrition-acceptance.ts";
import { readWholeFoodsProductPage } from "./parsers.ts";
import type { NutritionFacts } from "./types.ts";

/**
 * The facts a Whole Foods product page states about its main subject: its
 * first complete panel, else its first panel, or null. Convenience for parser
 * tests: it chooses the subject but does not bind it to a request, so it must
 * not be used to decide that a page is the product asked for.
 */
export function parseWholeFoodsProductPageDom(
	html: string,
): NutritionFacts | null {
	const subject = mainSubject(readWholeFoodsProductPage(html));
	if (subject.kind !== "SUBJECT") return null;
	return subject.panels.find(hasCoreNutrition) ?? subject.panels[0] ?? null;
}
