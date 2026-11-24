// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	buildEmptyExportDirFixture,
	buildExportDirFixture,
} from "./fixtures.ts";
import { photosSchema } from "./schemas.ts";
import { walkDir } from "./walk.ts";

const ENTRYPOINT = connectorEntrypoint("apple_photos");

function records(
	messages: readonly EmittedMessage[],
	stream: string,
): Record<string, unknown>[] {
	return messages
		.filter(
			(m): m is Extract<EmittedMessage, { type: "RECORD" }> =>
				m.type === "RECORD",
		)
		.filter((m) => m.stream === stream)
		.map((m) => m.data);
}

function skips(
	messages: readonly EmittedMessage[],
): Extract<EmittedMessage, { type: "SKIP_RESULT" }>[] {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
}

function states(
	messages: readonly EmittedMessage[],
): Extract<EmittedMessage, { type: "STATE" }>[] {
	return messages.filter(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE",
	);
}

function progressMessages(
	messages: readonly EmittedMessage[],
	stream: string,
): string[] {
	return messages
		.filter(
			(m): m is Extract<EmittedMessage, { type: "PROGRESS" }> =>
				m.type === "PROGRESS" && m.stream === stream,
		)
		.map((m) => m.message);
}

function runApplePhotos(
	exportDir: string,
	streams: string[],
	state: Record<string, unknown> = {},
) {
	return runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			APPLE_PHOTOS_EXPORT_DIR: exportDir,
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
		},
		start: {
			scope: { streams: streams.map((name) => ({ name })) },
			state,
			type: "START",
		},
	});
}

test("apple_photos walker skips a vanished supported photo and keeps the remaining photo", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "vanished.jpg", contents: Buffer.from("fictional") },
		{ relPath: "later.jpg", contents: Buffer.from("fixture") },
	]);
	try {
		const missing = Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
		const remaining = { mtime: new Date("2024-06-05T13:45:22.000Z"), size: 7 };
		const seen: string[] = [];
		const paths: string[] = [];
		const unsupported = new Map<string, number>();
		for await (const file of walkDir(dir, unsupported, undefined, async (path) => {
			seen.push(path);
			if (path === join(dir, "vanished.jpg")) throw missing;
			return remaining;
		})) {
			paths.push(file.path);
		}
		assert.deepEqual(seen.sort(), [join(dir, "later.jpg"), join(dir, "vanished.jpg")]);
		assert.deepEqual(paths, [join(dir, "later.jpg")]);
		assert.equal(unsupported.size, 0);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos walker does not count vanished unsupported files after a cursor", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "vanished.txt", contents: Buffer.from("fictional") },
		{ relPath: "later.jpg", contents: Buffer.from("fixture") },
	]);
	try {
		const missing = Object.assign(new Error("synthetic missing file"), { code: "ENOENT" });
		const remaining = { mtime: new Date("2024-06-05T13:45:22.000Z"), size: 7 };
		const seen: string[] = [];
		const paths: string[] = [];
		const unsupported = new Map<string, number>();
		for await (const file of walkDir(dir, unsupported, "2024-06-01T00:00:00.000Z", async (path) => {
			seen.push(path);
			if (path === join(dir, "vanished.txt")) throw missing;
			return remaining;
		})) {
			paths.push(file.path);
		}
		assert.deepEqual(seen.sort(), [join(dir, "later.jpg"), join(dir, "vanished.txt")]);
		assert.deepEqual(paths, [join(dir, "later.jpg")]);
		assert.equal(unsupported.size, 0);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos walker skips a folder that vanishes before it opens and keeps its siblings", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "gone/inside.jpg", contents: Buffer.from("fictional") },
		{ relPath: "later.jpg", contents: Buffer.from("fixture") },
	]);
	try {
		const missing = Object.assign(new Error("synthetic missing folder"), { code: "ENOENT" });
		const remaining = { mtime: new Date("2024-06-05T13:45:22.000Z"), size: 7 };
		const opened: string[] = [];
		const paths: string[] = [];
		const open = async (path: string) => {
			opened.push(path);
			if (path === join(dir, "gone")) throw missing;
			return opendir(path);
		};
		for await (const file of walkDir(dir, new Map(), undefined, async () => remaining, open)) {
			paths.push(file.path);
		}
		assert.deepEqual(opened.sort(), [dir, join(dir, "gone")].sort());
		assert.deepEqual(paths, [join(dir, "later.jpg")]);
		// The root still fails closed, and so does any other folder error.
		await assert.rejects(
			walkDir(dir, new Map(), undefined, async () => remaining, async () => { throw missing; }).next(),
			(error: unknown) => error === missing,
		);
		const denied = Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
		await assert.rejects(
			(async () => {
				const failing = async (path: string) => {
					if (path === join(dir, "gone")) throw denied;
					return opendir(path);
				};
				for await (const _ of walkDir(dir, new Map(), undefined, async () => remaining, failing)) {
					// drain
				}
			})(),
			(error: unknown) => error === denied,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos walker rethrows a supported-file permission failure", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "blocked.jpg", contents: Buffer.from("fictional") },
	]);
	try {
		const denied = Object.assign(new Error("synthetic permission failure"), { code: "EACCES" });
		const unsupported = new Map<string, number>();
		const files = walkDir(dir, unsupported, undefined, async () => { throw denied; });
		await assert.rejects(files.next(), (error: unknown) => error === denied);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos SKIP_RESULTs export_not_found when the export dir does not exist", async () => {
	const nonexistentDir = join(
		process.cwd(),
		"does-not-exist-apple-photos-export",
	);
	const result = await runApplePhotos(nonexistentDir, ["photos"]);
	const skip = skips(result.messages).find((s) => s.stream === "photos");
	assert.ok(skip, "expected a photos SKIP_RESULT");
	assert.equal(skip?.reason, "export_not_found");
	assert.match(skip?.message ?? "", /Export photos from Photos\.app/);
	assert.match(
		progressMessages(result.messages, "photos").join("\n"),
		/^No photo export folder found$/,
	);
	assert.match(
		result.stderr,
		/\[apple_photos-diagnostic\] coverage \{"files_scanned":0,"reason":"export_dir_missing","status":"missing","stream":"photos"\}/,
	);
	assert.equal(records(result.messages, "photos").length, 0);
});

