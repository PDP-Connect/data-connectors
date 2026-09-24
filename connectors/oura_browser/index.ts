// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Oura's browser-session profile. The PAT profile remains `oura`; this
 * profile uses the authenticated cloud.ouraring.com account endpoint. */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
  BrowserCollectContext,
  EnsureSessionArgs,
  RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

const HOME = "https://cloud.ouraring.com/";
const ORIGIN = new URL(HOME).origin;
// Include today in the initial 90-day snapshot.
const INITIAL_LOOKBACK_DAYS = 89;
const MAX_WINDOW_DAYS = 90;
const CHUNK_DAYS = 30;

interface DailySleep {
  contributors?: Record<string, unknown>;
  day: string;
  id: string;
  score?: number | null;
}

interface SleepSession {
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

interface DailyReadiness {
  contributors?: Record<string, unknown>;
  day: string;
  id: string;
  score?: number | null;
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

async function hasOuraSession(page: BrowserCollectContext["page"]): Promise<boolean> {
  if (new URL(page.url()).origin !== ORIGIN) {
    await page.goto(HOME, { waitUntil: "domcontentloaded" });
  }
  if (new URL(page.url()).origin !== ORIGIN) return false;
  return page.evaluate(async () => {
    try {
      if (location.origin !== "https://cloud.ouraring.com") return false;
      return (await fetch("/api/me", { credentials: "include" })).ok;
    } catch {
      return false;
    }
  });
}

export async function ensureOuraSession(args: EnsureSessionArgs): Promise<void> {
  const { assist, capture, completeAssistance, page, sendInteraction } = args;
  if (await hasOuraSession(page)) return;
  await page.goto(`${HOME}user/sign-in`, { waitUntil: "domcontentloaded" });
  const ready = await manualBrowserLogin({
    assist,
    capture,
    completeAssistance,
    isProbeSuccessful: (ok) => ok === true,
    message: "Sign in to Oura in the secure browser, then continue. PDPP will verify the session before collecting.",
    page,
    probe: () => hasOuraSession(page),
    readinessProbe: hasOuraSession,
    sendInteraction,
    timeoutSeconds: 30 * 60,
  });
  if (!ready) throw new Error("oura_session_dead");
}

async function fetchDailyData(page: BrowserCollectContext["page"], start: string, end: string): Promise<OuraDailyData> {
  if (new URL(page.url()).origin !== ORIGIN) throw new Error("oura_auth_failed: wrong browser origin");
  return page.evaluate(
    async ({ start, end }) => {
      if (location.origin !== "https://cloud.ouraring.com") throw new Error("oura_auth_failed: wrong browser origin");
      const query = new URLSearchParams({ start, end });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(`/api/account/daily-data?${query}`, {
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) throw new Error("oura_auth_failed");
        if (!response.ok) throw new Error(`oura_internal_api_${response.status}`);
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("oura_internal_api_invalid_payload");
        }
        const data = payload as Record<string, unknown>;
        const keys = ["sleeps", "daily_sleeps", "daily_readinesses", "daily_activities"];
        if (!keys.some((key) => Array.isArray(data[key])) ||
          keys.some((key) => data[key] !== undefined && !Array.isArray(data[key]))) {
          throw new Error("oura_internal_api_invalid_payload");
        }
        for (const key of keys) {
          const rows = data[key];
          if (Array.isArray(rows) && rows.some((row) =>
            typeof row !== "object" || row === null ||
            typeof row.id !== "string" || typeof row.day !== "string")) {
            throw new Error("oura_internal_api_invalid_payload");
          }
        }
        return data as OuraDailyData;
      } finally {
        clearTimeout(timeout);
      }
    },
    { start, end }
  );
}

function day(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
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
  next_day?: string;
  requested_since?: string;
  failed_windows?: Array<{ start: string; end: string }>;
  last_day?: string;
}

function startDateFor(ctx: BrowserCollectContext, stream: string, endDate: string): string {
  const cursor = ctx.state[stream] as OuraCursor | undefined;
  const requestedSince = ctx.requested.get(stream)?.time_range?.since?.slice(0, 10);
  if (ctx.collectionMode === "full_refresh") return requestedSince ?? initialStartDate(day(endDate));
  if (requestedSince) {
    return cursor?.requested_since === requestedSince && cursor.next_day && cursor.next_day > requestedSince
      ? cursor.next_day : requestedSince;
  }
  return cursor?.next_day ?? (cursor?.last_day ? addDays(cursor.last_day, 1) : initialStartDate(day(endDate)));
}

async function fetchWindow(
  ctx: BrowserCollectContext,
  stream: string,
  startDate: string,
  endDate: string
): Promise<{ data: OuraDailyData; failedWindows: Array<{ start: string; end: string }>; completedThrough: string; retryable: boolean }> {
  const data: OuraDailyData = {};
  const failedWindows: Array<{ start: string; end: string }> = [];
  let completedThrough = addDays(startDate, -1);
  let retryable = true;
  let start = day(startDate);
  const end = day(endDate);
  while (start <= end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    const from = start.toISOString().slice(0, 10);
    const to = chunkEnd.toISOString().slice(0, 10);
    await ctx.progress(`Fetching ${stream}: ${from} to ${to}`, { stream });
    try {
      const chunk = await fetchDailyData(ctx.page, from, to);
      for (const key of ["sleeps", "daily_sleeps", "daily_readinesses", "daily_activities"] as const) {
        const rows = chunk[key];
        if (Array.isArray(rows)) data[key] = [...(data[key] ?? []), ...rows] as never;
      }
      if (failedWindows.length === 0) completedThrough = to;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/\boura_auth_failed\b/.test(detail)) throw error;
      if (/oura_internal_api_(?:invalid_payload|4(?!29)\d\d)/.test(detail)) retryable = false;
      failedWindows.push({ start: from, end: to });
      await ctx.progress(
        `Oura ${stream} data chunk ${from} to ${to} failed: ${detail}`,
        { stream }
      );
    }
    start = new Date(chunkEnd);
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return { data, failedWindows, completedThrough, retryable };
}

function sleepRecord(session: SleepSession, daily?: DailySleep): RecordData {
  return {
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
    average_breath: session.average_breath ?? null,
    restless_periods: session.restless_periods ?? null,
    time_in_bed: session.time_in_bed ?? null,
    type: session.type ?? null,
    contributors: daily?.contributors ?? {},
  };
}

function readinessRecord(row: DailyReadiness): RecordData {
  return {
    id: row.id,
    day: row.day,
    score: row.score ?? null,
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

export async function collectOuraBrowser(ctx: BrowserCollectContext): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  for (const stream of ["sleep", "readiness", "activity"] as const) {
    if (!ctx.requested.has(stream)) continue;
    const previous = ctx.state[stream] as OuraCursor | undefined;
    const requestedSince = ctx.requested.get(stream)?.time_range?.since?.slice(0, 10);
    const until = ctx.requested.get(stream)?.time_range?.until?.slice(0, 10);
    const untilEnd = until ? addDays(until, -1) : today;
    const requestedEnd = untilEnd < today ? untilEnd : today;
    const startDate = startDateFor(ctx, stream, today);
    if (startDate > requestedEnd) continue;
    const cappedEnd = addDays(startDate, MAX_WINDOW_DAYS - 1);
    const endDate = cappedEnd < requestedEnd ? cappedEnd : requestedEnd;
    const { data, failedWindows, completedThrough, retryable } = await fetchWindow(ctx, stream, startDate, endDate);
    let records: RecordData[];
    if (stream === "sleep") {
      const scores = new Map((data.daily_sleeps ?? []).map((row) => [row.day, row]));
      const sessions = data.sleeps ?? [];
      records = sessions.map((row) => sleepRecord(row, scores.get(row.day)));
    } else if (stream === "readiness") {
      const rows = data.daily_readinesses ?? [];
      records = rows.map(readinessRecord);
    } else {
      const rows = data.daily_activities ?? [];
      records = rows.map(activityRecord);
    }
    for (const record of records) await ctx.emitRecord(stream, record);
    if (failedWindows.length > 0) {
      await ctx.reportStreamFailure?.(
        stream,
        `Oura ${stream} failed ${failedWindows.length} data window(s), starting ${failedWindows[0]?.start}; retry will resume at the first gap.`,
        { retryable }
      );
    }
    if (endDate < requestedEnd) {
      await ctx.emit({
        type: "SKIP_RESULT", stream, reason: "oura_browser_window_deferred",
        message: `Oura ${stream} stopped at ${endDate}; later days remain for the next run.`,
      });
    }
    await ctx.emit({
      type: "STATE",
      stream,
      cursor: {
        next_day: addDays(completedThrough, 1),
        requested_since: requestedSince ?? previous?.requested_since ?? null,
        failed_windows: failedWindows,
      },
    });
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "oura_browser",
    validateRecord,
    retryablePattern: /oura_internal_api_(?:429|5\d\d)|fetch failed|network|timeout|aborted/i,
    browser: { profileName: "oura_browser" },
    ensureSession: ensureOuraSession,
    probeSession: ({ page }) => hasOuraSession(page),
    probeSessionIsAuthoritative: true,
    collect: collectOuraBrowser,
  });
}
