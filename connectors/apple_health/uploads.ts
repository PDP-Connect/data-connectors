// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding the owner's Apple Health export among the files uploaded for this
 * connection, and reading it out of a .zip.
 *
 * THE MODEL.
 *   - Candidates are the owner's own uploads: `.zip` and `.xml` files, flat
 *     or nested (an unzipped export folder contributes its `.xml` files).
 *     Never a file this connector derived (its extraction cache and
 *     `.partial` files are dotfiles), never a dotfile or macOS AppleDouble
 *     companion (`._export.xml`), never anything under `__MACOSX/`.
 *   - An upload is a Health export only if the head of its XML shows a
 *     <HealthData> root element. The same bounded head read gives its
 *     <ExportDate>. Any other XML is ignored, whatever it is called.
 *   - Of the exports found, the one with the newest ExportDate is read; a tie
 *     goes to the newer file and then to the path, so the choice is the same
 *     every time. File times alone decide nothing: an upload moved in with
 *     its original time (mv, cp -p, Finder) is still read when it holds the
 *     newer export. A `.zip` written after that export which is damaged or
 *     incomplete is reported instead, and nothing is read, since it may hold
 *     a newer one; one refused only for its size is not, since the remedy
 *     for it is to upload the XML inside it, but the owner is told of it.
 *   - A zip's central directory is read once, bounded in bytes. Its `.xml`
 *     entries are told apart by streaming only their first bytes, a bounded
 *     number of them, and the export is extracted from its own directory
 *     record, never looked up again by name.
 *
 * The upload preview (validation.ts) and the import judge an upload with the
 * same two functions, inspectXmlUpload and inspectZipUpload, and extract
 * with the same extractExportEntry, so they accept exactly the same files.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	createWriteStream,
	type Dirent,
	fstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
} from "node:fs";
import { rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	readZipEntriesFromFile,
	type ZipEntry,
	ZipPolicyViolationError,
	type ZipReadPolicy,
} from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import { isoDate } from "./parsers.ts";

// ─── Limits ─────────────────────────────────────────────────────────────

export interface UploadLimits {
	/** The largest export XML extracted from a zip, counted on actual bytes. */
	readonly maxExportBytes: number;
	/** The largest zip central directory read. */
	readonly maxDirectoryBytes: number;
	/** How many of a zip's `.xml` entries are sniffed, at most HEAD_BYTES each. */
	readonly maxSniffedEntries: number;
}

export const UPLOAD_LIMITS: UploadLimits = {
	// Well above any single-person export, which can run to several GB for a
	// long-lived account; the ceiling exists to stop an adversarial archive,
	// and matches the manifest's upload limit.
	maxExportBytes: 8 * 1024 * 1024 * 1024,
	// An export holds one file per workout route, ECG recording and clinical
	// record, each named under apple_health_export/ in well under 200 bytes of
	// directory record, so even 65,535 entries need about 11 MB. 32 MiB leaves
	// room for three times that while keeping the directory and its decoded
	// names far inside the 300 MB streaming bound. Without a byte ceiling the
	// reader's per-record allowance admits about 271 MB of directory.
	maxDirectoryBytes: 32 * 1024 * 1024,
	// A real archive holds two XML documents, and the export is sniffed first.
	// The count, not the bytes, is what must be bounded: each sniff opens its
	// own inflate stream, whose context and 32 KiB window cost memory and time
	// however few bytes the entry holds, so sixty thousand tiny entries would
	// cost hundreds of MB. Inflated bytes follow: at most HEAD_BYTES and one
	// output chunk per sniff, about 20 MB across all of them. Compressed input
	// is held to SNIFF_COMPRESSED_BYTES per sniff.
	maxSniffedEntries: 256,
};

/**
 * How much of an XML's head is read for its root element and ExportDate.
 * Apple's export opens with an internal DTD of about ten kilobytes before the
 * root element, and ExportDate is the root's first child.
 */
const HEAD_BYTES = 65_536;
/**
 * The most compressed input read to sniff one zip entry's head. HEAD_BYTES
 * of a genuine export compress to a few kilobytes, and DEFLATE never
 * expands data by more than a few bytes per block, so this is ample. Without
 * it, a crafted entry of empty DEFLATE blocks, which inflate to nothing,
 * would be read to its end for every sniff, costing CPU in proportion to
 * the archive's size times the sniff count.
 */
