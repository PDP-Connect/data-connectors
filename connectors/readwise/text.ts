// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const TEXT_ENCODING = "pdpp-safe-escape-v1";

// Matches connectors/anthropic/safe-escape.ts and its reference vectors.
const ESCAPE_SCAN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escaped set IS these control characters
	/\\u([0-9a-fA-F]{4})|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/gu;
const ESCAPE_TOKEN = /\\u([0-9a-fA-F]{4})/g;
const BACKSLASH_UNIT = 0x5c;

/** Code units the encoding writes as `\uXXXX`: forbidden controls, lone surrogates and backslash. */
function isEscapedUnit(unit: number): boolean {
	return (
		unit === BACKSLASH_UNIT ||
		unit <= 0x08 ||
		unit === 0x0b ||
		unit === 0x0c ||
		(unit >= 0x0e && unit <= 0x1f) ||
		(unit >= 0x7f && unit <= 0x9f) ||
		(unit >= 0xd8_00 && unit <= 0xdf_ff)
	);
}

function escapeSequence(unit: number): string {
	return `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Each position of `s` that the encoding rewrites, and the code unit it writes. */
function* escapeSites(s: string): Generator<{ index: number; unit: number }> {
	for (const match of s.matchAll(ESCAPE_SCAN)) {
		const hex = match[1];
		const index = match.index ?? 0;
		if (hex === undefined) {
			yield { index, unit: match[0].charCodeAt(0) };
		} else if (isEscapedUnit(Number.parseInt(hex, 16))) {
			yield { index, unit: BACKSLASH_UNIT };
		}
	}
}

/**
 * Lossless, deterministic PDPP-safe encoding of text. Each escaped unit becomes
 * `\uXXXX` (uppercase hex). A source backslash that begins a `\uXXXX` the
 * decoder would read as an escape is itself written `\u005C`, so decoding is
 * unambiguous. All other text, including ordinary backslashes, is unchanged.
 */
export function encodeText(s: string): string {
	const parts: string[] = [];
	let last = 0;
	for (const { index, unit } of escapeSites(s)) {
		parts.push(s.slice(last, index), escapeSequence(unit));
		last = index + 1;
	}
	if (parts.length === 0) return s;
	parts.push(s.slice(last));
	return parts.join("");
}

/** Inverse of the encoding: restores the exact source text. */
export function decodeEscapedText(s: string): string {
	return s.replace(ESCAPE_TOKEN, (match, hex: string) => {
		const unit = Number.parseInt(hex, 16);
		return isEscapedUnit(unit) ? String.fromCharCode(unit) : match;
	});
}
