// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading the members `archive.ts` selects, one value or one row at a time.
 *
 * Every legacy family member is a JSON array, pretty-printed across many
 * lines, and the score file and the profile are CSV. Neither `JSON.parse` of a
 * whole file nor a line reader will do: a JSON value spans lines, and a CSV
 * cell can hold a quoted line break. A member is extracted to scratch and
 * streamed. JSON goes through `@streamparser/json`, and each element of the
 * root array goes to its handler as soon as it is complete; with
 * `keepStack: false` the parser drops each element once emitted, so memory
 * holds one read chunk and the values it completes, whatever the member's
 * size. CSV goes through a small state machine with limits on a cell's
 * length, a row's width and the number of rows, so a damaged or hostile file
 * cannot make a cell or a row grow without bound.
 *
 * ONLY THE SOURCE FAILING ENDS A READ QUIETLY. A failed read, or JSON or CSV
 * that breaks off, is reported as how the member ended, and the values before
 * it are kept. An error thrown while handling a value or a row (a builder bug,
 * a failed emit) propagates and fails the run. Caught, it would be reported as
 * a cut-short export, send the owner to request a new one, silently drop the
 * rest of the member, and hide the very bug a real export is run to find.
 */

import { createReadStream } from "node:fs";
import { JSONParser } from "@streamparser/json";
import {
	EMPTY_MEMBER_MAX_BYTES,
	extractMember,
	isDeviceError,
	type MemberRef,
	type PartHandle,
	removeScratch,
} from "./archive.ts";
import { isPlainObject, type SourceObject } from "./parsers.ts";

/** How reading a member ended. */
type ReadEnd = "complete" | "interrupted" | "device";

/** 64 KiB, as twitter_archive's streaming reader. */
const READ_CHUNK_BYTES = 65_536;

/** Skipped at the start of a CSV file, where some writers put it. */
const BYTE_ORDER_MARK = "\uFEFF";

/** Every legacy family member is a root array of objects. */
const ROOT_ARRAY: readonly string[] = ["$.*"];

interface SourceFault {
	failed: boolean;
	device: boolean;
}

/**
 * The chunks of `source`, ending early instead of throwing if the source
 * fails part-way. Only the source's own iteration is inside this catch: an
 * error thrown by the consumer's loop body calls `return()` on this
 * generator, not `throw()`, so it never lands here.
 */
async function* untilSourceFails(
	source: AsyncIterable<string>,
	fault: SourceFault,
): AsyncIterable<string> {
	try {
		for await (const chunk of source) {
			yield chunk;
		}
	} catch (error) {
		fault.failed = true;
		fault.device = isDeviceError(error);
	}
}

/**
 * Streams one extracted member, handing each child of its root value to
 * `onValue` in file order: each element of a root array, or each property
 * value of a root object. `onValue` is awaited per value, so emit
 * back-pressure bounds memory.
 *
 * Resolves how the member ended:
 *   - `complete`: the root value closed. Anything after it is ignored.
 *   - `interrupted`: the JSON broke, the file ended before the root closed, or
 *     the read failed. Every value completed before that point was delivered.
 *   - `device`: the read failed with a device error.
 * Rejects only with an error thrown by `onValue`.
 */
export async function readMemberValues(
	path: string,
	onValue: (value: unknown) => Promise<void>,
): Promise<ReadEnd> {
	const parser = new JSONParser({ paths: [...ROOT_ARRAY], keepStack: false });
	const pending: unknown[] = [];
	parser.onValue = ({ value }) => {
		pending.push(value);
	};
	const stream = createReadStream(path, {
		encoding: "utf8",
		highWaterMark: READ_CHUNK_BYTES,
	});
	const fault: SourceFault = { failed: false, device: false };
	try {
		for await (const chunk of untilSourceFails(stream, fault)) {
			let broken = false;
			try {
				parser.write(chunk);
			} catch {
				// A throw once the root has closed is trailing text, not a break.
				broken = !parser.isEnded;
			}
			// Outside any catch, so a builder or emit error fails the run.
			for (const value of pending.splice(0)) {
				await onValue(value);
			}
			if (broken) {
				return "interrupted";
			}
			if (parser.isEnded) {
				break;
			}
		}
	} finally {
		stream.destroy();
	}
	if (fault.failed) {
		return fault.device ? "device" : "interrupted";
	}
	// The file ended before the root closed: a truncated member.
	return parser.isEnded ? "complete" : "interrupted";
}

