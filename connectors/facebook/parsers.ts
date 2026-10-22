// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsing for the Facebook connector: no page, no network, no clock.
 *
 * Facebook's web app is Relay over GraphQL. Data calls are form-encoded POSTs
 * to `/api/graphql/` naming a persisted query (`doc_id`) and its variables.
 * Responses may start with `for (;;);` and may stream several JSON objects,
 * one per line: the first carries `data`, later ones carry `@stream` edges and
 * `@defer` fragments addressed by `path`. Server-rendered pages carry the same
 * payloads inside `<script type="application/json">` blocks, under
 * `RelayPrefetchedStreamCache` "next" calls.
 *
 * Everything here reads `unknown` trees through small guards; nothing trusts a
 * shape it has not checked.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";

export const FB_ORIGIN = "https://www.facebook.com";
export const GRAPHQL_PATH = "/api/graphql/";

// ─── Error classes ──────────────────────────────────────────────────────

/** Every error this connector throws starts with one of these classes. */
export const ERROR_CLASSES = {
	auth: "facebook_auth_failed",
	challenge: "facebook_challenge",
	rateLimited: "facebook_rate_limited",
	server: "facebook_http_5xx",
	http: "facebook_http_error",
	outdated: "facebook_query_outdated",
	unparseable: "facebook_response_unparseable",
	shape: "facebook_shape_changed",
	incomplete: "facebook_list_not_proven_complete",
	mutation: "facebook_mutation_refused",
} as const;

export type ErrorClass = (typeof ERROR_CLASSES)[keyof typeof ERROR_CLASSES];

export function facebookError(cls: ErrorClass, detail: string): Error {
	return new Error(`${cls}: ${detail}`);
}

/** Errors that end the whole run: retrying other streams would only make it worse. */
export function isRunEndingError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.startsWith(ERROR_CLASSES.auth) ||
		message.startsWith(ERROR_CLASSES.challenge) ||
		message.startsWith(ERROR_CLASSES.rateLimited)
	);
}

export const RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|timeout|facebook_rate_limited|facebook_http_5xx|fetch failed/i;

// ─── Read-only guard ────────────────────────────────────────────────────

const READ_OPERATION_RE = /^[A-Za-z][A-Za-z0-9_]{2,200}Query$/;
const WRITE_OPERATION_RE = /(?:Mutation|Subscription)/i;

/**
 * The connector is read-only. It refuses to send any operation whose friendly
 * name is not a plain `...Query`, and any name that mentions a mutation or a
 * subscription anywhere.
 */
export function assertReadOnlyOperation(friendlyName: string): void {
	if (
		WRITE_OPERATION_RE.test(friendlyName) ||
		!READ_OPERATION_RE.test(friendlyName)
	) {
		throw facebookError(
			ERROR_CLASSES.mutation,
			`refusing to send operation "${friendlyName.slice(0, 120)}"`,
		);
	}
}

// ─── Small guards ───────────────────────────────────────────────────────

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function asArray(value: unknown): unknown[] | null {
	return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function textOf(value: unknown): string | null {
	return asString(asRecord(value)?.text);
}

function getPath(root: unknown, path: readonly (string | number)[]): unknown {
	let current: unknown = root;
	for (const step of path) {
		if (typeof step === "number") {
			const list = asArray(current);
			if (!list) return undefined;
			current = list[step];
		} else {
			const record = asRecord(current);
			if (!record) return undefined;
			current = record[step];
		}
	}
	return current;
}

const DIGITS_RE = /^\d{1,30}$/;

export function isNumericId(value: unknown): value is string {
	return typeof value === "string" && DIGITS_RE.test(value);
}

/** Facebook times are epoch seconds. Returns RFC 3339 UTC, or null. */
export function epochSecondsToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		return null;
	const date = new Date(Math.round(value) * 1000);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Text the person wrote, made PDPP-safe. Counts every replacement. */
export interface TextCounter {
	replaced: number;
	truncated: number;
}

export function newTextCounter(): TextCounter {
	return { replaced: 0, truncated: 0 };
}

export function safeText(
	value: unknown,
	counter: TextCounter,
	max = 20_000,
): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	const result = safeTextPreview(value, max);
	if (result.kind === "binary") {
		counter.replaced += 1;
		return null;
	}
	if (result.truncated) counter.truncated += 1;
	return result.preview;
}

// ─── Response text → parts ──────────────────────────────────────────────

const ANTI_HIJACK_PREFIX = "for (;;);";
const LINE_SPLIT_RE = /\r?\n/;

/**
 * Split a `/api/graphql/` body into its JSON parts. Throws
 * `facebook_response_unparseable` when any part is not JSON.
 */
