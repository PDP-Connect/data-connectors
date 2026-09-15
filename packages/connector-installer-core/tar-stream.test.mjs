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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const TAR_READER_PATH = new URL("./tar-stream.mjs", import.meta.url);

async function loadTarReader() {
  const revision = process.env.TAR_STREAM_SOURCE_REVISION;
  const disablePaxOverrides = process.env.TAR_STREAM_DISABLE_PAX_OVERRIDES === "1";
  if (!revision && !disablePaxOverrides) return import(TAR_READER_PATH);

  let source = revision
    ? execFileSync("git", ["show", `${revision}:packages/connector-installer-core/tar-stream.mjs`], {
        encoding: "utf8",
      })
    : readFileSync(TAR_READER_PATH, "utf8");
  if (disablePaxOverrides) {
    const original = source;
    source = source.replace(
      "const effective = effectiveMemberMetadata(globalPax, nextPax, rawSize);",
      "const effective = { path: null, size: rawSize }; // mutation: ignore PAX overrides"
    );
    assert.notEqual(source, original, "the PAX override mutation matched production source");
  }
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { readTarGzEntries } = await loadTarReader();

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "tar-stream-test-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDiskTempDir(run) {
  const base = join(homedir(), ".tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "tar-stream-test-"));
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
function tarHeaderBlock(path, size, type = "0") {
  const block = Buffer.alloc(512, 0);
  block.write(path, 0, "utf8");
  block.write("000644 \0", 100, "ascii");
  block.write("000000 \0", 108, "ascii");
  block.write("000000 \0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")} `, 124, "ascii");
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")} `, 136, "ascii");
  block.write(type, 156, "ascii");
  block.write("ustar\0" + "00", 257, "ascii");
  repairTarChecksum(block);
  return block;
}

function repairTarChecksum(block) {
  block.write("        ", 148, "ascii");
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += block[i];
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
}

function padToBlock(buffer) {
  const paddedSize = Math.ceil(buffer.length / 512) * 512;
  return paddedSize === buffer.length
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(paddedSize - buffer.length)]);
}

function paxRecord(key, value) {
  const suffix = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(suffix) + 1;
  while (true) {
    const record = Buffer.from(`${length}${suffix}`, "utf8");
    if (record.length === length) return record;
    length = record.length;
  }
}

function paxHeader(type, records) {
  const body = Buffer.concat(records.map(([key, value]) => paxRecord(key, value)));
  return Buffer.concat([tarHeaderBlock(`PaxHeaders/${type}`, body.length, type), padToBlock(body)]);
}

function buildPaxFixture(dir, name, parts) {
  const out = join(dir, `${name}.tar.gz`);
  writeFileSync(out, gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)])));
  return { path: out, buffer: readFileSync(out) };
}

const INDEPENDENT_TAR_TABLE_SCRIPT = String.raw`
import hashlib, json, sys, tarfile
rows = []
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        if member.isfile():
            body = archive.extractfile(member).read()
            rows.append({"name": member.name, "sha256": hashlib.sha256(body).hexdigest()})
print(json.dumps(rows, ensure_ascii=False))
`;

function independentTarTable(archivePath) {
  return JSON.parse(
    execFileSync("python3", ["-c", INDEPENDENT_TAR_TABLE_SCRIPT, archivePath], {
      encoding: "utf8",
    })
  );
}

function independentTarOutcome(archivePath) {
  const result = spawnSync("python3", ["-c", INDEPENDENT_TAR_TABLE_SCRIPT, archivePath], {
    encoding: "utf8",
  });
  if (result.status === 0) return { accepted: true, entries: JSON.parse(result.stdout) };
  return {
    accepted: false,
    error: result.stderr.trim().split("\n").at(-1) ?? `python exited ${result.status}`,
  };
}

function readerTarTable(entries) {
  return entries.map(({ path, buffer }) => ({
    name: path,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  }));
}

function assertMatchesIndependent(dir, label, archive, entries) {
  const archivePath = join(dir, `${label}.tar.gz`);
  writeFileSync(archivePath, archive);
  const expected = independentTarTable(archivePath);
  assert.deepEqual(readerTarTable(entries), expected);
  process.stdout.write(`${JSON.stringify({ fixture: label, independentEntries: expected })}\n`);
}

