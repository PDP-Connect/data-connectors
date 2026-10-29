// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Facebook collection walk, separated from the page so it can be tested
 * against recorded responses. `index.ts` supplies the page-backed services.
 *
 * Each list stream follows the same plan:
 *   1. open the page the web app itself shows that list on;
 *   2. take the first page of the list from the page's server-rendered
 *      payloads, when it is there;
 *   3. if the list goes on, find the list's query: from the page's own
 *      request for it (scrolling, as a person would, if the page has not
 *      asked yet), else from the page's loaded query modules. A query that
 *      cannot be found fails the stream as `facebook_query_outdated`;
 *   4. page with the source's cursor until `has_next_page` is false.
 *
 * A list is complete only on the source's own end signal. A missing end
 * signal, a repeated cursor, a page that adds nothing new, or the page cap
 * fails the stream and writes no STATE.
 *
 * A bounded grant narrows the walk at the source:
 *   - `since`: the timeline and the activity log list newest first, so a walk
 *     ends once a run of items older than `since` (OLDER_ITEMS_TO_STOP) closes
 *     a page; nothing after it can be in the window;
 *   - `until` (posts): the timeline query's own `beforeTime`/`afterTime` date
 *     variables carry the window, widened by a day on each side, and only when
 *     the query declares them. A bounded walk that brings no item at all, or
 *     fails, is not trusted: the plain walk runs instead;
 *   - `resources`: a walk ends once every requested id was read.
 * The runtime still drops every record outside the grant; these only stop
 * reading what it would drop. STATE is never read, so a narrow run never
 * shortens a later wide one.
 */

import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ACTIVITY_CATEGORIES,
	ACTIVITY_OPERATION,
	type ActivityKind,
	assertHttpOk,
	assertNoEnvelopeFailure,
	assertReadOnlyOperation,
	buildProfileRecord,
	buildVariables,
	type CapturedOperation,
	type ConnectionMatcher,
	ERROR_CLASSES,
	edgeCreationSeconds,
	erroredItemCount,
	extractPreloadedPayloads,
	extractProfileIntro,
	extractViewer,
	FB_ORIGIN,
	type FoundConnection,
	FRIENDS_OPERATION,
	facebookError,
	friendRecordKey,
	GROUPS_OPERATION,
	groupRecordKey,
	isNumericId,
	isRunEndingError,
	isValidDocId,
	type JsonRecord,
	type MergedPayload,
	missingConnectionError,
	newTextCounter,
	nodeOf,
	type OperationSpec,
	POSTS_OPERATION,
	parseActivityNode,
	parseFriendNode,
	parseGraphqlText,
	parseGroupNode,
	parsePostNode,
	pickConnection,
	pickPreloadedConnection,
	postIdKey,
	type TextCounter,
	type Viewer,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

// ─── Pacing and bounds ──────────────────────────────────────────────────

/** Pause before every query the connector sends: a random time in this range. */
export const REQUEST_DELAY_MS: readonly [number, number] = [2000, 4500];
/** Pause before opening each page. */
export const NAVIGATION_DELAY_MS: readonly [number, number] = [3000, 6000];
/** Pause after each scroll that waits for the page to ask for the next part of a list. */
export const SCROLL_WAIT_MS: readonly [number, number] = [2500, 4000];
export const SCROLL_ATTEMPTS = 4;

export const MAX_PAGES: Readonly<Record<string, number>> = {
	posts: 600,
	friends: 700,
	groups: 200,
	reactions: 400,
	comments: 400,
};

/**
 * A walk under `since` ends when this many items in a row, closing a page,
 * are older than `since`. More than one page of each list, so a single item
 * out of order (a pinned or back-dated post) cannot end it early.
 */
export const OLDER_ITEMS_TO_STOP: Readonly<Record<string, number>> = {
	posts: 9,
	reactions: 30,
	comments: 30,
};

/** Slack added on each side of a time bound sent in the source's own date variables. */
export const PUSHED_BOUND_SLACK_SECONDS = 86_400;

const SOURCE = "facebook";

// ─── Services the page provides ─────────────────────────────────────────

export interface PageSnapshot {
	/** Where the page landed after redirects. */
	landedUrl: string;
	/** `<script type="application/json">` texts holding Relay payloads, secrets removed. */
	scripts: string[];
}

export interface ModuleOperation {
	docId: string | null;
	provided: JsonRecord;
}

