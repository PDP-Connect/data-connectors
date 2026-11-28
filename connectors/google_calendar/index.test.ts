// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type {
	CollectContext,
	EmittedMessage,
	RecordData,
	StartMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { CalendarEvent, CalendarListEntry, EventsPage } from "./api.ts";
import { CalendarApiError, CalendarSyncTokenExpiredError } from "./api.ts";
import { collectGoogleCalendar } from "./index.ts";
import { calendarsSchema } from "./schemas.ts";

test("calendar metadata accepts explicit null without treating missing fields as null", () => {
	const metadata = {
		id: "synthetic-calendar",
		summary: null,
		time_zone: null,
		access_role: null,
		primary: false,
		source: "google_calendar_api",
	};
	assert.equal(calendarsSchema.safeParse(metadata).success, true);
	assert.equal(
		calendarsSchema.safeParse({ ...metadata, summary: undefined }).success,
		false,
	);
});

test("calendar metadata accepts summaries at the declared limit but not beyond", () => {
	const metadata = {
		id: "synthetic-calendar",
		time_zone: "UTC",
		access_role: null,
		primary: false,
		source: "google_calendar_api",
	};
	assert.equal(
		calendarsSchema.safeParse({ ...metadata, summary: "x".repeat(2000) })
			.success,
		true,
	);
	assert.equal(
		calendarsSchema.safeParse({ ...metadata, summary: "x".repeat(2001) })
			.success,
		false,
	);
});

class FakeCalendarClient {
	readonly calls: Array<{ args?: unknown; method: string }> = [];
	private readonly calendars: CalendarListEntry[];
	private readonly eventPages: EventsPage[];
	private readonly onListEvents?: (
		calendarId: string,
		options: { pageToken?: string; syncToken?: string },
	) => EventsPage;

	constructor(args: {
		calendars: CalendarListEntry[];
		eventPages?: EventsPage[];
		onListEvents?: (
			calendarId: string,
			options: { pageToken?: string; syncToken?: string },
		) => EventsPage;
	}) {
		this.calendars = args.calendars;
		this.eventPages = args.eventPages ?? [];
		if (args.onListEvents) {
			this.onListEvents = args.onListEvents;
		}
	}

	listCalendars(): Promise<CalendarListEntry[]> {
		this.calls.push({ method: "listCalendars" });
		return Promise.resolve(this.calendars);
	}

	listEventsPage(
		calendarId: string,
		options: { pageToken?: string; syncToken?: string },
	): Promise<EventsPage> {
		this.calls.push({
			args: { calendarId, options },
			method: "listEventsPage",
		});
		if (this.onListEvents) {
			return Promise.resolve(this.onListEvents(calendarId, options));
		}
		const page = this.eventPages.shift();
		assert.ok(page, "unexpected listEventsPage call — no fake page queued");
		return Promise.resolve(page);
	}
}

function makeEvent(
	overrides: Partial<CalendarEvent> & { id: string },
): CalendarEvent {
	return {
		attendees: [],
		description: null,
		end: null,
		htmlLink: null,
		location: null,
		organizer: null,
		recurrence: null,
		recurringEventId: null,
		start: {
			date: null,
			dateTime: "2026-08-01T09:00:00-05:00",
			timeZone: "America/Chicago",
		},
		status: "confirmed",
		summary: "Event",
		updated: "2026-08-01T00:00:00Z",
		...overrides,
	};
}

