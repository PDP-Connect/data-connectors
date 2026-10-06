// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// strava_browser on PageShim. Each scope is `{ activities }`, matching Vana's
// stored Strava payload. The host persists STATE between runs; each run walks
// from the newest activity up to the connector's page bound. The mobile host
// stores each `{ activities }` payload as the newest whole version, so a list
// walk that stops early (a 503 or a 429 after the retries) fails the run: an
// emitted prefix would replace the stored list.
//
// A host range for strava.activities applies to start_date_local, a
// calendar day: full-date bounds are compared as days. A bound of another
// type collects nothing, and the runtime reports scope_not_supported.
import {
	collectStravaBrowser,
	LOGIN_URL,
	probeStravaSession,
	type StravaCollectContext,
} from "../../../connectors/strava_browser/index.ts";
import { validateRecord } from "../../../connectors/strava_browser/schemas.ts";
import { consentTimeFieldResolver } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import { timeRangeUnsupportedReason } from "../../../packages/polyfill-connectors/src/time-range.ts";
import { applyRequestedTimeRanges } from "../requested-time-range.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/strava_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

type ScopeEntriesPage = ShimPage & {
	requestedScopeEntries?: () => unknown;
};

const activitiesConsentField =
	consentTimeFieldResolver("strava-browser")("activities");

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(
		page,
		{
			platform: "strava",
			scopes: ["strava.activities"],
			version: PAGESHIM_CONNECTOR_VERSION,
			loginUrl: LOGIN_URL,
			loginMessage: "Sign in to Strava, then return here.",
			validateRecord,
			probe: (pw) => probeStravaSession(pw as never),
			collect: async (ctx) => {
				const { requested } = ctx as unknown as {
					requested: Map<
						string,
						{ time_range?: { since?: string; until?: string } }
					>;
				};
				applyRequestedTimeRanges(
					requested,
					(page as ScopeEntriesPage).requestedScopeEntries?.(),
					"strava",
					{ acceptFullDate: true },
				);
				const unsupported = timeRangeUnsupportedReason(
					"activities",
					requested.get("activities")?.time_range,
					activitiesConsentField,
				);
				if (unsupported !== null) return;
				await collectStravaBrowser(ctx as unknown as StravaCollectContext, {
					failRunOnIncompleteList: true,
				});
			},
			toScope: (_stream, records) => ({ activities: records }),
			streamScopeRecords: {
				order: ["activities"],
				arrayKey: "activities",
				summarizeCounts: (counts) => {
					const activities = counts.activities ?? 0;
					return {
						count: activities,
						label: activities === 1 ? "activity" : "activities",
						details: { activities },
					};
				},
			},
			summarize: (scopes) => {
				const activities =
					(
						scopes["strava.activities"] as
							| { activities?: unknown[] }
							| undefined
					)?.activities?.length ?? 0;
				return {
					count: activities,
					label: activities === 1 ? "activity" : "activities",
					details: { activities },
				};
			},
		},
		initialState,
		supportsState,
	);
