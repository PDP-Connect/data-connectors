// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Muse (Meta) gateway answers. Each `parse*` validates
 * the raw answer at the boundary with zod and returns null when its shape is
 * not the one observed (api.md), so the caller fails the stream instead of
 * emitting records built from guesses. Each `build*` turns one validated
 * source item into the record its stream declares.
 *
 * Text: every free-text value goes through `cleanText`, which keeps the
 * source text unchanged when it is PDPP-safe and otherwise replaces it with
 * null and counts the replacement (`TextTally`), so the collector can report
 * it instead of dropping it silently.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { TEXT_MAX_UNITS } from "./schemas.ts";

/** The agent's memory and profile files at the workspace root. The only paths ever read. */
export const MEMORY_FILE_NAMES = [
	"MEMORY.md",
	"USER.md",
	"SOUL.md",
	"IDENTITY.md",
	"PROACTIVE_PREFERENCES.md",
] as const;

const ZONED_ISO_RE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
// Epoch milliseconds between 2000-01-01 and 2200-01-01: anything else is not a
// time this source would report.
const MIN_MS = 946_684_800_000;
const MAX_MS = 7_258_118_400_000;

// ─── Text ───────────────────────────────────────────────────────────────

/** Count of free-text values replaced with null because they were not PDPP-safe. */
export class TextTally {
	readonly byStream = new Map<string, number>();
	add(stream: string, count: number): void {
		if (count > 0)
			this.byStream.set(stream, (this.byStream.get(stream) ?? 0) + count);
	}
}

export interface CleanText {
	value: string | null;
	/** The safety check's reason when a non-empty string was replaced with null. */
	reason: string | null;
}

/** The source string unchanged when it is PDPP-safe text; null otherwise. */
export function cleanText(value: unknown, max = TEXT_MAX_UNITS): CleanText {
	if (typeof value !== "string") return { value: null, reason: null };
	if (value === "") return { value: "", reason: null };
	const result = safeTextPreview(value, max);
	if (result.kind === "text" && !result.truncated) {
		return { value, reason: null };
	}
	return {
		value: null,
		reason: result.reason ?? (result.truncated ? "exceeds_inline_cap" : null),
	};
}

/** Collects replaced-text counts while one record is built. */
class TextScope {
	replaced = 0;
	text(value: unknown, max = TEXT_MAX_UNITS): string | null {
		const r = cleanText(value, max);
		if (r.value === null && r.reason !== null) this.replaced += 1;
		return r.value;
	}
}

// ─── Times ──────────────────────────────────────────────────────────────

/** Epoch milliseconds (UTC) as RFC 3339 with `Z`; null when not a plausible time. */
export function msToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < MIN_MS || value > MAX_MS) return null;
	return new Date(value).toISOString();
}

/** Epoch seconds (UTC) as RFC 3339 with `Z`. */
export function secondsToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return msToIso(value * 1000);
}

/** A zoned ISO string normalized to UTC `Z`; null for a zoneless or bad value. */
export function zonedIsoToIso(value: unknown): string | null {
	if (typeof value !== "string" || !ZONED_ISO_RE.test(value)) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : msToIso(ms);
}

const optString = z.string().nullable().optional();
const optBool = z.boolean().nullable().optional();
const optNumber = z.number().nullable().optional();

function str(value: string | null | undefined): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

// ─── sessions.list → conversations ──────────────────────────────────────

const sessionSchema = z.object({
	session_id: z.string().min(1),
	title: optString,
	snippet: optString,
	created_at_ms: optNumber,
	updated_at_ms: optNumber,
	is_primary: optBool,
	is_thread: optBool,
	archived: optBool,
	pinned: optBool,
	status: optString,
});
export type MuseSession = z.infer<typeof sessionSchema>;

const sessionsResponseSchema = z.object({ sessions: z.array(z.unknown()) });

const cursorValue = z.union([z.string(), z.number()]).nullable().optional();

const sessionsPagingSchema = z.object({
	next_cursor: cursorValue,
	has_more: z.boolean().nullable().optional(),
});

export interface SessionsPage {
	sessions: MuseSession[];
	/** The cursor for the next page; null when the answer says the list ended. */
	nextCursor: string | null;
	/** has_more:true with no cursor to follow: the list cannot be read to its end. */
	moreWithoutCursor: boolean;
}