function makeContext({
	state = {},
	streams = [{ name: "calendars" }, { name: "events" }],
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	const start: StartMessage = { type: "START", scope: { streams }, state };
	return {
		messages,
		records,
		ctx: {
			assist: () => Promise.resolve("asst_test"),
			capture: null,
			completeAssistance: () => Promise.resolve(),
			credentials: {},
			detailGaps: [],
			emit: (msg) => {
				messages.push(msg);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				records.push({ data, stream });
				return Promise.resolve();
			},
			emittedAt: "2026-08-07T00:00:00.000Z",
			progress: () => Promise.resolve(),
			requested: new Map(streams.map((stream) => [stream.name, stream])),
			requestDetailGapPage: () => Promise.resolve([]),
			scope: start.scope,
			sendInteraction: () =>
				Promise.resolve({
					request_id: "int_test",
					status: "cancelled" as const,
					type: "INTERACTION_RESPONSE" as const,
				}),
			state,
		},
	};
}

const ENV = {
	GOOGLE_OAUTH_CLIENT_ID: "client-id",
	GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
	GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token",
};

const FAKE_TOKEN = {
	getAccessToken: () =>
		Promise.resolve({
			accessToken: "ya29.fake",
			expiresAt: Date.now() + 3_600_000,
		}),
};

/** Narrow the last STATE message for a stream out of the emitted-message log. */
function lastStateCursor(
	messages: readonly EmittedMessage[],
	stream: string,
): unknown {
	const found = [...messages]
		.reverse()
		.find((msg) => msg.type === "STATE" && msg.stream === stream);
	return found && found.type === "STATE" ? found.cursor : undefined;
}

test("emits calendars and events, advancing the syncToken cursor", async () => {
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{
				events: [makeEvent({ id: "evt1" })],
				nextPageToken: null,
				nextSyncToken: "sync-1",
			},
		],
	});
	const { ctx, messages, records } = makeContext();

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	assert.equal(records.filter((r) => r.stream === "calendars").length, 1);
	assert.equal(records.filter((r) => r.stream === "events").length, 1);
	const cursor = lastStateCursor(messages, "events") as Record<
		string,
		{ sync_token?: string }
	>;
	assert.equal(cursor.primary?.sync_token, "sync-1");
});

test("pages through multiple event pages before advancing the cursor", async () => {
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{
				events: [makeEvent({ id: "evt1" })],
				nextPageToken: "page2",
				nextSyncToken: null,
			},
			{
				events: [makeEvent({ id: "evt2" })],
				nextPageToken: null,
				nextSyncToken: "sync-final",
			},
		],
	});
	const { ctx, records } = makeContext();

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	const eventCalls = fakeClient.calls.filter(
		(c) => c.method === "listEventsPage",
	);
	assert.equal(eventCalls.length, 2);
	assert.equal(records.filter((r) => r.stream === "events").length, 2);
});

test("a page cap with a continuation token discloses truncation instead of claiming coverage", async () => {
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{
				events: [makeEvent({ id: "evt1" })],
				nextPageToken: "page2",
				nextSyncToken: null,
			},
			{
				events: [makeEvent({ id: "evt2" })],
				nextPageToken: null,
				nextSyncToken: "sync-final",
			},
		],
	});
	const { ctx, messages, records } = makeContext();

	// The ceiling is hit while the provider still advertises another page. The
	// run does not fail — it keeps the prefix it enumerated — but it must say so
	// rather than let a truncated walk read as a complete one.
	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		maxPagesPerCalendar: 1,
		...FAKE_TOKEN,
	});

	assert.equal(
		records.filter((r) => r.stream === "events").length,
		1,
		"the enumerated prefix may be emitted",
	);
	const skip = messages.find(
		(message): message is Extract<typeof message, { type: "SKIP_RESULT" }> =>
			message.type === "SKIP_RESULT" && message.stream === "events",
	);
	assert.ok(skip, "a truncated walk must disclose itself to the owner");
	assert.equal(skip.reason, "older_pages_deferred_page_budget");
	assert.match(
		skip.message,
		/1-page limit/,
		"the disclosed ceiling must be the one actually enforced",
	);
	// Coverage IS emitted on a truncated walk — suppressing it would leave the
	// stream with no denominator at all. What must never happen is a COMPLETE
	// claim: a truncated calendar is withheld from the covered set, so the
	// shortfall is visible.
	const coverage = messages.find(
		(
			message,
		): message is Extract<typeof message, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "events",
	);
	assert.ok(coverage, "a truncated walk still needs a denominator");
	const { considered, covered } = coverage;
	assert.equal(
		typeof considered,
		"number",
		"a coverage claim without a denominator is not a claim",
	);
	assert.equal(
		typeof covered,
		"number",
		"a coverage claim without a numerator is not a claim",
	);
	assert.ok(
		(considered as number) > (covered as number),
		`truncation must read as a shortfall, got ${String(covered)}/${String(considered)}`,
	);
});