export function splitGraphqlText(text: string): unknown[] {
	let body = text.trimStart();
	if (body.startsWith(ANTI_HIJACK_PREFIX))
		body = body.slice(ANTI_HIJACK_PREFIX.length);
	const parts: unknown[] = [];
	try {
		for (const line of body.split(LINE_SPLIT_RE)) {
			const trimmed = line.trim();
			if (trimmed.length > 0) parts.push(JSON.parse(trimmed));
		}
	} catch {
		try {
			return [JSON.parse(body)];
		} catch {
			throw facebookError(
				ERROR_CLASSES.unparseable,
				"the response was not JSON",
			);
		}
	}
	if (parts.length === 0)
		throw facebookError(ERROR_CLASSES.unparseable, "the response was empty");
	return parts;
}

// ─── Parts → one payload ────────────────────────────────────────────────

export interface GraphqlErrorInfo {
	code: number | null;
	message: string;
	path: string;
	severity: string | null;
}

export interface MergedPayload {
	data: JsonRecord | null;
	errors: GraphqlErrorInfo[];
	/** Old-style `{ error: <code>, errorSummary }` envelope, when present. */
	legacyError: { code: number; summary: string | null } | null;
	parts: number;
}

function deepMerge(target: JsonRecord, source: JsonRecord): void {
	for (const [key, value] of Object.entries(source)) {
		const existing = asRecord(target[key]);
		const incoming = asRecord(value);
		if (existing && incoming) deepMerge(existing, incoming);
		else target[key] = value;
	}
}

function collectErrors(part: JsonRecord, into: GraphqlErrorInfo[]): void {
	for (const raw of asArray(part.errors) ?? []) {
		const error = asRecord(raw);
		if (!error) continue;
		const path = asArray(error.path) ?? [];
		into.push({
			code: typeof error.code === "number" ? error.code : null,
			message: (asString(error.message) ?? asString(error.summary) ?? "").slice(
				0,
				300,
			),
			path: path.map(String).join("."),
			severity: asString(error.severity),
		});
	}
}

function containerAt(
	root: JsonRecord,
	path: readonly (string | number)[],
): unknown {
	let current: unknown = root;
	for (const [index, step] of path.entries()) {
		const nextIsIndex = typeof path[index + 1] === "number";
		if (typeof step === "number") {
			const list = asArray(current);
			if (!list) return undefined;
			list[step] ??= nextIsIndex ? [] : {};
			current = list[step];
		} else {
			const record = asRecord(current);
			if (!record) return undefined;
			record[step] ??= nextIsIndex ? [] : {};
			current = record[step];
		}
	}
	return current;
}

/** Apply one `@stream`/`@defer` part at its path. */
function applyIncrementalPart(
	base: JsonRecord,
	path: readonly (string | number)[],
	data: unknown,
): void {
	const last = path.at(-1);
	if (typeof last === "number") {
		const list = asArray(containerAt(base, path.slice(0, -1)));
		if (list) list[last] = data;
		return;
	}
	const target = asRecord(containerAt(base, path));
	const incoming = asRecord(data);
	if (target && incoming) deepMerge(target, incoming);
}

function isPathArray(value: unknown): value is (string | number)[] {
	return (
		Array.isArray(value) &&
		value.every((step) => typeof step === "string" || typeof step === "number")
	);
}

/** Merge streamed parts into one payload, in arrival order. */
export function mergeGraphqlParts(parts: readonly unknown[]): MergedPayload {
	const merged: MergedPayload = {
		data: null,
		errors: [],
		legacyError: null,
		parts: parts.length,
	};
	for (const raw of parts) {
		const part = asRecord(raw);
		if (!part) continue;
		collectErrors(part, merged.errors);
		if (typeof part.error === "number") {
			merged.legacyError = {
				code: part.error,
				summary: asString(part.errorSummary),
			};
		}
		const data = asRecord(part.data);
		if (!data) continue;
		if (isPathArray(part.path) && part.path.length > 0) {
			if (merged.data) applyIncrementalPart(merged.data, part.path, part.data);
		} else if (merged.data) {
			deepMerge(merged.data, data);
		} else {
			merged.data = structuredClone(data);
		}
	}
	return merged;
}

export function parseGraphqlText(text: string): MergedPayload {
	return mergeGraphqlParts(splitGraphqlText(text));
}

// ─── Failure classification ─────────────────────────────────────────────

/** Codes Facebook uses for "not signed in" / "session expired". */
const AUTH_ERROR_CODES = new Set([1_357_001, 1_357_004, 1_357_005, 1_357_031]);
/** Codes Facebook uses for "slow down" / "temporarily blocked". */
const RATE_ERROR_CODES = new Set([368, 1_390_008, 1_675_004, 3_252_001]);
const OUTDATED_MESSAGE_RE =
	/persisted|doc_?id|document|unknown (?:query|operation)|missing_required_variable|noncoercible_variable|variable .*(?:required|invalid)|invalid .*variable/i;
const RATE_MESSAGE_RE =
	/rate limit|too many|temporarily blocked|going too fast/i;
