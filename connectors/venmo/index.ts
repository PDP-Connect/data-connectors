#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Venmo Connector (v0.2.0) — browser-session redesign
 *
 * Ground truth: /tmp/venmo-provider-path-audit-0810.md. The prior v0.1.0
 * design (password-grant + a per-run-random `device-id` over raw HTTP)
 * hit a live 403 — Venmo's device/session-trust anti-automation gate
 * rejecting a synthetic identity, a documented multi-year failure mode of
 * the unofficial `api.venmo.com` client ecosystem (github.com/mmohades/
 * Venmo issue #86). No retry, backoff, or device-id format change fixes
 * this; only a real, owner-authenticated session does.
 *
 * This redesign follows the same architecture already proven in this repo
 * by `reddit` (session-cookie JSON reads) and `amazon` (persistent
 * Patchright profile, one-time owner login, `ensureSession` automation):
 *
 *   - `browser: { profileName: "venmo" }` acquires an isolated, persistent
 *     Patchright profile. No custom User-Agent, no device fingerprinting —
 *     Patchright's stealth patches are what make the session credible.
 *   - `ensureSession` (src/auto-login/venmo.ts) probes/establishes a live
 *     venmo.com session: reused from the persistent profile when already
 *     live, credential-assisted when setup supplies credentials, or a
 *     `manual_action` browser handoff when they are not — the
 *     owner can always sign in by hand with nothing saved.
 *   - Once the session is live, every stream reads the SAME structured
 *     JSON endpoints the v0.1.0 connector used
 *     (`api.venmo.com/v1/{account,users/{id}/friends,stories/target-or-actor/{id}}`),
 *     but through `page.evaluate(fetch)` with `credentials: "include"` —
 *     the browser's own cookie jar authenticates the request, not a
 *     synthetic bearer token or device-id header. The existing
 *     parsers/schemas/cursor logic (parsers.ts, schemas.ts) is unchanged;
 *     only the transport and auth layer moved.
 *   - If a JSON endpoint ever stops responding under the session cookie
 *     (shape drift, endpoint retirement), the honest fallback is
 *     browser-visible data (DOM scrape) with the same evidence discipline
 *     as amazon/chase — not a silent re-add of a synthetic client.
 *     Nothing in this connector spoofs a User-Agent or device id; see
 *     docs/connector-authoring-guide.md §"Standard dependencies".
 *
 * Streams (unchanged from v0.1.0 — same vocabulary, same required set):
 *   - profile: the authenticated owner's own account (GET /account).
 *   - friends: the owner's Venmo friends list (GET /users/{id}/friends).
 *   - transactions: payments sent/requested/received visible to the owner
 *     (GET /stories/target-or-actor/{id}). Refunds/bank-transfers/top-ups/
 *     card authorizations/ATM withdrawals/disbursements share the same
 *     `/stories` feed but carry no `payment` object in the documented
 *     shape and are intentionally not modeled — see parsers.ts
 *     parseTransactionStory.
 *
 * Tested surfaces: fixture-driven only (pilot-fixture.test.ts,
 * parsers.test.ts, schemas.test.ts, integration.test.ts,
 * src/auto-login/venmo.test.ts). No live network call has proven this
 * redesign against a real account yet. The manifest lists it at Preview
 * (see public_listing.rationale) so the owner can opt in to perform that
 * first live run, matching the signal connector's precedent.
 *
 * CHANGES
 *   v0.2.0 (2026-08-10) — browser-session redesign; removed
 *     password-grant/device-id HTTP auth entirely.
 *   v0.1.0 — initial (unproven, never listed) password-grant connector.
 */

import { createHash } from "node:crypto";
import { isMainModule } from "@pdpp/connector-protocol";
import { redactTransportDetail } from "@pdpp/connector-protocol/http-retry";
import type { Page } from "playwright";
import {
	ensureVenmoOrigin,
	ensureVenmoSession,
} from "../../packages/polyfill-connectors/src/auto-login/venmo.ts";
import {
	type BrowserCollectContext,
	buildDetailCoverageMessage,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import {
	API_BASE,
	normalizeVenmoDate,
	profileRecord,
	parseTransactionStory,
	userRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { VenmoStory, VenmoUser } from "./types.ts";

const FRIENDS_PAGE_SIZE = 200;
const TRANSACTIONS_PAGE_SIZE = 50;
export const MAX_FRIENDS_PAGES = 200;
export const MAX_TRANSACTION_PAGES = 400;
const HEAD_REFRESH_PAGES_WITH_PENDING_WORK = 100;
const MAX_HEAD_GAPS = 4;
// Refresh mutable records independently of the unfinished history position.
const MUTABLE_REFRESH_PAGES = 2;

/** Unread story IDs between before_id and end_id; start_id anchors fresh refreshes. */
interface HeadGap {
	start_id: string;
	before_id: string;
	end_id: string;
}

/**
 * `venmo_transport_error` (collect()'s page-fetch, see `makePageFetch` below)
 * and `venmo_probe_transport_error` (ensureSession's PRE-submit session
 * probe, see `src/auto-login/venmo.ts`) are the browser fetch's own "could
 * not run at all" fault (opaque origin, DNS, TLS, reset socket) —
 * deliberately retryable, distinct from `venmo_session_expired`. Every
 * transport-fault throw in this connector is always wrapped in one of these
 * named errors before it can reach the runtime's retryablePattern check —
 * nothing unwrapped escapes either module's own try/catch — so this pattern
 * names the two retryable errors EXACTLY rather than also matching bare
 * transport vocabulary (`fetch failed`/`ECONN`/etc.) as a redundant, and
 * here actively dangerous, catch-all.
 *
 * B4: that redundant bare-vocabulary form is what this pattern used to be
 * (`venmo_.*transport_error` plus `fetch failed|failed to fetch`), and it
 * silently made a THIRD, deliberately similarly-named error retryable too:
 * `probeVenmoAccount` throws `venmo_post_submit_probe_transport_error` for a
 * transport fault discovered immediately after a saved password was
 * submitted to Venmo's own sign-in form, and that message still CONTAINS
 * "Failed to fetch" (the redacted detail) even though its NAME must not
 * retry. A wildcard/bare-vocabulary pattern classified it retryable anyway
 * via the message text, and a runtime-level retry re-enters
 * `ensureVenmoSession` from scratch — resubmitting the SAME saved password
 * against Venmo's anti-automation gate on every retry, with no run-scoped
 * budget to stop it (see `src/auto-login/venmo.test.ts`'s "B4" oracle).
 * Naming exactly the two errors that must retry — and nothing else — is the
 * only form immune to a future transport-detail string reintroducing this
 * exact collision. Exported so both this connector's own tests and
 * `src/auto-login/venmo.test.ts` assert against the REAL pattern, not a
 * hand-copied stand-in that could silently drift from it.
 */
export const VENMO_RETRYABLE_PATTERN =
	/^(?:venmo_rate_limited|venmo_server_error|venmo_transport_error|venmo_probe_transport_error)\b/i;

// The redesign dropped `venmoPacingProfile`/the HTTP governor (page-context
// fetch has no direct outbound Node HTTP to pace — F10 in
// /tmp/review-venmo-browser-redesign-0810.md), but the page loops below
// still hit `api.venmo.com` back-to-back up to 200-400 times with zero
// pacing. Self-pace like reddit (PAGE_DELAY_MS=500) rather than lean on a
// governor that structurally cannot see this transport.
const PAGE_DELAY_MS = 500;

interface VenmoProgressExtra {
	cursor_present?: boolean;
	item_count?: number;
	offset_ordinal?: number;
	phase?: string;
	stream?: string;
	total_seen?: number;
}
type VenmoProgress = (
	message: string,
	extra?: VenmoProgressExtra,
) => Promise<void>;

interface VenmoPageFetchResult {
	body: string;
	status: number;
}

/**
 * Fetch a Venmo JSON endpoint through the live page's own session cookie
 * (`credentials: "include"`) — no Authorization header, no device-id, no
 * custom User-Agent. This is the entire auth surface: the browser IS the
 * credential.
 */
export type VenmoPageFetch = (
	path: string,
	query?: Record<string, string>,
) => Promise<VenmoPageFetchResult>;

/**
 * Distinguishes "the fetch could not run at all" (opaque origin, DNS, TLS,
 * reset socket — a transport/precondition fault) from "the fetch ran and
 * Venmo said no" (an HTTP status). Collapsing both into the same shape, as
 * the pre-revision `catch { return { status: 0, ... } }` did, reports every
 * transport fault as a session-expired auth fault
 * (/tmp/review-venmo-browser-redesign-0810.md F4) — the owner is told to
 * re-authenticate when the real problem is that `collect()` never
 * established the `venmo.com` origin (F1/F3).
 */
type VenmoFetchOutcome =
	| { kind: "response"; body: string; status: number }
	| { kind: "transport_error"; message: string };

function makePageFetch(page: Page): VenmoPageFetch {
	return async (path, query) => {
		const url = new URL(API_BASE + path);
		for (const [key, value] of Object.entries(query ?? {})) {
			url.searchParams.set(key, value);
		}
		let outcome: VenmoFetchOutcome;
		try {
			outcome = (await page.evaluate(async (fetchUrl) => {
				try {
					const res = await fetch(fetchUrl, {
						credentials: "include",
						headers: { accept: "application/json" },
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
			}, url.toString())) as VenmoFetchOutcome;
		} catch (err) {
			// `page.evaluate` itself rejected (execution context destroyed by a
			// navigation, or the page/browser crashed) — same "could not run at
			// all" classification as a fetch throwing inside the callback.
			outcome = {
				kind: "transport_error",
				message: err instanceof Error ? err.message : String(err),
			};
		}
		if (outcome.kind === "transport_error") {
			throw new Error(
				`venmo_transport_error [endpoint ${path}]: ${redactTransportDetail(outcome.message)}`,
			);
		}
		return { status: outcome.status, body: outcome.body };
	};
}

/**
 * `collect()`'s own call to `ensureVenmoOrigin`, extracted so it is
 * unit-testable without a real Playwright `page` (mirrors `errorDetail`/
 * `assertVenmoOk` below, both pulled out of the fetch loop for the same
 * reason). `ensureVenmoOrigin` now throws `venmo_origin_navigation_failed`
 * when the one-time navigation doesn't land on venmo.com (see its doc —
 * production run_1787101857760, the owner's first-ever Venmo run). Folded
 * into this connector's own `venmo_transport_error` naming so it matches
 * `VENMO_RETRYABLE_PATTERN` the same way any other transport fault in this
 * file's fetch loop already does, rather than escaping `collect()` as an
 * unrecognized, non-retryable name.
 */
export async function establishVenmoCollectOrigin(page: Page): Promise<void> {
	try {
		await ensureVenmoOrigin(page);
	} catch (err) {
		throw new Error(
			`venmo_transport_error [origin navigation]: ${redactTransportDetail(err instanceof Error ? err.message : String(err))}`,
			{ cause: err },
		);
	}
}

export function errorDetail(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		if (parsed.error?.message) {
			return redactTransportDetail(parsed.error.message).slice(0, 200);
		}
	} catch {
		// fall through to raw redaction below
	}
	return redactTransportDetail(body).slice(0, 200);
}

function assertVenmoOk(status: number, body: string, path: string): void {
	if (status === 401 || status === 403) {
		throw new Error(
			`venmo_session_expired [endpoint ${path}]: ${errorDetail(body)}`,
		);
	}
	if (status === 429) {
		throw new Error(`venmo_rate_limited [endpoint ${path}]`);
	}
	if (status >= 500 && status <= 599) {
		throw new Error(`venmo_server_error [endpoint ${path}]: HTTP ${status}`);
	}
	if (status < 200 || status >= 300) {
		throw new Error(
			`venmo_http_${String(status)} [endpoint ${path}]: ${errorDetail(body)}`,
		);
	}
}

/** A missing or malformed data array cannot prove an inventory is empty. */
function parseVenmoInventory<T>(body: string, path: string): T[] {
	const parsed: unknown = JSON.parse(body);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("data" in parsed) ||
		!Array.isArray(parsed.data) ||
		!parsed.data.every(
			(item: unknown) =>
				item && typeof item === "object" && !Array.isArray(item),
		)
	) {
		throw new Error(
			`venmo_invalid_response [endpoint ${path}]: expected data array`,
		);
	}
	return parsed.data as T[];
}

/** Use the runtime's selection gate and the same schema policy as emitRecord. */
function isAcceptedRecord(
	ctx: BrowserCollectContext,
	stream: string,
	record: Record<string, unknown>,
): boolean {
	return (
		(ctx.isRecordSelected?.(stream, record) ?? true) &&
		validateRecord(stream, record).ok
	);
}

export async function fetchProfile(
	fetchPath: VenmoPageFetch,
): Promise<VenmoUser | null> {
	const { status, body } = await fetchPath("/account");
	assertVenmoOk(status, body, "/account");
	const parsed: unknown = JSON.parse(body);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		!("data" in parsed) ||
		!parsed.data ||
		typeof parsed.data !== "object" ||
		Array.isArray(parsed.data) ||
		!("user" in parsed.data) ||
		(parsed.data.user !== null &&
			(typeof parsed.data.user !== "object" || Array.isArray(parsed.data.user)))
	) {
		throw new Error(
			"venmo_invalid_response [endpoint /account]: expected data.user",
		);
	}
	return parsed.data.user as VenmoUser | null;
}

export async function fetchAllFriends(
	fetchPath: VenmoPageFetch,
	ownerId: string,
	progress: VenmoProgress,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<{ friends: VenmoUser[]; truncated: boolean }> {
	const all: VenmoUser[] = [];
	let offset = 0;
	const walk = await walkPagesWithCeiling({
		maxPages: MAX_FRIENDS_PAGES,
		fetchPage: async (pageNumber) => {
			const pageIndex = pageNumber - 1;
			await progress("Fetching Venmo friends page", {
				stream: "friends",
				phase: "fetch",
				offset_ordinal: pageIndex,
			});
			const { status, body } = await fetchPath(`/users/${ownerId}/friends`, {
				limit: String(FRIENDS_PAGE_SIZE),
				offset: String(offset),
			});
			assertVenmoOk(status, body, "/users/{id}/friends");
			const batch = parseVenmoInventory<VenmoUser>(body, "/users/{id}/friends");
			all.push(...batch);
			await progress("Fetched Venmo friends page", {
				stream: "friends",
				phase: "page",
				item_count: batch.length,
				total_seen: all.length,
			});
			// EXIT A — an empty page proves the offset walk is exhausted. A short
			// non-empty page is not terminal: Venmo can return fewer than `limit`
			// rows while more rows remain.
			if (batch.length === 0) {
				return false;
			}
			offset += batch.length;
			await delay(PAGE_DELAY_MS);
			return true;
		},
	});
	return { friends: all, truncated: walk.truncated };
}

export async function fetchTransactionsPage(
	fetchPath: VenmoPageFetch,
	ownerId: string,
	beforeId: string | undefined,
): Promise<VenmoStory[]> {
	const { status, body } = await fetchPath(
		`/stories/target-or-actor/${ownerId}`,
		{
			limit: String(TRANSACTIONS_PAGE_SIZE),
			...(beforeId ? { before_id: beforeId } : {}),
		},
	);
	assertVenmoOk(status, body, "/stories/target-or-actor/{id}");
	return parseVenmoInventory<VenmoStory>(body, "/stories/target-or-actor/{id}");
}

/** Compare normalized UTC timestamps without losing sub-millisecond precision. */
function isLaterVenmoDate(candidate: string, current: string): boolean {
	const candidateSecond = candidate.slice(0, 19);
	const currentSecond = current.slice(0, 19);
	if (candidateSecond !== currentSecond) {
		return candidateSecond > currentSecond;
	}
	const candidateFraction =
		candidate[19] === "." ? candidate.slice(20, -1) : "";
	const currentFraction = current[19] === "." ? current.slice(20, -1) : "";
	const width = Math.max(candidateFraction.length, currentFraction.length);
	return (
		candidateFraction.padEnd(width, "0") > currentFraction.padEnd(width, "0")
	);
}

async function emitTransactionsPage(
	ctx: BrowserCollectContext,
	stories: VenmoStory[],
	ownerId: string,
	shouldEmit: (record: Record<string, unknown>) => boolean,
): Promise<{
	accepted: number;
	firstSafeId: string | null;
	firstRejectedIndex: number | null;
	rejectionReason: string | null;
	latestSeenAt: string | null;
}> {
	let accepted = 0;
	let firstSafeId: string | null = null;
	let firstRejectedIndex: number | null = null;
	let rejectionReason: string | null = null;
	let latestSeenAt: string | null = null;
	for (const [index, story] of stories.entries()) {
		const parsed = parseTransactionStory(story, ownerId);
		if (parsed.kind === "unsupported") {
			firstSafeId ??= typeof story.id === "string" ? story.id : null;
			continue;
		}
		if (parsed.kind === "invalid") {
			firstRejectedIndex ??= index;
			rejectionReason ??= parsed.reason;
			continue;
		}
		const { record } = parsed;
		const selected = ctx.isRecordSelected?.("transactions", record) ?? true;
		const schemaAccepted = selected
			? validateRecord("transactions", record).ok
			: false;
		if (!selected || !schemaAccepted || shouldEmit(record)) {
			await ctx.emitRecord("transactions", record);
		}
		if (!selected) {
			firstSafeId ??= story.id;
			continue;
		}
		if (!schemaAccepted) {
			firstRejectedIndex ??= index;
			rejectionReason ??= "schema_invalid";
			continue;
		}
		firstSafeId ??= story.id;
		accepted += 1;
		const createdAt =
			typeof record.date_created === "string" ? record.date_created : null;
		if (
			createdAt &&
			(!latestSeenAt || isLaterVenmoDate(createdAt, latestSeenAt))
		) {
			latestSeenAt = createdAt;
		}
	}
	return {
		accepted,
		firstSafeId,
		firstRejectedIndex,
		rejectionReason,
		latestSeenAt,
	};
}

export async function collectTransactions(
	ctx: BrowserCollectContext,
	fetchPath: VenmoPageFetch,
	ownerId: string,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<{
	backfillBeforeId: string | null;
	blockedByRejected: boolean;
	considered: number;
	covered: number;
	headAnchorId: string | null;
	headGaps: HeadGap[];
	refreshFingerprints: Record<string, string>;
	latestSeenAt: string | null;
	rejectionReason: string | null;
	truncated: boolean;
}> {
	const progress = ctx.progress as VenmoProgress;
	const priorCursor = ctx.state.transactions;
	const prior =
		priorCursor &&
		typeof priorCursor === "object" &&
		!Array.isArray(priorCursor)
			? (priorCursor as Record<string, unknown>)
			: {};
	const priorBackfill =
		typeof prior.backfill_before_id === "string" && prior.backfill_before_id
			? prior.backfill_before_id
			: null;
	const priorHeadAnchor =
		typeof prior.head_anchor_id === "string" && prior.head_anchor_id
			? prior.head_anchor_id
			: null;
	const headGaps: HeadGap[] =
		prior.version === 2 && Array.isArray(prior.head_gaps)
			? prior.head_gaps
					.filter(
						(gap): gap is HeadGap =>
							gap !== null &&
							typeof gap === "object" &&
							!Array.isArray(gap) &&
							typeof gap.start_id === "string" &&
							gap.start_id.length > 0 &&
							typeof gap.before_id === "string" &&
							gap.before_id.length > 0 &&
							typeof gap.end_id === "string" &&
							gap.end_id.length > 0,
					)
					.slice(0, MAX_HEAD_GAPS)
			: [];
	const priorFingerprints =
		prior.refresh_fingerprints &&
		typeof prior.refresh_fingerprints === "object" &&
		!Array.isArray(prior.refresh_fingerprints)
			? (prior.refresh_fingerprints as Record<string, unknown>)
			: {};
	const refreshFingerprints: Record<string, string> = {};
	const emittedFingerprints = new Map<string, string>();
	let totalSeen = 0;
	let totalAccepted = 0;
	let pagesFetched = 0;
	let latestSeenAt: string | null = null;
	let firstHeadSafeId: string | null = null;
	let rejectionReason: string | null = null;

	const fetchAndEmitPage = async (
		beforeId: string | undefined,
		seenBeforeIds: Set<string>,
		stopAtId?: string,
		refreshPastStop = false,
	): Promise<
		| (Awaited<ReturnType<typeof emitTransactionsPage>> & {
				stories: VenmoStory[];
				lastStoryId: string;
				reachedStop: boolean;
		  })
		| null
	> => {
		await progress("Fetching Venmo transactions page", {
			stream: "transactions",
			phase: "fetch",
			offset_ordinal: pagesFetched,
			cursor_present: Boolean(beforeId),
			total_seen: totalSeen,
		});
		const fetched = await fetchTransactionsPage(fetchPath, ownerId, beforeId);
		pagesFetched += 1;
		if (fetched.length === 0) {
			return null;
		}
		const stopIndex = stopAtId
			? fetched.findIndex((story) => story.id === stopAtId)
			: -1;
		const reachedStop = stopIndex >= 0;
		const stories =
			reachedStop && !refreshPastStop ? fetched.slice(0, stopIndex) : fetched;
		const lastStoryId = fetched.at(-1)?.id ?? "";
		const finalStory = fetched.at(-1);
		const finalOutcome = finalStory
			? parseTransactionStory(finalStory, ownerId)
			: null;
		const missingSupportedId =
			!lastStoryId &&
			finalOutcome?.kind === "invalid" &&
			finalOutcome.reason === "missing_id";
		if (
			!reachedStop &&
			((!lastStoryId && !missingSupportedId) || seenBeforeIds.has(lastStoryId))
		) {
			throw new Error(
				"venmo_pagination_stalled [endpoint /stories/target-or-actor/{id}]",
			);
		}
		const page = await emitTransactionsPage(ctx, stories, ownerId, (record) => {
			const id = String(record.id);
			const fingerprint = createHash("sha256")
				.update(JSON.stringify(record))
				.digest("hex");
			if (
				pagesFetched <= MUTABLE_REFRESH_PAGES &&
				Object.keys(refreshFingerprints).length < MUTABLE_REFRESH_PAGES * TRANSACTIONS_PAGE_SIZE
			) {
				refreshFingerprints[id] = fingerprint;
			}
			const previous = emittedFingerprints.get(id) ?? priorFingerprints[id];
			emittedFingerprints.set(id, fingerprint);
			return previous !== fingerprint;
		});
		if (lastStoryId) seenBeforeIds.add(lastStoryId);
		totalSeen += stories.length;
		totalAccepted += page.accepted;
		if (
			page.latestSeenAt &&
			(!latestSeenAt || isLaterVenmoDate(page.latestSeenAt, latestSeenAt))
		) {
			latestSeenAt = page.latestSeenAt;
		}
		await progress("Fetched Venmo transactions page", {
			stream: "transactions",
			phase: "page",
			item_count: page.accepted,
			total_seen: totalSeen,
			cursor_present: !reachedStop && fetched.length === TRANSACTIONS_PAGE_SIZE,
		});
		await delay(PAGE_DELAY_MS);
		return { ...page, stories, lastStoryId, reachedStop };
	};

	const safeBeforeRejected = (
		stories: VenmoStory[],
		firstRejectedIndex: number,
		previous: string | undefined,
	): string | undefined => {
		for (let index = firstRejectedIndex - 1; index >= 0; index -= 1) {
			const id = stories[index]?.id;
			if (typeof id === "string" && id.length > 0) {
				return id;
			}
		}
		return previous;
	};

	// Refresh the head, then advance an old head gap and the tail independently.
	// A burst can create a new gap while an older gap is still in progress.
	let headBeforeId: string | undefined;
	let headExhausted = false;
	let headReachedAnchor = false;
	let blockedByRejected = false;
	const headStopId =
		headGaps[0]?.start_id ?? priorHeadAnchor ?? priorBackfill ?? undefined;
	const headSeenIds = new Set<string>();
	const headWalk = await walkPagesWithCeiling({
		maxPages:
			priorBackfill || headGaps.length > 0
				? HEAD_REFRESH_PAGES_WITH_PENDING_WORK
				: MAX_TRANSACTION_PAGES,
		fetchPage: async () => {
			const page = await fetchAndEmitPage(
				headBeforeId,
				headSeenIds,
				headReachedAnchor ? undefined : headStopId,
				true,
			);
			if (!page) {
				headExhausted = true;
				return false;
			}
			firstHeadSafeId ??= page.firstSafeId;
			if (page.firstRejectedIndex !== null) {
				blockedByRejected = true;
				rejectionReason ??= page.rejectionReason;
				headBeforeId = safeBeforeRejected(
					page.stories,
					page.firstRejectedIndex,
					headBeforeId,
				);
				return false;
			}
			headBeforeId = page.lastStoryId;
			if (page.reachedStop) headReachedAnchor = true;
			return !headReachedAnchor || pagesFetched < MUTABLE_REFRESH_PAGES;
		},
	});

	let backfillBeforeId = priorBackfill;
	const newestHeadGap = headGaps[0];
	if (headExhausted) {
		backfillBeforeId = null;
		headGaps.length = 0;
	} else if (!priorBackfill && headGaps.length === 0 && !headStopId) {
		if (headWalk.truncated || blockedByRejected) {
			backfillBeforeId = headBeforeId ?? null;
		}
	} else if (headReachedAnchor && newestHeadGap && firstHeadSafeId) {
		// The next refresh only needs to reach this run's newest safe story.
		newestHeadGap.start_id = firstHeadSafeId;
	} else if (
		!blockedByRejected &&
		!headReachedAnchor &&
		headBeforeId &&
		headStopId &&
		firstHeadSafeId
	) {
		headGaps.unshift({
			start_id: firstHeadSafeId,
			before_id: headBeforeId,
			end_id: headStopId,
		});
		while (headGaps.length > MAX_HEAD_GAPS) {
			const older = headGaps.pop();
			const newer = headGaps.at(-1);
			if (older && newer) newer.end_id = older.end_id;
		}
	}

	// Complete as many pending intervals as the allocated share permits.
	let gapBlocked = false;
	const advanceHeadGaps = async (pageBudget: number): Promise<void> => {
		const endAtPage = pagesFetched + pageBudget;
		while (headGaps.length > 0 && pagesFetched < endAtPage && !gapBlocked) {
			const oldestGap = headGaps.at(-1);
			if (!oldestGap) break;
			let gapBefore = oldestGap.before_id;
			let gapDone = false;
			const gapSeenIds = new Set([gapBefore]);
			await walkPagesWithCeiling({
				maxPages: endAtPage - pagesFetched,
				fetchPage: async () => {
					const page = await fetchAndEmitPage(
						gapBefore,
						gapSeenIds,
						oldestGap.end_id,
					);
					if (!page) {
						// An old cursor returning nothing does not prove this interval closed.
						gapBlocked = true;
						return false;
					}
					if (page.firstRejectedIndex !== null) {
						blockedByRejected = true;
						gapBlocked = true;
						rejectionReason ??= page.rejectionReason;
						gapBefore =
							safeBeforeRejected(
								page.stories,
								page.firstRejectedIndex,
								gapBefore,
							) ?? gapBefore;
						return false;
					}
					if (page.reachedStop) {
						gapDone = true;
						return false;
					}
					gapBefore = page.lastStoryId;
					return true;
				},
			});
			if (gapDone) headGaps.pop();
			else oldestGap.before_id = gapBefore;
		}
	};
	if (!headExhausted && headGaps.length > 0) {
		const reserveForBackfill = priorBackfill ? 100 : 0;
		await advanceHeadGaps(
			Math.min(
				200,
				Math.max(0, MAX_TRANSACTION_PAGES - pagesFetched - reserveForBackfill),
			),
		);
	}

	if (
		!headExhausted &&
		priorBackfill &&
		backfillBeforeId &&
		!(blockedByRejected && headBeforeId === backfillBeforeId) &&
		pagesFetched < MAX_TRANSACTION_PAGES
	) {
		let backfillExhausted = false;
		let backfillAdvanced = false;
		let backfillBefore = backfillBeforeId;
		const backfillSeenIds = new Set([backfillBefore]);
		await walkPagesWithCeiling({
			maxPages: MAX_TRANSACTION_PAGES - pagesFetched,
			fetchPage: async () => {
				const page = await fetchAndEmitPage(backfillBefore, backfillSeenIds);
				if (!page) {
					backfillExhausted = backfillAdvanced;
					return false;
				}
				if (page.firstRejectedIndex !== null) {
					blockedByRejected = true;
					rejectionReason ??= page.rejectionReason;
					backfillBefore =
						safeBeforeRejected(
							page.stories,
							page.firstRejectedIndex,
							backfillBefore,
						) ?? backfillBefore;
					return false;
				}
				backfillBefore = page.lastStoryId;
				backfillAdvanced = true;
				return true;
			},
		});
		backfillBeforeId = backfillExhausted ? null : backfillBefore;
	}
	if (
		!headExhausted &&
		!backfillBeforeId &&
		headGaps.length > 0 &&
		!gapBlocked
	) {
		await advanceHeadGaps(MAX_TRANSACTION_PAGES - pagesFetched);
	}
	const truncated =
		Boolean(backfillBeforeId || headGaps.length > 0) && !blockedByRejected;
	const headAnchorId =
		backfillBeforeId || headGaps.length > 0
			? (headGaps[0]?.start_id ??
				(blockedByRejected
					? (priorHeadAnchor ?? firstHeadSafeId)
					: (firstHeadSafeId ?? priorHeadAnchor)))
			: null;

	return {
		backfillBeforeId,
		blockedByRejected,
		considered: totalSeen + (truncated ? 1 : 0),
		covered: totalAccepted,
		headAnchorId,
		headGaps,
		refreshFingerprints,
		latestSeenAt,
		rejectionReason,
		truncated,
	};
}

async function collectProfile(
	ctx: BrowserCollectContext,
	fetchPath: VenmoPageFetch,
	account: VenmoUser | null,
): Promise<void> {
	const { emit, emitRecord } = ctx;
	const progress = ctx.progress as VenmoProgress;
	await progress("Fetching Venmo profile", {
		stream: "profile",
		phase: "fetch",
	});
	const profileUser = account ?? (await fetchProfile(fetchPath));
	const cursor = openFingerprintCursor(ctx.state.profile, {
		excludeFromFingerprint: [],
	});
	let covered = 0;
	if (profileUser) {
		const record = profileRecord(profileUser);
		if (isAcceptedRecord(ctx, "profile", record)) {
			if (cursor.shouldEmit(record)) {
				await emitRecord("profile", record);
			}
			covered = 1;
			cursor.dropUnseenIds();
			await emit({
				type: "STATE",
				stream: "profile",
				cursor: { fingerprints: cursor.toState() },
			});
		} else {
			await emitRecord("profile", record);
		}
	}
	await emit(
		buildDetailCoverageMessage({
			stream: "profile",
			stateStream: "profile",
			requiredKeys: [],
			hydratedKeys: [],
			considered: profileUser ? 1 : 0,
			covered,
		}),
	);
}

async function collectFriends(
	ctx: BrowserCollectContext,
	fetchPath: VenmoPageFetch,
	ownerId: string,
	progress: VenmoProgress,
	delay: (ms: number) => Promise<void>,
): Promise<void> {
	const { emit, emitRecord } = ctx;
	const { friends, truncated } = await fetchAllFriends(
		fetchPath,
		ownerId,
		progress,
		delay,
	);
	const cursor = openFingerprintCursor(ctx.state.friends, {
		excludeFromFingerprint: [],
	});
	let covered = 0;
	for (const friend of friends) {
		const record = userRecord(friend);
		if (isAcceptedRecord(ctx, "friends", record)) {
			covered += 1;
			if (!cursor.shouldEmit(record)) continue;
		}
		await emitRecord("friends", record);
	}
	if (!truncated) {
		cursor.dropUnseenIds();
	}
	const priorCursor = ctx.state.friends;
	const priorFingerprints =
		priorCursor &&
		typeof priorCursor === "object" &&
		!Array.isArray(priorCursor)
			? (priorCursor as { fingerprints?: unknown }).fingerprints
			: undefined;
	const fingerprints =
		truncated &&
		priorFingerprints &&
		typeof priorFingerprints === "object" &&
		!Array.isArray(priorFingerprints)
			? (priorFingerprints as Record<string, string>)
			: cursor.toState();
	if (truncated) {
		ctx.reportStreamFailure(
			"friends",
			`Venmo friends stopped at the ${MAX_FRIENDS_PAGES}-page limit with unread history`,
			{ retryable: false },
		);
	}
	await emit({ type: "STATE", stream: "friends", cursor: { fingerprints } });
	await emit(
		buildDetailCoverageMessage({
			stream: "friends",
			stateStream: "friends",
			requiredKeys: [],
			hydratedKeys: [],
			considered: friends.length + (truncated ? 1 : 0),
			covered,
		}),
	);
}

/** Exported for integration tests — the full collect() body against an injected page fetch. */
export async function collectAllStreams(
	ctx: BrowserCollectContext,
	fetchPath: VenmoPageFetch,
	ownerId: string,
	account: VenmoUser | null,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<void> {
	const { emit, requested } = ctx;
	const progress = ctx.progress as VenmoProgress;

	if (requested.has("profile")) {
		await collectProfile(ctx, fetchPath, account);
	}

	if (requested.has("friends")) {
		await collectFriends(ctx, fetchPath, ownerId, progress, delay);
	}

	if (requested.has("transactions")) {
		const {
			backfillBeforeId,
			blockedByRejected,
			considered,
			covered,
			headAnchorId,
			headGaps,
			refreshFingerprints,
			latestSeenAt,
			rejectionReason,
			truncated,
		} = await collectTransactions(ctx, fetchPath, ownerId, delay);
		const priorCursor = ctx.state.transactions;
		const priorLatestSeenAt =
			priorCursor &&
			typeof priorCursor === "object" &&
			!Array.isArray(priorCursor)
				? (priorCursor as { last_seen_date_created?: unknown })
						.last_seen_date_created
				: undefined;
		if (truncated) {
			ctx.reportStreamFailure(
				"transactions",
				`Venmo transaction enumeration is incomplete; saved positions retain unread history (limit ${MAX_TRANSACTION_PAGES} pages per run)`,
				{ retryable: false },
			);
		}
		if (blockedByRejected) {
			const reason =
				rejectionReason === "missing_id"
					? "missing story id"
					: rejectionReason === "missing_date_created"
						? "missing date_created"
						: "schema validation failed";
			ctx.reportStreamFailure(
				"transactions",
				`Venmo returned a supported payment with ${reason}; this page remains unfinished`,
				{ retryable: false },
			);
		}
		const normalizedPrior =
			typeof priorLatestSeenAt === "string" || priorLatestSeenAt === null
				? normalizeVenmoDate(priorLatestSeenAt)
				: null;
		const nextLatestSeenAt =
			latestSeenAt &&
			(!normalizedPrior || isLaterVenmoDate(latestSeenAt, normalizedPrior))
				? latestSeenAt
				: normalizedPrior;
		await emit({
			type: "STATE",
			stream: "transactions",
			cursor: {
				last_seen_date_created: nextLatestSeenAt,
				...((backfillBeforeId || headGaps.length > 0) && headAnchorId
					? {
							version: 2,
							refresh_fingerprints: refreshFingerprints,
							...(backfillBeforeId
								? { backfill_before_id: backfillBeforeId }
								: {}),
							head_anchor_id: headAnchorId,
							...(headGaps.length > 0 ? { head_gaps: headGaps } : {}),
						}
					: {}),
			},
		});
		await emit(
			buildDetailCoverageMessage({
				stream: "transactions",
				stateStream: "transactions",
				requiredKeys: [],
				hydratedKeys: [],
				considered,
				covered,
			}),
		);
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "venmo",
		validateRecord,
		// See VENMO_RETRYABLE_PATTERN's doc above for why this is an exact-name
		// pattern rather than the wildcard/bare-vocabulary form it replaced (B4).
		retryablePattern: VENMO_RETRYABLE_PATTERN,
		auth: { kind: "env", required: ["VENMO_USERNAME", "VENMO_PASSWORD"] },
		browser: { profileName: "venmo" },
		async ensureSession({
			assist,
			capture,
			checkpoint,
			completeAssistance,
			credentials,
			onCredentialSubmit,
			page,
			progress,
			sendInteraction,
		}): Promise<void> {
			// Forwarded for signature parity with every other connector's manual-
			// login handoff — see `EnsureVenmoSessionArgs.assist`'s doc in
			// `src/auto-login/venmo.ts` for why this does NOT yet self-resolve
			// without a click: Venmo's only liveness probe requires a navigation
			// that would destroy an in-progress captcha/OTP handoff.
			await ensureVenmoSession({
				assist,
				...(capture ? { capture } : {}),
				checkpoint,
				completeAssistance,
				credentials,
				onCredentialSubmit,
				page,
				progress,
				sendInteraction,
			});
		},
		async collect(ctx: BrowserCollectContext): Promise<void> {
			const { page } = ctx;
			// `ensureSession` may leave the page wherever sign-in redirected it
			// (e.g. `id.venmo.com`); `api.venmo.com`'s CORS allowlist only grants
			// a credentialed fetch from `https://venmo.com`, so collect must
			// establish that origin itself rather than assume ensureSession left
			// it there (F3 in /tmp/review-venmo-browser-redesign-0810.md). See
			// `establishVenmoCollectOrigin`'s doc for why this is wrapped.
			await establishVenmoCollectOrigin(page);
			const fetchPath = makePageFetch(page);
			const account = await fetchProfile(fetchPath);
			const ownerId = account?.id;
			if (!ownerId) {
				throw new Error(
					"venmo_session_expired: /account returned no user id after ensureSession succeeded",
				);
			}
			await collectAllStreams(ctx, fetchPath, ownerId, account);
		},
	});
}
