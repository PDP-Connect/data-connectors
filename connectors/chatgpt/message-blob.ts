// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Core-blob emission for message text over the inline `content` cap.
 *
 * The blob bytes are the JSON encoding of the source text (the host blob
 * protocol only accepts `application/json`), so `JSON.parse(bytes)` returns the
 * exact source text, NUL and lone surrogates included. This is the
 * `json-string-v1` codec declared on `messages.blob_ref`.
 *
 * Text is measured first (size and hash, streamed, stopping at the host cap) and
 * written later: no step holds an encoded copy of the whole text, and the caller
 * keeps only the small `MessageBlobRef`, re-deriving the text when it spools.
 *
 * Hosts: the desktop collector runner provides `PDPP_BLOB_SPOOL_DIR`. The
 * mobile PageShim has no blob store and does not set it, so `blobSpoolDir()`
 * is null there. Text a host cannot store is omitted from the record as a
 * field, never truncated.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
	HOST_BLOB_MAX_BYTES,
	type HostBlobMessage,
	validateHostBlobMessage,
} from "@pdpp/connector-protocol";

export interface MessageBlobRef {
	blob_id: string;
	mime_type: "application/json";
	sha256: string;
	size_bytes: number;
}

// Characters encoded per chunk. The JSON string is produced and written chunk
// by chunk so a multi-megabyte body is never joined into one more string or
// buffer.
const CHUNK_CHARS = 65_536;

export function blobSpoolDir(): string | null {
	return process.env.PDPP_BLOB_SPOOL_DIR || null;
}

/**
 * The JSON encoding of `text` as a sequence of byte chunks. A chunk never
 * splits a surrogate pair, so the concatenation equals `JSON.stringify(text)`.
 */
function* encodedChunks(text: string): Generator<Buffer> {
	yield Buffer.from('"');
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + CHUNK_CHARS, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd8_00 && last <= 0xdb_ff) {
			end -= 1;
		}
		yield Buffer.from(JSON.stringify(text.slice(start, end)).slice(1, -1));
		start = end;
	}
	yield Buffer.from('"');
}

/** Observer for the bounded-memory proof: sees every encoded chunk's byte length. */
export interface BlobMeasureObserver {
	onChunk?: (bytes: number) => void;
}

/**
 * Size and hash of the JSON encoding of `text`, or null when it exceeds the host
 * blob limit. Streams chunk by chunk and stops at the limit; a `text` too long to
 * fit even unescaped is rejected without encoding.
 */
export function measureMessageBlob(
	text: string,
	observer?: BlobMeasureObserver,
): MessageBlobRef | null {
	// The encoding is at least the text plus its two quotes.
	if (text.length + 2 > HOST_BLOB_MAX_BYTES) {
		return null;
	}
	const hash = createHash("sha256");
	let size = 0;
	for (const chunk of encodedChunks(text)) {
		observer?.onChunk?.(chunk.length);
		size += chunk.length;
		if (size > HOST_BLOB_MAX_BYTES) {
			return null;
		}
		hash.update(chunk);
	}
	const sha256 = hash.digest("hex");
	return {
		blob_id: `sha256:${sha256}`,
		mime_type: "application/json",
		sha256,
		size_bytes: size,
	};
}

type WriteFn = (fd: number, buffer: Buffer, offset: number) => number;

/** Writes all of `chunk`, looping over short writes; a zero-byte write fails. */
export function writeAllSync(
	fd: number,
	chunk: Buffer,
	write: WriteFn = (f, b, o) => writeSync(f, b, o),
): void {
	let offset = 0;
	while (offset < chunk.length) {
		const written = write(fd, chunk, offset);
		if (written <= 0) {
			throw new Error("blob spool write made no progress");
		}
		offset += written;
	}
}

/**
 * Writes the bytes to the host spool and returns the BLOB message to emit before
 * the record. `text` must be the text `expected` was measured from; the written
 * bytes are re-hashed and a mismatch fails instead of publishing a wrong blob.
 */
export function spoolMessageBlob(
	spoolDir: string,
	messageId: string,
	text: string,
	expected: MessageBlobRef,
	write?: WriteFn,
): HostBlobMessage {
	const file = `chatgpt-${randomUUID()}.json`;
	const path = join(spoolDir, file);
	const fd = openSync(path, "wx", 0o600);
	const hash = createHash("sha256");
	let size = 0;
	try {
		for (const chunk of encodedChunks(text)) {
			writeAllSync(fd, chunk, write);
			hash.update(chunk);
			size += chunk.length;
		}
	} catch (error) {
		closeSync(fd);
		unlinkSync(path);
		throw error;
	}
	closeSync(fd);
	if (size !== expected.size_bytes || hash.digest("hex") !== expected.sha256) {
		unlinkSync(path);
		throw new Error("blob spool bytes differ from the measured message text");
	}
	const event: HostBlobMessage = {
		type: "BLOB",
		stream: "messages",
		key: messageId,
		file,
		mime_type: "application/json",
		size_bytes: expected.size_bytes,
		sha256: expected.sha256,
	};
	validateHostBlobMessage(event);
	return event;
}