/**
 * One sessions.list page. Observed live: `{ limit }` answers
 * `{ sessions, next_cursor }`, the next page is asked with `cursor`, and the
 * last page has no next_cursor (without `limit`, one answer holds the whole
 * list and no next_cursor). An absent or null next_cursor, or has_more:false,
 * ends the list.
 */
export function parseSessionsPage(raw: unknown): SessionsPage | null {
	const sessions = parseSessions(raw);
	const paging = sessionsPagingSchema.safeParse(raw);
	if (sessions === null || !paging.success) return null;
	const cursor = paging.data.next_cursor;
	const nextCursor =
		cursor === undefined || cursor === null || cursor === ""
			? null
			: String(cursor);
	return {
		sessions,
		nextCursor,
		moreWithoutCursor: nextCursor === null && paging.data.has_more === true,
	};
}

/** The session of a sessions.get answer (`{ session }` or the session itself), or null. */
export function parseSessionGet(raw: unknown): MuseSession | null {
	const wrapped = z.object({ session: z.unknown() }).safeParse(raw);
	const parsed = sessionSchema.safeParse(
		wrapped.success ? wrapped.data.session : raw,
	);
	return parsed.success ? parsed.data : null;
}

/** Every session of one sessions.list answer, or null when any is unreadable. */
export function parseSessions(raw: unknown): MuseSession[] | null {
	const parsed = sessionsResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const out: MuseSession[] = [];
	for (const item of parsed.data.sessions) {
		const s = sessionSchema.safeParse(item);
		if (!s.success) return null;
		out.push(s.data);
	}
	return out;
}

export function buildConversationRecord(
	session: MuseSession,
	archivedView: boolean,
): { record: RecordData; replaced: number } {
	const t = new TextScope();
	const record: RecordData = {
		id: session.session_id,
		title: t.text(session.title),
		snippet: t.text(session.snippet),
		created_at: msToIso(session.created_at_ms),
		updated_at: msToIso(session.updated_at_ms),
		is_primary: session.is_primary ?? null,
		is_thread: session.is_thread ?? null,
		archived: session.archived ?? archivedView,
		pinned: session.pinned ?? null,
		status: str(session.status),
	};
	return { record, replaced: t.replaced };
}

// ─── chat.history → messages ────────────────────────────────────────────

const chatEventSchema = z.object({
	message_id: z.string().min(1),
	occurred_at_ms: z.number(),
	role: optString,
	display_text: optString,
	display_text_ready: optBool,
	reply_to_message_id: optString,
	visibility: optString,
	seq: optNumber,
	payload: z
		.object({
			content: z.unknown().optional(),
			source: optString,
			status: optString,
			display_text_ready: optBool,
		})
		.nullable()
		.optional(),
});
export type MuseChatEvent = z.infer<typeof chatEventSchema>;

/** Message statuses after which the text no longer changes ("completed" is observed live). */
const FINAL_STATUSES = new Set([
	"completed",
	"complete",
	"done",
	"failed",
	"error",
	"cancelled",
	"canceled",
	"interrupted",
	"stopped",
	"aborted",
]);

/**
 * Whether an event's text is final. A display text the source marks not
 * ready, or a status that is not a known final one (such as "running"), is
 * still being generated and must not be stored under its append-only id.
 * No status at all (user messages) is final.
 */
export function isFinalEvent(e: MuseChatEvent): boolean {
	if (e.display_text_ready === false || e.payload?.display_text_ready === false)
		return false;
	const status = e.payload?.status;
	return status === undefined || status === null || FINAL_STATUSES.has(status);
}

const historyResponseSchema = z.object({
	chat_events: z.array(z.unknown()),
	has_more: z.boolean(),
	transcript_revision: z.number().nullable().optional(),
});

export interface HistoryPage {
	events: MuseChatEvent[];
	hasMore: boolean;
	/** The chat transcript's revision, which changes with every change to it; null when absent. */
	transcriptRevision: number | null;
}

/** One chat.history page, or null when it or any event is unreadable. */
export function parseHistory(raw: unknown): HistoryPage | null {
	const parsed = historyResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const events: MuseChatEvent[] = [];
	for (const item of parsed.data.chat_events) {
		const e = chatEventSchema.safeParse(item);
		if (!e.success || msToIso(e.data.occurred_at_ms) === null) return null;
		events.push(e.data);
	}
	const revision = parsed.data.transcript_revision;
	return {
		events,
		hasMore: parsed.data.has_more,
		transcriptRevision:
			typeof revision === "number" && Number.isFinite(revision)
				? revision
				: null,
	};
}