const AUTH_MESSAGE_RE =
	/not logged in|login required|session (?:has )?expired/i;

/** Throws the right class for an envelope-level failure; returns when there is none. */
export function assertNoEnvelopeFailure(
	payload: MergedPayload,
	friendlyName: string,
): void {
	const legacy = payload.legacyError;
	if (legacy) {
		if (AUTH_ERROR_CODES.has(legacy.code))
			throw facebookError(
				ERROR_CLASSES.auth,
				`signed out (code ${legacy.code})`,
			);
		if (RATE_ERROR_CODES.has(legacy.code)) {
			throw facebookError(
				ERROR_CLASSES.rateLimited,
				`Facebook asked to slow down (code ${legacy.code})`,
			);
		}
		throw facebookError(
			ERROR_CLASSES.http,
			`${friendlyName} failed with code ${legacy.code}`,
		);
	}
	for (const error of payload.errors) {
		if (error.code !== null && RATE_ERROR_CODES.has(error.code)) {
			throw facebookError(
				ERROR_CLASSES.rateLimited,
				`Facebook asked to slow down (code ${error.code})`,
			);
		}
		if (RATE_MESSAGE_RE.test(error.message))
			throw facebookError(
				ERROR_CLASSES.rateLimited,
				"Facebook asked to slow down",
			);
		if (
			(error.code !== null && AUTH_ERROR_CODES.has(error.code)) ||
			AUTH_MESSAGE_RE.test(error.message)
		) {
			throw facebookError(ERROR_CLASSES.auth, "signed out");
		}
	}
}

/** When the expected list is missing, say why: an outdated query, or a changed shape. */
export function missingConnectionError(
	payload: MergedPayload,
	friendlyName: string,
): Error {
	const rootErrors = payload.errors.filter(
		(error) => error.path === "" || OUTDATED_MESSAGE_RE.test(error.message),
	);
	if (payload.data === null || rootErrors.length > 0) {
		return facebookError(
			ERROR_CLASSES.outdated,
			`${friendlyName} returned no list (${payload.errors.length} error(s)); Facebook may have changed this query`,
		);
	}
	return facebookError(
		ERROR_CLASSES.shape,
		`${friendlyName} returned data without the expected list`,
	);
}

// ─── Connections ────────────────────────────────────────────────────────

export interface PageInfo {
	endCursor: string | null;
	hasNextPage: boolean | null;
}

export interface FoundConnection {
	edges: unknown[];
	key: string;
	/** `id` of the object that holds the connection (a refetch variable). */
	ownerId: string | null;
	pageInfo: PageInfo | null;
}

export type ConnectionMatcher = (
	key: string,
	connection: JsonRecord,
) => boolean;

function readPageInfo(connection: JsonRecord): PageInfo | null {
	const info = asRecord(connection.page_info);
	if (!info) return null;
	return {
		endCursor: asString(info.end_cursor),
		hasNextPage:
			typeof info.has_next_page === "boolean" ? info.has_next_page : null,
	};
}

const MAX_WALK_NODES = 400_000;

/** Every connection (`{ edges: [...] }`) under `root` that `match` accepts, depth first. */
export function findConnections(
	root: unknown,
	match: ConnectionMatcher,
): FoundConnection[] {
	const found: FoundConnection[] = [];
	const stack: { owner: JsonRecord | null; value: unknown }[] = [
		{ owner: null, value: root },
	];
	let visited = 0;
	while (stack.length > 0 && visited < MAX_WALK_NODES) {
		visited += 1;
		const item = stack.pop();
		if (!item) break;
		const list = asArray(item.value);
		if (list) {
			for (const child of list) stack.push({ owner: item.owner, value: child });
			continue;
		}
		const record = asRecord(item.value);
		if (!record) continue;
		for (const [key, child] of Object.entries(record)) {
			const connection = asRecord(child);
			const edges = asArray(connection?.edges);
			if (connection && edges && match(key, connection)) {
				found.push({
					edges,
					key,
					ownerId: asString(record.id),
					pageInfo: readPageInfo(connection),
				});
				continue;
			}
			stack.push({ owner: record, value: child });
		}
	}
	return found;
}

function edgeNode(edge: unknown): JsonRecord | null {
	return asRecord(asRecord(edge)?.node);
}

export const matchTimelineConnection: ConnectionMatcher = (key) =>
	key === "timeline_list_feed_units";

export const matchActivityConnection: ConnectionMatcher = (key) =>
	key === "activity_log_stories";

/** A friend list item: its inner node is a person, or its action names a friendship status. */
function isFriendItem(edge: unknown): boolean {
	const node = edgeNode(edge);
	if (!node) return false;
	const inner = asRecord(node.node);
	if (inner?.__isEntity === "User" || inner?.__isNode === "User") return true;
	const status = getPath(node, [
		"actions_renderer",
		"action",
		"profile_owner",
		"friendship_status",
	]);
	return typeof status === "string";
}

