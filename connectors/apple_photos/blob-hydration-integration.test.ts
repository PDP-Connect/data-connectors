// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end blob hydration coverage for the `photos` stream through the
 * real connector protocol subprocess: hydrated success, oversized/too-large,
 * upload failure, and content-hash dedup across two "export copies" of the
 * same photo. Mirrors google_takeout's photos-integration.test.ts pattern —
 * both connectors share src/local-media-blob-hydration.ts, so this test
 * proves apple_photos wires the SAME hydration contract, not a reimplementation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

const ENTRYPOINT = connectorEntrypoint("apple_photos");

// Bounded fixture bytes: small deterministic buffers, never real photo data.
const TINY_JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

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

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	return new Promise((done, reject) => {
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => done(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

async function withBlobServer<T>(
	handler: (req: IncomingMessage) => Promise<{ body: unknown; status: number }>,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const server = createServer((req, res) => {
		handler(req)
			.then(({ body, status }) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			})
			.catch((err: unknown) => {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(
					JSON.stringify({
						error: err instanceof Error ? err.message : "test server error",
					}),
				);
			});
	});
	try {
		await new Promise<void>((done, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => done());
		});
		const address = server.address() as AddressInfo;
		return await fn(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((done, reject) => {
			server.close((err) => (err ? reject(err) : done()));
		});
	}
}

async function runApplePhotos(
	exportDir: string,
	env: Record<string, string> = {},
	state: Record<string, unknown> = {},
	runCoverage = false,
): Promise<{
	messages: EmittedMessage[];
	photos: Record<string, unknown>[];
	stderr: string;
}> {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			APPLE_PHOTOS_EXPORT_DIR: exportDir,
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			...env,
		},
		start: {
			...(runCoverage
				? { run_coverage_version: 1, collection_scope: "photos-test" }
				: {}),
			scope: { streams: [{ name: "photos" }] },
			state,
			type: "START",
		},
	});
	return {
		messages: result.messages,
		stderr: result.stderr,
		photos: records(result.messages, "photos"),
	};
}

