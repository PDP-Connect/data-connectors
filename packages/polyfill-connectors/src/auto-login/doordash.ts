// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * DoorDash automated session management.
 *
 * Strategy (mirrors `amazon.ts`):
 *   1. Probe session by navigating to /orders and checking DoorDash did not
 *      redirect to /consumer/login or /identity/*.
 *   2. If dead, drive DoorDash's own multi-step sign-in form: email field →
 *      "Continue" → password field → "Log In". Confirmed multi-step shape
 *      from the legacy scraper (data-connectors/doordash/doordash-playwright.js).
 *   3. DoorDash sits behind Cloudflare bot protection (same legacy-scraper
 *      note) and may also present Google/Apple SSO buttons on the same
 *      form — if the expected email/password fields never render, hand off
 *      to the operator rather than guessing at an SSO flow this connector
 *      does not drive.
 *
 * No live DoorDash account exists for this lane yet — every selector below
 * is a best-effort port of the legacy scraper's own selectors (which used
 * the same "try several candidate selectors" pattern because DoorDash's own
 * form field ids are not documented). Selectors MUST be re-verified against
 * a live login before this connector is promoted past `development`.
 */

import type { BrowserContext, Locator, Page } from "playwright";
import { manualAction } from "../browser-handoff.ts";
import type {
	InteractionRequest,
	InteractionResponse,
	SessionCheckpointFn,
} from "../connector-runtime.ts";
import type { CaptureSession } from "../fixture-capture.ts";
import {
	type LoginCredentialFields,
	resolveLoginCredentials,
} from "./login-credentials.ts";

export const DOORDASH_LOGIN_FIELDS: LoginCredentialFields = {
	password: ["DOORDASH_PASSWORD"],
	username: ["DOORDASH_USERNAME"],
};

const LOGIN_CHALLENGE_PATH = /\/consumer\/login/;
const ORDERS_URL = "https://www.doordash.com/orders";

/**
 * DoorDash's real sign-in challenge (confirmed by a live 2026-09-22 capture,
 * see the cut-doordash lane report's "Live evidence" section) redirects to
 * the `identity.doordash.com` HOST, not a `/identity/` path segment on
 * `www.doordash.com`. A path-only regex against the full URL string never
 * matches a challenge on a different subdomain — parse the URL and check
 * the hostname explicitly instead of pattern-matching the raw string.
 */
export function isLoginChallengeUrl(url: string): boolean {
	if (LOGIN_CHALLENGE_PATH.test(url)) {
		return true;
	}
	try {
		return new URL(url).hostname === "identity.doordash.com";
	} catch {
		return false;
	}
}
const CONTINUE_BUTTON_TEXT = /^(continue|continue to log in|next|sign in)$/i;
const SUBMIT_BUTTON_TEXT = /^(log in|sign in|submit)$/i;

const noopCheckpoint: SessionCheckpointFn = () => Promise.resolve();

interface EnsureDoorDashSessionArgs {
	capture?: CaptureSession | null;
	checkpoint?: SessionCheckpointFn;
	context: BrowserContext;
	credentials?: Readonly<Record<string, string | undefined>> | undefined;
	fieldTimeoutMs?: number | undefined;
	onCredentialSubmit?: () => void;
	page: Page;
	sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

async function fillWhenVisible(
	page: Page,
	locator: Locator,
	value: string,
	{ timeout = 15_000 }: { timeout?: number } = {},
): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const n = await locator.count().catch((): number => 0);
		for (let i = 0; i < n; i += 1) {
			const el = locator.nth(i);
			if (await el.isVisible().catch((): boolean => false)) {
				await el.fill(value);
				return true;
			}
		}
		await page.waitForTimeout(200);
	}
	throw new Error("no visible match for locator within timeout");
}

function isMissingVisibleFieldError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message === "no visible match for locator within timeout"
	);
}

/** Probe whether the persistent profile already has a live DoorDash session
 *  by navigating to /orders and confirming no redirect to the login/identity
 *  surface. */
async function probeDoorDashSession(page: Page): Promise<boolean> {
	await page
		.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	await page.waitForTimeout(2500);
	return !isLoginChallengeUrl(page.url());
}

async function requestManualLoginForChallenge({
	capture,
	page,
	reason,
	sendInteraction,
}: Pick<EnsureDoorDashSessionArgs, "capture" | "page" | "sendInteraction"> & {
	readonly reason: string;
}): Promise<boolean> {
	return await waitForManualLogin({
		...(capture ? { capture } : {}),
		handoffReason: "captcha",
		message:
			`DoorDash did not render the expected sign-in form (${reason}). ` +
			"This usually means Cloudflare is showing a challenge, or the account uses Google/Apple sign-in this connector does not drive. " +
			"If this run opened a visible browser, complete DoorDash sign-in there and respond success. " +
			"If it is headless, cancel this interaction and rerun with PDPP_BROWSER_HEADLESS=0 (or unset it) on a browser-capable deployment.",
		page,
		sendInteraction,
	});
}

async function requestManualLoginWithoutCredentials({
	capture,
	credentialReason,
	page,
	sendInteraction,
}: Pick<EnsureDoorDashSessionArgs, "capture" | "page" | "sendInteraction"> & {
	readonly credentialReason: string;
}): Promise<boolean> {
	return await waitForManualLogin({
		...(capture ? { capture } : {}),
		handoffReason: "login",
		message:
			`${credentialReason} ` +
			"Alternatively, sign in to DoorDash in the secure browser (email/password, Google, or Apple) and complete any CAPTCHA there, then respond success.",
		page,
		sendInteraction,
	});
}