export const matchFriendsConnection: ConnectionMatcher = (key, connection) => {
	if (key !== "pageItems") return false;
	const edges = asArray(connection.edges) ?? [];
	return edges.length > 0 && edges.every(isFriendItem);
};

const GROUP_URL_RE =
	/^https:\/\/(?:www|web|m)\.facebook\.com\/groups\/[^/?#]+\/?(?:[?#].*)?$/;

function isGroupNode(node: JsonRecord | null): boolean {
	if (!node) return false;
	const url = asString(node.url);
	const named = asString(node.name) !== null || textOf(node.title) !== null;
	return named && url !== null && GROUP_URL_RE.test(url);
}

/** A joined-groups list: every item links to a group. Matched by shape, since its key is not stable. */
export const matchGroupsConnection: ConnectionMatcher = (_key, connection) => {
	const edges = asArray(connection.edges) ?? [];
	return edges.length > 0 && edges.every((edge) => isGroupNode(edgeNode(edge)));
};

/** The one connection a response carries for `match`, or null. The longest wins when several match. */
export function pickConnection(
	root: unknown,
	match: ConnectionMatcher,
): FoundConnection | null {
	let best: FoundConnection | null = null;
	for (const connection of findConnections(root, match)) {
		if (!best || connection.edges.length > best.edges.length) best = connection;
	}
	return best;
}

// ─── Server-rendered payloads ───────────────────────────────────────────

const STREAM_CACHE_MODULE = "RelayPrefetchedStreamCache";

interface PreloadPart {
	preloaderId: string;
	result: unknown;
	sequence: number;
}

function visitArrays(root: unknown, visit: (list: unknown[]) => void): void {
	const stack: unknown[] = [root];
	let visited = 0;
	while (stack.length > 0 && visited < MAX_WALK_NODES) {
		visited += 1;
		const value = stack.pop();
		const list = asArray(value);
		if (list) {
			visit(list);
			for (const child of list) stack.push(child);
			continue;
		}
		const record = asRecord(value);
		if (record) for (const child of Object.values(record)) stack.push(child);
	}
}

function streamCachePart(list: unknown[]): PreloadPart | null {
	if (list[0] !== STREAM_CACHE_MODULE || list[1] !== "next") return null;
	const args = asArray(list[3]);
	const preloaderId = asString(args?.[0]);
	const bbox = asRecord(asRecord(args?.[1])?.__bbox);
	if (!preloaderId || !bbox || !("result" in bbox)) return null;
	const sequence =
		typeof bbox.sequence_number === "number" ? bbox.sequence_number : 0;
	return { preloaderId, result: bbox.result, sequence };
}

function parseScripts(scriptTexts: readonly string[]): unknown[] {
	const parsed: unknown[] = [];
	for (const text of scriptTexts) {
		try {
			parsed.push(JSON.parse(text));
		} catch {
			// Not every application/json block is a Relay payload; skip the rest.
		}
	}
	return parsed;
}

/**
 * The Relay payloads a server-rendered page preloaded, one merged payload per
 * preloader. The page's `<script type="application/json">` texts go in.
 */
export function extractPreloadedPayloads(
	scriptTexts: readonly string[],
): MergedPayload[] {
	const parts: PreloadPart[] = [];
	for (const root of parseScripts(scriptTexts)) {
		visitArrays(root, (list) => {
			const part = streamCachePart(list);
			if (part) parts.push(part);
		});
	}
	const byPreloader = new Map<string, PreloadPart[]>();
	for (const part of parts) {
		const group = byPreloader.get(part.preloaderId) ?? [];
		group.push(part);
		byPreloader.set(part.preloaderId, group);
	}
	return [...byPreloader.values()].map((group) =>
		mergeGraphqlParts(
			group.sort((a, b) => a.sequence - b.sequence).map((part) => part.result),
		),
	);
}

/** The first connection `match` accepts across preloaded payloads. */
export function pickPreloadedConnection(
	payloads: readonly MergedPayload[],
	match: ConnectionMatcher,
): FoundConnection | null {
	let best: FoundConnection | null = null;
	for (const payload of payloads) {
		const found = pickConnection(payload.data, match);
		if (found && (!best || found.edges.length > best.edges.length))
			best = found;
	}
	return best;
}

// ─── Viewer and profile ─────────────────────────────────────────────────

export interface Viewer {
	id: string;
	name: string | null;
}

/** The signed-in person from the page's `CurrentUserInitialData` module. Null when signed out. */
export function extractViewer(scriptTexts: readonly string[]): Viewer | null {
	let viewer: Viewer | null = null;
	for (const root of parseScripts(scriptTexts)) {
		visitArrays(root, (list) => {
			if (viewer || list[0] !== "CurrentUserInitialData") return;
			const config = asRecord(list[2]);
			const id = config?.USER_ID ?? config?.ACCOUNT_ID;
			if (isNumericId(id) && id !== "0")
				viewer = { id, name: asString(config?.NAME) };
		});
		if (viewer) break;
	}
	return viewer;
}

export interface ProfileIntro {
	bio: string | null;
	items: string[];
}

function collectTitleTexts(root: unknown, into: string[]): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const value = stack.pop();
		const list = asArray(value);
		if (list) {
			for (const child of list) stack.push(child);
			continue;
		}
		const record = asRecord(value);
		if (!record) continue;
		const title = textOf(record.title);
		if (title && !into.includes(title)) into.push(title);
		for (const [key, child] of Object.entries(record))
			if (key !== "title") stack.push(child);
	}
}

