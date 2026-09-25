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

export interface CloudKitLiveConfig {
  ckBaseUrl: string;
  dsid: string;
  fullName: string | null;
}

/** POST the setup/validate endpoint through the browser context's request
 *  client. It shares the browser cookie jar and does not navigate or depend
 *  on the owner's current login redirect origin. Never throws: any
 *  transport/parse failure reads as "not live", matching the legacy probe. */
export async function probeCloudKitConfig(page: Page): Promise<CloudKitLiveConfig | null> {
  let response:
    | {
        ok: () => boolean;
        json: () => Promise<unknown>;
        dispose: () => Promise<void>;
      }
    | undefined;
  try {
    response = await page.context().request.post(VALIDATE_URL, {
      headers: {
        origin: "https://www.icloud.com",
        referer: "https://www.icloud.com/notes",
      },
      timeout: 15_000,
    });
    if (!response.ok()) {
      return null;
    }
    const data = (await response.json()) as {
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
  } finally {
    await response?.dispose().catch((): undefined => undefined);
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
 * This probe must not navigate: Apple sign-in can remain on an identity
 * redirect while 2FA is in progress. The context request client uses the
 * shared cookie jar and can validate the session from any owner-page origin.
 */
export async function probeICloudSession(page: Page): Promise<boolean> {
  return (await probeCloudKitConfig(page)) !== null;
}