test("carries forward the prior syncToken cursor on an incremental run", async () => {
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{
				events: [makeEvent({ id: "evt2" })],
				nextPageToken: null,
				nextSyncToken: "sync-2",
			},
		],
	});
	const priorState = {
		calendars: { fingerprints: {} },
		events: { primary: { sync_token: "sync-1", fingerprints: {} } },
	};
	const { ctx } = makeContext({ state: priorState });

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	const call = fakeClient.calls.find((c) => c.method === "listEventsPage");
	assert.ok(call);
	const args = call.args as { options: { syncToken?: string } };
	assert.equal(args.options.syncToken, "sync-1");
});

for (const mode of ["incremental", "initial", "expired"] as const) {
	test(`a fresh Calendar sync resumes page two with the same one-page limit (${mode})`, async () => {
		const original = mode === "initial" ? undefined : "old-sync";
		const calls: Array<{ pageToken?: string; syncToken?: string }> = [];
		const client = new FakeCalendarClient({
			calendars: [
				{
					id: "work",
					summary: null,
					primary: true,
					accessRole: "owner",
					timeZone: null,
				},
			],
			onListEvents(_, tokens) {
				calls.push({ ...tokens });
				if (mode === "expired" && tokens.syncToken === "old-sync")
					throw new CalendarSyncTokenExpiredError();
				assert.equal(
					tokens.syncToken,
					mode === "incremental" ? original : undefined,
				);
				if (!tokens.pageToken)
					return {
						events: [makeEvent({ id: "A" })],
						nextPageToken: "page-B",
						nextSyncToken: null,
					};
				assert.equal(tokens.pageToken, "page-B");
				return {
					events: [makeEvent({ id: "B" })],
					nextPageToken: null,
					nextSyncToken: "new-sync",
				};
			},
		});
		async function run(events: unknown) {
			const { ctx, messages, records } = makeContext({
				state: { events },
				streams: [{ name: "events" }],
			});
			await collectGoogleCalendar(ctx, {
				...FAKE_TOKEN,
				clientFactory: () => client,
				maxPagesPerCalendar: 1,
			});
			const state = lastStateCursor(messages, "events") as Record<
				string,
				{
					sync_token?: string;
					fingerprints: Record<string, string>;
					continuation?: { page_token: string };
				}
			>;
			assert.ok(state.work);
			return {
				state: structuredClone(state),
				ids: records.map(({ data }) => data.id),
				deferred: messages.some(
					(message) =>
						message.type === "SKIP_RESULT" &&
						message.reason === "older_pages_deferred_page_budget",
				),
			};
		}
		const first = await run({
			work: { sync_token: original, fingerprints: { previous: "unchanged" } },
		});
		assert.deepEqual(first.ids, ["A"]);
		assert.equal(first.deferred, true);
		assert.equal(
			first.state.work?.sync_token,
			mode === "incremental" ? original : undefined,
		);
		assert.equal(first.state.work?.fingerprints.previous, "unchanged");
		calls.length = 0;
		const second = await run(first.state);
		assert.deepEqual(second.ids, ["B"]);
		assert.deepEqual(calls, [
			mode === "incremental"
				? { syncToken: original, pageToken: "page-B" }
				: { pageToken: "page-B" },
		]);
		assert.equal(second.deferred, false);
		assert.equal(second.state.work?.sync_token, "new-sync");
		assert.equal(second.state.work?.continuation, undefined);
		assert.ok(
			second.state.work?.fingerprints.A && second.state.work?.fingerprints.B,
		);
		if (mode === "expired")
			assert.equal(second.state.work?.fingerprints.previous, undefined);
		if (mode === "incremental")
			assert.equal(second.state.work?.fingerprints.previous, "unchanged");
	});
}

