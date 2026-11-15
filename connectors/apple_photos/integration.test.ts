// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
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

test("apple_photos ignores unsupported file extensions", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "IMG_0001.jpg", contents: Buffer.from("real-photo") },
		{ relPath: "readme.txt", contents: Buffer.from("not a photo") },
		{ relPath: ".DS_Store", contents: Buffer.from("mac metadata") },
	]);
	try {
		const result = await runApplePhotos(dir, ["photos"]);
		const photos = records(result.messages, "photos");
		assert.equal(photos.length, 1);
		assert.equal(photos[0]?.filename, "IMG_0001.jpg");
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos change-time cursor discovers backdated exports and replays only boundary files", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "old.jpg", contents: Buffer.from("old") },
	]);
	try {
		// Separate inode-change timestamps even on coarse filesystems.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await writeFile(join(dir, "boundary.jpg"), "boundary");
		const oldChange = (await stat(join(dir, "old.jpg"))).ctime.toISOString();
		const boundaryChange = (
			await stat(join(dir, "boundary.jpg"))
		).ctime.toISOString();
		assert.ok(oldChange < boundaryChange);
		const first = await runApplePhotos(dir, ["photos"]);
		const cursor = states(first.messages).find(
			(row) => row.stream === "photos",
		)?.cursor;
		assert.ok(cursor);
		assert.equal(
			(cursor as { changed_since: string }).changed_since,
			boundaryChange,
		);
		await writeFile(join(dir, "backdated.jpg"), "backdated");
		await utimes(
			join(dir, "backdated.jpg"),
			new Date("2000-01-01"),
			new Date("2000-01-01"),
		);
		const second = await runApplePhotos(dir, ["photos"], { photos: cursor });
		const photos = records(second.messages, "photos");
		assert.deepEqual(photos.map((row) => row.filename).sort(), [
			"backdated.jpg",
			"boundary.jpg",
		]);
		assert.equal(
			photos.find((row) => row.filename === "backdated.jpg")?.file_modified_at,
			"2000-01-01T00:00:00.000Z",
		);
		const legacy = await runApplePhotos(dir, ["photos"], {
			photos: { last_modified: "2099-01-01T00:00:00.000Z" },
		});
		assert.equal(records(legacy.messages, "photos").length, 3);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos regular-file export path is absent", async () => {
	const dir = buildExportDirFixture([
		{ relPath: "not-directory.jpg", contents: Buffer.from("fixture") },
	]);
	try {
		const result = await runApplePhotos(join(dir, "not-directory.jpg"), [
			"photos",
		]);
		assert.equal(skips(result.messages)[0]?.reason, "export_not_found");
		assert.equal(records(result.messages, "photos").length, 0);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos skipped subdirectory preserves change cursor with count-only diagnostic", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
	const dir = buildExportDirFixture([
		{ relPath: "visible.jpg", contents: Buffer.from("visible") },
	]);
	const denied = join(dir, "private-subdirectory");
	const since = "1999-01-01T00:00:00.000Z";
	try {
		await mkdir(denied);
		await writeFile(join(denied, "hidden.jpg"), "hidden");
		await chmod(denied, 0);
		const result = await runApplePhotos(dir, ["photos"], {
			photos: { changed_since: since },
		});
		assert.equal(records(result.messages, "photos").length, 1);
		const cursor = states(result.messages).find(
			(row) => row.stream === "photos",
		)?.cursor;
		assert.equal((cursor as { changed_since: string })?.changed_since, since);
		const diagnostics = result.stderr
			.split("\n")
			.filter((line) => line.includes("walk_skipped"));
		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]!, /"count":1/);
		assert.ok(!diagnostics[0]!.includes(dir));
		assert.ok(!diagnostics[0]!.includes("private-subdirectory"));
	} finally {
		await chmod(denied, 0o700);
		await rm(dir, { force: true, recursive: true });
	}
});

test("apple_photos discovers old descendants of an album renamed into the export", async () => {
	const root = buildEmptyExportDirFixture();
	const exportDir = join(root, "export");
	const stagedAlbum = join(root, "staging", "album");
	const photo = join(stagedAlbum, "nested", "photo.jpg");
	try {
		await mkdir(exportDir);
		await mkdir(join(stagedAlbum, "nested"), { recursive: true });
		await writeFile(photo, "staged-old-photo");
		const oldChange = (await stat(photo)).ctime.toISOString();
		const nestedChange = (
			await stat(join(stagedAlbum, "nested"))
		).ctime.toISOString();
		// Ensure a strict older-than relation, including coarse timestamp filesystems.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await writeFile(join(exportDir, "boundary.jpg"), "newer-boundary");
		const first = await runApplePhotos(exportDir, ["photos"]);
		const cursor = states(first.messages).find(
			(row) => row.stream === "photos",
		)?.cursor;
		assert.ok(cursor);
		const watermark = (cursor as { changed_since: string }).changed_since;
		assert.equal(typeof watermark, "string");
		assert.ok(
			oldChange < watermark && nestedChange < watermark,
			"fixture must defeat file-only and immediate-parent-only filtering",
		);
		assert.deepEqual(
			records(first.messages, "photos").map((row) => row.filename),
			["boundary.jpg"],
		);

		await rename(stagedAlbum, join(exportDir, "album"));
		const movedPhoto = join(exportDir, "album", "nested", "photo.jpg");
		assert.equal((await stat(movedPhoto)).ctime.toISOString(), oldChange);
		assert.equal(
			(await stat(join(exportDir, "album", "nested"))).ctime.toISOString(),
			nestedChange,
		);
		assert.ok((await stat(movedPhoto)).ctime.toISOString() < watermark);
		assert.ok(
			(await stat(join(exportDir, "album"))).ctime.toISOString() >= watermark,
		);
		const second = await runApplePhotos(exportDir, ["photos"], {
			photos: cursor,
		});
		const photos = records(second.messages, "photos");
		assert.ok(
			photos.some((row) => row.filename === "photo.jpg"),
			"the moved ancestor, not the unchanged file or nested directory, admits the photo",
		);
		assert.equal(skips(second.messages).length, 0);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