const SNIFF_COMPRESSED_BYTES = 1024 * 1024;
// A classic (non-zip64) archive states entry counts in 16 bits and sizes and
// offsets in 32. The shared reader parses only that format, so a value at a
// field's maximum means the real one lives in a zip64 record it cannot read.
const ZIP_MAX_CLASSIC_ENTRIES = 0xff_ff;
export const ZIP_MAX_CLASSIC_SIZE = 0xff_ff_ff_ff;
// A zip's end-of-central-directory record: its signature, its length when
// the archive has no comment, and the tail it lies within, as the shared
// reader bounds it: the record plus the longest comment it can carry.
const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50;
const ZIP_EOCD_LENGTH = 22;
const ZIP_EOCD_SEARCH_BYTES = ZIP_EOCD_LENGTH + 0xff_ff;
// Depth below the import directory searched for uploads: an upload lands flat
// (join(importDir, fileName)) or one level down under its artifact id, and a
// developer may place an unzipped apple_health_export/ folder at either.
const MAX_DISCOVERY_DEPTH = 3;
// Every upload found is inspected, so the count bounds the time spent reading
// heads and zip directories. An import directory holds one file per upload.
const MAX_UPLOADS = 100;
/**
 * Directories never searched. Apple writes these beside the export inside
 * apple_health_export/, one file per clinical record, ECG or route, and none
 * holds the export; __MACOSX/ holds only AppleDouble metadata. Searching them
 * would spend the walk on thousands of files that are never read.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	"__MACOSX",
	"clinical-records",
	"electrocardiograms",
	"workout-routes",
]);

const UPLOAD_NAME_RE = /\.(?:xml|zip)$/i;
const XML_NAME_RE = /\.xml$/i;
// The CDA companion Apple writes beside the export (export_cda.xml, or its
// localised name). Used only to sniff it last; its content decides.
const CDA_ENTRY_NAME_RE = /_cda\.xml$/i;
// The folder Apple writes the export into, under any localised file name.
const EXPORT_FOLDER_ENTRY_RE = /(?:^|\/)apple_health_export\/[^/]+$/;
// What follows `.<zip name>.` in the name of that zip's extraction, or of a
// partial one, named for the process writing it and a random suffix.
const EXTRACTION_SUFFIX_RE = /^[0-9a-f]{16}\.xml(\.\d+-[0-9a-f]{8}\.partial)?$/;
/**
 * How long a `.partial` goes unwritten before it is taken as abandoned. An
 * extraction writes to its partial continuously, so one untouched for an hour
 * is not being written, whatever process named it. A process id is not
 * consulted: across containers sharing a folder, the id in a name may belong
 * to an unrelated live process, or to a live run that cannot be seen.
 */
const ABANDONED_PARTIAL_MS = 60 * 60 * 1000;
const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// The first element start tag. Declarations (<?xml, <!DOCTYPE, <!ELEMENT) do
// not begin with a name character, so the first match is the root element.
const ROOT_ELEMENT_RE = /<([A-Za-z_][\w.:-]*)[\s/>]/;
// In the scanner's attribute grammar: either quote, whitespace around '='.
const EXPORT_DATE_RE = /<ExportDate\s+value\s*=\s*(?:"([^"]*)"|'([^']*)')/;

// ─── The head of an XML ─────────────────────────────────────────────────

/** An XML whose root element is <HealthData>. */
export interface ExportHead {
	/** Its ExportDate as an ISO instant, or null when its head states none. */
	readonly exportedAt: string | null;
}

/**
 * Judge a document from its head: an ExportHead when the root element is
 * <HealthData>, "other" when it is anything else, and undefined when the
 * head so far cannot tell. `complete` means no more of the head is coming,
 * and the verdict is then final. Comments are set aside first, since one may
 * hold text shaped like an element.
 */
function judgeHead(
	head: string,
	complete: boolean,
): ExportHead | "other" | undefined {
	let text = head.replace(XML_COMMENT_RE, "");
	const openComment = text.indexOf("<!--");
	if (openComment !== -1) {
		text = text.slice(0, openComment);
	}
	const root = ROOT_ELEMENT_RE.exec(text);
	if (!root) {
		return complete ? "other" : undefined;
	}
	if (root[1] !== "HealthData") {
		return "other";
	}
	const date = EXPORT_DATE_RE.exec(text.slice(root.index));
	if (date) {
		return { exportedAt: isoDate(date[1] ?? date[2]) };
	}
	return complete ? { exportedAt: null } : undefined;
}

