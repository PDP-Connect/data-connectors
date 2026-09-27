// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one rule for which files inside a bundled connector directory the cross-repo drift
 * job compares against data-connect's vendored copy. `check-connector-source-drift.mjs`
 * applies it to both sides of the comparison, and `pin-backed-paths.mjs` applies it to
 * decide whether a diff touches pin-backed bytes, so the two cannot disagree.
 *
 * Excluded: `*.test.ts` (data-connect does not carry this repo's test suite), anything
 * under a `fixtures/` or `__fixtures__/` directory (test fixture trees, not connector
 * logic), and the connector's `repo.json` (repository metadata, not vendored source).
 *
 * @param {string} rel path relative to the connector directory, `/`-separated
 */
export function isComparedConnectorFile(rel) {
	const parts = rel.split("/");
	const name = parts.at(-1);
	if (name.endsWith(".test.ts")) return false;
	if (rel === "repo.json") return false;
	return !parts.slice(0, -1).some((part) => part === "fixtures" || part === "__fixtures__");
}
