// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stream collection for the Slack browser profile, over an abstract Web API
 * client so the whole walk can be driven by fixtures in index.test.ts.
 *
 * Directory streams (workspace, channels, users, user_groups, reminders,
 * stars) are full scans gated by a per-record fingerprint, so a steady-state
 * run emits nothing for them. With several signed-in workspaces, each stream
 * reports one coverage for the whole run, its counts summed across them.
 *
 * `messages` keeps one cursor per conversation (the newest ts read) and the
 * time the run that wrote it started (`replies_checked_ts`). A conversation
 * the run never read starts at the lookback floor. One with a stored cursor
 * starts a week before that cursor, so a late reply or reaction on a recent
 * message is seen again, however long ago the last run was: after a long
 * pause the read catches up from the cursor, reaching back no further than
 * the owner's SLACK_MAX_BACKFILL_DAYS. The web client's own `client.counts`
 * cannot stand in for any of this: its `latest` moves only when a new message
 * lands, so it says nothing about a reaction or an edit landing on the newest
 * message it already reports.
 *
 * Replies to a thread whose parent is older than where a read starts are
 * found two ways. First, `search.messages` for everything written since the
 * oldest reply any conversation still owes a look for (the last run's start,
 * less the same week, or the floor on a first read): its results name the
 * threads that got a reply, whatever the age of their parent, and those are
 * read directly. When search is unavailable, fails, or runs past its page cap,
 * each conversation instead scans the month below its starting line for
 * thread parents with a reply since then. That scan is bounded; when the
 * conversation has history older than the scan reached, the conversation is
 * reported as a DETAIL_GAP carrying the oldest reply time still owed, so a
 * later run with search back looks that far again instead of the miss going
 * unrecorded.
 *
 * Conversations are read a few at a time. A conversation Slack will not
 * serve this session (`not_in_channel` and the like) is skipped; one Slack
 * stopped answering is reported as a DETAIL_GAP and its cursor stays put, so
 * the next run reads it again. A pending gap for a conversation that has left
 * what the run reads (the owner left it, Slack refuses it, or the allowlist or
 * channel kinds now leave it out) is resolved, so it does not stay open for
 * good; only gaps of the workspace being read are resolved this way. A
 * session rejection, the browser leaving app.slack.com, or the page being
 * closed ends the run with a SKIP_RESULT on every requested stream and no
 * cursor moves.
 */

import type { ZodType } from "zod";
import {
	buildFullScanCoverageMessage,
	type DetailGapStartEntry,
	type EmittedMessage,
	emitDetailCoverage,
	emitDetailGap,
	type ProgressExtra,
	type RecordData,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type FingerprintCursor,
	openFingerprintCursor,
} from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	buildChannel,
	buildMessageFamily,
	buildReminder,
	buildStar,
	buildUser,
	buildUserGroup,
	buildWorkspace,
	isThreadParent,
	slackTsSeconds,
	threadActiveSince,
} from "./parsers.ts";
import {
	authTestSchema,
	conversationsListSchema,
	historySchema,
	messagesCursorSchema,
	remindersListSchema,
	searchMessagesSchema,
	starsListSchema,
	teamInfoSchema,
	userGroupsListSchema,
	usersListSchema,
} from "./schemas.ts";
import type {
	ConversationKind,
	MessagesCursor,
	SignedInTeam,
	SlackBrowserOptions,
	SlackConversationObject,
	SlackMessageObject,
	TeamInfoAnswer,
} from "./types.ts";
import {
	CHALLENGE_REASON,
	isHostFault,
	type SlackApiClient,
	SlackApiError,
	SlackSessionLostError,
} from "./web-api.ts";

/**
 * How far below a conversation's cursor a later run reads again, for late
 * replies and reactions; also how far before the last run's start replies are
 * looked for again.
 */
export const LATE_REPLY_LOOKBACK_SECONDS = 7 * 24 * 3600;
/** How far below a read's starting line it scans for active threads when search did not name them. */
export const THREAD_LOOKBACK_SECONDS = 30 * 24 * 3600;
/** The thread scan below a read's starting line stopped with older history left unscanned. */
export const THREAD_SCAN_BOUND_REASON = "thread_scan_bound_reached";
export const MAX_PAGES_PER_CONVERSATION = 2000;
/** Search pages (100 matches each) a run reads before it stops trusting search for thread discovery. */
export const MAX_SEARCH_PAGES = 100;
/** How many conversations are read at once. */
export const DEFAULT_CONCURRENCY = 3;
const MAX_PAGES_PER_THREAD = 200;
const MAX_LIST_PAGES = 500;
/** Slack allows up to 999 per history page; fewer round trips on busy channels. */
const HISTORY_PAGE_LIMIT = "999";
const LIST_PAGE_LIMIT = "200";
const USERS_PAGE_LIMIT = "500";
const SEARCH_PAGE_COUNT = "100";
const THREAD_TS_IN_PERMALINK = /[?&]thread_ts=(\d{10}\.\d{1,6})/;
/** A method answered `ok` with a body this connector's schema does not recognise. */
const UNRECOGNISED_ANSWER = "unrecognised_answer";
/** History or replies hit this connector's page cap with `has_more` still true. */
export const PAGE_CAP_REASON = "page_cap_reached";

const FINGERPRINTED = [
	"workspace",
	"channels",
	"users",
	"user_groups",
	"reminders",
	"stars",
] as const;
type FingerprintedStream = (typeof FINGERPRINTED)[number];

/** Run-clock fields that must not take part in change detection. */
const FINGERPRINT_EXCLUDE: Record<FingerprintedStream, readonly string[]> = {
	workspace: ["fetched_at"],
	channels: [],
	users: [],
	user_groups: [],
	reminders: [],
	stars: [],
};

const MESSAGE_FAMILY = [
	"messages",
	"message_attachments",
	"reactions",
	"files",
] as const;

const CONVERSATION_TYPES: Record<ConversationKind, string> = {
	public: "public_channel",
	private: "private_channel",
	im: "im",
	mpim: "mpim",
};

export interface SlackBrowserCollectContext {
	collectionMode?: "full_refresh" | "incremental";
	/** Detail gaps the runtime had pending when the run started (its first page). */
	detailGaps?: readonly DetailGapStartEntry[];
	emit: (msg: EmittedMessage) => Promise<void>;
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	emittedAt: string;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
	/** The next page of pending detail gaps; absent when the host offers none. */
	requestDetailGapPage?: (req?: {
		maxBytes?: number;
		streams?: readonly string[];
	}) => Promise<readonly DetailGapStartEntry[]>;
	requested: Map<string, StreamScope>;
	state: Record<string, unknown>;
}

export interface SlackBrowserServices {
	api: SlackApiClient;
	/** Conversations read at once; defaults to DEFAULT_CONCURRENCY. */
	concurrency?: number;
	now: () => Date;
}

