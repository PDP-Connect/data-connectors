#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Google Calendar Connector (v0.1.0)
 *
 * Official Calendar API v3 (OAuth2, `calendar.readonly` scope) — distinct
 * from the existing `ical` connector, which reads owner-supplied .ics files
 * or subscription URLs with no OAuth and no attendee/recurrence-via-API
 * fidelity. This connector differentiates by syncing directly against
 * Google's account API: syncToken-based incremental paging, in-band
 * deletion tombstones (`status: "cancelled"`), and a full resync on
 * syncToken expiry (HTTP 410).
 *
 * Streams: calendars, events.
 *
 * State shape:
 *   {
 *     calendars: { fingerprints: { [calendarId]: sha1 } },
 *     events: {
 *       [calendarId]: { sync_token?, continuation?: { page_token, pending_prune? }, fingerprints }
 *     }
 *   }
 *
 * Auth: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (shared Google app
 * registration) + GOOGLE_CALENDAR_REFRESH_TOKEN (this connector's own consent
 * grant). See src/google-oauth.ts for the shared refresh primitive.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { createConnectorHttpGovernor } from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import {
	type CollectContext,
	emitDetailCoverage,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type FingerprintCursor,
	openFingerprintCursor,
} from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	type GoogleAccessToken,
	isGoogleOAuthGrantInvalid,
	refreshGoogleAccessToken,
	resolveGoogleOAuthCredentials,
} from "../../packages/polyfill-connectors/src/google-oauth.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import { google_calendarPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import {
	CalendarApiError,
	type CalendarEvent,
	type CalendarListEntry,
	CalendarSyncTokenExpiredError,
	type EventsPage,
	GoogleCalendarClient,
} from "./api.ts";
import { validateRecord } from "./schemas.ts";

// The HTTP governor wraps provider errors in RetryExhaustedError.
function providerCause(error: unknown): unknown {
	return error instanceof Error && "originalCause" in error
		? error.originalCause
		: error;
}

const REFRESH_TOKEN_ENV_VAR = "GOOGLE_CALENDAR_REFRESH_TOKEN";
const MAX_PAGES_PER_CALENDAR = 200;

const httpGovernor = createConnectorHttpGovernor({
	name: "google_calendar",
	maxAttempts: 1,
	profile: google_calendarPacingProfile(),
});

interface EventsContinuation {
	readonly page_token: string;
	/** Prior fingerprint IDs still unseen in a replacement inventory. */
	readonly pending_prune?: readonly string[];
}

interface EventsCalendarState {
	readonly continuation?: EventsContinuation;
	readonly fingerprints?: Record<string, string>;
	readonly sync_token?: string;
}

interface GoogleCalendarState {
	readonly calendars?: { fingerprints?: Record<string, string> };
	readonly events?: Record<string, EventsCalendarState>;
}

function calendarRecord(entry: CalendarListEntry): RecordData {
	return {
		id: entry.id,
		summary: entry.summary,
		time_zone: entry.timeZone,
		access_role: entry.accessRole,
		primary: entry.primary,
		source: "google_calendar_api",
	};
}

function isAllDay(event: CalendarEvent): boolean {
	return Boolean(event.start?.date && !event.start?.dateTime);
}

function eventRecord(calendarId: string, event: CalendarEvent): RecordData {
	const deleted = event.status === "cancelled";
	return {
		id: event.id,
		calendar_id: calendarId,
		summary: event.summary,
		description: event.description,
		location: event.location,
		status: event.status,
		deleted,
		start: event.start?.dateTime ?? null,
		start_date: event.start?.date ?? null,
		end: event.end?.dateTime ?? null,
		end_date: event.end?.date ?? null,
		all_day: isAllDay(event),
		organizer_email: event.organizer?.email ?? null,
		organizer_display_name: event.organizer?.displayName ?? null,
		attendees: event.attendees.map((a) => ({
			email: a.email,
			display_name: a.displayName,
			organizer: a.organizer,
			optional: a.optional,
			response_status: a.responseStatus,
			self: a.self,
		})),
		recurrence: event.recurrence,
		recurring_event_id: event.recurringEventId,
		html_link: event.htmlLink,
		updated: event.updated,
		source: "google_calendar_api",
	};
}

/** Fingerprint fields to exclude for events: `updated` is Google's own
 *  server-side write timestamp and moves whenever Google recomputes derived
 *  state without a human-visible content change (e.g. recurrence expansion
 *  bookkeeping); the rest of the record is the real content signal. */
const EVENT_FINGERPRINT_EXCLUDE = ["updated"] as const;

