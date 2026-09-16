// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";

const requireFromTarReader = (() => {
  try {
    return createRequire(import.meta.url);
  } catch {
    // The unchanged mutation control imports a transformed copy as a data URL.
    return createRequire(join(process.cwd(), "package.json"));
  }
})();
const { Parser } = requireFromTarReader("tar");

const BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 10_000;
const DECOMPRESSED_OVERHEAD_BYTES = 16 * 1024 * 1024;
const MAX_EXTENDED_HEADER_BYTES = BLOCK_SIZE * 8;

const TYPE_FILE = new Set(["0", "\0"]);
const TYPE_DIRECTORY = "5";
const TYPE_GNU_LONGNAME = "L";
const TYPE_GNU_LONGLINK = "K";
const TYPE_PAX_NEXT = "x";
const TYPE_PAX_GLOBAL = "g";
const METADATA_TYPES = new Set([
  TYPE_GNU_LONGNAME,
  TYPE_GNU_LONGLINK,
  TYPE_PAX_NEXT,
  TYPE_PAX_GLOBAL,
]);
const INFORMATIONAL_PAX_KEYS = new Set([
  "mtime",
  "atime",
  "ctime",
  "uid",
  "gid",
  "uname",
  "gname",
  "comment",
]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function readString(block, offset, length, label) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  try {
    return STRICT_UTF8.decode(nul < 0 ? field : field.subarray(0, nul));
  } catch {
    throw new Error(`archive contains a ${label} that is not valid UTF-8`);
  }
}

function readSize(block) {
  const offset = 124;
  const length = 12;
  if (block[offset] & 0x80) {
    let value = 0n;
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = (value << 8n) | BigInt(block[index]);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("archive declares a member size too large to account for");
    }
    return Number(value);
  }

  const field = block.toString("ascii", offset, offset + length).replace(/\0/g, " ").trim();
  if (!/^[0-7]+$/.test(field)) {
    throw new Error("archive declares an unreadable member size");
  }
  const size = Number.parseInt(field, 8);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("archive declares an unreadable member size");
  }
  return size;
}

function readPaxSize(value) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error("archive declares an unreadable PAX member size");
  }
  const size = Number(value);
  if (!Number.isSafeInteger(size)) {
    throw new Error("archive declares a PAX member size too large to account for");
  }
  return size;
}

function parsePaxRecords(body) {
  const records = new Map();
  let offset = 0;

  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space <= offset) throw new Error("archive contains a malformed PAX record");
    const lengthText = body.toString("latin1", offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) {
      throw new Error("archive contains a malformed PAX record");
    }
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || body[end - 1] !== 0x0a) {
      throw new Error("archive contains a malformed PAX record");
    }

    const equals = body.indexOf(0x3d, space + 1);
    if (equals < 0 || equals >= end - 1) {
      throw new Error("archive contains a malformed PAX record");
    }
    let key;
    let value;
    try {
      key = STRICT_UTF8.decode(body.subarray(space + 1, equals));
      value = STRICT_UTF8.decode(body.subarray(equals + 1, end - 1));
    } catch {
      throw new Error("archive contains a malformed PAX record");
    }

    if (key === "linkpath") throw new Error("archive uses unsupported PAX linkpath");
    if (key !== "path" && key !== "size" && !INFORMATIONAL_PAX_KEYS.has(key)) {
      throw new Error(`archive uses unsupported PAX key "${key}"`);
    }
    if ((key === "path" || key === "size") && value === "") {
      throw new Error(`archive uses unsupported empty PAX ${key}`);
    }
    if (key === "path" && value.includes("\0")) {
      throw new Error("archive uses a PAX path containing a NUL byte");
    }
    records.set(key, value);
    offset = end;
  }

  return records;
}

function parseGnuLongName(body) {
  try {
    const nul = body.indexOf(0);
    return STRICT_UTF8.decode(nul < 0 ? body : body.subarray(0, nul));
  } catch {
    throw new Error("archive contains a GNU long name that is not valid UTF-8");
  }
}

