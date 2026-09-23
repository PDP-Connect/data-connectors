#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Oura Connector (v0.1.1)
 *
 * Auth: OURA_PERSONAL_ACCESS_TOKEN env var.
 * Generate at https://cloud.ouraring.com/personal-access-tokens
 *
 * Streams: sleep, readiness, activity. Incremental via day cursor.
 * API: https://api.ouraring.com/v2/usercollection/*
 *   `sleep` joins two v2 resources by day: /usercollection/sleep (per-session
 *   document) and /usercollection/daily_sleep (score + contributors
 *   aggregate) — see collectSleep.
 * Rate limit: 5000 requests per 5-minute window (V1+V2 API).
 *   Doc: https://cloud.ouraring.com/docs/error-handling
 *
 * No live Oura token is available in this environment (no API access to
 * verify the daily_activity/daily_sleep response shapes below against a
 * real payload). Fields are named and typed per the documented v2 API
 * surface; see legacy-derivability.json (oura.activity, oura.sleep) for the
 * live-proof-pending caveat.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import {
	type ConnectorHttpGovernor,
	createConnectorHttpGovernor,
} from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import {
	type CollectContext,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import { ouraPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API = "https://api.ouraring.com/v2/usercollection";
const MAX_PAGES = 100;

// Single per-provider send governor + retry layer (shared convergence
// primitive). `maxAttempts: 1` keeps today's behavior byte-identical: a 429
// throws `oura_rate_limited` immediately (no inline retry), so the runtime
// `retryablePattern` cross-run source-pressure deferral/cooldown contract is
// unchanged. Raising `maxAttempts` (an owner knob) activates the now-wired
// inline Retry-After honor + bounded backoff without touching this call site.
// §3 ProviderProfile: oura declares its own AUDITED pacing ceiling (250ms ≈
// 4 req/s, ~24% of Oura's documented 5000-req/5-min ceiling — a deliberate 4×
// margin; WI-1b). NOT a borrow of ChatGPT's 250ms (same number, independently
// derived from Oura's limit). See src/provider-profile.ts → ouraPacingProfile and
// docs/research/per-connector-rate-profiles-2026-06-13.md for the derivation.
const httpGovernor = createConnectorHttpGovernor({
	name: "oura",
	maxAttempts: 1,
	profile: ouraPacingProfile(),
});

/** Governor the walk actually sends through. Production always uses the paced
 *  module-level one; a test may substitute an unpaced governor so a two-page
 *  fixture does not have to wait out the real rate ceiling. The ceiling itself
 *  stays covered by `ouraPacingProfile()`'s own tests. */
type OuraHttpGovernor = Pick<ConnectorHttpGovernor, "request">;

interface OuraSleepSession {
	average_breath?: number | null;
	average_heart_rate?: number | null;
	average_hrv?: number | null;
	bedtime_end?: string | null;
	bedtime_start?: string | null;
	day: string;
	deep_sleep_duration?: number | null;
	efficiency?: number | null;
	id: string;
	latency?: number | null;
	light_sleep_duration?: number | null;
	lowest_heart_rate?: number | null;
	rem_sleep_duration?: number | null;
	restless_periods?: number | null;
	temperature_delta?: number | null;
	time_in_bed?: number | null;
	total_sleep_duration?: number | null;
	type?: string | null;
}

/**
 * GET /v2/usercollection/daily_sleep — the daily sleep-score aggregate,
 * distinct from the per-session /v2/usercollection/sleep document above. Its
 * `contributors` map and `score` are joined onto the sleep record by `day`
 * (see collectSleep) because a nightly sleep session and its daily score are
 * two separate v2 API resources sharing the same date key.
 */
interface OuraDailySleep {
	contributors?: Record<string, unknown>;
	day: string;
	id: string;
	score?: number | null;
}

interface OuraReadiness {
	contributors?: Record<string, unknown>;
	day: string;
	id: string;
	score?: number | null;
	temperature_deviation?: number | null;
	temperature_trend_deviation?: number | null;
}

interface OuraActivity {
	active_calories?: number | null;
	contributors?: Record<string, unknown>;
	day: string;
	equivalent_walking_distance?: number | null;
	high_activity_time?: number | null;
	id: string;
	inactivity_alerts?: number | null;
	low_activity_time?: number | null;
	medium_activity_time?: number | null;
	resting_time?: number | null;
	score?: number | null;
	sedentary_time?: number | null;
	steps?: number | null;
	target_calories?: number | null;
	total_calories?: number | null;
}

type OuraRow = OuraSleepSession | OuraDailySleep | OuraReadiness | OuraActivity;

interface OuraListResponse<T> {
	data: T[];
	next_token?: string | null;
}

interface OuraParams {
	end_date?: string;
	next_token?: string;
	start_date?: string;
}

interface OuraRawResponse {
	body: string;
	retryAfter?: string;
	status: number;
}

async function oura<T>(
	governor: OuraHttpGovernor,
	endpoint: string,
	token: string,
	params: OuraParams,
): Promise<OuraListResponse<T>> {
	const url = new URL(`${API}/${endpoint}`);
	for (const [k, v] of Object.entries(params)) {
		if (v !== undefined) {
			url.searchParams.set(k, v);
		}
	}
	// The governor honors Retry-After and retries 429/5xx inline through ONE
	// pre-flight send governor; terminal 429 exhaustion throws `oura_rate_limited`
	// (the runtime `retryablePattern` cross-run contract). The body is read once
	// per attempt (each attempt is a fresh fetch / fresh Response stream).
	const result = await governor.request<OuraRawResponse, OuraRawResponse>(
		async (): Promise<OuraRawResponse> => {
			const res = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
			});
			const retryAfter = res.headers.get("retry-after");
			return {
				body: await res.text(),
				...(retryAfter === null ? {} : { retryAfter }),
				status: res.status,
			};
		},
		(rawResponse) => ({
			status: rawResponse.status,
			headers: { "retry-after": rawResponse.retryAfter },
			value: rawResponse,
		}),
	);
	const raw = result.value;
	if (raw.status === 401) {
		throw new Error("oura_auth_failed");
	}
	if (raw.status < 200 || raw.status >= 300) {
		throw new Error(
			`oura_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`,
		);
	}
	return JSON.parse(raw.body) as OuraListResponse<T>;
}

