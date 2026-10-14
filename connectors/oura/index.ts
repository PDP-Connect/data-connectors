#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Oura Connector (v0.1.20)
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
	buildDetailGap,
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
	awake_time?: number | null;
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
	timestamp?: string | null;
}

interface OuraReadiness {
	contributors?: Record<string, unknown>;
	day: string;
	id: string;
	timestamp?: string | null;
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
	timestamp?: string | null;
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
		throw new Error(`oura_http_${String(raw.status)}`);
	}
	const parsed: unknown = JSON.parse(raw.body);
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		!Array.isArray((parsed as Partial<OuraListResponse<T>>).data) ||
		!("next_token" in parsed
			? (parsed as OuraListResponse<T>).next_token == null ||
				(typeof (parsed as OuraListResponse<T>).next_token === "string" &&
					(parsed as OuraListResponse<T>).next_token !== "")
			: true)
	) {
		throw new Error(`oura_invalid_envelope:${endpoint}`);
	}
	return parsed as OuraListResponse<T>;
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
	endDate: string,
): Promise<{
	rows: T[];
	truncated: boolean;
	pages: number;
	invalidRows: number;
	error: string | null;
	failure: Error | null;
}> {
	const all: T[] = [];
	let pages = 0;
	let invalidRows = 0;
	let nextToken: string | undefined;
	try {
		const walk = await walkPagesWithCeiling({
			maxPages,
			fetchPage: async () => {
				const params: OuraParams = {};
				if (startDate) {
					params.start_date = startDate;
				}
				params.end_date = endDate;
				if (nextToken) {
					params.next_token = nextToken;
				}
				const json = await oura<T>(governor, endpoint, token, params);
				pages += 1;
				for (const row of json.data) {
					if (row && typeof row === "object" && !Array.isArray(row))
						all.push(row);
					else invalidRows += 1;
				}
				nextToken = json.next_token || undefined;
				return Boolean(nextToken);
			},
		});
		return {
			rows: all,
			truncated: walk.truncated,
			pages,
			invalidRows,
			error: invalidRows ? "invalid_row" : null,
			failure: null,
		};
	} catch (cause) {
		const error =
			cause instanceof Error &&
			cause.message.startsWith("oura_invalid_envelope")
				? "invalid_envelope"
				: cause instanceof Error && cause.message === "oura_auth_failed"
					? "auth_failed"
					: "fetch_failed";
		return {
			rows: all,
			truncated: false,
			pages,
			invalidRows,
			error,
			failure: cause instanceof Error ? cause : new Error(String(cause)),
		};
	}
}

/**
 * Session records retain the matched daily score when available. Daily score
 * documents also emit independently, so a daily-only day is not lost.
 */
function sleepRecord(
	s: OuraSleepSession,
	dailySleep: OuraDailySleep | undefined,
): RecordData {
	return {
		record_type: "sleep_session",
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
		awake_time: s.awake_time ?? null,
		daily_sleep_id: dailySleep?.id ?? null,
		daily_sleep_timestamp: dailySleep?.timestamp ?? null,
		type: s.type ?? null,
		contributors: dailySleep?.contributors ?? {},
	};
}

function dailySleepRecord(d: OuraDailySleep): RecordData {
	return {
		record_type: "daily_score",
		id: d.id,
		day: d.day,
		daily_sleep_id: d.id,
		daily_sleep_timestamp: d.timestamp ?? null,
		sleep_score: d.score ?? null,
		contributors: d.contributors ?? {},
	};
}

function sourceRowKey(
	row: { id?: unknown; day?: unknown },
	fallback: string,
): string {
	if (typeof row.id === "string" && row.id) return row.id;
	if (typeof row.day === "string" && row.day) return row.day;
	return fallback;
}