/** The open upload, shared by every stream of one run. */
export interface ArchiveIo {
	/** The upload's parts, in the order MemberRef.part counts them, opened and closed by the caller. */
	readonly parts: readonly PartHandle[];
	readonly scratchDir: string;
	readonly exportedAt: string | null;
	/** Numbers the next member's scratch file; every extraction advances it. */
	nextScratchIndex: number;
}

/** What walking a family found, beyond what its handler was given. */
export interface WalkResult {
	/** Members in the family. */
	readonly files: number;
	/**
	 * Values that were not plain objects, plus members larger than
	 * EMPTY_MEMBER_MAX_BYTES that read to the end without yielding a value:
	 * a wrapper key or root shape this connector does not know.
	 */
	readonly shapeMismatch: number;
	/** Members that could not be extracted, or whose JSON or CSV broke or ended early. */
	readonly interruptedFiles: number;
	/** Members over their cap or refused by the zip policy, and CSV past its limits. */
	readonly oversizedFiles: number;
	/** The device failed, and the walk stopped at that member. */
	readonly deviceError: boolean;
	/** The device error's code, when extraction failed; null for a failed read. */
	readonly deviceCode: string | null;
}

export function emptyWalk(): WalkResult {
	return {
		files: 0,
		shapeMismatch: 0,
		interruptedFiles: 0,
		oversizedFiles: 0,
		deviceError: false,
		deviceCode: null,
	};
}

/**
 * How one member's read ended. "read": extracted and read to its end with no shape mismatch.
 * "partial": its read began, but it was cut, failed on the device, or held a shape mismatch;
 * or it failed to extract for a reason other than its size or the device (not found,
 * damaged, an unsupported method, or inflated to a size other than declared).
 * "unread": never read (over its cap, past a ZIP64 switch, a device error at extraction,
 * or not reached after a device error).
 */
export type MemberEnd = "read" | "partial" | "unread";

interface FamilyHandler {
	/** One plain object from member `index` of the family, in member order and file order. */
	readonly value: (obj: SourceObject, index: number) => Promise<void>;
	/** Called once for every member, in order, however it ended. */
	readonly memberDone?: (index: number, end: MemberEnd) => void;
}

/**
 * Extracts and reads a family's members in the order given, handing every
 * plain object among each member's root children, as `readMemberValues`
 * reads them, to `handler.value`. One scratch file exists at a time, and it
 * is removed however its read ends. `cap` is the largest declared size a
 * member may have and still be extracted.
 *
 * The walk stops reading at the first device error, since every later member
 * needs the same scratch disk, but still tells `handler.memberDone` how every
 * member ended, so the caller knows which went unread. An error thrown by the
 * handler propagates.
 */
export async function walkJsonFamily(
	io: ArchiveIo,
	members: readonly MemberRef[],
	cap: number,
	handler: FamilyHandler,
): Promise<WalkResult> {
	let shapeMismatch = 0;
	let interruptedFiles = 0;
	let oversizedFiles = 0;
	let deviceError = false;
	let deviceCode: string | null = null;
	for (const [index, member] of members.entries()) {
		if (deviceError) {
			handler.memberDone?.(index, "unread");
			continue;
		}
		const n = io.nextScratchIndex;
		io.nextScratchIndex += 1;
		const extracted = await extractMember(
			io.parts,
			member,
			io.scratchDir,
			n,
			cap,
		);
		if (!extracted.ok) {
			if (extracted.failure === "device") {
				deviceError = true;
				deviceCode = extracted.code;
				handler.memberDone?.(index, "unread");
			} else if (extracted.failure === "too_large") {
				oversizedFiles += 1;
				handler.memberDone?.(index, "unread");
			} else {
				interruptedFiles += 1;
				handler.memberDone?.(index, "partial");
			}
			continue;
		}
		let memberValues = 0;
		let mismatched = false;
		const onValue = async (value: unknown): Promise<void> => {
			memberValues += 1;
			if (!isPlainObject(value)) {
				shapeMismatch += 1;
				mismatched = true;
				return;
			}
			await handler.value(value, index);
		};
		let end: ReadEnd;
		try {
			end = await readMemberValues(extracted.path, onValue);
		} finally {
			removeScratch(extracted.path);
		}
		if (end === "device") {
			deviceError = true;
		} else if (end === "interrupted") {
			interruptedFiles += 1;
		} else if (
			memberValues === 0 &&
			member.declaredBytes > EMPTY_MEMBER_MAX_BYTES
		) {
			// Read to the end and nothing matched: an unknown layout. Checked only
			// for a complete read, since a member cut short is already counted.
			shapeMismatch += 1;
			mismatched = true;
		}
		handler.memberDone?.(
			index,
			end === "complete" && !mismatched ? "read" : "partial",
		);
	}
	return {
		files: members.length,
		shapeMismatch,
		interruptedFiles,
		oversizedFiles,
		deviceError,
		deviceCode,
	};
}