export type PageGraphqlResult =
	| { kind: "signed_out" }
	| {
			contentType: string | null;
			kind: "response";
			/** The `cf-mitigated` header: set when a bot check answered instead of Facebook. */
			mitigated: string | null;
			status: number;
			text: string;
			url: string;
	  };

export interface GraphqlCall {
	asbdId: string | null;
	docId: string;
	friendlyName: string;
	variables: string;
}

export interface FacebookServices {
	graphql: (call: GraphqlCall) => Promise<PageGraphqlResult>;
	/** Navigate and read the page. Forgets requests captured on the previous page. */
	open: (url: string) => Promise<PageSnapshot>;
	random: () => number;
	resolveModule: (friendlyName: string) => Promise<ModuleOperation>;
	scroll: () => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	/** The latest of the page's own requests for this operation, if it made one. */
	takeCaptured: (spec: OperationSpec) => CapturedOperation | null;
	/** False where the host cannot see the page's own requests (PageShim); then no scrolling for one. */
	observesRequests: boolean;
	/** Run `tick` every `ms` until the returned stop function is called. */
	every: (ms: number, tick: () => void) => () => void;
}

// ─── Bounded waits ──────────────────────────────────────────────────────

/** The longest any one page action may take. Past it the action fails as `facebook_page_timeout`. */
export interface PageDeadlines {
	graphql: number;
	open: number;
	resolveModule: number;
	scroll: number;
}

export const PAGE_DEADLINES: PageDeadlines = {
	open: 30_000,
	graphql: 30_000,
	resolveModule: 10_000,
	scroll: 10_000,
};

/** While collecting, a PROGRESS goes out at least this often, so the host never sees a silent run. */
export const HEARTBEAT_MS = 20_000;

export function withDeadline<T>(
	work: Promise<T>,
	ms: number,
	what: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					facebookError(
						ERROR_CLASSES.timeout,
						`${what} took longer than ${ms} ms`,
					),
				),
			ms,
		);
	});
	return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The same services, with every page action bounded. */
export function boundServices(
	services: FacebookServices,
	deadlines: PageDeadlines,
): FacebookServices {
	return {
		...services,
		open: (url) =>
			withDeadline(
				services.open(url),
				deadlines.open,
				"opening a Facebook page",
			),
		graphql: (call) =>
			withDeadline(
				services.graphql(call),
				deadlines.graphql,
				`the ${call.friendlyName} query`,
			),
		resolveModule: (name) =>
			withDeadline(
				services.resolveModule(name),
				deadlines.resolveModule,
				"looking up a query in the page",
			),
		scroll: () =>
			withDeadline(services.scroll(), deadlines.scroll, "scrolling the page"),
	};
}

export type CollectorContext = Pick<
	BrowserCollectContext,
	| "collectionMode"
	| "emit"
	| "emitRecord"
	| "isRecordSelected"
	| "progress"
	| "reportStreamFailure"
	| "requested"
	| "state"
>;

function pause(
	services: FacebookServices,
	range: readonly [number, number],
): Promise<void> {
	const [min, max] = range;
	return services.sleep(Math.round(min + services.random() * (max - min)));
}

// ─── One query page ─────────────────────────────────────────────────────

interface ResolvedOperation {
	asbdId: string | null;
	docId: string;
	friendlyName: string;
	provided: JsonRecord;
	template: JsonRecord | null;
}

async function requestPage(
	services: FacebookServices,
	operation: ResolvedOperation,
	variables: JsonRecord,
): Promise<MergedPayload> {
	assertReadOnlyOperation(operation.friendlyName);
	const result = await services.graphql({
		friendlyName: operation.friendlyName,
		docId: operation.docId,
		variables: JSON.stringify(variables),
		asbdId: operation.asbdId,
	});
	if (result.kind === "signed_out")
		throw facebookError(ERROR_CLASSES.auth, "the page is signed out");
	assertHttpOk(result);
	const payload = parseGraphqlText(result.text);
	assertNoEnvelopeFailure(payload, operation.friendlyName);
	return payload;
}

const PROVIDED_PREFIX = "__relay_internal__pv__";

function providedOnly(provided: JsonRecord): JsonRecord {
	return Object.fromEntries(
		Object.entries(provided).filter(([key]) => key.startsWith(PROVIDED_PREFIX)),
	);
}