function readinessRecord(r: OuraReadiness): RecordData {
	return {
		id: r.id,
		timestamp: r.timestamp ?? null,
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
		timestamp: a.timestamp ?? null,
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
	endDate: string;
	emit: CollectContext["emit"];
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	detailGaps?: CollectContext["detailGaps"];
	isRecordSelected?: CollectContext["isRecordSelected"];
	governor: OuraHttpGovernor;
	/** Page ceiling actually enforced by this walk. Injectable so a test can
	 *  reach the capped exit with a two-page fixture instead of 100 real pages. */
	maxPages: number;
	progress: (message: string, extra?: { stream?: string }) => Promise<void>;
	reportStreamFailure?: CollectContext["reportStreamFailure"];
	requested: Map<string, { time_range?: { since?: string } }>;
	state: Record<string, unknown>;
	token: string;
}

async function emitValidRecord(
	stream: string,
	data: RecordData,
	emit: CollectContext["emit"],
	emitRecord: RunStreamArgs<OuraRow>["emitRecord"],
	isRecordSelected?: CollectContext["isRecordSelected"],
): Promise<{ valid: boolean; emitted: boolean }> {
	const result = validateRecord(stream, data);
	if (!result.ok) {
		if (typeof data.id !== "string" || data.id.length === 0) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "invalid_record_shape",
				message: "Oura returned a record without a usable identity",
				recovery_hint: { action: "retry", retryable: true },
				diagnostics: { day: String(data.day) },
			});
		} else {
			await emit(
				buildDetailGap({
					stream,
					recordKey: data.id,
					reason: "temporary_unavailable",
					locator: { kind: "oura.invalid_record", day: String(data.day) },
					error: { class: "invalid_record_shape" },
				}),
			);
		}
		return { valid: false, emitted: false };
	}
	if (isRecordSelected && !isRecordSelected(stream, result.data))
		return { valid: true, emitted: false };
	await emitRecord(stream, result.data);
	return { valid: true, emitted: true };
}

async function recoverServedGaps(
	stream: string,
	detailGaps: CollectContext["detailGaps"] | undefined,
	recovered: ReadonlySet<string>,
	emit: CollectContext["emit"],
): Promise<void> {
	for (const gap of detailGaps ?? []) {
		if (gap.stream !== stream || gap.status !== "pending") continue;
		const kind = gap.detail_locator?.kind;
		const key = gap.record_key;
		if (
			typeof kind !== "string" ||
			(typeof key !== "string" && typeof key !== "number")
		)
			continue;
		if (!recovered.has(`${kind}:${String(key)}`)) continue;
		await emit({
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			gap_id: gap.gap_id,
			stream,
			record_key: key,
		});
	}
}

function sinceFor(
	state: Record<string, unknown>,
	requested: Map<string, { time_range?: { since?: string; until?: string } }>,
	stream: string,
): string | null {
	const streamState = state[stream] as { last_day?: string } | undefined;
	const priorDay = streamState?.last_day;
	const scopeReq = requested.get(stream);
	const rawScopeSince = scopeReq?.time_range?.since;
	const scopeSince =
		rawScopeSince && !Number.isNaN(Date.parse(rawScopeSince))
			? rawScopeSince.slice(0, 10)
			: undefined;
	const rawUntil = scopeReq?.time_range?.until;
	if (
		priorDay &&
		rawUntil &&
		!Number.isNaN(Date.parse(rawUntil)) &&
		priorDay > rawUntil.slice(0, 10)
	) {
		return scopeSince ?? null;
	}
	if (priorDay && scopeSince)
		return priorDay < scopeSince ? priorDay : scopeSince;
	return priorDay || scopeSince || null;
}

function endFor(
	requested: Map<string, { time_range?: { until?: string } }>,
	stream: string,
	runDay: string,
): string {
	const rawUntil = requested.get(stream)?.time_range?.until;
	if (!rawUntil || Number.isNaN(Date.parse(rawUntil))) return runDay;
	const requestedDay = rawUntil.slice(0, 10);
	return requestedDay < runDay ? requestedDay : runDay;
}