function parserHeaderBlock(block, path, type, rawSize) {
  if (!TYPE_FILE.has(type) || rawSize === 0 || !path.endsWith("/")) return block;

  const lastNameByte = block.subarray(0, 100).findLastIndex((byte) => byte !== 0);
  if (lastNameByte < 0 || block[lastNameByte] !== 0x2f) return block;

  const adjusted = Buffer.from(block);
  adjusted[lastNameByte] = 0;
  adjusted.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of adjusted) checksum += byte;
  adjusted.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return adjusted;
}

function effectiveMemberMetadata(globalPax, nextPax, rawSize) {
  const path = nextPax?.get("path") ?? globalPax.get("path") ?? null;
  const size = nextPax?.has("size")
    ? readPaxSize(nextPax.get("size"))
    : globalPax.has("size")
      ? readPaxSize(globalPax.get("size"))
      : rawSize;
  return { path, size };
}

function normalizedMemberDestination(path) {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function decompressedMeter(maxDecompressedBytes, observeDecompressedChunk) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        total += chunk.length;
        observeDecompressedChunk(chunk.length);
        if (total > maxDecompressedBytes) {
          callback(new Error(`decompressed input exceeds the ${maxDecompressedBytes}-byte ceiling`));
          return;
        }
        callback(null, chunk);
      } catch (error) {
        callback(asError(error));
      }
    },
  });
}

function blockFramer() {
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= BLOCK_SIZE) {
        this.push(pending.subarray(0, BLOCK_SIZE));
        pending = pending.subarray(BLOCK_SIZE);
      }
      callback();
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending);
      callback();
    },
  });
}

/**
 * Keep only the small amount of raw framing that node-tar intentionally does
 * not expose. Parser still owns tar header decoding, metadata application,
 * stream ordering and entry bodies; this tap supplies exact raw sizes and
 * metadata bytes for the installer's stricter policy.
 */
function rawArchiveTap({ onHeader, onMetadata }) {
  let state = "header";
  let currentHeader = null;
  let bodyBlocksRemaining = 0;
  let metadataBodyRemaining = 0;
  let metadataBody = [];
  let sawFirstEndBlock = false;

  function feed(block) {
    if (state === "body") {
      bodyBlocksRemaining -= 1;
      if (bodyBlocksRemaining === 0) state = "header";
      return block;
    }

    if (state === "metadata") {
      const used = metadataBody.length * BLOCK_SIZE;
      const take = Math.min(BLOCK_SIZE, metadataBodyRemaining - used);
      if (take > 0) metadataBody.push(Buffer.from(block.subarray(0, take)));
      bodyBlocksRemaining -= 1;
      if (bodyBlocksRemaining === 0) {
        onMetadata({
          type: currentHeader.type,
          body: Buffer.concat(metadataBody, metadataBodyRemaining),
        });
        currentHeader = null;
        metadataBody = [];
        metadataBodyRemaining = 0;
        state = "header";
      }
      return block;
    }

    if (state !== "header") {
      throw new Error("archive parser lost track of the current member");
    }

    if (isZeroBlock(block)) {
      sawFirstEndBlock = true;
      return block;
    }
    if (sawFirstEndBlock) {
      throw new Error("archive contains a non-zero block after its first end marker");
    }

    const type = String.fromCharCode(block[156]);
    const name = readString(block, 0, 100, "member name");
    const prefix = readString(block, 345, 155, "member name");
    const rawSize = readSize(block);
    const path = prefix ? `${prefix}/${name}` : name;
    currentHeader = { block: Buffer.from(block), type, rawSize, path };
    onHeader(currentHeader);

    if (METADATA_TYPES.has(type)) {
      if (rawSize > MAX_EXTENDED_HEADER_BYTES) {
        throw new Error("archive declares an implausibly large extended header");
      }
      metadataBodyRemaining = rawSize;
      bodyBlocksRemaining = Math.ceil(rawSize / BLOCK_SIZE);
      if (bodyBlocksRemaining === 0) {
        onMetadata({ type, body: Buffer.alloc(0) });
        currentHeader = null;
      } else {
        state = "metadata";
      }
      return block;
    }

    state = "awaiting-entry";
    return parserHeaderBlock(block, path, type, rawSize);
  }

  return {
    feed,
    beginEntry(size) {
      if (state !== "awaiting-entry" || !currentHeader) {
        throw new Error("archive parser did not expose the current member header");
      }
      bodyBlocksRemaining = Math.ceil(size / BLOCK_SIZE);
      currentHeader = null;
      state = bodyBlocksRemaining === 0 ? "header" : "body";
    },
    currentHeader() {
      return currentHeader;
    },
    hasPendingMetadata() {
      return state === "metadata" || state === "awaiting-entry" && currentHeader?.type === TYPE_GNU_LONGLINK;
    },
    state() {
      return state;
    },
  };
}

