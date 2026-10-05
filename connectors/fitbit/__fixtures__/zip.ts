// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test zip writer for the Fitbit fixtures.
 *
 * `writeZip` and `zipBytes` write classic (non-ZIP64) archives that the shared bounded
 * reader, `unzip` and Python's `zipfile` all accept. Two writers make the shapes the
 * connector must refuse before it lists anything: an end record carrying a ZIP64
 * sentinel, and a sparse file past the classic 4 GiB address limit. A third makes the
 * shape it can list but not wholly read: ZIP64 records beside a classic end record with
 * real values, as a writer that switches to ZIP64 part-way leaves them, optionally with a
 * hole before the central directory that carries the archive past 2 GiB. A fourth writes
 * the first bytes of a gzip stream, as a `.tgz` export renamed `.zip` starts.
 *
 * Everything is synchronous, so no fixture adds a row to the no-await allowlist. A
 * `{ file }` member is read twice in 1 MiB chunks, once for its CRC and once to copy it, so
 * a 128 MiB member never sits in test memory.
 */

import {
	closeSync,
	ftruncateSync,
	openSync,
	readSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipMember {
	readonly name: string;
	/** The member's bytes, or a file on disk that is streamed in and always stored. */
	readonly data: Buffer | { readonly file: string };
	/** Defaults to "deflate" for in-memory bytes. */
	readonly method?: "store" | "deflate";
	/**
	 * Replaces the uncompressed size in the central directory, to make a member that lies
	 * about its size. The reader's size limits act on the central directory's figure; the
	 * local header keeps the true one.
	 */
	readonly declaredSize?: number;
	/**
	 * Writes ZIP64's sentinel as the member's offset in the central directory, with the
	 * real offset in a ZIP64 extra field, as a writer that switches to ZIP64 part-way
	 * writes every member stored past the switch. The shared reader cannot find it.
	 */
	readonly offsetSentinel?: boolean;
}

const LOCAL_FILE_SIGNATURE = 0x04_03_4b_50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02_01_4b_50;
const END_SIGNATURE = 0x06_05_4b_50;
const ZIP64_END_SIGNATURE = 0x06_06_4b_50;
const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_BYTES = 22;
const ZIP64_END_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EXTRA_ID = 0x00_01;
const ZIP64_OFFSET_EXTRA_BYTES = 12;
const UTF8_NAMES_FLAG = 0x08_00;
const METHOD_CODES = { store: 0, deflate: 8 } as const;
/** Version 2.0 made by MS-DOS (host 0). A Unix host would make the reader treat the external attributes as a file mode. */
const VERSION_CLASSIC = 20;
const VERSION_ZIP64 = 45;
const U16_MAX = 0xff_ff;
const U32_MAX = 0xff_ff_ff_ff;
const CHUNK_BYTES = 1024 * 1024;
/** A fixed MS-DOS timestamp, 2026-03-15 12:00:00, keeps every archive byte-for-byte reproducible. */
const DOS_TIME = 12 * 2048;
const DOS_DATE = (2026 - 1980) * 512 + 3 * 32 + 15;
/** Past the classic 32-bit address limit, whatever the archive's contents. */
const SPARSE_OVERSIZE_BYTES = 2 ** 32 + 64;
/**
 * A hole this long before the central directory carries the archive past 2 GiB, where
 * Python's zipfile, the earliest known writer to switch to ZIP64, switches.
 */
export const PAST_ZIP64_SWITCH_GAP_BYTES = 2 ** 31;
const GZIP_HEAD = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
const SENTINEL_ZIP_MEMBERS: readonly ZipMember[] = [
	{
		name: "zip64-sentinel.txt",
		data: Buffer.from("zip64 sentinel fixture\n"),
		method: "store",
	},
];

/** Where an archive's bytes go, in order. */
interface Sink {
	readonly write: (bytes: Buffer) => void;
	/** Moves on `bytes` without writing them: a hole, which only a file can hold. */
	readonly skip: (bytes: number) => void;
}
type EndStyle = "classic" | "zip64_sentinel" | "zip64_locator";

/** One member, measured and ready to write. */
interface Entry {
	readonly name: Buffer;
	readonly method: number;
	readonly crc: number;
	readonly compressedBytes: number;
	readonly uncompressedBytes: number;
	readonly declaredBytes: number;
	readonly offsetSentinel: boolean;
	readonly writeData: (sink: Sink) => void;
}

/** Writes a classic zip to `path`, replacing any file there. */
export function writeZip(path: string, members: readonly ZipMember[]): void {
	writeArchive(path, members, "classic");
}

/** The same archive as `writeZip`, in memory: for a zip nested inside another. */
export function zipBytes(members: readonly ZipMember[]): Buffer {
	const parts: Buffer[] = [];
	encodeZip(
		{
			// Copy each write: a `{ file }` member reuses one read buffer for every chunk.
			write: (bytes) => {
				parts.push(Buffer.from(bytes));
			},
			skip: () => {
				throw new Error("zip fixture: a hole needs a file");
			},
		},
		members,
		"classic",
	);
	return Buffer.concat(parts);
}

/**
 * A small, valid ZIP64 archive whose classic end record carries the sentinel
 * `cdOffset = 0xFFFFFFFF`, preceded by the ZIP64 end record and its locator. A ZIP64-aware
 * tool lists it; the shared reader, which has no ZIP64 support, would list nothing.
 */
export function writeZip64SentinelZip(
	path: string,
	members: readonly ZipMember[] = SENTINEL_ZIP_MEMBERS,
): void {
	writeArchive(path, members, "zip64_sentinel");
}

/**
 * A valid ZIP64 archive as Python's `zipfile` writes one between 2 and 4 GiB: the classic
 * end record holds real values, so the shared reader lists it, but the ZIP64 end record
 * and its locator precede it. Mark the members stored past the switch with
 * `offsetSentinel`. `gapBytes` are left unwritten before the central directory, so
 * `PAST_ZIP64_SWITCH_GAP_BYTES` makes the archive that large while only its members and
 * records reach the disk.
 */
export function writeZip64LocatorZip(
	path: string,
	members: readonly ZipMember[],
	gapBytes = 0,
): void {
	writeArchive(path, members, "zip64_locator", gapBytes);
}

/**
 * A file that starts like a gzip stream (magic, deflate, no flags) and holds a few bytes
 * more: what Takeout's `.tgz` file type delivers, whatever the file is named.
 */
export function writeGzipLookalike(path: string): void {
	writeFileSync(
		path,
		Buffer.concat([GZIP_HEAD, Buffer.from("not a zip archive", "latin1")]),
	);
}

/** A file that starts like a zip and ends past 4 GiB: only its first 4 bytes reach the disk. */
export function writeSparseOversize(path: string): void {
	const fd = openSync(path, "w");
	try {
		fileSink(fd).write(Buffer.from("PK\u0003\u0004", "latin1"));
		ftruncateSync(fd, SPARSE_OVERSIZE_BYTES);
	} finally {
		closeSync(fd);
	}
}

function writeArchive(
	path: string,
	members: readonly ZipMember[],
	end: EndStyle,
	gapBytes = 0,
): void {
	const fd = openSync(path, "w");
	try {
		encodeZip(fileSink(fd), members, end, gapBytes);
	} finally {
		closeSync(fd);
	}
}

/** Writes at its own position, so a skip leaves a hole the next write lands after. */
function fileSink(fd: number): Sink {
	let position = 0;
	return {
		write: (bytes) => {
			let written = 0;
			while (written < bytes.length) {
				written += writeSync(
					fd,
					bytes,
					written,
					bytes.length - written,
					position + written,
				);
			}
			position += bytes.length;
		},
		skip: (bytes) => {
			position += bytes;
		},
	};
}

function encodeZip(
	sink: Sink,
	members: readonly ZipMember[],
	end: EndStyle,
	gapBytes = 0,
): void {
	if (members.length > U16_MAX) {
		throw new RangeError(
			`zip fixture: ${String(members.length)} members need ZIP64`,
		);
	}
	const directory: Buffer[] = [];
	let offset = 0;
	for (const member of members) {
		const entry = measure(member);
		const local = localHeader(entry);
		sink.write(local);
		entry.writeData(sink);
		directory.push(centralHeader(entry, offset));
		offset = classic(
			offset + local.length + entry.compressedBytes,
			"archive offset",
		);
	}
	if (gapBytes > 0) {
		sink.skip(gapBytes);
		offset = classic(offset + gapBytes, "archive offset");
	}
	const directoryBytes = Buffer.concat(directory);
	sink.write(directoryBytes);
	if (end !== "classic") {
		sink.write(zip64EndRecords(members.length, directoryBytes.length, offset));
	}
	sink.write(
		endRecord(
			members.length,
			directoryBytes.length,
			end === "zip64_sentinel" ? U32_MAX : offset,
		),
	);
}

function measure(member: ZipMember): Entry {
	const name = Buffer.from(member.name, "utf8");
	if (name.length > U16_MAX) {
		throw new RangeError("zip fixture: member name too long");
	}
	const { data } = member;
	if (Buffer.isBuffer(data)) {
		const method = member.method ?? "deflate";
		const stored = method === "deflate" ? deflateRawSync(data) : data;
		return withDeclaredSize(member, {
			name,
			method: METHOD_CODES[method],
			crc: crc32(data),
			compressedBytes: stored.length,
			uncompressedBytes: data.length,
			writeData: (sink) => {
				sink.write(stored);
			},
		});
	}
	if (member.method === "deflate") {
		throw new Error("zip fixture: a { file } member is always stored");
	}
	let crc = 0;
	let size = 0;
	forEachChunk(data.file, (chunk) => {
		crc = crc32(chunk, crc);
		size += chunk.length;
	});
	return withDeclaredSize(member, {
		name,
		method: METHOD_CODES.store,
		crc,
		compressedBytes: size,
		uncompressedBytes: size,
		writeData: (sink) => {
			let copied = 0;
			forEachChunk(data.file, (chunk) => {
				sink.write(chunk);
				copied += chunk.length;
			});
			if (copied !== size) {
				throw new Error(
					"zip fixture: a { file } member changed while it was being zipped",
				);
			}
		},
	});
}

function withDeclaredSize(
	member: ZipMember,
	measured: Omit<Entry, "declaredBytes" | "offsetSentinel">,
): Entry {
	const declaredBytes = member.declaredSize ?? measured.uncompressedBytes;
	if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
		throw new RangeError(
			"zip fixture: declaredSize must be a non-negative integer",
		);
	}
	return {
		...measured,
		compressedBytes: classic(measured.compressedBytes, "compressed size"),
		uncompressedBytes: classic(measured.uncompressedBytes, "uncompressed size"),
		declaredBytes: classic(declaredBytes, "declared size"),
		offsetSentinel: member.offsetSentinel ?? false,
	};
}