async function runStream<T extends OuraRow>(
	args: RunStreamArgs<T>,
): Promise<void> {
	const {
		config,
		endDate,
		token,
		state,
		requested,
		emit,
		emitRecord,
		detailGaps,
		isRecordSelected,
		progress,
		maxPages,
		governor,
		reportStreamFailure,
	} = args;
	const { streamName, endpoint, toRecord } = config;
	await progress(`Fetching ${streamName}`, { stream: streamName });
	const startDate = sinceFor(state, requested, streamName);
	const { rows, truncated, pages, invalidRows, error, failure } =
		await fetchAll<T>(governor, endpoint, token, startDate, maxPages, endDate);
	const streamState = state[streamName] as { last_day?: string } | undefined;
	const priorDay: string | null = streamState?.last_day || null;
	let lastDay: string | null = priorDay;
	let invalid = 0;
	let emitted = 0;
	const recovered = new Set<string>();
	for (const row of rows) {
		const outcome = await emitValidRecord(
			streamName,
			toRecord(row),
			emit,
			emitRecord,
			isRecordSelected,
		);
		if (!outcome.valid) invalid += 1;
		if (outcome.emitted) emitted += 1;
		if (outcome.emitted)
			recovered.add(`oura.invalid_record:${sourceRowKey(row, "")}`);
		if (row.day && (!lastDay || row.day > lastDay)) {
			lastDay = row.day;
		}
	}
	await recoverServedGaps(streamName, detailGaps, recovered, emit);

	if (truncated || error) {
		await emit({
			type: "SKIP_RESULT",
			stream: streamName,
			reason: error ?? "older_pages_deferred_page_budget",
			recovery_hint: {
				action: error ? "retry" : "retry_on_connector_upgrade",
				retryable: Boolean(error),
			},
			// The ceiling reported here is the one actually enforced, not the module
			// default — otherwise a lowered cap would disclose a limit the walk
			// never applied.
			message: error
				? `Oura ${streamName} stopped after ${String(pages)} pages: ${error}`
				: `Oura ${streamName} stopped at the ${String(maxPages)}-page limit with more days still listed`,
			diagnostics: {
				page_limit: maxPages,
				pages,
				total_seen: rows.length,
				invalid_rows: invalidRows,
				unread_pages: truncated ? 1 : null,
				start_date: startDate,
				terminal: false,
			},
		});
	}
	await emit({
		type: "STATE",
		stream: streamName,
		// `last_day` is the next run's `start_date`. Advancing it after a capped
		// walk would skip past days this run never read, so a truncated walk holds
		// the day it started from and re-reads the same prefix next time.
		cursor: {
			last_day: truncated || error || invalid ? priorDay : lastDay,
			coverage: {
				start_date: startDate,
				end_date: endDate,
				resources: {
					[endpoint]: {
						pages,
						fetched: rows.length + invalidRows,
						terminal: !truncated && !error,
					},
				},
				emitted,
				gaps: invalid + invalidRows + (truncated || error ? 1 : 0),
			},
		},
	});
	if (failure) {
		if (!reportStreamFailure) throw failure;
		await reportStreamFailure(streamName, failure.message, {
			retryable: /rate_limited|oura_http_5|ECONN|fetch failed/i.test(
				failure.message,
			),
		});
	}
}

