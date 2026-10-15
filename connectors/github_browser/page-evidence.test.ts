// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	hasExpectedOwner,
	type InventoryEndEvidence,
	inspectInventoryEnd,
	sameNavigation,
} from "./page-evidence.ts";

const ownerPage =
	'<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span><main><ul id="user-repositories-list"></ul></main>';

function inventoryEvidence(
	overrides: Partial<InventoryEndEvidence> = {},
): InventoryEndEvidence {
	const url = "https://github.com/sample-user?tab=repositories&page=1";
	return {
		page: { requestedUrl: url, currentUrl: url, html: ownerPage },
		username: "sample-user",
		stream: "repositories",
		pageNumber: 1,
		parsedRows: 1,
		rejectedRows: 0,
		noProgress: false,
		explicitEmpty: false,
		hasRecognizedList: true,
		nextUrl: null,
		...overrides,
	};
}

test("inventory end evidence is bound to the exact owner request and navigation", () => {
	assert.equal(inspectInventoryEnd(inventoryEvidence()).complete, true);
	assert.equal(
		inspectInventoryEnd(
			inventoryEvidence({
				page: {
					requestedUrl: "https://github.com/other-user?tab=repositories&page=1",
					currentUrl: "https://github.com/other-user?tab=repositories&page=1",
					html: ownerPage,
				},
			}),
		).complete,
		false,
	);
	assert.equal(
		inspectInventoryEnd(
			inventoryEvidence({
				page: {
					requestedUrl:
						"https://github.com/sample-user?tab=repositories&page=1",
					currentUrl: "https://github.com/sample-user?tab=repositories&page=2",
					html: ownerPage,
				},
			}),
		).complete,
		false,
	);
	assert.equal(
		hasExpectedOwner(
			ownerPage.replace("sample-user</span>", "other-user</span>"),
			"sample-user",
		),
		false,
	);
	assert.equal(
		sameNavigation(
			"https://github.com/sample-user?tab=stars&page=1",
			"https://github.com/sample-user?tab=stars&page=2",
		),
		false,
	);
});

test("blocked, unloaded, and discarded-row vetoes beat terminal signals", () => {
	assert.equal(
		inspectInventoryEnd(
			inventoryEvidence({
				page: {
					...inventoryEvidence().page,
					html: "<main>Sign in to GitHub</main>",
				},
				explicitEmpty: true,
			}),
		).complete,
		false,
	);
	assert.equal(
		inspectInventoryEnd(
			inventoryEvidence({
				hasRecognizedList: false,
				explicitEmpty: false,
			}),
		).complete,
		false,
	);
	assert.equal(
		inspectInventoryEnd(
			inventoryEvidence({
				rejectedRows: 1,
				explicitEmpty: true,
			}),
		).complete,
		false,
	);
});

test("a remaining or no-progress continuation cannot prove completion", () => {
	const remaining = inspectInventoryEnd(
		inventoryEvidence({
			pageNumber: 1,
			nextUrl: "https://github.com/sample-user?tab=repositories&page=2",
		}),
	);
	assert.equal(remaining.complete, false);
	assert.equal(remaining.reason, "remaining_continuation");
	const noProgress = inspectInventoryEnd(
		inventoryEvidence({
			nextUrl: "https://github.com/sample-user?tab=repositories&page=2",
			noProgress: true,
		}),
	);
	assert.equal(noProgress.complete, false);
	assert.equal(noProgress.reason, "no_progress");
});