/** `value`, if a classic 32-bit field can hold it; this writer never produces ZIP64 fields. */
function classic(value: number, what: string): number {
	if (value > U32_MAX) {
		throw new RangeError(`zip fixture: the ${what} needs ZIP64`);
	}
	return value;
}

function forEachChunk(path: string, visit: (chunk: Buffer) => void): void {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let position = 0;
		let read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
		while (read > 0) {
			visit(buffer.subarray(0, read));
			position += read;
			read = readSync(fd, buffer, 0, CHUNK_BYTES, position);
		}
	} finally {
		closeSync(fd);
	}
}

function localHeader(entry: Entry): Buffer {
	const header = Buffer.alloc(LOCAL_HEADER_BYTES);
	header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
	header.writeUInt16LE(VERSION_CLASSIC, 4);
	header.writeUInt16LE(UTF8_NAMES_FLAG, 6);
	header.writeUInt16LE(entry.method, 8);
	header.writeUInt16LE(DOS_TIME, 10);
	header.writeUInt16LE(DOS_DATE, 12);
	header.writeUInt32LE(entry.crc, 14);
	header.writeUInt32LE(entry.compressedBytes, 18);
	header.writeUInt32LE(entry.uncompressedBytes, 22);
	header.writeUInt16LE(entry.name.length, 26);
	return Buffer.concat([header, entry.name]);
}

