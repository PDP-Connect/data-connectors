#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Uber Connector (v0.3.0)
 *
 * Streams (D5, docs/migration/connector-cutover/CONTRACTS.md):
 *   - trips: list-level fields from riders.uber.com's Activities GraphQL
 *     response (one RECORD per Uber trip). The list feed carries only a
 *     trip id — see parsers.ts's module doc and the connector cutover
 *     report's CONTRACT-CHANGE-REQUEST for why every other declared field
 *     is honestly null here.
 *   - receipts: 1:1 per-trip detail (status, dates, addresses, driver,
 *     fare, fare_breakdown, distance, duration), fetched from GetTrip +
 *     GetReceipt. Declared with `parent_streams: ["trips"]` /
 *     `coverage_strategy: "parent_detail_accounting"` in
 *     manifests/uber.json, so a trips-only START never triggers a
 *     per-trip detail fetch (proven in integration.test.ts).
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
	UberReceiptSummary,
	UberTrip,
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

interface UberTripDetailFetch {
	fareBreakdown: ReturnType<typeof parseFareBreakdown>;
	receipt: UberReceiptSummary | undefined;
	trip: UberTrip | undefined;
}

/** Fetch one trip's GetTrip + GetReceipt detail. Returns null (never throws) on a fetch/parse failure — the caller records that trip as an unhydrated key. */
export async function fetchTripDetail(
	fetchPath: UberPageFetch,
	tripId: string,
): Promise<UberTripDetailFetch | null> {
	try {
		const { status, body } = await fetchPath("GetTrip", GET_TRIP_QUERY, {
			tripUUID: tripId,
		});
		assertUberOk(status, body, "GetTrip");
		const parsed = JSON.parse(body) as UberGetTripResponse;
		const getTrip = parsed.data?.getTrip;
		if (!getTrip) {
			return null;
		}
		let fareBreakdown: ReturnType<typeof parseFareBreakdown> = [];
		try {
			const receiptRes = await fetchPath("GetReceipt", GET_RECEIPT_QUERY, {
				tripUUID: tripId,
				timestamp: "",
			});
			assertUberOk(receiptRes.status, receiptRes.body, "GetReceipt");
			const receiptParsed = JSON.parse(
				receiptRes.body,
			) as UberGetReceiptResponse;
			fareBreakdown = parseFareBreakdown(
				receiptParsed.data?.getReceipt?.receiptData,
			);
		} catch {
			// GetReceipt failure is non-fatal: the trip/receipt summary from
			// GetTrip still hydrates most fields; fare_breakdown stays empty.
		}
		return {
			fareBreakdown,
			receipt: getTrip.receipt,
			trip: getTrip.trip,
		};
	} catch {
		return null;
	}
}

/** Exported for integration tests — the full collect() body against an injected page fetch. */
export async function collectAllStreams(
	ctx: BrowserCollectContext,
	fetchPath: UberPageFetch,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<void> {
	const { emit, emitRecord, requested } = ctx;

	if (!requested.has("trips") && !requested.has("receipts")) {
		return;
	}

	const { activities, truncated } = await fetchAllActivities(fetchPath, delay);

	if (requested.has("trips")) {
		let covered = 0;
		for (const activity of activities) {
			const record = tripRecord(activity);
			if (record) {
				await emitRecord("trips", record);
				covered += 1;
			}
		}
		if (truncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: "trips",
				reason: "trips_deferred_page_budget",
				message: `Uber activity feed stopped at the ${MAX_ACTIVITY_PAGES}-page limit with more trip history possibly available`,
				diagnostics: { page_limit: MAX_ACTIVITY_PAGES },
			});
		}
		await emit({ type: "STATE", stream: "trips", cursor: {} });
		await emit(
			buildDetailCoverageMessage({
				stream: "trips",
				stateStream: "trips",
				requiredKeys: [],
				hydratedKeys: [],
				considered: activities.length,
				covered,
			}),
		);
	}

	// The dependency this D5 requires: a trips-only grant (receipts absent
	// from `requested`) must perform zero per-trip detail fetches.
	if (!requested.has("receipts")) {
		return;
	}

	const tripIds = activities
		.map((a) => activityTripId(a))
		.filter((id): id is string => Boolean(id))
		.slice(0, MAX_DETAIL_FETCHES);
	const requiredKeys: string[] = [];
	const hydratedKeys: string[] = [];
	for (const [index, tripId] of tripIds.entries()) {
		requiredKeys.push(tripId);
		const detail = await fetchTripDetail(fetchPath, tripId);
		if (detail) {
			await emitRecord(
				"receipts",
				receiptRecord(
					tripId,
					detail.trip,
					detail.receipt,
					detail.fareBreakdown,
				),
			);
			hydratedKeys.push(tripId);
		}
		if (index < tripIds.length - 1) {
			await delay(DETAIL_DELAY_MS);
		}
	}
	const detailTruncated = activities.length > MAX_DETAIL_FETCHES;
	if (detailTruncated) {
		await emit({
			type: "SKIP_RESULT",
			stream: "receipts",
			reason: "receipts_deferred_detail_budget",
			message: `Uber receipts stopped at the ${MAX_DETAIL_FETCHES}-trip detail-fetch limit for this run`,
			diagnostics: {
				detail_fetch_limit: MAX_DETAIL_FETCHES,
				total_trips: activities.length,
			},
		});
	}
	await emit(
		buildDetailCoverageMessage({
			stream: "receipts",
			stateStream: "trips",
			requiredKeys,
			hydratedKeys,
			considered: requiredKeys.length,
			covered: hydratedKeys.length,
		}),
	);
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