export function buildMessageRecord(
	event: MuseChatEvent,
	sessionId: string,
): { record: RecordData; replaced: number } {
	const display = event.display_text;
	const content = event.payload?.content;
	const source =
		typeof display === "string" && display !== ""
			? display
			: typeof content === "string" && content !== ""
				? content
				: null;
	const text = cleanText(source);
	const seq =
		typeof event.seq === "number" && Number.isInteger(event.seq)
			? event.seq
			: null;
	const record: RecordData = {
		id: event.message_id,
		session_id: sessionId,
		role: str(event.role),
		text: text.value,
		text_binary_reason: text.reason,
		occurred_at: msToIso(event.occurred_at_ms),
		reply_to_message_id: str(event.reply_to_message_id),
		source: str(event.payload?.source),
		visibility: str(event.visibility),
		seq,
	};
	return { record, replaced: text.reason === null ? 0 : 1 };
}

/**
 * One record per message id. An id seen twice keeps the event with the
 * higher seq (the later state of the same message).
 */
export function uniqueEvents(
	events: readonly MuseChatEvent[],
): MuseChatEvent[] {
	const byId = new Map<string, MuseChatEvent>();
	for (const e of events) {
		const prior = byId.get(e.message_id);
		if (!prior || (e.seq ?? -1) >= (prior.seq ?? -1)) byId.set(e.message_id, e);
	}
	return [...byId.values()].sort(
		(a, b) =>
			a.occurred_at_ms - b.occurred_at_ms || (a.seq ?? 0) - (b.seq ?? 0),
	);
}

// ─── activity.list → activities ─────────────────────────────────────────

const activitySchema = z.object({
	timestamp: z.string().min(1),
	type: z.string().min(1),
	message_id: optString,
	title: optString,
	subtitle: optString,
	status: optString,
	status_title: optString,
	task_label: optString,
});
export type MuseActivity = z.infer<typeof activitySchema>;

const activityResponseSchema = z.object({
	days: z.array(z.object({ activities: z.array(z.unknown()) })),
});

/** Every activity of one activity.list page, or null when any is unreadable. */
export function parseActivities(raw: unknown): MuseActivity[] | null {
	const parsed = activityResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const out: MuseActivity[] = [];
	for (const day of parsed.data.days) {
		for (const item of day.activities) {
			const a = activitySchema.safeParse(item);
			if (!a.success || zonedIsoToIso(a.data.timestamp) === null) return null;
			out.push(a.data);
		}
	}
	return out;
}

/** message_id plus timestamp plus type: one message can log several activities. */
export function activityId(a: MuseActivity): string {
	return `${a.message_id ?? ""}:${zonedIsoToIso(a.timestamp) ?? a.timestamp}:${a.type}`;
}

export function buildActivityRecord(a: MuseActivity): {
	record: RecordData;
	replaced: number;
} {
	const t = new TextScope();
	const record: RecordData = {
		id: activityId(a),
		message_id: str(a.message_id),
		type: a.type,
		title: t.text(a.title),
		subtitle: t.text(a.subtitle),
		status: str(a.status),
		status_title: t.text(a.status_title),
		task_label: t.text(a.task_label),
		timestamp: zonedIsoToIso(a.timestamp),
	};
	return { record, replaced: t.replaced };
}

// ─── goals.list → goals ─────────────────────────────────────────────────

const goalSchema = z.object({
	goal_id: z.string().min(1),
	source: optString,
	slug: optString,
	title: optString,
	status: optString,
	summary: optString,
	description: optString,
	momentum_status: optString,
	emoji: optString,
	created_at: optString,
	updated_at: optString,
	last_activity_at: optString,
});
export type MuseGoal = z.infer<typeof goalSchema>;

const goalsResponseSchema = z.object({
	goals: z.array(z.unknown()),
	pagination: z.object({
		has_next_page: z.boolean(),
		next_cursor: cursorValue,
		end_cursor: cursorValue,
		cursor: cursorValue,
	}),
	next_cursor: cursorValue,
});

