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
 *     its own hydration, so it is self-mapped, and it emits its own
 *     DETAIL_COVERAGE. It declares `incremental: false` /
 *     `coverage_strategy: "full_inventory"` in manifests/uber.json: the
 *     Activities list has no date/status field to filter or stop on (only a
 *     trip UUID; see parsers.ts), so `fetchAllActivities` walks the full
 *     feed every run with no STATE-consulted cursor. A stop-at-seen boundary
 *     keyed on trip id is plausible (the audit's cut-semantics-pass report
 *     item #1) but assumes the Activities feed is fetched newest-first,
 *     which no code or fixture in this connector confirms — that requires a
 *     live-account run to verify before implementing; tracked as a
 *     follow-up, not implemented here.
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
import { ensureUberSession } from "../../src/auto-login/uber.ts";
import {
	type BrowserCollectContext,
	buildDetailCoverageMessage,
	politeDelay,
	runConnector,
} from "../../src/connector-runtime.ts";
import { walkPagesWithCeiling } from "../../src/page-ceiling.ts";
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

function assertUberOk(
	status: number,
	body: string,
	operationName: string,
): void {
	if (status === 401 || status === 403) {
		throw new Error(`uber_session_expired [endpoint ${operationName}]`);
	}
	if (status === 429) {
		throw new Error(`uber_rate_limited [endpoint ${operationName}]`);
	}
	if (status < 200 || status >= 300) {
		throw new Error(
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
): Promise<{ activities: UberActivity[]; truncated: boolean }> {
	const all: UberActivity[] = [];
	const seenIds = new Set<string>();
	let nextPageToken: string | undefined;
	const walk = await walkPagesWithCeiling({
		maxPages: MAX_ACTIVITY_PAGES,
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
			const page = parsed.data?.activities?.past?.activities ?? [];
			let newOnPage = 0;
			for (const activity of page) {
				const id = activityTripId(activity);
				if (id && !seenIds.has(id)) {
					seenIds.add(id);
					all.push(activity);
					newOnPage += 1;
				}
			}
			const token = parsed.data?.activities?.past?.nextPageToken;
			if (!token || newOnPage === 0) {
				return false;
			}
			nextPageToken = token;
			if (pageNumber < MAX_ACTIVITY_PAGES) {
				await delay(PAGE_DELAY_MS);
			}
			return true;
		},
	});
	return { activities: all, truncated: walk.truncated };
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

/** One trip's fare-breakdown lines from GetReceipt. Never throws; an empty array is the honest "not hydrated" signal `receiptRecord` treats as absent evidence. */
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

	const { activities, truncated } = await fetchAllActivities(fetchPath, delay);
	const tripIds = activities
		.map((a) => activityTripId(a))
		.filter((id): id is string => Boolean(id))
		.slice(0, MAX_DETAIL_FETCHES);
	const detailTruncated = activities.length > MAX_DETAIL_FETCHES;

	const tripsRequired: string[] = [];
	const tripsHydrated: string[] = [];
	for (const [index, tripId] of tripIds.entries()) {
		if (wantTrips) {
			tripsRequired.push(tripId);
		}

		let getTrip: UberGetTripResult | undefined;
		if (wantTrips) {
			try {
				getTrip = await fetchGetTrip(fetchPath, tripId);
			} catch {
				getTrip = undefined;
			}
			const record = getTrip
				? tripRecord(tripId, getTrip.trip, getTrip.receipt)
				: null;
			if (record) {
				await emitRecord("trips", record);
				tripsHydrated.push(tripId);
			}
		}

		if (wantReceipts) {
			let fareBreakdown: ReturnType<typeof parseFareBreakdown> = [];
			try {
				fareBreakdown = await fetchFareBreakdown(fetchPath, tripId);
			} catch {
				fareBreakdown = [];
			}
			const receipt = receiptRecord(tripId, fareBreakdown);
			if (receipt) {
				await emitRecord("receipts", receipt);
			}
		}

		const isLast = index === tripIds.length - 1;
		if (!isLast && (wantTrips || wantReceipts)) {
			await delay(DETAIL_DELAY_MS);
		}
	}

	if (wantTrips) {
		if (truncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: "trips",
				reason: "trips_deferred_page_budget",
				message: `Uber activity feed stopped at the ${MAX_ACTIVITY_PAGES}-page limit with more trip history possibly available`,
				diagnostics: { page_limit: MAX_ACTIVITY_PAGES },
			});
		}
		if (detailTruncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: "trips",
				reason: "trips_deferred_detail_budget",
				message: `Uber trip detail stopped at the ${MAX_DETAIL_FETCHES}-trip detail-fetch limit for this run`,
				diagnostics: {
					detail_fetch_limit: MAX_DETAIL_FETCHES,
					total_trips: activities.length,
				},
			});
		}
		// `trips` is full_inventory / incremental: false (no source-side date
		// or stop-at-seen filter is proven — see the manifest and this
		// connector's header comment): it emits no STATE, matching the
		// fleet's full_inventory convention (e.g. meta's `following`), rather
		// than a `cursor: {}` that claimed a bookkeeping cursor with nothing
		// in it. `trips` does its own hydration (GetTrip per id), so it is
		// self-mapped and emits its own DETAIL_COVERAGE. `receipts` is
		// declared `state_stream: "trips"` in the manifest and must NEVER
		// construct one — see the fleet-wide
		// detail-coverage-state-stream-manifest-honesty guard.
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