function readFileHead(path: string): string {
	const fd = openSync(path, "r");
	try {
		const head = Buffer.alloc(HEAD_BYTES);
		let length = 0;
		let read = readSync(fd, head, 0, HEAD_BYTES, 0);
		while (read > 0 && length + read < HEAD_BYTES) {
			length += read;
			read = readSync(fd, head, length, HEAD_BYTES - length, length);
		}
		return head.subarray(0, length + read).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export type XmlInspection =
	| { readonly kind: "export"; readonly exportedAt: string | null }
	| { readonly kind: "not_export" };

/** Judge an uploaded `.xml` by its head. Reads at most HEAD_BYTES. */
export function inspectXmlUpload(path: string): XmlInspection {
	const head = judgeHead(readFileHead(path), true);
	return head === undefined || head === "other"
		? { kind: "not_export" }
		: { kind: "export", exportedAt: head.exportedAt };
}

// ─── Zip archives ───────────────────────────────────────────────────────

export type ZipInspection =
	| {
			readonly kind: "export";
			/** The export's entry, opened by its own record, never by name. */
			readonly entry: ZipEntry;
			readonly exportedAt: string | null;
	  }
	/** The archive was read and none of its `.xml` entries is a Health export. */
	| { readonly kind: "not_export" }
	/** No central directory could be read: not a zip, or a truncated or damaged one. */
	| { readonly kind: "unreadable_archive" }
	/**
	 * The archive is beyond what this reader opens, though the export inside
	 * it may not be, so the owner can unzip it and upload the XML. `detail`
	 * says which limit, in the owner's terms.
	 */
	| { readonly kind: "too_large"; readonly detail: string };

const ZIP64_DETAIL =
	"the archive or the export inside it is 4 GB or larger, which needs the zip64 format this reader does not support";
const ENTRY_COUNT_DETAIL =
	"it holds 65,535 or more files, and an archive of that many may list them in the zip64 format this reader does not support";
const DIRECTORY_DETAIL = "its list of files is larger than this reader accepts";
const SNIFF_DETAIL = "it holds more XML files than this reader will search";

function zipPolicy(limits: UploadLimits): ZipReadPolicy {
	return {
		maxCentralDirectoryBytes: limits.maxDirectoryBytes,
		maxEntries: ZIP_MAX_CLASSIC_ENTRIES,
		maxEntryUncompressedBytes: limits.maxExportBytes,
		// Not a useful ceiling here. The declared total counts every entry,
		// though only the export is ever extracted, so any figure would turn
		// away archives for files that are never read. What is inflated is
		// bounded by the export's own ceiling and the sniff count.
		maxTotalUncompressedBytes: Number.MAX_SAFE_INTEGER,
	};
}

/** Whether a zip entry could be the export: an `.xml` outside dot-directories and __MACOSX/. */
function isCandidateEntry(entry: ZipEntry): boolean {
	return (
		XML_NAME_RE.test(entry.name) &&
		entry.name
			.split("/")
			.every((segment) => !segment.startsWith(".") && segment !== "__MACOSX")
	);
}

/**
 * Most likely first, so an ordinary archive is sniffed once: a name that is
 * not the CDA companion, then an entry directly in apple_health_export/,
 * then the shallower path, then by path. Content alone decides what is the
 * export; the order saves work, keeps the export within the sniff count
 * however many other XML files an archive holds elsewhere, and settles which
 * of two Health exports in one archive is read.
 */
function byExportLikelihood(a: ZipEntry, b: ZipEntry): number {
	const cda =
		Number(CDA_ENTRY_NAME_RE.test(a.name)) -
		Number(CDA_ENTRY_NAME_RE.test(b.name));
	if (cda !== 0) {
		return cda;
	}
	const folder =
		Number(EXPORT_FOLDER_ENTRY_RE.test(b.name)) -
		Number(EXPORT_FOLDER_ENTRY_RE.test(a.name));
	if (folder !== 0) {
		return folder;
	}
	const depth = a.name.split("/").length - b.name.split("/").length;
	if (depth !== 0) {
		return depth;
	}
	if (a.name === b.name) {
		return 0;
	}
	return a.name < b.name ? -1 : 1;
}

/** Judge an entry from its first bytes, inflating no more of it than the head needs. */
async function sniffEntry(entry: ZipEntry): Promise<ExportHead | "other"> {
	const stream: Readable = entry.openStream({
		maxCompressedBytes: SNIFF_COMPRESSED_BYTES,
	});
	const chunks: Buffer[] = [];
	let length = 0;
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			chunks.push(chunk);
			length += chunk.length;
			const head = Buffer.concat(chunks).subarray(0, HEAD_BYTES);
			const verdict = judgeHead(head.toString("utf8"), length >= HEAD_BYTES);
			if (verdict !== undefined) {
				return verdict;
			}
		}
	} finally {
		stream.destroy();
	}
	return judgeHead(Buffer.concat(chunks).toString("utf8"), true) ?? "other";
}

