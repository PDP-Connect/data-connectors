// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-fidelity artifact capture for Claude Code.
 *
 * Session transcripts and tool-result sidecars are stored lossily today: an
 * attachment preview is 500 characters, a tool result is a bounded head
 * prefix, and the bytes past that window exist nowhere else. Claude Code
 * sessions have no native retention policy that would hold a second copy, so
 * a truncated projection is all that survives — the durable record cannot
 * reconstruct the session.
 *
 * This module routes artifact BODIES to blob storage while leaving every
 * existing inline field exactly as it was.
 *
 * **The inline fields are a search projection, not the body.** They are
 * deliberately preserved at their current sizes and coverage rather than
 * collapsed to a uniform preview — `MESSAGE_CONTENT_PREVIEW_CHARS` is 5000 and
 * shrinking it to 500 to match the others would be a regression in searchable
 * coverage, especially for file reads. The blob is the authoritative content;
 * the preview is what makes a record findable without fetching it.
 *
 * **Capture is durable or it is not claimed.** `captureBlobArtifact` returns
 * only once the bytes are committed to the local content-addressed spool AND
 * admitted to the durable outbox. A record therefore carries a `blob_ref` only
 * when the complete bytes are already safe; it is never written on the
 * strength of an upload that might yet fail.
 */

import { createReadStream } from "node:fs";
import {
	captureBlobArtifact,
	LocalDeviceBlobSpool,
	LocalDeviceOutbox,
} from "@pdpp/collector-runtime";
import { resolveArtifactCaptureEnv } from "../../src/artifact-capture-env.ts";

/** Blob reference recorded alongside the preserved inline preview. */
export interface ArtifactBlobRef {
	blob_id: string;
	mime_type: string;
	sha256: string;
	size_bytes: number;
}

/**
 * Why an artifact body was not captured.
 *
 * Recorded on the record so an uncaptured body is visible rather than silently
 * absent. `unavailable` means no spool/outbox was wired into this run (for
 * example a fixture or dry-run context), which is a capability statement, not
 * a failure to hide.
 */
export type ArtifactCaptureStatus = "captured" | "failed" | "unavailable";

export interface ArtifactCaptureResult {
	/** sha256 of the complete body, known at spool time. Null when uncaptured. */
	sha256: string | null;
	status: ArtifactCaptureStatus;
}

export interface ArtifactCaptureContext {
	connectorId: string;
	connectorInstanceId?: string | null;
	outbox: OutboxLike;
	sourceInstanceId: string;
	spool: LocalDeviceBlobSpool;
}

/** The slice of `LocalDeviceOutbox` artifact capture needs. */
type OutboxLike = Parameters<typeof captureBlobArtifact>[0]["outbox"];

export interface CaptureFileArtifactInput {
	context: ArtifactCaptureContext | null;
	mimeType: string;
	/** Absolute path of the source file whose complete bytes are captured. */
	path: string;
	recordKey: string;
	stream: string;
}

/**
 * Capture one file's complete bytes, streaming from disk.
 *
 * The file is never materialised in memory: `createReadStream` feeds the spool
 * chunk by chunk, so a 64 MB tool-result costs a buffer per chunk rather than
 * 64 MB of heap. That matters at the observed scale — 3,541 tool-result files,
 * 1.0 GB total, mean 304 KB, largest 64 MB.
 *
 * Failures are reported, never thrown: one unreadable artifact must not abort
 * a whole session's collection. The caller records the returned status so the
 * gap is visible on the record itself.
 */
export async function captureFileArtifact(
	input: CaptureFileArtifactInput,
): Promise<ArtifactCaptureResult> {
	if (!input.context) {
		return { sha256: null, status: "unavailable" };
	}
	try {
		const captured = await captureBlobArtifact({
			connectorId: input.context.connectorId,
			connectorInstanceId: input.context.connectorInstanceId ?? null,
			content: createReadStream(input.path),
			mimeType: input.mimeType,
			outbox: input.context.outbox,
			recordKey: input.recordKey,
			sourceInstanceId: input.context.sourceInstanceId,
			spool: input.context.spool,
			stream: input.stream,
		});
		return { sha256: captured.sha256, status: "captured" };
	} catch {
		// The body is not durably held, so the record must not claim it is.
		return { sha256: null, status: "failed" };
	}
}