interface Run {
	api: SlackApiClient;
	concurrency: number;
	ctx: SlackBrowserCollectContext;
	cursors: Map<FingerprintedStream, FingerprintCursor>;
	/** Optional streams that ended in a SKIP_RESULT this run. */
	failed: Set<string>;
	/**
	 * Each full-scan stream's enumerated size, summed across the workspaces
	 * read: one coverage per stream goes out when the run finishes.
	 */
	fullScanConsidered: Map<FingerprintedStream, number>;
	/** The messages boundary across every workspace read, reported once when the run finishes. */
	messagesCoverage: MessagesCoverage;
	/** Pending messages gaps by conversation, read once per run; null until the first workspace asks. */
	pendingGaps: Map<string, PendingGap[]> | null;
	fullRefresh: boolean;
	/** Message ids read this run, in read order, deduplicated: the parent boundary the derived detail streams account for. */
	messagesRead: string[];
	messagesSeen: Set<string>;
	messagesEmitted: number;
	/**
	 * Messages this run read whose files could not all be keyed (an id-less
	 * file), with the channel and ts the message lives at: the files stream's
	 * gaps, each carried as a DETAIL_GAP beside its coverage key.
	 */
	fileGaps: Map<string, { channelId: string; ts: string }>;
	/**
	 * files is its own checkpoint parent (checkpoint_window, as in the archive
	 * profile): its STATE is written only when every conversation in the
	 * window was read and every file it named carried an id.
	 */
	filesIncomplete: boolean;
	now: () => Date;
	options: SlackBrowserOptions;
}

interface MessagesPlan {
	/** The oldest the owner's max backfill lets a read from a cursor start; 0 for no limit. */
	backfillFloorSec: number;
	channelLastTs: Record<string, string>;
	/** Where a conversation's first read starts; 0 for its whole history. */
	floorSec: number;
	nextFloorSec: number;
	/** When the cursor's run started, if it said: replies before it were looked for then. */
	repliesCheckedSec: number | null;
	/**
	 * The oldest a read from a stored cursor may start: the requested start
	 * and the owner's max backfill. 0 when neither limits it.
	 */
	resumeClampSec: number;
	/** This run's start, stored as the next cursor's replies_checked_ts. */
	runSec: number;
}

/** Where one conversation's read starts this run, and which replies it owes a look for. */
interface ConversationWindow {
	/** The cursor's own starting line was older than the owner's max backfill allows. */
	clamped: boolean;
	/** The oldest ts the head walk reads; 0 for the whole history. */
	headOldest: number;
	/** Replies at or after this are looked for in threads below headOldest. */
	repliesSince: number;
}

interface PendingGap {
	gapId: string;
	leaseId?: string;
	/** The oldest reply time the gap still owes a look for, when it said. */
	repliesSince?: number;
	/** The workspace the gap was filed for, when it said. */
	teamId?: string;
}

interface MessagesCoverage {
	gaps: Set<string>;
	hydrated: Set<string>;
	refused: Set<string>;
	required: Set<string>;
}

interface HistoryWindow {
	/** Only parents with a reply at or after this are treated as active threads. */
	activeSince: number;
	latest: number | null;
	oldest: number;
	/** Keep only active thread parents, and do not move the cursor. */
	threadsOnly: boolean;
}

/** Slack's answer for a thread whose parent is gone: nothing left to read. */
const THREAD_GONE_REASON = "thread_not_found";
/**
 * Slack refusals that are about one conversation and not the session: the
 * conversation is outside what this session can read. A refusal of any other
 * kind (missing_scope, not_allowed_token_type...) would hit every
 * conversation alike, so it ends the run instead of emptying the inventory.
 */
const CONVERSATION_REFUSALS: ReadonlySet<string> = new Set([
	"channel_not_found",
	"not_in_channel",
]);

interface MessagesOutcome {
	gaps: string[];
	hydrated: string[];
	/** Slack answered `ok: false` for the conversation: not part of what this session can read. */
	refused: string[];
}

const wants = (run: Run, stream: string): boolean =>
	run.ctx.requested.has(stream);

function parseAnswer<T>(schema: ZodType<T>, method: string, json: unknown): T {
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new SlackApiError(method, UNRECOGNISED_ANSWER, false, null);
	}
	return parsed.data;
}

function conversationLabel(conversation: SlackConversationObject): string {
	if (conversation.is_im) {
		return `direct message ${conversation.id}`;
	}
	return conversation.name === undefined
		? conversation.id
		: `#${conversation.name}`;
}

/** YYYY-MM-DD in UTC, the granularity Slack search's `after:` accepts. */
function searchDay(seconds: number): string {
	return new Date(seconds * 1000).toISOString().slice(0, 10);
}

async function emitFingerprinted(
	run: Run,
	stream: FingerprintedStream,
	record: RecordData,
): Promise<void> {
	const cursor = run.cursors.get(stream);
	if (cursor && !cursor.shouldEmit(record)) {
		return;
	}
	await run.ctx.emitRecord(stream, record);
}

/**
 * Count one workspace's full scan toward the stream's boundary proof, only
 * after its enumeration succeeded: every item the source listed was
 * considered, and each was either emitted or suppressed as unchanged. The
 * proof goes out once per stream when the run finishes, summed across the
 * workspaces read; a scan that found nothing adds zero, which is how an
 * empty stream proves coverage instead of merely lacking evidence of it.
 */
function countFullScan(
	run: Run,
	stream: FingerprintedStream,
	considered: number,
): void {
	run.fullScanConsidered.set(
		stream,
		(run.fullScanConsidered.get(stream) ?? 0) + considered,
	);
}

/** Every page of a cursor-paginated list method. */
async function listAll<
	T extends {
		response_metadata?: { next_cursor?: string | undefined } | undefined;
	},
>(
	run: Run,
	teamId: string,
	method: string,
	params: Record<string, string>,
	schema: ZodType<T>,
): Promise<T[]> {
	const pages: T[] = [];
	let cursor = "";
	for (let pageNo = 0; pageNo < MAX_LIST_PAGES; pageNo += 1) {
		const answer = parseAnswer(
			schema,
			method,
			await run.api.call(
				teamId,
				method,
				cursor === "" ? params : { ...params, cursor },
			),
		);
		pages.push(answer);
		cursor = answer.response_metadata?.next_cursor ?? "";
		if (cursor === "") {
			return pages;
		}
	}
	// The page cap ran out with a cursor still in hand: the list was not read
	// to its end, and a STATE built on these pages would claim a boundary the
	// source never named. The run fails instead; nothing moves past what was
	// actually read.
	throw new SlackApiError(method, PAGE_CAP_REASON, true, null);
}

/**
 * `items` through `worker`, `size` at a time. The first error stops new
 * work and is rethrown once the lanes that were mid-item finish.
 */
