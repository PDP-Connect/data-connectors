// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Uber automated session management.
 *
 * Unlike reddit/amazon/venmo, this connector has no credential-driven
 * auto-login path yet — no `UBER_USERNAME`/`UBER_PASSWORD` env contract is
 * declared in the manifest (`human_interaction: ["manual_action"]` only),
 * and there is no live session to verify Uber's sign-in form selectors
 * against (auth.uber.com's flow branches across password/OTP/SMS tiers per
 * the legacy connector's own three-tier login — see
 * `connectors/uber/uber-playwright.js` at the repo root). Driving that form
 * blind, unverified against a real account, would be exactly the kind of
 * selector guesswork docs/connector-authoring-guide.md §2 warns against.
 *
 * So this module is deliberately narrow: probe the persistent profile for a
 * live riders.uber.com session (the `sid` cookie, same check as the
 * scaffold's `probeSession`), and if it's not live, hand the page to the
 * owner via `manual_action` and re-probe once they respond. Credential
 * auto-login is a documented gap — see the connector header comment and the
 * lane report — not a silent omission.
 */

import type { BrowserContext, Page } from "playwright";
import { manualBrowserLogin } from "../browser-handoff.ts";
import type {
	InteractionRequest,
	InteractionResponse,
} from "../connector-runtime.ts";

const RIDERS_ORIGIN = "https://riders.uber.com/";
const LOGIN_URL = "https://auth.uber.com/v2/";
const SESSION_COOKIE_NAME = "sid";
const MANUAL_LOGIN_MESSAGE =
	"Sign in to Uber in the secure browser. PDPP continues automatically once your session is ready.";

type SendInteraction = (
	req: InteractionRequest,
) => Promise<InteractionResponse>;

export async function hasUberSessionCookie(
	context: BrowserContext,
): Promise<boolean> {
	const cookies = await context.cookies(RIDERS_ORIGIN);
	return cookies.some(
		(c) => c.name === SESSION_COOKIE_NAME && Boolean(c.value),
	);
}

export interface EnsureUberSessionArgs {
	context: BrowserContext;
	page: Page;
	sendInteraction: SendInteraction;
}

/**
 * Establish a live riders.uber.com session: reuse the persistent profile's
 * cookie if already live, otherwise hand off to the owner. Never submits a
 * password or OTP — see module doc for why.
 */
export async function ensureUberSession({
	context,
	page,
	sendInteraction,
}: EnsureUberSessionArgs): Promise<void> {
	if (await hasUberSessionCookie(context)) {
		return;
	}
	await manualBrowserLogin({
		message: MANUAL_LOGIN_MESSAGE,
		page,
		probe: () => hasUberSessionCookie(context),
		sendInteraction,
	});
	if (!(await hasUberSessionCookie(context))) {
		throw new Error(
			"uber_session_not_established: no live session after manual handoff",
		);
	}
}

export { LOGIN_URL as UBER_LOGIN_URL };
