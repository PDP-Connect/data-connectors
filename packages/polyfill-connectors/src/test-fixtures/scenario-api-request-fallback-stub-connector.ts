// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for proving browser-har-replay.ts's
 * APIRequestContext → HAR bridge (see that file's module comment) end to
 * end, through a REAL (headless) browser context — the bridge patches
 * `context.request`'s prototype, which only exists on a genuine
 * `BrowserContext`, so no amount of mocking replaces a real launch here.
 *
 * Makes exactly one `page.context().request.get(url)` call, to a URL this
 * fixture reads from `PDPP_TEST_API_REQUEST_URL`, and emits one record
 * carrying the response status/body. Used by
 * src/scenario/browser-har-replay-api-request-bridge.test.ts to replay
 * against a hand-built recorded-browser scenario twice: once with a live
 * URL matching a HAR entry EXACTLY, once with a URL matching only via the
 * bridge's fallback (same path, differing query) — proving
 * `ApiRequestFallbackMatchLimitation` (claims.ts) appears in exactly the
 * second case.
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import type {
	BrowserCollectContext,
	ValidateRecord,
} from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream, data) => ({ ok: true, data });

async function collect(ctx: BrowserCollectContext): Promise<void> {
	const url = process.env.PDPP_TEST_API_REQUEST_URL;
	if (!url) {
		throw new Error(
			"scenario-api-request-fallback-stub-connector: PDPP_TEST_API_REQUEST_URL is not set",
		);
	}
	const response = await ctx.page.context().request.get(url);
	const body = await response.text();
	await ctx.emitRecord("items", {
		id: "probe",
		status: response.status(),
		body,
	});
}

runConnector({
	name: "scenario-api-request-fallback-stub-connector",
	validateRecord,
	browser: { profileName: "scenario-api-request-fallback-stub" },
	collect,
});
