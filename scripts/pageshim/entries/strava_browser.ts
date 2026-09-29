// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// strava_browser on PageShim. Each scope is `{ records }`, the stream's PDPP
// records unchanged. The host keeps no cursor between runs, so every run
// walks the list from the newest activity, up to the connector's page bound.
import {
	collectStravaBrowser,
	LOGIN_URL,
	probeStravaSession,
	type StravaCollectContext,
} from "../../../connectors/strava_browser/index.ts";
import { validateRecord } from "../../../connectors/strava_browser/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/strava_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "strava",
		scopes: ["strava.activities", "strava.coverage_diagnostics"],
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: LOGIN_URL,
		loginMessage: "Sign in to Strava, then return here.",
		validateRecord,
		probe: (pw) => probeStravaSession(pw as never),
		collect: (ctx) =>
			collectStravaBrowser(ctx as unknown as StravaCollectContext),
		toScope: (_stream, records) => ({ records }),
		summarize: (scopes) => {
			const activities =
				(scopes["strava.activities"] as { records?: unknown[] } | undefined)
					?.records?.length ?? 0;
			return {
				count: activities,
				label: activities === 1 ? "activity" : "activities",
				details: { activities },
			};
		},
	});