async function awaitCapture(
	services: FacebookServices,
	spec: OperationSpec,
): Promise<CapturedOperation | null> {
	if (!services.observesRequests) return null;
	let captured = services.takeCaptured(spec);
	for (let attempt = 0; !captured && attempt < SCROLL_ATTEMPTS; attempt += 1) {
		await services.scroll();
		await pause(services, SCROLL_WAIT_MS);
		captured = services.takeCaptured(spec);
	}
	return captured;
}

/** Find the list's query: the page's own request first, then its loaded modules. */
async function resolveOperation(
	services: FacebookServices,
	spec: OperationSpec,
	stream: string,
): Promise<ResolvedOperation> {
	const captured = await awaitCapture(services, spec);
	if (captured) {
		assertReadOnlyOperation(captured.friendlyName);
		return { ...captured, provided: {}, template: captured.variables };
	}
	if (typeof spec.friendlyName !== "string") {
		throw facebookError(
			ERROR_CLASSES.outdated,
			`the page did not reveal the query for ${stream}`,
		);
	}
	assertReadOnlyOperation(spec.friendlyName);
	let module: ModuleOperation;
	try {
		module = await services.resolveModule(spec.friendlyName);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.startsWith(ERROR_CLASSES.timeout)) throw error;
		throw facebookError(
			ERROR_CLASSES.outdated,
			`${spec.friendlyName} could not be found in the page in time`,
		);
	}
	if (!isValidDocId(module.docId)) {
		throw facebookError(
			ERROR_CLASSES.outdated,
			`${spec.friendlyName} is not loaded by the page any more`,
		);
	}
	return {
		friendlyName: spec.friendlyName,
		docId: module.docId,
		provided: providedOnly(module.provided),
		template: null,
		asbdId: null,
	};
}

// ─── The list walk ──────────────────────────────────────────────────────

interface WalkPlan {
	/** Skip the server-rendered first page and start at the query's own first page. */
	fromQuery?: boolean;
	/** Variables set only when the query declares them (the source's date filters). */
	ifDeclared?: JsonRecord;
	maxPages: number;
	/** Variables this stream always sets (for example the activity category). */
	overrides: JsonRecord;
	snapshot: PageSnapshot;
	spec: OperationSpec;
	stream: string;
	viewerId: string;
	/** Handle one page of edges. The walk itself decides when the list ended. */
	onEdges: (edges: unknown[]) => Promise<void>;
	/** Asked after each page: true when the grant's window or resources are fully read. */
	stopAfterPage?: () => boolean;
	/** True for an edge the grant's resources leave out: it is not read, so its errors do not count. */
	skipsEdge?: (edge: unknown) => boolean;
}

interface WalkState {
	cursor: string | null;
	/** Edges the walk was given, on every page. */
	edges: number;
	ownerId: string | null;
	seenCursors: Set<string>;
	seenKeys: Set<string>;
}

/** New item ids on this page, by the id the record is emitted under. */
function addKeys(
	spec: OperationSpec,
	state: WalkState,
	edges: readonly unknown[],
): number {
	let added = 0;
	for (const edge of edges) {
		const key = spec.itemKey(edge);
		if (key !== null && !state.seenKeys.has(key)) {
			state.seenKeys.add(key);
			added += 1;
		}
	}
	return added;
}

/**
 * Decide, from one page's `page_info`, whether the list ended or goes on.
 * Only the source's own `has_next_page: false` ends it. A page that says
 * more follows but repeats a cursor or brings no new item cannot be trusted.
 */
function nextCursor(
	plan: WalkPlan,
	state: WalkState,
	connection: FoundConnection,
	added: number,
	restartedFromTop: boolean,
): string | "end" {
	const info = connection.pageInfo;
	if (!info || info.hasNextPage === null) {
		throw facebookError(
			ERROR_CLASSES.incomplete,
			`${plan.stream}: a page came without an end signal`,
		);
	}
	if (!info.hasNextPage) return "end";
	if (!info.endCursor || state.seenCursors.has(info.endCursor)) {
		throw facebookError(
			ERROR_CLASSES.incomplete,
			`${plan.stream}: the list repeated its cursor`,
		);
	}
	// A walk that had to restart from the top re-reads the preloaded first page once; that is expected.
	const rereadFirstPage = restartedFromTop && connection.edges.length > 0;
	if (added === 0 && !rereadFirstPage) {
		throw facebookError(
			ERROR_CLASSES.incomplete,
			`${plan.stream}: a page said more follows but added nothing new`,
		);
	}
	state.seenCursors.add(info.endCursor);
	return info.endCursor;
}

