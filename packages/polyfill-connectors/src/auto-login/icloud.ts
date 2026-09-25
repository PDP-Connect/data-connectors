// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * iCloud (Apple ID) session probe for the icloud_notes connector.
 *
 * SESSION-FIRST, NEVER CREDENTIAL-DRIVEN, NO AUTH BLOCK. Apple ID sign-in
 * and any 2FA challenge are never automated here — no username/password
 * form is ever filled, no OTP field is ever driven, and the connector
 * declares no `auth` at all (there is no credential this connector ever
 * consumes). `probeCloudKitConfig` only checks whether the seeded browser
 * profile already carries a live iCloud session (POST
 * https://setup.icloud.com/setup/ws/1/validate with credentials:'include'
 * from the page; a live session returns `dsInfo.dsid` +
 * `webservices.ckdatabasews.url`).
 *
 * Wired into `runConnector`'s `probeSession` hook (see
 * `connectors/icloud_notes/index.ts`), NOT `ensureSession`. The runtime's
 * `establishSession` owns the rest of the flow generically for any
 * `probeSession`-based connector: on a live probe, collection proceeds
 * immediately with no credential resolution of any kind (see
 * `session-establish.ts` / `connector-runtime.ts`'s deferred-credential
 * fix). On a dead probe, the runtime hands the page to the owner via a
 * `manual_action` INTERACTION and re-probes once — the owner completes
 * Apple ID sign-in and any 2FA prompt themselves, entirely outside this
 * module and outside the connector.
 *
 * Confirmed live against a real, already-authenticated browser profile
 * 2026-09-22 (see the connector's header CHANGES): the live probe returned
 * true on the first call with no manual_action needed.
 *
 * Anti-bot: Apple ID sign-in can present its own bot/rate-limit friction
 * (CAPTCHA-like "unusual activity" holds). Since sign-in is entirely
 * owner-driven in the runtime's generic manual_action surface, this module
 * never needs to detect or react to that friction itself.
 */

import type { Page } from "playwright";

const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const NOTES_URL = "https://www.icloud.com/notes";
const ICLOUD_HOST_RE = /(?:^|\.)icloud\.com$/;

export interface CloudKitLiveConfig {
	ckBaseUrl: string;
	dsid: string;
	fullName: string | null;
}

/** POST validate from the iCloud page so browser cookies and the browser's
 *  network identity remain the source of truth. */
export async function probeCloudKitConfig(
	page: Page,
): Promise<CloudKitLiveConfig | null> {
	const result = (await page
		.evaluate(async (url) => {
			try {
				const res = await fetch(url, {
					method: "POST",
					credentials: "include",
				});
				if (!res.ok) {
					return null;
				}
				const data = (await res.json()) as {
					dsInfo?: { dsid?: string | number; fullName?: string };
					webservices?: { ckdatabasews?: { url?: string } };
				};
				const dsid = data?.dsInfo?.dsid;
				const ckBaseUrl = data?.webservices?.ckdatabasews?.url;
				if (dsid === undefined || dsid === null || !ckBaseUrl) {
					return null;
				}
				return {
					dsid: String(dsid),
					ckBaseUrl,
					fullName: data?.dsInfo?.fullName ?? null,
				};
			} catch {
				return null;
			}
		}, VALIDATE_URL)
		.catch(() => null)) as CloudKitLiveConfig | null;
	return result?.dsid && result.ckBaseUrl ? result : null;
}

function isOnICloudOrigin(page: Page): boolean {
	try {
		return ICLOUD_HOST_RE.test(new URL(page.url()).hostname);
	} catch {
		return false;
	}
}

/**
 * `probeSession` hook: boolean-only, matching the runtime's
 * `ProbeSessionArgs -> Promise<boolean>` contract. The connector's own
 * `collect()` (`connectors/icloud_notes/index.ts`'s `resolveCloudKitConfig`)
 * re-derives the actual CloudKit config independently once collection
 * starts — this hook only tells the runtime whether a session exists at
 * all, so it can decide whether to hand off to the owner before `collect()`
 * ever runs.
 *
 * Navigating is required for the first probe and for collection: the
 * validate request needs an iCloud page origin. Sign-in itself stays in the
 * iCloud page, so later probes on that origin do not reload it.
 */
export async function probeICloudSession(page: Page): Promise<boolean> {
	if (!isOnICloudOrigin(page)) {
		await page
			.goto(NOTES_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
			.catch((): undefined => undefined);
	}
	return (await probeCloudKitConfig(page)) !== null;
}

/** Handoff readiness probe: never navigate the owner's tab while Apple ID
 *  sign-in or 2FA may be in progress in an embedded identity frame. */
export async function probeICloudSessionInPlace(page: Page): Promise<boolean> {
	if (!isOnICloudOrigin(page)) {
		return false;
	}
	return (await probeCloudKitConfig(page)) !== null;
}