export interface GoalsPage {
	goals: MuseGoal[];
	hasNextPage: boolean;
	/** The cursor the answer gives for its next page, if any. */
	nextCursor: string | null;
}

export function parseGoals(raw: unknown): GoalsPage | null {
	const parsed = goalsResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const goals: MuseGoal[] = [];
	for (const item of parsed.data.goals) {
		const g = goalSchema.safeParse(item);
		if (!g.success) return null;
		goals.push(g.data);
	}
	const { pagination } = parsed.data;
	const cursor = [
		pagination.next_cursor,
		pagination.end_cursor,
		pagination.cursor,
		parsed.data.next_cursor,
	].find((c) => c !== undefined && c !== null && c !== "");
	return {
		goals,
		hasNextPage: pagination.has_next_page,
		nextCursor: cursor === undefined || cursor === null ? null : String(cursor),
	};
}

export function buildGoalRecord(
	g: MuseGoal,
	requestedSource: string | null,
): { record: RecordData; replaced: number } {
	const t = new TextScope();
	const record: RecordData = {
		id: g.goal_id,
		source: str(g.source) ?? requestedSource,
		slug: t.text(g.slug),
		title: t.text(g.title),
		status: str(g.status),
		summary: t.text(g.summary),
		description: t.text(g.description),
		momentum_status: str(g.momentum_status),
		emoji: t.text(g.emoji),
		created_at: zonedIsoToIso(g.created_at),
		updated_at: zonedIsoToIso(g.updated_at),
		last_activity_at: zonedIsoToIso(g.last_activity_at),
	};
	return { record, replaced: t.replaced };
}

// ─── tasks.list → scheduled_tasks ───────────────────────────────────────

const scheduleSchema = z.object({
	id: z.string().min(1),
	title: optString,
	schedule_key: optString,
	mode: optString,
	enabled: optBool,
	is_heartbeat: optBool,
	next_run_at_utc: optNumber,
	timezone: optString,
	cadence: z
		.object({
			kind: optString,
			time: optString,
			interval_seconds: optNumber,
			run_at_utc: optNumber,
		})
		.nullable()
		.optional(),
});
export type MuseSchedule = z.infer<typeof scheduleSchema>;

const tasksResponseSchema = z.object({ schedules: z.array(z.unknown()) });

export function parseSchedules(raw: unknown): MuseSchedule[] | null {
	const parsed = tasksResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const out: MuseSchedule[] = [];
	for (const item of parsed.data.schedules) {
		const s = scheduleSchema.safeParse(item);
		if (!s.success) return null;
		out.push(s.data);
	}
	return out;
}

export function buildScheduledTaskRecord(s: MuseSchedule): {
	record: RecordData;
	replaced: number;
} {
	const t = new TextScope();
	const interval = s.cadence?.interval_seconds;
	const record: RecordData = {
		id: s.id,
		title: t.text(s.title),
		schedule_key: t.text(s.schedule_key),
		mode: str(s.mode),
		enabled: s.enabled ?? null,
		is_heartbeat: s.is_heartbeat ?? null,
		// next_run_at_utc and run_at_utc are epoch seconds (api.md ranges).
		next_run_at: secondsToIso(s.next_run_at_utc),
		timezone: str(s.timezone),
		cadence_kind: str(s.cadence?.kind),
		cadence_time: str(s.cadence?.time),
		cadence_interval_seconds:
			typeof interval === "number" &&
			Number.isInteger(interval) &&
			interval >= 0
				? interval
				: null,
		cadence_run_at: secondsToIso(s.cadence?.run_at_utc),
	};
	return { record, replaced: t.replaced };
}

// ─── fs.list / fs.raw → memory_files ────────────────────────────────────

const fsEntrySchema = z.object({
	name: z.string().min(1),
	type: z.string().min(1),
	size: optNumber,
	modifiedAt: optString,
});
export type MuseFsEntry = z.infer<typeof fsEntrySchema>;

const fsListResponseSchema = z.object({ entries: z.array(z.unknown()) });

export function parseFsList(raw: unknown): MuseFsEntry[] | null {
	const parsed = fsListResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const out: MuseFsEntry[] = [];
	for (const item of parsed.data.entries) {
		const e = fsEntrySchema.safeParse(item);
		if (!e.success) return null;
		out.push(e.data);
	}
	return out;
}