test("photos stream hydrates bytes through the reference blob endpoint", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-hydrate-"));
	try {
		await writeFile(join(dir, "IMG_1111.jpg"), TINY_JPEG_A);

		await withBlobServer(
			async (req) => {
				assert.equal(req.headers.authorization, "Bearer owner-token");
				assert.equal(req.headers["content-type"], "application/octet-stream");
				const url = new URL(req.url ?? "", "http://127.0.0.1");
				assert.equal(url.searchParams.get("mime_type"), "image/jpeg");
				const body = await readRequestBody(req);
				const sha256 = createHash("sha256").update(body).digest("hex");
				return {
					body: {
						blob_id: `blob_sha256_${sha256}`,
						mime_type: url.searchParams.get("mime_type"),
						object: "blob",
						sha256,
						size_bytes: body.byteLength,
					},
					status: 200,
				};
			},
			async (baseUrl) => {
				const { photos } = await runApplePhotos(dir, {
					PDPP_OWNER_TOKEN: "owner-token",
					PDPP_RS_URL: baseUrl,
				});
				assert.equal(photos.length, 1);
				assert.equal(photos[0]?.hydration_status, "hydrated");
				assert.equal(photos[0]?.hydration_error, null);
				assert.deepEqual(photos[0]?.blob_ref, {
					blob_id: `blob_sha256_${photos[0]?.content_sha256}`,
					mime_type: "image/jpeg",
					sha256: photos[0]?.content_sha256,
					size_bytes: TINY_JPEG_A.byteLength,
				});
			},
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("photos stream marks hydration failed (not fabricated deletion) when blob upload fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-hydrate-fail-"));
	try {
		await writeFile(join(dir, "IMG_2222.jpg"), TINY_JPEG_A);

		await withBlobServer(
			async () => ({
				body: { error: "synthetic upload failure" },
				status: 500,
			}),
			async (baseUrl) => {
				const { photos } = await runApplePhotos(dir, {
					PDPP_OWNER_TOKEN: "owner-token",
					PDPP_RS_URL: baseUrl,
				});
				assert.equal(
					photos.length,
					1,
					"the record is still emitted even though hydration failed",
				);
				assert.equal(photos[0]?.hydration_status, "failed");
				assert.deepEqual(photos[0]?.blob_ref, null);
				assert.match(String(photos[0]?.hydration_error), /500/);
				assert.doesNotMatch(String(photos[0]?.hydration_error), /IMG_2222/);
			},
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("photos stream skips oversized files without dropping the record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-oversized-"));
	try {
		await writeFile(join(dir, "big.jpg"), TINY_JPEG_A);

		const { photos, messages } = await runApplePhotos(dir, {
			PDPP_APPLE_PHOTOS_MAX_PHOTO_BYTES: "1",
		});

		assert.equal(photos.length, 1);
		assert.equal(photos[0]?.hydration_status, "skipped_too_large");
		assert.equal(photos[0]?.blob_ref, null);
		assert.equal(photos[0]?.content_sha256, null);
		assert.equal(
			photoCursor(messages).last_modified,
			photos[0]?.file_modified_at,
			"intentionally oversized photos retain their cursor policy",
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

test("photos stream dedupes identical-content files discovered under different names/subdirectories to one record", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-dedup-"));
	try {
		// Simulates the same photo present in two different Photos.app album
		// exports — same bytes, different filename and directory.
		await mkdir(join(dir, "album-1"), { recursive: true });
		await mkdir(join(dir, "album-2-copy"), { recursive: true });
		await writeFile(join(dir, "album-1", "IMG_3333.jpg"), TINY_JPEG_A);
		await writeFile(
			join(dir, "album-2-copy", "IMG_3333_copy.jpg"),
			TINY_JPEG_A,
		);

		const { photos } = await runApplePhotos(dir);

		// Both files were discovered and hydrated, but since content_sha256 is
		// identical, buildPhotoRecord derives the same `id` for both — the
		// record itself (a mutable_state stream keyed by id) collapses to one
		// logical photo rather than two duplicate entries.
		const ids = new Set(photos.map((p) => p.id));
		assert.equal(
			photos.length,
			2,
			"both files are discovered/hydrated independently",
		);
		assert.equal(
			ids.size,
			1,
			"identical content collapses to a single record id (dedup by content hash)",
		);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
});

function photoCursor(
	messages: readonly EmittedMessage[],
): Record<string, unknown> {
	const checkpoint = messages.find(
		(m) => m.type === "STATE" && m.stream === "photos",
	);
	assert.ok(checkpoint?.type === "STATE", "expected a photos STATE checkpoint");
	return checkpoint.cursor as Record<string, unknown>;
}

function assertPhotoDone(
	messages: readonly EmittedMessage[],
	runCoverage: boolean,
	status: "partial" | "collected",
): void {
	const done = messages.find((m) => m.type === "DONE");
	assert.deepEqual(done, {
		type: "DONE",
		status: "succeeded",
		records_emitted: 2,
		...(runCoverage
			? {
					coverage: {
						version: 1,
						collection_scope: "photos-test",
						streams: [{
							stream: "photos",
							scoped: false,
							stores: [{ store: "export_dir", status }],
						}],
					},
				}
			: {}),
	});
}

for (const [failure, runCoverage] of [
	["read", false],
	["read", true],
	["upload", false],
	["upload", true],
] as const) {
	test(
		`photos retries older ${failure} failure from STATE (${runCoverage ? "coverage v1" : "legacy DONE"})`,
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pdpp-apple-photos-resume-"));
			const dir = join(root, "export");
			const oldPath = join(dir, "older.jpg");
			const newerPath = join(dir, "newer.jpg");
			const older = new Date("2024-06-01T00:00:00.000Z");
			const newer = new Date("2024-06-10T00:00:00.000Z");
			const prior = failure === "read" ? "2024-05-01T00:00:00.000Z" : undefined;
			const oldBytes = Buffer.concat([TINY_JPEG_A, Buffer.from("older")]);
			const newBytes = Buffer.concat([TINY_JPEG_A, Buffer.from("newer")]);
			const preload = join(root, "make-unreadable.mjs");
			try {
				await mkdir(dir);
				await writeFile(oldPath, oldBytes);
				await writeFile(newerPath, newBytes);
				await utimes(oldPath, older, older);
				await utimes(newerPath, newer, newer);
				// Remove the discovered file immediately after its metadata is read.
				// This causes a real ENOENT during hydration even when running as root,
				// without mocking hydration results or depending on chmod behavior.
				await writeFile(
					preload,
					[
						'import fs from "node:fs/promises";',
						'import { syncBuiltinESMExports } from "node:module";',
						"const originalStat = fs.stat;",
						"let removed = false;",
						"fs.stat = async function(path, ...args) {",
						"  const result = await originalStat.call(this, path, ...args);",
						"  if (!removed && String(path) === process.env.PDPP_TEST_UNREADABLE_PHOTO) {",
						"    removed = true;",
						'    await fs.rename(path, String(path) + ".unreadable");',
						"  }",
						"  return result;",
						"};",
						"syncBuiltinESMExports();",
					].join("\n"),
				);
				let failUpload = failure === "upload";
				await withBlobServer(
					async (req) => {
						const body = await readRequestBody(req);
						if (failUpload && body.equals(oldBytes)) {
							return {
								body: { error: "synthetic upload failure" },
								status: 500,
							};
						}
						const sha256 = createHash("sha256").update(body).digest("hex");
						return {
							body: {
								blob_id: `blob_sha256_${sha256}`,
								mime_type: "image/jpeg",
								object: "blob",
								sha256,
								size_bytes: body.byteLength,
							},
							status: 200,
						};
					},
					async (baseUrl) => {
						const env = {
							PDPP_OWNER_TOKEN: "owner-token",
							PDPP_RS_URL: baseUrl,
						};
						const first = await runApplePhotos(
							dir,
							{
								...env,
								...(failure === "read"
									? {
											NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`,
											PDPP_TEST_UNREADABLE_PHOTO: oldPath,
										}
									: {}),
							},
							{ photos: { last_modified: prior, export_marker: "preserved" } },
							runCoverage,
						);
						const failed = first.photos.find((p) => p.filename === "older.jpg");
						const healthy = first.photos.find((p) => p.filename === "newer.jpg");
						assert.equal(
							first.photos.length, 2, "failure must not drop either record",
						);
						assert.equal(failed?.hydration_status, "failed");
						assert.equal(failed?.blob_ref, null);
						assert.equal(healthy?.hydration_status, "hydrated");
						assert.ok(healthy?.blob_ref);
						if (failure === "read") {
							assert.equal(failed?.content_sha256, null);
							await rename(oldPath + ".unreadable", oldPath);
						}
						failUpload = false;
						const checkpoint = photoCursor(first.messages);
						const second = await runApplePhotos(
							dir, env, { photos: checkpoint }, runCoverage,
						);
						const repaired = second.photos.find((p) => p.filename === "older.jpg");
						assert.equal(
							repaired?.hydration_status,
							"hydrated",
							"resume must retry repaired older work, not skip it behind the cursor",
						);
						assert.equal(
							repaired?.content_sha256,
							createHash("sha256").update(oldBytes).digest("hex"),
						);
						assert.ok(repaired?.blob_ref);
						assert.deepEqual(
							second.photos.find((p) => p.filename === "newer.jpg"),
							healthy,
							"replayed healthy records retain identity, bytes and all metadata",
						);
						assert.equal(second.photos.length, 2);
						assert.equal(checkpoint.export_marker, "preserved");
						assert.equal(photoCursor(second.messages).export_marker, "preserved");
						assert.equal(
							checkpoint.last_modified, prior,
							"any failed hydration must hold the existing cursor",
						);
						assert.match(
							first.stderr, /"reason":"hydration_failed","status":"partial"/,
						);
						assert.doesNotMatch(first.stderr, /coverage .*"status":"collected"/);
						assert.equal(
							photoCursor(second.messages).last_modified, newer.toISOString(),
						);
						assert.match(
							second.stderr, /"reason":"collected","status":"collected"/,
						);
						assertPhotoDone(first.messages, runCoverage, "partial");
						assertPhotoDone(second.messages, runCoverage, "collected");
					},
				);
			} finally {
				await rm(root, { force: true, recursive: true });
			}
		},
	);
}
