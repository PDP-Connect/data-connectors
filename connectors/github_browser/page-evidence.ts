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
	readonly renderComplete: boolean;
	readonly hasUnknownContinuation: boolean;
	readonly terminalProof: "disabled_next" | "exact_count" | null;
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
		| "render_incomplete"
		| "discarded_rows"
		| "no_progress"
		| "remaining_continuation"
		| "unknown_continuation"
		| "terminal_unverified"
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
	if (!sameNavigation(page.requestedUrl, page.currentUrl))
		return { complete: false, nextUrl: null, reason: "wrong_navigation" };
	if (!isExpectedRequest(page.requestedUrl, stream, username, pageNumber))
		return { complete: false, nextUrl: null, reason: "wrong_navigation" };
	if (!hasExpectedOwner(page.html, username, stream === "starred" ? page.currentUrl : undefined))
		return { complete: false, nextUrl: null, reason: "wrong_owner" };
	if (!evidence.hasRecognizedList)
		return { complete: false, nextUrl: null, reason: "unreadable_list" };
	if (evidence.hasUnknownContinuation)
		return { complete: false, nextUrl: null, reason: "unknown_continuation" };
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
	if (evidence.rejectedRows > 0)
		return { complete: false, nextUrl: null, reason: "discarded_rows" };
	if (evidence.terminalProof === null)
		return { complete: false, nextUrl: null, reason: "terminal_unverified" };
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
			validSelection(url, starsRoute) &&
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

export function hasExpectedOwner(html: string, username: string, currentUrl?: string): boolean {
	const { document } = parseHTML(html);
	const meta = document.querySelector('meta[name="user-login"]');
	if (meta?.getAttribute("content") !== username) return false;
	// The stars listing has no profile nickname. Its exact owner route and
	// signed-in identity bind it instead; request selection is checked above.
	if (currentUrl !== undefined) {
		try {
			const url = new URL(currentUrl);
			if (url.origin === "https://github.com" && !url.username && !url.password &&
				url.pathname === `/stars/${username}`) return true;
		} catch {
			return false;
		}
	}
	return document.querySelector("span.p-nickname")?.textContent?.trim() === username;
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
	// Field readability is tracked separately by parseProfilePage. An owner-bound
	// partial profile may be ingested without receiving completion authority.
	return true;
}

export function isBlocked(html: string): boolean {
	const { document } = parseHTML(html);
	const body = Array.from(document.querySelectorAll("main")).map((node) => node.textContent ?? "").join(" ");
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
			!validSelection(url, url.pathname === `/stars/${username}`) ||
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

/** Inventory routes are unfiltered. Reject selection-changing and duplicate params. */
function validSelection(url: URL, starsRoute: boolean): boolean {
	const allowed = starsRoute ? ["page", "after"] : ["page", "tab", "after"];
	return url.username === "" && url.password === "" && url.hash === "" &&
		(!url.searchParams.has("after") || (url.searchParams.get("after")?.trim().length ?? 0) > 0) &&
		Array.from(url.searchParams.keys()).every((key) =>
			allowed.includes(key) && url.searchParams.getAll(key).length === 1);
}
