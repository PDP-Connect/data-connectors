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
 * Streams: conversations, messages (claude.conversations split per D3),
 * projects, project_documents (claude.projects split per D3). See
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
 * `design_chats`, `light_metadata`) as out-of-scope by category before
 * content inspection — those categories have no capability-map stream (see
 * report's CONTRACT-CHANGE-REQUEST) and are downloaded-but-not-parsed,
 * reported via PROGRESS rather than silently dropped.
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
 *      becomes ready, downloads the ZIP, parses it, emits records, clears
 *      the pending STATE, and emits a fresh STATE with `synced_at`.
 *   4. If the run budget expires before the export is ready, emits a
 *      RETRYABLE SKIP_RESULT (recovery_hint: retry_by_runtime) per
 *      requested stream and leaves the pending STATE in place for the next
 *      run to resume — no data loss, no abandoned job, no duplicate
 *      request.
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
 *     falling back to `capabilities.includes('claude_max')`, then the
 *     first org).
 *   - Whether claude.ai's download endpoints still gate on
 *     `Sec-Fetch-Dest: document` (the legacy connector's documented reason
 *     for needing a real navigation/download event rather than in-page
 *     `fetch()`) — this connector navigates via `page.goto` on each
 *     download URL and captures the resulting `download` event via
 *     `attachDownloadQueue`, matching that constraint.
 *   - `docs[]` sub-field names and the multi-part category ZIP layout are
 *     NOW VERIFIED (see parsers.ts header comment) — removed from this list.
 */

import { closeSync, openSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	readZipEntriesFromFile,
	type ZipReadPolicy,
} from "../../src/bounded-zip-archive.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	nowIso,
	type ProbeSessionArgs,
	politeDelay,
	runConnector,
} from "../../src/connector-runtime.ts";
import { attachDownloadQueue } from "../../src/download-queue.ts";
import { savePlaywrightDownload } from "../../src/playwright-download.ts";
import {
	classifyManifestPartEntries,
	type ManifestPartFile,
	type ParsedExport,
	parseClassifiedExport,
	parseExport,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const SESSION_COOKIE = /sessionKey|__Secure-next-auth.session-token/;
const CLAUDE_ORIGIN = "https://claude.ai";
const CLAUDE_HOME_URL = `${CLAUDE_ORIGIN}/new`;

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

const CONVERSATIONS_STREAM = "conversations";
const MESSAGES_STREAM = "messages";
const PROJECTS_STREAM = "projects";
const PROJECT_DOCUMENTS_STREAM = "project_documents";
const ALL_STREAMS = [
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
	synced_at?: string;
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
	const pending = (cursor as AnthropicCursorState).pending_export;
	if (
		!pending ||
		typeof pending.organization_id !== "string" ||
		typeof pending.nonce !== "string" ||
		typeof pending.requested_at !== "string"
	) {
		return null;
	}
	return pending;
}

// ─── Claude API calls (in-page, cookie-authenticated) ───────────────────

interface ClaudeOrganization {
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
 * documented selection (chat, then claude_max, then first org) — an
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
		orgs.find((o) => o.capabilities?.includes("claude_max")) ??
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
	| { ok: false; status: number; format: null };

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
				return { ok: false as const, status: res.status, format: null };
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
			return { ok: false as const, status: res.status, format: null };
		} catch {
			return { ok: false as const, status: 0, format: null };
		}
	}, organizationId);
}

function exportDownloadUrl(organizationId: string, nonce: string): string {
	return `${CLAUDE_ORIGIN}/export/${organizationId}/download/${nonce}`;
}

// ─── Download + parse ────────────────────────────────────────────────────