async function waitForManualLogin({
	capture,
	handoffReason,
	message,
	page,
	sendInteraction,
}: Pick<EnsureDoorDashSessionArgs, "capture" | "page" | "sendInteraction"> & {
	readonly handoffReason: "captcha" | "login";
	readonly message: string;
}): Promise<boolean> {
	await manualAction(
		{
			...(capture ? { capture } : {}),
			page,
			reason: handoffReason,
			message,
			timeoutSeconds: 1800,
		},
		sendInteraction,
	);
	await page.waitForTimeout(3000);
	return probeDoorDashSession(page);
}

async function ensureManualSessionWithoutCredentials({
	capture,
	checkpoint,
	credentialReason,
	page,
	sendInteraction,
}: {
	capture?: CaptureSession | null;
	checkpoint: SessionCheckpointFn;
	readonly credentialReason: string;
	page: Page;
	sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}): Promise<boolean> {
	await checkpoint("doordash-signin-manual-required");
	if (
		await requestManualLoginWithoutCredentials({
			...(capture ? { capture } : {}),
			credentialReason,
			page,
			sendInteraction,
		})
	) {
		return true;
	}
	throw new Error("doordash_login_manual_incomplete");
}

async function fillOrHandleChallenge({
	capture,
	fieldTimeoutMs = 15_000,
	locator,
	page,
	reason,
	sendInteraction,
	value,
}: Pick<EnsureDoorDashSessionArgs, "capture" | "page" | "sendInteraction"> & {
	readonly locator: Locator;
	readonly fieldTimeoutMs?: number | undefined;
	readonly reason: string;
	readonly value: string;
}): Promise<"filled" | "recovered"> {
	try {
		await fillWhenVisible(page, locator, value, { timeout: fieldTimeoutMs });
		return "filled";
	} catch (error) {
		if (!isMissingVisibleFieldError(error)) {
			throw error;
		}
		if (
			await requestManualLoginForChallenge({
				...(capture ? { capture } : {}),
				page,
				reason,
				sendInteraction,
			})
		) {
			return "recovered";
		}
		throw new Error("doordash_login_unexpected_ui", { cause: error });
	}
}

async function clickButtonWithText(page: Page, pattern: RegExp): Promise<void> {
	const buttons = page.locator("button");
	const count = await buttons.count().catch((): number => 0);
	for (let i = 0; i < count; i += 1) {
		const btn = buttons.nth(i);
		const text = (await btn.innerText().catch((): string => "")).trim();
		if (pattern.test(text)) {
			await btn.click().catch((): undefined => undefined);
			return;
		}
	}
	await page
		.locator('button[type="submit"]')
		.first()
		.click()
		.catch((): undefined => undefined);
}

export async function ensureDoorDashSession({
	capture,
	checkpoint = noopCheckpoint,
	context: _context,
	credentials,
	fieldTimeoutMs,
	onCredentialSubmit,
	page,
	sendInteraction,
}: EnsureDoorDashSessionArgs): Promise<boolean> {
	await checkpoint("doordash-auth-probe");
	if (await probeDoorDashSession(page)) {
		await checkpoint("doordash-session-already-live");
		return true;
	}

	const resolved = resolveLoginCredentials(
		credentials,
		DOORDASH_LOGIN_FIELDS,
		"doordash",
	);
	if (resolved.kind === "absent") {
		return await ensureManualSessionWithoutCredentials({
			...(capture ? { capture } : {}),
			checkpoint,
			credentialReason: resolved.reason,
			page,
			sendInteraction,
		});
	}
	const { password, username: email } = resolved;

	await page.goto("https://www.doordash.com/consumer/login/", {
		waitUntil: "domcontentloaded",
		timeout: 30_000,
	});
	await page.waitForTimeout(2000);
	await checkpoint("doordash-signin-loaded");

	// Email step. DoorDash's login form uses `input[name="email"]` on the
	// legacy scraper's own selector list; fall back to type/id heuristics
	// for the same reason amazon.ts tries multiple candidate selectors.
	const emailStep = await fillOrHandleChallenge({
		...(capture ? { capture } : {}),
		fieldTimeoutMs,
		locator: page.locator(
			'input[name="email"], input[type="email"], input[autocomplete="email"]',
		),
		page,
		reason: "sign-in form did not render",
		sendInteraction,
		value: email,
	});
	if (emailStep === "recovered") {
		return true;
	}
	await clickButtonWithText(page, CONTINUE_BUTTON_TEXT);
	await page.waitForTimeout(3000);
	await checkpoint("doordash-email-submit");

	// Password step — appears after the Continue click (multi-step form).
	const passwordStep = await fillOrHandleChallenge({
		...(capture ? { capture } : {}),
		fieldTimeoutMs,
		locator: page.locator('input[name="password"], input[type="password"]'),
		page,
		reason: "password form did not render",
		sendInteraction,
		value: password,
	});
	if (passwordStep === "recovered") {
		return true;
	}
	await clickButtonWithText(page, SUBMIT_BUTTON_TEXT);
	onCredentialSubmit?.();
	await page.waitForTimeout(5000);
	await checkpoint("doordash-password-submit");

	await checkpoint("doordash-final-verify");
	if (await probeDoorDashSession(page)) {
		return true;
	}
	if (
		await requestManualLoginForChallenge({
			...(capture ? { capture } : {}),
			page,
			reason: "automated sign-in did not complete",
			sendInteraction,
		})
	) {
		return true;
	}
	throw new Error("doordash_login_incomplete_after_submit");
}