async function runPool<T>(
	items: readonly T[],
	size: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const state: { failure: { error: unknown } | null; next: number } = {
		failure: null,
		next: 0,
	};
	const lane = async (): Promise<void> => {
		while (state.next < items.length && state.failure === null) {
			const item = items[state.next];
			state.next += 1;
			if (item === undefined) {
				return;
			}
			try {
				await worker(item);
			} catch (error) {
				state.failure ??= { error };
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(size, items.length)) }, lane),
	);
	if (state.failure !== null) {
		throw state.failure.error;
	}
}

// ─── Directory streams ──────────────────────────────────────────────────

async function collectWorkspace(run: Run, team: SignedInTeam): Promise<void> {
	const auth = parseAnswer(
		authTestSchema,
		"auth.test",
		await run.api.call(team.id, "auth.test", {}),
	);
	let info: TeamInfoAnswer | null = null;
	try {
		info = parseAnswer(
			teamInfoSchema,
			"team.info",
			await run.api.call(team.id, "team.info", {}),
		);
	} catch (error) {
		// team.info only adds the domain and icon; auth.test already names the team.
		if (!(error instanceof SlackApiError) || isHostFault(error)) {
			throw error;
		}
	}
	const record = buildWorkspace(auth, info);
	if (record !== null) {
		await emitFingerprinted(run, "workspace", record);
		countFullScan(run, "workspace", 1);
	}
}

async function collectUsers(run: Run, team: SignedInTeam): Promise<void> {
	await run.ctx.progress("Reading the workspace directory", {
		stream: "users",
	});
	const pages = await listAll(
		run,
		team.id,
		"users.list",
		{ limit: USERS_PAGE_LIMIT },
		usersListSchema,
	);
	let members = 0;
	for (const page of pages) {
		for (const member of page.members ?? []) {
			members += 1;
			await emitFingerprinted(run, "users", buildUser(member));
		}
	}
	countFullScan(run, "users", members);
}

async function listConversations(
	run: Run,
	team: SignedInTeam,
): Promise<SlackConversationObject[]> {
	await run.ctx.progress("Listing the conversations you belong to", {
		stream: "channels",
	});
	const types = run.options.channelTypes
		.map((kind) => CONVERSATION_TYPES[kind])
		.join(",");
	const pages = await listAll(
		run,
		team.id,
		"users.conversations",
		{ types, limit: LIST_PAGE_LIMIT, exclude_archived: "false" },
		conversationsListSchema,
	);
	const allowed = new Set(
		run.options.channelAllowlist.map((entry) => entry.toLowerCase()),
	);
	return pages
		.flatMap((page) => page.channels ?? [])
		.filter(
			(conversation) =>
				allowed.size === 0 ||
				allowed.has(conversation.id.toLowerCase()) ||
				allowed.has((conversation.name ?? "").toLowerCase()),
		);
}

async function collectChannels(
	run: Run,
	conversations: readonly SlackConversationObject[],
): Promise<void> {
	for (const conversation of conversations) {
		await emitFingerprinted(run, "channels", buildChannel(conversation));
	}
	countFullScan(run, "channels", conversations.length);
}

// ─── Messages: plan and discovery ───────────────────────────────────────

function readMessagesCursor(raw: unknown): MessagesCursor | null {
	const parsed = messagesCursorSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * Where each conversation's read starts. A stored cursor is used only when
 * its own floor reaches at least as far back as this run asks for; a run
 * that asks for more history than the cursor covers walks every
 * conversation down to the new floor.
 */
function planMessages(run: Run): MessagesPlan {
	const nowSec = Math.floor(run.now().getTime() / 1000);
	const lookbackFloor =
		run.options.lookbackDays > 0
			? nowSec - run.options.lookbackDays * 86_400
			: 0;
	const since = run.ctx.requested.get("messages")?.time_range?.since;
	const parsedSince =
		since === undefined ? Number.NaN : Math.floor(Date.parse(since) / 1000);
	const sinceSec = Number.isFinite(parsedSince) ? parsedSince : 0;
	const floorSec = Math.max(lookbackFloor, sinceSec);
	const backfillFloor =
		run.options.maxBackfillDays > 0
			? nowSec - run.options.maxBackfillDays * 86_400
			: 0;
	const stored = run.fullRefresh
		? null
		: readMessagesCursor(run.ctx.state.messages);
	const covers = stored !== null && stored.floor_ts <= floorSec;
	return {
		backfillFloorSec: backfillFloor,
		channelLastTs: covers ? { ...stored.channel_last_ts } : {},
		floorSec,
		nextFloorSec: covers ? Math.min(stored.floor_ts, floorSec) : floorSec,
		repliesCheckedSec: covers ? (stored.replies_checked_ts ?? null) : null,
		resumeClampSec: Math.max(sinceSec, backfillFloor),
		runSec: nowSec,
	};
}

/**
 * One conversation's starting line and the replies it owes a look for. A
 * first read starts at the floor. A later read starts a week before its
 * cursor however far back that is (a long pause catches up instead of
 * skipping to the floor), clamped only by the requested start and the
 * owner's max backfill. Replies are owed from a week before the last run
 * started, or from the starting line when the cursor does not say when that
 * was, and from further back still when a pending gap says so.
 */
function conversationWindow(
	plan: MessagesPlan,
	conversationId: string,
	pendingRepliesSince: number | undefined,
): ConversationWindow {
	const last = plan.channelLastTs[conversationId];
	if (last === undefined) {
		return {
			clamped: false,
			headOldest: plan.floorSec,
			repliesSince: plan.floorSec,
		};
	}
	const fromCursor = Math.max(
		0,
		Math.floor(slackTsSeconds(last)) - LATE_REPLY_LOOKBACK_SECONDS,
	);
	const headOldest = Math.max(plan.resumeClampSec, fromCursor);
	// A cursor is the newest message read, never later than the run that read
	// it, so a week before that run is never older than a week before the
	// cursor: a quiet conversation's old cursor does not drag the reply search
	// back with it.
	const checked =
		plan.repliesCheckedSec === null
			? headOldest
			: plan.repliesCheckedSec - LATE_REPLY_LOOKBACK_SECONDS;
	const owed =
		pendingRepliesSince === undefined
			? checked
			: Math.min(checked, pendingRepliesSince);
	return {
		// A requested start that cuts the catch-up short is the grant's own
		// boundary, not history lost: only the max backfill is reported.
		clamped: fromCursor < plan.backfillFloorSec,
		headOldest,
		repliesSince: Math.max(plan.resumeClampSec, owed),
	};
}

/**
 * Which threads got a reply since `sinceSec`, per conversation, from Slack
 * search: parents whose replies are active whatever the age of the parent
 * itself. Null when search did not cover the window (unavailable, failed, or
 * past its page cap), so each conversation scans below its starting line
 * instead.
 */
async function discoverThreads(
	run: Run,
	team: SignedInTeam,
	sinceSec: number,
): Promise<Map<string, Set<string>> | null> {
	await run.ctx.progress("Asking Slack which threads got replies", {
		stream: "messages",
	});
	const found = await searchSinceFloor(run, team, sinceSec);
	return found?.complete ? found.threadsByChannel : null;
}

interface SearchFindings {
	/** Whether every page was read, so the thread list is complete. */
	complete: boolean;
	threadsByChannel: Map<string, Set<string>>;
}

/**
 * Everything written since the floor, from Slack search: which thread
 * parents got a reply (search links a reply to its parent through the
 * permalink's `thread_ts`). Search is paged 100 at a time and rate limited
 * more tightly than history, so a run reads at most MAX_SEARCH_PAGES pages
 * and reports the list incomplete beyond that.
 */
async function searchSinceFloor(
	run: Run,
	team: SignedInTeam,
	floorSec: number,
): Promise<SearchFindings | null> {
	const findings: SearchFindings = {
		complete: false,
		threadsByChannel: new Map(),
	};
	// `after:` is exclusive of the named day; step one day back to cover the floor itself.
	const query = `after:${searchDay(floorSec - 86_400)}`;
	for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
		let json: unknown;
		try {
			json = await run.api.call(team.id, "search.messages", {
				query,
				count: SEARCH_PAGE_COUNT,
				page: String(page),
				sort: "timestamp",
			});
		} catch (error) {
			if (!(error instanceof SlackApiError) || isHostFault(error)) {
				throw error;
			}
			return page === 1 ? null : findings;
		}
		const parsed = searchMessagesSchema.safeParse(json);
		if (!parsed.success) {
			return page === 1 ? null : findings;
		}
		for (const match of parsed.data.messages?.matches ?? []) {
			const channelId = match.channel?.id;
			if (channelId === undefined) {
				continue;
			}
			const parent = THREAD_TS_IN_PERMALINK.exec(match.permalink ?? "")?.[1];
			if (parent !== undefined) {
				let threads = findings.threadsByChannel.get(channelId);
				if (threads === undefined) {
					threads = new Set();
					findings.threadsByChannel.set(channelId, threads);
				}
				threads.add(parent);
			}
		}
		const paging = parsed.data.messages?.paging;
		const reportedPage = paging?.page;
		const totalPages = paging?.pages;
		if (
			typeof reportedPage !== "number" ||
			typeof totalPages !== "number" ||
			reportedPage !== page
		) {
			// A page that does not confirm where its own list ends (no paging
			// block, or one that does not match the page just read) is no proof
			// of the end: stop and let the caller fall back to walking history.
			break;
		}
		if (page >= totalPages) {
			findings.complete = true;
			return findings;
		}
	}
	return findings;
}