/**
 * Whether a zip's end record, found as the shared reader finds it, by its
 * signature searched backwards from the end within ZIP_EOCD_SEARCH_BYTES,
 * places the directory past itself. The directory precedes that record in
 * any archive, however large, so the reader's refusal of such a directory is
 * damage, not size. zip64 placeholders are left to the size checks.
 */
function directoryOverrunsEnd(fd: number, fileSize: number): boolean {
	const tailStart = Math.max(0, fileSize - ZIP_EOCD_SEARCH_BYTES);
	const tail = Buffer.alloc(fileSize - tailStart);
	readSync(fd, tail, 0, tail.length, tailStart);
	let at = tail.length - ZIP_EOCD_LENGTH;
	while (at >= 0 && tail.readUInt32LE(at) !== ZIP_EOCD_SIGNATURE) {
		at -= 1;
	}
	if (at < 0) {
		return false;
	}
	const size = tail.readUInt32LE(at + 12);
	const start = tail.readUInt32LE(at + 16);
	return (
		size !== ZIP_MAX_CLASSIC_SIZE &&
		start !== ZIP_MAX_CLASSIC_SIZE &&
		start + size > tailStart + at
	);
}

/**
 * Find the Health export inside an archive: read the central directory once,
 * then sniff its `.xml` entries in order of likelihood until one has a
 * <HealthData> root, at most UploadLimits.maxSniffedEntries of them. The CDA
 * companion, whose root is <ClinicalDocument>, is never taken, whatever it is
 * called; Apple localises both names (a Norwegian export holds eksport.xml
 * beside eksport_cda.xml).
 *
 * An entry whose stream fails is passed over; if no export is found, that
 * failure is thrown rather than reporting an archive without an export,
 * which would not be known. Throws on an unsafe entry name, as the shared
 * reader does. `fd` is the caller's, and must stay open while the returned
 * entry is read.
 */
export async function inspectZipUpload(
	fd: number,
	fileSize: number,
	limits: UploadLimits = UPLOAD_LIMITS,
): Promise<ZipInspection> {
	if (fileSize >= ZIP_MAX_CLASSIC_SIZE) {
		// The directory sits past the last offset a classic record can hold.
		return { kind: "too_large", detail: ZIP64_DETAIL };
	}
	let entries: ZipEntry[];
	try {
		entries = readZipEntriesFromFile(fd, fileSize, zipPolicy(limits));
	} catch (err) {
		if (
			err instanceof ZipPolicyViolationError &&
			err.code === "too_many_entries"
		) {
			return directoryOverrunsEnd(fd, fileSize)
				? { kind: "unreadable_archive" }
				: { kind: "too_large", detail: DIRECTORY_DETAIL };
		}
		throw err;
	}
	if (entries.length === 0) {
		return { kind: "unreadable_archive" };
	}
	if (entries.length >= ZIP_MAX_CLASSIC_ENTRIES) {
		return { kind: "too_large", detail: ENTRY_COUNT_DETAIL };
	}
	const candidates = entries.filter(isCandidateEntry).sort(byExportLikelihood);
	let failure: unknown = null;
	for (const [sniffed, entry] of candidates.entries()) {
		if (
			entry.compressedSize === ZIP_MAX_CLASSIC_SIZE ||
			entry.uncompressedSize === ZIP_MAX_CLASSIC_SIZE
		) {
			return { kind: "too_large", detail: ZIP64_DETAIL };
		}
		if (sniffed >= limits.maxSniffedEntries) {
			return { kind: "too_large", detail: SNIFF_DETAIL };
		}
		try {
			const head = await sniffEntry(entry);
			if (head !== "other") {
				return { kind: "export", entry, exportedAt: head.exportedAt };
			}
		} catch (err) {
			failure ??= err;
		}
	}
	if (failure !== null) {
		throw failure;
	}
	return { kind: "not_export" };
}

