// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A minimal DEFLATE zip writer for tests: one local header and one central
// directory record per entry, then the end-of-central-directory record. The
// three record writers are exported for tests that craft archives `buildZip`
// cannot express, such as many directory records pointing at one entry.
//
// `zip64Sizes` writes an entry the way a zip64 writer records one too large
// for the classic fields: both size fields hold 0xFFFFFFFF and the real sizes
// move to a zip64 extended-information extra field. The data stays small, so
// a test can present the shape of a 4 GB entry without writing one.
//
// `declaredSize` writes a smaller uncompressed size than the data has, as a
// writer that wraps a size past 32 bits does, so a test can reach a ceiling
// on actual bytes that the declared size would not trip.

import { deflateRawSync } from "node:zlib";

export interface ZipFixtureEntry {
	readonly data: Buffer | string;
	readonly declaredSize?: number;
	readonly name: string;
	readonly zip64Sizes?: boolean;
}

export interface ZipRecord {
	readonly compressedSize: number;
	readonly extra?: Buffer;
	/** Offset of the entry's local header; central directory records only. */
	readonly localOffset?: number;
	readonly name: Buffer;
	readonly uncompressedSize: number;
	readonly versionNeeded?: number;
}

const ZIP64_SIZE_SENTINEL = 0xff_ff_ff_ff;
const UTF8_NAMES = 0x08_00;
const DEFLATE = 8;
const NO_EXTRA = Buffer.alloc(0);

/** A local file header followed by the entry's name and extra field. */
export function localFileHeader(record: ZipRecord): Buffer {
	const extra = record.extra ?? NO_EXTRA;
	const header = Buffer.alloc(30);
	header.writeUInt32LE(0x04_03_4b_50, 0);
	header.writeUInt16LE(record.versionNeeded ?? 20, 4);
	header.writeUInt16LE(UTF8_NAMES, 6);
	header.writeUInt16LE(DEFLATE, 8);
	header.writeUInt32LE(record.compressedSize, 18);
	header.writeUInt32LE(record.uncompressedSize, 22);
	header.writeUInt16LE(record.name.length, 26);
	header.writeUInt16LE(extra.length, 28);
	return Buffer.concat([header, record.name, extra]);
}

/** A central directory record followed by the entry's name and extra field. */
export function centralDirectoryRecord(record: ZipRecord): Buffer {
	const extra = record.extra ?? NO_EXTRA;
	const header = Buffer.alloc(46);
	header.writeUInt32LE(0x02_01_4b_50, 0);
	header.writeUInt16LE(20, 4);
	header.writeUInt16LE(20, 6);
	header.writeUInt16LE(UTF8_NAMES, 8);
	header.writeUInt16LE(DEFLATE, 10);
	header.writeUInt32LE(record.compressedSize, 20);
	header.writeUInt32LE(record.uncompressedSize, 24);
	header.writeUInt16LE(record.name.length, 28);
	header.writeUInt16LE(extra.length, 30);
	header.writeUInt32LE(record.localOffset ?? 0, 42);
	return Buffer.concat([header, record.name, extra]);
}

/** The end-of-central-directory record, with no archive comment. */
export function endOfCentralDirectory(
	entries: number,
	directoryBytes: number,
	directoryOffset: number,
): Buffer {
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06_05_4b_50, 0);
	end.writeUInt16LE(entries, 8);
	end.writeUInt16LE(entries, 10);
	end.writeUInt32LE(directoryBytes, 12);
	end.writeUInt32LE(directoryOffset, 16);
	return end;
}

function zip64Extra(uncompressed: number, compressed: number): Buffer {
	const extra = Buffer.alloc(20);
	extra.writeUInt16LE(0x00_01, 0);
	extra.writeUInt16LE(16, 2);
	extra.writeBigUInt64LE(BigInt(uncompressed), 4);
	extra.writeBigUInt64LE(BigInt(compressed), 12);
	return extra;
}

export function buildZip(entries: readonly ZipFixtureEntry[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const data =
			typeof entry.data === "string" ? Buffer.from(entry.data) : entry.data;
		const compressed = deflateRawSync(data);
		const record: ZipRecord = {
			compressedSize: entry.zip64Sizes
				? ZIP64_SIZE_SENTINEL
				: compressed.length,
			localOffset: offset,
			name: Buffer.from(entry.name, "utf8"),
			uncompressedSize: entry.zip64Sizes
				? ZIP64_SIZE_SENTINEL
				: (entry.declaredSize ?? data.length),
			versionNeeded: entry.zip64Sizes ? 45 : 20,
			...(entry.zip64Sizes
				? { extra: zip64Extra(data.length, compressed.length) }
				: {}),
		};
		const localEntry = Buffer.concat([localFileHeader(record), compressed]);
		localParts.push(localEntry);
		centralParts.push(centralDirectoryRecord(record));
		offset += localEntry.length;
	}
	const centralDir = Buffer.concat(centralParts);
	return Buffer.concat([
		...localParts,
		centralDir,
		endOfCentralDirectory(entries.length, centralDir.length, offset),
	]);
}