// ─── Messages: the walk ─────────────────────────────────────────────────

async function emitMessage(
	run: Run,
	channelId: string,
	message: SlackMessageObject,
): Promise<void> {
	// The record carries source times only: parseMessageRow's sent_at comes
	// from the message's own ts, and the connector's clock answers only when
	// Slack served a ts that cannot be parsed. The emitted_at on the record
	// envelope is the runtime's to stamp; the connector never reads it.
	const family = buildMessageFamily(
		channelId,
		message,
		run.now().toISOString(),
	);
	const messageKey = family.message.id;
	if (
		typeof messageKey === "string" &&
		messageKey !== "" &&
		!run.messagesSeen.has(messageKey)
	) {
		run.messagesSeen.add(messageKey);
		run.messagesRead.push(messageKey);
		if (family.fileGaps > 0) {
			run.fileGaps.set(messageKey, { channelId, ts: message.ts });
		}
	}
	// The message record itself is the parent the detail streams hang off:
	// when only a detail stream was asked for, its message ids still need a
	// parent record to reference, so messages emit for any family stream.
	const emitMessageRecord =
		wants(run, "messages") ||
		wants(run, "message_attachments") ||
		wants(run, "reactions") ||
		wants(run, "files");
	if (emitMessageRecord) {
		await run.ctx.emitRecord("messages", family.message);
		run.messagesEmitted += 1;
	}
	const details: ReadonlyArray<[string, RecordData[]]> = [
		["message_attachments", family.attachments],
		["reactions", family.reactions],
		["files", family.files],
	];
	for (const [stream, records] of details) {
		if (!wants(run, stream)) {
			continue;
		}
		for (const record of records) {
			await run.ctx.emitRecord(stream, record);
		}
	}
}

/** A whole thread. The parent comes back as the first reply and is emitted only when asked. */
async function emitThread(
	run: Run,
	team: SignedInTeam,
	channelId: string,
	parentTs: string,
	includeParent: boolean,
): Promise<void> {
	let cursor = "";
	for (let pageNo = 0; pageNo < MAX_PAGES_PER_THREAD; pageNo += 1) {
		const params: Record<string, string> = {
			channel: channelId,
			ts: parentTs,
			limit: HISTORY_PAGE_LIMIT,
		};
		if (cursor !== "") {
			params.cursor = cursor;
		}
		let answer: ReturnType<typeof historySchema.parse>;
		try {
			answer = parseAnswer(
				historySchema,
				"conversations.replies",
				await run.api.call(team.id, "conversations.replies", params),
			);
		} catch (error) {
			// A thread Slack no longer serves (deleted, or its parent was) is not
			// a reason to give up on the conversation around it. An answer this
			// connector cannot parse is a different fault: the thread was not
			// read, and swallowing it would truncate the thread as if its last
			// page had said so, so it is rethrown to the conversation's own
			// error handling.
			// Only Slack's own "this thread is gone" answer ends the thread
			// quietly; any other refusal (missing_scope, not_in_channel...)
			// goes to the conversation's error handling, so the thread is never
			// counted as read when it was not.
			if (
				error instanceof SlackApiError &&
				error.refusedBySlack &&
				error.reason === THREAD_GONE_REASON
			) {
				return;
			}
			throw error;
		}
		for (const reply of answer.messages ?? []) {
			if (reply.ts !== parentTs || (includeParent && pageNo === 0)) {
				await emitMessage(run, channelId, reply);
			}
		}
		cursor = answer.response_metadata?.next_cursor ?? "";
		if (!answer.has_more || cursor === "") {
			return;
		}
	}
	// The page cap ran out with `has_more` still true: the thread was not read
	// to its end. Throwing sends the conversation to the gap handling instead
	// of reporting a thread that was cut short as fully read.
	throw new SlackApiError("conversations.replies", PAGE_CAP_REASON, true, null);
}

function historyParams(
	channelId: string,
	window: HistoryWindow,
	cursor: string,
): Record<string, string> {
	const params: Record<string, string> = {
		channel: channelId,
		limit: HISTORY_PAGE_LIMIT,
	};
	if (window.oldest > 0) {
		params.oldest = String(window.oldest);
	}
	if (window.latest !== null) {
		params.latest = String(window.latest);
	}
	if (cursor !== "") {
		params.cursor = cursor;
	}
	return params;
}

