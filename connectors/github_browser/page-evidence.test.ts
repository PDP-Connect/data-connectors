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
		renderComplete: true,
		hasUnknownContinuation: false,
		terminalProof: "disabled_next",
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

test("source end proof rejects entry loss, absent lists and ambiguous evidence", () => {
 assert.equal(inspectInventoryEnd(inventoryEvidence({
  noProgress: true, renderComplete: true,
 })).complete, true);
 for (const overrides of [{ renderComplete: false }, { rejectedRows: 1 }, { hasRecognizedList: false }, { hasUnknownContinuation: true }])
  assert.equal(inspectInventoryEnd(inventoryEvidence(overrides)).complete, false);
 assert.equal(inspectInventoryEnd(inventoryEvidence({ terminalProof: null, explicitEmpty: true })).complete, false);
});
test("an explicit continuation must be walked", () => {
 assert.equal(inspectInventoryEnd(inventoryEvidence({
  nextUrl: "https://github.com/sample-user?tab=repositories&page=2",
 })).complete, false);
});

test("the exact stars route binds the owner through signed-in identity without a profile nickname", () => {
	const url = "https://github.com/stars/sample-user?page=1";
	const html = '<meta name="user-login" content="sample-user"><main><ul id="user-starred-repos"></ul></main>';
	const evidence = inventoryEvidence({
		stream: "starred", parsedRows: 0,
		page: { requestedUrl: url, currentUrl: url, html },
	});
	assert.equal(inspectInventoryEnd(evidence).complete, true);
	assert.equal(hasExpectedOwner(html, "sample-user"), false);
	for (const wrongHtml of [
		html.replace('content="sample-user"', 'content="other-user"'),
		html.replace('<meta name="user-login" content="sample-user">', ""),
	]) {
		assert.equal(inspectInventoryEnd({
			...evidence, page: { ...evidence.page, html: wrongHtml },
		}).reason, "wrong_owner");
	}
	for (const wrongUrl of [
		"https://github.com/stars/other-user?page=1",
		"https://github.com/stars/sample-user/list-name?page=1",
		"https://github.com/stars/sample-user?page=1&q=filtered",
		"https://github.com/stars/sample-user?page=1&page=1",
		"https://example.test/stars/sample-user?page=1",
	]) {
		assert.equal(inspectInventoryEnd({
			...evidence, page: { requestedUrl: wrongUrl, currentUrl: wrongUrl, html },
		}).reason, "wrong_navigation", wrongUrl);
	}
	assert.equal(inspectInventoryEnd({
		...evidence,
		page: { requestedUrl: url, currentUrl: "https://github.com/stars/other-user?page=1", html },
	}).reason, "wrong_navigation");
	const profileUrl = "https://github.com/sample-user?tab=stars&page=1";
	assert.equal(inspectInventoryEnd({
		...evidence, page: { requestedUrl: profileUrl, currentUrl: profileUrl, html },
	}).reason, "wrong_owner");
});
