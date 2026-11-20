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
const WINDOW_DAYS = 90;
const FIRST_OURA_DAY = "2015-01-01";

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
 * Page one bounded date window. Tokens never leave this window or survive
 * a run; a partial window is replayed inclusively on the next run.
 */
async function fetchAll<T>(
	governor: OuraHttpGovernor,
	endpoint: string,
	token: string,
	startDate: string,
	endDate: string,
	maxPages: number,
): Promise<{ rows: T[]; truncated: boolean; pages: number }> {
	const all: T[] = [];
	let pages = 0;
	let nextToken: string | undefined;
	const walk = await walkPagesWithCeiling({
		maxPages,
		fetchPage: async () => {
			const params: OuraParams = { start_date: startDate, end_date: endDate };
			pages += 1;
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
	return { rows: all, truncated: walk.truncated, pages };
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
	fullRefresh: boolean;
	governor: OuraHttpGovernor;
	/** The same per-resource ceiling applies across all windows in this run. */
	maxPages: number;
	progress: (message: string, extra?: { stream?: string }) => Promise<void>;
	requested: CollectContext["requested"];
	state: Record<string, unknown>;
	today: string;
	token: string;
}

interface OuraScope {
	since: string | null;
	until: string | null;
	resources: string[] | null;
}

function normalizeScope(scope: {
	since?: string | null;
	until?: string | null;
	resources?: unknown;
} | undefined): OuraScope {
	return {
		since: scope?.since ?? null,
		until: scope?.until ?? null,
		resources: Array.isArray(scope?.resources)
			? [...new Set(scope.resources.filter((value): value is string => typeof value === "string"))].sort()
			: null,
	};
}

function sameScope(left: OuraScope, right: OuraScope): boolean {
	return left.since === right.since && left.until === right.until
		&& (left.resources === null || right.resources === null
			? left.resources === right.resources
			: left.resources.length === right.resources.length
				&& left.resources.every((resource, index) => resource === right.resources?.[index]));
}

interface OuraCursor {
	/** Inclusive start date, including for legacy STATE with no other fields. */
	last_day?: string | null;
	scope?: OuraScope;
	frontier?: {
		start_date: string;
		newest_day: string | null;
		/** Shrinks incomplete windows; absent in older STATE. Never a page token. */
		window_days?: number;
	} | null;
}

function day(value: string | null | undefined): string | null {
	return value && !Number.isNaN(Date.parse(value))
		? new Date(Date.parse(value)).toISOString().slice(0, 10)
		: null;
}

function addDays(value: string, count: number): string {
	const date = new Date(value);
	date.setUTCDate(date.getUTCDate() + count);
	return date.toISOString().slice(0, 10);
}

type WindowRecord = { id: string; day: string; data: RecordData };

async function runWindows(
	args: Omit<RunStreamArgs<OuraRow>, "config"> & {
		streamName: string;
		endpoints: string[];
		requireCompleteWindow: boolean;
		toRecords: (rows: OuraRow[][]) => WindowRecord[];
	},
): Promise<void> {
	const {
		streamName, endpoints, requireCompleteWindow, toRecords,
		token, state, requested, emit, emitRecord, progress, maxPages,
		governor, fullRefresh, today,
	} = args;
	await progress(`Fetching ${streamName}`, { stream: streamName });
	const request = requested.get(streamName) as {
		time_range?: { since?: string; until?: string };
		resources?: unknown;
	} | undefined;
	const scope = normalizeScope({
		since: request?.time_range?.since ?? null,
		until: request?.time_range?.until ?? null,
		resources: request?.resources ?? null,
	});
	const saved = state[streamName] as OuraCursor | undefined;
	const legacy = !saved?.scope && !saved?.frontier;
	const useSaved = !fullRefresh
		&& (legacy || sameScope(normalizeScope(saved?.scope), scope));
	let startDate = (useSaved
		? day(saved?.frontier?.start_date) ?? day(saved?.last_day)
		: null) ?? day(scope.since) ?? FIRST_OURA_DAY;
	let newestDay = useSaved
		? (saved?.frontier ? day(saved.frontier.newest_day) : day(saved?.last_day))
		: null;
	const savedWindowDays = useSaved ? saved?.frontier?.window_days : undefined;
	let windowDays = typeof savedWindowDays === "number"
		&& Number.isInteger(savedWindowDays) && savedWindowDays > 0
		? Math.min(savedWindowDays, WINDOW_DAYS) : WINDOW_DAYS;
	const tomorrow = addDays(today, 1);
	const until = day(scope.until);
	const endDate = until && until < tomorrow ? until : tomorrow;
	const remaining = endpoints.map(() => maxPages);
	const emitted = new Set<string>();
	let totalSeen = 0;
	let complete = startDate > endDate;
	let singleDayOverflow = false;

	while (!complete && remaining.every((pages) => pages > 0)) {
		// Oura date bounds are inclusive. Keep the established overlap between
		// larger windows, but a one-day fallback must request exactly one day.
		const boundary = windowDays === 1 ? startDate : addDays(startDate, windowDays);
		const windowEnd = boundary < endDate ? boundary : endDate;
		const results = await Promise.all(endpoints.map((endpoint, index) =>
			fetchAll<OuraRow>(
				governor, endpoint, token, startDate, windowEnd, remaining[index] ?? 0,
			),
		));
		for (let index = 0; index < results.length; index += 1) {
			remaining[index] = (remaining[index] ?? 0) - (results[index]?.pages ?? 0);
		}
		totalSeen += results[0]?.rows.length ?? 0;
		const truncated = results.some((result) => result.truncated);
		// Sleep must not turn a missing (not yet read) daily score into a
		// nullable record. Both resources must finish this exact date window.
		if (!requireCompleteWindow || !truncated) {
			for (const record of toRecords(results.map((result) => result.rows))) {
				if (!emitted.has(record.id)) {
					await emitRecord(streamName, record.data);
					emitted.add(record.id);
				}
				if (!newestDay || record.day > newestDay) {
					newestDay = record.day;
				}
			}
		}
		if (truncated) {
			// Tokens have no established cross-run lifetime. Split the date
			// window instead of replaying an unfinishable prefix forever.
			singleDayOverflow = startDate === windowEnd
				&& results.some((result) => result.truncated && result.pages === maxPages);
			windowDays = startDate === windowEnd ? 1 : Math.max(1, Math.floor(windowDays / 2));
			break;
		}
		// An unordered page gives no safe date frontier. Only an exhausted
		// window does. Retain overlap, except after an exhausted single day.
		complete = windowEnd >= endDate;
		startDate = windowEnd === startDate ? addDays(windowEnd, 1) : windowEnd;
		windowDays = WINDOW_DAYS;
	}

	if (!complete) {
		await emit({
			type: "SKIP_RESULT",
			stream: streamName,
			reason: "older_pages_deferred_page_budget",
			recovery_hint: singleDayOverflow
				? { action: "retry_on_connector_upgrade", retryable: false }
				: { action: "retry_by_runtime", retryable: true },
			message: singleDayOverflow
				? `Oura ${streamName} exceeded the ${String(maxPages)}-page limit within one day; no safe cross-run page token is available`
				: `Oura ${streamName} stopped at the ${String(maxPages)}-page limit with more days still listed`,
			diagnostics: {
				page_limit: maxPages,
				total_seen: totalSeen,
				unread_pages: 1,
			},
		});
	}
	await emit({
		type: "STATE",
		stream: streamName,
		cursor: {
			last_day: complete ? newestDay : startDate,
			scope,
			frontier: complete ? null : {
				start_date: startDate,
				newest_day: newestDay,
				window_days: windowDays,
			},
		},
	});
}

async function runStream<T extends OuraRow>(
	args: RunStreamArgs<T>,
): Promise<void> {
	const { config, ...common } = args;
	await runWindows({
		...common,
		streamName: config.streamName,
		endpoints: [config.endpoint],
		requireCompleteWindow: false,
		toRecords: (rows) => (rows[0] ?? []).map((row) => ({
			id: row.id,
			day: row.day,
			data: config.toRecord(row as T),
		})),
	});
}

/** Join session and daily score only after both resources finish a window. */
async function collectSleep(
	args: Omit<RunStreamArgs<OuraSleepSession>, "config">,
): Promise<void> {
	await runWindows({
		...args,
		streamName: "sleep",
		endpoints: ["sleep", "daily_sleep"],
		requireCompleteWindow: true,
		toRecords: (rows) => {
			const dailySleepByDay = new Map<string, OuraDailySleep>();
			for (const row of (rows[1] ?? []) as OuraDailySleep[]) {
				dailySleepByDay.set(row.day, row);
			}
			return ((rows[0] ?? []) as OuraSleepSession[]).map((row) => ({
				id: row.id,
				day: row.day,
				data: sleepRecord(row, dailySleepByDay.get(row.day)),
			}));
		},
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
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const today = day(ctx.emittedAt) ?? new Date().toISOString().slice(0, 10);
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
			fullRefresh,
			today,
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
			fullRefresh,
			today,
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
			fullRefresh,
			today,
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
