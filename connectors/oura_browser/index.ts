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
// Oura's first ring shipped in 2015; the API has no account-created date, and days before the account return no rows.
const INITIAL_START_DATE = "2015-01-01";
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

interface OuraWindowResume {
  start: string;
  end: string;
  nextToken: string;
  lastIds: string[];
}

interface CollectionResult<T> {
  rows: T[];
  complete: boolean;
  sourcePressure?: "rate_limited" | "timeout";
  resume?: OuraWindowResume | undefined;
}

// Bound one stalled transport request, not the number of history pages.
const OURA_REQUEST_TIMEOUT_MS = 30_000;
// Bound consecutive continuation pages that add no IDs; this is not a history cap.
const NO_PROGRESS_PAGE_GUARD = 16;

async function fetchCollection<T extends { id: string; day: string }>(page: BrowserCollectContext["page"], token: string,
  endpoint: string, start: string, end: string, resume?: OuraWindowResume): Promise<CollectionResult<T>> {
  const rows: T[] = [];
  let nextToken = resume?.nextToken ?? null;
  const seenTokens = new Set<string>(nextToken ? [nextToken] : []);
  const seenIds = new Set<string>(resume?.lastIds ?? []);
  const overlapDay = addDays(end, 1);
  let checkingResume = resume !== undefined;
  let checkpoint = resume;
  let noProgressPages = 0;
  const restart = () => {
    checkingResume = false;
    checkpoint = undefined;
    nextToken = null;
    seenTokens.clear();
    seenIds.clear();
    noProgressPages = 0;
  };
  while (true) {
    const query = new URLSearchParams({ start_date: start, end_date: addDays(end, 1) });
    if (nextToken) query.set("next_token", nextToken);
    let response: APIResponse;
    try {
      response = await page.context().request.get(`${API}/${endpoint}?${query}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: OURA_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "TimeoutError" || /timeout|timed out/i.test(error.message));
      return timeout ? { rows, complete: false, sourcePressure: "timeout", resume: checkpoint } : { rows, complete: false };
    }
    try {
      if (response.status() === 429) return { rows, complete: false, sourcePressure: "rate_limited", resume: checkpoint };
      if (checkingResume && [400, 404, 410].includes(response.status())) {
        restart();
        continue;
      }
      if (response.status() === 401 || response.status() === 403) return { rows, complete: false };
      if (!response.ok()) return { rows, complete: false };
      const value: unknown = await response.json().catch(() => null);
      if (!value || typeof value !== "object" || Array.isArray(value)) return { rows, complete: false };
      const payload = value as Record<string, unknown>;
      if (!Array.isArray(payload.data)) return { rows, complete: false };
      const pageRows: T[] = [];
      const pageIds = new Set<string>();
      const overlapRows: T[] = [];
      let invalidRow = false;
      const previousSize = seenIds.size;
      let hasInWindowRow = false;
      for (const row of payload.data) {
        // A row without an identity or a calendar day cannot be placed in the
        // inventory, so its page cannot prove the inventory complete.
        if (!row || typeof row !== "object" || Array.isArray(row) ||
          typeof row.id !== "string" || !row.id || !isUtcDay(row.day)) {
          invalidRow = true;
          continue;
        }
        if (row.day < start || row.day > end) {
          // The API may include the extra boundary day requested for the next
          // chunk; retain it for dedupe/enrichment, never for inventory proof.
          if (row.day === overlapDay) overlapRows.push(row as T);
          continue;
        }
        hasInWindowRow = true;
        pageRows.push(row as T);
        pageIds.add(row.id);
      }
      if (checkingResume) {
        const overlap = [...pageIds].filter((id) => seenIds.has(id)).length;
        const exactReplay = overlap === seenIds.size && overlap === pageIds.size;
        if (invalidRow || (overlap > 0 && (!exactReplay || payload.next_token === null))) {
          restart();
          continue;
        }
        checkingResume = false;
      }
      rows.push(...pageRows, ...overlapRows);
      for (const id of pageIds) seenIds.add(id);
      // A page with rows but none inside this chunk cannot witness the chunk.
      if (invalidRow || (payload.data.length > 0 && !hasInWindowRow)) return { rows, complete: false };
      // A terminal next_token is Oura's only source evidence of a complete inventory.
      if (!("next_token" in payload)) return { rows, complete: false };
      // A last page that only repeats seen rows proves nothing about the end.
      if (payload.next_token === null && payload.data.length > 0 && seenIds.size === previousSize)
        return { rows, complete: false };
      if (payload.next_token === null) return { rows, complete: true };
      if (typeof payload.next_token !== "string" || !payload.next_token || seenTokens.has(payload.next_token))
        return { rows, complete: false };
      noProgressPages = seenIds.size === previousSize ? noProgressPages + 1 : 0;
      if (noProgressPages > NO_PROGRESS_PAGE_GUARD) return { rows, complete: false };
      nextToken = payload.next_token;
      seenTokens.add(nextToken);
      if (pageIds.size > 0) checkpoint = { start, end, nextToken, lastIds: [...pageIds].sort() };
    } finally { await response.dispose().catch(() => {}); }
  }
}

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function requestedUtcDay(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString().slice(0, 10);
}

export function initialStartDate(_now = new Date()): string {
  // Keep the caller's optional date argument compatible; first runs always
  // walk the complete supported history rather than a moving lookback.
  return INITIAL_START_DATE;
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
  resume?: OuraWindowResume | undefined;
}

function isUtcDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    requestedUtcDay(value) === value;
}

async function fetchWindow(
  ctx: BrowserCollectContext, token: string, stream: string,
  startDate: string, endDate: string, resume?: OuraWindowResume
): Promise<{
  data: OuraDailyData;
  failedWindows: Array<{ start: string; end: string }>;
  sourcePressure?: CollectionResult<never>["sourcePressure"] | undefined;
  resume?: OuraWindowResume | undefined;
}> {
  const data: OuraDailyData = {};
  const failedWindows: Array<{ start: string; end: string }> = [];
  let sourcePressure: CollectionResult<never>["sourcePressure"];
  let continuation: OuraWindowResume | undefined;
  let start = day(resume?.start ?? startDate);
  const end = day(endDate);
  const endpoints = stream === "sleep" ? ["daily_sleep", "sleep"] :
    stream === "readiness" ? ["daily_readiness"] : ["daily_activity"];
  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const from = start.toISOString().slice(0, 10);
    const saved = resume?.start === from ? resume : undefined;
    if (saved) chunkEnd.setTime(day(saved.end).getTime());
    const to = chunkEnd.toISOString().slice(0, 10);
    await ctx.progress(`Fetching ${stream}: ${from} to ${to}`, { stream });
    let complete = true;
    for (const endpoint of endpoints) {
      try {
        if (endpoint === "daily_sleep") {
          const result = await fetchCollection<DailySleep>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          sourcePressure ??= result.sourcePressure;
          data.daily_sleeps = [...(data.daily_sleeps ?? []), ...result.rows];
        } else if (endpoint === "sleep") {
          const result = await fetchCollection<SleepSession>(ctx.page, token, endpoint, from, to);
          complete &&= result.complete;
          sourcePressure ??= result.sourcePressure;
          data.sleeps = [...(data.sleeps ?? []), ...result.rows];
        } else if (endpoint === "daily_readiness") {
          const result = await fetchCollection<DailyReadiness>(ctx.page, token, endpoint, from, to, saved);
          complete &&= result.complete;
          sourcePressure ??= result.sourcePressure;
          if (failedWindows.length === 0) continuation = result.resume;
          data.daily_readinesses = [...(data.daily_readinesses ?? []), ...result.rows];
        } else {
          const result = await fetchCollection<DailyActivity>(ctx.page, token, endpoint, from, to, saved);
          complete &&= result.complete;
          sourcePressure ??= result.sourcePressure;
          if (failedWindows.length === 0) continuation = result.resume;
          data.daily_activities = [...(data.daily_activities ?? []), ...result.rows];
        }
      } catch (error) {
        complete = false;
        connectorDiagnostic("oura_browser", "collection_failed", { stream, endpoint, from, to,
          detail: error instanceof Error ? error.message : String(error) });
      }
      if (sourcePressure) break;
    }
    if (!complete) failedWindows.push({ start: from, end: to });
    if (sourcePressure) break;
    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return { data, failedWindows, sourcePressure, resume: continuation };
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
    const requestedSince = requestedUtcDay(ctx.requested.get(stream)?.time_range?.since);
    // A cursor from another account or a narrower lower bound cannot prove this range.
    const priorSince = stored?.requested_since;
    const widened = isUtcDay(priorSince) && (!requestedSince || requestedSince < priorSince);
    const previous = ctx.collectionMode === "full_refresh" || stored?.api_v2 !== true ||
      stored.account !== access.account || widened ? undefined : stored;
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
    // Sleep joins two inventories by day. A page-only checkpoint would lose
    // the prior score rows needed to recreate that join, so sleep still replays.
    const saved = stream === "sleep" || (previous?.requested_since ?? undefined) !== requestedSince
      ? undefined : previous?.resume;
    const resume = saved && isUtcDay(saved.start) && isUtcDay(saved.end) &&
      startDate <= saved.start && saved.start <= saved.end && saved.end <= endDate &&
      typeof saved.nextToken === "string" && saved.nextToken.length > 0 &&
      Array.isArray(saved.lastIds) && saved.lastIds.length > 0 &&
      saved.lastIds.every((id) => typeof id === "string" && id.length > 0) ? saved : undefined;
    const result = await fetchWindow(ctx, access.accessToken, stream, startDate, endDate, resume);
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
      const message = result.sourcePressure
        ? `Oura ${stream} stopped under source pressure; the next run will retry the unconfirmed range.`
        : `Oura ${stream} did not prove complete coverage of ${startDate} to ${endDate}.`;
      if (result.sourcePressure) {
        await ctx.emit({
          type: "SKIP_RESULT", stream, reason: "upstream_pressure", message,
          recovery_hint: { action: "retry_by_runtime", retryable: true },
          diagnostics: { cause: result.sourcePressure },
        });
      } else {
        await ctx.emit({
          type: "SKIP_RESULT", stream, reason: "inventory_not_proven_complete", message,
          recovery_hint: { action: "retry_by_runtime", retryable: true },
        });
      }
      if (result.resume) {
        // Keep the completed-day watermark untouched; this only checkpoints
        // the provider page after the validated rows were emitted.
        await ctx.emit({ type: "STATE", stream, cursor: {
          ...previous,
          account: access.account,
          api_v2: true,
          requested_since: requestedSince ?? null,
          resume: result.resume,
        } });
      }
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