/** One window of a conversation, newest page first. Returns the newest ts read outside a threads-only pass. */
async function walkHistory(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	window: HistoryWindow,
	fetchedThreads: Set<string>,
): Promise<string | null> {
	let cursor = "";
	let newestTs: string | null = null;
	for (let pageNo = 0; pageNo < MAX_PAGES_PER_CONVERSATION; pageNo += 1) {
		const answer = parseAnswer(
			historySchema,
			"conversations.history",
			await run.api.call(
				team.id,
				"conversations.history",
				historyParams(conversation.id, window, cursor),
			),
		);
		for (const message of answer.messages ?? []) {
			const active =
				isThreadParent(message) &&
				threadActiveSince(message, window.activeSince);
			if (window.threadsOnly && !active) {
				continue;
			}
			await emitMessage(run, conversation.id, message);
			if (active && !fetchedThreads.has(message.ts)) {
				fetchedThreads.add(message.ts);
				await emitThread(run, team, conversation.id, message.ts, false);
			}
			if (
				!window.threadsOnly &&
				slackTsSeconds(message.ts) > slackTsSeconds(newestTs ?? undefined)
			) {
				newestTs = message.ts;
			}
		}
		await run.ctx.progress(
			`${conversationLabel(conversation)}: ${run.messagesEmitted} messages read this run`,
			{ count: run.messagesEmitted, stream: "messages" },
		);
		cursor = answer.response_metadata?.next_cursor ?? "";
		if (!answer.has_more || cursor === "") {
			return newestTs;
		}
	}
	await run.ctx.progress(
		`${conversationLabel(conversation)}: stopped after ${MAX_PAGES_PER_CONVERSATION} pages with more history left`,
		{ stream: "messages" },
	);
	// The page cap ran out with `has_more` still true: the messages between
	// the last page read and the window floor were not read. Returning the
	// newest ts would let the cursor move past them and lose them, so this
	// goes to the conversation's gap handling: the read is retried next run
	// and the cursor stays where it was.
	throw new SlackApiError("conversations.history", PAGE_CAP_REASON, true, null);
}

/**
 * Whether the conversation has any message older than `beforeSec`: one
 * single-message page below the line a thread scan stopped at.
 */
async function hasHistoryBefore(
	run: Run,
	team: SignedInTeam,
	conversationId: string,
	beforeSec: number,
): Promise<boolean> {
	const answer = parseAnswer(
		historySchema,
		"conversations.history",
		await run.api.call(team.id, "conversations.history", {
			channel: conversationId,
			latest: String(beforeSec),
			limit: "1",
		}),
	);
	return (answer.messages ?? []).length > 0;
}

/**
 * Read one conversation's window and the threads below it that owe a look.
 * Returns whether the thread scan below the window stopped at its bound with
 * older history left, so replies there may have been missed.
 */
async function walkConversation(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	plan: MessagesPlan,
	window: ConversationWindow,
	threadsByChannel: Map<string, Set<string>> | null,
): Promise<{ boundHit: boolean }> {
	const last = plan.channelLastTs[conversation.id];
	const { headOldest, repliesSince } = window;
	const fetchedThreads = new Set<string>();
	const newest = await walkHistory(
		run,
		team,
		conversation,
		{
			activeSince: headOldest,
			latest: null,
			oldest: headOldest,
			threadsOnly: false,
		},
		fetchedThreads,
	);
	let boundHit = false;
	if (threadsByChannel !== null) {
		// Threads search saw a reply in: their parents may be far below the floor.
		for (const parentTs of threadsByChannel.get(conversation.id) ?? []) {
			if (fetchedThreads.has(parentTs)) {
				continue;
			}
			fetchedThreads.add(parentTs);
			await emitThread(run, team, conversation.id, parentTs, true);
		}
	} else if (headOldest > 0) {
		// Search did not name the threads: scan the month below the starting
		// line for parents with a reply the conversation still owes a look at.
		const scanOldest = Math.max(0, headOldest - THREAD_LOOKBACK_SECONDS);
		await walkHistory(
			run,
			team,
			conversation,
			{
				activeSince: repliesSince,
				latest: headOldest,
				oldest: scanOldest,
				threadsOnly: true,
			},
			fetchedThreads,
		);
		// Older parents than the scan reached may have replies too; whether
		// any exist is one small read, and a conversation with older history
		// is reported instead of being taken as fully read.
		boundHit =
			scanOldest > 0 &&
			(await hasHistoryBefore(run, team, conversation.id, scanOldest));
	}
	if (
		newest !== null &&
		(last === undefined || slackTsSeconds(newest) > slackTsSeconds(last))
	) {
		plan.channelLastTs[conversation.id] = newest;
	}
	return { boundHit };
}

/** File a conversation left to retry: a DETAIL_GAP that also carries the replies it still owes a look for. */
async function emitConversationGap(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	window: ConversationWindow,
	outcome: MessagesOutcome,
	gap: {
		error: { class: string; httpStatus: number | null; message: string };
		reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable";
	},
): Promise<void> {
	outcome.gaps.push(conversation.id);
	await emitDetailGap(run.ctx, {
		error: {
			class: gap.error.class,
			...(gap.error.httpStatus === null
				? {}
				: { httpStatus: gap.error.httpStatus }),
			message: gap.error.message,
		},
		locator: {
			kind: "slack_conversation",
			channel_id: conversation.id,
			team_id: team.id,
			thread_replies_since: window.repliesSince,
		},
		reason: gap.reason,
		recordKey: conversation.id,
		stream: "messages",
	});
}

/** Read one conversation, filing the outcome; only faults that end the run escape. */
async function readConversation(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	plan: MessagesPlan,
	window: ConversationWindow,
	threadsByChannel: Map<string, Set<string>> | null,
	outcome: MessagesOutcome,
): Promise<void> {
	await run.ctx.progress(`Reading ${conversationLabel(conversation)}`, {
		count: run.messagesEmitted,
		stream: "messages",
	});
	try {
		const { boundHit } = await walkConversation(
			run,
			team,
			conversation,
			plan,
			window,
			threadsByChannel,
		);
		if (!boundHit) {
			outcome.hydrated.push(conversation.id);
			return;
		}
		// The window itself was read, so its cursor moved; the threads below
		// the scan were not all looked at. The gap carries the oldest reply
		// still owed, so a later run with search back looks that far again.
		await emitConversationGap(run, team, conversation, window, outcome, {
			error: {
				class: "collection_bound",
				httpStatus: null,
				message: THREAD_SCAN_BOUND_REASON,
			},
			reason: "temporary_unavailable",
		});
	} catch (error) {
		if (!(error instanceof SlackApiError) || isHostFault(error)) {
			throw error;
		}
		if (!error.retryable) {
			// Slack will keep answering the same way; a gap would never close.
			if (error.refusedBySlack && CONVERSATION_REFUSALS.has(error.reason)) {
				outcome.refused.push(conversation.id);
				return;
			}
			// An answer this connector cannot parse is a permanent fault on data
			// the owner owns: Slack will answer the same unparseable shape on
			// every run, so a DETAIL_GAP here would be re-attempted forever
			// while every run stayed partial. Throwing ends the run closed with
			// the source_unreadable skip the runtime surfaces, instead of an
			// eternally retryable temporary_unavailable gap.
			throw error;
		}
		await emitConversationGap(run, team, conversation, window, outcome, {
			error: {
				class: "upstream_pressure",
				httpStatus: error.httpStatus,
				message: error.reason,
			},
			reason:
				error.reason === "ratelimited"
					? "rate_limited"
					: error.reason === PAGE_CAP_REASON
						? "temporary_unavailable"
						: "retry_exhausted",
		});
	}
}