function semanticPaxFixtures(dir) {
  const sizePayload = Buffer.alloc(513, "S");
  const followingPayload = Buffer.from("after-size-boundary");
  const newlinePayload = Buffer.from("newline path bytes");
  const globalPayload = Buffer.from("global path bytes");
  const precedencePayload = Buffer.from("precedence bytes");
  return [
    {
      label: "size-override",
      ...buildPaxFixture(dir, "size-override", [
        paxHeader("x", [["size", "513"]]),
        tarHeaderBlock("raw-size.bin", 3),
        padToBlock(sizePayload),
        tarHeaderBlock("following.bin", followingPayload.length),
        padToBlock(followingPayload),
      ]),
    },
    {
      label: "newline-path",
      ...buildPaxFixture(dir, "newline-path", [
        paxHeader("x", [["path", "code/☃a\nb.mjs"]]),
        tarHeaderBlock("placeholder", newlinePayload.length),
        padToBlock(newlinePayload),
      ]),
    },
    {
      label: "global-path-local-reset",
      ...buildPaxFixture(dir, "global-path-local-reset", [
        paxHeader("g", [["path", "code/global-name.mjs"]]),
        paxHeader("x", [["path", "code/local-name.mjs"]]),
        tarHeaderBlock("first-placeholder", globalPayload.length),
        padToBlock(globalPayload),
        tarHeaderBlock("second-placeholder", followingPayload.length),
        padToBlock(followingPayload),
      ]),
    },
    {
      label: "global-size-persists",
      ...buildPaxFixture(dir, "global-size-persists", [
        paxHeader("g", [["size", "4"]]),
        tarHeaderBlock("first.bin", 3),
        padToBlock(Buffer.from("ABCD")),
        tarHeaderBlock("second.bin", 3),
        padToBlock(Buffer.from("EFGH")),
      ]),
    },
    {
      label: "global-path",
      ...buildPaxFixture(dir, "global-path", [
        paxHeader("g", [["path", "code/global-name.mjs"]]),
        tarHeaderBlock("placeholder", globalPayload.length),
        padToBlock(globalPayload),
      ]),
    },
    {
      label: "later-and-local-precedence",
      ...buildPaxFixture(dir, "precedence", [
        paxHeader("g", [["path", "code/global.mjs"]]),
        paxHeader("x", [
          ["path", "code/first-local.mjs"],
          ["path", "code/final-local.mjs"],
        ]),
        tarHeaderBlock("placeholder", precedencePayload.length),
        padToBlock(precedencePayload),
      ]),
    },
    {
      label: "informational-keys",
      ...buildPaxFixture(dir, "informational-keys", [
        paxHeader("x", [
          ["mtime", "1.25"],
          ["atime", "2.5"],
          ["ctime", "3.75"],
          ["uid", "123"],
          ["gid", "456"],
          ["uname", "builder"],
          ["gname", "builders"],
          ["comment", "independent reader cross-check"],
        ]),
        tarHeaderBlock("informational.bin", precedencePayload.length),
        padToBlock(precedencePayload),
      ]),
    },
    {
      label: "leading-bom-path",
      ...buildPaxFixture(dir, "leading-bom-path", [
        paxHeader("x", [["path", "\uFEFFcode/bom-name.mjs"]]),
        tarHeaderBlock("placeholder", precedencePayload.length),
        padToBlock(precedencePayload),
      ]),
    },
  ];
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
    assertMatchesIndependent(dir, "named-owner", buffer, entries);
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
    for (const [archiveLabel, buffer] of [["named", named], ["numeric", numeric]]) {
      const entries = await readTarGzEntries(buffer, { maxUnpackedBytes: 8192 });
      assert.equal(entries.find((e) => e.path.endsWith("m.bin")).buffer.length, 4096);
      assertMatchesIndependent(dir, `owner-${archiveLabel}`, buffer, entries);
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
    assertMatchesIndependent(dir, "member-bytes", readFileSync(out), entries);
  });
});

