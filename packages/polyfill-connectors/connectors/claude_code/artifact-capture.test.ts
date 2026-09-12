// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof that Claude Code tool-result bodies are retained in full.
 *
 * The regression these guard against: a session was stored as a truncated
 * projection (500-character preview, bounded head prefix) and the remaining
 * bytes existed nowhere, so the durable record could not reconstruct it.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	LocalDeviceBlobSpool,
	LocalDeviceOutbox,
} from "@pdpp/collector-runtime";

import type { ArtifactCaptureContext } from "./artifact-capture.ts";
import { emitToolResultFile } from "./index.ts";
import { TOOL_RESULT_PREVIEW_CHARS } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const roots: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "claude-artifact-"));
	roots.push(root);
	return root;
}

after(() => {
	for (const root of roots) {
		rmSync(root, { force: true, recursive: true });
	}
});

interface Harness {
	captureContext: ArtifactCaptureContext;
	outbox: LocalDeviceOutbox;
	root: string;
	spool: LocalDeviceBlobSpool;
	toolResultsDir: string;
}

function makeHarness(): Harness {
	const root = makeRoot();
	const outbox = new LocalDeviceOutbox({ path: join(root, "outbox.sqlite") });
	const spool = new LocalDeviceBlobSpool({ root: join(root, "blob-spool") });
	const toolResultsDir = join(root, "session", "tool-results");
	mkdirSync(toolResultsDir, { recursive: true });
	return {
		captureContext: {
			connectorId: "claude_code",
			connectorInstanceId: null,
			outbox,
			sourceInstanceId: "src-claude-1",
			spool,
		},
		outbox,
		root,
		spool,
		toolResultsDir,
	};
}

const SESSION_ID = "3f2a1b4c-5d6e-4f80-9a1b-2c3d4e5f6071";

/** Emits one tool-result file through the real connector path. */
async function emitFile(
	h: Harness,
	name: string,
	body: Buffer,
): Promise<Record<string, unknown>> {
	const full = join(h.toolResultsDir, name);
	writeFileSync(full, body);
	const emitted: Record<string, unknown>[] = [];
	await emitToolResultFile({
		captureContext: h.captureContext,
		emitRecord: (_stream, data) => {
			emitted.push(data as Record<string, unknown>);
			return Promise.resolve();
		},
		full,
		projectDir: "demo-project",
		sessionId: SESSION_ID,
		st: statSync(full),
		toolResultsDir: h.toolResultsDir,
	});
	assert.equal(emitted.length, 1);
	return emitted[0] as Record<string, unknown>;
}

describe("claude_code artifact capture", () => {
	it("retains the complete body of a tool result far larger than the preview", async () => {
		const h = makeHarness();
		// 2 MB of text: ~4000x the 500-character preview that was previously the
		// only stored representation.
		const body = Buffer.from("x".repeat(2 * 1024 * 1024), "utf8");

		const record = await emitFile(h, "big-output.txt", body);

		assert.equal(record.artifact_capture, "captured");
		assert.equal(
			record.artifact_sha256,
			createHash("sha256").update(body).digest("hex"),
		);
		// The whole body is durably held, not just the prefix.
		assert.deepEqual(
			await readFile(h.spool.pathFor(record.artifact_sha256 as string)),
			body,
		);
		assert.equal(
			h.spool.sizeOf(record.artifact_sha256 as string),
			body.byteLength,
		);
		h.outbox.close();
	});

	it("PRESERVES the existing inline preview fields unchanged", async () => {
		const h = makeHarness();
		const text = "A".repeat(5000);
		const body = Buffer.from(text, "utf8");

		const record = await emitFile(h, "preview.txt", body);

		// The search projection keeps its existing size and semantics. This is a
		// regression guard: collapsing it, or widening it, both change coverage.
		const preview = record.content_preview as string;
		assert.ok(preview.startsWith("A".repeat(TOOL_RESULT_PREVIEW_CHARS)));
		assert.ok(
			preview.length <= TOOL_RESULT_PREVIEW_CHARS + 1,
			"preview stays bounded at its established size",
		);
		// content_bytes still reports the TRUE full length, not the preview's.
		assert.equal(record.content_bytes, body.byteLength);
		h.outbox.close();
	});

	it("emits a record that still validates against the stream schema", async () => {
		const h = makeHarness();
		const record = await emitFile(h, "valid.txt", Buffer.from("hello world"));

		const result = validateRecord("attachments", record);
		assert.equal(result.ok, true, JSON.stringify(result));
		h.outbox.close();
	});

	it("queues the body durably so it survives the source being deleted", async () => {
		const h = makeHarness();
		const body = randomBytes(512 * 1024);
		const full = join(h.toolResultsDir, "ephemeral.bin");
		writeFileSync(full, body);

		const emitted: Record<string, unknown>[] = [];
		await emitToolResultFile({
			captureContext: h.captureContext,
			emitRecord: (_stream, data) => {
				emitted.push(data as Record<string, unknown>);
				return Promise.resolve();
			},
			full,
			projectDir: "demo-project",
			sessionId: SESSION_ID,
			st: statSync(full),
			toolResultsDir: h.toolResultsDir,
		});
		const record = emitted[0] as Record<string, unknown>;

		// The Claude Code hazard: the session file goes away and nothing else
		// holds a copy.
		rmSync(full);

		const sha = record.artifact_sha256 as string;
		assert.deepEqual(await readFile(h.spool.pathFor(sha)), body);

		// And the upload is durable work, not a one-shot call that died with the
		// source.
		const pending = h.outbox.peekReady({ sourceInstanceId: "src-claude-1" });
		assert.ok(pending, "an upload is queued");
		assert.equal(pending.kind, "blob_upload");
		h.outbox.close();
	});

	it("reports honestly, and still emits the record, when capture is unavailable", async () => {
		const h = makeHarness();
		const full = join(h.toolResultsDir, "no-capture.txt");
		const body = Buffer.from("still searchable");
		writeFileSync(full, body);

		const emitted: Record<string, unknown>[] = [];
		await emitToolResultFile({
			captureContext: null,
			emitRecord: (_stream, data) => {
				emitted.push(data as Record<string, unknown>);
				return Promise.resolve();
			},
			full,
			projectDir: "demo-project",
			sessionId: SESSION_ID,
			st: statSync(full),
			toolResultsDir: h.toolResultsDir,
		});
		const record = emitted[0] as Record<string, unknown>;

		// No blob_ref is claimed, the shortfall is explicit, and the searchable
		// projection is still emitted — degraded, not silently dropped.
		assert.equal(record.artifact_capture, "unavailable");
		assert.equal(record.artifact_sha256, null);
		assert.equal(record.content_preview, "still searchable");
		assert.equal(validateRecord("attachments", record).ok, true);
		h.outbox.close();
	});

	it("deduplicates identical bodies across sessions by content", async () => {
		const h = makeHarness();
		const body = Buffer.from("identical tool output");

		const first = await emitFile(h, "dup-a.txt", body);
		const second = await emitFile(h, "dup-b.txt", body);

		assert.equal(first.artifact_sha256, second.artifact_sha256);
		assert.equal(first.artifact_capture, "captured");
		assert.equal(second.artifact_capture, "captured");
		h.outbox.close();
	});
});