/** Fails the walk when Facebook reported errors on fields the records are built from. */
function assertItemsReadable(
	plan: WalkPlan,
	payload: MergedPayload,
	connection: FoundConnection,
): void {
	if (payload.errors.length === 0) return;
	const errored = erroredItemCount(
		payload.errors,
		connection,
		plan.spec.readPaths,
		(index) => plan.skipsEdge?.(connection.edges[index]) ?? false,
	);
	if (errored > 0) {
		throw facebookError(
			ERROR_CLASSES.incomplete,
			`${plan.stream}: Facebook reported errors on ${errored} item(s) of a page`,
		);
	}
	connectorDiagnostic(SOURCE, "graphql_field_errors", {
		stream: plan.stream,
		count: payload.errors.length,
	});
}

/**
 * Later pages are the same list only when they are provably that list (see
 * `OperationSpec.continuation`): the same owner id, the same full path for
 * an ownerless list, or a uniquely named key. Contents are not judged, so an
 * empty last page carrying the end signal is still recognised; an unrelated
 * list that merely shares a key is not.
 */
function samePagesMatcher(
	plan: WalkPlan,
	first: FoundConnection | null,
): ConnectionMatcher {
	if (first === null) return plan.spec.match;
	const samePath = (path: readonly (string | number)[]): boolean =>
		path.length === first.path.length &&
		path.every((step, index) => step === first.path[index]);
	return (key, connection, context) => {
		if (key !== first.key) return false;
		const ownerMatches =
			first.ownerId !== null && context.ancestors.at(-1)?.id === first.ownerId;
		switch (plan.spec.continuation) {
			case "owner":
				return ownerMatches;
			case "path":
				return (
					ownerMatches || (first.ownerId === null && samePath(context.path))
				);
			default:
				return ownerMatches || plan.spec.match(key, connection, context);
		}
	};
}

async function walkQueryPages(
	services: FacebookServices,
	plan: WalkPlan,
	state: WalkState,
	first: FoundConnection | null,
): Promise<void> {
	const operation = await resolveOperation(services, plan.spec, plan.stream);
	const match = samePagesMatcher(plan, first);
	for (let page = 0; ; page += 1) {
		if (page >= plan.maxPages) {
			throw facebookError(
				ERROR_CLASSES.incomplete,
				`${plan.stream}: stopped after ${plan.maxPages} pages`,
			);
		}
		await pause(services, REQUEST_DELAY_MS);
		const variables = buildVariables({
			cursor: state.cursor,
			defaults: plan.spec.defaults({
				ownerId: state.ownerId,
				viewerId: plan.viewerId,
			}),
			overrides: plan.overrides,
			ifDeclared: plan.ifDeclared,
			provided: operation.provided,
			template: operation.template,
		});
		const payload = await requestPage(services, operation, variables);
		const connection = pickConnection(payload.data, match, plan.spec.prefer);
		if (!connection)
			throw missingConnectionError(payload, operation.friendlyName);
		assertItemsReadable(plan, payload, connection);
		const restartedFromTop =
			page === 0 && state.cursor === null && state.seenKeys.size > 0;
		const added = addKeys(plan.spec, state, connection.edges);
		state.edges += connection.edges.length;
		await plan.onEdges(connection.edges);
		if (plan.stopAfterPage?.()) return;
		const next = nextCursor(plan, state, connection, added, restartedFromTop);
		if (next === "end") return;
		state.cursor = next;
	}
}

/**
 * Walk one list to the source's end signal, or until `stopAfterPage` says
 * the grant is fully read. Throws when neither was proven. Returns how many
 * edges the walk was given.
 */
export async function walkList(
	services: FacebookServices,
	plan: WalkPlan,
): Promise<{ edges: number }> {
	const preloaded = plan.fromQuery
		? null
		: pickPreloadedConnection(
				extractPreloadedPayloads(plan.snapshot.scripts),
				plan.spec.match,
				plan.spec.prefer,
			);
	const first = preloaded?.connection ?? null;
	const state: WalkState = {
		cursor: null,
		edges: 0,
		ownerId: first?.ownerId ?? null,
		seenCursors: new Set(),
		seenKeys: new Set(),
	};
	if (preloaded && first) {
		assertItemsReadable(plan, preloaded.payload, first);
		addKeys(plan.spec, state, first.edges);
		state.edges += first.edges.length;
		await plan.onEdges(first.edges);
		if (first.pageInfo?.hasNextPage === false || plan.stopAfterPage?.())
			return { edges: state.edges };
		state.cursor = first.pageInfo?.endCursor ?? null;
		if (state.cursor) state.seenCursors.add(state.cursor);
	}
	await walkQueryPages(services, plan, state, first);
	return { edges: state.edges };
}

