#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Anthropic/Claude Connector.
 *
 * Acquisition (binding, per docs/migration/connector-cutover/
 * capability-map.json's `anthropic` source entry): browser session ->
 * official Claude data export (request, poll, download) -> pure ZIP
 * parser. This mirrors the legacy `claude-export-playwright.js` connector
 * (READ ONLY prior art at connectors/anthropic/, root of the repo) for the
 * OLD single-ZIP export format, reimplemented on the modern runtime's
 * seams (download-queue.ts, playwright-download.ts, bounded-zip-
 * archive.ts) instead of the legacy runner's bespoke
 * `page.captureDownload`/`page.extractZipEntries` methods.
 *
 * Streams: account_profile, conversations, messages (claude.conversations
 * split per D3), projects, project_documents (claude.projects split per D3). See
 * parsers.ts for the pure JSON -> record mapping and schemas.ts for the
 * capability-map field-mapping documentation.
 *
 * ── TWO EXPORT FORMATS ──────────────────────────────────────────────────
 *
 * `POST export_data` has been observed to return two different response
 * shapes, and this connector must handle both (evidence-gated: only kept
 * where a real observation backs it — see cut-anthropic-export report):
 *
 * 1. OLD single-ZIP format (`{ nonce }`) — the legacy connector's
 *    documented behavior: one nonce, one ZIP at
 *    `/export/{org}/download/{nonce}`, containing top-level
 *    `conversations.json` and `projects/*.json` entries. Evidence: legacy
 *    `claude-export-playwright.js` (prior art) AND a live run by the
 *    predecessor lane (2026-09-22, nonce `550cfd0a...`) that got this exact
 *    response shape from the real API.
 * 2. NEW multi-part manifest format (`{ version, total_files,
 *    data_files: [{ batch_index, category, part, filename, export_url }] }`)
 *    — observed 2026-09-22 in Tim's own UI-driven export manifest (private
 *    copy, never committed — contains one-shot signed URLs). Categories seen:
 *    `light_metadata`, `projects`, `memories`, `design_chats`,
 *    `conversations`. Each `export_url` downloads exactly ONE ZIP and is
 *    usable exactly once ("Each export URL can only be used once" per the
 *    manifest's own `instructions` field).
 *
 * Both formats are handled by inspecting the `POST export_data` JSON body
 * at runtime (`nonce` string -> old path; `data_files` array -> new path)
 * rather than by a feature flag, since which format a given account/session
 * gets is presumably server-controlled, not something this connector
 * chooses.
 *
 * The INNER layout of each multi-part category ZIP is now VERIFIED — this
 * lane read Tim's real, already-downloaded local part ZIPs offline (never
 * an export_url) and confirmed every category's exact entry names and
 * top-level JSON keys; see `parsers.ts`'s module comment above
 * `classifyManifestPartEntries` for the full per-category layout and the
 * report for the driver used. `classifyManifestPartEntries` classifies each
 * `conversations`/`projects` part's JSON entries by CONTENT SHAPE (matching
 * the verified real keys), and treats any other category (`memories`,
 * `design_chats`) as out-of-scope by category before
 * content inspection — those categories have no capability-map stream (see
 * report's CONTRACT-CHANGE-REQUEST) and are downloaded-but-not-parsed,
 * reported via PROGRESS rather than silently dropped. `light_metadata` only
 * contributes `users.json` to account_profile; login history is ignored.
 *
 * ── RESUMABILITY: OLD vs NEW FORMAT DIFFERS ─────────────────────────────
 *
 * Old format: the nonce is a stable, repeatedly-pollable reference —
 * checkpointed to STATE, resumed across runs without a new POST (see below).
 *
 * New format: each `export_url` is ONE-SHOT and, per
 * spec-collection-profile.md §5's "does not store secrets in STATE" rule,
 * is NEVER persisted to STATE. Consequently a multi-part job is only
 * resumable WITHIN the run that received the manifest — if that run is
 * interrupted after downloading some parts but not others, the
 * not-yet-downloaded parts' URLs are lost when the process exits (STATE
 * never had them), and any already-downloaded-but-not-yet-consumed part
 * bytes are discarded too (nothing durable to resume from). The next run
 * has no pending-manifest STATE to resume — it starts fresh and must
 * request an entirely new export. This is a real behavior difference from
 * the old format, not an oversight: there is no way to make one-shot,
 * secret, short-lived URLs resumable across process restarts without
 * violating the no-secrets-in-STATE rule.
 *
 * Async-export resumability for the OLD format (the crux of the original
 * implementation): the export is prepared by an async job on Anthropic's
 * side. A run:
 *   1. Checks STATE for a pending export reference (org id + nonce +
 *      requested-at) from a prior run. If present, resumes polling with
 *      the SAME nonce — never requests a second export while one is
 *      already pending (that would abandon the first job and waste the
 *      owner's rate-limit budget).
 *   2. If no pending reference, discovers the chat-capable org and POSTs
 *      export_data to request a new export, then persists the pending
 *      reference to STATE immediately (before polling), so a crash mid-poll
 *      still leaves a resumable checkpoint.
 *   3. Polls the download URL within a bounded run budget. If the export
 *      becomes ready, downloads the ZIP and clears the pending STATE as soon
 *      as the archive is recognized, then parses it, emits records, and
 *      emits a fresh STATE with `synced_at`.
 *   4. If the run budget expires before the export is ready, emits a
 *      RETRYABLE SKIP_RESULT (recovery_hint: retry_by_runtime) per
 *      requested stream and leaves the pending STATE in place for the next
 *      run to resume — no data loss, no abandoned job, no duplicate
 *      request.
 *   5. Claude gives out each download link only once. If the runtime
 *      reports that the link of a resumed export (pending or consumed) was
 *      already used (`EXPORT_LINK_SPENT`), the run drops that reference
 *      from STATE and requests a fresh export in the same run. If the link
 *      of an export requested in this run is spent, the run fails.
 *
 * Tested surfaces: process-level protocol tests against a fake page/context
 * (integration.test.ts) for both formats, and pure-parser tests against
 * SYNTHETIC fixtures for both formats, PLUS an offline driver run against
 * the real local part ZIPs (see report) exercising the actual
 * parse/classify/validate path end-to-end — the manifest-format's real
 * record counts and schema validation are now proven (see report). NO live
 * BROWSER run (request export -> poll -> download) has completed against a
 * real account this format was never observed to originate from a live
 * connector run, only from Tim's own UI-driven export already on disk.
 *
 * Known untested / unconfirmed against a real account:
 *   - The exact `/api/organizations` capability field used to select the
 *     chat-capable org (mirrors legacy: `capabilities.includes('chat')`,
 *     falling back to `capabilities.includes('claude_pro')`, then the
 *     first org).
 *   - Whether claude.ai's download endpoints still gate on
 *     `Sec-Fetch-Dest: document` (the legacy connector's documented reason
 *     for needing a real navigation/download event rather than in-page
 *     `fetch()`) — this connector navigates via `page.goto` on each
 *     download URL and captures the resulting `download` event via
 *     `attachDownloadQueue`, matching that constraint.
 *   - `docs[]` sub-field names and the multi-part category ZIP layout are
 *     NOW VERIFIED (see parsers.ts header comment) — removed from this list.
 * Host blob limit (32 MiB per blob). Each selected conversation or project
 * raw envelope is stored whole as a Core blob, streamed into the spool chunk
 * by chunk while its size and SHA-256 are computed (an object too large to
 * buffer is reread from the export by offset; nothing but one message is held
 * at a time). Message and document text over the 10M-character inline cap is
 * not truncated: `content` is null and `blob_ref` holds the full text. Nothing
 * is replaced by a stand-in. Content the host cannot store (an envelope or a
 * text whose encoding is over 32 MiB) leaves its `blob_ref` (envelope) or
 * `content` (text) field ABSENT on a record that is still emitted, so every
 * key is accounted and every stream still proves; the run reports only an
 * aggregate count and reason (no ids or titles) in a diagnostic and a PROGRESS
 * note. A real account had one 79 MiB conversation.
 *
 * The nonce download can itself be a split-export manifest: on 2026-09-22 a
 * real account's download was a `manifest-<org>-...json` file (the same
 * `data_files` shape as format 2), not a ZIP. `readManifestDownload`
 * detects it, and the run then downloads each part as in format 2. The
 * nonce stays checkpointed until the parts are read, so a failed part
 * retries the same nonce and does not request a new export.
 */

import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_BLOB_MAX_BYTES, isMainModule } from "@pdpp/connector-protocol";
import type { BrowserContext } from "playwright";
import {
	readZipEntriesFromFile,
	type ZipReadPolicy,
} from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	type EmittedMessage,
	type EnsureSessionArgs,
	nowIso,
	type ProbeSessionArgs,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { attachDownloadQueue } from "../../packages/polyfill-connectors/src/download-queue.ts";
import { savePlaywrightDownload } from "../../packages/polyfill-connectors/src/playwright-download.ts";
import {
	BufferMeter,
	InvalidConversationObjectError,
	scanConversation,
} from "./oversize-conversation.ts";
import {
	buildAccountPlanRecord,
	usablePlanOrganizations,
	classifyManifestPartEntries,
	createPipelinedJsonEntryReader,
	JSON_ENTRY_READ_CHUNK_UNITS,
	type ManifestPartFile,
	messageOmissionTimestamp,
	omittedFieldCountOf,
	oversizeTextOf,
	type ParsedExport,
	parseClassifiedExport,
	parseConversation,
	parseConversationHeader,
	parseExport,
	parseJsonArrayChunks,
	parseMessage,
	parseProject,
	parseProjectDocument,
	type RawOrganization,
	resolveExportedProfile,
	type SourceRecordEnvelope,
} from "./parsers.ts";
import { encodePdppSafeText } from "./safe-escape.ts";
import { validateRecord } from "./schemas.ts";
import {
	type SpooledBlob,
	spoolEnvelopeFromChunks,
	spoolEnvelopeText,
	spoolJsonText,
} from "./source-blob.ts";

const SESSION_COOKIE = /sessionKey|__Secure-next-auth.session-token/;
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_HOME_URL = `${CLAUDE_ORIGIN}/new`;
export const ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE =
	"Sign in to Claude in the secure browser. The import continues automatically once Claude confirms you're signed in.";

/**
 * Probe the browser's Claude session. A dead cookie probe also opens Claude's
 * sign-in origin so the runtime's manual-action handoff has a useful page.
 * Navigation errors intentionally propagate; a blank-page handoff is not a
 * successful recovery path.
 */
export async function probeAnthropicSession({
	context,
	page,
}: ProbeSessionArgs): Promise<boolean> {
	if (await hasAnthropicSessionCookie(context)) return true;
	await page.goto(CLAUDE_HOME_URL, { waitUntil: "domcontentloaded" });
	return false;
}

async function hasAnthropicSessionCookie(
	context: BrowserContext,
): Promise<boolean> {
	const cookies = await context.cookies(`${CLAUDE_ORIGIN}/`);
	return cookies.some(
		(cookie) => SESSION_COOKIE.test(cookie.name) && Boolean(cookie.value),
	);
}

