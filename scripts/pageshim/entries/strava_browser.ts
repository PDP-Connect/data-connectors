// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// strava_browser on PageShim. Each scope is `{ activities }`, matching Vana's
// stored Strava payload. The mobile host stores each `{ activities }` payload
// as the newest whole version: it merges only keyed `{ records }` scopes, so
// this one is delivered as is. Every run is therefore a full inventory of
// activity summaries. The saved cursor is not given to the collector: with
// it, a later run emits only new activities or a detail batch, and that
// subset would replace the stored list (or, with nothing new, store nothing
// and fail the run as no data). A list walk that stops early (a 503 or a 429
// after the retries) fails the run for the same reason: an emitted prefix
// would replace the stored list.
//
// The STATE checkpoint is still sent, since the runtime uses it to tell an
// account with no activities (a confirmed empty list) from a run that
// collected nothing. Its id lists (`known_ids`, `pending_detail_ids`) are
// dropped first: no PageShim run reads them, and at about 9k activities they
// would exceed the host bridge's 256Ki message cap and fail the checkpoint.
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
declare const PAGESHIM_CONNECTOR_STREAMS: string[];

type ScopeEntriesPage = ShimPage & {
	requestedScopeEntries?: () => unknown;
};

const activitiesConsentField =
	consentTimeFieldResolver("strava-browser")("activities");

/**
 * The collector's activities cursor without its id lists. Everything else
 * (`list_complete`, `requested_since`) is a few bytes and keeps the stored
 * STATE a recognisable subset of the desktop shape.
 */
function compactCursor(cursor: unknown): unknown {
	if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor))
		return cursor;
	const {
		known_ids: _knownIds,
		pending_detail_ids: _pendingIds,
		...rest
	} = cursor as Record<string, unknown>;
	return rest;
}

/**
 * What the run found, as `page.setData("scopeCounts", ...)`:
 * `{"strava.activities": {found, ok}}`, ok false when the list was only
 * partly read (unreadable or unplaced activities, an unsupported range).
 * The mobile host parses it into scope counts on a failed run, which is the
 * only way it can tell an account with no activities (found 0, ok) from a
 * connector that could not read the list: both arrive as an empty
 * `{ activities }` scope and the host reports no data. Sent only after
 * collect returned; never fails the run.
 */
async function reportScopeCounts(
	page: ShimPage,
	found: number,
	ok: boolean,
): Promise<void> {
	try {
		await page.setData("scopeCounts", {
			"strava.activities": { found, ok },
		});
	} catch {
		// A host that refuses the key loses only the detail, not the run.
	}
}

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(
		page,
		{
			platform: "strava",
			scopes: PAGESHIM_CONNECTOR_STREAMS.map((stream) => `strava.${stream}`),
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
				if (unsupported !== null) {
					await reportScopeCounts(page, 0, false);
					return;
				}
				// No saved cursor, and a checkpoint without the id lists: see the
				// note at the top of this file.
				const stravaCtx = ctx as unknown as StravaCollectContext;
				let found = 0;
				let answered = true;
				await collectStravaBrowser(
					{
						...stravaCtx,
						state: {},
						emit: (msg) => {
							if (msg.type === "SKIP_RESULT" && msg.stream === "activities")
								answered = false;
							return stravaCtx.emit(
								msg.type === "STATE"
									? { ...msg, cursor: compactCursor(msg.cursor) }
									: msg,
							);
						},
						emitRecord: (stream, record) => {
							if (stream === "activities") found += 1;
							return stravaCtx.emitRecord(stream, record);
						},
						...(stravaCtx.reportStreamFailure
							? {
									reportStreamFailure: (
										...args: Parameters<
											NonNullable<StravaCollectContext["reportStreamFailure"]>
										>
									) => {
										answered = false;
										return stravaCtx.reportStreamFailure?.(...args);
									},
								}
							: {}),
					},
					{ failRunOnIncompleteList: true },
				);
				await reportScopeCounts(page, found, answered);
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