// ─── Streams ────────────────────────────────────────────────────────────

interface StreamRun {
	ctx: CollectorContext;
	services: FacebookServices;
	snapshot: PageSnapshot;
	viewer: Viewer;
}

function reportText(stream: string, counter: TextCounter): void {
	if (counter.truncated > 0) {
		connectorDiagnostic(SOURCE, "text_truncated", {
			stream,
			truncated: counter.truncated,
		});
	}
}

/** True the first time an item id is met in this walk; a re-read page or a repeated item is handled once. */
function firstSeen(handled: Set<string>, key: string | null): boolean {
	if (key === null) return true;
	if (handled.has(key)) return false;
	handled.add(key);
	return true;
}

// ─── The grant's window and resources ───────────────────────────────────

interface StreamGrant {
	/** Requested record ids, or null for every record. */
	resources: ReadonlySet<string> | null;
	sinceSeconds: number | null;
	untilSeconds: number | null;
}

function boundSeconds(value: string | undefined): number | null {
	if (value === undefined) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms / 1000 : null;
}

function streamGrant(ctx: CollectorContext, stream: string): StreamGrant {
	const scope = ctx.requested.get(stream);
	const resources = scope?.resources;
	return {
		resources:
			Array.isArray(resources) && resources.length > 0
				? new Set(resources.map(String))
				: null,
		sinceSeconds: boundSeconds(scope?.time_range?.since),
		untilSeconds: boundSeconds(scope?.time_range?.until),
	};
}

/**
 * Decides when a newest-first walk has read all of a grant: every requested
 * id was met, or a run of OLDER_ITEMS_TO_STOP items older than `since`
 * closed a page. An item with no readable time breaks the run.
 */
class GrantStop {
	private olderRun = 0;
	private readonly grant: StreamGrant;
	private readonly keyOf: (edge: unknown) => string | null;
	private readonly observed = new Set<string>();
	private readonly olderToStop: number;
	private readonly pending: Set<string> | null;

	/** `keyOf` gives an edge's record id when the raw edge proves it, else null. */
	constructor(
		grant: StreamGrant,
		olderToStop: number,
		keyOf: (edge: unknown) => string | null,
	) {
		this.grant = grant;
		this.keyOf = keyOf;
		this.olderToStop = olderToStop;
		this.pending = grant.resources ? new Set(grant.resources) : null;
	}

	/** Items met again (a re-read page, a restart from the top) do not add to the older run. */
	observeEdges(edges: readonly unknown[]): void {
		const since = this.grant.sinceSeconds;
		if (since === null) return;
		for (const edge of edges) {
			const key = this.keyOf(edge);
			if (key !== null) {
				if (this.observed.has(key)) continue;
				this.observed.add(key);
			}
			const seconds = edgeCreationSeconds(edge);
			this.olderRun =
				seconds !== null && seconds < since ? this.olderRun + 1 : 0;
		}
	}

	/**
	 * True for an edge the grant's resources leave out, by its raw id: it is
	 * not parsed, so an unrequested item cannot fail the stream.
	 */
	skips(edge: unknown): boolean {
		if (this.pending === null || this.grant.resources === null) return false;
		const key = this.keyOf(edge);
		return key !== null && !this.grant.resources.has(key);
	}

	/** True once every requested id was met; the rest of the page need not be read. */
	allMet(): boolean {
		return this.pending !== null && this.pending.size === 0;
	}

	met(id: string): void {
		this.pending?.delete(id);
	}

	done(): boolean {
		if (this.pending !== null && this.pending.size === 0) return true;
		return (
			this.grant.sinceSeconds !== null && this.olderRun >= this.olderToStop
		);
	}
}

/** Counts records the runtime would drop for their shape: such a stream is not complete. */
async function emitChecked(
	ctx: CollectorContext,
	stream: string,
	record: Record<string, unknown>,
): Promise<boolean> {
	const selected = ctx.isRecordSelected?.(stream, record) ?? true;
	const valid = !selected || validateRecord(stream, record).ok;
	await ctx.emitRecord(stream, record);
	return valid;
}