export async function ensureAnthropicSession({
	assist,
	autoProbeIntervalMs,
	autoProbeWindowMs,
	capture,
	completeAssistance,
	context,
	now,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	| "assist"
	| "capture"
	| "completeAssistance"
	| "context"
	| "page"
	| "sendInteraction"
> & {
	readonly autoProbeIntervalMs?: number;
	readonly autoProbeWindowMs?: number;
	readonly now?: () => number;
}): Promise<void> {
	await manualBrowserLogin({
		assist,
		...(autoProbeIntervalMs === undefined ? {} : { autoProbeIntervalMs }),
		...(autoProbeWindowMs === undefined ? {} : { autoProbeWindowMs }),
		...(capture ? { capture } : {}),
		completeAssistance,
		isProbeSuccessful: (isLive: boolean) => isLive,
		message: ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE,
		...(now ? { now } : {}),
		page,
		probe: () => probeAnthropicSession({ context, page }),
		readinessProbe: () => hasAnthropicSessionCookie(context),
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 1800,
	});
}

/** The signed-in user's menu was the legacy collector's name and plan source. */
async function readBrowserProfile(
	page: BrowserCollectContext["page"],
): Promise<{
	name: string | null;
	plan: string | null;
}> {
	try {
		return await page.evaluate(() => {
			const clean = (value: string | null | undefined) =>
				value?.replace(/\s+/g, " ").trim() || null;
			const button = document.querySelector(
				'button[data-testid="user-menu-button"]',
			);
			const name = clean(button?.querySelector("span")?.textContent);
			const plan =
				Array.from(button?.querySelectorAll("span") ?? [])
					.map((span) => clean(span.textContent))
					.find((value) => value !== null && value !== name) ?? null;
			return { name, plan };
		});
	} catch {
		return { name: null, plan: null };
	}
}

// Bounded run budget for the export-poll loop. Generous but finite: a
// connector run must not block forever (spec-collection-profile.md §5:
// "a connector running unattended must either complete or emit a clear
// signal; it must not hang"). If the export isn't ready inside this
// budget, the run checkpoints and returns a retryable SKIP_RESULT rather
// than blocking past it. Mirrors the legacy connector's MAX_WAIT_MS.
//
// Env-overridable (matching the repo's existing timeout-override
// convention — see connectors/google_messages/index.ts,
// connectors/slack/index.ts) so integration tests can drive the
// never-ready path in milliseconds instead of the real 10-minute budget.
const MAX_POLL_WAIT_MS =
	Number(process.env.PDPP_ANTHROPIC_MAX_POLL_WAIT_MS) || 10 * 60 * 1000;
const POLL_INTERVAL_MS =
	Number(process.env.PDPP_ANTHROPIC_POLL_INTERVAL_MS) || 15_000;
const DOWNLOAD_TIMEOUT_MS =
	Number(process.env.PDPP_ANTHROPIC_DOWNLOAD_TIMEOUT_MS) || 180_000;

/** A conversation larger than this many UTF-16 units is read incrementally
 * instead of being buffered whole. */
const OVERSIZE_PARENT_UNITS = 16 * 1024 * 1024;
/** Top-level conversation fields read from an oversized parent. */
const CONVERSATION_SCAN_FIELDS: ReadonlySet<string> = new Set([
	"uuid",
	"id",
	"name",
	"summary",
	"created_at",
	"updated_at",
	"project_uuid",
	"is_starred",
]);

const CONVERSATIONS_STREAM = "conversations";
const ACCOUNT_PROFILE_STREAM = "account_profile";
const ACCOUNT_PLAN_STREAM = "account_plan";
const MESSAGES_STREAM = "messages";
const PROJECTS_STREAM = "projects";
const PROJECT_DOCUMENTS_STREAM = "project_documents";
export type AnthropicZipEntryChunkReader = (
	entryName: string,
	offset: number,
	length: number,
) => Promise<string>;

/** Why a raw source envelope has no blob: its UTF-8 size is over the host
 * blob cap. Named in the run diagnostic. */
const ENVELOPE_OMITTED_REASON = "source_envelope_exceeds_host_blob_cap";
const TEXT_ABSENT_CAP_REASON = "content_exceeds_host_blob_cap";
const TEXT_ABSENT_NO_HOST_BLOB_REASON = "host_blob_store_unavailable";
/** A text field passed the inline cap on a record that has no blob for it. */
const FIELD_ABSENT_REASON = "exceeds_inline_cap";

/** The buffered source envelope as a blob, or null when it passes the host
 * blob cap. */
function spoolSourceRecord(
	source: SourceRecordEnvelope,
	maxBytes = HOST_BLOB_MAX_BYTES,
): Promise<SpooledBlob | null> {
	return spoolEnvelopeText(
		source.stream,
		source.record_key,
		JSON.stringify(source),
		maxBytes,
	);
}

/** Text chunks of `[start, end)` of one export entry. */
async function* entryRangeChunks(
	readChunk: AnthropicZipEntryChunkReader,
	entry: { name: string; size: number },
	start: number,
	end: number,
): AsyncGenerator<string> {
	const reader = createPipelinedJsonEntryReader(readChunk, entry, start, end);
	for (let offset = start; offset < end; ) {
		const text = await reader(
			entry.name,
			offset,
			Math.min(JSON_ENTRY_READ_CHUNK_UNITS, end - offset),
		);
		if (!text || text.length > end - offset)
			throw new Error("invalid bounded conversation reread");
		yield text;
		offset += text.length;
	}
}

const ALL_STREAMS = [
	ACCOUNT_PROFILE_STREAM,
	ACCOUNT_PLAN_STREAM,
	CONVERSATIONS_STREAM,
	MESSAGES_STREAM,
	PROJECTS_STREAM,
	PROJECT_DOCUMENTS_STREAM,
];

const EXPORT_ZIP_POLICY: ZipReadPolicy = {
	// The official export can legitimately hold many project files plus one
	// conversations.json; generous but bounded, matching the legacy
	// connector's documented real-world size (33 MB for 442 conversations).
	maxEntries: 20_000,
	maxEntryUncompressedBytes: 512 * 1024 * 1024,
	maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
};

// ─── STATE shape ────────────────────────────────────────────────────────
//
// Only the OLD (single-nonce) export format is resumable across runs via
// STATE — see the module header's "RESUMABILITY: OLD vs NEW FORMAT
// DIFFERS" note. The new manifest format's per-part `export_url` values
// are one-shot secrets and are NEVER written to STATE
// (spec-collection-profile.md §5), so there is no `pending_manifest`
// STATE shape to resume from; a manifest is fully consumed or fully lost
// within the run that requested it.

interface PendingExportState {
	organization_id: string;
	nonce: string;
	requested_at: string;
}

interface AnthropicCursorState {
	pending_export?: PendingExportState;
	/** The export whose archive was last parsed successfully. */
	consumed_export?: PendingExportState;
	/** When this connector last sent `POST export_data` (each one emails
	 * the user). Drives the EXPORT_REQUEST_MIN_INTERVAL_MS rate limit. */
	last_export_requested_at?: string;
	/** Set from a 429 Retry-After: no `POST export_data` before this time. */
	export_retry_not_before?: string;
	synced_at?: string;
}

/** Claude emails the user for every export request, so request at most
 * once per 24 h. A pending export is still resumed at any time. */
const EXPORT_REQUEST_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Dev-only override of the request interval, in ms, for manual testing.
 * Off by default. Ignored when `PDPP_RUN_ID` is set: every host-supervised
 * run (Desktop dev or stable, the reference server) sets it and passes a
 * cleared environment, so the override can only apply to a hand-run
 * connector process. */
export const DEV_EXPORT_MIN_INTERVAL_ENV =
	"PDPP_ANTHROPIC_DEV_EXPORT_MIN_INTERVAL_MS";

export function exportRequestMinIntervalMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const override = env[DEV_EXPORT_MIN_INTERVAL_ENV];
	if (override === undefined || override === "" || env.PDPP_RUN_ID?.trim()) {
		return EXPORT_REQUEST_MIN_INTERVAL_MS;
	}
	const ms = Number(override);
	return Number.isFinite(ms) && ms >= 0 ? ms : EXPORT_REQUEST_MIN_INTERVAL_MS;
}

function readConversationsCursor(
	state: Record<string, unknown>,
): AnthropicCursorState {
	const cursor = state[CONVERSATIONS_STREAM];
	if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
		return {};
	}
	return cursor as AnthropicCursorState;
}

function priorCursorWithoutSyncedAt(
	cursor: AnthropicCursorState,
): AnthropicCursorState {
	const copy = { ...cursor };
	delete copy.synced_at;
	return copy;
}

function cursorWithoutExportRefs(
	cursor: AnthropicCursorState,
): AnthropicCursorState {
	const copy = { ...cursor };
	delete copy.pending_export;
	delete copy.consumed_export;
	return copy;
}

function readPendingExport(
	state: Record<string, unknown>,
): PendingExportState | null {
	// STATE is checkpoint-stream-keyed; conversations is the checkpoint
	// stream for this connector's export-level resumability (there is one
	// export job covering both scopes, so one pending-export reference is
	// enough — see collect() below for why it's stored under
	// `conversations`).
	const cursor = state[CONVERSATIONS_STREAM];
	if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
		return null;
	}
	return readExportReference((cursor as AnthropicCursorState).pending_export);
}

function readExportReference(
	ref: PendingExportState | undefined,
): PendingExportState | null {
	if (
		!ref ||
		typeof ref.organization_id !== "string" ||
		typeof ref.nonce !== "string" ||
		typeof ref.requested_at !== "string"
	) {
		return null;
	}
	return ref;
}

// ─── Claude API calls (in-page, cookie-authenticated) ───────────────────

interface ClaudeOrganization extends RawOrganization {
	uuid: string;
	capabilities?: string[];
}

