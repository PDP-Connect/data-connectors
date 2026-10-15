// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseHTML } from "linkedom";

export interface BrowserPageObservation {
	readonly requestedUrl: string;
	readonly currentUrl: string;
	readonly html: string;
}

export interface InventoryEndEvidence {
	readonly page: BrowserPageObservation;
	readonly username: string;
	readonly stream: "repositories" | "starred";
	readonly pageNumber: number;
	readonly parsedRows: number;
	readonly rejectedRows: number;
	readonly noProgress: boolean;
	readonly explicitEmpty: boolean;
	readonly hasRecognizedList: boolean;
	readonly nextUrl: string | null;
}

export interface InventoryEndResult {
	readonly complete: boolean;
	readonly nextUrl: string | null;
	readonly reason:
		| "blocked_page"
		| "wrong_navigation"
		| "wrong_owner"
		| "unreadable_list"
		| "discarded_rows"
		| "no_progress"
		| "remaining_continuation"
		| "empty_unverified"
		| "terminal_list";
}

/**
 * Decide whether one inventory page proves its own terminal state.
 * Every negative condition is checked before terminal evidence is considered.
 */
export function inspectInventoryEnd(
	evidence: InventoryEndEvidence,
): InventoryEndResult {
	const { page, stream, username, pageNumber } = evidence;
	if (isBlocked(page.html))
		return { complete: false, nextUrl: null, reason: "blocked_page" };
	if (!sameNavigation(page.requestedUrl, page.currentUrl))
		return { complete: false, nextUrl: null, reason: "wrong_navigation" };
	if (!isExpectedRequest(page.requestedUrl, stream, username, pageNumber))
		return { complete: false, nextUrl: null, reason: "wrong_navigation" };
	if (!hasExpectedOwner(page.html, username))
		return { complete: false, nextUrl: null, reason: "wrong_owner" };
	if (evidence.rejectedRows > 0)
		return { complete: false, nextUrl: null, reason: "discarded_rows" };
	if (evidence.noProgress)
		return { complete: false, nextUrl: null, reason: "no_progress" };
	if (!evidence.hasRecognizedList && !evidence.explicitEmpty)
		return { complete: false, nextUrl: null, reason: "unreadable_list" };
	if (evidence.nextUrl !== null) {
		const next = validContinuation(
			evidence.nextUrl,
			stream,
			username,
			pageNumber + 1,
		);
		return next
			? { complete: false, nextUrl: next, reason: "remaining_continuation" }
			: { complete: false, nextUrl: null, reason: "wrong_navigation" };
	}
	if (evidence.explicitEmpty) {
		return evidence.parsedRows === 0 && pageNumber === 1
			? { complete: true, nextUrl: null, reason: "terminal_list" }
			: { complete: false, nextUrl: null, reason: "empty_unverified" };
	}
	if (evidence.parsedRows === 0)
		return { complete: false, nextUrl: null, reason: "empty_unverified" };
	return { complete: true, nextUrl: null, reason: "terminal_list" };
}

function isExpectedRequest(
	request: string,
	stream: "repositories" | "starred",
	username: string,
	pageNumber: number,
): boolean {
	try {
		const url = new URL(request);
		const profileRoute = url.pathname === `/${username}`;
		const starsRoute =
			stream === "starred" && url.pathname === `/stars/${username}`;
		const expectedTab = stream === "repositories" ? "repositories" : "stars";
		return (
			url.origin === "https://github.com" &&
			(profileRoute || starsRoute) &&
			Number(url.searchParams.get("page")) === pageNumber &&
			(starsRoute || url.searchParams.get("tab") === expectedTab)
		);
	} catch {
		return false;
	}
}

export function sameNavigation(
	requestedUrl: string,
	currentUrl: string,
): boolean {
	try {
		const requested = new URL(requestedUrl);
		const current = new URL(currentUrl);
		return (
			requested.origin === "https://github.com" &&
			current.origin === requested.origin &&
			current.pathname === requested.pathname &&
			current.search === requested.search
		);
	} catch {
		return false;
	}
}

export function hasExpectedOwner(html: string, username: string): boolean {
	const { document } = parseHTML(html);
	const meta = document.querySelector('meta[name="user-login"]');
	const nickname = document.querySelector("span.p-nickname");
	return (
		meta?.getAttribute("content") === username &&
		nickname?.textContent?.trim() === username
	);
}

export function inspectProfilePage(
	page: BrowserPageObservation,
	username: string,
	expectedUrl: string,
): boolean {
	if (
		page.requestedUrl !== expectedUrl ||
		page.currentUrl !== expectedUrl ||
		!sameNavigation(page.requestedUrl, page.currentUrl) ||
		!hasExpectedOwner(page.html, username)
	)
		return false;
	const { document } = parseHTML(page.html);
	return (
		document.querySelector("span.p-name") !== null &&
		document.querySelector('a[href*="tab=repositories"]') !== null &&
		document.querySelector('a[href$="?tab=followers"]') !== null &&
		document.querySelector('a[href$="?tab=following"]') !== null
	);
}

function isBlocked(html: string): boolean {
	const { document } = parseHTML(html);
	const body = document.querySelector("main")?.textContent ?? "";
	return /(?:sign in to github|you must be signed in|account suspended|page not found|rate limit exceeded|verify your account)/iu.test(
		body,
	);
}

function validContinuation(
	href: string,
	stream: "repositories" | "starred",
	username: string,
	pageNumber: number,
): string | null {
	try {
		const url = new URL(href, "https://github.com");
		const page = Number(url.searchParams.get("page"));
		const expectedTab = stream === "repositories" ? "repositories" : "stars";
		const validPath =
			url.pathname === `/${username}` ||
			(stream === "starred" && url.pathname === `/stars/${username}`);
		const validTab =
			url.pathname === `/stars/${username}` ||
			url.searchParams.get("tab") === expectedTab;
		if (
			url.origin !== "https://github.com" ||
			!validPath ||
			!validTab ||
			!Number.isInteger(page) ||
			page !== pageNumber
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}