/** An item key that is a numeric id (the record id of posts, friends and groups), else null. */
function numericKey(
	itemKey: (edge: unknown) => string | null,
): (edge: unknown) => string | null {
	return (edge) => {
		const key = itemKey(edge);
		return isNumericId(key) ? key : null;
	};
}

function rejectedError(stream: string, rejected: number): Error {
	return facebookError(
		ERROR_CLASSES.shape,
		`${stream}: ${rejected} record(s) did not match the stream's schema and were not saved`,
	);
}

async function collectProfile(run: StreamRun): Promise<void> {
	const counter = newTextCounter();
	const intro = extractProfileIntro(
		extractPreloadedPayloads(run.snapshot.scripts),
		counter,
	);
	if (intro === null) {
		// The intro (bio, "lives in", "works at") was not in the page, so it was
		// not read; emitting nulls would say the person filled in nothing.
		throw facebookError(
			ERROR_CLASSES.shape,
			"profile: the page did not include the intro card, so the bio and intro could not be read",
		);
	}
	const record = buildProfileRecord(
		run.viewer,
		run.snapshot.landedUrl,
		intro,
		counter,
	);
	const valid = await emitChecked(run.ctx, "profile", { ...record });
	reportText("profile", counter);
	if (!valid) throw rejectedError("profile", 1);
}

/** The timeline's own date variables for a grant with `until`, widened by a day each side. */
function timelineDateVariables(grant: StreamGrant): JsonRecord | null {
	if (grant.untilSeconds === null) return null;
	return {
		beforeTime: Math.ceil(grant.untilSeconds) + PUSHED_BOUND_SLACK_SECONDS,
		...(grant.sinceSeconds === null
			? {}
			: {
					afterTime:
						Math.floor(grant.sinceSeconds) - PUSHED_BOUND_SLACK_SECONDS,
				}),
	};
}

/**
 * Posts are mutable (text, audience), and an edit does not change a post's
 * creation time, so every run walks the whole timeline, or the whole of the
 * grant's window, to its end. STATE only marks the walk complete; it never
 * shortens the next walk.
 */
async function collectPosts(run: StreamRun): Promise<void> {
	const counter = newTextCounter();
	const grant = streamGrant(run.ctx, "posts");
	let rejected = 0;
	const handled = new Set<string>();
	/** One attempt; its unreadable count is its own, so a discarded dated walk cannot fail the plain one. */
	const walk = async (
		dates: JsonRecord | null,
	): Promise<{ edges: number; unreadable: number }> => {
		const stop = new GrantStop(
			grant,
			OLDER_ITEMS_TO_STOP.posts ?? 9,
			numericKey(postIdKey),
		);
		let unreadable = 0;
		const walked = await walkList(run.services, {
			stream: "posts",
			spec: POSTS_OPERATION,
			snapshot: run.snapshot,
			viewerId: run.viewer.id,
			overrides: {},
			// The plain walk clears the date variables: a template captured from
			// the page may be this run's own dated request.
			...(dates
				? { fromQuery: true, ifDeclared: dates }
				: { ifDeclared: { afterTime: null, beforeTime: null } }),
			maxPages: MAX_PAGES.posts ?? 600,
			stopAfterPage: () => stop.done(),
			skipsEdge: (edge) => stop.skips(edge),
			onEdges: async (edges) => {
				stop.observeEdges(edges);
				for (const edge of edges) {
					if (stop.allMet()) break;
					if (stop.skips(edge)) continue;
					const node = nodeOf(edge);
					const parsed = node
						? parsePostNode(node, run.viewer.id, counter)
						: { kind: "unreadable" as const };
					if (parsed.kind === "unreadable") unreadable += 1;
					if (parsed.kind !== "post") continue;
					stop.met(parsed.record.id);
					if (!firstSeen(handled, parsed.record.id)) continue;
					if (!(await emitChecked(run.ctx, "posts", { ...parsed.record })))
						rejected += 1;
				}
			},
		});
		return { edges: walked.edges, unreadable };
	};
	const dates = timelineDateVariables(grant);
	let trusted: { edges: number; unreadable: number } | null = null;
	if (dates) {
		try {
			trusted = await walk(dates);
		} catch (error) {
			// A dated walk that failed at any page may be the date filter itself;
			// the plain walk below is the proof instead. Posts it already
			// delivered are not delivered twice (`handled`).
			if (isRunEndingError(error)) throw error;
			connectorDiagnostic(SOURCE, "date_filter_unused", { stream: "posts" });
		}
	}
	// No item under the source's date filter is not proof of an empty window:
	// the filter may have been read differently. Walk without it.
	if (trusted === null || trusted.edges === 0) trusted = await walk(null);
	const { unreadable } = trusted;
	reportText("posts", counter);
	if (unreadable > 0)
		throw facebookError(
			ERROR_CLASSES.shape,
			`posts: ${unreadable} timeline item(s) could not be read`,
		);
	if (rejected > 0) throw rejectedError("posts", rejected);
	await run.ctx.emit({ type: "STATE", stream: "posts", cursor: {} });
}