function nonEmptyPaxValues(pax) {
  return Object.fromEntries(
    Object.entries(pax ?? {}).filter(([key, value]) => key !== "global" && value !== undefined)
  );
}

function assertParserMetadata(entry) {
  const allowed = new Set([...INFORMATIONAL_PAX_KEYS, "path", "size"]);
  for (const metadata of [entry.extended, entry.globalExtended]) {
    for (const key of Object.keys(nonEmptyPaxValues(metadata))) {
      if (!allowed.has(key)) {
        throw new Error(`archive uses unsupported PAX key "${key}"`);
      }
    }
  }
}

function parserError(error, tap) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Truncated input/.test(message)) {
    return new Error(
      tap.state() === "body"
        ? "archive ends in the middle of a member"
        : "archive ends in the middle of a header block"
    );
  }
  return asError(error);
}

/**
 * Gunzip and parse one archive while enforcing file, input, and entry limits.
 * Returns regular files as `[{ path, buffer }]`, in archive order.
 */
export async function readTarGzEntries(
  buffer,
  {
    maxUnpackedBytes,
    maxDecompressedBytes = Math.min(
      Number.MAX_SAFE_INTEGER,
      maxUnpackedBytes + DECOMPRESSED_OVERHEAD_BYTES
    ),
    maxEntries = DEFAULT_MAX_ENTRIES,
    validateMemberPath = () => {},
    observeDecompressedChunk = () => {},
  } = {}
) {
  if (!Number.isSafeInteger(maxUnpackedBytes) || maxUnpackedBytes < 0) {
    throw new Error("a byte ceiling is required to read an archive");
  }
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 0) {
    throw new Error("a decompressed-input byte ceiling must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new Error("an archive entry ceiling must be a non-negative safe integer");
  }
  if (typeof observeDecompressedChunk !== "function") {
    throw new Error("observeDecompressedChunk must be a function");
  }

  const source = Readable.from(buffer);
  const gunzip = createGunzip();
  const meter = decompressedMeter(maxDecompressedBytes, observeDecompressedChunk);
  const framer = blockFramer();
  const parser = new Parser({ strict: true, maxDecompressionRatio: Infinity });

  const files = [];
  const globalPax = new Map();
  const pendingMetadata = [];
  const rawMetadata = [];
  const memberDestinations = new Set();
  let declared = 0;
  let entryCount = 0;
  let sawEndOfArchive = false;
  let sawPartialBlock = false;
  let failure = null;
  let stopped = false;

  const tap = rawArchiveTap({
    onHeader(header) {
      if (header.type === TYPE_DIRECTORY && header.rawSize !== 0) {
        throw new Error("archive declares a non-zero directory size");
      }
      if (header.type === TYPE_GNU_LONGLINK) {
        throw new Error("archive uses unsupported GNU long-link metadata");
      }
    },
    onMetadata(metadata) {
      rawMetadata.push(metadata);
    },
  });

  const stopInput = () => {
    if (stopped) return;
    stopped = true;
    source.destroy();
    gunzip.destroy();
    meter.destroy();
    framer.destroy();
  };

  const fail = (error) => {
    const next = asError(error);
    if (failure) return;
    failure = next;
    stopInput();
    if (!parser.aborted) {
      try {
        parser.abort(next);
      } catch {
        // The parser's error listener receives the original failure.
      }
    }
  };

  const countEntry = () => {
    entryCount += 1;
    if (entryCount > maxEntries) {
      throw new Error(`archive contains more than ${maxEntries} entries`);
    }
  };

  const processMetadata = (_metaText) => {
    countEntry();
    const raw = rawMetadata.shift();
    if (!raw) throw new Error("archive parser reported metadata without raw bytes");

    if (raw.type === TYPE_GNU_LONGNAME) {
      pendingMetadata.push({ type: raw.type, path: parseGnuLongName(raw.body) });
      return;
    }

    if (raw.type === TYPE_PAX_NEXT || raw.type === TYPE_PAX_GLOBAL) {
      pendingMetadata.push({ type: raw.type, records: parsePaxRecords(raw.body) });
      return;
    }

    throw new Error(`Artifact contains unsupported archive entry type "${raw.type}"`);
  };

  const processEntry = (entry) => {
    countEntry();
    const rawHeader = tap.currentHeader();
    if (!rawHeader) throw new Error("archive parser reported an entry without a raw header");
    const parserInferredDirectory = TYPE_FILE.has(rawHeader.type) && entry.header.typeKey === TYPE_DIRECTORY;
    if (
      rawHeader.type !== entry.header.typeKey &&
      !(rawHeader.type === "\0" && entry.header.typeKey === "0") &&
      !parserInferredDirectory
    ) {
      throw new Error("archive parser reported an entry with an unknown header type");
    }
    assertParserMetadata(entry);

    if (rawMetadata.length > 0) {
      throw new Error("archive contains metadata that has no following entry");
    }

    const localMetadata = pendingMetadata.filter(({ type }) => type !== TYPE_PAX_GLOBAL);
    if (
      localMetadata.some(({ type }) => type === TYPE_GNU_LONGNAME) &&
      localMetadata.some(({ type }) => type === TYPE_PAX_NEXT)
    ) {
      throw new Error("archive combines GNU and PAX path overrides for one entry");
    }
    let sawLocalMetadata = false;
    for (const metadata of pendingMetadata) {
      if (metadata.type === TYPE_PAX_GLOBAL) {
        if (sawLocalMetadata) {
          throw new Error("archive uses consecutive per-entry metadata headers");
        }
      } else if (sawLocalMetadata) {
        throw new Error("archive uses consecutive per-entry metadata headers");
      } else {
        sawLocalMetadata = true;
      }
    }

    const pendingGlobalPax = new Map(globalPax);
    for (const metadata of pendingMetadata) {
      if (metadata.type === TYPE_PAX_GLOBAL) {
        for (const [key, value] of metadata.records) pendingGlobalPax.set(key, value);
      }
    }
    const local = localMetadata[0];
    if (local?.type === TYPE_GNU_LONGNAME && pendingGlobalPax.has("path")) {
      throw new Error("archive combines GNU and PAX path overrides for one entry");
    }

    for (const metadata of pendingMetadata) {
      if (metadata.type === TYPE_PAX_GLOBAL) {
        for (const [key, value] of metadata.records) globalPax.set(key, value);
      }
    }
    const nextPax = local?.type === TYPE_PAX_NEXT ? local.records : null;
    const rawSize = rawHeader.rawSize;
    const effective = effectiveMemberMetadata(globalPax, nextPax, rawSize);
    const path = local?.path ?? effective.path ?? rawHeader.path;
    const size = effective.size;
    pendingMetadata.length = 0;

    if (typeof path !== "string" || path.includes("\0")) {
      throw new Error("archive contains a member path that is not valid");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("archive declares an unreadable member size");
    }
    if (rawHeader.type === TYPE_DIRECTORY && size !== 0) {
      throw new Error("archive declares a non-zero directory size");
    }

    const parserExpectedPath = TYPE_FILE.has(rawHeader.type) && rawHeader.rawSize > 0
      ? path.endsWith("/")
        ? path.slice(0, -1)
        : path
      : path;
    const parserEffectivePath = entry.extended?.path ?? entry.globalExtended?.path ?? entry.path;
    const parserMissedNewlinePath =
      effective.path?.includes("\n") &&
      !entry.extended?.path &&
      !entry.globalExtended?.path &&
      parserEffectivePath === entry.path;
    if ((parserEffectivePath !== parserExpectedPath && !parserMissedNewlinePath) || entry.size !== size) {
      throw new Error(
        "archive parser metadata disagrees with raw archive"
      );
    }

    if (rawHeader.type === TYPE_DIRECTORY) {
      validateMemberPath(path);
      tap.beginEntry(0);
      entry.resume();
      return;
    }
    if (!TYPE_FILE.has(rawHeader.type)) {
      throw new Error(`Artifact contains unsupported archive entry type "${rawHeader.type}"`);
    }

    validateMemberPath(path);
    const destination = normalizedMemberDestination(path);
    if (memberDestinations.has(destination)) {
      throw new Error(`archive contains duplicate member destination "${destination}"`);
    }
    memberDestinations.add(destination);
    declared += size;
    if (declared > maxUnpackedBytes) {
      throw new Error(
        `archive declares ${declared} bytes of members, over the ${maxUnpackedBytes}-byte ceiling`
      );
    }

    const chunks = [];
    let received = 0;
    let finalized = false;
    const finalize = () => {
      if (finalized) return;
      finalized = true;
      if (received !== size) {
        fail(`archive member ended after ${received} bytes, expected ${size}`);
        return;
      }
      files.push({ path, buffer: Buffer.concat(chunks, size) });
    };
    entry.on("data", (chunk) => {
      received += chunk.length;
      chunks.push(Buffer.from(chunk));
    });
    entry.on("end", finalize);
    tap.beginEntry(size);
    entry.resume();
    if (size === 0) finalize();
  };

  const parserPromise = new Promise((resolve, reject) => {
    const rejectOnce = (error) => {
      const next = parserError(error, tap);
      if (!failure) failure = next;
      stopInput();
      reject(failure);
    };

    parser.on("error", rejectOnce);
    parser.on("warn", (code, message) => rejectOnce(new Error(`${code}: ${message}`)));
    parser.on("ignoredEntry", (entry) => {
      try {
        countEntry();
        fail(new Error(`Artifact contains unsupported archive entry type "${entry.header.typeKey}"`));
      } catch (error) {
        fail(error);
      }
    });
    parser.on("meta", (metaText) => {
      try {
        processMetadata(metaText);
      } catch (error) {
        fail(error);
      }
    });
    parser.on("entry", (entry) => {
      try {
        processEntry(entry);
      } catch (error) {
        fail(error);
      }
    });
    parser.on("eof", () => {
      try {
        if (pendingMetadata.length > 0 || rawMetadata.length > 0 || tap.hasPendingMetadata()) {
          throw new Error("archive ends with metadata that has no following entry");
        }
        sawEndOfArchive = true;
        stopInput();
        parser.end();
      } catch (error) {
        fail(error);
      }
    });
    parser.on("end", () => {
      if (failure) return;
      if (!sawEndOfArchive) {
        rejectOnce(
          new Error(
            sawPartialBlock
              ? "archive ends in the middle of a header block"
              : "archive ends before two zero blocks"
          )
        );
        return;
      }
      resolve();
    });

    source.on("error", rejectOnce);
    gunzip.on("error", rejectOnce);
    meter.on("error", rejectOnce);
    framer.on("error", rejectOnce);
    framer.on("end", () => {
      if (!stopped && !failure) parser.end();
    });
    framer.on("data", (block) => {
      if (stopped || failure) return;
      try {
        let parserBlock = block;
        if (block.length === BLOCK_SIZE) parserBlock = tap.feed(block);
        else sawPartialBlock = true;
        if (!parser.write(parserBlock)) framer.pause();
      } catch (error) {
        fail(error);
      }
    });
    parser.on("drain", () => {
      if (!stopped && !failure) framer.resume();
    });

    source.pipe(gunzip).pipe(meter).pipe(framer);
  });

  await parserPromise;
  return files;
}
