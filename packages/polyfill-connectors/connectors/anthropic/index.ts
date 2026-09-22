#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Anthropic/Claude Connector.
 *
 * Acquisition (binding, per docs/migration/connector-cutover/
 * capability-map.json's `anthropic` source entry): browser session ->
 * official Claude data export (request, poll, download ZIP) -> pure ZIP
 * parser. This mirrors the legacy `claude-export-playwright.js` connector
 * (READ ONLY prior art at connectors/anthropic/, root of the repo) — same
 * endpoints, same async-export resumability design — reimplemented on the
 * modern runtime's seams (download-queue.ts, playwright-download.ts,
 * bounded-zip-archive.ts) instead of the legacy runner's bespoke
 * `page.captureDownload`/`page.extractZipEntries` methods.
 *
 * Streams: conversations, messages (claude.conversations split per D3),
 * projects, project_documents (claude.projects split per D3). See
 * parsers.ts for the pure JSON -> record mapping and schemas.ts for the
 * capability-map field-mapping documentation.
 *
 * Async-export resumability (the crux of this connector): the export is
 * prepared by an async job on Anthropic's side. A run:
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
 * Tested surfaces: NONE — this lane has not been given live-account
 * clearance (no "PROFILE READY: anthropic"). Every code path here is
 * proven only against the synthetic fixture and process-level protocol
 * tests. Live-run proof is PENDING; see the cut-anthropic report.
 *
 * Known untested / unconfirmed against a real account:
 *   - The exact `/api/organizations` capability field used to select the
 *     chat-capable org (mirrors legacy: `capabilities.includes('chat')`,
 *     falling back to `capabilities.includes('claude_max')`, then the
 *     first org).
 *   - The exact `docs[]` sub-field names inside a project's detail (see
 *     parsers.ts header comment).
 *   - Whether claude.ai's download endpoint still gates on
 *     `Sec-Fetch-Dest: document` (the legacy connector's documented reason
 *     for needing a real navigation/download event rather than in-page
 *     `fetch()`) — this connector navigates via `page.goto` on the
 *     download URL and captures the resulting `download` event via
 *     `attachDownloadQueue`, matching that constraint.
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
import { parseExport } from "./parsers.ts";
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

interface RequestExportResult {
	ok: boolean;
	status: number;
	nonce: string | null;
}

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
			let nonce: string | null = null;
			try {
				const json = (await res.json()) as { nonce?: unknown };
				nonce = typeof json.nonce === "string" ? json.nonce : null;
			} catch {
				// no JSON body — nonce stays null, ok/status still reported
			}
			return { ok: res.ok, status: res.status, nonce };
		} catch {
			return { ok: false, status: 0, nonce: null };
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

function readExportZip(zipPath: string): {
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

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

// ─── Retryable pending-export SKIP_RESULT ───────────────────────────────

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

	// Resume a pending export from a prior run — NEVER request a second
	// export while one is already pending (would abandon the first job's
	// budget and waste Anthropic's rate limit on this account).
	let pending = readPendingExport(state);

	if (!pending) {
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
		if (!req.ok || !req.nonce) {
			await emit({
				type: "SKIP_RESULT",
				stream: CONVERSATIONS_STREAM,
				reason: "export_request_failed",
				message: `Could not start the Claude export (HTTP ${req.status}).`,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
			return;
		}
		pending = {
			organization_id: org.uuid,
			nonce: req.nonce,
			requested_at: nowIso(),
		};
		// Checkpoint immediately, before polling: a crash mid-poll must not
		// lose the nonce and force a second export request next run.
		await emit({
			type: "STATE",
			stream: CONVERSATIONS_STREAM,
			cursor: { pending_export: pending },
		});
	}

	const downloadUrl = exportDownloadUrl(pending.organization_id, pending.nonce);
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
		const { conversationsJson, projectFiles } = readExportZip(attempt.zipPath);
		const parsed = parseExport(
			conversationsJson,
			projectFiles.map((f) => f.json),
		);

		const wantsConversations = requested.has(CONVERSATIONS_STREAM);
		const wantsMessages = requested.has(MESSAGES_STREAM);
		const wantsProjects = requested.has(PROJECTS_STREAM);
		const wantsDocuments = requested.has(PROJECT_DOCUMENTS_STREAM);

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

		// Export consumed successfully: clear the pending reference and
		// checkpoint synced_at. One STATE per checkpoint stream this
		// connector declares as incremental (conversations, messages,
		// projects); project_documents is non-incremental (see
		// manifests/anthropic.json) and gets no cursor.
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
	} finally {
		await attempt.cleanup?.();
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