interface CalendarWalk {
	readonly calendarId: string;
	readonly client: CalendarClientLike;
	readonly ctx: CollectContext;
	readonly cursor: FingerprintCursor;
	readonly maxPages: number;
}

async function pageThroughEvents(
	{ calendarId, client, ctx, cursor, maxPages }: CalendarWalk,
	syncToken: string | undefined,
	pageToken?: string,
	pendingIds?: readonly string[],
) {
	let pendingPrune = pendingIds ? new Set(pendingIds) : undefined;
	let nextPageToken = pageToken ?? null;
	let nextSyncToken: string | null = null;
	const readPage = (continuation: string | null) =>
		httpGovernor.request(
			() =>
				client.listEventsPage(calendarId, {
					...(syncToken ? { syncToken } : {}),
					...(continuation ? { pageToken: continuation } : {}),
				}),
			(value) => ({ status: 200, value }),
		);
	const { truncated } = await walkPagesWithCeiling({
		maxPages,
		fetchPage: async (pageNumber) => {
			const page = await readPage(nextPageToken).catch((error: unknown) => {
				const cause = providerCause(error);
				if (
					pageNumber !== 1 ||
					!pageToken ||
					!(cause instanceof CalendarApiError && cause.status === 400)
				) {
					throw error;
				}
				// Retry once without the rejected continuation. A failed original query propagates.
				if (pendingPrune) pendingPrune = new Set(Object.keys(cursor.toState()));
				return readPage(null);
			});
			await ctx.progress(
				`Fetched Google Calendar events page ${String(pageNumber)}`,
				{ stream: "events", count: page.value.events.length },
			);
			for (const event of page.value.events) {
				pendingPrune?.delete(event.id);
				const record = eventRecord(calendarId, event);
				if (cursor.shouldEmit(record)) {
					await ctx.emitRecord("events", record);
				}
			}
			nextPageToken = page.value.nextPageToken;
			nextSyncToken = page.value.nextSyncToken ?? nextSyncToken;
			return Boolean(nextPageToken);
		},
	});
	return {
		nextPageToken,
		nextSyncToken: truncated ? (syncToken ?? null) : nextSyncToken,
		pendingPrune,
		truncated,
	};
}

async function syncCalendarEvents(
	walk: CalendarWalk,
	prior: EventsCalendarState | undefined,
) {
	const saved = prior?.continuation;
	try {
		return await pageThroughEvents(
			walk,
			prior?.sync_token,
			saved?.page_token,
			saved?.pending_prune,
		);
	} catch (error) {
		if (!(providerCause(error) instanceof CalendarSyncTokenExpiredError))
			throw error;
		// A 410 invalidates the entire listing, including any saved page token.
		return pageThroughEvents(
			walk,
			undefined,
			undefined,
			Object.keys(walk.cursor.toState()),
		);
	}
}

async function persistCalendarEventsResult(args: {
	readonly ctx: CollectContext;
	readonly calendarId: string;
	readonly cursor: FingerprintCursor;
	readonly maxPages: number;
	readonly nextEventsState: Record<string, EventsCalendarState>;
	readonly result: Awaited<ReturnType<typeof pageThroughEvents>>;
}): Promise<boolean> {
	const { ctx, calendarId, cursor, maxPages, nextEventsState, result } = args;
	const fingerprints = cursor.toState();
	if (!result.truncated && result.pendingPrune) {
		for (const id of result.pendingPrune) delete fingerprints[id];
	}
	if (result.truncated) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: "events",
			reason: "older_pages_deferred_page_budget",
			// The ceiling reported here is the one actually enforced, not the
			// module default — otherwise a lowered cap would disclose a limit the
			// walk never applied.
			message: `Google Calendar ${calendarId}: stopped at the ${String(maxPages)}-page limit with more events listed`,
			diagnostics: {
				calendar_id: calendarId,
				page_limit: maxPages,
				unread_pages: 1,
			},
		});
	}
	nextEventsState[calendarId] = {
		...(result.nextSyncToken ? { sync_token: result.nextSyncToken } : {}),
		...(result.nextPageToken
			? {
					continuation: {
						page_token: result.nextPageToken,
						...(result.pendingPrune
							? { pending_prune: [...result.pendingPrune] }
							: {}),
					},
				}
			: {}),
		fingerprints,
	};
	return !result.truncated;
}

/** Structural shape the connector needs from a Calendar client — lets tests
 *  substitute a fake without extending the concrete `GoogleCalendarClient`. */
export interface CalendarClientLike {
	listCalendars: () => Promise<CalendarListEntry[]>;
	listEventsPage: (
		calendarId: string,
		options: { pageToken?: string; syncToken?: string; timeMin?: string },
	) => Promise<EventsPage>;
}