function centralHeader(entry: Entry, localOffset: number): Buffer {
	const extra = entry.offsetSentinel
		? zip64OffsetExtra(localOffset)
		: Buffer.alloc(0);
	const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
	header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
	header.writeUInt16LE(VERSION_CLASSIC, 4);
	header.writeUInt16LE(
		entry.offsetSentinel ? VERSION_ZIP64 : VERSION_CLASSIC,
		6,
	);
	header.writeUInt16LE(UTF8_NAMES_FLAG, 8);
	header.writeUInt16LE(entry.method, 10);
	header.writeUInt16LE(DOS_TIME, 12);
	header.writeUInt16LE(DOS_DATE, 14);
	header.writeUInt32LE(entry.crc, 16);
	header.writeUInt32LE(entry.compressedBytes, 20);
	header.writeUInt32LE(entry.declaredBytes, 24);
	header.writeUInt16LE(entry.name.length, 28);
	header.writeUInt16LE(extra.length, 30);
	header.writeUInt32LE(entry.offsetSentinel ? U32_MAX : localOffset, 42);
	return Buffer.concat([header, entry.name, extra]);
}

/** ZIP64's extended-information extra field carrying only the local header's offset. */
function zip64OffsetExtra(localOffset: number): Buffer {
	const extra = Buffer.alloc(ZIP64_OFFSET_EXTRA_BYTES);
	extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
	extra.writeUInt16LE(ZIP64_OFFSET_EXTRA_BYTES - 4, 2);
	extra.writeBigUInt64LE(BigInt(localOffset), 4);
	return extra;
}

