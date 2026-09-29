// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Stream collection for the Slack browser profile, over an abstract Web API
 * client so the whole walk can be driven by fixtures in index.test.ts.
 *
 * Directory streams (workspace, channels, users, user_groups, reminders,
 * stars) are full scans gated by a per-record fingerprint, so a steady-state
 * run emits nothing for them.
 *
 * `messages` keeps one cursor per conversation: the newest ts read. Before
 * walking, the run asks the web client's own `client.counts` for every open
 * conversation's latest message, and `search.messages` for everything
 * written since the lookback floor. Conversations with nothing in the window
 * are not read at all (most of them, on a workspace with hundreds of quiet
 * direct messages), and the search results name the threads that got a reply
 * inside the window whatever the age of their parent, so those threads are
 * read directly instead of scanning a month of history below the floor.
 * When either signal is unavailable the walk falls back to reading every
 * conversation and, on a first read, scanning below the floor for active
 * threads. A later run reads from a week before each conversation's cursor,
 * so a reply or reaction that arrived on a recent message is seen again.
 *
 * Conversations are read a few at a time. A conversation Slack will not
 * serve this session (`not_in_channel` and the like) is skipped; one Slack
 * stopped answering is reported as a DETAIL_GAP and its cursor stays put, so
 * the next run reads it again. A session rejection, the browser leaving
 * app.slack.com, or the page being closed ends the run with a SKIP_RESULT on
 * every requested stream and no cursor moves.
 */

import type { ZodType } from "zod";
import {
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
	clientCountsSchema,
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
	isHostFault,
	type SlackApiClient,
	SlackApiError,
	SlackSessionLostError,
} from "./web-api.ts";

/** How far below a conversation's cursor a later run reads again, for late replies and reactions. */
export const LATE_REPLY_LOOKBACK_SECONDS = 7 * 24 * 3600;
/** How far below the lookback floor a first read looks for active threads when search is unavailable. */
export const THREAD_LOOKBACK_SECONDS = 30 * 24 * 3600;
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
	emit: (msg: EmittedMessage) => Promise<void>;
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	emittedAt: string;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
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
	fullRefresh: boolean;
	messagesEmitted: number;
	now: () => Date;
	options: SlackBrowserOptions;
}

interface MessagesPlan {
	channelLastTs: Record<string, string>;
	floorSec: number;
	nextFloorSec: number;
}

/** What the web client's own signals say about the window, before any history is read. */
interface Activity {
	/** Conversations with a message in the window; null when `client.counts` did not answer. */
	activeIds: Set<string> | null;
	/** Thread parents, per conversation, that got a reply in the window; null when search did not cover the window. */
	threadsByChannel: Map<string, Set<string>> | null;
}

interface HistoryWindow {
	/** Only parents with a reply at or after this are treated as active threads. */
	activeSince: number;
	latest: number | null;
	oldest: number;
	/** Keep only active thread parents, and do not move the cursor. */
	threadsOnly: boolean;
}

interface MessagesOutcome {
	gaps: string[];
	hydrated: string[];
	skippedQuiet: string[];
	unreadable: string[];
}

const wants = (run: Run, stream: string): boolean =>
	run.ctx.requested.has(stream);

function parseAnswer<T>(schema: ZodType<T>, method: string, json: unknown): T {
	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new SlackApiError(method, "unrecognised_answer", false, null);
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
			break;
		}
	}
	return pages;
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
	const record = buildWorkspace(auth, info, run.ctx.emittedAt);
	if (record !== null) {
		await emitFingerprinted(run, "workspace", record);
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
	for (const page of pages) {
		for (const member of page.members ?? []) {
			await emitFingerprinted(run, "users", buildUser(member));
		}
	}
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
	const sinceSec =
		since === undefined ? Number.NaN : Math.floor(Date.parse(since) / 1000);
	const floorSec = Number.isFinite(sinceSec)
		? Math.max(lookbackFloor, sinceSec)
		: lookbackFloor;
	const stored = run.fullRefresh
		? null
		: readMessagesCursor(run.ctx.state.messages);
	const covers = stored !== null && stored.floor_ts <= floorSec;
	return {
		channelLastTs: covers ? { ...stored.channel_last_ts } : {},
		floorSec,
		nextFloorSec: covers ? Math.min(stored.floor_ts, floorSec) : floorSec,
	};
}

/**
 * The conversations `client.counts` says have a message at or after the
 * floor. A conversation the client does not count (a closed direct message,
 * an archived channel) has had nothing new, or it would be open. Null when
 * the method did not answer, so the caller reads everything.
 */