export type ExportExtraction =
	| { readonly kind: "extracted" }
	/** The export inflated past UploadLimits.maxExportBytes. */
	| { readonly kind: "export_too_large" };

/**
 * Stream an archive's export entry to `destPath`, never whole in memory.
 *
 * Atomic: the entry is written to a `.partial` beside the destination and
 * renamed onto it only once complete, so a run killed part way never leaves
 * a file that looks like a finished extraction, and an older one is replaced
 * in one step. The `.partial` is named for the process and a random suffix,
 * so no two extractions write one file, even from processes in different
 * containers that share a folder and a process id. Its size is held to the
 * limit it was listed under, on actual bytes, since a zip's declared sizes
 * are untrusted.
 */
export async function extractExportEntry(
	entry: ZipEntry,
	destPath: string,
): Promise<ExportExtraction> {
	const partialPath = `${destPath}.${process.pid}-${randomBytes(4).toString("hex")}.partial`;
	try {
		await pipeline(entry.openStream(), createWriteStream(partialPath));
		await rename(partialPath, destPath);
		return { kind: "extracted" };
	} catch (err) {
		if (
			err instanceof ZipPolicyViolationError &&
			err.code === "entry_too_large"
		) {
			return { kind: "export_too_large" };
		}
		throw err;
	} finally {
		await rm(partialPath, { force: true });
	}
}

// ─── Discovery ──────────────────────────────────────────────────────────

export interface Upload {
	readonly mtimeMs: number;
	readonly path: string;
}

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}

/** Follows a symlink to what it names; null when that cannot be read. */
function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function byName(a: Dirent, b: Dirent): number {
	if (a.name === b.name) {
		return 0;
	}
	return a.name < b.name ? -1 : 1;
}

interface Walk {
	readonly deeper: string[];
	readonly onUnreadableDirectory: (dir: string) => void;
	/** Real paths already visited: a symlink loop or a second link to one file is walked once. */
	readonly seen: Set<string>;
	readonly uploads: Upload[];
}

function scanDirectory(dir: string, walk: Walk): void {
	const real = realpathOrNull(dir);
	if (real === null || walk.seen.has(real)) {
		return;
	}
	walk.seen.add(real);
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort(byName);
	} catch {
		walk.onUnreadableDirectory(dir);
		return;
	}
	for (const entry of entries) {
		const { name } = entry;
		const skipped =
			name.startsWith(".") ||
			SKIPPED_DIRECTORIES.has(name) ||
			// A plain file that is not an upload needs no stat.
			(entry.isFile() && !UPLOAD_NAME_RE.test(name));
		const path = join(dir, name);
		const stats = skipped ? null : statOrNull(path);
		if (stats?.isDirectory()) {
			walk.deeper.push(path);
		} else if (stats?.isFile() && UPLOAD_NAME_RE.test(name)) {
			addUpload(path, stats.mtimeMs, walk);
		}
	}
}

function addUpload(path: string, mtimeMs: number, walk: Walk): void {
	const real = realpathOrNull(path);
	if (
		real === null ||
		walk.seen.has(real) ||
		walk.uploads.length >= MAX_UPLOADS
	) {
		return;
	}
	walk.seen.add(real);
	walk.uploads.push({ mtimeMs, path });
}

/**
 * The owner's uploads under `importDir`: every `.zip` and `.xml`, breadth
 * first, so the import directory itself and the folders directly in it
 * (an upload's artifact directory, an unzipped apple_health_export/) are
 * searched before anything deeper. Symlinks are followed, each real path
 * once. The walk is bounded by depth and by the number of uploads found,
 * never by the number of other files it passes; see SKIPPED_DIRECTORIES.
 * A directory that cannot be listed is passed to `onUnreadableDirectory` and
 * skipped.
 */
