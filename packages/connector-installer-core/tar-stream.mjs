// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { Readable, Transform } from "node:stream";
import { createGunzip } from "node:zlib";

/**
 * Read a `.tar.gz` layer by parsing the archive format, never a tool's display.
 *
 * The previous reader used a whitespace column from `tar -tvzf`. GNU and BSD
 * tar render that listing differently, and producing a complete listing gave
 * no proof that an oversized stream was stopped early. This reader uses the
 * header fields directly and enforces limits while gunzip produces data.
 */

const BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 10_000;
const DECOMPRESSED_OVERHEAD_BYTES = 16 * 1024 * 1024;

const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

const TYPE_FILE = new Set(["0", "\0"]);
const TYPE_DIRECTORY = "5";
const TYPE_GNU_LONGNAME = "L";
const TYPE_GNU_LONGLINK = "K";
const TYPE_PAX_NEXT = "x";
const TYPE_PAX_GLOBAL = "g";
const METADATA_TYPES = new Set([TYPE_GNU_LONGNAME, TYPE_PAX_NEXT, TYPE_PAX_GLOBAL]);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// `path` and `size` affect members and are implemented below; empty values for
// either are refused. `linkpath` and every unlisted key are also refused. These
// keys are the complete informational allowlist: they do not change bytes or
// paths this installer returns. Consecutive per-entry metadata headers are
// refused rather than assigned accidental precedence. In particular, SCHILY.*
// and LIBARCHIVE.* are not ignored as families because some keys define sparse
// semantics.
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

function readString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  try {
    return STRICT_UTF8.decode(nul < 0 ? field : field.subarray(0, nul));
  } catch {
    throw new Error("archive contains a member name that is not valid UTF-8");
  }
}

function readGnuLongName(body) {
  const nul = body.indexOf(0);
  try {
    return STRICT_UTF8.decode(nul < 0 ? body : body.subarray(0, nul));
  } catch {
    throw new Error("archive contains a GNU long name that is not valid UTF-8");
  }
}

function readSize(block) {
  if (block[SIZE_OFFSET] & 0x80) {
    let value = 0n;
    for (let i = SIZE_OFFSET + 1; i < SIZE_OFFSET + SIZE_LENGTH; i += 1) {
      value = (value << 8n) | BigInt(block[i]);
    }
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("archive declares a member size too large to account for");
    }
    return Number(value);
  }

  const field = block.toString("ascii", SIZE_OFFSET, SIZE_OFFSET + SIZE_LENGTH);
  const digits = field.replace(/\0/g, " ").trim();
  if (!/^[0-7]+$/.test(digits)) {
    throw new Error("archive declares an unreadable member size");
  }
  const size = Number.parseInt(digits, 8);
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