// CSV

/** Limits on one CSV file: a cell's length in UTF-16 units, a row's cells, and rows including the header. */
export interface CsvLimits {
	readonly maxFieldChars: number;
	readonly maxCells: number;
	readonly maxRows: number;
}

/** `Your Profile/Profile.csv`: a header and one row, whose free-text `about_me` may hold commas and line breaks. */
export const PROFILE_CSV_LIMITS: CsvLimits = {
	maxFieldChars: 16_384,
	maxCells: 256,
	maxRows: 2,
};

/** `Sleep Score/sleep_score.csv`: short cells, a row a night. */
export const SLEEP_SCORE_CSV_LIMITS: CsvLimits = {
	maxFieldChars: 256,
	maxCells: 64,
	maxRows: 200_000,
};

/** How reading a CSV member ended; `too_long` is a cell, a row or the file past its limits. */
type CsvEnd = ReadEnd | "too_long";

/**
 * RFC 4180 rows from text pushed in chunks: a BOM at the start is skipped,
 * quoted cells may hold commas, doubled quotes and line breaks, `\n` ends a
 * row and a `\r` outside quotes is dropped, so CRLF and LF read alike. A
 * quote at the end of a chunk may open a doubled quote or close the cell, so
 * the decision waits for the next chunk. `push` returns only the rows that
 * chunk completed, and stops at the first cell or row past its limit.
 */
class CsvRowParser {
	private field = "";
	private inQuotes = false;
	private pendingQuote = false;
	private row: string[] = [];
	private sawAnyChar = false;
	private readonly limits: CsvLimits;

	constructor(limits: CsvLimits) {
		this.limits = limits;
	}

	push(text: string): { readonly rows: string[][]; readonly tooLong: boolean } {
		const rows: string[][] = [];
		for (let i = 0; i < text.length; i += 1) {
			const ch = text.charAt(i);
			if (!this.sawAnyChar && ch === BYTE_ORDER_MARK) {
				continue;
			}
			this.sawAnyChar = true;
			if (this.pendingQuote) {
				this.pendingQuote = false;
				if (ch === '"') {
					if (!this.append('"')) {
						return { rows, tooLong: true };
					}
					continue;
				}
				this.inQuotes = false;
			}
			if (this.inQuotes) {
				if (ch !== '"') {
					if (!this.append(ch)) {
						return { rows, tooLong: true };
					}
				} else if (text.charAt(i + 1) === '"') {
					if (!this.append('"')) {
						return { rows, tooLong: true };
					}
					i += 1;
				} else if (i + 1 === text.length) {
					this.pendingQuote = true;
				} else {
					this.inQuotes = false;
				}
				continue;
			}
			if (ch === '"') {
				this.inQuotes = true;
			} else if (ch === ",") {
				if (!this.endCell()) {
					return { rows, tooLong: true };
				}
			} else if (ch === "\n") {
				if (!this.endCell()) {
					return { rows, tooLong: true };
				}
				rows.push(this.row);
				this.row = [];
			} else if (ch !== "\r" && !this.append(ch)) {
				return { rows, tooLong: true };
			}
		}
		return { rows, tooLong: false };
	}