function endRecord(
	entries: number,
	directoryBytes: number,
	directoryOffset: number,
): Buffer {
	const record = Buffer.alloc(END_BYTES);
	record.writeUInt32LE(END_SIGNATURE, 0);
	record.writeUInt16LE(entries, 8);
	record.writeUInt16LE(entries, 10);
	record.writeUInt32LE(directoryBytes, 12);
	record.writeUInt32LE(directoryOffset, 16);
	return record;
}

/** The ZIP64 end record, then the locator that points back at it. */
function zip64EndRecords(
	entries: number,
	directoryBytes: number,
	directoryOffset: number,
): Buffer {
	const record = Buffer.alloc(ZIP64_END_BYTES);
	record.writeUInt32LE(ZIP64_END_SIGNATURE, 0);
	record.writeBigUInt64LE(BigInt(ZIP64_END_BYTES - 12), 4); // the record's size after this field
	record.writeUInt16LE(VERSION_ZIP64, 12);
	record.writeUInt16LE(VERSION_ZIP64, 14);
	record.writeBigUInt64LE(BigInt(entries), 24);
	record.writeBigUInt64LE(BigInt(entries), 32);
	record.writeBigUInt64LE(BigInt(directoryBytes), 40);
	record.writeBigUInt64LE(BigInt(directoryOffset), 48);
	const locator = Buffer.alloc(ZIP64_LOCATOR_BYTES);
	locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
	locator.writeBigUInt64LE(BigInt(directoryOffset + directoryBytes), 8);
	locator.writeUInt32LE(1, 16); // total number of disks
	return Buffer.concat([record, locator]);
}