function memberName(block) {
  const name = readString(block, NAME_OFFSET, NAME_LENGTH);
  const prefix = readString(block, PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix ? `${prefix}/${name}` : name;
}

function headerChecksumMatches(block) {
  const field = block.toString("ascii", 148, 156).replace(/\0/g, " ").trim();
  const stored = Number.parseInt(field, 8);
  if (!Number.isFinite(stored)) return false;

  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function newMember(path, size, collect, metadataType = null) {
  return {
    path,
    size,
    remaining: size,
    padded: Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE,
    chunks: [],
    collect,
    metadataType,
  };
}

function malformedPaxRecord() {
  throw new Error("archive contains a malformed PAX record");
}

/** Parse byte-counted PAX records. Later records with the same key win. */
function parsePaxRecords(body) {
  const records = new Map();
  let offset = 0;

  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space <= offset) malformedPaxRecord();
    const lengthText = body.toString("latin1", offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) malformedPaxRecord();
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > body.length || body[end - 1] !== 0x0a) {
      malformedPaxRecord();
    }

    const equals = body.indexOf(0x3d, space + 1);
    if (equals < 0 || equals >= end - 1) malformedPaxRecord();
    let key;
    let value;
    try {
      key = STRICT_UTF8.decode(body.subarray(space + 1, equals));
      value = STRICT_UTF8.decode(body.subarray(equals + 1, end - 1));
    } catch {
      malformedPaxRecord();
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

function applyPaxRecords(target, records) {
  for (const [key, value] of records) {
    target.set(key, value);
  }
}

function effectiveMemberMetadata(globalRecords, nextRecords, rawSize) {
  const effective = new Map(globalRecords);
  applyPaxRecords(effective, nextRecords);
  return {
    path: effective.get("path") ?? null,
    size: effective.has("size") ? readPaxSize(effective.get("size")) : rawSize,
  };
}

function isZeroBlock(block) {
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    if (block[i] !== 0) return false;
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
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/**
 * Gunzip and parse one archive while enforcing file, input, and entry limits.
 * Returns regular files as `[{ path, buffer }]`, in archive order.
 *
 * The parser stops after the two tar end blocks. Node streams may have already
 * produced bounded read-ahead when that stop is observed.
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
  source.on("error", (error) => meter.destroy(error));
  gunzip.on("error", (error) => meter.destroy(error));
  source.pipe(gunzip).pipe(meter);

  const files = [];
  let pending = Buffer.alloc(0);
  let declared = 0;
  let entryCount = 0;
  let current = null;
  let zeroBlockCount = 0;
  let archiveEnded = false;
  let nextGnuPath = null;
  const globalPax = new Map();
  const nextPax = new Map();

  const stopStreams = () => {
    source.destroy();
    gunzip.destroy();
    meter.destroy();
  };
  const fail = (message) => {
    stopStreams();
    throw new Error(message);
  };

  try {
    archiveChunks: for await (const chunk of meter) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      while (pending.length >= BLOCK_SIZE) {
        if (current) {
          const take = Math.min(current.padded, pending.length - (pending.length % BLOCK_SIZE));
          if (take === 0) break;
          const payload = Math.min(take, current.remaining);
          if (current.collect && payload > 0) {
            current.chunks.push(Buffer.from(pending.subarray(0, payload)));
          }
          current.remaining -= payload;
          current.padded -= take;
          pending = pending.subarray(take);

          if (current.padded === 0) {
            const body = Buffer.concat(current.chunks, current.size);
            if (current.metadataType === TYPE_GNU_LONGNAME) {
              nextGnuPath = readGnuLongName(body);
            } else if (current.metadataType === TYPE_PAX_NEXT) {
              applyPaxRecords(nextPax, parsePaxRecords(body));
            } else if (current.metadataType === TYPE_PAX_GLOBAL) {
              applyPaxRecords(globalPax, parsePaxRecords(body));
            } else if (current.collect) {
              files.push({ path: current.path, buffer: body });
            }
            current = null;
          }
          continue;
        }

        const block = pending.subarray(0, BLOCK_SIZE);
        pending = pending.subarray(BLOCK_SIZE);

        if (isZeroBlock(block)) {
          zeroBlockCount += 1;
          if (zeroBlockCount === 2) {
            if (nextGnuPath !== null || nextPax.size > 0) {
              fail("archive ends with metadata that has no following entry");
            }
            archiveEnded = true;
            stopStreams();
            break archiveChunks;
          }
          continue;
        }
        if (zeroBlockCount === 1) {
          fail("archive contains a non-zero block after its first end marker");
        }
        if (!headerChecksumMatches(block)) {
          fail("archive contains a block that is not a readable tar header");
        }

        entryCount += 1;
        if (entryCount > maxEntries) fail(`archive contains more than ${maxEntries} entries`);

        const type = String.fromCharCode(block[TYPEFLAG_OFFSET]);
        const rawSize = readSize(block);
        if (type === TYPE_GNU_LONGLINK) {
          fail("archive uses unsupported GNU long-link metadata");
        }
        if (METADATA_TYPES.has(type)) {
          if (nextGnuPath !== null || nextPax.size > 0) {
            fail("archive uses consecutive per-entry metadata headers");
          }
          if (rawSize > BLOCK_SIZE * 8) {
            fail("archive declares an implausibly large extended header");
          }
          current = rawSize === 0 ? null : newMember(memberName(block), rawSize, true, type);
          continue;
        }

        const effective = effectiveMemberMetadata(globalPax, nextPax, rawSize);
        if (nextGnuPath !== null && effective.path !== null) {
          fail("archive combines GNU and PAX path overrides for one entry");
        }
        const path = effective.path ?? nextGnuPath ?? memberName(block);
        const size = effective.size;
        nextGnuPath = null;
        nextPax.clear();

        if (type === TYPE_DIRECTORY) {
          if (size !== 0) fail("archive declares a non-zero directory size");
          validateMemberPath(path);
          continue;
        }
        if (!TYPE_FILE.has(type)) {
          fail(`Artifact contains unsupported archive entry type "${type}"`);
        }

        validateMemberPath(path);
        declared += size;
        if (declared > maxUnpackedBytes) {
          fail(
            `archive declares ${declared} bytes of members, over the ${maxUnpackedBytes}-byte ceiling`
          );
        }
        if (size === 0) files.push({ path, buffer: Buffer.alloc(0) });
        else current = newMember(path, size, true);
      }
    }
  } catch (error) {
    stopStreams();
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (current) fail("archive ends in the middle of a member");
  if (!archiveEnded) {
    if (pending.length > 0) fail("archive ends in the middle of a header block");
    fail("archive ends before two zero blocks");
  }
  return files;
}
