// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The archive reader, against the cases that broke the column-parsing version.
//
// The previous preflight read whitespace token 2 of `tar -tvzf` as the member
// size. GNU tar prints `perms owner/group size`; BSD tar prints
// `perms links owner group size`. So the same expression read the size under one
// tar and the OWNER under the other, and the two failures point opposite ways: a
// NAMED owner made a valid archive unreadable, a NUMERIC owner added zero and
// let an oversized archive through. Moving the token index cannot fix that —
// whichever index is chosen, one platform is wrong. These tests pin the reader
// to the archive FORMAT, which is the same bytes under every tar.
//
// `--owner`/`--group` set what the header stores, so the owner cases here are
// the real archives the two formatters would render differently; they are not a
// simulation of a listing.

import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTarGzEntries } from "./tar-stream.mjs";

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "tar-stream-test-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a real `.tar.gz` and return its bytes. */
function buildArchive(dir, files, tarArgs = [], tarBin = "tar") {
  const content = join(dir, "content");
  mkdirSync(content, { recursive: true });
  for (const [name, size] of files) {
    writeFileSync(join(content, name), Buffer.alloc(size, "a"));
  }
  const out = join(dir, "layer.tar.gz");
  execFileSync(tarBin, ["-czf", out, ...tarArgs, "-C", content, "."]);
  return readFileSync(out);
}

// Writes one gzipped tar through libarchive itself — the library bsdtar is built
// on — so the BSD-side archive in this suite is a real one rather than a
// hand-assembled imitation. Python + ctypes because libarchive is a C library
// and this repository has no binding for it; the test skips where it is absent.
const LIBARCHIVE_WRITER = `
import ctypes, sys
la = ctypes.CDLL("libarchive.so.13")
la.archive_write_new.restype = ctypes.c_void_p
la.archive_entry_new.restype = ctypes.c_void_p
out, uname, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
a = la.archive_write_new()
la.archive_write_set_format_gnutar(ctypes.c_void_p(a))
la.archive_write_add_filter_gzip(ctypes.c_void_p(a))
la.archive_write_open_filename(ctypes.c_void_p(a), out.encode())
e = la.archive_entry_new()
la.archive_entry_set_pathname(ctypes.c_void_p(e), b"./m.bin")
la.archive_entry_set_size.argtypes = [ctypes.c_void_p, ctypes.c_int64]
la.archive_entry_set_size(ctypes.c_void_p(e), size)
la.archive_entry_set_filetype.argtypes = [ctypes.c_void_p, ctypes.c_uint]
la.archive_entry_set_filetype(ctypes.c_void_p(e), 0o100000)
la.archive_entry_set_perm.argtypes = [ctypes.c_void_p, ctypes.c_uint]
la.archive_entry_set_perm(ctypes.c_void_p(e), 0o644)
la.archive_entry_set_uname(ctypes.c_void_p(e), uname.encode())
la.archive_entry_set_gname(ctypes.c_void_p(e), uname.encode())
la.archive_write_header(ctypes.c_void_p(a), ctypes.c_void_p(e))
la.archive_write_data.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_size_t]
la.archive_write_data(ctypes.c_void_p(a), b"a" * size, size)
la.archive_entry_free(ctypes.c_void_p(e))
la.archive_write_close(ctypes.c_void_p(a))
la.archive_write_free(ctypes.c_void_p(a))
`;

