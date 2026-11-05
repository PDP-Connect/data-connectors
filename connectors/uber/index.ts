#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Uber Connector (v0.4.0)
 *
 * Streams (D5 as revised by capability-map.json's `lead_decision_live`,
 * docs/migration/connector-cutover/CONTRACTS.md):
 *   - trips: one RECORD per Uber trip, hydrated from `GetTrip` (status,
 *     requested_at, completed_at, pickup/dropoff addresses, product_type,
 *     driver, distance, duration, fare_total). The Activities list feed
 *     carries only a trip UUID — see parsers.ts's module doc. `trips` does
 *     its own hydration and emits its own DETAIL_COVERAGE. STATE keeps a
 *     head marker, scoped page continuations, pending detail IDs, and the
 *     successfully hydrated IDs while backfill is open. The source's
 *     nextPageToken resumes history after each per-run budget; only actual
 *     budget deferral emits a budget skip. Failed details retire after
 *     three permanent failures without being marked hydrated; STATE keeps
 *     up to 100 retired IDs per stream, and every later run reports them as
 *     a non-retryable gap until full_refresh or a scope change.
 *     The head boundary assumes Activities is newest-first. The prior
 *     connector flagged live confirmation of that ordering as outstanding.
 *   - receipts: 1:1 per-trip detail (`fare_breakdown`, `currency`, receipt
 *     totals), fetched from `GetReceipt` only. Declared `state_stream:
 *     "trips"` in the manifest — it rides trips' checkpoint rather than
 *     proving its own, because it is fetched in the SAME per-trip loop as
 *     trips and has no independent hydration lane (see the Collection
 *     Profile spec's checkpoint-dependency section). Per the fleet-wide
 *     `detail-coverage-state-stream-manifest-honesty` guard, a
 *     `state_stream`-declared stream must never construct a
 *     DETAIL_COVERAGE — this connector does not.
 *   - A trips-only START (receipts absent from `requested`) makes ZERO
 *     GetReceipt calls — proven in integration.test.ts. It still calls
 *     GetTrip, because trips' own fields are hydrated from GetTrip.
 *
 * Architecture: same browser-session JSON-read pattern already proven by
 * `venmo`/`reddit` in this repo — an isolated persistent Patchright profile
 * (`browser: { profileName: "uber" }`), a `page.evaluate(fetch)` read under
 * the live session cookie (no synthetic device id, no custom User-Agent),
 * and pure parsers (parsers.ts) separated from the fetch/pagination loop.
 * `collect()` navigates to riders.uber.com/trips before its first fetch
 * (mirrors venmo's `establishVenmoCollectOrigin`) — `ensureSession`'s probe
 * only proves a live cookie exists, it does not land the page anywhere a
 * same-origin `fetch` can run from.
 *
 * LIVE EVIDENCE (2026-09-22, real account capture — see the connector
 * cutover report): `operationName: "Activities"` / `"GetTrip"` /
 * `"GetReceipt"`, `/graphql`, and the `nextPageToken` cursor are all
 * confirmed correct. The request MUST carry `x-csrf-token: x` (a static
 * literal, not derived from any cookie) and
 * `x-uber-rv-session-type: desktop_session`, and `accept: (wildcard)` — a
 * request missing the CSRF header gets a 403 with body `"Missing csrf token."`
 * before it ever reaches GraphQL. `GetReceipt`'s `receiptData` is a full
 * HTML email-receipt document, not structured JSON; the itemized fare
 * breakdown is parsed from it via `data-testid="fare_line_item_*"`
 * structural attributes (parsers.ts's `parseFareBreakdown`) — never a
 * text-regex over rendered content (authoring guide §2).
 *
 * `ensureSession` is a manual-only handoff; no password or OTP is ever
 * submitted by this connector — see src/auto-login/uber.ts's doc for why.
 *
 * CHANGES
 *   v0.4.0 (2026-09-22) — D5 revised per lead_decision_live: trips is now
 *     hydrated per-trip from GetTrip (previously list-level-only, all
 *     detail fields null); receipts is now GetReceipt-only (fare_breakdown,
 *     currency, totals) and declared `state_stream: "trips"` instead of
 *     `parent_streams: ["trips"]`, since it has no independent hydration
 *     lane — both streams' detail is fetched in the same per-trip loop.
 *   v0.3.0 (2026-09-22) — live-verified: real Activities/GetTrip/GetReceipt
 *     shapes, real pagination (nextPageToken), real CSRF/session-type
 *     headers, collect() now navigates before fetching (fixes a real
 *     uber_transport_error observed on the first live run — see the report).
 *   v0.2.0 (2026-09-22) — real trips + receipts collection wired from
 *     unverified/inferred shapes (previously a session-probe-only scaffold).
 *   v0.1.0 — scaffold (manifest + probeSession only).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { redactTransportDetail } from "@pdpp/connector-protocol/http-retry";
import type { Page } from "playwright";
import { ensureUberSession } from "../../packages/polyfill-connectors/src/auto-login/uber.ts";
import {
	type BrowserCollectContext,
	buildDetailCoverageMessage,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import {
	activityTripId,
	parseFareBreakdown,
	receiptRecord,
	tripRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	UberActivitiesResponse,
	UberActivity,
	UberActivityPosition,
	UberCursor,
	UberGetReceiptResponse,
	UberGetTripResponse,
	UberGetTripResult,
} from "./types.ts";

const RIDERS_ORIGIN = "https://riders.uber.com";
const TRIPS_URL = `${RIDERS_ORIGIN}/trips`;
const GRAPHQL_PATH = "/graphql";
/** Uber's own default page size for the Activities feed, observed live. */
const ACTIVITIES_PAGE_SIZE = 5;
/** Safety ceiling, not an observed Uber limit — mirrors venmo's page-cap precedent. */
const MAX_ACTIVITY_PAGES = 200;
const MAX_DETAIL_FETCHES = 200;
/** Retired IDs kept per stream so later runs keep reporting the gap. */
const MAX_RETIRED_IDS = 100;
const PAGE_DELAY_MS = 500;
const DETAIL_DELAY_MS = 500;

const ACTIVITIES_QUERY = `query Activities($cityID: Int, $endTimeMs: Float, $includePast: Boolean = true, $includeUpcoming: Boolean = true, $limit: Int = 5, $nextPageToken: String, $orderTypes: [RVWebCommonActivityOrderType!] = [RIDES, TRAVEL], $profileType: RVWebCommonActivityProfileType = PERSONAL, $startTimeMs: Float) {
  activities(cityID: $cityID) {
    cityID
    past(
      endTimeMs: $endTimeMs
      limit: $limit
      nextPageToken: $nextPageToken
      orderTypes: $orderTypes
      profileType: $profileType
      startTimeMs: $startTimeMs
    ) @include(if: $includePast) {
      activities {
        ...RVWebCommonActivityFragment
        __typename
      }
      nextPageToken
      __typename
    }
    upcoming @include(if: $includeUpcoming) {
      activities {
        ...RVWebCommonActivityFragment
        __typename
      }
      __typename
    }
    __typename
  }
}

fragment RVWebCommonActivityFragment on RVWebCommonActivity {
  buttons {
    isDefault
    startEnhancerIcon
    text
    url
    __typename
  }
  cardURL
  description
  subtitle
  title
  uuid
  __typename
}
`;

const GET_TRIP_QUERY = `query GetTrip($tripUUID: String!) {
  getTrip(tripUUID: $tripUUID) {
    trip {
      beginTripTime
      cityID
      countryID
      driver
      dropoffTime
      fare
      isSurgeTrip
      jobUUID
      status
      uuid
      vehicleDisplayName
      vehicleViewID
      waypoints
      __typename
    }
    receipt {
      distance
      distanceLabel
      duration
      vehicleType
      __typename
    }
    __typename
  }
}
`;

const GET_RECEIPT_QUERY = `query GetReceipt($tripUUID: String!, $timestamp: String) {
  getReceipt(tripUUID: $tripUUID, timestamp: $timestamp) {
    receiptData
    __typename
  }
}
`;

/**
 * Every transport fault this connector throws is wrapped in one of these two
 * named errors before it can reach the runtime's retryablePattern check —
 * mirrors venmo's VENMO_RETRYABLE_PATTERN precedent (see that file's doc for
 * why an exact-name pattern is safer than a bare-vocabulary wildcard).
 */
export const UBER_RETRYABLE_PATTERN = /uber_rate_limited|uber_transport_error/i;

interface UberFetchResult {
	body: string;
	status: number;
}

/** Read Uber's GraphQL endpoint through the live page's own session cookie. No Authorization header, no device id, no custom User-Agent. */
export type UberPageFetch = (
	operationName: string,
	query: string,
	variables: Record<string, unknown>,
) => Promise<UberFetchResult>;

type UberFetchOutcome =
	| { kind: "response"; body: string; status: number }
	| { kind: "transport_error"; message: string };

/**
 * `collect()`'s own navigation to establish the riders.uber.com origin
 * before the first credentialed fetch — `ensureSession`'s cookie probe
 * proves a session exists, it does not land the page anywhere a same-origin
 * `fetch` can run from (the page starts at `about:blank`). Mirrors venmo's
 * `establishVenmoCollectOrigin`. Fixes a real `uber_transport_error
 * [endpoint /graphql]: Failed to fetch` observed on the first live run of
 * this connector (2026-09-22) — see the connector cutover report.
 */
export async function establishUberCollectOrigin(page: Page): Promise<void> {
	try {
		await page.goto(TRIPS_URL, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
	} catch (err) {
		throw new Error(
			`uber_transport_error [origin navigation]: ${redactTransportDetail(err instanceof Error ? err.message : String(err))}`,
			{ cause: err },
		);
	}
	if (!page.url().startsWith(RIDERS_ORIGIN)) {
		throw new Error(
			`uber_transport_error [origin navigation]: navigation did not land on ${RIDERS_ORIGIN} (landed on ${page.url()})`,
		);
	}
}

function makePageFetch(page: Page): UberPageFetch {
	return async (operationName, query, variables) => {
		let outcome: UberFetchOutcome;
		try {
			outcome = (await page.evaluate(
				async ({ fetchUrl, body }) => {
					try {
						const res = await fetch(fetchUrl, {
							credentials: "include",
							headers: {
								accept: "*/*",
								"content-type": "application/json",
								"x-csrf-token": "x",
								"x-uber-rv-session-type": "desktop_session",
							},
							method: "POST",
							body,
						});
						return {
							kind: "response" as const,
							status: res.status,
							body: await res.text().catch(() => ""),
						};
					} catch (err) {
						return {
							kind: "transport_error" as const,
							message: err instanceof Error ? err.message : String(err),
						};
					}
				},
				{
					fetchUrl: RIDERS_ORIGIN + GRAPHQL_PATH,
					body: JSON.stringify({ operationName, query, variables }),
				},
			)) as UberFetchOutcome;
		} catch (err) {
			outcome = {
				kind: "transport_error",
				message: err instanceof Error ? err.message : String(err),
			};
		}
		if (outcome.kind === "transport_error") {
			throw new Error(
				`uber_transport_error [endpoint ${operationName}]: ${redactTransportDetail(outcome.message)}`,
			);
		}
		return { status: outcome.status, body: outcome.body };
	};
}

class UberHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function isPermanentDetailFailure(error: unknown): boolean {
	return (
		error instanceof SyntaxError ||
		(error instanceof UberHttpError &&
			error.status >= 400 &&
			error.status < 500 &&
			error.status !== 408 &&
			error.status !== 429)
	);
}

function assertUberOk(
	status: number,
	body: string,
	operationName: string,
): void {
	if (status === 401 || status === 403) {
		throw new UberHttpError(
			status,
			`uber_session_expired [endpoint ${operationName}]`,
		);
	}
	if (status === 429) {
		throw new UberHttpError(
			status,
			`uber_rate_limited [endpoint ${operationName}]`,
		);
	}
	if (status < 200 || status >= 300) {
		throw new UberHttpError(
			status,
			`uber_http_${String(status)} [endpoint ${operationName}]: ${redactTransportDetail(body).slice(0, 200)}`,
		);
	}
}

/**
 * Fetch the Activities GraphQL feed page by page via the real
 * `nextPageToken` cursor (live-verified 2026-09-22). Dedupes by trip id
 * across pages defensively; Uber's own feed has not been observed to repeat
 * an id across pages, but a same-run dedupe costs nothing and guards
 * against a partial-overlap page boundary.
 */
export async function fetchAllActivities(
	fetchPath: UberPageFetch,
	delay: (ms: number) => Promise<void> = politeDelay,
	options: {
		nextPageToken?: string | undefined;
		stopAtTripId?: string | undefined;
		maxPages?: number;
	} = {},
): Promise<{
	activities: UberActivity[];
	truncated: boolean;
	nextPageToken?: string | undefined;
	pages: number;
	reachedEnd: boolean;
}> {
	const all: UberActivity[] = [];
	const seenIds = new Set<string>();
	const seenTokens = new Set<string>();
	let nextPageToken = options.nextPageToken;
	let pages = 0;
	let reachedEnd = false;
	if (nextPageToken) seenTokens.add(nextPageToken);
	const maxPages = options.maxPages ?? MAX_ACTIVITY_PAGES;
	const walk = await walkPagesWithCeiling({
		maxPages,
		fetchPage: async (pageNumber) => {
			const { status, body } = await fetchPath("Activities", ACTIVITIES_QUERY, {
				includePast: true,
				includeUpcoming: false,
				limit: ACTIVITIES_PAGE_SIZE,
				orderTypes: ["RIDES", "TRAVEL"],
				profileType: "PERSONAL",
				...(nextPageToken ? { nextPageToken } : {}),
			});
			assertUberOk(status, body, "Activities");
			const parsed = JSON.parse(body) as UberActivitiesResponse;
			const past = parsed.data?.activities?.past;
			if (!past || !Array.isArray(past.activities)) {
				throw new Error("uber_activity_resume_failed: missing Activities page");
			}
			pages += 1;
			for (const activity of past.activities) {
				const id = activityTripId(activity);
				if (id && id === options.stopAtTripId) {
					nextPageToken = undefined;
					return false;
				}
				if (id && !seenIds.has(id)) {
					seenIds.add(id);
					all.push(activity);
				}
			}
			const token = past.nextPageToken;
			if (!token) {
				nextPageToken = undefined;
				reachedEnd = true;
				return false;
			}
			if (seenTokens.has(token)) {
				throw new Error(
					"uber_activity_resume_failed: repeated Activities cursor",
				);
			}
			seenTokens.add(token);
			nextPageToken = token;
			if (pageNumber < maxPages) {
				await delay(PAGE_DELAY_MS);
			}
			return true;
		},
	});
	return {
		activities: all,
		truncated: walk.truncated,
		nextPageToken,
		pages,
		reachedEnd,
	};
}

/** One trip's raw GetTrip result, kept as-is so the caller decides how to turn it into a trips RECORD. */
async function fetchGetTrip(
	fetchPath: UberPageFetch,
	tripId: string,
): Promise<UberGetTripResult | undefined> {
	const { status, body } = await fetchPath("GetTrip", GET_TRIP_QUERY, {
		tripUUID: tripId,
	});
	assertUberOk(status, body, "GetTrip");
	const parsed = JSON.parse(body) as UberGetTripResponse;
	return parsed.data?.getTrip;
}

/** One trip's fare-breakdown lines; transport and JSON failures remain distinguishable from absent receipt evidence. */
async function fetchFareBreakdown(
	fetchPath: UberPageFetch,
	tripId: string,
): Promise<ReturnType<typeof parseFareBreakdown>> {
	const { status, body } = await fetchPath("GetReceipt", GET_RECEIPT_QUERY, {
		tripUUID: tripId,
		timestamp: "",
	});
	assertUberOk(status, body, "GetReceipt");
	const parsed = JSON.parse(body) as UberGetReceiptResponse;
	return parseFareBreakdown(parsed.data?.getReceipt?.receiptData);
}

/**
 * Exported for integration tests — the full collect() body against an
 * injected page fetch. Fetches the Activities list once for trip identity,
 * then hydrates each requested stream from its own detail call: `trips`
 * from `GetTrip`, `receipts` from `GetReceipt`. The dependency this D5
 * revision requires: a trips-only grant (receipts absent from `requested`)
 * must perform zero GetReceipt calls.
 */
export async function collectAllStreams(
	ctx: BrowserCollectContext,
	fetchPath: UberPageFetch,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<void> {
	const { emit, emitRecord, requested } = ctx;
	const wantTrips = requested.has("trips");
	const wantReceipts = requested.has("receipts");

	if (!wantTrips && !wantReceipts) {
		return;
	}

	const scope = JSON.stringify(
		[...requested.values()]
			.filter((stream) => stream.name === "trips" || stream.name === "receipts")
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((stream) => ({
				name: stream.name,
				since: stream.time_range?.since ?? null,
				until: stream.time_range?.until ?? null,
				resources: [...(stream.resources ?? [])].sort(),
			})),
	);
	const saved = ctx.state.trips as UberCursor | undefined;
	const previous =
		ctx.collectionMode !== "full_refresh" &&
		saved?.version === 1 &&
		saved.scope === scope &&
		(!saved.backfill || saved.backfill.scope === scope)
			? saved
			: undefined;
	const hydratedTrips = new Set(previous?.hydrated_trip_ids ?? []);
	const hydratedReceipts = new Set(previous?.hydrated_receipt_ids ?? []);
	const detailFailureCounts = new Map(
		Object.entries(previous?.backfill?.detail_failure_counts ?? {}),
	);
	const retired = {
		trips: new Set(previous?.retired_trip_ids?.trips ?? []),
		receipts: new Set(previous?.retired_trip_ids?.receipts ?? []),
	};
	const head = await fetchAllActivities(fetchPath, delay, {
		stopAtTripId: previous?.head_trip_id,
	});
	const activities = [...head.activities];
	let pagesRemaining = MAX_ACTIVITY_PAGES - head.pages;
	const positions: UberActivityPosition[] = head.reachedEnd
		? []
		: (previous?.backfill?.pages ?? []).map((position) => ({ ...position }));
	if (head.truncated && head.nextPageToken) {
		positions.unshift({
			next_page_token: head.nextPageToken,
			...(previous?.head_trip_id
				? { stop_at_trip_id: previous.head_trip_id }
				: {}),
		});
	}
	// A head burst can itself exceed the page limit. Keep that unfinished
	// segment ahead of the older backfill rather than losing either position.
	while (positions.length > 0 && pagesRemaining > 0) {
		const position = positions[0];
		if (!position) break;
		await delay(PAGE_DELAY_MS);
		const page = await fetchAllActivities(fetchPath, delay, {
			nextPageToken: position.next_page_token,
			stopAtTripId: position.stop_at_trip_id,
			maxPages: pagesRemaining,
		});
		activities.push(...page.activities);
		pagesRemaining -= page.pages;
		if (page.truncated && page.nextPageToken) {
			position.next_page_token = page.nextPageToken;
		} else {
			positions.shift();
		}
	}
	const headIds = head.activities
		.map((activity) => activityTripId(activity))
		.filter((id): id is string => Boolean(id));
	const discoveredIds = activities
		.map((activity) => activityTripId(activity))
		.filter((id): id is string => Boolean(id));
	const needsTrip = (id: string) =>
		wantTrips && !hydratedTrips.has(id) && !retired.trips.has(id);
	const needsReceipt = (id: string) =>
		wantReceipts && !hydratedReceipts.has(id) && !retired.receipts.has(id);
	const needsDetail = (id: string) => needsTrip(id) || needsReceipt(id);
	const candidates = [
		...new Set([
			...headIds,
			...(previous?.backfill?.pending_trip_ids ?? []),
			...discoveredIds,
		]),
	].filter((id) => needsDetail(id) && (detailFailureCounts.get(id) ?? 0) < 3);
	const tripIds = candidates.slice(0, MAX_DETAIL_FETCHES);
	const truncated = positions.length > 0;

	const tripsRequired: string[] = [];
	const tripsHydrated: string[] = [];
	const attemptedTripIds = new Set<string>();
	let rateLimit: UberHttpError | undefined;
	for (const [index, tripId] of tripIds.entries()) {
		attemptedTripIds.add(tripId);
		let permanentFailure = false;
		let transientFailure = false;
		const recordFailure = (error: unknown) => {
			if (isPermanentDetailFailure(error)) {
				permanentFailure = true;
			} else {
				transientFailure = true;
			}
			if (error instanceof UberHttpError && error.status === 429) {
				rateLimit = error;
			}
		};

		if (needsTrip(tripId)) {
			tripsRequired.push(tripId);
			let getTrip: UberGetTripResult | undefined;
			let fetched = false;
			try {
				getTrip = await fetchGetTrip(fetchPath, tripId);
				fetched = true;
			} catch (error) {
				recordFailure(error);
			}
			const record = getTrip
				? tripRecord(tripId, getTrip.trip, getTrip.receipt)
				: null;
			if (record) {
				await emitRecord("trips", record);
				tripsHydrated.push(tripId);
				hydratedTrips.add(tripId);
			} else if (fetched) {
				permanentFailure = true;
			}
		}

		if (!rateLimit && needsReceipt(tripId)) {
			let fareBreakdown: ReturnType<typeof parseFareBreakdown> = [];
			let fetched = false;
			try {
				fareBreakdown = await fetchFareBreakdown(fetchPath, tripId);
				fetched = true;
			} catch (error) {
				recordFailure(error);
			}
			const receipt = receiptRecord(tripId, fareBreakdown);
			if (receipt) {
				await emitRecord("receipts", receipt);
				hydratedReceipts.add(tripId);
			} else if (fetched) {
				permanentFailure = true;
			}
		}

		// A transient failure in either requested stream must not retire the ID.
		if (!needsDetail(tripId)) {
			detailFailureCounts.delete(tripId);
		} else if (permanentFailure && !transientFailure) {
			detailFailureCounts.set(
				tripId,
				(detailFailureCounts.get(tripId) ?? 0) + 1,
			);
		}
		if (rateLimit) break;

		const isLast = index === tripIds.length - 1;
		if (!isLast) {
			await delay(DETAIL_DELAY_MS);
		}
	}

	// Retire IDs that used their third permanent failure. Each stream keeps
	// the IDs it still lacks, so later runs report the gap without fetching.
	for (const id of attemptedTripIds) {
		if ((detailFailureCounts.get(id) ?? 0) < 3) continue;
		const lacking = [
			...(needsTrip(id) ? [retired.trips] : []),
			...(needsReceipt(id) ? [retired.receipts] : []),
		];
		if (lacking.every((ids) => ids.size < MAX_RETIRED_IDS)) {
			for (const ids of lacking) ids.add(id);
			detailFailureCounts.delete(id);
		}
	}
	const retiredTripIds = {
		...(retired.trips.size > 0 ? { trips: [...retired.trips] } : {}),
		...(retired.receipts.size > 0 ? { receipts: [...retired.receipts] } : {}),
	};

	// Unattempted IDs, including work stopped by a rate limit, remain pending.
	// Only permanent failures consume the three-run retirement allowance.
	const pendingTripIds = [
		...candidates.filter((id) => !attemptedTripIds.has(id)),
		...tripIds.filter(
			(id) =>
				attemptedTripIds.has(id) &&
				needsDetail(id) &&
				(detailFailureCounts.get(id) ?? 0) < 3,
		),
	];
	const detailTruncated =
		attemptedTripIds.size === MAX_DETAIL_FETCHES &&
		candidates.length > MAX_DETAIL_FETCHES;
	const backfillIncomplete = truncated || pendingTripIds.length > 0;
	const headTripId = headIds[0] ?? previous?.head_trip_id;
	const cursor: UberCursor = {
		version: 1,
		scope,
		...(headTripId ? { head_trip_id: headTripId } : {}),
		// These sets only guard overlap while historical work remains open.
		hydrated_trip_ids: backfillIncomplete ? [...hydratedTrips] : [],
		hydrated_receipt_ids: backfillIncomplete ? [...hydratedReceipts] : [],
		...(backfillIncomplete
			? {
					backfill: {
						scope,
						pages: positions,
						pending_trip_ids: pendingTripIds,
						detail_failure_counts: Object.fromEntries(detailFailureCounts),
					},
				}
			: {}),
		...(Object.keys(retiredTripIds).length > 0
			? { retired_trip_ids: retiredTripIds }
			: {}),
	};
	await emit({ type: "STATE", stream: "trips", cursor });

	if (wantTrips || wantReceipts) {
		if (truncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: wantTrips ? "trips" : "receipts",
				reason: "trips_deferred_page_budget",
				recovery_hint: {
					action: "retry_by_runtime",
					retryable: true,
				},
				message: `Uber activity feed stopped at the ${MAX_ACTIVITY_PAGES}-page limit with more trip history possibly available`,
				diagnostics: { page_limit: MAX_ACTIVITY_PAGES },
			});
		}
		if (detailTruncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: wantTrips ? "trips" : "receipts",
				reason: "trips_deferred_detail_budget",
				recovery_hint: {
					action: "retry_by_runtime",
					retryable: true,
				},
				message: `Uber trip detail stopped at the ${MAX_DETAIL_FETCHES}-trip detail-fetch limit for this run`,
				diagnostics: {
					detail_fetch_limit: MAX_DETAIL_FETCHES,
					total_trips: candidates.length,
				},
			});
		}
		// A failed detail is not a budget stop. Report each stream whose
		// attempted or retired trips still lack detail, so no run looks complete.
		if (!rateLimit) {
			const gaps: Array<["trips" | "receipts", Set<string>, Set<string>]> = [];
			if (wantTrips) gaps.push(["trips", hydratedTrips, retired.trips]);
			if (wantReceipts) {
				gaps.push(["receipts", hydratedReceipts, retired.receipts]);
			}
			for (const [stream, hydrated, retiredIds] of gaps) {
				const missing = [
					...new Set([
						...[...attemptedTripIds].filter((id) => !hydrated.has(id)),
						...retiredIds,
					]),
				];
				if (missing.length === 0) continue;
				const retrying = missing.filter((id) =>
					pendingTripIds.includes(id),
				).length;
				await emit({
					type: "SKIP_RESULT",
					stream,
					reason: "trip_details_unavailable",
					recovery_hint:
						retrying > 0
							? { action: "retry_by_runtime", retryable: true }
							: { action: "retry_on_connector_upgrade", retryable: false },
					message: `Uber did not return ${stream} detail for ${String(missing.length)} trip(s)`,
					diagnostics: { missing: missing.length, retrying },
				});
			}
		}
	}
	if (wantTrips) {
		// Receipts keeps using trips' checkpoint and has no independent
		// DETAIL_COVERAGE. Emit only this run's attempted trip hydration.
		await emit(
			buildDetailCoverageMessage({
				stream: "trips",
				stateStream: "trips",
				requiredKeys: tripsRequired,
				hydratedKeys: tripsHydrated,
				considered: tripsRequired.length,
				covered: tripsHydrated.length,
			}),
		);
	}
	// Save retryable work and emit coverage before propagating the named fault.
	if (rateLimit) throw rateLimit;
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "uber",
		validateRecord,
		retryablePattern: UBER_RETRYABLE_PATTERN,
		browser: { profileName: "uber" },
		async ensureSession({ context, page, sendInteraction }): Promise<void> {
			await ensureUberSession({ context, page, sendInteraction });
		},
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await establishUberCollectOrigin(ctx.page);
			const fetchPath = makePageFetch(ctx.page);
			await collectAllStreams(ctx, fetchPath);
		},
	});
}
