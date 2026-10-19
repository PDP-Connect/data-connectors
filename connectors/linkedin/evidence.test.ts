// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionEvidence, collectionEvidence, profileEvidence, sectionEvidence, summaryEvidence } from "./evidence.ts";

const me = { plainId: 12, miniProfile: { entityUrn: "urn:li:fs_miniProfile:12", objectUrn: "urn:li:member:12", dashEntityUrn: "urn:li:fsd_profile:12", publicIdentifier: "owner" } };
const profile = { entityUrn: "urn:li:fsd_profile:12", publicIdentifier: "owner" };
const collection = () => ({ elements: [{ entityUrn: "urn:1" }], paging: { start: 0, total: 1 } });

test("source totals require distinct URNs and exact metadata", () => {
	assert.equal(collectionEvidence(collection()), undefined);
	assert.equal(collectionEvidence({ elements: [], paging: { start: 0, total: 0 } }), undefined);
	for (const total of [2, -1, 1.1, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
		assert.ok(collectionEvidence({ ...collection(), paging: { start: 0, total } }));
	}
	assert.equal(collectionEvidence({ ...collection(), elements: [{ entityUrn: "urn:1" }, { entityUrn: "urn:1" }], paging: { start: 0, total: 2 } }), "collection_urn_duplicate");
	assert.equal(collectionEvidence({ ...collection(), elements: [{}] }), "collection_urn_missing");
	assert.equal(collectionEvidence({ elements: [] }), "collection_paging_invalid");
	assert.ok(collectionEvidence({ ...collection(), paging: { total: 1 } }));
	assert.ok(collectionEvidence({ ...collection(), paging: { start: "0", total: 1 } }));
});

test("profile identity requires both exact owner fields", () => {
	assert.equal(profileEvidence(me, profile), undefined);
	assert.equal(profileEvidence(me, { ...profile, entityUrn: "urn:li:fsd_profile:123" }), "profile_identity_mismatch");
	assert.equal(profileEvidence(me, { ...profile, publicIdentifier: "other" }), "profile_identity_mismatch");
	assert.equal(profileEvidence({}, profile), "owner_identity_missing");
});

test("summary totals and owner binding fail closed", () => {
	const summary = { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 1 };
	assert.deepEqual(summaryEvidence(summary, me), { total: 1 });
	assert.equal(summaryEvidence({ ...summary, entityUrn: "urn:li:fsd_connectionsSummary:123" }, me).reason, "summary_owner_mismatch");
	for (const numConnections of [undefined, null, "1", -1, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
		assert.equal(summaryEvidence({ ...summary, numConnections }, me).reason, "summary_total_invalid");
	}
	assert.equal(summaryEvidence({ _error: "http_503" }, me).reason, "summary_request_failed");
});

test("experience proves every group and nested collection; absent nesting is the sole exception", () => {
	const groups = collection();
	assert.equal(sectionEvidence({ profilePositionGroups: groups }, "profilePositionGroups"), undefined);
	const nested = { ...groups, elements: [{ entityUrn: "group:1", profilePositionInPositionGroup: collection() }] };
	assert.equal(sectionEvidence({ profilePositionGroups: nested }, "profilePositionGroups"), undefined);
	for (const value of [null, {}, { ...collection(), paging: { start: 0, total: 2 } }]) {
		assert.ok(sectionEvidence({ profilePositionGroups: { ...groups, elements: [{ entityUrn: "group:1", profilePositionInPositionGroup: value }] } }, "profilePositionGroups")?.startsWith("experience_nested_"));
	}
});

test("connections need stable owner summaries and a confirming empty page", () => {
	const args = { before: { total: 1 }, after: { total: 1 }, distinctCount: 1, missingUrnCount: 0, terminationReason: "observed_end_unproven", pageTotal: null, confirmation: { elements: [] } };
	assert.equal(connectionEvidence(args), undefined);
	assert.equal(connectionEvidence({ ...args, after: { total: 2 } }), "summary_total_changed");
	assert.equal(connectionEvidence({ ...args, distinctCount: 0 }), "connection_total_mismatch");
	assert.equal(connectionEvidence({ ...args, missingUrnCount: 1 }), "connection_urn_missing");
	assert.equal(connectionEvidence({ ...args, terminationReason: "repeated_page" }), "connection_walk_repeated_page");
	assert.equal(connectionEvidence({ ...args, pageTotal: 2 }), "connection_paging_total_mismatch");
	for (const confirmation of [null, {}, { _error: "http_503" }, { elements: [{}] }]) {
		assert.equal(connectionEvidence({ ...args, confirmation }), "connection_confirmation_missing");
	}
	assert.equal(connectionEvidence({ ...args, confirmation: { elements: [], paging: { total: 2 } } }), "connection_confirmation_malformed");
	assert.equal(connectionEvidence({ ...args, before: { total: 0 }, after: { total: 0 }, distinctCount: 0 }), undefined);
});