/**
 * The pending `messages` gaps the runtime served for prior runs, keyed by the
 * conversation the gap hangs off. The run's first page is `detailGaps`; the
 * rest, if any, come from `requestDetailGapPage` until a page answers with
 * nothing this run has not already seen. Empty when the host offered no gap
 * service, so there is nothing to recover. Read once per run: every
 * workspace settles its own conversations' gaps from the same map.
 */
async function pendingDetailGaps(
	ctx: SlackBrowserCollectContext,
): Promise<Map<string, PendingGap[]>> {
	const messages = new Map<string, PendingGap[]>();
	const seen = new Set<string>();
	const entry = (gap: DetailGapStartEntry): PendingGap => {
		const teamId = gap.detail_locator?.team_id;
		const repliesSince = gap.detail_locator?.thread_replies_since;
		return {
			gapId: gap.gap_id,
			...(gap.lease_id === undefined ? {} : { leaseId: gap.lease_id }),
			...(typeof teamId === "string" && teamId !== "" ? { teamId } : {}),
			...(typeof repliesSince === "number" && Number.isFinite(repliesSince)
				? { repliesSince }
				: {}),
		};
	};
	const add = (gap: DetailGapStartEntry): void => {
		// The runtime answers with the gaps still pending, so recovered ones
		// drop out and one re-emitted this run comes back, already seen.
		if (seen.has(gap.gap_id)) {
			return;
		}
		seen.add(gap.gap_id);
		const key = String(gap.record_key);
		if (key === "") {
			return;
		}
		if (gap.stream !== "messages") {
			return;
		}
		const list = messages.get(key);
		if (list === undefined) {
			messages.set(key, [entry(gap)]);
		} else {
			list.push(entry(gap));
		}
	};
	const first = ctx.detailGaps ?? [];
	for (const gap of first) {
		add(gap);
	}
	// Later pages exist only past a first page START carried. With none, there
	// is nothing to page, and a host that does not page gaps would leave the
	// request unanswered and the run waiting forever.
	if (first.length === 0 || typeof ctx.requestDetailGapPage !== "function") {
		return messages;
	}
	for (;;) {
		const page = await ctx.requestDetailGapPage({ streams: ["messages"] });
		const unseen = page.filter((gap) => !seen.has(gap.gap_id));
		if (unseen.length === 0) {
			return messages;
		}
		for (const gap of unseen) {
			add(gap);
		}
	}
}

/** A pending gap filed for this workspace, or one that does not say which. */
const gapIsFor = (gap: PendingGap, team: SignedInTeam): boolean =>
	gap.teamId === undefined || gap.teamId === team.id;

/**
 * Close the pending gaps of conversations this workspace settled: read to
 * their end, refused to this session, or gone from the workspace's complete
 * conversation list (the owner left, or the allowlist or channel kinds now
 * leave them out). A gone conversation will never be read again, so its gap
 * would otherwise stay open for good. Only gaps filed for this workspace are
 * closed as gone: in a run over several workspaces, another workspace's
 * conversations are absent from this list without having gone anywhere.
 */
async function settlePendingGaps(
	run: Run,
	team: SignedInTeam,
	listed: ReadonlySet<string>,
	outcome: MessagesOutcome,
): Promise<void> {
	const pending = run.pendingGaps;
	if (pending === null) {
		return;
	}
	const settled = new Set([...outcome.hydrated, ...outcome.refused]);
	for (const [id, gaps] of [...pending]) {
		const closing = gaps.filter((gap) =>
			settled.has(id)
				? gapIsFor(gap, team)
				: !listed.has(id) && gap.teamId === team.id,
		);
		if (closing.length === 0) {
			continue;
		}
		for (const gap of closing) {
			await run.ctx.emit({
				type: "DETAIL_GAP_RECOVERED",
				reference_only: true,
				gap_id: gap.gapId,
				...(gap.leaseId === undefined ? {} : { lease_id: gap.leaseId }),
				record_key: id,
				stream: "messages",
			});
		}
		const left = gaps.filter((gap) => !closing.includes(gap));
		if (left.length === 0) {
			pending.delete(id);
		} else {
			pending.set(id, left);
		}
	}
}

/** The oldest reply time a conversation's pending gaps for this workspace still owe. */
function pendingRepliesSince(
	run: Run,
	team: SignedInTeam,
	conversationId: string,
): number | undefined {
	let oldest: number | undefined;
	for (const gap of run.pendingGaps?.get(conversationId) ?? []) {
		if (gapIsFor(gap, team) && gap.repliesSince !== undefined) {
			oldest =
				oldest === undefined
					? gap.repliesSince
					: Math.min(oldest, gap.repliesSince);
		}
	}
	return oldest;
}

