// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// The known-killable production comparison every admitted run must kill through its
// native owner. It is located by text at HEAD, never by a fixed line number.
export const canary = Object.freeze({
	file: "connectors/groupme/index.ts",
	anchor: "curr.created_at < prev.created_at",
	original: "<",
	replacement: "<=",
	owner: Object.freeze({
		file: "connectors/groupme/incremental-frontier.test.ts",
		name: "ordinary resume: equal timestamps with advancing IDs collect and advance across pages",
		message:
			"equal timestamps with advancing IDs must not fail the forward walk",
	}),
});

// The full expression Stryker reports as the replacement for the canary's operator.
export const canaryReplacementText = canary.anchor.replace(
	canary.original,
	canary.replacement,
);

// Returns the 1-based line and column where the canary expression starts.
export function locateCanary(source) {
	const lines = source.split("\n");
	const hits = [];
	lines.forEach((text, index) => {
		if (text.includes(canary.anchor)) hits.push(index);
	});
	if (hits.length !== 1)
		throw new Error(
			`canary anchor must occur exactly once in ${canary.file}; found ${hits.length}`,
		);
	return {
		line: hits[0] + 1,
		column: lines[hits[0]].indexOf(canary.anchor) + 1,
	};
}
