// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { highlightsSchema } from "./schemas.ts";
import { decodeEscapedText, encodeText } from "./text.ts";

// text.ts is a copy of the pdpp-safe-escape-v1 codec in
// connectors/anthropic/safe-escape.ts. These shared vectors make a drift in
// the copy fail here.
const fixture = JSON.parse(
	readFileSync(
		new URL("../anthropic/safe-escape-vectors.json", import.meta.url),
		"utf8",
	),
) as { vectors: Array<{ raw: string; encoded: string }> };

test("encodeText matches every shared reference vector in both directions", () => {
	assert.ok(fixture.vectors.length > 100);
	for (const { raw, encoded } of fixture.vectors) {
		assert.equal(encodeText(raw), encoded, JSON.stringify(raw));
		assert.equal(decodeEscapedText(encoded), raw, JSON.stringify(raw));
	}
});

test("astral text is unchanged, a lone surrogate is escaped, and decoding runs once", () => {
	const cases = [
		{ raw: "\u{1F600}", encoded: "\u{1F600}" },
		{ raw: "\uD800", encoded: "\\uD800" },
		{ raw: "\\u0000", encoded: "\\u005Cu0000" },
	];
	for (const { raw, encoded } of cases) {
		assert.equal(encodeText(raw), encoded);
		assert.equal(decodeEscapedText(encoded), raw);
	}
});

// Limits count the decoded text in UTF-16 code units; the encoded form may be
// up to six times longer and is never truncated.
const boundaries = [
	{
		name: "100,000 NULs encode to exactly 600,000 units",
		raw: "\u0000".repeat(100_000),
		encodedUnits: 600_000,
		accepted: true,
	},
	{
		name: "99,999 letters and a NUL",
		raw: `${"a".repeat(99_999)}\u0000`,
		encodedUnits: 100_005,
		accepted: true,
	},
	{
		name: "one unit past the limit",
		raw: `${"a".repeat(99_999)}\u0000a`,
		encodedUnits: 100_006,
		accepted: false,
	},
	{
		name: "50,000 emoji fill 100,000 code units",
		raw: "\u{1F600}".repeat(50_000),
		encodedUnits: 100_000,
		accepted: true,
	},
	{
		name: "50,000 emoji and a letter",
		raw: `${"\u{1F600}".repeat(50_000)}a`,
		encodedUnits: 100_001,
		accepted: false,
	},
];
for (const { name, raw, encodedUnits, accepted } of boundaries) {
	test(`highlight text limit: ${name}`, () => {
		const encoded = encodeText(raw);
		assert.equal(encoded.length, encodedUnits);
		assert.equal(decodeEscapedText(encoded), raw);
		assert.equal(
			highlightsSchema.shape.text.safeParse(encoded).success,
			accepted,
		);
	});
}
