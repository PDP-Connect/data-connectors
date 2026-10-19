// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOST_BLOB_MAX_BYTES } from "@pdpp/connector-protocol";
import {
	measureMessageBlob,
	spoolMessageBlob,
	writeAllSync,
} from "./message-blob.ts";

const CHUNK_CHARS = 65_536;
// The worst a chunk can encode to: every char a six-byte \uXXXX escape.
const MAX_CHUNK_BYTES = CHUNK_CHARS * 6 + 2;

test("measureMessageBlob: size and hash equal the one-shot JSON encoding", () => {
	const text = `${"ab\u0000😀\\".repeat(50_000)}tail`;
	const ref = measureMessageBlob(text);
	const bytes = Buffer.from(JSON.stringify(text));
	assert.equal(ref?.size_bytes, bytes.length);
	assert.equal(ref?.sha256, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(ref?.blob_id, `sha256:${ref?.sha256}`);
});

test("measureMessageBlob: stops encoding once the cap is passed and never builds more than one chunk at a time", () => {
	// 8M NULs encode to 48 MB of JSON, over the 32 MiB cap. The encoder must
	// give up after the cap, not after encoding the whole text.
	const text = "\u0000".repeat(8_000_000);
	let total = 0;
	let largest = 0;
	let chunks = 0;
	const ref = measureMessageBlob(text, {
		onChunk: (bytes) => {
			total += bytes;
			largest = Math.max(largest, bytes);
			chunks += 1;
		},
	});
	assert.equal(ref, null);
	assert.ok(
		total <= HOST_BLOB_MAX_BYTES + MAX_CHUNK_BYTES,
		`encoded ${total} bytes before stopping`,
	);
	assert.ok(largest <= MAX_CHUNK_BYTES, `a chunk was ${largest} bytes`);
	assert.ok(
		chunks < Math.ceil(text.length / CHUNK_CHARS),
		"it did not walk every chunk",
	);
});

test("measureMessageBlob: text too long to fit even unescaped is rejected without encoding a chunk", () => {
	let chunks = 0;
	const ref = measureMessageBlob("y".repeat(HOST_BLOB_MAX_BYTES - 1), {
		onChunk: () => {
			chunks += 1;
		},
	});
	assert.equal(ref, null);
	assert.equal(chunks, 0);
});

test("measureMessageBlob: text exactly at the cap fits and one byte more does not", () => {
	const fits = "y".repeat(HOST_BLOB_MAX_BYTES - 2);
	assert.equal(measureMessageBlob(fits)?.size_bytes, HOST_BLOB_MAX_BYTES);
	assert.equal(measureMessageBlob(`${fits}y`), null);
});

test("writeAllSync: loops over short writes and writes every byte once, in order", () => {
	const chunk = Buffer.from("0123456789");
	const written: string[] = [];
	writeAllSync(0, chunk, (_fd, buffer, offset) => {
		const n = Math.min(3, buffer.length - offset);
		written.push(buffer.subarray(offset, offset + n).toString());
		return n;
	});
	assert.equal(written.join(""), "0123456789");
	assert.deepEqual(written, ["012", "345", "678", "9"]);
});

test("writeAllSync: a write that makes no progress fails instead of looping", () => {
	assert.throws(
		() => writeAllSync(0, Buffer.from("abc"), () => 0),
		/no progress/,
	);
});

test("spoolMessageBlob: survives short writes and produces the exact JSON bytes", () => {
	const dir = mkdtempSync(join(tmpdir(), "chatgpt-blob-unit-"));
	try {
		const text = `${"é😀\u0000".repeat(40_000)}end`;
		const ref = measureMessageBlob(text);
		assert.ok(ref);
		const event = spoolMessageBlob(dir, "m1", text, ref, (fd, buffer, offset) =>
			writeSync(fd, buffer, offset, Math.min(7_001, buffer.length - offset)),
		);
		const bytes = readFileSync(join(dir, event.file));
		assert.equal(bytes.toString("utf8"), JSON.stringify(text));
		assert.equal(event.sha256, ref.sha256);
		assert.equal(event.size_bytes, ref.size_bytes);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("spoolMessageBlob: a failed write or a text that differs from the measured one leaves no file", () => {
	const dir = mkdtempSync(join(tmpdir(), "chatgpt-blob-unit-"));
	try {
		const ref = measureMessageBlob("hello");
		assert.ok(ref);
		assert.throws(
			() => spoolMessageBlob(dir, "m1", "hello", ref, () => 0),
			/no progress/,
		);
		assert.throws(
			() => spoolMessageBlob(dir, "m1", "HELLO", ref),
			/differ from the measured/,
		);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});
