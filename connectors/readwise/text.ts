// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const TEXT_ENCODING = "pdpp-safe-escape-v1";

// Escaping literal backslashes makes the conversion reversible.
export function encodeText(text: string): string {
	return text.replace(/[\\\p{Cc}\p{Cs}]/gu, (char) => {
		if (char === "\t" || char === "\n" || char === "\r") return char;
		return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
	});
}

export function decodeEscapedText(text: string): string {
	return text.replace(/\\u([0-9a-f]{4})/g, (_match, hex: string) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}