async function activeByCounts(
	run: Run,
	team: SignedInTeam,
	floorSec: number,
): Promise<Set<string> | null> {
	let json: unknown;
	try {
		json = await run.api.call(team.id, "client.counts", {});
	} catch (error) {
		if (!(error instanceof SlackApiError) || isHostFault(error)) {
			throw error;
		}
		return null;
	}
	const parsed = clientCountsSchema.safeParse(json);
	if (!parsed.success) {
		return null;
	}
	const active = new Set<string>();
	for (const entries of [
		parsed.data.channels,
		parsed.data.ims,
		parsed.data.mpims,
	]) {
		for (const entry of entries ?? []) {
			if (slackTsSeconds(entry.latest) >= floorSec) {
				active.add(entry.id);
			}
		}
	}
	return active;
}

interface SearchFindings {
	channelIds: Set<string>;
	/** Whether every page was read, so the thread list is complete. */
	complete: boolean;
	threadsByChannel: Map<string, Set<string>>;
}

/**
 * Everything written since the floor, from Slack search: which conversations
 * it landed in, and which thread parents got a reply (search links a reply
 * to its parent through the permalink's `thread_ts`). Search is paged 100
 * at a time and rate limited more tightly than history, so a run reads at
 * most MAX_SEARCH_PAGES pages and reports the list incomplete beyond that.
 */
async function searchSinceFloor(
	run: Run,
	team: SignedInTeam,
	floorSec: number,
): Promise<SearchFindings | null> {
	const findings: SearchFindings = {
		channelIds: new Set(),
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
			findings.channelIds.add(channelId);
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
		const pages = parsed.data.messages?.paging?.pages ?? 1;
		if (page >= pages) {
			findings.complete = true;
			return findings;
		}
	}
	return findings;
}

async function discoverActivity(
	run: Run,
	team: SignedInTeam,
	plan: MessagesPlan,
): Promise<Activity> {
	if (plan.floorSec <= 0) {
		// The whole history was asked for; every conversation is read anyway.
		return { activeIds: null, threadsByChannel: null };
	}
	await run.ctx.progress("Asking Slack which conversations changed", {
		stream: "messages",
	});
	const counted = await activeByCounts(run, team, plan.floorSec);
	const found = await searchSinceFloor(run, team, plan.floorSec);
	let activeIds: Set<string> | null = counted;
	if (activeIds !== null && found !== null) {
		activeIds = new Set([...activeIds, ...found.channelIds]);
	}
	return {
		activeIds,
		threadsByChannel: found?.complete ? found.threadsByChannel : null,
	};
}

// ─── Messages: the walk ─────────────────────────────────────────────────

async function emitMessage(
	run: Run,
	channelId: string,
	message: SlackMessageObject,
): Promise<void> {
	const family = buildMessageFamily(channelId, message, run.ctx.emittedAt);
	if (wants(run, "messages")) {
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
			// a reason to give up on the conversation around it.
			if (
				error instanceof SlackApiError &&
				!(error.retryable || isHostFault(error))
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
		`${conversationLabel(conversation)}: stopped after ${MAX_PAGES_PER_CONVERSATION} pages; older messages were not read`,
		{ stream: "messages" },
	);
	return newestTs;
}

async function walkConversation(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	plan: MessagesPlan,
	activity: Activity,
): Promise<void> {
	const last = plan.channelLastTs[conversation.id];
	const headOldest =
		last === undefined
			? plan.floorSec
			: Math.max(
					plan.floorSec,
					Math.floor(slackTsSeconds(last)) - LATE_REPLY_LOOKBACK_SECONDS,
				);
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
	if (activity.threadsByChannel !== null) {
		// Threads search saw a reply in: their parents may be far below the floor.
		for (const parentTs of activity.threadsByChannel.get(conversation.id) ??
			[]) {
			if (fetchedThreads.has(parentTs)) {
				continue;
			}
			fetchedThreads.add(parentTs);
			await emitThread(run, team, conversation.id, parentTs, true);
		}
	} else if (last === undefined && plan.floorSec > 0) {
		await walkHistory(
			run,
			team,
			conversation,
			{
				activeSince: plan.floorSec,
				latest: plan.floorSec,
				oldest: plan.floorSec - THREAD_LOOKBACK_SECONDS,
				threadsOnly: true,
			},
			fetchedThreads,
		);
	}
	if (
		newest !== null &&
		(last === undefined || slackTsSeconds(newest) > slackTsSeconds(last))
	) {
		plan.channelLastTs[conversation.id] = newest;
	}
}

/** Read one conversation, filing the outcome; only faults that end the run escape. */
async function readConversation(
	run: Run,
	team: SignedInTeam,
	conversation: SlackConversationObject,
	plan: MessagesPlan,
	activity: Activity,
	outcome: MessagesOutcome,
): Promise<void> {
	await run.ctx.progress(`Reading ${conversationLabel(conversation)}`, {
		count: run.messagesEmitted,
		stream: "messages",
	});
	try {
		await walkConversation(run, team, conversation, plan, activity);
		outcome.hydrated.push(conversation.id);
	} catch (error) {
		if (!(error instanceof SlackApiError) || isHostFault(error)) {
			throw error;
		}
		if (!error.retryable) {
			// Slack will keep answering the same way; a gap would never close.
			outcome.unreadable.push(conversation.id);
			return;
		}
		outcome.gaps.push(conversation.id);
		await emitDetailGap(run.ctx, {
			error: {
				class: "upstream_pressure",
				...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus }),
				message: error.reason,
			},
			locator: {
				kind: "slack_conversation",
				channel_id: conversation.id,
				team_id: team.id,
			},
			reason:
				error.reason === "ratelimited" ? "rate_limited" : "retry_exhausted",
			recordKey: conversation.id,
			stream: "messages",
		});
	}
}