/** The memory files present at the workspace root, in MEMORY_FILE_NAMES order. */
export function memoryFileEntries(
	entries: readonly MuseFsEntry[],
): MuseFsEntry[] {
	const files = new Map(
		entries.filter((e) => e.type === "file").map((e) => [e.name, e]),
	);
	return MEMORY_FILE_NAMES.flatMap((name) => {
		const entry = files.get(name);
		return entry ? [entry] : [];
	});
}

const rawTextSchema = z.union([
	z.object({ __blob_text: z.string() }),
	z.string(),
]);

/** The text of an fs.raw answer (the page turns the Blob into `{ __blob_text }`). */
export function parseRawText(raw: unknown): string | null {
	const parsed = rawTextSchema.safeParse(raw);
	if (!parsed.success) return null;
	return typeof parsed.data === "string"
		? parsed.data
		: parsed.data.__blob_text;
}

function nonNegativeInt(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
		? value
		: null;
}

export function buildMemoryFileRecord(
	entry: MuseFsEntry,
	content: string,
): { record: RecordData; replaced: number } {
	const text = cleanText(content);
	const record: RecordData = {
		id: entry.name,
		path: entry.name,
		text: text.value,
		text_binary_reason: text.reason,
		size: nonNegativeInt(entry.size),
		modified_at: zonedIsoToIso(entry.modifiedAt),
	};
	return { record, replaced: text.reason === null ? 0 : 1 };
}

// ─── fs.library → files ─────────────────────────────────────────────────

const libraryEntrySchema = z.object({
	name: optString,
	path: z.string().min(1),
	size: optNumber,
	modified_ms: optNumber,
});
export type MuseLibraryEntry = z.infer<typeof libraryEntrySchema>;

const libraryResponseSchema = z.object({
	entries: z.array(z.unknown()),
	total: z.number().int().min(0).optional(),
	has_more: z.boolean(),
});

export interface LibraryPage {
	entries: MuseLibraryEntry[];
	total: number | null;
	hasMore: boolean;
}

export function parseLibrary(raw: unknown): LibraryPage | null {
	const parsed = libraryResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const entries: MuseLibraryEntry[] = [];
	for (const item of parsed.data.entries) {
		const e = libraryEntrySchema.safeParse(item);
		if (!e.success) return null;
		entries.push(e.data);
	}
	return {
		entries,
		total: parsed.data.total ?? null,
		hasMore: parsed.data.has_more,
	};
}

export function buildFileRecord(e: MuseLibraryEntry): {
	record: RecordData;
	replaced: number;
} | null {
	const t = new TextScope();
	const path = t.text(e.path, 4096);
	// The path is the record's identity; an unsafe one cannot be stored.
	if (path === null || path === "") return null;
	const record: RecordData = {
		id: e.path,
		path,
		name: t.text(e.name),
		size: nonNegativeInt(e.size),
		modified_at: msToIso(e.modified_ms),
	};
	return { record, replaced: t.replaced };
}

// ─── connectors.list → connected_apps ───────────────────────────────────

const connectorSchema = z.object({
	id: z.string().min(1),
	name: optString,
	state: optString,
	management_kind: optString,
	needs_reauth: optBool,
});
export type MuseConnector = z.infer<typeof connectorSchema>;

const connectorsResponseSchema = z.object({ connectors: z.array(z.unknown()) });

export function parseConnectors(raw: unknown): MuseConnector[] | null {
	const parsed = connectorsResponseSchema.safeParse(raw);
	if (!parsed.success) return null;
	const out: MuseConnector[] = [];
	for (const item of parsed.data.connectors) {
		const c = connectorSchema.safeParse(item);
		if (!c.success) return null;
		out.push(c.data);
	}
	return out;
}

/** Only services the owner connected (including ones that need re-auth). */
export function isConnectedApp(c: MuseConnector): boolean {
	return c.state === "connected" || c.needs_reauth === true;
}

export function buildConnectedAppRecord(c: MuseConnector): {
	record: RecordData;
	replaced: number;
} {
	const t = new TextScope();
	const record: RecordData = {
		id: c.id,
		name: t.text(c.name),
		state: str(c.state),
		management_kind: str(c.management_kind),
		needs_reauth: c.needs_reauth ?? null,
	};
	return { record, replaced: t.replaced };
}
