// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Oura's owner-app browser profile. The PAT profile remains `oura`. */

import { isMainModule } from "@pdpp/connector-protocol";
import type { APIResponse } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
  BrowserCollectContext,
  EnsureSessionArgs,
  RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";
import { ensureOuraApiAccess, type OuraApiAccess, probeOuraPortalSession, probeOuraSignInInProgress, readOuraCachedAccess } from "./api-access.ts";

const API = "https://api.ouraring.com/v2/usercollection";
// Include today in the initial 90-day snapshot.
const INITIAL_LOOKBACK_DAYS = 89;
const MUTABLE_OVERLAP_DAYS = 2;
const CHUNK_DAYS = 30;

interface DailySleep {
  contributors?: Record<string, unknown>;
  day: string;
  id: string;
  score?: number | null;
  timestamp?: string | null;
}

interface SleepSession {
  average_breath?: number | null;
  awake_time?: number | null;
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

interface DailyReadiness {
  contributors?: Record<string, unknown>;
  day: string;
  id: string;
  score?: number | null;
  timestamp?: string | null;
  temperature_deviation?: number | null;
  temperature_trend_deviation?: number | null;
}

interface DailyActivity {
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
  timestamp?: string | null;
  sedentary_time?: number | null;
  steps?: number | null;
  target_calories?: number | null;
  total_calories?: number | null;
}

interface OuraDailyData {
  daily_activities?: DailyActivity[];
  daily_readinesses?: DailyReadiness[];
  daily_sleeps?: DailySleep[];
  sleeps?: SleepSession[];
}

export async function probeOuraBrowserSession(page: BrowserCollectContext["page"]): Promise<boolean> {
  return (await probeOuraSignInInProgress(page)) || probeOuraPortalSession(page);
}

export async function ensureOuraSession(args: EnsureSessionArgs): Promise<void> {
  await ensureOuraApiAccess(args.page, async (url, message, ready) => {
    if (await args.page.evaluate(() => location.href).catch(() => "") !== url)
      await args.page.goto(url, { waitUntil: "domcontentloaded" });
    const ok = await manualBrowserLogin({
      assist: args.assist,
      capture: args.capture,
      completeAssistance: args.completeAssistance,
      isProbeSuccessful: (value) => value === true,
      message,
      page: args.page,
      probe: ready,
      readinessProbe: ready,
      readinessProbeOnHandoffPage: true,
      sendInteraction: args.sendInteraction,
      timeoutSeconds: 30 * 60,
    });
    if (!ok) throw new Error("oura_authorization_incomplete");
  });
}

interface CollectionResult<T> {
  rows: T[];
  complete: boolean;
}

async function fetchCollection<T extends { id: string; day: string }>(page: BrowserCollectContext["page"], token: string,
  endpoint: string, start: string, end: string): Promise<CollectionResult<T>> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let nextToken: string | null = null;
  for (let pages = 0; pages < 50; pages++) {
    const query = new URLSearchParams({ start_date: start, end_date: addDays(end, 1) });
    if (nextToken) query.set("next_token", nextToken);
    let response: APIResponse;
    try {
      response = await page.context().request.get(`${API}/${endpoint}?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 30_000,
      });
    } catch {
      return { rows, complete: false };
    }
    try {
      if (response.status() === 401 || response.status() === 403) return { rows, complete: false };
      if (!response.ok()) return { rows, complete: false };
      const value: unknown = await response.json().catch(() => null);
      if (!value || typeof value !== "object" || Array.isArray(value)) return { rows, complete: false };
      const payload = value as Record<string, unknown>;
      if (!Array.isArray(payload.data)) return { rows, complete: false };
      let invalidRow = false;
      for (const row of payload.data) {
        // A row without an identity or a calendar day cannot be placed in the
        // inventory, so its page cannot prove the inventory complete.
        if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.id !== "string" || !row.id || !isUtcDay(row.day)) {
          invalidRow = true;
          continue;
        }
        rows.push(row as T);
      }
      if (invalidRow) return { rows, complete: false };
      // A terminal next_token is Oura's only source evidence of a complete inventory.
      if (!("next_token" in payload)) return { rows, complete: false };
      if (payload.next_token === null) return { rows, complete: true };
      if (typeof payload.next_token !== "string" || !payload.next_token || seen.has(payload.next_token))
        return { rows, complete: false };
      nextToken = payload.next_token;
      seen.add(nextToken);
    } finally { await response.dispose().catch(() => {}); }
  }
  return { rows, complete: false };
}

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function requestedUtcDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString().slice(0, 10);
}

export function initialStartDate(now = new Date()): string {
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - INITIAL_LOOKBACK_DAYS);
  return start.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const result = day(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

interface OuraCursor {
  /** Key of the account whose inventory this cursor describes. */
  account?: string;
  api_v2?: true;
  next_day?: string;
  refresh_from?: string;
  requested_since?: string | null;
}

function isUtcDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    requestedUtcDay(value) === value;
}

async function fetchWindow(
  ctx: BrowserCollectContext, token: string, stream: string,
  startDate: string, endDate: string
): Promise<{ data: OuraDailyData; failedWindows: Array<{ start: string; end: string }> }> {
  const data: OuraDailyData = {};
  const failedWindows: Array<{ start: string; end: string }> = [];
  let start = day(startDate);
  const end = day(endDate);
  const endpoints = stream === "sleep" ? ["daily_sleep", "sleep"] :
    stream === "readiness" ? ["daily_readiness"] : ["daily_activity"];
  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const from = start.toISOString().slice(0, 10);
    const to = chunkEnd.toISOString().slice(0, 10);
    await ctx.progress(`Fetching ${stream}: ${from} to ${to}`, { stream });
    let complete = true;
    for (const endpoint of endpoints) {
      try {
        if (endpoint === "daily_sleep") {
          const result = await fetchCollection<DailySleep>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          data.daily_sleeps = [...(data.daily_sleeps ?? []), ...result.rows];
        } else if (endpoint === "sleep") {
          const result = await fetchCollection<SleepSession>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          data.sleeps = [...(data.sleeps ?? []), ...result.rows];
        } else if (endpoint === "daily_readiness") {
          const result = await fetchCollection<DailyReadiness>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          data.daily_readinesses = [...(data.daily_readinesses ?? []), ...result.rows];
        } else {
          const result = await fetchCollection<DailyActivity>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          data.daily_activities = [...(data.daily_activities ?? []), ...result.rows];
        }
      } catch (error) {
        complete = false;
        connectorDiagnostic("oura_browser", "collection_failed", { stream, endpoint, from, to,
          detail: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!complete) failedWindows.push({ start: from, end: to });
    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return { data, failedWindows };
}

// One record per id: Oura repeats chunk-boundary days; keep the copy with more filled fields, ties keep the first.
function oneRecordPerId(records: RecordData[]): RecordData[] {
  const byId = new Map<unknown, RecordData>();
  for (const record of records) {
    const known = byId.get(record.id);
    if (!known || filledFields(record) > filledFields(known)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

function filledFields(record: RecordData): number {
  return Object.values(record).filter((value) => value !== null && value !== undefined).length;
}

function sleepRecord(session: SleepSession, daily?: DailySleep): RecordData {
  return {
    record_type: "sleep_session",
    id: session.id,
    day: session.day,
    bedtime_start: session.bedtime_start ?? null,
    bedtime_end: session.bedtime_end ?? null,
    total_sleep_duration: session.total_sleep_duration ?? null,
    rem_sleep_duration: session.rem_sleep_duration ?? null,
    deep_sleep_duration: session.deep_sleep_duration ?? null,
    light_sleep_duration: session.light_sleep_duration ?? null,
    efficiency: session.efficiency ?? null,
    latency: session.latency ?? null,
    average_heart_rate: session.average_heart_rate ?? null,
    lowest_heart_rate: session.lowest_heart_rate ?? null,
    average_hrv: session.average_hrv ?? null,
    temperature_delta: session.temperature_delta ?? null,
    sleep_score: daily?.score ?? null,
    daily_sleep_id: daily?.id ?? null,
    daily_sleep_timestamp: daily?.timestamp ?? null,
    awake_time: session.awake_time ?? null,
    average_breath: session.average_breath ?? null,
    restless_periods: session.restless_periods ?? null,
    time_in_bed: session.time_in_bed ?? null,
    type: session.type ?? null,
    contributors: daily?.contributors ?? {},
  };
}

function dailyScoreRecord(daily: DailySleep): RecordData {
  return {
    record_type: "daily_score",
    id: daily.id,
    day: daily.day,
    bedtime_start: null,
    bedtime_end: null,
    total_sleep_duration: null,
    rem_sleep_duration: null,
    deep_sleep_duration: null,
    light_sleep_duration: null,
    efficiency: null,
    latency: null,
    average_heart_rate: null,
    lowest_heart_rate: null,
    average_hrv: null,
    temperature_delta: null,
    sleep_score: daily.score ?? null,
    daily_sleep_id: daily.id,
    daily_sleep_timestamp: daily.timestamp ?? null,
    awake_time: null,
    average_breath: null,
    restless_periods: null,
    time_in_bed: null,
    type: null,
    contributors: daily.contributors ?? {},
  };
}

function readinessRecord(row: DailyReadiness): RecordData {
  return {
    id: row.id,
    day: row.day,
    score: row.score ?? null,
    timestamp: row.timestamp ?? null,
    temperature_deviation: row.temperature_deviation ?? null,
    temperature_trend_deviation: row.temperature_trend_deviation ?? null,
    contributors: row.contributors ?? {},
  };
}

function activityRecord(row: DailyActivity): RecordData {
  return {
    id: row.id,
    day: row.day,
    score: row.score ?? null,
    timestamp: row.timestamp ?? null,
    active_calories: row.active_calories ?? null,
    total_calories: row.total_calories ?? null,
    steps: row.steps ?? null,
    target_calories: row.target_calories ?? null,
    equivalent_walking_distance: row.equivalent_walking_distance ?? null,
    high_activity_time: row.high_activity_time ?? null,
    medium_activity_time: row.medium_activity_time ?? null,
    low_activity_time: row.low_activity_time ?? null,
    sedentary_time: row.sedentary_time ?? null,
    resting_time: row.resting_time ?? null,
    inactivity_alerts: row.inactivity_alerts ?? null,
    contributors: row.contributors ?? {},
  };
}

/**
 * Oura sleep sessions carry no daily_sleep id, so a session can share a score
 * only by day. A day maps to its score only when it has exactly one distinct
 * score document. A day with more maps to null: no score belongs to its
 * sessions, and each score stays a daily_score record. Page order cannot
 * change the result.
 */
function dailyScoreByDay(scores: DailySleep[]): Map<string, DailySleep | null> {
  const byDay = new Map<string, DailySleep | null>();
  for (const score of scores) {
    const known = byDay.get(score.day);
    byDay.set(score.day, known === undefined || known?.id === score.id ? score : null);
  }
  return byDay;
}

export async function collectOuraBrowser(ctx: BrowserCollectContext, cachedAccess?: OuraApiAccess): Promise<void> {
  const access = cachedAccess ?? await readOuraCachedAccess(ctx.page);
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  for (const stream of ["sleep", "readiness", "activity"] as const) {
    if (!ctx.requested.has(stream)) continue;
    const stored = ctx.state[stream] as OuraCursor | undefined;
    // A cursor written for another account says nothing about this one.
    const previous = ctx.collectionMode === "full_refresh" || stored?.api_v2 !== true ||
      stored.account !== access.account ? undefined : stored;
    const requestedSince = requestedUtcDay(ctx.requested.get(stream)?.time_range?.since);
    const rawUntil = ctx.requested.get(stream)?.time_range?.until;
    const until = requestedUtcDay(rawUntil);
    const untilTimestamp = rawUntil ? Date.parse(rawUntil) : Number.NaN;
    const untilEnd = until
      ? (untilTimestamp % 86_400_000 === 0 ? addDays(until, -1) : until)
      : today;
    const endDate = untilEnd < today ? untilEnd : today;
    // An explicit range is collected as one inventory, even when it spans more
    // than 90 days. A partial range cannot advance STATE, so a fixed cap here
    // would replay the same prefix forever.
    const overlapStart = addDays(today, -MUTABLE_OVERLAP_DAYS);
    let startDate = requestedSince ?? previous?.next_day ?? initialStartDate(day(endDate));
    if (!requestedSince && previous) {
      if (overlapStart < startDate) startDate = overlapStart;
      if (isUtcDay(previous.refresh_from) && previous.refresh_from < startDate)
        startDate = previous.refresh_from;
    }
    if (startDate > endDate) {
      if (previous && previous.next_day && previous.next_day > endDate &&
        (!requestedSince || previous.requested_since === requestedSince))
        await ctx.emit({ type: "STATE", stream, cursor: previous });
      continue;
    }
    const result = await fetchWindow(ctx, access.accessToken, stream, startDate, endDate);
    const data = result.data;
    let records: RecordData[];
    if (stream === "sleep") {
      const scores = dailyScoreByDay(data.daily_sleeps ?? []);
      records = [
        ...(data.sleeps ?? []).map((row) => sleepRecord(row, scores.get(row.day) ?? undefined)),
        ...(data.daily_sleeps ?? []).map(dailyScoreRecord),
      ];
    } else if (stream === "readiness") {
      records = (data.daily_readinesses ?? []).map(readinessRecord);
    } else {
      records = (data.daily_activities ?? []).map(activityRecord);
    }
    for (const record of oneRecordPerId(records)) {
      const recordDay = record.day;
      if (typeof recordDay !== "string" || recordDay < startDate || recordDay > endDate) continue;
      await ctx.emitRecord(stream, record);
    }
    if (result.failedWindows.length > 0) {
      const message = `Oura ${stream} did not prove complete coverage of ${startDate} to ${endDate}.`;
      await ctx.emit({
        type: "SKIP_RESULT", stream, reason: "inventory_not_proven_complete",
        message,
        recovery_hint: { action: "retry_by_runtime", retryable: true },
      });
      // Desktop needs its runtime failure latch set before DONE; PageShim
      // derives Partial directly from the inventory skip above.
      if (ctx.browserSurface) await ctx.reportStreamFailure?.(stream, message, { retryable: true });
      continue;
    }
    await ctx.emit({
      type: "STATE", stream,
      cursor: {
        account: access.account,
        api_v2: true,
        next_day: addDays(endDate, 1),
        refresh_from: requestedSince ?? (overlapStart < startDate ? startDate : overlapStart),
        requested_since: requestedSince ?? null,
      },
    });
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "oura_browser",
    validateRecord,
    retryablePattern: /oura_api_(?:429|5\d\d)|fetch failed|network|timeout|aborted|inventory_not_proven_complete/i,
    browser: { profileName: "oura_browser" },
    ensureSession: ensureOuraSession,
    probeSession: ({ page }) => probeOuraBrowserSession(page),
    collect: collectOuraBrowser,
  });
}
