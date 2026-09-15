// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

/**
 * Read a `.tar.gz` layer by parsing the archive FORMAT, never a tool's display.
 *
 * The previous reader totalled `tar -tvzf`'s whitespace column 2. That column is
 * not an interface. GNU tar prints `perms owner/group size`, BSD tar prints
 * `perms links owner group size`, so the same expression reads the SIZE on one
 * platform and the OWNER on the other: a named owner (`builduser`) made a valid
 * archive unreadable, and a numeric owner (`0`) added zero to the total and let
 * an oversized archive through. No token index fixes that — one of the two
 * platforms is always wrong. The size a tar archive declares lives at a fixed
 * offset in a 512-byte header (POSIX ustar: bytes 124..136, octal), which is the
 * archive's own metadata and identical on every platform and every tool.
 *
 * Reading the format also buys the property the old preflight only claimed.
 * `tar -tvzf` decompresses the WHOLE archive to produce its listing, so a 190 KB
 * layer that expands to 200 MB was fully expanded before the ceiling was
 * consulted — on a host with a RAM-backed /tmp, into memory. Here the gunzip is
 * a stream and the running total is checked per member, so the read is abandoned
 * as soon as the declared bytes cross the ceiling: the bomb above stops after
 * about 2 MB instead of 200 MB.
 *
 * Member bodies are collected in memory rather than written out, so "refuse and
 * clean up on overflow" is the absence of a write rather than a deletion after
 * one. The caller still measures what it received (see `readLayerArchive`),
 * because a header is written by whoever built the archive and only bytes
 * counted on the reading side are a guarantee rather than a claim.
 */

const BLOCK_SIZE = 512;

// ustar header field offsets. Fixed by the format, not by a tool's choices.
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;

// Entry types that carry a member this installer will accept: a regular file
// (`0`, and the historical `\0` spelling) or a directory (`5`). Everything else
// — symlink `1`/`2`, character/block device `3`/`4`, FIFO `6` — is refused, the
// same predicate the tarball path applies, now decided from the header byte
// rather than from the first character of a rendered line.
const TYPE_FILE = new Set(["0", "\0"]);
const TYPE_DIRECTORY = "5";

// Metadata entries: GNU long name/link (`L`/`K`) and pax extended headers
// (`x`/`g`). These describe the NEXT entry rather than being a member. Their
// bodies are skipped and their sizes are not charged against the ceiling; the
// member they annotate is read from its own header, which carries the real size.
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

function readString(block, offset, length) {
  return block.toString("utf8", offset, offset + length).replace(/\0.*$/, "");
}

/**
 * The declared size, read as the format defines it.
 *
 * Octal ASCII in the ordinary case. The high bit set marks GNU's base-256
 * encoding for sizes that do not fit the 12 octal digits; it is read rather than
 * ignored, because treating an unreadable size as zero is exactly the failure
 * that let an oversized archive through before.
 */
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

