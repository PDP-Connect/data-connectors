// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scenario hosts (scenario-record, scenario-verify) keep no detail-gap
 * ledger. A connector may still ask for a page of pending gaps
 * (DETAIL_GAPS_PAGE_REQUEST); left unanswered, it waits on stdin until the
 * host's inactivity watchdog kills it, with no DONE. These hosts answer every
 * request with an empty page, as the vana CLI host does.
 */

export interface DetailGapsPageRequestLine {
	type: "DETAIL_GAPS_PAGE_REQUEST";
	request_id: string;
}

export function isDetailGapsPageRequestLine(
	parsed: unknown,
): parsed is DetailGapsPageRequestLine {
	return (
		parsed !== null &&
		typeof parsed === "object" &&
		(parsed as { type?: unknown }).type === "DETAIL_GAPS_PAGE_REQUEST" &&
		typeof (parsed as { request_id?: unknown }).request_id === "string"
	);
}

export function emptyDetailGapsPage(requestId: string): {
	type: "DETAIL_GAPS_PAGE_RESPONSE";
	request_id: string;
	reference_only: true;
	detail_gaps: [];
} {
	return {
		type: "DETAIL_GAPS_PAGE_RESPONSE",
		request_id: requestId,
		reference_only: true,
		detail_gaps: [],
	};
}