	/**
	 * The last row, when the text did not end with a line break (its width
	 * unchecked); `unterminated` when it ended inside a quoted cell.
	 */
	finish():
		| { readonly unterminated: true }
		| { readonly unterminated: false; readonly row: string[] | null } {
		if (this.pendingQuote) {
			this.pendingQuote = false;
			this.inQuotes = false;
		}
		if (this.inQuotes) {
			return { unterminated: true };
		}
		if (this.field === "" && this.row.length === 0) {
			return { unterminated: false, row: null };
		}
		this.row.push(this.field);
		this.field = "";
		return { unterminated: false, row: this.row };
	}

	/** Whether the cell is still within its limit. */
	private append(ch: string): boolean {
		this.field += ch;
		return this.field.length <= this.limits.maxFieldChars;
	}

	/** Whether the row is still within its limit. */
	private endCell(): boolean {
		this.row.push(this.field);
		this.field = "";
		return this.row.length <= this.limits.maxCells;
	}
}

/**
 * Streams one extracted CSV member, handing each row to `onRow` in file order
 * and awaiting it before the next chunk is read. `onRow` returns "stop" to end
 * the read early; the read then ends `complete`.
 *
 * Resolves how the member ended:
 *   - `complete`: the file ended outside a quoted cell, or `onRow` stopped the
 *     read. A last row without a line break is a row: many Takeout CSVs end
 *     without one, so a truncation shows instead as an extraction that
 *     inflated to the wrong size.
 *   - `too_long`: a cell, a row or the file went past `limits`. The rows
 *     before it were delivered.
 *   - `interrupted`: the file ended inside a quoted cell, or the read failed.
 *   - `device`: the read failed with a device error.
 * Rejects only with an error thrown by `onRow`.
 */
export async function readCsvRows(
	path: string,
	limits: CsvLimits,
	onRow: (cells: readonly string[]) => Promise<"more" | "stop">,
): Promise<CsvEnd> {
	const parser = new CsvRowParser(limits);
	let rows = 0;
	const stream = createReadStream(path, {
		encoding: "utf8",
		highWaterMark: READ_CHUNK_BYTES,
	});
	const fault: SourceFault = { failed: false, device: false };
	try {
		for await (const chunk of untilSourceFails(stream, fault)) {
			const pushed = parser.push(chunk);
			// Outside any catch, so a handler error fails the run.
			for (const cells of pushed.rows) {
				rows += 1;
				if (rows > limits.maxRows) {
					return "too_long";
				}
				if ((await onRow(cells)) === "stop") {
					return "complete";
				}
			}
			if (pushed.tooLong) {
				return "too_long";
			}
		}
	} finally {
		stream.destroy();
	}
	if (fault.failed) {
		return fault.device ? "device" : "interrupted";
	}
	const last = parser.finish();
	if (last.unterminated) {
		return "interrupted";
	}
	if (last.row === null) {
		return "complete";
	}
	rows += 1;
	if (rows > limits.maxRows || last.row.length > limits.maxCells) {
		return "too_long";
	}
	await onRow(last.row);
	return "complete";
}

/**
 * Extracts one CSV member and reads its rows into `onRow`, removing the
 * scratch file however the read ends. A declared size over `cap`, or a file
 * past `limits`, counts as oversized; a cut one as interrupted.
 */
export async function walkCsvMember(
	io: ArchiveIo,
	member: MemberRef,
	cap: number,
	limits: CsvLimits,
	onRow: (cells: readonly string[]) => Promise<"more" | "stop">,
): Promise<WalkResult> {
	const walk = { ...emptyWalk(), files: 1 };
	const n = io.nextScratchIndex;
	io.nextScratchIndex += 1;
	const extracted = await extractMember(
		io.parts,
		member,
		io.scratchDir,
		n,
		cap,
	);
	if (!extracted.ok) {
		switch (extracted.failure) {
			case "device":
				return { ...walk, deviceError: true, deviceCode: extracted.code };
			case "too_large":
				return { ...walk, oversizedFiles: 1 };
			default:
				return { ...walk, interruptedFiles: 1 };
		}
	}
	let end: CsvEnd;
	try {
		end = await readCsvRows(extracted.path, limits, onRow);
	} finally {
		removeScratch(extracted.path);
	}
	switch (end) {
		case "complete":
			return walk;
		case "too_long":
			return { ...walk, oversizedFiles: 1 };
		case "interrupted":
			return { ...walk, interruptedFiles: 1 };
		default:
			return { ...walk, deviceError: true };
	}
}