for (const label of [
  "size-override",
  "newline-path",
  "global-path",
  "global-path-local-reset",
  "global-size-persists",
  "later-and-local-precedence",
  "informational-keys",
  "leading-bom-path",
]) {
  test(`PAX fixture: ${label} matches Python tarfile names and sha256`, async () => {
    await withTempDir(async (dir) => {
      const fixture = semanticPaxFixtures(dir).find((candidate) => candidate.label === label);
      const expected = independentTarTable(fixture.path);
      const entries = await readTarGzEntries(fixture.buffer, { maxUnpackedBytes: 1 << 20 });
      const actual = readerTarTable(entries);
      assert.deepEqual(actual, expected);
      process.stdout.write(`${JSON.stringify({ fixture: label, entries: actual })}\n`);
    });
  });
}

test("malformed and unsupported semantic PAX records are refused", async () => {
  await withTempDir(async (dir) => {
    const payload = Buffer.from("x");
    const malformedBody = Buffer.from("99 path=truncated\n");
    const invalidUtf8Body = paxRecord("path", "x");
    invalidUtf8Body[invalidUtf8Body.indexOf("x")] = 0xff;
    const cases = [
      {
        name: "malformed",
        expected: /malformed PAX record/,
        parts: [
          tarHeaderBlock("PaxHeaders/x", malformedBody.length, "x"),
          padToBlock(malformedBody),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
      {
        name: "linkpath",
        expected: /unsupported PAX linkpath/,
        parts: [
          paxHeader("x", [["linkpath", "elsewhere"]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
      {
        name: "sparse-map",
        expected: /unsupported PAX key "GNU\.sparse\.map"/,
        parts: [
          paxHeader("x", [["GNU.sparse.map", "0,1"]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
      ...["SCHILY.filetype", "LIBARCHIVE.xattr.user.key"].map((key) => ({
        name: key,
        expected: new RegExp(`unsupported PAX key "${key.replaceAll(".", "\\.")}"`),
        parts: [
          paxHeader("x", [[key, "semantic-value"]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      })),
      ...["path", "size"].map((key) => ({
        name: `empty-${key}`,
        expected: new RegExp(`unsupported empty PAX ${key}`),
        parts: [
          paxHeader("x", [[key, ""]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      })),
      {
        name: "empty-linkpath",
        expected: /unsupported PAX linkpath/,
        parts: [
          paxHeader("x", [["linkpath", ""]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
      {
        name: "invalid-utf8",
        expected: /malformed PAX record/,
        parts: [
          tarHeaderBlock("PaxHeaders/x", invalidUtf8Body.length, "x"),
          padToBlock(invalidUtf8Body),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
      {
        name: "nul-path",
        expected: /PAX path containing a NUL byte/,
        parts: [
          paxHeader("x", [["path", "code/\0name"]]),
          tarHeaderBlock("placeholder", payload.length),
          padToBlock(payload),
        ],
      },
    ];

    for (const fixtureCase of cases) {
      const fixture = buildPaxFixture(dir, fixtureCase.name, fixtureCase.parts);
      await assert.rejects(
        () => readTarGzEntries(fixture.buffer, { maxUnpackedBytes: 1 << 20 }),
        fixtureCase.expected,
        fixtureCase.name
      );
      process.stdout.write(
        `${JSON.stringify({
          fixture: fixtureCase.name,
          independentReader: independentTarOutcome(fixture.path),
          installer: "refused",
        })}\n`
      );
    }
  });
});

test("invalid UTF-8 in ustar and GNU long names is refused", async () => {
  await withTempDir(async (dir) => {
    const invalidHeader = tarHeaderBlock("placeholder", 0);
    invalidHeader[0] = 0xff;
    repairTarChecksum(invalidHeader);
    const invalidLongName = Buffer.from([0xff, 0]);
    const cases = [
      {
        name: "invalid-ustar-name",
        expected: /member name that is not valid UTF-8/,
        parts: [invalidHeader],
      },
      {
        name: "invalid-gnu-long-name",
        expected: /GNU long name that is not valid UTF-8/,
        parts: [
          tarHeaderBlock("././@LongLink", invalidLongName.length, "L"),
          padToBlock(invalidLongName),
          tarHeaderBlock("placeholder", 0),
        ],
      },
    ];

    for (const fixtureCase of cases) {
      const fixture = buildPaxFixture(dir, fixtureCase.name, fixtureCase.parts);
      await assert.rejects(
        () => readTarGzEntries(fixture.buffer, { maxUnpackedBytes: 4096 }),
        fixtureCase.expected
      );
      process.stdout.write(
        `${JSON.stringify({
          fixture: fixtureCase.name,
          independentReader: independentTarOutcome(fixture.path),
          installer: "refused",
        })}\n`
      );
    }
  });
});

test("consecutive per-entry metadata headers are refused", async () => {
  await withTempDir(async (dir) => {
    for (const [label, secondType] of [["x-to-x", "x"], ["x-to-g", "g"]]) {
      const fixture = buildPaxFixture(dir, label, [
        paxHeader("x", [["path", "first.mjs"]]),
        paxHeader(secondType, [["path", "second.mjs"]]),
        tarHeaderBlock("placeholder", 0),
      ]);
      await assert.rejects(
        () => readTarGzEntries(fixture.buffer, { maxUnpackedBytes: 4096 }),
        /consecutive per-entry metadata headers/
      );
      process.stdout.write(
        `${JSON.stringify({
          fixture: label,
          independentReader: independentTarOutcome(fixture.path),
          installer: "refused",
        })}\n`
      );
    }
  });
});

test(
  "PAX mutation control turns the semantic fixture tests red",
  { skip: process.env.TAR_STREAM_DISABLE_PAX_OVERRIDES === "1" },
  () => {
    const childEnv = { ...process.env, TAR_STREAM_DISABLE_PAX_OVERRIDES: "1" };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(
      process.execPath,
      ["--test", "--test-name-pattern=PAX fixture:", fileURLToPath(import.meta.url)],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: childEnv,
      }
    );
    assert.notEqual(child.status, 0, "disabled PAX overrides must fail the semantic fixtures");
    assert.match(`${child.stdout}\n${child.stderr}`, /AssertionError|Expected values to be strictly deep-equal/);
  }
);

test("20,000 empty members are refused by the entry ceiling", async () => {
  await withDiskTempDir(async (dir) => {
    const out = join(dir, "many-empty.tar.gz");
    const script = String.raw`
import sys, tarfile
with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as archive:
    for index in range(20_000):
        entry = tarfile.TarInfo(f"empty-{index:05d}")
        entry.size = 0
        archive.addfile(entry)
`;
    execFileSync("python3", ["-c", script, out]);
    await assert.rejects(
      () =>
        readTarGzEntries(readFileSync(out), {
          maxUnpackedBytes: 4096,
          maxEntries: 100,
        }),
      /archive contains more than 100 entries/
    );
  });
});

test("the reader stops before 16 MiB of compressed trailing tar padding", async () => {
  await withDiskTempDir(async (dir) => {
    const out = join(dir, "trailing-padding.tar.gz");
    const script = String.raw`
import gzip, io, sys, tarfile
with gzip.open(sys.argv[1], "wb") as compressed:
    with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        entry = tarfile.TarInfo("four.bin")
        entry.size = 4
        archive.addfile(entry, io.BytesIO(b"ABCD"))
    block = b"\0" * (1024 * 1024)
    for _ in range(16):
        compressed.write(block)
`;
    execFileSync("python3", ["-c", script, out]);
    const archive = readFileSync(out);
    const expected = independentTarTable(out);
    let observed = 0;
    const entries = await readTarGzEntries(archive, {
      maxUnpackedBytes: 4,
      maxDecompressedBytes: 32 * 1024 * 1024,
      observeDecompressedChunk: (length) => {
        observed += length;
        if (observed > 1024 * 1024) {
          throw new Error("reader consumed trailing padding past the observable bound");
        }
      },
    });
    assert.deepEqual(readerTarTable(entries), expected);
    assert.ok(observed < 16 * 1024 * 1024, `observed ${observed} decompressed bytes`);
    process.stdout.write(`${JSON.stringify({ fixture: "trailing-padding", observed })}\n`);
  });
});

test("an incomplete regular-file body is refused", async () => {
  const incomplete = gzipSync(
    Buffer.concat([tarHeaderBlock("incomplete.bin", 4), Buffer.from("ABC")])
  );
  await assert.rejects(
    () => readTarGzEntries(incomplete, { maxUnpackedBytes: 16 }),
    /archive ends in the middle of a member/
  );
});

test("the decompressed-input ceiling is enforced independently of member bytes", async () => {
  const payload = Buffer.alloc(4096, "i");
  const archive = gzipSync(
    Buffer.concat([
      tarHeaderBlock("within-member-budget.bin", payload.length),
      padToBlock(payload),
      Buffer.alloc(1024),
    ])
  );
  await assert.rejects(
    () =>
      readTarGzEntries(archive, {
        maxUnpackedBytes: 8192,
        maxDecompressedBytes: 1024,
      }),
    /decompressed input exceeds the 1024-byte ceiling/
  );
});

test("metadata headers count toward the entry ceiling", async () => {
  const metadata = Array.from({ length: 4 }, (_, index) =>
    paxHeader("g", [["comment", `metadata-${index}`]])
  );
  const archive = gzipSync(
    Buffer.concat([
      ...metadata,
      tarHeaderBlock("empty.bin", 0),
      Buffer.alloc(1024),
    ])
  );
  await assert.rejects(
    () => readTarGzEntries(archive, { maxUnpackedBytes: 4096, maxEntries: 3 }),
    /archive contains more than 3 entries/
  );
});

test("metadata without a following entry is refused", async () => {
  const archive = gzipSync(
    Buffer.concat([paxHeader("x", [["path", "dangling.bin"]]), Buffer.alloc(1024)])
  );
  await assert.rejects(
    () => readTarGzEntries(archive, { maxUnpackedBytes: 4096 }),
    /metadata that has no following entry/
  );
});

test("a gzip stream truncated before the tar end marker is refused", async () => {
  const complete = gzipSync(
    Buffer.concat([tarHeaderBlock("empty.bin", 0), Buffer.alloc(1024)])
  );
  const truncated = complete.subarray(0, Math.floor(complete.length / 2));
  await assert.rejects(
    () => readTarGzEntries(truncated, { maxUnpackedBytes: 4096 }),
    /unexpected end|invalid|unexpected end of file/i
  );
});

test("a non-zero directory size is refused", async () => {
  const archive = gzipSync(
    Buffer.concat([
      tarHeaderBlock("invalid-directory", 1, "5"),
      padToBlock(Buffer.from("x")),
      Buffer.alloc(1024),
    ])
  );
  await assert.rejects(
    () => readTarGzEntries(archive, { maxUnpackedBytes: 4096 }),
    /non-zero directory size/
  );
});

test("a partial final header block is refused", async () => {
  const archive = gzipSync(
    Buffer.concat([tarHeaderBlock("empty.bin", 0), Buffer.alloc(100, "h")])
  );
  await assert.rejects(
    () => readTarGzEntries(archive, { maxUnpackedBytes: 4096 }),
    /middle of a header block/
  );
});

test("a non-zero block after the first tar end marker is refused", async () => {
  const archive = gzipSync(
    Buffer.concat([
      tarHeaderBlock("first.bin", 0),
      Buffer.alloc(512),
      tarHeaderBlock("after-marker.bin", 0),
      Buffer.alloc(1024),
    ])
  );
  await assert.rejects(
    () => readTarGzEntries(archive, { maxUnpackedBytes: 4096 }),
    /non-zero block after its first end marker/
  );
});

test("a 200 MiB archive is refused before full decompression", async () => {
  // The old listing parser gave no observable proof that it stopped early. The
  // callback sits between gunzip and the parser, so this assertion measures the
  // decompressed bytes the reader actually consumes before refusing the header.
  // Build by streaming zeros through gzip instead of retaining a 200 MiB input.
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

  let observed = 0;
  await assert.rejects(
    () =>
      readTarGzEntries(buffer, {
        maxUnpackedBytes: 64 * 1024 * 1024,
        observeDecompressedChunk: (length) => {
          observed += length;
          if (observed > 2 * 1024 * 1024) {
            throw new Error("reader consumed the bomb past the observable bound");
          }
        },
      }),
    /over the 67108864-byte ceiling/
  );
  assert.ok(observed > 0, "the decompressed-byte observer was exercised");
  assert.ok(observed <= 2 * 1024 * 1024, `observed ${observed} decompressed bytes`);
  process.stdout.write(`${JSON.stringify({ fixture: "200-mib-refusal", observed })}\n`);
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
      assertMatchesIndependent(dir, `long-path-${format.slice(9)}`, readFileSync(out), entries);
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
          assertMatchesIndependent(dir, `${label}-${owner}`, buffer, entries);
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