/**
 * The intro card the person filled in (bio and the "lives in / works at"
 * lines), when the profile page preloaded it. Null when no intro card was in
 * the page at all, which is not the same as an empty intro.
 */
export function extractProfileIntro(
	payloads: readonly MergedPayload[],
	counter: TextCounter,
): ProfileIntro | null {
	for (const payload of payloads) {
		let card: JsonRecord | null = null;
		const stack: unknown[] = [payload.data];
		while (stack.length > 0 && !card) {
			const value = stack.pop();
			const record = asRecord(value);
			const list = asArray(value);
			if (list) for (const child of list) stack.push(child);
			if (!record) continue;
			card = asRecord(record.profile_intro_card);
			if (!card) for (const child of Object.values(record)) stack.push(child);
		}
		if (!card) continue;
		const raw: string[] = [];
		collectTitleTexts(card.context_items, raw);
		const items = raw
			.map((item) => safeText(item, counter, 500))
			.filter((item): item is string => item !== null);
		return { bio: safeText(textOf(card.bio), counter, 2000), items };
	}
	return null;
}

const VANITY_PATH_RE = /^\/([A-Za-z0-9.]{3,80})\/?$/;

/** The canonical profile URL from where `/me` landed. */
export function profileUrlFrom(
	landedUrl: string,
	viewerId: string,
): { url: string; username: string | null } {
	let parsed: URL | null = null;
	try {
		parsed = new URL(landedUrl);
	} catch {
		parsed = null;
	}
	const fallback = {
		url: `${FB_ORIGIN}/profile.php?id=${viewerId}`,
		username: null,
	};
	if (!parsed || parsed.origin !== FB_ORIGIN) return fallback;
	if (parsed.pathname === "/profile.php") return fallback;
	const vanity = VANITY_PATH_RE.exec(parsed.pathname)?.[1];
	if (!vanity || vanity === "me") return fallback;
	return { url: `${FB_ORIGIN}/${vanity}`, username: vanity };
}

// ─── Records ────────────────────────────────────────────────────────────

export interface ProfileRecord {
	bio: string | null;
	id: string;
	intro: string[] | null;
	name: string | null;
	profile_url: string;
	username: string | null;
}

export function buildProfileRecord(
	viewer: Viewer,
	landedUrl: string,
	intro: ProfileIntro | null,
	counter: TextCounter,
): ProfileRecord {
	const { url, username } = profileUrlFrom(landedUrl, viewer.id);
	return {
		id: viewer.id,
		name: safeText(viewer.name, counter, 500),
		profile_url: url,
		username,
		bio: intro?.bio ?? null,
		intro: intro ? intro.items : null,
	};
}

export interface PostAttachment {
	kind: string | null;
	title: string | null;
}

export interface PostRecord {
	attachments: PostAttachment[];
	create_time: string;
	id: string;
	privacy: string | null;
	privacy_label: string | null;
	text: string | null;
	url: string | null;
}

const STYLE_RE = /^[a-z0-9_]{1,80}$/;

function attachmentKind(attachment: JsonRecord): string | null {
	const styles =
		asArray(getPath(attachment, ["styles", "attachment", "style_list"])) ??
		asArray(attachment.style_list) ??
		[];
	const first = styles.find(
		(style): style is string =>
			typeof style === "string" && STYLE_RE.test(style),
	);
	return first ?? null;
}

function attachmentTitle(
	attachment: JsonRecord,
	counter: TextCounter,
): string | null {
	const inner =
		asRecord(getPath(attachment, ["styles", "attachment"])) ?? attachment;
	const title =
		textOf(inner.title_with_entities) ??
		asString(inner.title) ??
		textOf(inner.title);
	return safeText(title, counter, 1000);
}

function storyAttachments(node: JsonRecord): unknown[] {
	const content = asArray(
		getPath(node, ["comet_sections", "content", "story", "attachments"]),
	);
	return content && content.length > 0
		? content
		: (asArray(node.attachments) ?? []);
}

function postText(node: JsonRecord): string | null {
	return (
		textOf(getPath(node, ["comet_sections", "content", "story", "message"])) ??
		textOf(
			getPath(node, [
				"comet_sections",
				"content",
				"story",
				"comet_sections",
				"message",
				"story",
				"message",
			]),
		) ??
		textOf(node.message)
	);
}