async function collectInventory(
	run: StreamRun,
	stream: "friends" | "groups",
	spec: OperationSpec,
	parse: (node: JsonRecord, counter: TextCounter) => { id: string } | null,
	recordKey: (edge: unknown) => string | null,
): Promise<void> {
	const counter = newTextCounter();
	const grant = streamGrant(run.ctx, stream);
	const stop = new GrantStop(grant, Number.POSITIVE_INFINITY, recordKey);
	const seen = new Set<string>();
	let unreadable = 0;
	let rejected = 0;
	await walkList(run.services, {
		stream,
		spec,
		snapshot: run.snapshot,
		viewerId: run.viewer.id,
		overrides: {},
		maxPages: MAX_PAGES[stream] ?? 200,
		stopAfterPage: () => stop.done(),
		skipsEdge: (edge) => stop.skips(edge),
		onEdges: async (edges) => {
			for (const edge of edges) {
				if (stop.allMet()) break;
				if (stop.skips(edge)) continue;
				const node = nodeOf(edge);
				const record = node ? parse(node, counter) : null;
				if (!record) {
					unreadable += 1;
					continue;
				}
				stop.met(record.id);
				if (!firstSeen(seen, record.id)) continue;
				if (!(await emitChecked(run.ctx, stream, { ...record }))) rejected += 1;
			}
		},
	});
	reportText(stream, counter);
	if (unreadable > 0)
		throw facebookError(
			ERROR_CLASSES.shape,
			`${stream}: ${unreadable} item(s) could not be read`,
		);
	if (rejected > 0) throw rejectedError(stream, rejected);
	// A walk for chosen ids may end early, so it is no full inventory scan.
	if (grant.resources === null)
		await run.ctx.emit(buildFullScanCoverageMessage(stream, seen.size));
	await run.ctx.emit({ type: "STATE", stream, cursor: {} });
}

/**
 * The activity log is walked to its end every run, or to the end of the
 * grant's window: a saved time is never taken as proof that older entries
 * were read.
 */
async function collectActivity(
	run: StreamRun,
	stream: "comments" | "reactions",
	kind: ActivityKind,
): Promise<void> {
	const counter = newTextCounter();
	const grant = streamGrant(run.ctx, stream);
	const stop = new GrantStop(
		grant,
		OLDER_ITEMS_TO_STOP[stream] ?? 30,
		ACTIVITY_OPERATION.itemKey,
	);
	const seen = new Set<string>();
	let unreadable = 0;
	let rejected = 0;
	await walkList(run.services, {
		stream,
		spec: ACTIVITY_OPERATION,
		snapshot: run.snapshot,
		viewerId: run.viewer.id,
		overrides: { category_key: ACTIVITY_CATEGORIES[kind] },
		maxPages: MAX_PAGES[stream] ?? 400,
		stopAfterPage: () => stop.done(),
		skipsEdge: (edge) => stop.skips(edge),
		onEdges: async (edges) => {
			stop.observeEdges(edges);
			for (const edge of edges) {
				if (stop.allMet()) break;
				if (stop.skips(edge)) continue;
				const node = nodeOf(edge);
				const record = node ? parseActivityNode(node, kind, counter) : null;
				if (!record) {
					unreadable += 1;
					continue;
				}
				stop.met(record.id);
				if (!firstSeen(seen, record.id)) continue;
				if (!(await emitChecked(run.ctx, stream, { ...record }))) rejected += 1;
			}
		},
	});
	reportText(stream, counter);
	if (unreadable > 0)
		throw facebookError(
			ERROR_CLASSES.shape,
			`${stream}: ${unreadable} entry(ies) could not be read`,
		);
	if (rejected > 0) throw rejectedError(stream, rejected);
	await run.ctx.emit({ type: "STATE", stream, cursor: {} });
}