test("apple_photos SKIP_RESULTs export_not_found when the export dir exists but is empty", async () => {
	const dir = buildEmptyExportDirFixture();
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		const skip = skips(result.messages).find((s) => s.stream === "photos");
		assert.ok(skip, "expected a photos SKIP_RESULT for an empty export dir");
		assert.equal(skip?.reason, "export_not_found");
		assert.match(
			progressMessages(result.messages, "photos").join("\n"),
			/^Photo export folder is empty$/,
		);
		assert.match(
			result.stderr,
			/\[apple_photos-diagnostic\] coverage \{"files_scanned":0,"reason":"export_dir_empty","status":"missing","stream":"photos"\}/,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos extracts filename/size/hash/mtime/content_type for fixture files", async () => {
	const mtime = new Date("2024-06-05T13:45:22.000Z");
	const dir = buildExportDirFixture([
		{
			relPath: "IMG_0001.jpg",
			contents: Buffer.from("fake-jpeg-content"),
			mtime,
		},
		{
			relPath: "subalbum/clip.mov",
			contents: Buffer.from("fake-mov-content"),
			mtime,
		},
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		const photos = records(result.messages, "photos");
		assert.equal(photos.length, 2);
		assert.match(
			progressMessages(result.messages, "photos").join("\n"),
			/Found 2 photos in your export/,
		);
		assert.match(
			result.stderr,
			/\[apple_photos-diagnostic\] coverage \{"files_scanned":2,"reason":"collected","status":"collected","stream":"photos"\}/,
		);
		assert.match(
			result.stderr,
			/\[apple_photos-diagnostic\] emit_scan \{"files_scanned":2,"final":true,"pass":"emit","phase":"emit"\}/,
		);
		assert.match(result.stderr, /\[apple_photos-diagnostic\] emit_start/);
		assertUserFacingProgress(result.messages);

		const jpg = photos.find((p) => p.filename === "IMG_0001.jpg");
		assert.ok(jpg, "expected the jpg record");
		assert.equal(jpg?.content_type, "image/jpeg");
		assert.equal(jpg?.size_bytes, Buffer.from("fake-jpeg-content").byteLength);
		assert.match(String(jpg?.content_sha256), /^[0-9a-f]{64}$/);
		assert.equal(jpg?.file_modified_at, mtime.toISOString());
		assert.equal(jpg?.taken_at, null);

		const mov = photos.find((p) => p.filename === "clip.mov");
		assert.ok(mov, "expected the mov record from the nested subdirectory");
		assert.equal(mov?.content_type, "video/quicktime");

		// Every emitted record validates against the schema.
		for (const p of photos) {
			const parsed = photosSchema.safeParse(p);
			assert.ok(
				parsed.success,
				parsed.success ? "" : JSON.stringify(parsed.error.issues),
			);
		}
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos collects all four additional media extensions", async () => {
	const samples = [
		["sample.webp", "image/webp"],
		["sample.webm", "video/webm"],
		["sample.avi", "video/x-msvideo"],
		["sample.mkv", "video/x-matroska"],
	] as const;
	const dir = buildExportDirFixture(
		samples.map(([relPath]) => ({
			relPath,
			contents: Buffer.from(relPath),
		})),
	);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		const actual = records(result.messages, "photos").map((record) => [
			record.filename,
			record.content_type,
		]);
		assert.deepEqual(actual.sort(), [...samples].sort());
		assert.equal(skips(result.messages).length, 0);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos reports grouped unsupported extensions and partial coverage", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "sample.jpg", contents: Buffer.from("invented image") },
		{ relPath: "nested/sample.DNG", contents: Buffer.from("") },
		{ relPath: "other.dng", contents: Buffer.from("") },
		{ relPath: "another.xyz", contents: Buffer.from("") },
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		assert.equal(records(result.messages, "photos").length, 1);
		const omitted = skips(result.messages);
		assert.equal(omitted.length, 1);
		assert.equal(omitted[0]?.reason, "source_incomplete");
		assert.equal(
			omitted[0]?.message,
			"Skipped 3 files with unsupported extensions: .dng 2, .xyz 1",
		);
		assert.ok(
			progressMessages(result.messages, "photos").includes(
				"Found 1 photo in your export, 3 skipped (unsupported extensions)",
			),
		);
		assert.match(
			result.stderr,
			/coverage \{"files_scanned":4,"reason":"unsupported_extensions","status":"partial","stream":"photos"\}/,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos does not repeat an unsupported skip at or before its returned cursor", async () => {
	const older = new Date("2024-06-01T00:00:00.000Z");
	const cursorTime = new Date("2024-06-10T00:00:00.000Z");
	const dir = buildExportDirFixture([
		{ relPath: "old.dng", contents: Buffer.from(""), mtime: older },
		{ relPath: "same-time.xyz", contents: Buffer.from(""), mtime: cursorTime },
		{
			relPath: "checkpoint.jpg",
			contents: Buffer.from("invented image"),
			mtime: cursorTime,
		},
	]);
	try {
		const first = await runApplePhotos(dir, ["photos"]);
		assert.equal(
			skips(first.messages)[0]?.message,
			"Skipped 2 files with unsupported extensions: .dng 1, .xyz 1",
		);
		const checkpoint = states(first.messages).find(
			(s) => s.stream === "photos",
		);
		assert.ok(checkpoint);
		assert.deepEqual(checkpoint.cursor, {
			last_modified: cursorTime.toISOString(),
		});
		const second = await runApplePhotos(dir, ["photos"], {
			photos: checkpoint.cursor,
		});
		assert.equal(records(second.messages, "photos").length, 0);
		assert.deepEqual(skips(second.messages), []);
		assert.match(
			second.stderr,
			/coverage \{"files_scanned":1,"reason":"collected","status":"collected","stream":"photos"\}/,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos treats a .DS_Store-only export as having no unsupported files", async () => {
	const dir = buildExportDirFixture([
		{ relPath: ".DS_Store", contents: Buffer.from("") },
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		assert.equal(records(result.messages, "photos").length, 0);
		assert.deepEqual(skips(result.messages), []);
		assert.match(
			result.stderr,
			/coverage \{"files_scanned":0,"reason":"collected","status":"collected","stream":"photos"\}/,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos skips macOS metadata directories and does not count what is inside them", async () => {
	const dir = buildExportDirFixture([
		{ relPath: ".Spotlight-V100/Store-V2/index.db", contents: Buffer.from("x") },
		{ relPath: ".fseventsd/0000000000000001", contents: Buffer.from("x") },
		{ relPath: ".Trashes/501/removed.jpg", contents: Buffer.from("x") },
		{ relPath: ".AppleDouble/._IMG_0001.jpg", contents: Buffer.from("x") },
		{ relPath: ".TemporaryItems/folders.501/tmp.bin", contents: Buffer.from("x") },
		{ relPath: ".DocumentRevisions-V100/db.sqlite", contents: Buffer.from("x") },
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		assert.equal(records(result.messages, "photos").length, 0);
		assert.deepEqual(skips(result.messages), []);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos groups ordinary extensionless and unusual files without exposing their names", async () => {
	const dir = buildExportDirFixture([
		{ relPath: ".Spotlight-V100", contents: Buffer.from("") },
		{ relPath: ".fseventsd", contents: Buffer.from("") },
		{ relPath: ".Trashes", contents: Buffer.from("") },
		{ relPath: "notes", contents: Buffer.from("") },
		{
			relPath: "nested/object.synthetic-long-suffix",
			contents: Buffer.from(""),
		},
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		assert.equal(records(result.messages, "photos").length, 0);
		assert.deepEqual(
			skips(result.messages).map(({ reason, message }) => ({
				reason,
				message,
			})),
			[
				{
					reason: "source_incomplete",
					message:
						"Skipped 2 files with unsupported extensions: (no extension) 1, (other extension) 1",
				},
			],
		);
		assert.ok(
			progressMessages(result.messages, "photos").includes(
				"Found 0 photos in your export, 2 skipped (unsupported extensions)",
			),
		);
		assert.match(
			result.stderr,
			/coverage \{"files_scanned":2,"reason":"unsupported_extensions","status":"partial","stream":"photos"\}/,
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos cursor carries forward: a second run with prior STATE only emits newer files", async () => {
	const older = new Date("2024-06-01T00:00:00.000Z");
	const newer = new Date("2024-06-10T00:00:00.000Z");
	const dir = buildExportDirFixture([
		{ relPath: "old.jpg", contents: Buffer.from("old"), mtime: older },
		{ relPath: "new.jpg", contents: Buffer.from("new"), mtime: newer },
	]);
	try {
		const first = await runApplePhotos(dir, ["photos"]);
		const firstPhotos = records(first.messages, "photos");
		assert.equal(firstPhotos.length, 2);
		const firstState = states(first.messages).find(
			(s) => s.stream === "photos",
		);
		assert.ok(firstState, "expected a photos STATE checkpoint");
		assert.equal(
			(firstState.cursor as { last_modified: string }).last_modified,
			newer.toISOString(),
		);

		// Second run seeded with a cursor between old and new mtimes should
		// only re-emit the newer file.
		const second = await runApplePhotos(dir, ["photos"], {
			photos: { last_modified: older.toISOString() },
		});
		const secondPhotos = records(second.messages, "photos");
		assert.equal(secondPhotos.length, 1);
		assert.equal(secondPhotos[0]?.filename, "new.jpg");
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});