async function collectMessages(
	run: Run,
	team: SignedInTeam,
	conversations: readonly SlackConversationObject[],
	plan: MessagesPlan,
): Promise<void> {
	// This workspace's messages, for its files report: another workspace's
	// messages, already in the run's list, stay out.
	const readFrom = run.messagesRead.length;
	run.pendingGaps ??= await pendingDetailGaps(run.ctx);
	const windows = new Map<string, ConversationWindow>();
	for (const conversation of conversations) {
		windows.set(
			conversation.id,
			conversationWindow(
				plan,
				conversation.id,
				pendingRepliesSince(run, team, conversation.id),
			),
		);
	}
	// Search reaches back to the oldest reply any conversation still owes a
	// look for. A conversation read from its very beginning finds every thread
	// on the way and owes none.
	const owed = [...windows.values()]
		.filter((window) => window.headOldest > 0)
		.map((window) => window.repliesSince);
	const threadsByChannel =
		owed.length === 0
			? null
			: await discoverThreads(run, team, Math.min(...owed));
	const clamped = [...windows.values()].filter((w) => w.clamped).length;
	if (clamped > 0) {
		await run.ctx.progress(
			`${clamped} conversations were last read longer ago than SLACK_MAX_BACKFILL_DAYS allows; they are read from ${run.options.maxBackfillDays} days back`,
			{ stream: "messages" },
		);
	}
	const outcome: MessagesOutcome = {
		gaps: [],
		hydrated: [],
		refused: [],
	};
	// Every conversation is read, from its own starting line: the floor for a
	// first read, a week before its stored cursor for a later one. There is no
	// quiet skip: the web client's counts move only when a message lands, so
	// they cannot vouch for a reaction or an edit landing on the newest
	// message they already report, and skipping on them would drop exactly
	// those changes for good.
	const toRead: SlackConversationObject[] = [...conversations];
	await run.ctx.progress(
		`Reading ${toRead.length} of ${conversations.length} conversations`,
		{ stream: "messages" },
	);
	await runPool(toRead, run.concurrency, (conversation) => {
		const window = windows.get(conversation.id);
		if (window === undefined) {
			return Promise.resolve();
		}
		return readConversation(
			run,
			team,
			conversation,
			plan,
			window,
			threadsByChannel,
			outcome,
		);
	});
	// A conversation read to its end closes the gaps prior runs filed for it,
	// and so does one that is refused or no longer listed: each pending gap
	// resolves with its own id, so the runtime's ledger does not keep owing a
	// conversation that now reads clean or that the run will never read again.
	await settlePendingGaps(
		run,
		team,
		new Set(conversations.map((conversation) => conversation.id)),
		outcome,
	);
	await run.ctx.progress(
		`Messages: ${run.messagesEmitted} read from ${outcome.hydrated.length} conversations; ${outcome.refused.length} not readable, ${outcome.gaps.length} to retry next run`,
		{ count: run.messagesEmitted, stream: "messages" },
	);
	// A conversation Slack refuses to this session (not_in_channel and the
	// like) is outside the inventory the owner can read: it is reported in
	// optional_skip_keys and left out of the required keys, so one refused
	// conversation cannot hold the messages checkpoint back on every run. Any
	// other lasting failure — an answer this connector cannot parse among
	// them — never becomes an optional skip either: it is a fault on data the
	// owner owns, and a permanent one (Slack answers the same shape every
	// run), so it ends the run closed with source_unreadable instead of
	// filing an eternally retried gap. The boundary is reported once for the
	// whole run when it finishes, every workspace's keys together.
	const refused = new Set(outcome.refused);
	const coverage = run.messagesCoverage;
	for (const conversation of toRead) {
		if (!refused.has(conversation.id)) {
			coverage.required.add(conversation.id);
		}
	}
	for (const id of refused) {
		coverage.refused.add(id);
	}
	for (const id of outcome.gaps) {
		coverage.gaps.add(id);
	}
	for (const id of outcome.hydrated) {
		coverage.hydrated.add(id);
	}
	// files is its own checkpoint parent: a conversation left to retry means
	// the window's files are not all read, so the files STATE is withheld this
	// run. A file Slack served with no id can never become a record (it has
	// nothing to be keyed by) and Slack serves it the same way on every run:
	// it is reported here and does not hold the checkpoint back. It is not a
	// DETAIL_GAP either: no retry can close it, and files has no parent
	// stream to hang a gap off.
	const teamMessages = run.messagesRead.slice(readFrom);
	const idlessFiles = teamMessages.filter((id) => run.fileGaps.has(id)).length;
	// Accumulated across teams: a later team that reads clean must not clear
	// an earlier team's conversations left to retry.
	run.filesIncomplete ||= outcome.gaps.length > 0;
	if (wants(run, "files") && (outcome.gaps.length > 0 || idlessFiles > 0)) {
		await run.ctx.progress(
			`Files: ${outcome.gaps.length} conversations to retry${run.filesIncomplete ? " (not checkpointed this run)" : ""}; ${idlessFiles} messages named a file Slack served with no id`,
			{ stream: "files" },
		);
	}
}

/**
 * The run's coverage, once per stream, after every workspace was read: each
 * full scan's size summed across workspaces, and the messages boundary with
 * the derived streams that hang off the messages read.
 */
async function emitRunCoverage(
	run: Run,
	plan: MessagesPlan | null,
): Promise<void> {
	for (const stream of FINGERPRINTED) {
		const considered = run.fullScanConsidered.get(stream);
		if (considered === undefined || run.failed.has(stream)) {
			continue;
		}
		await run.ctx.emit(buildFullScanCoverageMessage(stream, considered));
	}
	if (plan === null) {
		return;
	}
	// A conversation shared between two workspaces (Slack Connect) is one key:
	// left to retry if either read left it, hydrated only if none did, and an
	// optional skip only if no workspace could read it.
	const { gaps, hydrated, refused, required } = run.messagesCoverage;
	const hydratedKeys = [...hydrated].filter((id) => !gaps.has(id));
	await emitDetailCoverage(run.ctx, {
		considered: required.size,
		covered: hydratedKeys.length,
		gapKeys: [...gaps],
		hydratedKeys,
		optionalSkipKeys: [...refused].filter((id) => !required.has(id)),
		requiredKeys: [...required],
		stateStream: "messages",
		stream: "messages",
	});
	// message_attachments and reactions hang off each message read: their
	// parent boundary is the messages this run read, and their details ride
	// on the message object, so no message can be read without them.
	for (const stream of ["message_attachments", "reactions"] as const) {
		if (!wants(run, stream)) {
			continue;
		}
		await emitDetailCoverage(run.ctx, {
			considered: run.messagesRead.length,
			covered: run.messagesRead.length,
			hydratedKeys: run.messagesRead,
			requiredKeys: run.messagesRead,
			stateStream: "messages",
			stream,
		});
	}
}

// ─── Optional directory streams ─────────────────────────────────────────

async function readUserGroups(
	run: Run,
	team: SignedInTeam,
): Promise<RecordData[]> {
	const answer = parseAnswer(
		userGroupsListSchema,
		"usergroups.list",
		await run.api.call(team.id, "usergroups.list", {
			include_users: "true",
			include_count: "true",
			include_disabled: "true",
		}),
	);
	return (answer.usergroups ?? []).map(buildUserGroup);
}

async function readReminders(
	run: Run,
	team: SignedInTeam,
): Promise<RecordData[]> {
	const answer = parseAnswer(
		remindersListSchema,
		"reminders.list",
		await run.api.call(team.id, "reminders.list", {}),
	);
	return (answer.reminders ?? []).map(buildReminder);
}

async function readStars(run: Run, team: SignedInTeam): Promise<RecordData[]> {
	const pages = await listAll(
		run,
		team.id,
		"stars.list",
		{ count: "100" },
		starsListSchema,
	);
	return pages.flatMap((page) => (page.items ?? []).map(buildStar));
}

/**
 * An optional stream Slack refuses for good (`missing_scope`, a method the
 * workspace no longer serves) is skipped with a reason; the rest of the run
 * continues. A retryable failure — a rate limit, a 5xx, a page cap — is not
 * one: it ends the run so the runtime retries it whole, the same way a
 * required stream's failure does. A session rejection still ends the run.
 */
async function collectOptional(
	run: Run,
	team: SignedInTeam,
	stream: FingerprintedStream,
	read: () => Promise<RecordData[]>,
): Promise<void> {
	if (!wants(run, stream) || run.failed.has(stream)) {
		return;
	}
	await run.ctx.progress(`Reading ${stream.replace("_", " ")}`, { stream });
	let records: RecordData[];
	try {
		records = await read();
	} catch (error) {
		if (
			!(error instanceof SlackApiError) ||
			isHostFault(error) ||
			error.retryable
		) {
			throw error;
		}
		run.failed.add(stream);
		await run.ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "optional_stream_failed",
			message: `Slack did not serve ${error.method} for ${team.name || team.id}: ${error.reason}`,
			diagnostics: { method: error.method, reason: error.reason },
		});
		return;
	}
	for (const record of records) {
		await emitFingerprinted(run, stream, record);
	}
	countFullScan(run, stream, records.length);
}