/** One valid ustar header block, so a bomb can be declared without being built. */
function tarHeaderBlock(path, size) {
  const block = Buffer.alloc(512, 0);
  block.write(path, 0, "utf8");
  block.write("000644 \0", 100, "ascii");
  block.write("000000 \0", 108, "ascii");
  block.write("000000 \0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")} `, 124, "ascii");
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")} `, 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write("0", 156, "ascii");
  block.write("ustar\0" + "00", 257, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += block[i];
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

function hasLibarchive() {
  try {
    execFileSync("python3", ["-c", 'import ctypes; ctypes.CDLL("libarchive.so.13")'], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function buildLibarchiveArchive(dir, owner, size) {
  const out = join(dir, `libarchive-${owner}.tar.gz`);
  execFileSync("python3", ["-c", LIBARCHIVE_WRITER, out, owner, String(size)], {
    stdio: "ignore",
  });
  return readFileSync(out);
}

test("a small archive written with a NAMED owner is read, not refused", async () => {
  // Under the old reader this is the case that broke: BSD tar renders
  // `builduser` in the column it treated as the size, so `Number("builduser")`
  // was NaN and a valid 32-byte archive was refused as unreadable.
  await withTempDir(async (dir) => {
    const buffer = buildArchive(dir, [["small.txt", 32]], [
      "--owner=builduser",
      "--group=builddept",
    ]);
    const entries = await readTarGzEntries(buffer, { maxUnpackedBytes: 64 });
    const file = entries.find((entry) => entry.path.endsWith("small.txt"));
    assert.ok(file, "the member is read");
    assert.equal(file.buffer.length, 32);
  });
});

test("an oversized archive written with a NUMERIC owner is refused", async () => {
  // The other half of the same defect: BSD tar renders owner `0`, which the old
  // reader added to the total as zero, so an archive over the ceiling passed the
  // preflight it was supposed to fail.
  await withTempDir(async (dir) => {
    const buffer = buildArchive(dir, [["small.txt", 32]], ["--owner=0", "--group=0"]);
    await assert.rejects(
      () => readTarGzEntries(buffer, { maxUnpackedBytes: 16 }),
      /declares 32 bytes of members, over the 16-byte ceiling/
    );
  });
});

test("the size read is the archive's own, whatever the owner is spelled as", async () => {
  // The property behind both cases above, stated once: two archives differing
  // ONLY in how the owner is spelled must account identically.
  await withTempDir(async (dir) => {
    const named = buildArchive(dir, [["m.bin", 4096]], ["--owner=builduser", "--group=g"]);
    const numeric = buildArchive(dir, [["m.bin", 4096]], ["--owner=0", "--group=0"]);
    for (const buffer of [named, numeric]) {
      const entries = await readTarGzEntries(buffer, { maxUnpackedBytes: 8192 });
      assert.equal(entries.find((e) => e.path.endsWith("m.bin")).buffer.length, 4096);
      await assert.rejects(
        () => readTarGzEntries(buffer, { maxUnpackedBytes: 4095 }),
        /over the 4095-byte ceiling/
      );
    }
  });
});

test("member bytes survive the read intact", async () => {
  await withTempDir(async (dir) => {
    const content = join(dir, "content");
    mkdirSync(content, { recursive: true });
    const payload = Buffer.from("collection profile bytes\n".repeat(400), "utf8");
    writeFileSync(join(content, "profile.mjs"), payload);
    writeFileSync(join(content, "empty"), Buffer.alloc(0));
    const out = join(dir, "layer.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", content, "."]);

    const entries = await readTarGzEntries(readFileSync(out), { maxUnpackedBytes: 1 << 20 });
    const file = entries.find((entry) => entry.path.endsWith("profile.mjs"));
    assert.deepEqual(file.buffer, payload);
    assert.equal(entries.find((entry) => entry.path.endsWith("empty")).buffer.length, 0);
  });
});

test("a decompression bomb is refused without decompressing it", async () => {
  // The property the old preflight could not have: `tar -tvzf` expands the whole
  // archive to produce a listing, so the 200 MB existed before the ceiling was
  // consulted. Here the ceiling is applied to a streaming read, so the refusal
  // arrives after a couple of megabytes. The heap assertion is what makes that
  // claim testable rather than asserted in a comment.
  // Built by streaming zeros through gzip rather than by writing a 200 MB file:
  // the point is that the READER never expands it, and materialising the bomb on
  // a RAM-backed /tmp just to prove that fills the disk for every other suite.
  const { createGzip } = await import("node:zlib");
  const declared = 200 * 1024 * 1024;
  const gzip = createGzip();
  const chunks = [];
  gzip.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolveDone) => gzip.on("end", resolveDone));
  gzip.write(tarHeaderBlock("./big.bin", declared));
  const zeros = Buffer.alloc(1024 * 1024, 0);
  for (let written = 0; written < declared; written += zeros.length) {
    if (!gzip.write(zeros)) await new Promise((r) => gzip.once("drain", r));
  }
  gzip.end();
  await done;
  const buffer = Buffer.concat(chunks);
  assert.ok(buffer.length < 1024 * 1024, "the compressed bomb is small");

  global.gc?.();
  const before = process.memoryUsage().heapUsed;
  await assert.rejects(
    () => readTarGzEntries(buffer, { maxUnpackedBytes: 64 * 1024 * 1024 }),
    /over the 67108864-byte ceiling/
  );
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(
    grew < 32 * 1024 * 1024,
    `the refusal must not first expand the layer (heap grew ${grew} bytes)`
  );
});

test("unsupported member types are refused from the header, not a rendered line", async () => {
  await withTempDir(async (dir) => {
    const content = join(dir, "content");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "real.txt"), "x");
    symlinkSync("real.txt", join(content, "link.txt"));
    const out = join(dir, "layer.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", content, "."]);

    await assert.rejects(
      () => readTarGzEntries(readFileSync(out), { maxUnpackedBytes: 1 << 20 }),
      /unsupported archive entry type "2"/
    );
  });
});