/**
 * Page one Oura collection. Exhausting the page ceiling and receiving no
 * `next_token` used to produce a byte-identical return value, so a capped walk
 * read as a finished one. `truncated` is the distinction the caller needs to
 * withhold its cursor and disclose the deferred tail.
 */
async function fetchAll<T>(
	governor: OuraHttpGovernor,
	endpoint: string,
	token: string,
	startDate: string | null,
	maxPages: number,
): Promise<{ rows: T[]; truncated: boolean }> {
	const all: T[] = [];
	let nextToken: string | undefined;
	const walk = await walkPagesWithCeiling({
		maxPages,
		fetchPage: async () => {
			const params: OuraParams = {};
			if (startDate) {
				params.start_date = startDate;
			}
			if (nextToken) {
				params.next_token = nextToken;
			}
			const json = await oura<T>(governor, endpoint, token, params);
			if (Array.isArray(json.data)) {
				all.push(...json.data);
			}
			nextToken = json.next_token || undefined;
			return Boolean(nextToken);
		},
	});
	return { rows: all, truncated: walk.truncated };
}

/**
 * `dailySleep` is the same day's /v2/usercollection/daily_sleep document, when
 * one was fetched and matched by day (see collectSleep) — absent for a day
 * whose daily_sleep document is missing or unmatched, which contributes
 * `sleep_score: null` / `contributors: {}` rather than failing the record.
 */
function sleepRecord(
	s: OuraSleepSession,
	dailySleep: OuraDailySleep | undefined,
): RecordData {
	return {
		id: s.id,
		day: s.day,
		bedtime_start: s.bedtime_start ?? null,
		bedtime_end: s.bedtime_end ?? null,
		total_sleep_duration: s.total_sleep_duration ?? null,
		rem_sleep_duration: s.rem_sleep_duration ?? null,
		deep_sleep_duration: s.deep_sleep_duration ?? null,
		light_sleep_duration: s.light_sleep_duration ?? null,
		efficiency: s.efficiency ?? null,
		latency: s.latency ?? null,
		average_heart_rate: s.average_heart_rate ?? null,
		lowest_heart_rate: s.lowest_heart_rate ?? null,
		average_hrv: s.average_hrv ?? null,
		temperature_delta: s.temperature_delta ?? null,
		sleep_score: dailySleep?.score ?? null,
		average_breath: s.average_breath ?? null,
		restless_periods: s.restless_periods ?? null,
		time_in_bed: s.time_in_bed ?? null,
		type: s.type ?? null,
		contributors: dailySleep?.contributors ?? {},
	};
}