// ─── Run ────────────────────────────────────────────────────────────────

async function collectTeam(
	run: Run,
	team: SignedInTeam,
	plan: MessagesPlan | null,
): Promise<void> {
	await run.ctx.progress(
		`Reading workspace ${team.name || team.domain || team.id}`,
		{ stream: "workspace" },
	);
	if (wants(run, "workspace")) {
		await collectWorkspace(run, team);
	}
	if (wants(run, "users")) {
		await collectUsers(run, team);
	}
	// Channels are the parent every message references: when the message
	// family is requested, the conversations it reads are listed and their
	// channel records emit too, whatever the requested set says, so no
	// message lands without its parent channel in the same run.
	const conversations =
		wants(run, "channels") || plan !== null
			? await listConversations(run, team)
			: [];
	if (wants(run, "channels") || plan !== null) {
		await collectChannels(run, conversations);
	}
	if (plan !== null) {
		await collectMessages(run, team, conversations, plan);
	}
	await collectOptional(run, team, "user_groups", () =>
		readUserGroups(run, team),
	);
	await collectOptional(run, team, "reminders", () => readReminders(run, team));
	await collectOptional(run, team, "stars", () => readStars(run, team));
}

interface Abort {
	/**
	 * Which lasting way the run ended. The SKIP_RESULT reason is spelled out
	 * as a literal per branch at the emission site, so every emitted reason
	 * code stays a finite, statically visible set.
	 */
	kind: "challenge" | "session" | "interrupted" | "unrecognised";
	message: string;
}

/** The SKIP_RESULT every requested stream gets when the run cannot go on; anything unexpected is rethrown. */
function classifyAbort(error: unknown): Abort {
	if (error instanceof SlackSessionLostError) {
		return {
			kind: "session",
			message:
				"Slack rejected the browser session while reading. Sign in again and run the connector once more.",
		};
	}
	if (error instanceof SlackApiError) {
		if (isHostFault(error)) {
			return {
				kind: "interrupted",
				message: `The browser page the connector was reading from went away (${error.reason}), so reading stopped. Keep the connector's browser window open until the run finishes.`,
			};
		}
		if (error.reason === CHALLENGE_REASON) {
			// An edge challenge (Cloudflare and the like) answered where JSON
			// was expected. The session is fine and nothing is on fire: the
			// owner passes the check in the browser, and the next run reads
			// again from where this one stopped.
			return {
				kind: "challenge",
				message: `Slack (or its edge) is checking this browser with a challenge page (HTTP ${error.httpStatus ?? "unknown status"}). Pass the check in the connector's browser window, then run the connector again.`,
			};
		}
		if (error.retryable) {
			return {
				kind: "interrupted",
				message: `Slack stopped answering ${error.method} (${error.reason}). The next run reads again from where this one stopped.`,
			};
		}
		return {
			kind: "unrecognised",
			message: `Slack answered ${error.method} with ${error.reason}, which this connector does not understand.`,
		};
	}
	throw error;
}

async function finish(
	run: Run,
	plan: MessagesPlan | null,
	abort: Abort | null,
): Promise<void> {
	if (abort !== null) {
		for (const stream of run.ctx.requested.keys()) {
			if (run.failed.has(stream)) {
				continue;
			}
			await run.ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason:
					abort.kind === "challenge"
						? "source_auth_or_challenge"
						: abort.kind === "session"
							? "sign_in_required"
							: abort.kind === "interrupted"
								? "collection_interrupted"
								: "source_unreadable",
				message: abort.message,
			});
		}
		return;
	}
	await emitRunCoverage(run, plan);
	for (const stream of FINGERPRINTED) {
		const cursor = run.cursors.get(stream);
		if (cursor === undefined || run.failed.has(stream)) {
			continue;
		}
		// Every fingerprinted stream is a full scan: an id the source no longer
		// returns must not keep its fingerprint, or a later re-add would be missed.
		cursor.dropUnseenIds();
		await run.ctx.emit({
			type: "STATE",
			stream,
			// The connector's own clock, not the run envelope's: the record's
			// emitted_at is the runtime's to stamp, and nothing here reads it.
			cursor: {
				synced_at: run.now().toISOString(),
				fingerprints: cursor.toState(),
			},
		});
	}
	// The messages checkpoint follows the walk, not the requested list: a run
	// that read messages only to hang files (or reactions) off them still
	// moved the per-conversation cursors, and the next run reads from there.
	if (plan !== null) {
		await run.ctx.emit({
			type: "STATE",
			stream: "messages",
			cursor: {
				channel_last_ts: plan.channelLastTs,
				floor_ts: plan.nextFloorSec,
				format: 1,
				replies_checked_ts: plan.runSec,
			},
		});
		if (wants(run, "files") && !run.filesIncomplete) {
			await run.ctx.emit({
				type: "STATE",
				stream: "files",
				cursor: {
					synced_at: run.now().toISOString(),
					floor_ts: plan.nextFloorSec,
				},
			});
		}
	}
}

export async function collectSlackBrowser(
	ctx: SlackBrowserCollectContext,
	services: SlackBrowserServices,
	teams: readonly SignedInTeam[],
	options: SlackBrowserOptions,
): Promise<void> {
	const run: Run = {
		api: services.api,
		concurrency: services.concurrency ?? DEFAULT_CONCURRENCY,
		ctx,
		cursors: new Map(),
		failed: new Set(),
		fullScanConsidered: new Map(),
		messagesCoverage: {
			gaps: new Set(),
			hydrated: new Set(),
			refused: new Set(),
			required: new Set(),
		},
		pendingGaps: null,
		fullRefresh: ctx.collectionMode === "full_refresh",
		messagesRead: [],
		messagesSeen: new Set<string>(),
		messagesEmitted: 0,
		fileGaps: new Map(),
		filesIncomplete: false,
		now: services.now,
		options,
	};
	for (const stream of FINGERPRINTED) {
		if (wants(run, stream)) {
			run.cursors.set(
				stream,
				openFingerprintCursor(run.fullRefresh ? undefined : ctx.state[stream], {
					excludeFromFingerprint: FINGERPRINT_EXCLUDE[stream],
				}),
			);
		}
	}
	const plan = MESSAGE_FAMILY.some((stream) => wants(run, stream))
		? planMessages(run)
		: null;
	let abort: Abort | null = null;
	try {
		for (const team of teams) {
			await collectTeam(run, team, plan);
		}
	} catch (error) {
		abort = classifyAbort(error);
	}
	await finish(run, plan, abort);
}