/**
 * Capture an in-memory artifact body (an attachment extracted from a JSONL
 * line, which is already parsed and resident).
 */
export async function captureInlineArtifact(input: {
	content: string;
	context: ArtifactCaptureContext | null;
	mimeType: string;
	recordKey: string;
	stream: string;
}): Promise<ArtifactCaptureResult> {
	if (!input.context) {
		return { sha256: null, status: "unavailable" };
	}
	try {
		const captured = await captureBlobArtifact({
			connectorId: input.context.connectorId,
			connectorInstanceId: input.context.connectorInstanceId ?? null,
			content: [Buffer.from(input.content, "utf8")],
			mimeType: input.mimeType,
			outbox: input.context.outbox,
			recordKey: input.recordKey,
			sourceInstanceId: input.context.sourceInstanceId,
			spool: input.context.spool,
			stream: input.stream,
		});
		return { sha256: captured.sha256, status: "captured" };
	} catch {
		return { sha256: null, status: "failed" };
	}
}

/** A capture context plus the handles that must be closed after the run. */
export interface OpenedArtifactCapture {
	close: () => void;
	context: ArtifactCaptureContext;
}

/**
 * Open the run's artifact stores from the environment the collector runner
 * supplied, or return null when this run has none.
 *
 * Null is the honest capability answer for a fixture or a caller that has not
 * opted in — capture then records `unavailable` rather than failing the run.
 * A store that is configured but unopenable is a different thing: that throws,
 * because silently downgrading to `unavailable` would hide a broken device.
 */
export function openArtifactCapture(input: {
	connectorId: string;
	env?: NodeJS.ProcessEnv;
}): OpenedArtifactCapture | null {
	const resolved = resolveArtifactCaptureEnv(input.env);
	if (!resolved) {
		return null;
	}
	const outbox = new LocalDeviceOutbox({ path: resolved.outboxPath });
	try {
		const spool = new LocalDeviceBlobSpool({ root: resolved.spoolRoot });
		return {
			close: () => outbox.close(),
			context: {
				connectorId: input.connectorId,
				connectorInstanceId: null,
				outbox,
				sourceInstanceId: resolved.sourceInstanceId,
				spool,
			},
		};
	} catch (error) {
		outbox.close();
		throw error;
	}
}

/**
 * The bodies this run still owes, tracked SEPARATELY from the file mtimes that
 * gate enumeration.
 *
 * The two obligations are genuinely different and were braided together
 * before: an mtime records "this file's previews were enumerated", while a
 * capture records "this file's bytes are durably held". Capture failure is
 * reported rather than thrown, so a run could checkpoint the mtime, skip the
 * unchanged file on the next run, and never retry the body — a visible gap
 * that repaired itself only if the source happened to be rewritten. Turning
 * capture on later had the same problem: files already recorded `unavailable`
 * were never revisited.
 *
 * Recording the outstanding paths lets the next run withhold exactly those
 * files' mtimes, so they are re-examined while every successfully captured
 * file stays checkpointed. One failed artifact still does not abort a session.
 *
 * A run with no capture configured at all owes nothing: `enabled` is false and
 * the ledger stays empty, so enumeration checkpoints exactly as it did before
 * artifact capture existed. Only a run that was ASKED to capture can be behind
 * on it.
 */
export class ArtifactCaptureLedger {
	readonly #enabled: boolean;
	readonly #outstanding = new Set<string>();

	constructor(options: { enabled: boolean }) {
		this.#enabled = options.enabled;
	}

	/** Note the outcome for one source file. */
	record(path: string, status: ArtifactCaptureStatus): void {
		if (!this.#enabled) {
			return;
		}
		if (status === "captured") {
			this.#outstanding.delete(path);
			return;
		}
		this.#outstanding.add(path);
	}

	/** True when this file's body is still owed. */
	isOutstanding(path: string): boolean {
		return this.#outstanding.has(path);
	}

	get size(): number {
		return this.#outstanding.size;
	}
}

export { LocalDeviceBlobSpool, LocalDeviceOutbox };