function readinessRecord(r: OuraReadiness): RecordData {
	return {
		id: r.id,
		day: r.day,
		score: r.score ?? null,
		temperature_deviation: r.temperature_deviation ?? null,
		temperature_trend_deviation: r.temperature_trend_deviation ?? null,
		contributors: r.contributors ?? {},
	};
}

function activityRecord(a: OuraActivity): RecordData {
	return {
		id: a.id,
		day: a.day,
		score: a.score ?? null,
		active_calories: a.active_calories ?? null,
		total_calories: a.total_calories ?? null,
		steps: a.steps ?? null,
		target_calories: a.target_calories ?? null,
		equivalent_walking_distance: a.equivalent_walking_distance ?? null,
		high_activity_time: a.high_activity_time ?? null,
		medium_activity_time: a.medium_activity_time ?? null,
		low_activity_time: a.low_activity_time ?? null,
		sedentary_time: a.sedentary_time ?? null,
		resting_time: a.resting_time ?? null,
		inactivity_alerts: a.inactivity_alerts ?? null,
		contributors: a.contributors ?? {},
	};
}

interface StreamConfig<T extends OuraRow> {
	endpoint: string;
	streamName: string;
	toRecord: (row: T) => RecordData;
}

interface RunStreamArgs<T extends OuraRow> {
	config: StreamConfig<T>;
	emit: CollectContext["emit"];
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	governor: OuraHttpGovernor;
	/** Page ceiling actually enforced by this walk. Injectable so a test can
	 *  reach the capped exit with a two-page fixture instead of 100 real pages. */
	maxPages: number;
	progress: (message: string, extra?: { stream?: string }) => Promise<void>;
	requested: Map<string, { time_range?: { since?: string } }>;
	state: Record<string, unknown>;
	token: string;
}

function sinceFor(
	state: Record<string, unknown>,
	requested: Map<string, { time_range?: { since?: string } }>,
	stream: string,
): string | null {
	const streamState = state[stream] as { last_day?: string } | undefined;
	const priorDay = streamState?.last_day;
	const scopeReq = requested.get(stream);
	const scopeSince = scopeReq?.time_range?.since?.slice(0, 10);
	return priorDay || scopeSince || null;
}

async function runStream<T extends OuraRow>(
	args: RunStreamArgs<T>,
): Promise<void> {
	const {
		config,
		token,
		state,
		requested,
		emit,
		emitRecord,
		progress,
		maxPages,
		governor,
	} = args;
	const { streamName, endpoint, toRecord } = config;
	await progress(`Fetching ${streamName}`, { stream: streamName });
	const startDate = sinceFor(state, requested, streamName);
	const { rows, truncated } = await fetchAll<T>(
		governor,
		endpoint,
		token,
		startDate,
		maxPages,
	);
	const streamState = state[streamName] as { last_day?: string } | undefined;
	const priorDay: string | null = streamState?.last_day || null;
	let lastDay: string | null = priorDay;
	for (const row of rows) {
		await emitRecord(streamName, toRecord(row));
		if (row.day && (!lastDay || row.day > lastDay)) {
			lastDay = row.day;
		}
	}

	if (truncated) {
		await emit({
			type: "SKIP_RESULT",
			stream: streamName,
			reason: "older_pages_deferred_page_budget",
			// The ceiling reported here is the one actually enforced, not the module
			// default — otherwise a lowered cap would disclose a limit the walk
			// never applied.
			message: `Oura ${streamName} stopped at the ${String(maxPages)}-page limit with more days still listed`,
			diagnostics: {
				page_limit: maxPages,
				total_seen: rows.length,
				unread_pages: 1,
			},
		});
	}

	await emit({
		type: "STATE",
		stream: streamName,
		// `last_day` is the next run's `start_date`. Advancing it after a capped
		// walk would skip past days this run never read, so a truncated walk holds
		// the day it started from and re-reads the same prefix next time.
		cursor: { last_day: truncated ? priorDay : lastDay },
	});
}

