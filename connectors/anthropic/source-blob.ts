// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host blob spool for the Anthropic connector.
 *
 * Every blob is a JSON file (the host blob protocol accepts only
 * `application/json`) written chunk by chunk while its size and SHA-256 are
 * computed, so a large source object is never joined into one string or
 * buffer. A blob that would pass the host cap (`HOST_BLOB_MAX_BYTES`) is
 * abandoned: the partial file is removed and the caller gets `null`, never a
 * truncated or substitute blob.
 */

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	HOST_BLOB_MAX_BYTES,
	type HostBlobMessage,
	validateHostBlobMessage,
} from "@pdpp/connector-protocol";

export interface BlobRef {
	blob_id: string;
	mime_type: "application/json";
	sha256: string;
	size_bytes: number;
}

export interface SpooledBlob {
	event: HostBlobMessage;
	blob_ref: BlobRef;
}

/** Characters of a source string encoded per chunk. */
const TEXT_CHUNK_CHARS = 65_536;

function spoolDirectory(): string {
	const spoolDir = process.env.PDPP_BLOB_SPOOL_DIR;
	if (!spoolDir) {
		throw new Error(
			"Host blob spool is unavailable for Anthropic source records",
		);
	}
	return spoolDir;
}

/** One blob being written. `write` returns false once the cap is passed. */
class BlobWriter {
	private readonly hash = createHash("sha256");
	private readonly file = `anthropic-${randomUUID()}.json`;
	private readonly path: string;
	private readonly stream: string;
	private readonly key: string;
	private size = 0;
	private started = false;
	private overflow = false;

	constructor(
		stream: string,
		key: string,
		maxBytes = HOST_BLOB_MAX_BYTES,
	) {
		this.stream = stream;
		this.key = key;
		this.maxBytes = maxBytes;
		this.path = join(spoolDirectory(), this.file);
	}

	private readonly maxBytes: number;

	write(bytes: Buffer): boolean {
		if (this.overflow) return false;
		if (this.size + bytes.length > this.maxBytes) {
			this.overflow = true;
			return false;
		}
		if (bytes.length === 0) return true;
		writeFileSync(this.path, bytes, {
			flag: this.started ? "a" : "wx",
			mode: 0o600,
		});
		this.started = true;
		this.hash.update(bytes);
		this.size += bytes.length;
		return true;
	}

	async discard(): Promise<void> {
		if (this.started) await rm(this.path, { force: true });
	}

	async finish(): Promise<SpooledBlob | null> {
		if (this.overflow || this.size === 0) {
			await this.discard();
			return null;
		}
		const sha256 = this.hash.digest("hex");
		const event: HostBlobMessage = {
			type: "BLOB",
			stream: this.stream,
			key: this.key,
			file: this.file,
			mime_type: "application/json",
			size_bytes: this.size,
			sha256,
		};
		validateHostBlobMessage(event);
		return {
			event,
			blob_ref: {
				blob_id: `sha256:${sha256}`,
				mime_type: "application/json",
				sha256,
				size_bytes: this.size,
			},
		};
	}
}

/**
 * Encodes UTF-16 chunks to UTF-8 without splitting a surrogate pair that
 * straddles a chunk boundary.
 */
class Utf8Chunks {
	private pendingHigh = "";

	push(text: string): Buffer {
		let chunk = this.pendingHigh + text;
		this.pendingHigh = "";
		const last = chunk.charCodeAt(chunk.length - 1);
		if (last >= 0xd8_00 && last <= 0xdb_ff) {
			this.pendingHigh = chunk.slice(-1);
			chunk = chunk.slice(0, -1);
		}
		return Buffer.from(chunk, "utf8");
	}

	flush(): Buffer {
		const rest = this.pendingHigh;
		this.pendingHigh = "";
		return Buffer.from(rest, "utf8");
	}
}

/** The JSON encoding of `text` as byte chunks; their concatenation equals
 * `JSON.stringify(text)`, lone surrogates and NUL included. */
function* jsonTextChunks(text: string): Generator<Buffer> {
	yield Buffer.from('"');
	let start = 0;
	while (start < text.length) {
		let end = Math.min(start + TEXT_CHUNK_CHARS, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd8_00 && last <= 0xdb_ff) end -= 1;
		yield Buffer.from(JSON.stringify(text.slice(start, end)).slice(1, -1));
		start = end;
	}
	yield Buffer.from('"');
}

/** Spool a source envelope that is already one JSON string. Null when its
 * UTF-8 size is over the host cap. */
export async function spoolEnvelopeText(
	stream: string,
	key: string,
	envelopeJson: string,
	maxBytes = HOST_BLOB_MAX_BYTES,
): Promise<SpooledBlob | null> {
	if (Buffer.byteLength(envelopeJson, "utf8") > maxBytes)
		return null;
	const writer = new BlobWriter(stream, key, maxBytes);
	const utf8 = new Utf8Chunks();
	for (let start = 0; start < envelopeJson.length; start += TEXT_CHUNK_CHARS) {
		const bytes = utf8.push(
			envelopeJson.slice(start, start + TEXT_CHUNK_CHARS),
		);
		if (!writer.write(bytes)) {
			await writer.discard();
			return null;
		}
	}
	writer.write(utf8.flush());
	return writer.finish();
}

/**
 * Spool a source envelope whose payload is read from the export in chunks:
 * `{"format":...,"stream":...,"record_key":...,"payload":<raw>}`. The payload
 * text is copied verbatim and never held whole. Null when the envelope passes
 * the host cap.
 */
export async function spoolEnvelopeFromChunks(
	stream: "conversations" | "projects",
	key: string,
	payloadChunks: AsyncIterable<string>,
	maxBytes = HOST_BLOB_MAX_BYTES,
): Promise<SpooledBlob | null> {
	const writer = new BlobWriter(stream, key, maxBytes);
	const utf8 = new Utf8Chunks();
	const prefix = `{"format":"anthropic-source-record-v1","stream":${JSON.stringify(stream)},"record_key":${JSON.stringify(key)},"payload":`;
	if (!writer.write(Buffer.from(prefix, "utf8"))) {
		await writer.discard();
		return null;
	}
	for await (const chunk of payloadChunks) {
		if (!writer.write(utf8.push(chunk))) {
			await writer.discard();
			return null;
		}
	}
	if (!(writer.write(utf8.flush()) && writer.write(Buffer.from("}")))) {
		await writer.discard();
		return null;
	}
	return writer.finish();
}

/** Spool one text value as a JSON string blob (`JSON.parse` returns the exact
 * source text). Null when its encoding is over the host cap. */
export async function spoolJsonText(
	stream: string,
	key: string,
	text: string,
	maxBytes = HOST_BLOB_MAX_BYTES,
): Promise<SpooledBlob | null> {
	const writer = new BlobWriter(stream, key, maxBytes);
	for (const chunk of jsonTextChunks(text)) {
		if (!writer.write(chunk)) {
			await writer.discard();
			return null;
		}
	}
	return writer.finish();
}