interface ExportAttemptResult {
	ready: boolean;
	zipPath?: string;
	cleanup?: () => Promise<void>;
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
		await savePlaywrightDownload(download, zipPath);
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
} {
	const fd = openSync(zipPath, "r");
	try {
		const fileSize = statSync(zipPath).size;
		const entries = readZipEntriesFromFile(fd, fileSize, EXPORT_ZIP_POLICY);
		const conversationsEntry = entries.find(
			(e) => e.name === "conversations.json",
		);
		const conversationsJson = conversationsEntry
			? safeJsonParse(conversationsEntry.data().toString("utf8"))
			: [];
		const projectFiles = entries
			.filter((e) => e.name.startsWith("projects/") && e.name.endsWith(".json"))
			.map((e) => ({
				name: e.name,
				json: safeJsonParse(e.data().toString("utf8")),
			}));
		return { conversationsJson, projectFiles };
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
		const entries = readManifestPartZip(attempt.zipPath);
		return {
			category: dataFile.category,
			filename: dataFile.filename,
			outcome: "downloaded",
			entries,
		};
	} finally {
		await attempt.cleanup?.();
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
): Promise<void> {
	const failedList = failedParts
		.map((p) => `${p.category} (${p.filename})`)
		.join(", ");
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
				`became ready): ${failedList}. A fresh export must be ` +
				"requested on the next run — this manifest's other part URLs " +
				"cannot be reused.",
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
	progress,
}: BrowserCollectContext): Promise<void> {
	if (requested.size === 0) {
		return;
	}

	await page
		.goto(CLAUDE_HOME_URL, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		})
		.catch((): undefined => undefined);
	await politeDelay(1500);

	const wantsConversations = requested.has(CONVERSATIONS_STREAM);
	const wantsMessages = requested.has(MESSAGES_STREAM);
	const wantsProjects = requested.has(PROJECTS_STREAM);
	const wantsDocuments = requested.has(PROJECT_DOCUMENTS_STREAM);

	async function emitParsed(parsed: ParsedExport): Promise<void> {
		if (wantsConversations) {
			for (const conversation of parsed.conversations) {
				await emitRecord(CONVERSATIONS_STREAM, conversation);
			}
		}
		if (wantsMessages) {
			for (const message of parsed.messages) {
				await emitRecord(MESSAGES_STREAM, message);
			}
		}
		if (wantsProjects) {
			for (const project of parsed.projects) {
				await emitRecord(PROJECTS_STREAM, project);
			}
		}
		if (wantsDocuments) {
			for (const doc of parsed.projectDocuments) {
				await emitRecord(PROJECT_DOCUMENTS_STREAM, doc);
			}
		}
		const syncedAt = nowIso();
		if (wantsConversations) {
			await emit({
				type: "STATE",
				stream: CONVERSATIONS_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
		if (wantsMessages) {
			await emit({
				type: "STATE",
				stream: MESSAGES_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
		if (wantsProjects) {
			await emit({
				type: "STATE",
				stream: PROJECTS_STREAM,
				cursor: { synced_at: syncedAt },
			});
		}
	}

	// Resume a pending OLD-format export from a prior run — NEVER request a
	// second export while one is already pending (would abandon the first
	// job's budget and waste Anthropic's rate limit on this account). The
	// NEW manifest format has no equivalent resume path (see module header)
	// — STATE only ever holds an old-format pending reference.
	const pending = readPendingExport(state);

	if (pending) {
		await pollAndEmitOldFormat(pending);
		return;
	}

	const orgs = await fetchOrganizations(page);
	const org = selectChatOrganization(orgs);
	if (!org) {
		await emit({
			type: "SKIP_RESULT",
			stream: CONVERSATIONS_STREAM,
			reason: "no_chat_organization",
			message:
				"No chat-capable Claude organization could be resolved from the session.",
			recovery_hint: { action: "refresh_credentials", retryable: false },
		});
		return;
	}

	await progress("Requesting Claude data export...", {
		stream: CONVERSATIONS_STREAM,
	});
	const req = await requestExport(page, org.uuid);
	if (!req.ok) {
		await emit({
			type: "SKIP_RESULT",
			stream: CONVERSATIONS_STREAM,
			reason: "export_request_failed",
			message: `Could not start the Claude export (HTTP ${req.status}).`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
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
			cursor: { pending_export: newPending },
		});
		await pollAndEmitOldFormat(newPending);
		return;
	}

	// ── NEW multi-part manifest format ──────────────────────────────────
	// No pending-STATE checkpoint here — the manifest's export_url values
	// are one-shot secrets and are never persisted (see module header). A
	// crash between here and full consumption loses this job; the next run
	// starts over with a fresh POST export_data.
	await downloadAndEmitManifest(req.manifest);

	async function pollAndEmitOldFormat(
		pendingExport: PendingExportState,
	): Promise<void> {
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
			if (attempt.ready) {
				break;
			}
			if (Date.now() - waitStart > MAX_POLL_WAIT_MS) {
				break;
			}
			await politeDelay(POLL_INTERVAL_MS);
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
			return;
		}

		try {
			await progress("Reading downloaded export...", {
				stream: CONVERSATIONS_STREAM,
			});
			const { conversationsJson, projectFiles } = readExportZip(
				attempt.zipPath,
			);
			const parsed = parseExport(
				conversationsJson,
				projectFiles.map((f) => f.json),
			);
			await emitParsed(parsed);
		} finally {
			await attempt.cleanup?.();
		}
	}

	async function downloadAndEmitManifest(
		manifest: ExportManifest,
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
			const result = await downloadManifestPart(page, dataFile);
			results.push(result);
			await politeDelay(500);
		}

		const failed = results.filter((r) => r.outcome === "download_failed");
		if (failed.length > 0) {
			await emitManifestPartFailureSkip(emit, requested, failed);
			return;
		}

		const rawConversations: unknown[] = [];
		const rawProjects: unknown[] = [];
		const unclassified: string[] = [];
		const outOfScopeByCategory = new Map<string, number>();
		for (const result of results) {
			const classified = classifyManifestPartEntries(
				result.category,
				result.entries,
			);
			rawConversations.push(...classified.conversations);
			rawProjects.push(...classified.projects);
			unclassified.push(...classified.unclassifiedEntryNames);
			if (classified.outOfScopeEntryNames.length > 0) {
				outOfScopeByCategory.set(
					result.category,
					(outOfScopeByCategory.get(result.category) ?? 0) +
						classified.outOfScopeEntryNames.length,
				);
			}
		}

		// Categories this connector declares no stream for (memories,
		// design_chats, light_metadata, or any other future category) are
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
			await progress(
				`This export includes categories this connector does not yet ` +
					`declare a stream for — downloaded but not parsed: ${summary}.`,
				{ stream: CONVERSATIONS_STREAM },
			);
		}

		if (unclassified.length > 0) {
			await progress(
				`Warning: ${unclassified.length} export entry/entries did not ` +
					"match a known conversation or project shape and were not " +
					`parsed: ${unclassified.join(", ")}.`,
				{ stream: CONVERSATIONS_STREAM },
			);
		}

		const parsed = parseClassifiedExport(rawConversations, rawProjects);
		await emitParsed(parsed);
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
		async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
			const cookies = await context.cookies(`${CLAUDE_ORIGIN}/`);
			return cookies.some(
				(c) => SESSION_COOKIE.test(c.name) && Boolean(c.value),
			);
		},
		collect: collectAnthropic,
	});
}