// ─── Run ────────────────────────────────────────────────────────────────

export const STREAM_ORDER = [
	"profile",
	"posts",
	"friends",
	"groups",
	"reactions",
	"comments",
] as const;
export type FacebookStream = (typeof STREAM_ORDER)[number];

export function activityUrl(viewerId: string, kind: ActivityKind): string {
	return `${FB_ORIGIN}/${viewerId}/allactivity?category_key=${ACTIVITY_CATEGORIES[kind]}`;
}

const PROGRESS: Readonly<Record<FacebookStream, string>> = {
	profile: "Reading your Facebook profile",
	posts: "Reading your Facebook posts",
	friends: "Reading your Facebook friends",
	groups: "Reading the Facebook groups you joined",
	reactions: "Reading your Facebook likes and reactions",
	comments: "Reading your Facebook comments",
};

async function failStream(
	ctx: CollectorContext,
	stream: string,
	error: unknown,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	if (!ctx.reportStreamFailure) throw error;
	await ctx.reportStreamFailure(stream, message.slice(0, 500), {
		recoveryHint: streamFailureHint(message),
	});
}

/**
 * A query the page no longer reveals, or an operation refused as a write,
 * needs a newer connector; retrying the same one cannot help. Other stream
 * failures (an unproven end, a timeout, an unreadable item) may pass on a
 * later run.
 */
export function streamFailureHint(message: string): {
	action: "retry_by_runtime" | "retry_on_connector_upgrade";
	retryable: boolean;
} {
	return message.startsWith(ERROR_CLASSES.outdated) ||
		message.startsWith(ERROR_CLASSES.mutation)
		? { action: "retry_on_connector_upgrade", retryable: false }
		: { action: "retry_by_runtime", retryable: true };
}

async function runStream(
	ctx: CollectorContext,
	services: FacebookServices,
	viewer: Viewer,
	me: PageSnapshot,
	stream: FacebookStream,
): Promise<void> {
	const open = async (url: string): Promise<PageSnapshot> => {
		await pause(services, NAVIGATION_DELAY_MS);
		return services.open(url);
	};
	const run = (snapshot: PageSnapshot): StreamRun => ({
		ctx,
		services,
		snapshot,
		viewer,
	});
	switch (stream) {
		case "profile":
			return collectProfile(run(me));
		case "posts":
			return collectPosts(run(me));
		case "friends":
			return collectInventory(
				run(await open(`${FB_ORIGIN}/me/friends_all`)),
				"friends",
				FRIENDS_OPERATION,
				parseFriendNode,
				friendRecordKey,
			);
		case "groups":
			return collectInventory(
				run(await open(`${FB_ORIGIN}/groups/joins/`)),
				"groups",
				GROUPS_OPERATION,
				parseGroupNode,
				groupRecordKey,
			);
		case "reactions":
			return collectActivity(
				run(await open(activityUrl(viewer.id, "reaction"))),
				"reactions",
				"reaction",
			);
		case "comments":
			return collectActivity(
				run(await open(activityUrl(viewer.id, "comment"))),
				"comments",
				"comment",
			);
		default:
			return undefined;
	}
}

/** Collect every requested stream. Auth, challenge and rate-limit errors end the run; others fail one stream. */
export async function collectFacebook(
	ctx: CollectorContext,
	rawServices: FacebookServices,
	deadlines: PageDeadlines = PAGE_DEADLINES,
): Promise<void> {
	const streams = STREAM_ORDER.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const services = boundServices(rawServices, deadlines);
	let current = "Opening your Facebook profile";
	const stopHeartbeat = services.every(HEARTBEAT_MS, () => {
		ctx.progress(current).catch(() => undefined);
	});
	const say = async (message: string): Promise<void> => {
		current = message;
		await ctx.progress(message);
	};
	try {
		await say(current);
		const me = await services.open(`${FB_ORIGIN}/me`);
		const viewer = extractViewer(me.scripts);
		if (!viewer)
			throw facebookError(
				ERROR_CLASSES.auth,
				"the page shows no signed-in person",
			);
		for (const stream of streams) {
			await say(PROGRESS[stream]);
			try {
				await runStream(ctx, services, viewer, me, stream);
			} catch (error) {
				if (isRunEndingError(error)) throw error;
				await failStream(ctx, stream, error);
			}
		}
	} finally {
		stopHeartbeat();
	}
}