test("a path too long for the header is validated in full", async () => {
  // A name over 100 bytes is stored in a GNU `L` or pax `x` entry and the header
  // holds only its truncation. Reading the truncation would validate a string
  // that is not the path being written, so the metadata entry is applied.
  for (const format of ["--format=gnu", "--format=posix"]) {
    await withTempDir(async (dir) => {
      const content = join(dir, "content");
      const deep = join(content, "d".repeat(120));
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "profile.mjs"), Buffer.alloc(40, "z"));
      const out = join(dir, "layer.tar.gz");
      execFileSync("tar", ["-czf", out, format, "-C", content, "."]);

      const seen = [];
      const entries = await readTarGzEntries(readFileSync(out), {
        maxUnpackedBytes: 1 << 20,
        validateMemberPath: (path) => seen.push(path),
      });
      assert.ok(
        seen.some((path) => path.endsWith("profile.mjs")),
        `${format}: the validator sees the full path`
      );
      assert.ok(
        entries.some((entry) => entry.path.endsWith("profile.mjs") && entry.buffer.length === 40),
        `${format}: the member is returned under its full path`
      );
    });
  }
});

test("the reader refuses a member whose declared size cannot be read", async () => {
  await withTempDir(async (dir) => {
    const buffer = buildArchive(dir, [["small.txt", 16]]);
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = gunzipSync(buffer);
    // Corrupt the first member header's size field, then repair the checksum so
    // the refusal is about the size rather than the header being unreadable.
    let offset = 0;
    while (offset + 512 <= raw.length) {
      const type = String.fromCharCode(raw[offset + 156]);
      const declared = Number.parseInt(
        raw.toString("ascii", offset + 124, offset + 136).replace(/\0/g, " ").trim() || "0",
        8
      );
      if (type === "0" || type === "\0") {
        raw.write("99z99999999\0", offset + 124, "ascii");
        raw.write("        ", offset + 148, "ascii");
        let sum = 0;
        for (let i = 0; i < 512; i += 1) sum += raw[offset + i];
        raw.write(`${sum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
        break;
      }
      offset += 512 + Math.ceil(declared / 512) * 512;
    }

    await assert.rejects(
      () => readTarGzEntries(gzipSync(raw), { maxUnpackedBytes: 1 << 20 }),
      /unreadable member size/
    );
  });
});

test(
  "archives written by libarchive account identically to GNU tar's",
  { skip: hasLibarchive() ? false : "libarchive is not present on this machine" },
  async () => {
    // The portability claim, executed rather than argued. bsdtar is the binary
    // whose listing format caused the defect; libarchive is the library it is
    // built on, so writing through the library produces the archives bsdtar
    // would write. Both writers' output must read the same here, because both
    // store the size in the same header field — which is the whole point of
    // reading the format instead of a rendering of it.
    await withTempDir(async (dir) => {
      for (const owner of ["builduser", "0"]) {
        const gnu = buildArchive(dir, [["m.bin", 2048]], [
          `--owner=${owner}`,
          `--group=${owner}`,
        ]);
        const bsd = buildLibarchiveArchive(dir, owner, 2048);
        for (const [label, buffer] of [["gnu", gnu], ["libarchive", bsd]]) {
          const entries = await readTarGzEntries(buffer, { maxUnpackedBytes: 4096 });
          assert.equal(
            entries.find((entry) => entry.path.endsWith("m.bin")).buffer.length,
            2048,
            `${label}/${owner} reads the declared size`
          );
          await assert.rejects(
            () => readTarGzEntries(buffer, { maxUnpackedBytes: 2047 }),
            /over the 2047-byte ceiling/,
            `${label}/${owner} refuses over the ceiling`
          );
        }
      }
    });
  }
);

test("the column the old reader used is not the size under BSD rendering", () => {
  // Why the repair is a rewrite rather than a new token index, kept as an
  // executable statement so the reasoning cannot quietly go stale. BSD tar's
  // `list_item_verbose()` prints perms, link count, owner, group, then size;
  // GNU prints perms, owner/group, then size. Token 2 is therefore the size
  // under one and the owner under the other, and the two spellings of an owner
  // fail in OPPOSITE directions — so no single index is correct for both.
  const oldTokenTwo = (line) => Number(line.trim().split(/\s+/)[2]);

  assert.equal(oldTokenTwo("-rw-r--r-- builduser/builddept 2048 Jan  1 00:00 ./m.bin"), 2048);

  // Named owner: NaN, so a valid archive was refused as unreadable.
  assert.ok(
    Number.isNaN(oldTokenTwo("-rw-r--r--  1 builduser builddept 2048 Jan  1 00:00 ./m.bin")),
    "a named owner rendered BSD-style read as NaN"
  );
  // Numeric owner: 0, so an oversized archive was admitted by the preflight.
  assert.equal(
    oldTokenTwo("-rw-r--r--  1 0 0 2048 Jan  1 00:00 ./m.bin"),
    0,
    "a numeric owner rendered BSD-style contributed zero"
  );
});
