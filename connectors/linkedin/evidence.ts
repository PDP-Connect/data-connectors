// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isRecord } from "./field-read.ts";

/** Undefined means proved; every failure is named and carries no invented total. */
export type EvidenceFailure = string | undefined;
export const safeTotal = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

export function profileEvidence(me: unknown, profile: unknown): EvidenceFailure {
	if (!isRecord(me) || !isRecord(me.miniProfile) ||
		!identity(me.miniProfile.dashEntityUrn) || !identity(me.miniProfile.publicIdentifier)) {
		return "owner_identity_missing";
	}
	if (!isRecord(profile) || profile.entityUrn !== me.miniProfile.dashEntityUrn ||
		profile.publicIdentifier !== me.miniProfile.publicIdentifier) return "profile_identity_mismatch";
	return undefined;
}

export function summaryEvidence(summary: unknown, me: unknown):
	{ total: number; reason?: undefined } | { total?: undefined; reason: string } {
	if (!isRecord(summary) || Object.hasOwn(summary, "_error")) return { reason: "summary_request_failed" };
	if (!safeTotal(summary.numConnections)) return { reason: "summary_total_invalid" };
	if (!isRecord(me) || !isRecord(me.miniProfile) || !safeTotal(me.plainId) || !identity(me.miniProfile.dashEntityUrn)) {
		return { reason: "owner_identity_missing" };
	}
	// Profile IDs are opaque; only objectUrn is bound to the numeric plainId.
	const profileId = /^urn:li:fsd_profile:([^:]+)$/u.exec(me.miniProfile.dashEntityUrn)?.[1];
	if (!profileId || !profileId.trim() ||
		me.miniProfile.entityUrn !== `urn:li:fs_miniProfile:${profileId}` ||
		me.miniProfile.objectUrn !== `urn:li:member:${me.plainId}`) return { reason: "owner_identity_missing" };
	if (summary.entityUrn !== `urn:li:fs_relConnectionsSummary:${profileId}` &&
		summary.entityUrn !== `urn:li:fsd_connectionsSummary:${profileId}`) return { reason: "summary_owner_mismatch" };
	return { total: summary.numConnections };
}

export function collectionEvidence(value: unknown): EvidenceFailure {
	if (!isRecord(value) || !Array.isArray(value.elements)) return "collection_malformed";
	if (!isRecord(value.paging) || value.paging.start !== 0 || !safeTotal(value.paging.total)) {
		return "collection_paging_invalid";
	}
	if (value.paging.links !== undefined && (!Array.isArray(value.paging.links) || value.paging.links.length > 0)) return "collection_continuation_advertised";
	const ids = new Set<string>();
	for (const element of value.elements) {
		if (!isRecord(element) || !identity(element.entityUrn)) return "collection_urn_missing";
		if (ids.has(element.entityUrn)) return "collection_urn_duplicate";
		ids.add(element.entityUrn);
	}
	if (value.paging.total !== ids.size) return "collection_total_mismatch";
	return undefined;
}

export function sectionEvidence(profile: unknown, key: string): EvidenceFailure {
	if (!isRecord(profile)) return "collection_malformed";
	const collection = profile[key];
	const reason = collectionEvidence(collection);
	if (reason) return reason;
	if (!isRecord(collection) || !Array.isArray(collection.elements)) return "collection_malformed";
	if (key === "profilePositionGroups") {
		const flattenedIds = new Set<unknown>();
		for (const group of collection.elements) {
			if (!isRecord(group)) return "collection_malformed";
			// Groups without positions produce one row using the group's own ID.
			let positions = [group];
			if (Object.hasOwn(group, "profilePositionInPositionGroup")) {
				const nested = collectionEvidence(group.profilePositionInPositionGroup);
				if (nested) return `experience_nested_${nested}`;
				const nestedCollection = group.profilePositionInPositionGroup;
				if (!isRecord(nestedCollection) || !Array.isArray(nestedCollection.elements)) return "collection_malformed";
				if (nestedCollection.elements.length > 0) positions = nestedCollection.elements;
			}
			for (const position of positions) {
				if (flattenedIds.has(position.entityUrn)) return "experience_flattened_id_duplicate";
				flattenedIds.add(position.entityUrn);
			}
		}
	}
	if (key === "profileSkills" && collection.elements.some((entry) =>
		isRecord(entry) && (Object.hasOwn(entry, "skills") || Object.hasOwn(entry, "elements")))) {
		return "skills_nested_unproven";
	}
	return undefined;
}

export function connectionEvidence(args: {
	before: ReturnType<typeof summaryEvidence>;
	after: ReturnType<typeof summaryEvidence>;
	distinctCount: number;
	missingUrnCount: number;
	terminationReason: string;
	pageTotal: number | null;
	confirmation: unknown;
}): EvidenceFailure {
	const { before, after, distinctCount, missingUrnCount, terminationReason, pageTotal, confirmation } = args;
	if (before.reason) return before.reason;
	if (after.reason) return after.reason;
	if (before.total !== after.total) return "summary_total_changed";
	if (missingUrnCount !== 0) return "connection_urn_missing";
	if (terminationReason !== "observed_end_unproven") return `connection_walk_${terminationReason}`;
	if (pageTotal !== null && pageTotal !== before.total) return "connection_paging_total_mismatch";
	if (distinctCount !== before.total) return "connection_total_mismatch";
	if (!isRecord(confirmation) || Object.hasOwn(confirmation, "_error") ||
		!Array.isArray(confirmation.elements) || confirmation.elements.length !== 0) return "connection_confirmation_missing";
	if (Object.hasOwn(confirmation, "paging")) {
		const paging = confirmation.paging;
		if (!isRecord(paging) ||
			(Object.hasOwn(paging, "start") && paging.start !== before.total) ||
			(Object.hasOwn(paging, "total") && paging.total !== before.total) ||
			(Object.hasOwn(paging, "links") && (!Array.isArray(paging.links) || paging.links.length > 0))) return "connection_confirmation_malformed";
	}
	return undefined;
}
