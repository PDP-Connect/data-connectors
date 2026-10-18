// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Skip gate for tests that need their own bwrap/unshare namespaces.
 *
 * Returns `unavailable` unchanged, except in the `sandboxed` lane (see
 * scripts/run-tests.mjs): there the test-sandbox's bwrap blocks nested
 * namespaces, so a skip would hide a misplaced file. It throws instead.
 */
export function namespaceSkip(unavailable: boolean): boolean {
	if (unavailable && process.env.TEST_LANE === "sandboxed") {
		throw new Error(
			"this test file needs its own namespaces (bwrap/unshare) and cannot run in the sandboxed lane; " +
				"list it in NAMESPACE_TESTS in scripts/run-tests.mjs",
		);
	}
	return unavailable;
}