export function findUploads(
	importDir: string,
	onUnreadableDirectory: (dir: string) => void = () => undefined,
): Upload[] {
	const walk: Walk = {
		deeper: [],
		onUnreadableDirectory,
		seen: new Set(),
		uploads: [],
	};
	let level = [importDir];
	for (let depth = 0; depth <= MAX_DISCOVERY_DEPTH; depth += 1) {
		walk.deeper.length = 0;
		for (const dir of level) {
			scanDirectory(dir, walk);
		}
		level = [...walk.deeper];
	}
	return walk.uploads;
}

// ─── Choosing and reading the export ────────────────────────────────────

/** The fingerprint an extraction is keyed to: its zip's size, modification time and inode. */
function fingerprintOf(stats: BigIntStats): string {
	return createHash("sha256")
		.update(`${stats.size}:${stats.mtimeNs}:${stats.ino}`)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Where a zip's export is extracted to: a dotfile beside the zip named for it
 * and for its fingerprint, so discovery never takes it for an upload, and an
 * extraction is reused only while the zip it came from is unchanged.
 */
function extractionPathFor(zipPath: string, stats: BigIntStats): string {
	return join(
		dirname(zipPath),
		`.${basename(zipPath)}.${fingerprintOf(stats)}.xml`,
	);
}

/**
 * Whether a `.partial` has gone unwritten for ABANDONED_PARTIAL_MS. One
 * written more recently may be another run's, and removing it would fail
 * that run's rename, and with it that run's import.
 */
function isAbandoned(path: string): boolean {
	const stats = statOrNull(path);
	return stats !== null && Date.now() - stats.mtimeMs >= ABANDONED_PARTIAL_MS;
}

/**
 * Remove every extraction of this zip but `keep`, and every `.partial` of one
 * that has not been written for ABANDONED_PARTIAL_MS, as a killed run's
 * stops being. Nothing else is ever removed; every other file beside the zip
 * may be the owner's. Best effort: a file that cannot be removed is left, as
 * a stale extraction is never read, and failing to tidy up must not cost the
 * import.
 */
function removeStaleExtractions(zipPath: string, keep: string): void {
	const dir = dirname(zipPath);
	const prefix = `.${basename(zipPath)}.`;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const suffix = name.startsWith(prefix)
			? EXTRACTION_SUFFIX_RE.exec(name.slice(prefix.length))
			: null;
		const partial = suffix?.[1] !== undefined;
		const stale =
			suffix !== null &&
			name !== basename(keep) &&
			(!partial || isAbandoned(join(dir, name)));
		if (stale) {
			try {
				rmSync(join(dir, name), { force: true });
			} catch {
				// Left in place; see above.
			}
		}
	}
}

/** An upload holding a Health export, and how to read it. */
interface FoundExport {
	readonly exportedAt: string | null;
	/** An XML ready to stream: the upload itself, or its zip's extraction. */
	readonly path?: string;
	/** A zip whose export is not extracted yet: its open descriptor and entry. */
	readonly pending?: {
		readonly entry: ZipEntry;
		readonly extractionPath: string;
		readonly fd: number;
	};
	readonly upload: Upload;
}

type Inspected =
	| { readonly kind: "export"; readonly found: FoundExport }
	| { readonly kind: "not_export" }
	| {
			readonly kind: "failed";
			/**
			 * A `.zip` that is damaged or incomplete, and so may hold an export
			 * newer than any found elsewhere; a `.zip` refused only for its size,
			 * whose remedy is to upload the XML inside it; or an upload that could
			 * not be read at all.
			 */
			readonly cause: "damaged" | "too_large" | "unreadable";
			readonly message: string;
	  };

function describeBytes(bytes: number): string {
	const gb = 1024 * 1024 * 1024;
	return bytes >= gb ? `${Math.floor(bytes / gb)} GB` : `${bytes} bytes`;
}

/** For a .zip with no readable directory; the upload preview says the same. */
export const UNREADABLE_ARCHIVE_MESSAGE =
	"The uploaded .zip could not be opened as an archive; it may be incomplete. Take a fresh export from Health app > profile > Export All Health Data and upload it again.";

const UNREADABLE_DIRECTORY_MESSAGE =
	"The folder holding your uploads could not be read, so nothing was imported.";

/**
 * For an archive this reader cannot open. The export inside it may still be
 * readable once unzipped, but only if it is within the size this import
 * reads, which from here cannot be known, so the advice says so.
 */