/**
 * `sleep` joins two v2 API resources by `day`: /usercollection/sleep (the
 * per-session document — bedtime, durations, average_breath,
 * restless_periods, time_in_bed, type) and /usercollection/daily_sleep (the
 * daily score + contributors aggregate). Oura can emit more than one sleep
 * session for a day (naps); every session for a day is joined against that
 * same day's single daily_sleep document. The daily_sleep walk shares the
 * sleep stream's own cursor/truncation state (`state.sleep`) rather than a
 * separate `state.daily_sleep`, since daily_sleep is sleep's supporting
 * fetch, not an independently-requestable stream.
 */
async function collectSleep(
	args: Omit<RunStreamArgs<OuraSleepSession>, "config">,
): Promise<void> {
	const {
		token,
		state,
		requested,
		emit,
		emitRecord,
		progress,
		maxPages,
		governor,
	} = args;
	const streamName = "sleep";
	await progress(`Fetching ${streamName}`, { stream: streamName });
	const startDate = sinceFor(state, requested, streamName);

	const [sessions, dailySleep] = await Promise.all([
		fetchAll<OuraSleepSession>(governor, "sleep", token, startDate, maxPages),
		fetchAll<OuraDailySleep>(
			governor,
			"daily_sleep",
			token,
			startDate,
			maxPages,
		),
	]);
	const truncated = sessions.truncated || dailySleep.truncated;
	const streamState = state[streamName] as { last_day?: string } | undefined;
	const priorDay: string | null = streamState?.last_day || null;
	if (truncated) {
		await emit({
			type: "SKIP_RESULT",
			stream: streamName,
			reason: "older_pages_deferred_page_budget",
			message: `Oura ${streamName} stopped at the ${String(maxPages)}-page limit with more days still listed`,
			diagnostics: {
				page_limit: maxPages,
				total_seen: sessions.rows.length,
				unread_pages: 1,
			},
		});
		await emit({
			type: "STATE",
			stream: streamName,
			cursor: { last_day: priorDay },
		});
		return;
	}

	const dailySleepByDay = new Map<string, OuraDailySleep>();
	for (const d of dailySleep.rows) {
		dailySleepByDay.set(d.day, d);
	}

	let lastDay: string | null = priorDay;
	for (const row of sessions.rows) {
		await emitRecord(
			streamName,
			sleepRecord(row, dailySleepByDay.get(row.day)),
		);
		if (row.day && (!lastDay || row.day > lastDay)) {
			lastDay = row.day;
		}
	}

	await emit({
		type: "STATE",
		stream: streamName,
		cursor: { last_day: lastDay },
	});
}

export interface OuraCollectOptions {
	/** @see OuraHttpGovernor */
	readonly httpGovernor?: OuraHttpGovernor;
	/** Page ceiling actually enforced by each stream's walk. Injectable so a
	 *  test can reach the capped exit with a two-page fixture. */
	readonly maxPages?: number;
}

export async function collectOura(
	ctx: CollectContext,
	options: OuraCollectOptions = {},
): Promise<void> {
	const { state, requested, credentials, emit, emitRecord, progress } = ctx;
	const maxPages = options.maxPages ?? MAX_PAGES;
	const governor = options.httpGovernor ?? httpGovernor;
	const token = credentials.OURA_PERSONAL_ACCESS_TOKEN;
	if (!token) {
		throw new Error("oura_auth_failed");
	}

	if (requested.has("sleep")) {
		await collectSleep({
			token,
			state,
			requested,
			emit,
			emitRecord,
			progress,
			maxPages,
			governor,
		});
	}

	if (requested.has("readiness")) {
		await runStream<OuraReadiness>({
			config: {
				streamName: "readiness",
				endpoint: "daily_readiness",
				toRecord: readinessRecord,
			},
			token,
			state,
			requested,
			emit,
			emitRecord,
			progress,
			maxPages,
			governor,
		});
	}

	if (requested.has("activity")) {
		await runStream<OuraActivity>({
			config: {
				streamName: "activity",
				endpoint: "daily_activity",
				toRecord: activityRecord,
			},
			token,
			state,
			requested,
			emit,
			emitRecord,
			progress,
			maxPages,
			governor,
		});
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "oura",
		validateRecord,
		retryablePattern: /rate_limited|ECONN|fetch failed/i,
		auth: { kind: "env", required: ["OURA_PERSONAL_ACCESS_TOKEN"] },
		collect: (ctx) => collectOura(ctx),
	});
}