function postMetadataStory(node: JsonRecord): JsonRecord | null {
	const metadata = asArray(
		getPath(node, [
			"comet_sections",
			"context_layout",
			"story",
			"comet_sections",
			"metadata",
		]),
	);
	for (const entry of metadata ?? []) {
		const story = asRecord(asRecord(entry)?.story);
		if (story?.privacy_scope) return story;
	}
	return null;
}

const PRIVACY_STATE_RE = /^[A-Z_]{2,40}$/;

function postPrivacy(
	node: JsonRecord,
	counter: TextCounter,
): { privacy: string | null; label: string | null } {
	const scope = asRecord(postMetadataStory(node)?.privacy_scope);
	const renderer = asRecord(scope?.privacy_scope_renderer);
	const state =
		getPath(renderer, [
			"scope",
			"selected_option",
			"privacy_row_input",
			"base_state",
		]) ?? getPath(renderer, ["privacy_row_input", "base_state"]);
	const label =
		asString(
			getPath(renderer, ["entry_point_renderer", "source", "scope", "label"]),
		) ?? asString(scope?.label);
	return {
		privacy:
			typeof state === "string" && PRIVACY_STATE_RE.test(state) ? state : null,
		label: safeText(label, counter, 200),
	};
}

function postAuthorId(node: JsonRecord): string | null {
	const actors =
		asArray(node.actors) ??
		asArray(getPath(node, ["comet_sections", "content", "story", "actors"])) ??
		[];
	const id = asRecord(actors[0])?.id;
	return isNumericId(id) ? id : null;
}

const HTTPS_URL_RE = /^https:\/\/[^\s]+$/;

function httpsUrl(value: unknown): string | null {
	return typeof value === "string" && HTTPS_URL_RE.test(value) ? value : null;
}

export type PostParse =
	| { kind: "post"; record: PostRecord }
	| { kind: "not_own"; createTime: string | null }
	| { kind: "unreadable" };

/** One timeline unit. Units another person posted on the timeline are `not_own`. */
export function parsePostNode(
	node: JsonRecord,
	viewerId: string,
	counter: TextCounter,
): PostParse {
	const createTime =
		epochSecondsToIso(node.creation_time) ??
		epochSecondsToIso(
			getPath(node, ["comet_sections", "timestamp", "story", "creation_time"]),
		);
	const author = postAuthorId(node);
	if (author !== null && author !== viewerId)
		return { kind: "not_own", createTime };
	const id =
		node.post_id ??
		getPath(node, ["comet_sections", "content", "story", "post_id"]);
	if (!isNumericId(id) || createTime === null || author === null)
		return { kind: "unreadable" };
	const privacy = postPrivacy(node, counter);
	const attachments: PostAttachment[] = [];
	for (const raw of storyAttachments(node)) {
		const attachment = asRecord(raw);
		if (attachment)
			attachments.push({
				kind: attachmentKind(attachment),
				title: attachmentTitle(attachment, counter),
			});
	}
	return {
		kind: "post",
		record: {
			id,
			create_time: createTime,
			text: safeText(postText(node), counter, 60_000),
			url:
				httpsUrl(node.permalink_url) ??
				httpsUrl(
					getPath(node, ["comet_sections", "timestamp", "story", "url"]),
				) ??
				httpsUrl(
					getPath(node, ["comet_sections", "content", "story", "wwwURL"]),
				),
			attachments,
			privacy: privacy.privacy,
			privacy_label: privacy.label,
		},
	};
}

export interface FriendRecord {
	id: string;
	name: string;
	profile_url: string | null;
}

/** One item of the friends list; null when the item does not name a person. */
export function parseFriendNode(
	node: JsonRecord,
	counter: TextCounter,
): FriendRecord | null {
	const inner = asRecord(node.node);
	const ownerId = getPath(node, [
		"actions_renderer",
		"action",
		"profile_owner",
		"id",
	]);
	const id = isNumericId(inner?.id) ? inner?.id : ownerId;
	const name =
		safeText(textOf(node.title), counter, 500) ??
		safeText(
			getPath(node, ["actions_renderer", "action", "profile_owner", "name"]),
			counter,
			500,
		);
	if (!isNumericId(id) || name === null) return null;
	return { id, name, profile_url: httpsUrl(node.url) ?? httpsUrl(inner?.url) };
}

export interface GroupRecord {
	id: string;
	joined_time: string | null;
	name: string;
	url: string;
}