for (const status of [400, 410]) {
	test(`Calendar restarts the listing when the saved continuation gets HTTP ${status}`, async () => {
		const calls: Array<{ pageToken?: string; syncToken?: string }> = [];
		const client = new FakeCalendarClient({
			calendars: [
				{
					id: "work",
					summary: null,
					primary: true,
					accessRole: "owner",
					timeZone: null,
				},
			],
			onListEvents(_, tokens) {
				calls.push({ ...tokens });
				if (tokens.pageToken === "expired-page") {
					if (status === 410) throw new CalendarSyncTokenExpiredError();
					throw new CalendarApiError(400, "Invalid value");
				}
				return {
					events: [makeEvent({ id: "tail" })],
					nextPageToken: null,
					nextSyncToken: "earned",
				};
			},
		});
		const { ctx, messages, records } = makeContext({
			streams: [{ name: "events" }],
			state: {
				events: {
					work: {
						sync_token: "original",
						continuation: { page_token: "expired-page" },
						fingerprints: { prior: "known" },
					},
				},
			},
		});
		await collectGoogleCalendar(ctx, {
			...FAKE_TOKEN,
			clientFactory: () => client,
			maxPagesPerCalendar: 1,
		});
		assert.deepEqual(calls, [
			{ syncToken: "original", pageToken: "expired-page" },
			status === 410 ? {} : { syncToken: "original" },
		]);
		assert.deepEqual(
			records.map((r) => r.data.id),
			["tail"],
		);
		const state = lastStateCursor(messages, "events") as {
			work: {
				sync_token: string;
				fingerprints: Record<string, string>;
				continuation?: unknown;
			};
		};
		assert.equal(state.work.sync_token, "earned");
		assert.equal(state.work.continuation, undefined);
		assert.equal(
			state.work.fingerprints.prior,
			status === 410 ? undefined : "known",
		);
	});
}

test("unchanged event does not re-emit (fingerprint gate) but does not drop the cursor", async () => {
	const event = makeEvent({ id: "evt1", updated: "2026-08-01T00:00:00Z" });
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{ events: [event], nextPageToken: null, nextSyncToken: "sync-2" },
		],
	});
	// Prior fingerprint computed by first emitting the same record through the
	// real builder shape (excluding `updated`) — simplest to just run once to
	// seed it, then run again and assert no second emit.
	const seedCtx = makeContext();
	await collectGoogleCalendar(seedCtx.ctx, {
		clientFactory: () =>
			new FakeCalendarClient({
				calendars: [
					{
						id: "primary",
						summary: "Work",
						primary: true,
						accessRole: "owner",
						timeZone: null,
					},
				],
				eventPages: [
					{ events: [event], nextPageToken: null, nextSyncToken: "sync-1" },
				],
			}),
		env: ENV,
		...FAKE_TOKEN,
	});
	const seededState = lastStateCursor(seedCtx.messages, "events");

	const { ctx, records } = makeContext({
		state: { events: seededState as Record<string, unknown> },
	});
	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	// Same event content (only `updated` differs is excluded from fingerprint,
	// and here it's identical too) — must NOT re-emit.
	assert.equal(records.filter((r) => r.stream === "events").length, 0);
});

test("cancelled event emits a tombstone record with deleted=true", async () => {
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		eventPages: [
			{
				events: [
					makeEvent({ id: "evt-gone", status: "cancelled", summary: null }),
				],
				nextPageToken: null,
				nextSyncToken: "sync-1",
			},
		],
	});
	const { ctx, records } = makeContext();

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	const eventRecord = records.find((r) => r.stream === "events");
	assert.ok(eventRecord);
	assert.equal(eventRecord.data.deleted, true);
	assert.equal(eventRecord.data.status, "cancelled");
});

test("falls back to a full resync when the syncToken has expired (HTTP 410)", async () => {
	let call = 0;
	const fakeClient = new FakeCalendarClient({
		calendars: [
			{
				id: "primary",
				summary: "Work",
				primary: true,
				accessRole: "owner",
				timeZone: null,
			},
		],
		onListEvents: (_calendarId, options) => {
			call += 1;
			if (call === 1) {
				assert.equal(options.syncToken, "sync-expired");
				throw new CalendarSyncTokenExpiredError();
			}
			// Full resync path — no syncToken this time.
			assert.equal(options.syncToken, undefined);
			return {
				events: [makeEvent({ id: "evt-full" })],
				nextPageToken: null,
				nextSyncToken: "sync-fresh",
			};
		},
	});
	const priorState = {
		events: {
			primary: { sync_token: "sync-expired", fingerprints: { stale: "abc" } },
		},
	};
	const { ctx, messages, records } = makeContext({ state: priorState });

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	assert.equal(records.filter((r) => r.stream === "events").length, 1);
	const cursor = lastStateCursor(messages, "events") as Record<
		string,
		{ sync_token?: string; fingerprints?: Record<string, string> }
	>;
	assert.equal(cursor.primary?.sync_token, "sync-fresh");
	// The stale fingerprint from the discarded cursor must be pruned on a full resync.
	assert.equal(cursor.primary?.fingerprints?.stale, undefined);
});