interface CalendarCollectOptions {
	readonly clientFactory?: (accessToken: string) => CalendarClientLike;
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	readonly getAccessToken?: () => Promise<GoogleAccessToken>;
	/** Test seam: lowers the page ceiling so truncation is reachable without
	 *  standing up {@link MAX_PAGES_PER_CALENDAR} pages of fixtures. */
	readonly maxPagesPerCalendar?: number;
}

export async function collectGoogleCalendar(
	ctx: CollectContext,
	options: CalendarCollectOptions = {},
): Promise<void> {
	const env = options.env ?? process.env;
	const maxPagesPerCalendar =
		options.maxPagesPerCalendar ?? MAX_PAGES_PER_CALENDAR;
	const getAccessToken =
		options.getAccessToken ??
		(async (): Promise<GoogleAccessToken> => {
			const credentials = resolveGoogleOAuthCredentials(
				env,
				REFRESH_TOKEN_ENV_VAR,
			);
			try {
				return await refreshGoogleAccessToken(credentials);
			} catch (error) {
				if (isGoogleOAuthGrantInvalid(error)) {
					throw new Error("google_calendar_auth_failed", { cause: error });
				}
				throw error;
			}
		});

	const wantsCalendars = ctx.requested.has("calendars");
	const wantsEvents = ctx.requested.has("events");
	if (!(wantsCalendars || wantsEvents)) {
		await ctx.progress("No Google Calendar streams requested", {
			stream: "calendars",
		});
		return;
	}

	const { accessToken } = await getAccessToken();
	const client = options.clientFactory
		? options.clientFactory(accessToken)
		: new GoogleCalendarClient({ accessToken });

	const state = (ctx.state as GoogleCalendarState) ?? {};
	const calendars = await httpGovernor.request(
		() => client.listCalendars(),
		(value) => ({ status: 200, value }),
	);

	const calendarsCursor = openFingerprintCursor(state.calendars);
	if (wantsCalendars) {
		for (const entry of calendars.value) {
			const record = calendarRecord(entry);
			if (calendarsCursor.shouldEmit(record)) {
				await ctx.emitRecord("calendars", record);
			}
		}
		calendarsCursor.dropUnseenIds();
		await ctx.emit({
			type: "STATE",
			stream: "calendars",
			cursor: { fingerprints: calendarsCursor.toState() },
		});
	}

	if (!wantsEvents) {
		return;
	}

	const nextEventsState: Record<string, EventsCalendarState> = {
		...(state.events ?? {}),
	};
	const requiredCalendarIds = calendars.value.map((c) => c.id);
	const coveredCalendarIds: string[] = [];

	for (const entry of calendars.value) {
		const priorCalendarState = state.events?.[entry.id];
		const eventsCursor = openFingerprintCursor(priorCalendarState, {
			excludeFromFingerprint: [...EVENT_FINGERPRINT_EXCLUDE],
		});
		await ctx.progress("Syncing Google Calendar events", { stream: "events" });
		const result = await syncCalendarEvents(
			{
				calendarId: entry.id,
				client,
				ctx,
				cursor: eventsCursor,
				maxPages: maxPagesPerCalendar,
			},
			priorCalendarState,
		);
		// A syncToken response is a PARTIAL delta (only changed/deleted events
		// surface), so pruning is only valid on the full-resync path — the same
		// rule Gmail/YNAB apply to their own delta vs. full-scan cursors.
		if (
			await persistCalendarEventsResult({
				ctx,
				calendarId: entry.id,
				cursor: eventsCursor,
				maxPages: maxPagesPerCalendar,
				nextEventsState,
				result,
			})
		) {
			coveredCalendarIds.push(entry.id);
		}
		await ctx.emit({
			type: "STATE",
			stream: "events",
			cursor: nextEventsState,
		});
	}

	await emitDetailCoverage(ctx, {
		stream: "events",
		stateStream: "events",
		requiredKeys: requiredCalendarIds,
		hydratedKeys: coveredCalendarIds,
		considered: requiredCalendarIds.length,
		covered: coveredCalendarIds.length,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "google_calendar",
		validateRecord,
		retryablePattern:
			/429|5\d\d|timeout|temporar|rate|unavailable|google_calendar_api_error/i,
		isTombstone: (stream, data) => stream === "events" && data.deleted === true,
		auth: {
			kind: "env",
			required: [
				"GOOGLE_OAUTH_CLIENT_ID",
				"GOOGLE_OAUTH_CLIENT_SECRET",
				REFRESH_TOKEN_ENV_VAR,
			],
		},
		collect: (ctx) => collectGoogleCalendar(ctx),
	});
}