export function zipTooLargeMessage(
	detail: string,
	limits: UploadLimits,
): string {
	return `The uploaded .zip cannot be opened here: ${detail}. If the export XML inside it (apple_health_export/export.xml, or its translated name, such as eksport.xml) is under ${describeBytes(limits.maxExportBytes)}, unzip it on your computer and upload that XML instead.`;
}

/** For an export over the size this import reads, which unzipping would not change. */
export function exportTooLargeMessage(limits: UploadLimits): string {
	return `The export inside the uploaded .zip is larger than ${describeBytes(limits.maxExportBytes)}, the most this import reads.`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function inspectZipCandidate(
	upload: Upload,
	limits: UploadLimits,
): Promise<Inspected> {
	const fd = openSync(upload.path, "r");
	let keepOpen = false;
	try {
		const stats = fstatSync(fd, { bigint: true });
		const extractionPath = extractionPathFor(upload.path, stats);
		// Tidied whether or not this zip's extraction is reused, or a `.partial`
		// left beside a reused one would stay for as long as the zip does.
		removeStaleExtractions(upload.path, extractionPath);
		// An extraction keyed to this very zip is its export, already verified.
		const cached = statOrNull(extractionPath)
			? inspectXmlUpload(extractionPath)
			: null;
		if (cached?.kind === "export") {
			return {
				kind: "export",
				found: { exportedAt: cached.exportedAt, path: extractionPath, upload },
			};
		}
		const zip = await inspectZipUpload(fd, Number(stats.size), limits);
		if (zip.kind === "export") {
			keepOpen = true;
			return {
				kind: "export",
				found: {
					exportedAt: zip.exportedAt,
					pending: { entry: zip.entry, extractionPath, fd },
					upload,
				},
			};
		}
		if (zip.kind === "not_export") {
			return { kind: "not_export" };
		}
		return zip.kind === "too_large"
			? {
					kind: "failed",
					cause: "too_large",
					message: zipTooLargeMessage(zip.detail, limits),
				}
			: {
					kind: "failed",
					cause: "damaged",
					message: UNREADABLE_ARCHIVE_MESSAGE,
				};
	} finally {
		if (!keepOpen) {
			closeSync(fd);
		}
	}
}

async function inspectUpload(
	upload: Upload,
	limits: UploadLimits,
): Promise<Inspected> {
	const isXml = XML_NAME_RE.test(upload.path);
	try {
		if (!isXml) {
			return await inspectZipCandidate(upload, limits);
		}
		const xml = inspectXmlUpload(upload.path);
		return xml.kind === "export"
			? {
					kind: "export",
					found: { exportedAt: xml.exportedAt, path: upload.path, upload },
				}
			: { kind: "not_export" };
	} catch (err) {
		return {
			kind: "failed",
			cause: isXml ? "unreadable" : "damaged",
			message: `Failed to read the uploaded ${isXml ? "file" : ".zip"}: ${errorMessage(err)}`,
		};
	}
}

/** Newest ExportDate first; then the newer file; then the path, so the choice never varies. */
function isNewer(a: FoundExport, b: FoundExport): boolean {
	const dateA = a.exportedAt ?? "";
	const dateB = b.exportedAt ?? "";
	if (dateA !== dateB) {
		return dateA > dateB;
	}
	if (a.upload.mtimeMs !== b.upload.mtimeMs) {
		return a.upload.mtimeMs > b.upload.mtimeMs;
	}
	return a.upload.path < b.upload.path;
}

function release(found: FoundExport | null): void {
	if (found?.pending) {
		closeSync(found.pending.fd);
	}
}

export type UploadedExport =
	/** Nothing has been uploaded. */
	| { readonly kind: "none" }
	/** Files were uploaded and none is an Apple Health export. */
	| { readonly kind: "not_export" }
	/** The upload that may hold the export could not be read; the message says why and what to do. */
	| { readonly kind: "failed"; readonly message: string }
	| {
			readonly kind: "export";
			readonly exportedAt: string | null;
			/**
			 * Set when a `.zip` written after this export was refused for its
			 * size: what the owner is told of that `.zip`.
			 */
			readonly newerTooLarge?: string;
			/** The export XML, ready to stream. */
			readonly path: string;
	  };

async function readOut(
	found: FoundExport,
	limits: UploadLimits,
): Promise<UploadedExport> {
	if (!found.pending) {
		return {
			kind: "export",
			exportedAt: found.exportedAt,
			path: found.path ?? found.upload.path,
		};
	}
	const { entry, extractionPath } = found.pending;
	try {
		const extraction = await extractExportEntry(entry, extractionPath);
		if (extraction.kind === "export_too_large") {
			return {
				kind: "failed",
				message: `${exportTooLargeMessage(limits)} Nothing was imported.`,
			};
		}
	} catch (err) {
		return {
			kind: "failed",
			message: `Failed to extract the export from the uploaded .zip: ${errorMessage(err)}`,
		};
	}
	return { kind: "export", exportedAt: found.exportedAt, path: extractionPath };
}

/** An upload that could not be read, and when it was written. */
interface Failure {
	readonly message: string;
	readonly mtimeMs: number;
}

function newestFailure(
	failure: Failure | null,
	upload: Upload,
	message: string,
): Failure {
	return failure === null || upload.mtimeMs > failure.mtimeMs
		? { message, mtimeMs: upload.mtimeMs }
		: failure;
}

/**
 * Resolve the export XML to read this run: find the uploads, keep the one
 * holding the newest export (see isNewer), and extract it if it is a zip.
 *
 * Only an export can be chosen, and never in place of a newer upload that
 * may hold one but could not be read: a `.zip` that is damaged or incomplete,
 * written after the export found, is reported exactly as if it were the only
 * upload, and nothing is read. Reading the older export instead would import
 * stale data while the owner believes the new upload was read. A `.zip`
 * refused only for its size does not stand in the way: the remedy it is
 * given, unzipping it and uploading the XML, leaves exactly that XML beside
 * it, with the file time the archive gave it. The export is read, and the
 * result names that `.zip` (newerTooLarge), so the owner is still told that
 * a newer upload could not be opened. Nor does an `.xml`, known to be an
 * export only by its head, whose head cannot be read.
 *
 * When no upload is an export, an upload that could not be read is reported,
 * the newest first, since it may be the export; the owner is told why and
 * what to do. Otherwise the upload is called the wrong file, or none said to
 * have been found.
 *
 * Uploads are inspected one at a time, and only the leading export's zip is
 * held open, so that its directory is read once and its export extracted
 * from the same descriptor. A directory that cannot be listed is passed to
 * `onUnreadableDirectory` and skipped, for the caller to tell the owner of
 * beside what was found. The import folder itself, unlisted, is the outcome,
 * since nothing in it can be found.
 */
export async function resolveUploadedExport(
	importDir: string,
	limits: UploadLimits = UPLOAD_LIMITS,
	onUnreadableDirectory?: (dir: string) => void,
): Promise<UploadedExport> {
	let importDirUnlisted = false;
	const uploads = findUploads(importDir, (dir) => {
		importDirUnlisted ||= dir === importDir;
		onUnreadableDirectory?.(dir);
	});
	if (importDirUnlisted) {
		return { kind: "failed", message: UNREADABLE_DIRECTORY_MESSAGE };
	}
	if (uploads.length === 0) {
		return { kind: "none" };
	}
	let best: FoundExport | null = null;
	let failure: Failure | null = null;
	let damagedZip: Failure | null = null;
	let tooLargeZip: Failure | null = null;
	try {
		for (const upload of uploads) {
			const inspected = await inspectUpload(upload, limits);
			if (inspected.kind === "export") {
				if (best === null || isNewer(inspected.found, best)) {
					release(best);
					best = inspected.found;
				} else {
					release(inspected.found);
				}
			} else if (inspected.kind === "failed") {
				failure = newestFailure(failure, upload, inspected.message);
				if (inspected.cause === "damaged") {
					damagedZip = newestFailure(damagedZip, upload, inspected.message);
				} else if (inspected.cause === "too_large") {
					tooLargeZip = newestFailure(tooLargeZip, upload, inspected.message);
				}
			}
		}
		if (best && !(damagedZip && damagedZip.mtimeMs > best.upload.mtimeMs)) {
			const read = await readOut(best, limits);
			return read.kind === "export" &&
				tooLargeZip &&
				tooLargeZip.mtimeMs > best.upload.mtimeMs
				? { ...read, newerTooLarge: tooLargeZip.message }
				: read;
		}
		const reported = best ? damagedZip : failure;
		if (reported) {
			return { kind: "failed", message: reported.message };
		}
		return { kind: "not_export" };
	} finally {
		release(best);
	}
}