/**
 * `sleep` joins two v2 API resources by `day`: /usercollection/sleep (the
 * per-session document — bedtime, durations, average_breath,
 * restless_periods, time_in_bed, type) and /usercollection/daily_sleep (the
 * daily score + contributors aggregate). Oura can emit more than one sleep
 * session for a day (naps); every session for a day is joined against that
 * same day's daily_sleep document when the day has one. The daily_sleep walk shares the
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
		detailGaps,
		isRecordSelected,
		progress,
		maxPages,
		endDate,
		governor,
		reportStreamFailure,
	} = args;
	const streamName = "sleep";
	await progress(`Fetching ${streamName}`, { stream: streamName });
	const startDate = sinceFor(state, requested, streamName);

	const [sessions, dailySleep] = await Promise.all([
		fetchAll<OuraSleepSession>(
			governor,
			"sleep",
			token,
			startDate,
			maxPages,
			endDate,
		),
		fetchAll<OuraDailySleep>(
			governor,
			"daily_sleep",
			token,
			startDate,
			maxPages,
			endDate,
		),
	]);
	const truncated = sessions.truncated || dailySleep.truncated;
	const sourceError = sessions.error || dailySleep.error;
	const streamState = state[streamName] as { last_day?: string } | undefined;
	const priorDay: string | null = streamState?.last_day || null;
	if (truncated || sourceError) {
		await emit({
			type: "SKIP_RESULT",
			stream: streamName,
			reason: sourceError ?? "older_pages_deferred_page_budget",
			recovery_hint: {
				action: sourceError ? "retry" : "retry_on_connector_upgrade",
				retryable: Boolean(sourceError),
			},
			message: sourceError
				? `Oura ${streamName} source stopped: ${sourceError}`
				: `Oura ${streamName} stopped at the ${String(maxPages)}-page limit with more days still listed`,
			diagnostics: {
				page_limit: maxPages,
				total_seen: sessions.rows.length + dailySleep.rows.length,
				sleep_pages: sessions.pages,
				daily_sleep_pages: dailySleep.pages,
				sleep_rows: sessions.rows.length,
				daily_sleep_rows: dailySleep.rows.length,
				sleep_invalid_rows: sessions.invalidRows,
				daily_sleep_invalid_rows: dailySleep.invalidRows,
				sleep_terminal: !sessions.truncated && !sessions.error,
				daily_sleep_terminal: !dailySleep.truncated && !dailySleep.error,
				sleep_error: sessions.error,
				daily_sleep_error: dailySleep.error,
				start_date: startDate,
				unread_pages: truncated ? 1 : null,
			},
		});
	}

	const dailySleepByDay = new Map<string, OuraDailySleep>();
	const duplicateDailyDays = new Set<string>();
	const validDailyDayCounts = new Map<string, number>();
	let joinGaps = 0;
	for (const d of dailySleep.rows) {
		// An invalid daily score cannot supply fields to a healthy session.
		// Its own emission below reports the invalid row as a detail gap.
		if (!validateRecord(streamName, dailySleepRecord(d)).ok) continue;
		validDailyDayCounts.set(d.day, (validDailyDayCounts.get(d.day) ?? 0) + 1);
		if (dailySleepByDay.has(d.day) || duplicateDailyDays.has(d.day)) {
			dailySleepByDay.delete(d.day);
			duplicateDailyDays.add(d.day);
			if (
				isRecordSelected &&
				!isRecordSelected(streamName, dailySleepRecord(d))
			)
				continue;
			joinGaps += 1;
			await emit(
				buildDetailGap({
					stream: streamName,
					recordKey: d.day,
					reason: "temporary_unavailable",
					locator: { kind: "oura.daily_sleep_duplicate", day: d.day },
				}),
			);
			continue;
		}
		dailySleepByDay.set(d.day, d);
	}

	let lastDay: string | null = priorDay;
	let invalid = 0;
	let emitted = 0;
	const recovered = new Set<string>();
	const validSessionDays = new Set<string>();
	for (const [rowIndex, row] of sessions.rows.entries()) {
		const record = sleepRecord(row, dailySleepByDay.get(row.day));
		const selected = isRecordSelected?.(streamName, record) ?? true;
		if (
			selected &&
			typeof row.id === "string" &&
			row.id &&
			!dailySleepByDay.has(row.day)
		) {
			joinGaps += 1;
			await emit(
				buildDetailGap({
					stream: streamName,
					recordKey: sourceRowKey(row, `sleep-row-${String(rowIndex)}`),
					reason: "temporary_unavailable",
					locator: {
						kind: duplicateDailyDays.has(row.day)
							? "oura.daily_sleep_ambiguous"
							: "oura.daily_sleep_missing",
						day: row.day,
					},
				}),
			);
		}
		const outcome = await emitValidRecord(
			streamName,
			record,
			emit,
			emitRecord,
			isRecordSelected,
		);
		if (!outcome.valid) invalid += 1;
		if (outcome.emitted) emitted += 1;
		if (outcome.emitted) {
			validSessionDays.add(row.day);
			recovered.add(`oura.invalid_record:${sourceRowKey(row, "")}`);
			if (dailySleepByDay.has(row.day))
				recovered.add(`oura.daily_sleep_missing:${row.id}`);
			if (dailySleepByDay.has(row.day))
				recovered.add(`oura.daily_sleep_ambiguous:${row.id}`);
		}
		if (row.day && (!lastDay || row.day > lastDay)) {
			lastDay = row.day;
		}
	}
	for (const [rowIndex, row] of dailySleep.rows.entries()) {
		const record = dailySleepRecord(row);
		const selected = isRecordSelected?.(streamName, record) ?? true;
		if (
			selected &&
			typeof row.id === "string" &&
			row.id &&
			!validSessionDays.has(row.day)
		) {
			joinGaps += 1;
			await emit(
				buildDetailGap({
					stream: streamName,
					recordKey: sourceRowKey(row, `daily-sleep-row-${String(rowIndex)}`),
					reason: "temporary_unavailable",
					locator: { kind: "oura.sleep_session_missing", day: row.day },
				}),
			);
		}
		const outcome = await emitValidRecord(
			streamName,
			record,
			emit,
			emitRecord,
			isRecordSelected,
		);
		if (!outcome.valid) invalid += 1;
		if (outcome.emitted) emitted += 1;
		if (outcome.emitted) {
			recovered.add(`oura.invalid_record:${sourceRowKey(row, "")}`);
			if (validSessionDays.has(row.day))
				recovered.add(`oura.sleep_session_missing:${row.id}`);
			if (
				!dailySleep.truncated &&
				!dailySleep.error &&
				validDailyDayCounts.get(row.day) === 1
			)
				recovered.add(`oura.daily_sleep_duplicate:${row.day}`);
		}
		if (row.day && (!lastDay || row.day > lastDay)) lastDay = row.day;
	}
	await recoverServedGaps(streamName, detailGaps, recovered, emit);
	await emit({
		type: "STATE",
		stream: streamName,
		cursor: {
			last_day:
				truncated || sourceError || joinGaps || invalid ? priorDay : lastDay,
			coverage: {
				start_date: startDate,
				end_date: endDate,
				resources: {
					sleep: {
						pages: sessions.pages,
						fetched: sessions.rows.length + sessions.invalidRows,
						terminal: !sessions.truncated && !sessions.error,
					},
					daily_sleep: {
						pages: dailySleep.pages,
						fetched: dailySleep.rows.length + dailySleep.invalidRows,
						terminal: !dailySleep.truncated && !dailySleep.error,
					},
				},
				emitted,
				gaps:
					joinGaps +
					invalid +
					sessions.invalidRows +
					dailySleep.invalidRows +
					(sessions.truncated || sessions.error ? 1 : 0) +
					(dailySleep.truncated || dailySleep.error ? 1 : 0),
			},
		},
	});
	for (const failure of [sessions.failure, dailySleep.failure]) {
		if (!failure) continue;
		if (!reportStreamFailure) throw failure;
		await reportStreamFailure(streamName, failure.message, {
			retryable: /rate_limited|oura_http_5|ECONN|fetch failed/i.test(
				failure.message,
			),
		});
	}
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
	const {
		state,
		requested,
		credentials,
		emit,
		emitRecord,
		detailGaps,
		isRecordSelected,
		progress,
		reportStreamFailure,
	} = ctx;
	const runDay = ctx.emittedAt.slice(0, 10);
	const maxPages = options.maxPages ?? MAX_PAGES;
	const governor = options.httpGovernor ?? httpGovernor;
	const token = credentials.OURA_PERSONAL_ACCESS_TOKEN;
	if (!token) {
		throw new Error("oura_auth_failed");
	}

	if (requested.has("sleep")) {
		await collectSleep({
			endDate: endFor(requested, "sleep", runDay),
			token,
			state,
			requested,
			emit,
			emitRecord,
			detailGaps,
			isRecordSelected,
			progress,
			reportStreamFailure,
			maxPages,
			governor,
		});
	}

	if (requested.has("readiness")) {
		await runStream<OuraReadiness>({
			endDate: endFor(requested, "readiness", runDay),
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
			detailGaps,
			isRecordSelected,
			progress,
			reportStreamFailure,
			maxPages,
			governor,
		});
	}

	if (requested.has("activity")) {
		await runStream<OuraActivity>({
			endDate: endFor(requested, "activity", runDay),
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
			detailGaps,
			isRecordSelected,
			progress,
			reportStreamFailure,
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