async function collectMessages(
	run: Run,
	team: SignedInTeam,
	conversations: readonly SlackConversationObject[],
	plan: MessagesPlan,
): Promise<void> {
	const activity = await discoverActivity(run, team, plan);
	const outcome: MessagesOutcome = {
		gaps: [],
		hydrated: [],
		skippedQuiet: [],
		unreadable: [],
	};
	const toRead: SlackConversationObject[] = [];
	for (const conversation of conversations) {
		if (
			activity.activeIds === null ||
			activity.activeIds.has(conversation.id)
		) {
			toRead.push(conversation);
		} else {
			outcome.skippedQuiet.push(conversation.id);
		}
	}
	await run.ctx.progress(
		`Reading ${toRead.length} of ${conversations.length} conversations; ${outcome.skippedQuiet.length} had nothing new`,
		{ stream: "messages" },
	);
	await runPool(toRead, run.concurrency, (conversation) =>
		readConversation(run, team, conversation, plan, activity, outcome),
	);
	await run.ctx.progress(
		`Messages: ${run.messagesEmitted} read from ${outcome.hydrated.length} conversations; ${outcome.skippedQuiet.length} quiet, ${outcome.unreadable.length} not readable, ${outcome.gaps.length} to retry next run`,
		{ count: run.messagesEmitted, stream: "messages" },
	);
	await emitDetailCoverage(run.ctx, {
		considered: conversations.length,
		// A quiet conversation is accounted for: the client's own counts say nothing landed there.
		covered: outcome.hydrated.length + outcome.skippedQuiet.length,
		gapKeys: outcome.gaps,
		hydratedKeys: outcome.hydrated,
		optionalSkipKeys: outcome.unreadable,
		requiredKeys: toRead.map((conversation) => conversation.id),
		stateStream: "messages",
		stream: "messages",
	});
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
 * An optional stream Slack refuses (a method the workspace no longer serves,
 * a scope this session lacks) is skipped with a reason; the rest of the run
 * continues. A session rejection still ends the run.
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
		if (!(error instanceof SlackApiError) || isHostFault(error)) {
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
	const conversations =
		wants(run, "channels") || plan !== null
			? await listConversations(run, team)
			: [];
	if (wants(run, "channels")) {
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
	message: string;
	reason: string;
}

/** The SKIP_RESULT every requested stream gets when the run cannot go on; anything unexpected is rethrown. */
function classifyAbort(error: unknown): Abort {
	if (error instanceof SlackSessionLostError) {
		return {
			message:
				"Slack rejected the browser session while reading. Sign in again and run the connector once more.",
			reason: "sign_in_required",
		};
	}
	if (error instanceof SlackApiError) {
		if (isHostFault(error)) {
			return {
				message: `The browser page the connector was reading from went away (${error.reason}), so reading stopped. Keep the connector's browser window open until the run finishes.`,
				reason: "collection_interrupted",
			};
		}
		if (error.retryable) {
			return {
				message: `Slack stopped answering ${error.method} (${error.reason}). The next run reads again from where this one stopped.`,
				reason: "collection_interrupted",
			};
		}
		return {
			message: `Slack answered ${error.method} with ${error.reason}, which this connector does not understand.`,
			reason: "source_unreadable",
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
				reason: abort.reason,
				message: abort.message,
			});
		}
		return;
	}
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
			cursor: { synced_at: run.ctx.emittedAt, fingerprints: cursor.toState() },
		});
	}
	if (plan !== null && wants(run, "messages")) {
		await run.ctx.emit({
			type: "STATE",
			stream: "messages",
			cursor: {
				channel_last_ts: plan.channelLastTs,
				floor_ts: plan.nextFloorSec,
				format: 1,
			},
		});
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
		fullRefresh: ctx.collectionMode === "full_refresh",
		messagesEmitted: 0,
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
