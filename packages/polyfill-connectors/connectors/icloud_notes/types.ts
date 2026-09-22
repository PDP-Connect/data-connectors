// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire shapes for the CloudKit `records/query` response used by the
 * `com.apple.notes` private database. These are narrow, hand-written types
 * for the fields this connector actually reads — CloudKit's record schema is
 * undocumented and not a stable public contract, so we narrow at the
 * boundary with manual guards (see `parsers.ts`) rather than trusting a
 * fuller shape we have not observed.
 */

export interface CloudKitFieldValue {
	type?: string;
	value?: unknown;
}

export interface CloudKitRecordRef {
	recordName?: string;
	zoneID?: { zoneName?: string };
}

export interface CloudKitRecord {
	recordName?: string;
	recordType?: string;
	fields?: Record<string, CloudKitFieldValue>;
	created?: { timestamp?: number };
	modified?: { timestamp?: number };
}

export interface CloudKitQueryResponse {
	records?: CloudKitRecord[];
	continuationMarker?: string;
}

export interface CloudKitValidateResponse {
	dsInfo?: {
		dsid?: string | number;
		fullName?: string;
	};
	webservices?: {
		ckdatabasews?: { url?: string };
	};
}

export interface CloudKitConfig {
	ckBaseUrl: string;
	dsid: string;
	fullName: string | null;
}

/** Same shape `redditFetch`/`RedditFetchResult` use: the page-evaluate bridge
 *  reports transport status separately from the parsed body so the caller can
 *  classify auth/rate-limit/parse failures without re-parsing text. */
export interface CloudKitFetchResult {
	status: number;
	json: unknown;
}