function memberName(block) {
  const name = readString(block, NAME_OFFSET, NAME_LENGTH);
  const prefix = readString(block, PREFIX_OFFSET, PREFIX_LENGTH);
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * The checksum the header stores over itself, verified so a block of arbitrary
 * bytes is not read as a header. Both the signed and unsigned sums are accepted
 * because historical writers disagreed on the sign of the char type.
 */
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

/**
 * The path a pax extended header declares for the member that follows it.
 *
 * Records are `<length> <key>=<value>\n`. Only `path` is read; everything else
 * an archive may carry there is irrelevant to this reader.
 */
function paxPath(body) {
  const text = body.toString("utf8");
  const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(`\n${text}`);
  return match ? match[1] : null;
}

function isZeroBlock(block) {
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

/**
 * Gunzip and parse one archive, enforcing `maxUnpackedBytes` as it goes.
 *
 * Returns `[{ path, buffer }]` for the regular files, in archive order.
 * `validateMemberPath` is the caller's path predicate, applied to every entry
 * before its body is accepted, so a traversing or absolute name is refused
 * during the read rather than after a tree exists.
 *
 * Throws as soon as the running total crosses the ceiling. The stream is
 * destroyed at that point, so the remainder is never decompressed.
 */
export async function readTarGzEntries(
  buffer,
  { maxUnpackedBytes, validateMemberPath = () => {} } = {}
) {
  if (!Number.isFinite(maxUnpackedBytes) || maxUnpackedBytes < 0) {
    throw new Error("a byte ceiling is required to read an archive");
  }

  const gunzip = createGunzip();
  const source = Readable.from(buffer);
  source.pipe(gunzip);

  const files = [];
  let pending = Buffer.alloc(0);
  let declared = 0;
  // Set while a member's body is being consumed; null while the next block is
  // expected to be a header.
  let current = null;
  let sawTerminator = false;
  // Set by an `L`/`x` metadata entry, consumed by the member it precedes.
  let nextPathOverride = null;

  const fail = (message) => {
    source.destroy();
    gunzip.destroy();
    throw new Error(message);
  };

  try {
    for await (const chunk of gunzip) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      // Consume whole blocks only; a partial trailing block waits for the next
      // chunk. This is what keeps memory bounded by the ceiling rather than by
      // the archive.
      while (pending.length >= BLOCK_SIZE) {
        if (current) {
          // A member occupies whole blocks: `size` payload bytes then zero
          // padding to the block boundary. `padded` counts what the stream must
          // yield; `remaining` counts how much of that is still payload. Taking
          // whole blocks keeps the two in step without any special case for the
          // final partial block.
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
            if (current.metadataType) {
              // `L` carries the name as raw bytes; `x` carries pax records. A
              // global header (`g`) sets nothing for a single member here.
              if (current.metadataType === TYPE_GNU_LONGNAME) {
                nextPathOverride = body.toString("utf8").replace(/\0.*$/, "");
              } else if (current.metadataType === TYPE_PAX_NEXT) {
                nextPathOverride = paxPath(body) ?? nextPathOverride;
              }
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
          // Two zero blocks end the archive; anything after them is ignored,
          // which is what tar itself does.
          sawTerminator = true;
          continue;
        }
        if (sawTerminator) {
          // A non-zero block after the terminator is not part of this archive.
          continue;
        }

        if (!headerChecksumMatches(block)) {
          fail("archive contains a block that is not a readable tar header");
        }

        const type = String.fromCharCode(block[TYPEFLAG_OFFSET]);
        const size = readSize(block);
        // An `L`/`x` header immediately before this entry names it; the
        // header's own 100-byte field is the truncation of that name.
        const path = METADATA_TYPES.has(type)
          ? memberName(block)
          : (nextPathOverride ?? memberName(block));
        if (!METADATA_TYPES.has(type)) {
          nextPathOverride = null;
        }

        if (METADATA_TYPES.has(type)) {
          // Collected, not charged: this names the NEXT member, which carries
          // its own size. It has to be read rather than skipped — a path longer
          // than the header's 100 bytes lives here, and validating the
          // truncated header name instead would check a string that is not the
          // path being written.
          if (size > BLOCK_SIZE * 8) {
            fail("archive declares an implausibly large extended header");
          }
          current = size === 0 ? null : newMember(path, size, true, type);
          continue;
        }

        if (type === TYPE_DIRECTORY) {
          validateMemberPath(path);
          continue;
        }

        if (!TYPE_FILE.has(type)) {
          fail(`Artifact contains unsupported archive entry type "${type}"`);
        }

        validateMemberPath(path);

        declared += size;
        if (declared > maxUnpackedBytes) {
          // Refused mid-stream: the rest of the archive is never decompressed,
          // and because nothing has been written this is a refusal with nothing
          // to clean up.
          fail(
            `archive declares ${declared} bytes of members, over the ${maxUnpackedBytes}-byte ceiling`
          );
        }

        if (size === 0) {
          files.push({ path, buffer: Buffer.alloc(0) });
        } else {
          current = newMember(path, size, true);
        }
      }
    }
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (current) {
    throw new Error("archive ends in the middle of a member");
  }

  return files;
}
