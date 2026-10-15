// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface SpotifyEndEvidence {
	stream: string;
	operation: string;
	navigation: string;
	owner: string;
	selector: string;
	firstOffset: number;
	lastOffset: number;
	pageCount: number;
	rawCount: number;
	expectedCount: number | null;
	discardedCount: number;
	remaining: boolean;
	terminal: "empty_verified" | "short_page" | "total_reached" | null;
}

export interface SpotifyEndExpectation {
	stream: string;
	operation: string;
	owner: string;
	selector: string;
}

/**
 * A positive source boundary is valid only for the request context that read
 * it, and only after every known gap veto has been checked.
 */
export function hasSpotifyEndProof(
	evidence: SpotifyEndEvidence | null | undefined,
	expected: SpotifyEndExpectation,
): evidence is SpotifyEndEvidence {
	return (
		hasSpotifyTerminalBoundary(evidence, expected) &&
		evidence.discardedCount === 0
	);
}

/** True after the source end is proven even when one or more rows lack identity. */
export function hasSpotifyTerminalBoundary(
	evidence: SpotifyEndEvidence | null | undefined,
	expected: SpotifyEndExpectation,
): evidence is SpotifyEndEvidence {
	if (
		!evidence ||
		evidence.stream !== expected.stream ||
		evidence.operation !== expected.operation ||
		evidence.navigation !== "https://open.spotify.com/" ||
		evidence.owner !== expected.owner ||
		evidence.selector !== expected.selector ||
		!Number.isSafeInteger(evidence.firstOffset) ||
		evidence.firstOffset !== 0 ||
		!Number.isSafeInteger(evidence.lastOffset) ||
		evidence.lastOffset < 0 ||
		!Number.isSafeInteger(evidence.pageCount) ||
		evidence.pageCount < 1 ||
		!Number.isSafeInteger(evidence.rawCount) ||
		evidence.rawCount < 0 ||
		(evidence.expectedCount !== null &&
			(!Number.isSafeInteger(evidence.expectedCount) ||
				evidence.expectedCount < 0)) ||
		!Number.isSafeInteger(evidence.discardedCount) ||
		evidence.discardedCount < 0 ||
		evidence.discardedCount > evidence.rawCount ||
		(evidence.expectedCount !== null &&
			evidence.rawCount !== evidence.expectedCount) ||
		evidence.remaining ||
		(evidence.terminal !== "empty_verified" &&
			evidence.terminal !== "short_page" &&
			evidence.terminal !== "total_reached") ||
		(evidence.terminal === "empty_verified" && evidence.rawCount !== 0) ||
		(evidence.terminal === "short_page" && evidence.expectedCount !== null) ||
		(evidence.terminal === "total_reached" && evidence.expectedCount === null)
	) {
		return false;
	}
	return true;
}