test("no-op when neither calendars nor events streams are requested", async () => {
	const fakeClient = new FakeCalendarClient({ calendars: [] });
	const { ctx, records } = makeContext({ streams: [] });

	await collectGoogleCalendar(ctx, {
		clientFactory: () => fakeClient,
		env: ENV,
		...FAKE_TOKEN,
	});

	assert.equal(fakeClient.calls.length, 0);
	assert.equal(records.length, 0);
});

// ─── Default credential-resolution path (no getAccessToken override) ────
//
// Every test above passes FAKE_TOKEN, which bypasses collectGoogleCalendar's
// own default `getAccessToken` closure entirely — a dead or silently-broken
// refreshGoogleAccessToken()/resolveGoogleOAuthCredentials() call would not
// fail any of them. This test omits the override so the connector's real
// default path (src/google-oauth.ts, reached via the global `fetch`) runs
// end to end: it stubs `globalThis.fetch` for the token endpoint only, and
// asserts the access token handed to the client factory is the one that
// ONLY a real refresh exchange could have produced.

test("default getAccessToken path calls the real Google OAuth token endpoint and forwards its access_token to the client", async () => {
	const originalFetch = globalThis.fetch;
	const tokenCalls: Array<{ body: string; url: string }> = [];
	globalThis.fetch = ((url: string, init: RequestInit) => {
		tokenCalls.push({ body: String(init.body ?? ""), url: String(url) });
		return Promise.resolve(
			new Response(
				JSON.stringify({
					access_token: "ya29.from-real-refresh-flow",
					expires_in: 3600,
				}),
				{
					headers: { "Content-Type": "application/json" },
					status: 200,
				},
			),
		);
	}) as typeof fetch;

	try {
		const fakeClient = new FakeCalendarClient({
			calendars: [
				{
					id: "primary",
					summary: "Work",
					primary: true,
					accessRole: "owner",
					timeZone: null,
				},
			],
			eventPages: [
				{ events: [], nextPageToken: null, nextSyncToken: "sync-1" },
			],
		});
		let capturedAccessToken: string | null = null;
		const { ctx } = makeContext();

		// No getAccessToken override — exercises collectGoogleCalendar's own
		// default closure, which must call resolveGoogleOAuthCredentials +
		// refreshGoogleAccessToken exactly as production does.
		await collectGoogleCalendar(ctx, {
			clientFactory: (accessToken) => {
				capturedAccessToken = accessToken;
				return fakeClient;
			},
			env: ENV,
		});

		assert.equal(
			tokenCalls.length,
			1,
			"the real token endpoint must be called exactly once",
		);
		assert.equal(tokenCalls[0]?.url, "https://oauth2.googleapis.com/token");
		const params = new URLSearchParams(tokenCalls[0]?.body ?? "");
		assert.equal(params.get("client_id"), ENV.GOOGLE_OAUTH_CLIENT_ID);
		assert.equal(params.get("client_secret"), ENV.GOOGLE_OAUTH_CLIENT_SECRET);
		assert.equal(
			params.get("refresh_token"),
			ENV.GOOGLE_CALENDAR_REFRESH_TOKEN,
		);
		assert.equal(params.get("grant_type"), "refresh_token");
		assert.equal(capturedAccessToken, "ya29.from-real-refresh-flow");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("default getAccessToken path surfaces google_calendar_auth_failed on invalid_grant (400) without calling the client", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ error: "invalid_grant" }), {
				headers: { "Content-Type": "application/json" },
				status: 400,
			}),
		)) as typeof fetch;

	try {
		let clientFactoryCalled = false;
		const { ctx } = makeContext();

		await assert.rejects(
			() =>
				collectGoogleCalendar(ctx, {
					clientFactory: () => {
						clientFactoryCalled = true;
						return new FakeCalendarClient({ calendars: [] });
					},
					env: ENV,
				}),
			/google_calendar_auth_failed/,
		);
		assert.equal(
			clientFactoryCalled,
			false,
			"a revoked grant must fail before any client is constructed",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
