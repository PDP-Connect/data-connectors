// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Core-blob emission for message text over the inline `content` cap.
 *
 * The blob bytes are the JSON encoding of the source text (the host blob
 * protocol only accepts `application/json`), so `JSON.parse(bytes)` returns the
 * exact source text, NUL and lone surrogates included.
 *
 * Hosts: the desktop collector runner provides `PDPP_BLOB_SPOOL_DIR`. The
 * mobile PageShim has no blob store and does not set it, so `blobSpoolDir()`
 * is null there and the caller must withhold the message, never truncate it.
 */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
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

export interface PreparedMessageBlob {
	blob_ref: MessageBlobRef;
	text: string;
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

/** Null when the encoded text exceeds the host blob limit. */
export function prepareMessageBlob(text: string): PreparedMessageBlob | null {
	const hash = createHash("sha256");
	let size = 0;
	for (const chunk of encodedChunks(text)) {
		size += chunk.length;
		if (size > HOST_BLOB_MAX_BYTES) {
			return null;
		}
		hash.update(chunk);
	}
	const sha256 = hash.digest("hex");
	return {
		text,
		blob_ref: {
			blob_id: `sha256:${sha256}`,
			mime_type: "application/json",
			sha256,
			size_bytes: size,
		},
	};
}

/** Writes the bytes to the host spool and returns the BLOB message to emit before the record. */
export function spoolMessageBlob(
	spoolDir: string,
	messageId: string,
	prepared: PreparedMessageBlob,
): HostBlobMessage {
	const file = `chatgpt-${randomUUID()}.json`;
	const fd = openSync(join(spoolDir, file), "wx", 0o600);
	try {
		for (const chunk of encodedChunks(prepared.text)) {
			writeSync(fd, chunk);
		}
	} finally {
		closeSync(fd);
	}
	const event: HostBlobMessage = {
		type: "BLOB",
		stream: "messages",
		key: messageId,
		file,
		mime_type: "application/json",
		size_bytes: prepared.blob_ref.size_bytes,
		sha256: prepared.blob_ref.sha256,
	};
	validateHostBlobMessage(event);
	return event;
}