async function fetchOrganizations(
	page: BrowserCollectContext["page"],
): Promise<ClaudeOrganization[]> {
	const result = await page.evaluate(async () => {
		try {
			const res = await fetch("https://claude.ai/api/organizations", {
				credentials: "include",
				headers: { accept: "application/json" },
			});
			if (!res.ok) {
				return { ok: false as const, status: res.status };
			}
			const json = (await res.json()) as unknown;
			return { ok: true as const, json };
		} catch (err) {
			return {
				ok: false as const,
				status: 0,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});
	if (!result.ok || !Array.isArray(result.json)) {
		return [];
	}
	return result.json.filter(
		(org): org is ClaudeOrganization =>
			typeof org === "object" &&
			org !== null &&
			typeof (org as { uuid?: unknown }).uuid === "string",
	);
}

/** Selects the chat-capable org, mirroring the legacy connector's
 * documented selection (chat, then claude_pro, then first org) — an
 * account can have several orgs, e.g. a separate API-only org, and the
 * chat/export surface only exists on the chat-capable one. */
function selectChatOrganization(
	orgs: ClaudeOrganization[],
): ClaudeOrganization | null {
	if (orgs.length === 0) {
		return null;
	}
	return (
		orgs.find((o) => o.capabilities?.includes("chat")) ??
		orgs.find((o) => o.capabilities?.includes("claude_pro")) ??
		orgs[0] ??
		null
	);
}

/** One entry of a new-format manifest's `data_files[]`. */
interface ManifestDataFile {
	batch_index: number;
	category: string;
	part: number;
	filename: string;
	export_url: string;
}

interface ExportManifest {
	version: string;
	total_files: number;
	data_files: ManifestDataFile[];
}

type RequestExportResult =
	| { ok: true; status: number; format: "old"; nonce: string }
	| { ok: true; status: number; format: "new"; manifest: ExportManifest }
	| {
			ok: false;
			/** HTTP status; 0 when fetch threw (network error). */
			status: number;
			format: null;
			/** Raw Retry-After header, when the response had one. */
			retryAfter?: string;
			/** Top-level key names (never values) of a 2xx JSON body that
			 * had neither `nonce` nor `data_files`. */
			bodyKeys?: string[];
	  };

function isManifestDataFile(v: unknown): v is ManifestDataFile {
	return (
		isPlainObject(v) &&
		typeof v.batch_index === "number" &&
		typeof v.category === "string" &&
		typeof v.part === "number" &&
		typeof v.filename === "string" &&
		typeof v.export_url === "string"
	);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * POST export_data and classify the response as the OLD single-nonce
 * format or the NEW multi-part manifest format (see module header). Both
 * are real, evidence-backed shapes — this dispatches on the response body
 * rather than assuming one, since which shape a given request gets is
 * server-controlled.
 */
async function requestExport(
	page: BrowserCollectContext["page"],
	organizationId: string,
): Promise<RequestExportResult> {
	return await page.evaluate(async (orgId) => {
		try {
			const res = await fetch(
				`https://claude.ai/api/organizations/${orgId}/export_data`,
				{
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json", accept: "*/*" },
					body: "{}",
				},
			);
			if (!res.ok) {
				const retryAfter = res.headers.get("retry-after");
				return {
					ok: false as const,
					status: res.status,
					format: null,
					...(retryAfter === null ? {} : { retryAfter }),
				};
			}
			let json: unknown;
			try {
				json = await res.json();
			} catch {
				return { ok: false as const, status: res.status, format: null };
			}
			if (
				typeof json === "object" &&
				json !== null &&
				typeof (json as { nonce?: unknown }).nonce === "string"
			) {
				return {
					ok: true as const,
					status: res.status,
					format: "old" as const,
					nonce: (json as { nonce: string }).nonce,
				};
			}
			if (
				typeof json === "object" &&
				json !== null &&
				Array.isArray((json as { data_files?: unknown }).data_files)
			) {
				return {
					ok: true as const,
					status: res.status,
					format: "new" as const,
					manifest: json as ExportManifest,
				};
			}
			return {
				ok: false as const,
				status: res.status,
				format: null,
				bodyKeys:
					typeof json === "object" && json !== null && !Array.isArray(json)
						? Object.keys(json).sort()
						: [],
			};
		} catch {
			return { ok: false as const, status: 0, format: null };
		}
	}, organizationId);
}

/** Retry-After is delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function parseRetryAfterSeconds(
	value: string | undefined,
	nowMs: number,
): number | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	let seconds: number;
	if (/^\d+$/.test(trimmed)) {
		seconds = Number(trimmed);
	} else {
		const dateMs = Date.parse(trimmed);
		if (Number.isNaN(dateMs)) return null;
		seconds = Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
	}
	// A huge value would overflow Date; no wait is honored past 7 days.
	return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

const MAX_RETRY_AFTER_SECONDS = 7 * 24 * 60 * 60;

interface ExportRequestFailure {
	reason:
		| "export_rate_limited"
		| "export_auth_rejected"
		| "export_response_unrecognized"
		| "export_request_failed";
	message: string;
	recoveryHint: { action: string; retryable: boolean };
	diagnostics: Record<string, number | string | string[]>;
	/** ISO time before which no new export may be requested. */
	retryNotBefore?: string;
	/** Claude answered 2xx, so it may have started an export and emailed
	 * the owner: the request counts for the 24 h interval. */
	exportMayHaveStarted?: boolean;
}

/** Map a failed `POST export_data` to a reason code and safe structured
 * diagnostics, so a rate limit, an auth rejection and a changed response
 * shape are distinguishable without reading the message text. */
export function classifyExportRequestFailure(
	req: Extract<RequestExportResult, { ok: false }>,
	nowMs: number,
): ExportRequestFailure {
	const status = req.status;
	if (status === 429) {
		const retryAfter = parseRetryAfterSeconds(req.retryAfter, nowMs);
		if (retryAfter === null) {
			// No Retry-After: wait the normal request interval, not zero.
			const retryNotBefore = new Date(
				nowMs + EXPORT_REQUEST_MIN_INTERVAL_MS,
			).toISOString();
			return {
				reason: "export_rate_limited",
				message:
					"Claude rate-limited the export request (HTTP 429) and gave no " +
					`Retry-After. A new one is not sent before ${retryNotBefore}.`,
				recoveryHint: { action: "retry_by_runtime", retryable: true },
				diagnostics: { http_status: status, retry_not_before: retryNotBefore },
				retryNotBefore,
			};
		}
		const retryNotBefore = new Date(nowMs + retryAfter * 1000).toISOString();
		return {
			reason: "export_rate_limited",
			message:
				"Claude rate-limited the export request (HTTP 429). A new one is " +
				`not sent before ${retryNotBefore}.`,
			recoveryHint: { action: "retry_by_runtime", retryable: true },
			diagnostics: {
				http_status: status,
				retry_after: retryAfter,
				retry_not_before: retryNotBefore,
			},
			retryNotBefore,
		};
	}
	if (status === 401 || status === 403) {
		return {
			reason: "export_auth_rejected",
			message: `Claude rejected the export request (HTTP ${status}).`,
			recoveryHint: { action: "refresh_credentials", retryable: false },
			diagnostics: { http_status: status },
		};
	}
	if (req.bodyKeys !== undefined) {
		return {
			reason: "export_response_unrecognized",
			message:
				`Claude answered the export request (HTTP ${status}) with a body ` +
				"that has neither nonce nor data_files.",
			recoveryHint: { action: "retry_on_connector_upgrade", retryable: false },
			diagnostics: { http_status: status, body_keys: req.bodyKeys },
			exportMayHaveStarted: status >= 200 && status < 300,
		};
	}
	return {
		reason: "export_request_failed",
		message: `Could not start the Claude export (HTTP ${status}).`,
		recoveryHint: { action: "retry_by_runtime", retryable: true },
		diagnostics: { http_status: status },
	};
}

function exportDownloadUrl(organizationId: string, nonce: string): string {
	return `${CLAUDE_ORIGIN}/export/${organizationId}/download/${nonce}`;
}

// ─── Download + parse ────────────────────────────────────────────────────

interface ExportAttemptResult {
	ready: boolean;
	zipPath?: string;
	cleanup?: () => Promise<void>;
	/** The provider refused the link because it was already used. */
	linkSpent?: Error;
}

/**
 * A runtime's download binding sets this `code` on the error it throws when
 * Claude refuses an export link because it was already used. Claude issues
 * each link once, so that export can never be downloaded again. Desktop
 * Playwright cannot tell this apart from "not ready yet" and never sets it.
 */
export const EXPORT_LINK_SPENT = "export_link_spent";

function isExportLinkSpent(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error as Error & { code?: unknown }).code === EXPORT_LINK_SPENT
	);
}

/**
 * One poll attempt: navigate to the download URL and wait briefly for a
 * `download` event. If the export isn't ready yet, Claude's SPA re-renders
 * the shell instead of firing a download — `ready: false`, caller polls
 * again. Uses attachDownloadQueue + savePlaywrightDownload (the runtime's
 * download seams) rather than hand-rolled fetch+fs, per the task's
 * "don't reinvent" instruction.
 */
async function attemptDownload(
	page: BrowserCollectContext["page"],
	downloadUrl: string,
): Promise<ExportAttemptResult> {
	const queue = attachDownloadQueue(page);
	try {
		const navigation = page
			.goto(downloadUrl, { waitUntil: "commit", timeout: DOWNLOAD_TIMEOUT_MS })
			.catch((): undefined => undefined);
		const download = await queue
			.waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS })
			.catch((): null => null);
		await navigation;
		if (!download) {
			return { ready: false };
		}
		const dir = await mkdtemp(join(tmpdir(), "pdpp-anthropic-export-"));
		const zipPath = join(dir, "export.zip");
		try {
			await savePlaywrightDownload(download, zipPath);
		} catch (error) {
			await rm(dir, { recursive: true, force: true });
			if (isExportLinkSpent(error)) return { ready: false, linkSpent: error };
			throw error;
		}
		return {
			ready: true,
			zipPath,
			cleanup: () => rm(dir, { recursive: true, force: true }),
		};
	} finally {
		queue.detach();
	}
}

interface ProjectZipFile {
	name: string;
	json: unknown;
}

/** Exported for the offline real-export driver (see report) and tests only
 * — never called from a network/network-adjacent code path outside index.ts
 * itself. Reads local ZIP bytes; no I/O beyond the given file descriptor. */
export function readExportZip(zipPath: string): {
	conversationsJson: unknown;
	projectFiles: ProjectZipFile[];
	userFiles: unknown[];
	/** True only when root `conversations.json` exists and parses to an
	 * array. A missing entry is NOT an empty account. */
	recognized: boolean;
	/** Every entry name in the archive (names only, never content). */
	entryNames: string[];
} {
	const fd = openSync(zipPath, "r");
	try {
		const fileSize = statSync(zipPath).size;
		const entries = readZipEntriesFromFile(fd, fileSize, EXPORT_ZIP_POLICY);
		const entryJson = (entry: (typeof entries)[number]): unknown => {
			const data = entry.data() as Buffer & {
				hasJsonValue?: boolean;
				jsonValue?: unknown;
			};
			return data.hasJsonValue
				? data.jsonValue
				: safeJsonParse(data.toString("utf8"));
		};
		const conversationsEntry = entries.find(
			(e) => e.name === "conversations.json",
		);
		const conversationsJson = conversationsEntry
			? entryJson(conversationsEntry)
			: null;
		const projectFiles = entries
			.filter((e) => e.name.startsWith("projects/") && e.name.endsWith(".json"))
			.map((e) => ({
				name: e.name,
				json: entryJson(e),
			}));
		const usersEntry = entries.find((e) => e.name === "users.json");
		return {
			conversationsJson,
			projectFiles,
			userFiles: usersEntry ? [entryJson(usersEntry)] : [],
			recognized: Array.isArray(conversationsJson),
			entryNames: entries.map((e) => e.name),
		};
	} finally {
		closeSync(fd);
	}
}

/** PageShim supplies archive metadata and a bounded reader instead of JSON
 * values. Keep this adapter here so the collector stays independent of the
 * host bridge; Desktop continues to use readExportZip above. */
async function readExportZipMetadata(
	zipPath: string,
	readChunk: AnthropicZipEntryChunkReader,
): Promise<{
	conversationsEntry: { name: string; size: number } | null;
	projectFiles: ProjectZipFile[];
	userFiles: unknown[];
	entryNames: string[];
}> {
	const fd = openSync(zipPath, "r");
	try {
		const entries = readZipEntriesFromFile(
			fd,
			statSync(zipPath).size,
			EXPORT_ZIP_POLICY,
		);
		const jsonEntries = entries as typeof entries & Array<{ size?: number }>;
		const byName = new Map(jsonEntries.map((entry) => [entry.name, entry]));
		const sizeOf = (entry: (typeof jsonEntries)[number]) =>
			typeof entry.size === "number" ? entry.size : entry.uncompressedSize;
		const readJsonEntry = async (entry: (typeof jsonEntries)[number]) => {
			const size = sizeOf(entry);
			const jsonEntry = { name: entry.name, size };
			const reader = createPipelinedJsonEntryReader(readChunk, jsonEntry);
			const parts: string[] = [];
			let offset = 0;
			while (offset < size) {
				const requestedLength = Math.min(
					JSON_ENTRY_READ_CHUNK_UNITS,
					size - offset,
				);
				const chunk = await reader(entry.name, offset, requestedLength);
				if (!chunk || chunk.length > requestedLength)
					throw new Error(`invalid bounded read for JSON entry ${entry.name}`);
				parts.push(chunk);
				offset += chunk.length;
			}
			return safeJsonParse(parts.join(""));
		};
		const conversationCandidate = byName.get("conversations.json");
		const conversationsEntry = conversationCandidate
			? { ...conversationCandidate, size: sizeOf(conversationCandidate) }
			: undefined;
		const projectFiles: ProjectZipFile[] = [];
		for (const entry of jsonEntries) {
			if (entry.name.startsWith("projects/") && entry.name.endsWith(".json")) {
				projectFiles.push({
					name: entry.name,
					json: await readJsonEntry(entry),
				});
			}
		}
		const usersEntry = byName.get("users.json");
		return {
			conversationsEntry: conversationsEntry
				? { name: conversationsEntry.name, size: sizeOf(conversationsEntry) }
				: null,
			projectFiles,
			userFiles: usersEntry ? [await readJsonEntry(usersEntry)] : [],
			entryNames: entries.map((entry) => entry.name),
		};
	} finally {
		closeSync(fd);
	}
}

/**
 * Read every `.json` entry out of one downloaded multi-part manifest ZIP.
 * Unlike `readExportZip` (old format), this does not assume a single fixed
 * entry name — a category ZIP holds one or more `.json` entries (verified
 * layout per category in parsers.ts's module comment). Every `.json` entry
 * is returned for `classifyManifestPartEntries` to sort by category and
 * content shape.
 *
 * Exported for the offline real-export driver (see report) and tests only
 * — see readExportZip's note above.
 */
export function readManifestPartZip(zipPath: string): ManifestPartFile[] {
	const fd = openSync(zipPath, "r");
	try {
		const fileSize = statSync(zipPath).size;
		const entries = readZipEntriesFromFile(fd, fileSize, EXPORT_ZIP_POLICY);
		return entries
			.filter((e) => e.name.endsWith(".json"))
			.map((e) => ({
				name: e.name,
				json: safeJsonParse(e.data().toString("utf8")),
			}));
	} finally {
		closeSync(fd);
	}
}

/** PageShim entries have metadata only; read their JSON through the active
 * shell handle instead of the ZIP compatibility entry's empty `data()` stub. */
async function readManifestPartZipChunks(
	zipPath: string,
	readChunk: AnthropicZipEntryChunkReader,
): Promise<ManifestPartFile[]> {
	const fd = openSync(zipPath, "r");
	try {
		const entries = readZipEntriesFromFile(
			fd,
			statSync(zipPath).size,
			EXPORT_ZIP_POLICY,
		);
		const sizedEntries = entries as Array<
			(typeof entries)[number] & { size?: number }
		>;
		const jsonEntries = sizedEntries.filter((entry) =>
			entry.name.endsWith(".json"),
		);
		const result: ManifestPartFile[] = [];
		for (const entry of jsonEntries) {
			const size =
				typeof entry.size === "number" ? entry.size : entry.uncompressedSize;
			const descriptor = { name: entry.name, size };
			const reader = createPipelinedJsonEntryReader(readChunk, descriptor);
			const chunks: string[] = [];
			for (let offset = 0; offset < size; ) {
				const length = Math.min(JSON_ENTRY_READ_CHUNK_UNITS, size - offset);
				const chunk = await reader(entry.name, offset, length);
				if (!chunk || chunk.length > length)
					throw new Error(`invalid bounded read for JSON entry ${entry.name}`);
				chunks.push(chunk);
				offset += chunk.length;
			}
			result.push({ name: entry.name, json: safeJsonParse(chunks.join("")) });
		}
		return result;
	} finally {
		closeSync(fd);
	}
}

/** A nonce download larger than this is never a manifest. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Claude's nonce download can deliver the split-export manifest JSON
 * (`{ data_files: [...] }`) instead of one ZIP. The owner's 2026-09-22
 * export arrived this way: a `manifest-<org>-...json` file plus one ZIP per
 * category. Returns the manifest, or null when the file is a ZIP or any
 * other content. Exported for tests only.
 */
export function readManifestDownload(path: string): ExportManifest | null {
	const size = statSync(path).size;
	if (size === 0 || size > MAX_MANIFEST_BYTES) {
		return null;
	}
	const bytes = readFileSync(path);
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
		return null;
	}
	const json = safeJsonParse(bytes.toString("utf8"));
	if (!isPlainObject(json) || !Array.isArray(json.data_files)) {
		return null;
	}
	return json as unknown as ExportManifest;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ─── Multi-part manifest download (new format) ─────────────────────────

interface ManifestPartDownloadResult {
	category: string;
	filename: string;
	outcome: "downloaded" | "download_failed";
	entries: ManifestPartFile[];
	completeJsonBoundary?: boolean;
}

/**
 * Download and read one manifest part. Each `export_url` is one-shot
 * (navigating to an already-used or expired one is expected to 403 or
 * simply not fire a `download` event) — that is a normal, anticipated
 * outcome here, not a bug, and is reported as `download_failed` rather
 * than thrown.
 */
async function downloadManifestPart(
	page: BrowserCollectContext["page"],
	dataFile: ManifestDataFile,
	readChunk?: AnthropicZipEntryChunkReader,
): Promise<ManifestPartDownloadResult> {
	const attempt = await attemptDownload(page, dataFile.export_url);
	if (!attempt.ready || !attempt.zipPath) {
		return {
			category: dataFile.category,
			filename: dataFile.filename,
			outcome: "download_failed",
			entries: [],
		};
	}
	try {
		const entries = readChunk
			? await readManifestPartZipChunks(attempt.zipPath, readChunk)
			: readManifestPartZip(attempt.zipPath);
		return {
			category: dataFile.category,
			filename: dataFile.filename,
			outcome: "downloaded",
			entries,
			completeJsonBoundary: archiveEntriesMatch(attempt.zipPath, (name) =>
				name.endsWith(".json"),
			),
		};
	} finally {
		await attempt.cleanup?.();
	}
}

/** Unknown archive entries cannot establish a complete source boundary. */
function archiveEntriesMatch(
	zipPath: string,
	known: (name: string) => boolean,
): boolean {
	const fd = openSync(zipPath, "r");
	try {
		const entries = readZipEntriesFromFile(
			fd,
			statSync(zipPath).size,
			EXPORT_ZIP_POLICY,
			{
				requireCompleteCentralDirectory: true,
			},
		);
		return entries.length > 0 && entries.every((entry) => known(entry.name));
	} finally {
		closeSync(fd);
	}
}

// ─── Retryable SKIP_RESULT helpers ───────────────────────────────────────

async function emitPendingSkip(
	emit: (msg: EmittedMessage) => Promise<void>,
	requested: Map<string, unknown>,
	message: string,
): Promise<void> {
	for (const stream of ALL_STREAMS) {
		if (!requested.has(stream)) {
			continue;
		}
		await emit({
			type: "SKIP_RESULT",
			stream,
			reason: "export_pending",
			message,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
	}
}

/** At most this many entry names go into one PROGRESS event: names from an
 * unknown layout can hold user-written titles, and an archive can hold
 * thousands of entries. */
const MAX_REPORTED_ENTRY_NAMES = 50;

/**
 * The downloaded archive has no entry this connector recognizes. A missing
 * `conversations.json` is not an empty account, so fail closed: skip every
 * selected stream (account_profile too; with no record and no skip the host
 * treats it as a verified empty) and emit no `synced_at`. Only entry NAMES
 * are reported, never content.
 */
async function emitLayoutUnrecognizedSkip(
	emit: (msg: EmittedMessage) => Promise<void>,
	progress: BrowserCollectContext["progress"],
	requested: Map<string, unknown>,
	entryNames: readonly string[],
): Promise<void> {
	const shown = entryNames.slice(0, MAX_REPORTED_ENTRY_NAMES);
	const hidden = entryNames.length - shown.length;
	connectorDiagnostic("anthropic", "export_layout_unrecognized", {
		entry_count: entryNames.length,
		entry_names: shown.join(", ") || "(none)",
		hidden_entry_count: hidden,
	});
	await progress(
		"The Claude export did not contain conversations or projects in a format we recognize",
		{
			stream: CONVERSATIONS_STREAM,
		},
	);
	for (const stream of ALL_STREAMS) {
		if (!requested.has(stream)) {
			continue;
		}
		await emit({
			type: "SKIP_RESULT",
			stream,
			reason: "export_layout_unrecognized",
			message:
				"The Claude export archive has no recognized conversations or projects content. " +
				"No data was imported, and this run does not claim the account is empty.",
			recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
		});
	}
}

/**
 * One or more manifest parts failed to download this run (one-shot URL
 * already used/expired, or the download never fired). Since the manifest
 * itself is never persisted to STATE (see module header), there is no
 * "resume the same manifest" option — the recovery hint is still
 * retryable, but the next run must request an entirely new export.
 */
async function emitManifestPartFailureSkip(
	emit: (msg: EmittedMessage) => Promise<void>,
	requested: Map<string, unknown>,
	failedParts: readonly ManifestPartDownloadResult[],
	resumableByNonce: boolean,
): Promise<void> {
	const failedList = failedParts
		.map((p) => `${p.category} (${p.filename})`)
		.join(", ");
	const next = resumableByNonce
		? "The export request is checkpointed, so the next run downloads " +
			"the same export again without requesting a new one."
		: "A fresh export must be requested on the next run — this " +
			"manifest's other part URLs cannot be reused.";
	for (const stream of ALL_STREAMS) {
		if (!requested.has(stream)) {
			continue;
		}
		await emit({
			type: "SKIP_RESULT",
			stream,
			reason: "export_part_download_failed",
			message:
				`${failedParts.length} of this export's parts could not be ` +
				`downloaded (one-shot URL already used, expired, or never ` +
				`became ready): ${failedList}. ${next}`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
	}
}

// ─── Connector ────────────────────────────────────────────────────────────

/**
 * The connector's full collect() logic, exported (not inlined in
 * runConnector()) so integration tests can drive it directly against a
 * fake page/context without a real browser or the stdio protocol
 * subprocess — see integration.test.ts.
 */
export async function collectAnthropic({
	page,
	requested,
	state,
	emit,
	emitRecord,
	isRecordSelected,
	recoveryOnly,
	detailGaps,
	progress,
	readZipEntryChunk,
	entriesValidated,
	storeSourceRecords = true,
	bufferMeter = new BufferMeter(),
	testOverrides,
}: BrowserCollectContext & {
	readZipEntryChunk?: AnthropicZipEntryChunkReader;
	entriesValidated?: boolean;
	storeSourceRecords?: boolean;
	/** Records the largest text the oversize-parent reader held at once. */
	bufferMeter?: BufferMeter;
	/** Per-collection test seam. Production calls use the real limits and delay. */
	testOverrides?: {
		maxBufferedObjectUnits?: number;
		maxBlobBytes?: number;
		inlineTextMaxUnits?: number;
		initialDelayMs?: number;
	};
}): Promise<void> {
	if (requested.size === 0) {
		return;
	}

	await page
		.goto(CLAUDE_HOME_URL, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		})
		.catch((): undefined => undefined);
	const initialDelayMs = testOverrides?.initialDelayMs ?? 1500;
	if (initialDelayMs > 0) await politeDelay(initialDelayMs);
	const browserProfile = await readBrowserProfile(page);
	// One read of the signed-in account's organizations, shared by the
	// account_plan stream (plan family, creation time) and the export request
	// (which organization to export). It runs here, on the claude.ai page and
	// before any download navigation, and only when the plan stream was asked for.
	let organizationsRead: Promise<ClaudeOrganization[]> | undefined;
	const readOrganizations = (): Promise<ClaudeOrganization[]> => {
		organizationsRead ??= fetchOrganizations(page);
		return organizationsRead;
	};
	const organizations = requested.has(ACCOUNT_PLAN_STREAM)
		? await readOrganizations()
		: [];
	// The legacy key stays bound to the actual export org (or unchanged selector
	// in a plan-only run). Enumerating plans must never request another export.
	const emitAccountPlan = async (organizationId: string): Promise<void> => {
		const usable = usablePlanOrganizations(organizations);
		if (!usable.some((org) => org.uuid === organizationId)) {
			await emit({
				type: "SKIP_RESULT",
				stream: ACCOUNT_PLAN_STREAM,
				reason: "organization_unavailable",
				message: "The exported organization has no readable chat plan.",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
			return;
		}
		for (const org of usable) {
			const plan = buildAccountPlanRecord(org, org.uuid === organizationId);
			if (!plan) continue;
			if (plan.plan_type === null || plan.account_created_at === null) {
				connectorDiagnostic("anthropic", "account_plan_incomplete", {
					plan_type: plan.plan_type === null ? "absent" : "read",
					account_created_at:
						plan.account_created_at === null ? "absent" : "read",
				});
			}
			await emitRecord(ACCOUNT_PLAN_STREAM, plan);
		}
		await emit(
			buildFullScanCoverageMessage(ACCOUNT_PLAN_STREAM, usable.length),
		);
	};
	// The plan needs no export. A run that asks for nothing else must not request
	// one: each request emails the account owner.
	if (![...requested.keys()].some((stream) => stream !== ACCOUNT_PLAN_STREAM)) {
		const planOrganization = selectChatOrganization(organizations);
		if (planOrganization) {
			await emitAccountPlan(planOrganization.uuid);
		} else {
			await emit({
				type: "SKIP_RESULT",
				stream: ACCOUNT_PLAN_STREAM,
				reason: "no_chat_organization",
				message:
					"No chat-capable Claude organization could be resolved from the session.",
				recovery_hint: { action: "refresh_credentials", retryable: false },
			});
		}
		return;
	}

	const wantsConversations = requested.has(CONVERSATIONS_STREAM);
	const wantsMessages = requested.has(MESSAGES_STREAM);
	const wantsProjects = requested.has(PROJECTS_STREAM);
	const wantsDocuments = requested.has(PROJECT_DOCUMENTS_STREAM);
	// A parent is worth reading if either requested scope can use it. An
	// absent lower bound in any requested scope makes this coarse union
	// unbounded; final selection still belongs to each record's own scope.
	const windowSinceMs = Math.min(
		...[CONVERSATIONS_STREAM, MESSAGES_STREAM]
			.filter((stream) => requested.has(stream))
			.map((stream) => {
				const since = requested.get(stream)?.time_range?.since;
				return since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
			}),
	);
	const isWithinTimeWindow = (value: unknown): boolean => {
		if (!Number.isFinite(windowSinceMs)) return true;
		if (typeof value !== "string") return false;
		const updatedAt = Date.parse(value);
		return Number.isFinite(updatedAt) && updatedAt >= windowSinceMs;
	};
	// A sibling conversation scope must not widen messages' omission window.
	// Only a child's own usable time locates it at a point. An undated
	// child could fall anywhere between the parent's creation and update;
	// missing or invalid endpoints leave that side of the interval unbounded.
	const messagesWindow = requested.get(MESSAGES_STREAM)?.time_range;
	const messagesSinceMs = Date.parse(messagesWindow?.since ?? "");
	const messagesUntilMs = Date.parse(messagesWindow?.until ?? "");
	const messageOmissionAffectsScope = (
		childTime: number | null,
		parent: Record<string, unknown>,
	): boolean => {
		if (childTime !== null) {
			return (
				(!Number.isFinite(messagesSinceMs) || childTime >= messagesSinceMs) &&
				(!Number.isFinite(messagesUntilMs) || childTime <= messagesUntilMs)
			);
		}
		const parentCreatedMs =
			typeof parent.created_at === "string"
				? Date.parse(parent.created_at)
				: Number.NaN;
		const parentUpdatedMs =
			typeof parent.updated_at === "string"
				? Date.parse(parent.updated_at)
				: Number.NaN;
		return !(
			(Number.isFinite(messagesSinceMs) &&
				Number.isFinite(parentUpdatedMs) &&
				parentUpdatedMs < messagesSinceMs) ||
			(Number.isFinite(messagesUntilMs) &&
				Number.isFinite(parentCreatedMs) &&
				parentCreatedMs > messagesUntilMs)
		);
	};
	if ((wantsConversations || wantsProjects) && !isRecordSelected) {
		throw new Error(
			"Anthropic host blob collection requires the runtime record selector",
		);
	}

	// Source identities and delivered identities are measured independently.
	// beforeEmit is called only after runtime selection and validation; an
	// awaited emitRecord alone can also mean silently filtered or rejected.
	const rawMessageIds = new Set<string>();
	const rawConversationIds = new Set<string>();
	const deliveredMessageIds = new Set<string>();
	let completeMessages = true;
	// Archive-wide and per-stream source accounting for the other native
	// streams. Each flag only ever moves from true to false.
	let archiveComplete = true;
	let conversationsBoundary = false;
	let conversationsExact = true;
	let projectsExact = true;
	let documentsExact = true;
	let projectsExplicitEmpty = false;
	let ambiguousClassification = false;
	const rawCoverageConversationIds = new Set<string>();
	const rawProjectIds = new Set<string>();
	const rawDocumentIds = new Set<string>();
	const deliveredConversationIds = new Set<string>();
	const deliveredProjectIds = new Set<string>();
	const deliveredDocumentIds = new Set<string>();
	const unrestrictedStream = (stream: string) => {
		if (recoveryOnly || detailGaps?.length) {
			return false;
		}
		const scope = requested.get(stream);
		return (
			scope !== undefined &&
			scope.time_range === undefined &&
			scope.resources === undefined &&
			scope.fields === undefined
		);
	};
	const accountConversationIdentity = (
		parent: ReturnType<typeof parseConversationHeader>,
		hasDocs: boolean,
	) => {
		// A conversation that also carries docs is ambiguous for every stream
		// of this export, so it is noted whichever streams were requested.
		if (hasDocs) {
			ambiguousClassification = true;
		}
		if (!wantsConversations) {
			return;
		}
		if (!parent || rawCoverageConversationIds.has(parent.id)) {
			conversationsExact = false;
			return;
		}
		rawCoverageConversationIds.add(parent.id);
	};
	const accountRawConversationSource = (raw: unknown) => {
		accountConversationIdentity(
			isPlainObject(raw) && Array.isArray(raw.chat_messages)
				? parseConversationHeader(raw, 0)
				: null,
			isPlainObject(raw) && Object.hasOwn(raw, "docs"),
		);
	};
	const accountRawProject = (raw: unknown) => {
		// A project that also carries chat_messages is ambiguous the same way.
		if (isPlainObject(raw) && Object.hasOwn(raw, "chat_messages")) {
			ambiguousClassification = true;
		}
		if (!wantsProjects && !wantsDocuments) {
			return;
		}
		const parsed = isPlainObject(raw) ? parseProject(raw) : null;
		if (!isPlainObject(raw) || !parsed) {
			projectsExact = false;
			documentsExact = false;
			return;
		}
		const projectId = parsed.project.id;
		if (rawProjectIds.has(projectId)) {
			projectsExact = false;
			documentsExact = false;
			return;
		}
		rawProjectIds.add(projectId);
		// A missing, null or malformed child list is unknown, never empty.
		if (!Array.isArray(raw.docs)) {
			documentsExact = false;
			return;
		}
		for (const rawDocument of raw.docs) {
			const document = isPlainObject(rawDocument)
				? parseProjectDocument(rawDocument, projectId)
				: null;
			if (!document || rawDocumentIds.has(document.id)) {
				documentsExact = false;
				continue;
			}
			rawDocumentIds.add(document.id);
		}
	};
	const unrestrictedMessages = () => {
		if (recoveryOnly || detailGaps?.length) {
			return false;
		}
		for (const stream of [CONVERSATIONS_STREAM, MESSAGES_STREAM]) {
			const scope = requested.get(stream);
			if (
				scope &&
				(scope.time_range !== undefined ||
					scope.resources !== undefined ||
					scope.fields !== undefined)
			) {
				return false;
			}
		}
		return wantsMessages;
	};
	/** The message-proof side of one conversation: its identity and whether
	 * `chat_messages` is an array. Children follow via accountMessageChild. */
	const accountMessageParent = (
		parent: ReturnType<typeof parseConversationHeader>,
		chatMessagesIsArray: boolean,
	): boolean => {
		if (!wantsMessages) {
			return false;
		}
		if (!(chatMessagesIsArray && parent)) {
			completeMessages = false;
			return false;
		}
		if (rawConversationIds.has(parent.id)) {
			completeMessages = false;
		}
		rawConversationIds.add(parent.id);
		return true;
	};
	const accountMessageChild = (
		message: ReturnType<typeof parseMessage> | null,
	) => {
		if (!wantsMessages) {
			return;
		}
		if (!message || rawMessageIds.has(message.id)) {
			completeMessages = false;
			return;
		}
		rawMessageIds.add(message.id);
	};
	const accountRawConversation = async (raw: unknown) => {
		accountRawConversationSource(raw);
		if (!(wantsMessages && isPlainObject(raw))) {
			if (wantsMessages) completeMessages = false;
			return;
		}
		const { chat_messages } = raw;
		const parent = parseConversationHeader(raw, 0);
		const messagesAccounted = accountMessageParent(
			parent,
			Array.isArray(chat_messages),
		);
		if (!parent) return;
		let omittedMessages =
			!Array.isArray(chat_messages) && messageOmissionAffectsScope(null, raw);
		if (messagesAccounted && Array.isArray(chat_messages)) {
			for (const child of chat_messages) {
				const message = parseMessage(child, parent.id);
				accountMessageChild(message);
				if (
					!message &&
					messageOmissionAffectsScope(messageOmissionTimestamp(child), raw)
				)
					omittedMessages = true;
			}
		}
		if (omittedMessages)
			await reportConversationOmission(parent.id, [MESSAGES_STREAM]);
	};
	const markDelivered = (
		delivered: Set<string>,
		id: string,
		kind: "c" | "p" | "d",
	) => {
		if (delivered.has(id)) {
			if (kind === "c") conversationsExact = false;
			else if (kind === "p") projectsExact = false;
			else documentsExact = false;
		}
		delivered.add(id);
	};
	// Records whose raw envelope or text has no blob, counted per stream for
	// the run's aggregate disclosure (no ids, no titles).
	const omittedEnvelopes = { conversations: 0, projects: 0 };
	const absentText = {
		messages: { cap: 0, host: 0 },
		project_documents: { cap: 0, host: 0 },
	};
	// Text fields left absent for passing the inline cap (never cut to a
	// prefix); counted per stream as records are emitted.
	const omittedFields = {
		conversations: 0,
		projects: 0,
		messages: 0,
		project_documents: 0,
	};
	/**
	 * Emit one record whose text may pass the inline cap. The text is never
	 * truncated: over the inline cap `content` is null and the full text is a
	 * Core blob; text the host cannot store as a blob (over the cap, or no blob
	 * store) leaves `content` absent. The record is emitted in every case.
	 */
	const emitTextRecord = async (
		stream: typeof MESSAGES_STREAM | typeof PROJECT_DOCUMENTS_STREAM,
		record: { id: string; content: unknown },
		afterSelected: () => void,
	) => {
		const text = oversizeTextOf(record);
		const omitted = omittedFieldCountOf(record);
		if (text === null) {
			await emitRecord(stream, record, {
				beforeEmit: () => {
					afterSelected();
					omittedFields[stream] += omitted;
					return Promise.resolve();
				},
			});
			return;
		}
		const { content: _inline, ...rest } = record;
		let blob: SpooledBlob | null = null;
		if (!storeSourceRecords) {
			absentText[stream].host += 1;
		} else if (isRecordSelected?.(stream, record) !== false) {
			blob = await spoolJsonText(
				stream,
				record.id,
				text,
				testOverrides?.maxBlobBytes,
			);
			// TODO(pdpp-host-blob-cap): text over max_blob_bytes is omitted; revisit if the protocol raises the cap or adds multi-part blobs.
			if (!blob) absentText[stream].cap += 1;
		}
		await emitRecord(
			stream,
			blob ? { ...rest, content: null, blob_ref: blob.blob_ref } : rest,
			{
				beforeEmit: () => {
					afterSelected();
					omittedFields[stream] += omitted;
					return blob ? emit(blob.event) : Promise.resolve();
				},
			},
		);
	};
	const emitMessage = async (
		message: NonNullable<ReturnType<typeof parseMessage>>,
	) => {
		await emitTextRecord(MESSAGES_STREAM, message, () => {
			if (deliveredMessageIds.has(message.id)) {
				completeMessages = false;
			}
			deliveredMessageIds.add(message.id);
		});
	};
	const emitSourceRecord = async (
		stream: typeof CONVERSATIONS_STREAM | typeof PROJECTS_STREAM,
		record: { id: string },
		blob: SpooledBlob | null,
		onSelected: () => void,
	) => {
		const omitted = omittedFieldCountOf(record);
		await emitRecord(
			stream,
			blob ? { ...record, blob_ref: blob.blob_ref } : record,
			{
				beforeEmit: () => {
					onSelected();
					omittedFields[stream] += omitted;
					return blob ? emit(blob.event) : Promise.resolve();
				},
			},
		);
	};
	/** The raw envelope as a blob, or null when this host stores no blobs or
	 * the envelope passes the host cap (then counted for the run report). */
	const spoolEnvelope = async (
		stream: typeof CONVERSATIONS_STREAM | typeof PROJECTS_STREAM,
		source: () => Promise<SpooledBlob | null>,
	): Promise<SpooledBlob | null> => {
		if (!storeSourceRecords) return null;
		const blob = await source();
		// TODO(pdpp-host-blob-cap): raw envelopes over max_blob_bytes are omitted; revisit if the protocol raises the cap or adds multi-part blobs.
		if (!blob) omittedEnvelopes[stream] += 1;
		return blob;
	};
	/** Aggregate disclosure of the above: run diagnostics and one owner-facing
	 * note per stream, with counts only. Not a gap and not a skip: every record
	 * is still emitted and accounted. */
	const reportOmissions = async () => {
		const plural = (n: number) => (n === 1 ? "item" : "items");
		const rows: Array<[string, number, string, string]> = [
			[
				CONVERSATIONS_STREAM,
				omittedEnvelopes.conversations,
				ENVELOPE_OMITTED_REASON,
				"too large to keep a raw copy of; the {record} imported without {it}",
			],
			[
				PROJECTS_STREAM,
				omittedEnvelopes.projects,
				ENVELOPE_OMITTED_REASON,
				"too large to keep a raw copy of; the {record} imported without {it}",
			],
			[
				MESSAGES_STREAM,
				absentText.messages.cap,
				TEXT_ABSENT_CAP_REASON,
				"too large to store; the {record} imported without the text",
			],
			[
				PROJECT_DOCUMENTS_STREAM,
				absentText.project_documents.cap,
				TEXT_ABSENT_CAP_REASON,
				"too large to store; the {record} imported without the text",
			],
			[
				MESSAGES_STREAM,
				absentText.messages.host,
				TEXT_ABSENT_NO_HOST_BLOB_REASON,
				"too large for this device to store; the {record} imported without the text",
			],
			[
				PROJECT_DOCUMENTS_STREAM,
				absentText.project_documents.host,
				TEXT_ABSENT_NO_HOST_BLOB_REASON,
				"too large for this device to store; the {record} imported without the text",
			],
			...(
				[
					CONVERSATIONS_STREAM,
					PROJECTS_STREAM,
					MESSAGES_STREAM,
					PROJECT_DOCUMENTS_STREAM,
				] as const
			).map((stream): [string, number, string, string] => [
				stream,
				omittedFields[stream],
				FIELD_ABSENT_REASON,
				"had a value too large to store; the {record} imported without that value",
			]),
		];
		for (const [stream, count, reason, what] of rows) {
			if (count === 0) continue;
			connectorDiagnostic("anthropic", "export_items_too_large", {
				stream,
				count,
				reason,
				max_bytes: HOST_BLOB_MAX_BYTES,
			});
			const label = stream.replaceAll("_", " ");
			await progress(
				`${count} ${plural(count)} of ${label} in the export ${count === 1 ? "was" : "were"} ${what
					.replace("{record}", count === 1 ? "record was" : "records were")
					.replace("{it}", count === 1 ? "it" : "them")}`,
				{ stream, count },
			);
		}
		omittedEnvelopes.conversations = 0;
		omittedEnvelopes.projects = 0;
		absentText.messages = { cap: 0, host: 0 };
		absentText.project_documents = { cap: 0, host: 0 };
		omittedFields.conversations = 0;
		omittedFields.projects = 0;
		omittedFields.messages = 0;
		omittedFields.project_documents = 0;
	};

	// The conversations cursor from STATE. The run updates it when it drops a
	// spent export reference or reads an export, so later STATE builds on it.
	let priorCursor = readConversationsCursor(state);

	// Actual conversation omissions must also block successful checkpoints,
	// not merely withhold full-scan coverage. Successfully streamed records
	// (including envelopes too large for a raw blob) are unaffected.
	const conversationSkipped = new Set<string>();
	const reportConversationOmission = async (
		conversationId: string | null,
		streams: readonly string[],
		startOffset?: number,
	) => {
		for (const stream of streams) {
			if (!requested.has(stream)) continue;
			conversationSkipped.add(stream);
			if (stream === CONVERSATIONS_STREAM) conversationsExact = false;
			if (stream === MESSAGES_STREAM) completeMessages = false;
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason:
					startOffset === undefined
						? "export_conversation_incomplete"
						: "export_oversized_conversation_incomplete",
				message:
					`Conversation ${conversationId ?? "(identity unavailable)"} could not be fully read, ` +
					`so ${stream} is incomplete and was not checkpointed.`,
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
				diagnostics: {
					...(conversationId === null
						? {}
						: { conversation_id: conversationId }),
					...(startOffset === undefined ? {} : { source_offset: startOffset }),
				},
			});
		}
	};

	/**
	 * Emit the parsed export. Callers must first confirm the archive layout
	 * was recognized; only then is an empty result real evidence of an empty
	 * account, and only then may `synced_at` be checkpointed.
	 */
	async function emitParsed(
		parsed: ParsedExport,
		organizationId: string,
		userFiles: readonly unknown[],
		browserProfileAppliesToExport: boolean,
		exportBookkeeping: Pick<
			AnthropicCursorState,
			"consumed_export" | "last_export_requested_at"
		>,
		/** In-scope manifest entries whose content matched no known shape,
		 * counted by the parent stream they would have fed. */
		unclassifiedEntries: { conversations: number; projects: number } = {
			conversations: 0,
			projects: 0,
		},
		/** The manifest has no recognized conversations source. That is not
		 * an empty account, so conversations and messages are skipped. */
		conversationsSourceMissing = false,
	): Promise<void> {
		const selectedConversations: Array<{
			record: (typeof parsed.conversations)[number];
			source: SourceRecordEnvelope;
		}> = [];
		const selectedProjects: Array<{
			record: (typeof parsed.projects)[number];
			source: SourceRecordEnvelope;
		}> = [];
		const inWindowConversationIds = new Set<string>();
		for (const [index, record] of parsed.conversations.entries()) {
			if (isWithinTimeWindow(record.update_time))
				inWindowConversationIds.add(record.id);
			if (wantsConversations) {
				const source = parsed.conversationSources[index];
				if (!source || source.record_key !== record.id)
					throw new Error("Anthropic conversation source alignment failed");
				if (
					isWithinTimeWindow(record.update_time) &&
					isRecordSelected?.(CONVERSATIONS_STREAM, record)
				)
					selectedConversations.push({ record, source });
			}
		}
		if (wantsProjects) {
			for (const [index, record] of parsed.projects.entries()) {
				const source = parsed.projectSources[index];
				if (!source || source.record_key !== record.id)
					throw new Error("Anthropic project source alignment failed");
				if (isRecordSelected?.(PROJECTS_STREAM, record))
					selectedProjects.push({ record, source });
			}
		}
		if (requested.has(ACCOUNT_PROFILE_STREAM)) {
			const profile = resolveExportedProfile(
				userFiles,
				browserProfile.name,
				browserProfileAppliesToExport,
			);
			if (
				profile.metadataStatus !== "valid" ||
				!browserProfileAppliesToExport ||
				profile.fullName === null
			) {
				connectorDiagnostic("anthropic", "account_profile_unverified", {
					metadata_status: profile.metadataStatus,
					name_source: profile.nameSource,
					outcome: !browserProfileAppliesToExport
						? "resumed_export_owner_not_verified_browser_name_and_plan_omitted"
						: profile.fullName === null
							? "export_owner_not_verified_name_and_plan_omitted"
							: "browser_profile_belongs_to_new_export",
				});
				await progress(
					!browserProfileAppliesToExport
						? "The signed-in Claude profile may not belong to this export, so its name and plan were not used"
						: profile.fullName === null
							? "Could not confirm which Claude account this export belongs to; profile name and plan were left out"
							: "Claude account details for this export could not be fully verified",
					{
						stream: ACCOUNT_PROFILE_STREAM,
					},
				);
			}
			// Delivered with the old mapping, but never proven complete: users.json
			// carries no raw field that ties its roster entry to the requested
			// organization, so a name match cannot establish identity or ownership.
			await emitRecord(ACCOUNT_PROFILE_STREAM, {
				id: organizationId,
				organization_id: organizationId,
				full_name:
					profile.fullName === null
						? null
						: encodePdppSafeText(profile.fullName),
				plan:
					browserProfileAppliesToExport &&
					profile.metadataStatus !== "mismatch" &&
					profile.metadataStatus !== "ambiguous" &&
					profile.fullName !== null &&
					browserProfile.plan !== null
						? encodePdppSafeText(browserProfile.plan)
						: null,
				name_source: profile.nameSource,
				metadata_status: profile.metadataStatus,
			});
		}
		if (requested.has(ACCOUNT_PLAN_STREAM)) {
			// The exported organization's plan; see emitAccountPlan.
			await emitAccountPlan(organizationId);
		}
		if (wantsConversations) {
			for (const { record: conversation, source } of selectedConversations) {
				const blob = await spoolEnvelope(CONVERSATIONS_STREAM, () =>
					spoolSourceRecord(source, testOverrides?.maxBlobBytes),
				);
				await emitSourceRecord(CONVERSATIONS_STREAM, conversation, blob, () =>
					markDelivered(deliveredConversationIds, conversation.id, "c"),
				);
			}
		}
		if (wantsMessages) {
			for (const message of parsed.messages) {
				if (
					Number.isFinite(windowSinceMs) &&
					!inWindowConversationIds.has(message.conversation_id)
				)
					continue;
				await emitMessage(message);
			}
		}
		if (wantsProjects) {
			for (const { record: project, source } of selectedProjects) {
				const blob = await spoolEnvelope(PROJECTS_STREAM, () =>
					spoolSourceRecord(source, testOverrides?.maxBlobBytes),
				);
				await emitSourceRecord(PROJECTS_STREAM, project, blob, () =>
					markDelivered(deliveredProjectIds, project.id, "p"),
				);
			}
		}
		if (wantsDocuments) {
			for (const doc of parsed.projectDocuments) {
				await emitTextRecord(PROJECT_DOCUMENTS_STREAM, doc, () =>
					markDelivered(deliveredDocumentIds, doc.id, "d"),
				);
			}
		}
		await reportOmissions();
		// A dropped parent item also drops its child items (a conversation's
		// messages, a project's documents). An unparseable item skips the
		// parent and child streams: a skipped stream keeps its prior snapshot
		// and gets no synced_at. A large item is not dropped: see
		// reportOmissions.
		const dropGroups: Array<[readonly string[], number]> = [
			[
				[CONVERSATIONS_STREAM, MESSAGES_STREAM],
				parsed.droppedConversations + unclassifiedEntries.conversations,
			],
			[
				[PROJECTS_STREAM, PROJECT_DOCUMENTS_STREAM],
				parsed.droppedProjects + unclassifiedEntries.projects,
			],
		];
		const skipped = new Set(conversationSkipped);
		if (conversationsSourceMissing) {
			for (const stream of [CONVERSATIONS_STREAM, MESSAGES_STREAM]) {
				if (!requested.has(stream)) {
					continue;
				}
				skipped.add(stream);
				await emit({
					type: "SKIP_RESULT",
					stream,
					reason: "export_conversations_missing",
					message:
						"The Claude export has no recognized conversations entry, so " +
						`${stream} was not imported and was not checkpointed.`,
					recovery_hint: {
						action: "retry_on_connector_upgrade",
						retryable: false,
					},
				});
			}
		}
		for (const [streams, count] of dropGroups) {
			if (count === 0) {
				continue;
			}
			const [parent] = streams;
			const parentLabel = (parent ?? CONVERSATIONS_STREAM).replaceAll("_", " ");
			await progress(
				`${count} ${count === 1 ? "item" : "items"} of ${parentLabel} in the export could not be read and ${count === 1 ? "was" : "were"} not imported`,
				{ stream: parent ?? CONVERSATIONS_STREAM, count },
			);
			for (const stream of streams) {
				if (!requested.has(stream) || skipped.has(stream)) {
					continue;
				}
				skipped.add(stream);
				await emit({
					type: "SKIP_RESULT",
					stream,
					reason: "export_items_unparseable",
					recovery_hint: {
						action: "retry_on_connector_upgrade",
						retryable: false,
					},
					message: `${count} ${parent} item(s) in the export could not be parsed, so ${stream} is incomplete and was not checkpointed.`,
					diagnostics: { dropped_count: count },
				});
			}
		}
		if (
			unrestrictedMessages() &&
			completeMessages &&
			!ambiguousClassification &&
			!skipped.has(MESSAGES_STREAM) &&
			rawMessageIds.size === deliveredMessageIds.size &&
			[...rawMessageIds].every((id) => deliveredMessageIds.has(id))
		) {
			await emit(
				buildFullScanCoverageMessage(MESSAGES_STREAM, rawMessageIds.size),
			);
		}
		const sameIds = (
			raw: ReadonlySet<string>,
			delivered: ReadonlySet<string>,
		) =>
			raw.size === delivered.size && [...raw].every((id) => delivered.has(id));
		const archiveProven = archiveComplete && !ambiguousClassification;
		// Coverage is self-measured from raw source items and the records the
		// runtime actually accepted; it is emitted once, after the stream's
		// last record.
		const conversationsProven =
			wantsConversations &&
			unrestrictedStream(CONVERSATIONS_STREAM) &&
			archiveProven &&
			conversationsBoundary &&
			conversationsExact &&
			!skipped.has(CONVERSATIONS_STREAM) &&
			sameIds(rawCoverageConversationIds, deliveredConversationIds);
		const projectsProven =
			wantsProjects &&
			unrestrictedStream(PROJECTS_STREAM) &&
			archiveProven &&
			projectsExact &&
			!skipped.has(PROJECTS_STREAM) &&
			(rawProjectIds.size > 0 || projectsExplicitEmpty) &&
			sameIds(rawProjectIds, deliveredProjectIds);
		const documentsProven =
			wantsDocuments &&
			projectsProven &&
			unrestrictedStream(PROJECT_DOCUMENTS_STREAM) &&
			documentsExact &&
			!skipped.has(PROJECT_DOCUMENTS_STREAM) &&
			sameIds(rawDocumentIds, deliveredDocumentIds);
		if (conversationsProven) {
			await emit(
				buildFullScanCoverageMessage(
					CONVERSATIONS_STREAM,
					rawCoverageConversationIds.size,
				),
			);
		}
		if (projectsProven) {
			await emit(
				buildFullScanCoverageMessage(PROJECTS_STREAM, rawProjectIds.size),
			);
		}
		if (documentsProven) {
			await emit(
				buildFullScanCoverageMessage(
					PROJECT_DOCUMENTS_STREAM,
					rawDocumentIds.size,
				),
			);
		}
		const syncedAt = nowIso();
		if (wantsConversations) {
			// Keep the consumed nonce and request time: the next run needs
			// last_export_requested_at for the rate limit.
			await emit({
				type: "STATE",
				stream: CONVERSATIONS_STREAM,
				cursor: skipped.has(CONVERSATIONS_STREAM)
					? { ...exportBookkeeping }
					: { ...exportBookkeeping, synced_at: syncedAt },
			});
		}
		if (wantsMessages && !skipped.has(MESSAGES_STREAM)) {
			await emit({
				type: "STATE",
				stream: MESSAGES_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
		if (wantsProjects && !skipped.has(PROJECTS_STREAM)) {
			await emit({
				type: "STATE",
				stream: PROJECTS_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
		// Documents are collected with their projects, so they are checkpointed
		// with them. An account with no projects then reports both as complete.
		if (wantsDocuments && !skipped.has(PROJECT_DOCUMENTS_STREAM)) {
			await emit({
				type: "STATE",
				stream: PROJECT_DOCUMENTS_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
	}

	async function emitStreamingConversations(
		entry: { name: string; size: number },
		entryNames: string[],
		organizationId: string,
		userFiles: readonly unknown[],
		browserProfileAppliesToExport: boolean,
		exportBookkeeping: Pick<
			AnthropicCursorState,
			"consumed_export" | "last_export_requested_at"
		>,
		parsedProjects: ParsedExport,
	): Promise<void> {
		if (!readZipEntryChunk)
			throw new Error("Anthropic incremental export reader is unavailable");
		const readChunk = readZipEntryChunk;
		const entryReader = createPipelinedJsonEntryReader(readChunk, entry);
		// The conversations entry is not a JSON array. Projects do not depend
		// on it, so they still import; only an archive with no projects either
		// is unrecognized.
		const emitProjectsWithoutConversations = async () => {
			if (parsedProjects.projects.length === 0) {
				await emitLayoutUnrecognizedSkip(emit, progress, requested, entryNames);
				return;
			}
			completeMessages = false;
			archiveComplete = false;
			await emitParsed(
				parsedProjects,
				organizationId,
				userFiles,
				browserProfileAppliesToExport,
				exportBookkeeping,
				undefined,
				true,
			);
		};
		if (!entriesValidated) {
			try {
				await parseJsonArrayChunks(entryReader, entry, () => {});
			} catch (error) {
				if ((error as { code?: string })?.code !== "INVALID_JSON_ARRAY")
					throw error;
				await emitProjectsWithoutConversations();
				return;
			}
		}
		let droppedConversations = 0;
		const processConversation = async (raw: unknown) => {
			await accountRawConversation(raw);
			const updatedAt =
				typeof raw === "object" && raw !== null && !Array.isArray(raw)
					? (raw as Record<string, unknown>).updated_at
					: undefined;
			if (!isWithinTimeWindow(updatedAt)) return;
			const parsed = parseConversation(raw);
			if (!parsed) {
				droppedConversations += 1;
				return;
			}
			const source: SourceRecordEnvelope = {
				format: "anthropic-source-record-v1",
				stream: "conversations",
				record_key: parsed.conversation.id,
				payload: raw as Record<string, unknown>,
			};
			if (wantsMessages) {
				for (const message of parsed.messages) await emitMessage(message);
			}
			if (
				wantsConversations &&
				isRecordSelected?.(CONVERSATIONS_STREAM, parsed.conversation)
			) {
				const blob = await spoolEnvelope(CONVERSATIONS_STREAM, () =>
					spoolSourceRecord(source, testOverrides?.maxBlobBytes),
				);
				await emitSourceRecord(
					CONVERSATIONS_STREAM,
					parsed.conversation,
					blob,
					() =>
						markDelivered(
							deliveredConversationIds,
							parsed.conversation.id,
							"c",
						),
				);
			}
		};
		/**
		 * A conversation object too large to buffer. Its fields are read in one
		 * tokenizer pass, wherever they sit in the object; its messages are
		 * reread one at a time by offset, in created_at order; its raw envelope
		 * is copied to the blob spool chunk by chunk. Nothing but one message
		 * is held at once, whatever the parent's size.
		 */
		const processOversizedConversation = async (value: {
			startOffset: number;
			endOffset: number;
		}) => {
			const chunks = (start: number, end: number) =>
				entryRangeChunks(readChunk, entry, start, end);
			let scan: Awaited<ReturnType<typeof scanConversation>>;
			try {
				scan = await scanConversation(
					chunks(value.startOffset, value.endOffset),
					value.startOffset,
					CONVERSATION_SCAN_FIELDS,
					bufferMeter,
					testOverrides?.inlineTextMaxUnits,
				);
			} catch (error) {
				// Do not swallow host/read failures or downstream sink errors.
				if (!(error instanceof InvalidConversationObjectError)) throw error;
				await reportConversationOmission(
					error.conversationId,
					[CONVERSATIONS_STREAM, MESSAGES_STREAM],
					value.startOffset,
				);
				return;
			}
			const header = Object.fromEntries(scan.fields);
			const conversation = parseConversationHeader(
				header,
				scan.messageCount,
				scan.overCap,
			);
			const chatMessagesIsArray = scan.chatMessages === "array";
			accountConversationIdentity(
				chatMessagesIsArray
					? parseConversationHeader(header, 0, scan.overCap)
					: null,
				scan.hasDocs,
			);
			const messagesAccounted = accountMessageParent(
				conversation,
				chatMessagesIsArray,
			);
			if (messagesAccounted && scan.omittedMessageTimes.length > 0)
				completeMessages = false;
			// The scan already saw every child. Account omissions before the
			// coarse parent gate, without rereading out-of-window messages.
			if (
				wantsMessages &&
				((!chatMessagesIsArray && messageOmissionAffectsScope(null, header)) ||
					scan.omittedMessageTimes.some((time) =>
						messageOmissionAffectsScope(time, header),
					))
			)
				await reportConversationOmission(
					conversation?.id ?? null,
					[MESSAGES_STREAM],
					value.startOffset,
				);
			if (!isWithinTimeWindow(header.updated_at)) return;
			if (!conversation) {
				droppedConversations += 1;
				return;
			}
			if (wantsMessages) {
				const ordered = [...scan.messageKeys].sort(
					(a, b) => a.sortTime - b.sortTime || a.index - b.index,
				);
				for (const key of ordered) {
					const parts: string[] = [];
					let units = 0;
					for await (const part of chunks(key.start, key.end)) {
						parts.push(part);
						units += part.length;
						bufferMeter.note(scan.retainedUnits + units);
					}
					// The parts and their joined copy are alive together.
					bufferMeter.note(scan.retainedUnits + 2 * units);
					const message = parseMessage(
						JSON.parse(parts.join("")),
						conversation.id,
					);
					if (messagesAccounted) accountMessageChild(message);
					if (message) await emitMessage(message);
				}
			}
			if (
				wantsConversations &&
				isRecordSelected?.(CONVERSATIONS_STREAM, conversation)
			) {
				const blob = await spoolEnvelope(CONVERSATIONS_STREAM, () =>
					spoolEnvelopeFromChunks(
						CONVERSATIONS_STREAM,
						conversation.id,
						chunks(value.startOffset, value.endOffset),
						testOverrides?.maxBlobBytes,
					),
				);
				await emitSourceRecord(CONVERSATIONS_STREAM, conversation, blob, () =>
					markDelivered(deliveredConversationIds, conversation.id, "c"),
				);
			}
		};
		try {
			await parseJsonArrayChunks(
				entryReader,
				entry,
				processConversation,
				JSON_ENTRY_READ_CHUNK_UNITS,
				{
					validatedEntry: Boolean(entriesValidated),
					...(entriesValidated
						? {
								maxBufferedObjectUnits:
									testOverrides?.maxBufferedObjectUnits ??
									OVERSIZE_PARENT_UNITS,
							}
						: {}),
					onOversizedObject: async (_prefix, value) => {
						await processOversizedConversation(value);
					},
				},
			);
		} catch (error) {
			if ((error as { code?: string })?.code !== "INVALID_JSON_ARRAY")
				throw error;
			await emitProjectsWithoutConversations();
			return;
		}
		parsedProjects.droppedConversations = droppedConversations;
		await emitParsed(
			parsedProjects,
			organizationId,
			userFiles,
			browserProfileAppliesToExport,
			exportBookkeeping,
		);
	}

	// Resume a pending OLD-format export from a prior run — NEVER request a
	// second export while one is already pending (would abandon the first
	// job's budget and waste Anthropic's rate limit on this account). The
	// NEW manifest format has no equivalent resume path (see module header)
	// — STATE only ever holds an old-format pending reference.
	//
	// A resumed export whose link Claude reports as already used is dropped,
	// and the run requests a fresh export below. The 24 h request interval
	// does not apply then: without a fresh export the run has nothing to
	// import. Claude's own 429 back-off still applies.
	const pending = readPendingExport(state);
	let resumedLinkSpent = false;

	if (pending) {
		if ((await pollAndEmitOldFormat(pending, false)) === "done") return;
		resumedLinkSpent = true;
	}

	const retryNotBefore = priorCursor.export_retry_not_before;
	if (retryNotBefore && Date.now() < Date.parse(retryNotBefore)) {
		for (const stream of ALL_STREAMS) {
			if (!requested.has(stream)) {
				continue;
			}
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "export_rate_limited",
				message:
					"Claude rate-limited the last export request. A new one is not " +
					`sent before ${retryNotBefore}.`,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				diagnostics: { retry_not_before: retryNotBefore },
			});
		}
		return;
	}

	const lastRequestedAt = priorCursor.last_export_requested_at;
	if (lastRequestedAt && !resumedLinkSpent) {
		const elapsedMs = Date.now() - Date.parse(lastRequestedAt);
		const minIntervalMs = exportRequestMinIntervalMs();
		if (elapsedMs >= 0 && elapsedMs < minIntervalMs) {
			// The last export is still inside the request window. Download it
			// again instead of skipping: this costs no new email, and a run
			// that skipped a stream last time can finish it.
			const consumed = readExportReference(priorCursor.consumed_export);
			if (consumed) {
				if ((await pollAndEmitOldFormat(consumed, false)) === "done") return;
			} else {
				const nextAt = new Date(
					Date.parse(lastRequestedAt) + minIntervalMs,
				).toISOString();
				for (const stream of ALL_STREAMS) {
					if (!requested.has(stream)) {
						continue;
					}
					await emit({
						type: "SKIP_RESULT",
						stream,
						reason: "export_recently_requested",
						message:
							`A Claude export was already requested at ${lastRequestedAt}. ` +
							"Each request sends you an email, so a new one is not sent " +
							`before ${nextAt}.`,
						recovery_hint: { action: "retry_by_runtime", retryable: true },
					});
				}
				return;
			}
		}
	}

	const orgs = await readOrganizations();
	const org = selectChatOrganization(orgs);
	if (!org) {
		// Every export-derived stream is skipped: a stream with no record and
		// no skip counts as complete and empty.
		for (const stream of ALL_STREAMS) {
			if (!requested.has(stream)) {
				continue;
			}
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "no_chat_organization",
				message:
					"No chat-capable Claude organization could be resolved from the session.",
				recovery_hint: { action: "refresh_credentials", retryable: false },
			});
		}
		return;
	}
	const organizationId = org.uuid;

	await progress("Requesting Claude data export...", {
		stream: CONVERSATIONS_STREAM,
	});
	const req = await requestExport(page, org.uuid);
	if (!req.ok) {
		const failure = classifyExportRequestFailure(req, Date.now());
		if (failure.retryNotBefore || failure.exportMayHaveStarted) {
			await emit({
				type: "STATE",
				stream: CONVERSATIONS_STREAM,
				cursor: {
					...priorCursor,
					...(failure.retryNotBefore
						? { export_retry_not_before: failure.retryNotBefore }
						: {}),
					...(failure.exportMayHaveStarted
						? { last_export_requested_at: nowIso() }
						: {}),
				},
			});
		}
		// Skip every export-derived stream, as the guard paths above do.
		for (const stream of ALL_STREAMS) {
			if (!requested.has(stream)) {
				continue;
			}
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: failure.reason,
				message: failure.message,
				recovery_hint: failure.recoveryHint,
				diagnostics: failure.diagnostics,
			});
		}
		return;
	}

	if (req.format === "old") {
		const newPending: PendingExportState = {
			organization_id: org.uuid,
			nonce: req.nonce,
			requested_at: nowIso(),
		};
		// Checkpoint immediately, before polling: a crash mid-poll must not
		// lose the nonce and force a second export request next run.
		await emit({
			type: "STATE",
			stream: CONVERSATIONS_STREAM,
			cursor: {
				...priorCursor,
				pending_export: newPending,
				last_export_requested_at: newPending.requested_at,
			},
		});
		await pollAndEmitOldFormat(newPending, true);
		return;
	}

	// ── NEW multi-part manifest format ──────────────────────────────────
	// No pending-STATE checkpoint here — the manifest's export_url values
	// are one-shot secrets and are never persisted (see module header). A
	// crash between here and full consumption loses this job; the next run
	// starts over with a fresh POST export_data (after the rate limit).
	const manifestRequestedAt = nowIso();
	await emit({
		type: "STATE",
		stream: CONVERSATIONS_STREAM,
		// No synced_at: nothing has been downloaded yet.
		cursor: {
			...priorCursorWithoutSyncedAt(priorCursor),
			last_export_requested_at: manifestRequestedAt,
		},
	});
	await downloadAndEmitManifest(
		req.manifest,
		organizationId,
		{ last_export_requested_at: manifestRequestedAt },
		true,
		false,
	);

	/** Returns "link_spent" when a resumed export can no longer be
	 * downloaded and the caller should request a fresh one. */
	async function pollAndEmitOldFormat(
		pendingExport: PendingExportState,
		pendingExportWasCreatedThisRun: boolean,
	): Promise<"done" | "link_spent"> {
		const downloadUrl = exportDownloadUrl(
			pendingExport.organization_id,
			pendingExport.nonce,
		);
		const waitStart = Date.now();
		let attempt: ExportAttemptResult = { ready: false };
		for (;;) {
			const elapsedSeconds = Math.round((Date.now() - waitStart) / 1000);
			await progress(
				elapsedSeconds === 0
					? "Waiting for Claude to prepare your export..."
					: `Still preparing your export (${elapsedSeconds}s elapsed)...`,
				{ stream: CONVERSATIONS_STREAM },
			);
			attempt = await attemptDownload(page, downloadUrl);
			if (attempt.ready || attempt.linkSpent) {
				break;
			}
			if (Date.now() - waitStart > MAX_POLL_WAIT_MS) {
				break;
			}
			await politeDelay(POLL_INTERVAL_MS);
		}

		if (attempt.linkSpent) {
			// Retrying this nonce can never succeed, so drop it from STATE.
			priorCursor = cursorWithoutExportRefs(priorCursor);
			await emit({
				type: "STATE",
				stream: CONVERSATIONS_STREAM,
				cursor: pendingExportWasCreatedThisRun
					? {
							...priorCursor,
							last_export_requested_at: pendingExport.requested_at,
						}
					: priorCursor,
			});
			// A nonce requested in this run has no older export to fall back
			// from, so the run fails as before.
			if (pendingExportWasCreatedThisRun) throw attempt.linkSpent;
			await progress(
				"Claude already gave out the download link for the saved export. " +
					"Requesting a new export...",
				{ stream: CONVERSATIONS_STREAM },
			);
			return "link_spent";
		}

		if (!attempt.ready || !attempt.zipPath) {
			// Leave the pending-export STATE in place (do not overwrite it) so
			// the next run resumes polling the SAME nonce.
			await emitPendingSkip(
				emit,
				requested,
				"Claude's export was not ready within this run's poll budget. " +
					"The request is checkpointed — the next run will resume polling " +
					"the same export instead of requesting a new one.",
			);
			return "done";
		}

		try {
			await progress("Reading downloaded export...", {
				stream: CONVERSATIONS_STREAM,
			});
			const manifest = readManifestDownload(attempt.zipPath);
			if (manifest) {
				// No STATE until the parts are read: pending_export stays, so a
				// failed part download retries this nonce, not a new export.
				await downloadAndEmitManifest(
					manifest,
					pendingExport.organization_id,
					{
						consumed_export: pendingExport,
						last_export_requested_at: pendingExport.requested_at,
					},
					pendingExportWasCreatedThisRun,
					true,
				);
				return "done";
			}
			const streamedArchive = readZipEntryChunk
				? await readExportZipMetadata(attempt.zipPath, readZipEntryChunk)
				: null;
			const {
				conversationsJson,
				projectFiles,
				userFiles,
				recognized,
				entryNames,
			} = streamedArchive
				? {
						conversationsJson: null,
						projectFiles: streamedArchive.projectFiles,
						userFiles: streamedArchive.userFiles,
						recognized: streamedArchive.conversationsEntry !== null,
						entryNames: streamedArchive.entryNames,
					}
				: readExportZip(attempt.zipPath);
			// Projects are read from their own entries, so a missing or
			// unreadable conversations entry does not hide them.
			if (!recognized && projectFiles.length === 0) {
				// No STATE: pending_export stays so the same export is reused.
				await emitLayoutUnrecognizedSkip(emit, progress, requested, entryNames);
				return "done";
			}
			// The export is read, and Claude gives out each download link only
			// once. Drop pending_export now, so a later failure in this run does
			// not leave a spent nonce for the next run to resume.
			priorCursor = {
				...cursorWithoutExportRefs(priorCursor),
				consumed_export: pendingExport,
				last_export_requested_at: pendingExport.requested_at,
			};
			await emit({
				type: "STATE",
				stream: CONVERSATIONS_STREAM,
				cursor: priorCursor,
			});
			completeMessages = archiveEntriesMatch(
				attempt.zipPath,
				(name) =>
					name === "conversations.json" ||
					name === "users.json" ||
					(name.startsWith("projects/") && name.endsWith(".json")),
			);
			archiveComplete = completeMessages;
			for (const file of projectFiles) accountRawProject(file.json);
			if (streamedArchive?.conversationsEntry) {
				conversationsBoundary = true;
				const parsedProjects = parseExport(
					[],
					projectFiles.map((file) => file.json),
				);
				await emitStreamingConversations(
					streamedArchive.conversationsEntry,
					streamedArchive.entryNames,
					pendingExport.organization_id,
					userFiles,
					pendingExportWasCreatedThisRun,
					{
						consumed_export: pendingExport,
						last_export_requested_at: pendingExport.requested_at,
					},
					parsedProjects,
				);
				return "done";
			}
			if (Array.isArray(conversationsJson)) {
				conversationsBoundary = true;
				for (const raw of conversationsJson) {
					await accountRawConversation(raw);
				}
			} else {
				completeMessages = false;
				archiveComplete = false;
			}
			const parsed = parseExport(
				conversationsJson,
				projectFiles.map((f) => f.json),
			);
			await emitParsed(
				parsed,
				pendingExport.organization_id,
				userFiles,
				pendingExportWasCreatedThisRun,
				{
					consumed_export: pendingExport,
					last_export_requested_at: pendingExport.requested_at,
				},
				undefined,
				!Array.isArray(conversationsJson),
			);
			return "done";
		} finally {
			await attempt.cleanup?.();
		}
	}

	async function downloadAndEmitManifest(
		manifest: ExportManifest,
		exportOrganizationId: string,
		exportBookkeeping: Pick<
			AnthropicCursorState,
			"consumed_export" | "last_export_requested_at"
		>,
		browserProfileAppliesToExport: boolean,
		/** The manifest came from a checkpointed nonce, so the next run can
		 * download it again. */
		resumableByNonce: boolean,
	): Promise<void> {
		const dataFiles = manifest.data_files.filter(isManifestDataFile);
		await progress(`Downloading ${dataFiles.length} export part(s)...`, {
			stream: CONVERSATIONS_STREAM,
		});

		const results: ManifestPartDownloadResult[] = [];
		// Sequential, not Promise.all: each export_url is one-shot and this
		// keeps at most one in-flight download per navigation, matching
		// attemptDownload's single-page navigate+wait pattern (no-await-in-
		// loops allowlisted below, same as the old poll loop's sequential
		// awaits — see scripts/no-await-in-loops-allowlist.ts).
		for (const dataFile of dataFiles) {
			const result = await downloadManifestPart(
				page,
				dataFile,
				readZipEntryChunk,
			);
			results.push(result);
			await politeDelay(500);
		}

		const failed = results.filter((r) => r.outcome === "download_failed");
		if (failed.length > 0) {
			await emitManifestPartFailureSkip(
				emit,
				requested,
				failed,
				resumableByNonce,
			);
			return;
		}

		// Only accept present, contiguous category-local parts starting at 0.
		// The real part-numbering contract is not captured in our fixtures;
		// other numbering schemes fail closed. No zero-part boundary exists.
		const categoryBoundary = (category: string) => {
			const parts = dataFiles
				.filter((part) => part.category === category)
				.map((part) => part.part)
				.sort((a, b) => a - b);
			return parts.length > 0 && parts.every((part, index) => part === index);
		};
		const conversationsManifestBoundary = categoryBoundary("conversations");
		const projectsManifestBoundary = categoryBoundary("projects");
		// Observed in parsers.ts and __fixtures__/split-export/manifest.json:
		// these categories have no declared stream, but their parts still
		// require the same archive accounting as consumed categories.
		const knownUnconsumedCategories = new Set(["memories", "design_chats"]);
		// parsers.ts and the split-export fixture document this exact name;
		// other files inside light_metadata still have unknown semantics.
		const knownUnconsumedMetadataFiles = new Set(["login_history.json"]);
		const accountedCategories = [
			"conversations",
			"projects",
			"light_metadata",
			...knownUnconsumedCategories,
		];
		const partitionsContiguous = accountedCategories.every(
			(category) =>
				!dataFiles.some((part) => part.category === category) ||
				categoryBoundary(category),
		);
		archiveComplete = completeMessages =
			manifest.version === "1.0" &&
			Number.isSafeInteger(manifest.total_files) &&
			manifest.total_files === dataFiles.length &&
			dataFiles.length === manifest.data_files.length &&
			dataFiles.every(
				(part) =>
					Number.isSafeInteger(part.batch_index) &&
					part.batch_index >= 0 &&
					Number.isSafeInteger(part.part) &&
					part.part >= 0,
			) &&
			new Set(dataFiles.map((part) => part.export_url)).size ===
				dataFiles.length &&
			new Set(dataFiles.map((part) => part.filename)).size ===
				dataFiles.length &&
			partitionsContiguous &&
			// Missing metadata is as incomplete as a partial metadata partition:
			// conservatively withhold archive-wide proof, but keep record delivery.
			categoryBoundary("light_metadata") &&
			results.every(
				(result) =>
					result.completeJsonBoundary === true &&
					accountedCategories.includes(result.category) &&
					// safeJsonParse returns null when an extra entry is unreadable.
					(!knownUnconsumedCategories.has(result.category) ||
						result.entries.every((entry) => entry.json !== null)) &&
					(result.category !== "light_metadata" ||
						result.entries.every(
							(entry) =>
								!knownUnconsumedMetadataFiles.has(entry.name) ||
								entry.json !== null,
						)),
			);
		completeMessages &&= conversationsManifestBoundary;
		conversationsExact &&= conversationsManifestBoundary;
		projectsExact &&= projectsManifestBoundary;
		const rawConversations: unknown[] = [];
		const rawProjects: unknown[] = [];
		const rawUserProfiles: unknown[] = [];
		const unclassified: string[] = [];
		const unclassifiedEntries = { conversations: 0, projects: 0 };
		let recognizedPart = false;
		// Like the nonce reader, only a conversations source proves the
		// conversations stream: a conversation item, or a literal `[]` entry
		// in a conversations part.
		let conversationsSourceFound = false;
		const outOfScopeByCategory = new Map<string, number>();
		let unaccountedEntries = false;
		for (const result of results) {
			const accountedMalformedConversations = new Set<unknown>();
			// In a conversations part, a project discriminator or unmatched shape
			// must not hide a missing or malformed conversation child list.
			for (const entry of result.entries) {
				const items = Array.isArray(entry.json) ? entry.json : [entry.json];
				if (result.category === "conversations") {
					for (const item of items) {
						if (isPlainObject(item) && !Array.isArray(item.chat_messages)) {
							// Report the named omission before shape classification can
							// divert this conversation to projects or leave it unmatched.
							await accountRawConversation(item);
							accountedMalformedConversations.add(item);
						}
					}
				}
				if (
					items.some(
						(item) =>
							isPlainObject(item) &&
							Object.hasOwn(item, "chat_messages") &&
							!Array.isArray(item.chat_messages),
					)
				) {
					completeMessages = false;
					conversationsExact = false;
				}
			}
			const classified = classifyManifestPartEntries(
				result.category,
				result.entries,
			);
			unaccountedEntries ||= classified.outOfScopeEntryNames.some(
				(name) =>
					!knownUnconsumedCategories.has(result.category) &&
					(result.category !== "light_metadata" ||
						!knownUnconsumedMetadataFiles.has(name)),
			);
			if (
				result.category === "projects" &&
				classified.emptyEntryNames.length > 0
			) {
				projectsExplicitEmpty = true;
			}
			// Cross-classified records still reach the sink, but cannot enlarge
			// another category's measured boundary or prove an empty stream.
			if (result.category === "conversations") {
				for (const raw of classified.conversations) {
					if (!accountedMalformedConversations.has(raw))
						await accountRawConversation(raw);
				}
			} else if (classified.conversations.length > 0) {
				conversationsExact = false;
				completeMessages = false;
			}
			if (result.category === "projects") {
				for (const raw of classified.projects) {
					accountRawProject(raw);
				}
			} else if (classified.projects.length > 0) {
				projectsExact = false;
				documentsExact = false;
			}
			rawConversations.push(...classified.conversations);
			rawProjects.push(...classified.projects);
			rawUserProfiles.push(...classified.userProfiles);
			unclassified.push(...classified.unclassifiedEntryNames);
			// A part is recognized by its classified content, never by its
			// category name alone.
			if (
				classified.conversations.length > 0 ||
				classified.projects.length > 0 ||
				classified.emptyEntryNames.length > 0
			) {
				recognizedPart = true;
			}
			if (
				classified.conversations.length > 0 ||
				(result.category === "conversations" &&
					classified.emptyEntryNames.length > 0)
			) {
				conversationsSourceFound = true;
			}
			if (
				result.category === "conversations" ||
				result.category === "projects"
			) {
				unclassifiedEntries[result.category] +=
					classified.unclassifiedEntryNames.length;
			}
			if (classified.outOfScopeEntryNames.length > 0) {
				outOfScopeByCategory.set(
					result.category,
					(outOfScopeByCategory.get(result.category) ?? 0) +
						classified.outOfScopeEntryNames.length,
				);
			}
		}

		// Categories this connector declares no stream for (memories,
		// design_chats, or any other future category) are
		// downloaded (the manifest offers no selective fetch) but never
		// classified for content — reported here so the run's PROGRESS log
		// names exactly which categories were out of scope, rather than
		// silently discarding them with no trace. Per CONTRACTS.md's
		// ownership boundary, this connector does not invent a stream for an
		// out-of-scope category on its own; see the report's
		// CONTRACT-CHANGE-REQUEST for the proposed `memories`/`design_chats`
		// field maps.
		if (outOfScopeByCategory.size > 0) {
			const summary = [...outOfScopeByCategory.entries()]
				.map(
					([category, count]) =>
						`${category} (${count} entr${count === 1 ? "y" : "ies"})`,
				)
				.join(", ");
			connectorDiagnostic("anthropic", "export_categories_without_stream", {
				categories: summary,
			});
			await progress(
				"Part of the Claude export is not supported yet and was skipped",
				{
					stream: CONVERSATIONS_STREAM,
				},
			);
		}

		if (unclassified.length > 0) {
			connectorDiagnostic("anthropic", "export_entries_unrecognized", {
				count: unclassified.length,
				entries: unclassified.join(", "),
			});
			await progress(
				`${unclassified.length} export item(s) were not recognized and were skipped`,
				{
					stream: CONVERSATIONS_STREAM,
				},
			);
		}

		if (!recognizedPart) {
			await emitLayoutUnrecognizedSkip(
				emit,
				progress,
				requested,
				results.flatMap((r) => r.entries.map((e) => `${r.category}/${e.name}`)),
			);
			return;
		}

		if (
			!conversationsSourceFound ||
			unclassified.length > 0 ||
			unaccountedEntries
		) {
			completeMessages = false;
		}
		if (unclassified.length > 0 || unaccountedEntries) {
			archiveComplete = false;
		}
		conversationsBoundary =
			conversationsManifestBoundary && conversationsSourceFound;
		const parsed = parseClassifiedExport(rawConversations, rawProjects);
		await emitParsed(
			parsed,
			exportOrganizationId,
			rawUserProfiles,
			browserProfileAppliesToExport,
			exportBookkeeping,
			unclassifiedEntries,
			!conversationsSourceFound,
		);
	}
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime and
// block the Node event loop on stdin. Only fires when this module IS the
// process entry point (i.e. `tsx connectors/anthropic/index.ts`). Mirrors
// connectors/amazon/index.ts's isMainModule guard.
if (isMainModule(import.meta.url)) {
	runConnector({
		name: "anthropic",
		browser: { profileName: "anthropic" },
		validateRecord,
		retryablePattern: /ECONN|fetch failed|rate_limited|export_pending/i,
		ensureSession: ensureAnthropicSession,
		probeSession: probeAnthropicSession,
		probeSessionIsAuthoritative: true,
		collect: collectAnthropic,
	});
}
