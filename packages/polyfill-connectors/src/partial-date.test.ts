// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEnglishPartialDate } from "./partial-date.ts";

test("English partial dates preserve spelling acceptance and printed precision, and reject days the calendar lacks", () => {
	const cases: [string | null | undefined, string | null][] = [
		[null, null],
		[undefined, null],
		["", null],
		[" \t\n ", null],
		["unknown", null],
		["not set", null],
		["Aug 27, 2023", "2023-08-27"],
		["August 7, 2023", "2023-08-07"],
		["Dec 01, 1963", "1963-12-01"],
		["Dec 01, 2020", "2020-12-01"],
		["Feb 2022", "2022-02"],
		["September 2019", "2019-09"],
		["1892", "1892"],
		["2023-08-27", "2023-08-27"],
		["2023-08", "2023-08"],
		["0000", "0000"],
		["2023-99-99", null],
		["2023-99", null],
		["February 31, 2023", null],
		["Sep 1 2023", "2023-09-01"],
		["Sept. 1, 2023", "2023-09-01"],
		["JANUARY 2, 2023", "2023-01-02"],
		["aUgUsT. 7 2023", "2023-08-07"],
		["Feb. 2022", "2022-02"],
		["Feb, 2022", "2022-02"],
		["Feb., 2022", "2022-02"],
		["‎ Aug\t7,\n 2023 ‏", "2023-08-07"],
		[" ‎2023-08‏ ", "2023-08"],
		["Smarch 3, 2020", null],
		["février 2023", null],
		["Feb 2023 trailing", null],
		["Feb 0 2023", null],
		["Feb 32 2023", null],
		["Feb 1,2023", null],
		["Feb.. 2023", null],
		["23", null],
		["2023-8", null],
		["2023-13", null],
		["2023-00", null],
		["2023-02-29", null],
		["2024-02-29", "2024-02-29"],
		["Feb 29, 2024", "2024-02-29"],
		["Feb 29, 2023", null],
		["Apr 31, 2023", null],
		["1900-02-29", null],
		["2000-02-29", "2000-02-29"],
	];
	for (const [input, expected] of cases) {
		assert.equal(normalizeEnglishPartialDate(input), expected, String(input));
		if (expected !== null) {
			assert.equal(normalizeEnglishPartialDate(expected), expected);
		}
	}
});

test("every English month name and abbreviation is retained", () => {
	const names = [
		["Jan", "January"],
		["Feb", "February"],
		["Mar", "March"],
		["Apr", "April"],
		["May"],
		["Jun", "June"],
		["Jul", "July"],
		["Aug", "August"],
		["Sep", "Sept", "September"],
		["Oct", "October"],
		["Nov", "November"],
		["Dec", "December"],
	];
	for (const [index, spellings] of names.entries()) {
		const month = String(index + 1).padStart(2, "0");
		for (const spelling of spellings) {
			for (const name of [spelling.toLowerCase(), spelling.toUpperCase()]) {
				for (const [input, expected] of [
					[`${name} 2023`, `2023-${month}`],
					[`${name}. 1, 2023`, `2023-${month}-01`],
				] as Array<[string, string]>) {
					assert.equal(normalizeEnglishPartialDate(input), expected, input);
					assert.equal(normalizeEnglishPartialDate(expected), expected);
				}
			}
		}
	}
});