const GROUP_PATH_ID_RE = /\/groups\/(\d{1,30})(?:[/?#]|$)/;

/** One joined group; null when it carries no id, name or link. */
export function parseGroupNode(
	node: JsonRecord,
	counter: TextCounter,
): GroupRecord | null {
	const url = httpsUrl(node.url);
	const pathId = url ? GROUP_PATH_ID_RE.exec(url)?.[1] : undefined;
	const id = isNumericId(node.id) ? node.id : (pathId ?? null);
	const name = safeText(
		asString(node.name) ?? textOf(node.title),
		counter,
		500,
	);
	if (!url || id === null || name === null) return null;
	const joined =
		epochSecondsToIso(node.viewer_join_time) ??
		epochSecondsToIso(node.join_time) ??
		epochSecondsToIso(getPath(node, ["viewer_membership", "join_time"]));
	return { id, name, url, joined_time: joined };
}

export type ActivityKind = "comment" | "reaction";

export interface ActivityRecord {
	comment_text: string | null;
	id: string;
	kind: ActivityKind;
	post_id: string | null;
	target_text: string | null;
	target_url: string | null;
	time: string;
	title: string | null;
}

const ACTIVITY_ID_RE = /^[\x21-\x7E]{1,400}$/;

/** One activity-log entry; null when it has no id or time. */
export function parseActivityNode(
	node: JsonRecord,
	kind: ActivityKind,
	counter: TextCounter,
): ActivityRecord | null {
	const id = node.id;
	const time = epochSecondsToIso(node.creation_time);
	if (typeof id !== "string" || !ACTIVITY_ID_RE.test(id) || time === null)
		return null;
	const attached = asRecord(node.attached_story);
	return {
		id,
		kind,
		time,
		title: safeText(textOf(node.title) ?? textOf(node.summary), counter, 2000),
		target_url: httpsUrl(node.url),
		target_text: safeText(textOf(attached?.message), counter, 20_000),
		post_id: isNumericId(node.post_id) ? node.post_id : null,
		comment_text:
			kind === "comment"
				? safeText(textOf(node.message), counter, 20_000)
				: null,
	};
}

/** A stable key for an edge, used to prove a page added something new. */
export function edgeKey(edge: unknown): string | null {
	const node = edgeNode(edge);
	if (!node) return null;
	const id = node.id ?? node.post_id ?? asRecord(node.node)?.id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

export function nodeOf(edge: unknown): JsonRecord | null {
	return edgeNode(edge);
}

export function edgeCreationSeconds(edge: unknown): number | null {
	const node = edgeNode(edge);
	const value =
		node?.creation_time ??
		getPath(node, ["comet_sections", "timestamp", "story", "creation_time"]);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─── Captured requests and variables ────────────────────────────────────

export interface CapturedOperation {
	asbdId: string | null;
	docId: string;
	friendlyName: string;
	variables: JsonRecord;
}

const DOC_ID_RE = /^\d{5,30}$/;
const ASBD_RE = /^\d{1,12}$/;

/**
 * Read the persisted-query id and the variables out of one of the page's own
 * `/api/graphql/` requests. Everything else in the body (the CSRF token, the
 * viewer id, session counters) is dropped here and never leaves this function.
 */
export function parseCapturedGraphqlRequest(request: {
	headers: Record<string, string>;
	method: string;
	postData: string | null;
	url: string;
}): CapturedOperation | null {
	if (request.method !== "POST" || !request.postData) return null;
	let path: string;
	try {
		const url = new URL(request.url);
		if (url.origin !== FB_ORIGIN) return null;
		path = url.pathname;
	} catch {
		return null;
	}
	if (path !== GRAPHQL_PATH) return null;
	const form = new URLSearchParams(request.postData);
	const friendlyName =
		form.get("fb_api_req_friendly_name") ??
		request.headers["x-fb-friendly-name"] ??
		"";
	const docId = form.get("doc_id") ?? "";
	if (
		!DOC_ID_RE.test(docId) ||
		friendlyName.length === 0 ||
		WRITE_OPERATION_RE.test(friendlyName)
	)
		return null;
	let variables: JsonRecord | null = null;
	try {
		variables = asRecord(JSON.parse(form.get("variables") ?? "{}"));
	} catch {
		variables = null;
	}
	if (!variables) return null;
	const asbd = request.headers["x-asbd-id"];
	return {
		friendlyName,
		docId,
		variables,
		asbdId: asbd && ASBD_RE.test(asbd) ? asbd : null,
	};
}

export function isValidDocId(value: unknown): value is string {
	return typeof value === "string" && DOC_ID_RE.test(value);
}

/**
 * Variables for one page of a list. The page's own captured request is the
 * template when there is one: it carries the exact variable set this build
 * of the web app sends. Without it, the operation's defaults stand in.
 * Relay "provided variables" fill any name the template lacks.
 */
export function buildVariables(args: {
	cursor: string | null;
	defaults: JsonRecord;
	overrides: JsonRecord;
	provided: JsonRecord;
	template: JsonRecord | null;
}): JsonRecord {
	const variables: JsonRecord = { ...(args.template ?? args.defaults) };
	for (const [key, value] of Object.entries(args.provided))
		if (!(key in variables)) variables[key] = value;
	for (const [key, value] of Object.entries(args.overrides))
		variables[key] = value;
	variables.cursor = args.cursor;
	return variables;
}

// ─── Operations (names and variable defaults only; doc_ids come from the page) ──

export interface OperationSpec {
	/** Fallback variables when the page's own request was not seen. */
	defaults: (context: {
		ownerId: string | null;
		viewerId: string;
	}) => JsonRecord;
	/** Exact friendly name, or a pattern for operations whose name is not known ahead. */
	friendlyName: string | RegExp;
	match: ConnectionMatcher;
}

export const POSTS_OPERATION: OperationSpec = {
	friendlyName: "ProfileCometTimelineFeedRefetchQuery",
	match: matchTimelineConnection,
	defaults: ({ viewerId }) => ({
		afterTime: null,
		beforeTime: null,
		count: 3,
		feedLocation: "TIMELINE",
		feedbackSource: 0,
		focusCommentID: null,
		memorializedSplitTimeFilter: null,
		omitPinnedPost: true,
		postedBy: null,
		privacy: null,
		privacySelectorRenderLocation: "COMET_STREAM",
		referringStoryRenderLocation: null,
		renderLocation: "timeline",
		scale: 1,
		stream_count: 1,
		taggedInOnly: null,
		trackingCode: null,
		useDefaultActor: false,
		id: viewerId,
	}),
};

export const FRIENDS_OPERATION: OperationSpec = {
	friendlyName:
		"ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
	match: matchFriendsConnection,
	defaults: ({ ownerId }) => ({
		count: 8,
		scale: 1,
		search: null,
		id: ownerId,
	}),
};

export const ACTIVITY_OPERATION: OperationSpec = {
	friendlyName: "CometActivityLogStoriesListPaginationQuery",
	match: matchActivityConnection,
	defaults: ({ viewerId }) => ({
		audience: null,
		category: null,
		count: 25,
		end_date: null,
		feedLocation: null,
		media_content_filters: [],
		month: null,
		person_id: viewerId,
		privacy: null,
		scale: 1,
		start_date: null,
		timeline_visibility: null,
		year: null,
		id: viewerId,
	}),
};

/** The joined-groups pagination query is not named in the evidence; it is taken from the page's own request. */
export const GROUPS_OPERATION: OperationSpec = {
	friendlyName: /^Groups\w*Pagination\w*Query$/,
	match: matchGroupsConnection,
	defaults: ({ ownerId }) => ({ count: 20, scale: 1, id: ownerId }),
};

export function operationMatches(
	spec: OperationSpec,
	friendlyName: string,
): boolean {
	return typeof spec.friendlyName === "string"
		? spec.friendlyName === friendlyName
		: spec.friendlyName.test(friendlyName);
}

/** Activity log categories (the `category_key` the activity-log pages use). */
export const ACTIVITY_CATEGORIES: Readonly<Record<ActivityKind, string>> = {
	reaction: "LIKEDPOSTS",
	comment: "COMMENTSCLUSTER",
};

// ─── HTTP and navigation outcomes ───────────────────────────────────────

const LOGIN_PATH_RE = /^\/(?:login|login\.php|recover|r\.php)(?:[/?#]|$)/;
const CHALLENGE_PATH_RE =
	/^\/(?:checkpoint|captcha|two_step_verification|nt\/screen)(?:[/?#]|$)/;

function pathOf(url: string): string | null {
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
}

/** Throws when the page landed on a sign-in form or a security check instead of where it was sent. */
export function assertLandedOnContent(landedUrl: string): void {
	const path = pathOf(landedUrl);
	if (path === null) return;
	if (CHALLENGE_PATH_RE.test(path))
		throw facebookError(
			ERROR_CLASSES.challenge,
			"Facebook asked for a security check",
		);
	if (LOGIN_PATH_RE.test(path))
		throw facebookError(ERROR_CLASSES.auth, "Facebook asked to sign in again");
}

/** Throws the right class for a non-data answer to a query. */
export function assertHttpOk(response: {
	status: number;
	text: string;
	url: string;
}): void {
	const html = response.text.trimStart().startsWith("<");
	assertLandedOnContent(response.url);
	if (response.status === 401)
		throw facebookError(ERROR_CLASSES.auth, "Facebook answered 401");
	if (response.status === 429)
		throw facebookError(ERROR_CLASSES.rateLimited, "Facebook answered 429");
	if (response.status >= 500)
		throw facebookError(
			ERROR_CLASSES.server,
			`Facebook answered ${response.status}`,
		);
	if (response.status === 403 && html)
		throw facebookError(
			ERROR_CLASSES.challenge,
			"Facebook answered 403 with a page",
		);
	if (response.status !== 200)
		throw facebookError(
			ERROR_CLASSES.http,
			`Facebook answered ${response.status}`,
		);
	if (html)
		throw facebookError(
			ERROR_CLASSES.challenge,
			"Facebook answered with a page instead of data",
		);
}
