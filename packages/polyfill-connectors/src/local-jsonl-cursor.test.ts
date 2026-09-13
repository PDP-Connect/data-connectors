// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import type { FileHandle } from "node:fs/promises";
import {
	mkdtemp,
	open,
	rename,
	rm,
	truncate,
	unlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scanLocalJsonl } from "./local-jsonl-cursor.ts";

async function scan(
	path: string,
	prior?: Awaited<ReturnType<typeof scanLocalJsonl>>["cursor"],
) {
	const lines: string[] = [];
	const result = await scanLocalJsonl({
		path,
		prior,
		onLine: (line) => {
			lines.push(line.toString("utf8"));
			return Promise.resolve();
		},
	});
	return { lines, result };
}

test("local JSONL cursor skips an mtime-only touch and tails one complete append", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"one"}\n');
	const first = await scan(path);
	const date = new Date(Date.now() + 10_000);
	await utimes(path, date, date);
	const touched = await scan(path, first.result.cursor);
	assert.equal(touched.result.decision.kind, "verified_noop");
	assert.deepEqual(touched.lines, []);
	await writeFile(path, '{"id":"one"}\n{"id":"two"}\n');
	const appended = await scan(path, touched.result.cursor);
	assert.deepEqual(appended.lines, ['{"id":"two"}']);
	assert.equal(appended.result.decision.kind, "append");
});

test("filesystem failures identify the local JSONL path and operation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-source-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const missing = join(root, "missing.jsonl");
	await assert.rejects(scan(missing), {
		name: "LocalJsonlSourceReadError",
		path: missing,
		operation: "open",
	});
	await assert.rejects(scan(root), {
		name: "LocalJsonlSourceReadError",
		path: root,
		operation: "read",
	});
	const path = join(root, "events.jsonl");
	await writeFile(path, "{}\n");
	await assert.rejects(
		scanLocalJsonl({ path, prior: undefined, onLine: () => unlink(path) }),
		{ name: "LocalJsonlSourceReadError", path, operation: "stat" },
	);
});

test("complete-line and tail callback failures retain identity even with filesystem-like codes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-callback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "events.jsonl");
	const failure = Object.assign(new Error("output transport failed"), {
		code: "EIO",
	});
	await writeFile(path, "{}\n");
	await assert.rejects(
		scanLocalJsonl({
			path,
			prior: undefined,
			onLine: () => Promise.reject(failure),
		}),
		(error: unknown) => error === failure,
	);
	await writeFile(path, "partial");
	await assert.rejects(
		scanLocalJsonl({
			path,
			prior: undefined,
			onLine: () => Promise.resolve(),
			onIncompleteLine: () => Promise.reject(failure),
		}),
		(error: unknown) => error === failure,
	);
});

test("cleanup failure cannot replace a callback failure with a recoverable source error", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-close-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "events.jsonl");
	await writeFile(path, "{}\n");
	const probe = await open(path);
	const prototype = Object.getPrototypeOf(probe) as Pick<FileHandle, "stat">;
	await probe.close();
	const originalStat = prototype.stat;
	const patched = new WeakSet<FileHandle>();
	const cleanupFailure = Object.assign(new Error("close failed"), {
		code: "EIO",
	});
	t.mock.method(prototype, "stat", function (this: FileHandle) {
		if (!patched.has(this)) {
			patched.add(this);
			const close = this.close.bind(this);
			this.close = async () => {
				await close();
				throw cleanupFailure;
			};
		}
		return originalStat.bind(this)();
	});
	const callbackFailure = new Error("output transport failed");
	await assert.rejects(
		scanLocalJsonl({
			path,
			prior: undefined,
			onLine: () => Promise.reject(callbackFailure),
		}),
		(error: unknown) => error === callbackFailure,
	);
	await assert.rejects(scan(path), {
		name: "LocalJsonlSourceReadError",
		operation: "close",
		cause: cleanupFailure,
	});
});

test("local JSONL cursor detects a changed committed byte beyond 64 KiB", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	const padding = "x".repeat(70_000);
	await writeFile(path, `${JSON.stringify({ id: "one", padding })}\n`);
	const first = await scan(path);
	const contents = await (await import("node:fs/promises")).readFile(
		path,
		"utf8",
	);
	await writeFile(path, contents.replace("x", "y"));
	const rewritten = await scan(path, first.result.cursor);
	assert.deepEqual(rewritten.lines, [contents.replace("x", "y").trim()]);
	assert.deepEqual(rewritten.result.decision, {
		kind: "rebuild",
		reason: "prefix_changed",
	});
});

test("local JSONL cursor retains an unterminated line until it gains LF", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"partial');
	const first = await scan(path);
	assert.equal(first.result.cursor.committed_offset_bytes, 0);
	assert.deepEqual(first.lines, []);
	await writeFile(path, '{"id":"partial"}\n');
	const second = await scan(path, first.result.cursor);
	assert.deepEqual(second.lines, ['{"id":"partial"}']);
});

test("local JSONL cursor rebuilds after a replacement or truncation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"one"}\n');
	const first = await scan(path);
	await truncate(path, 0);
	await writeFile(path, '{"id":"new"}\n');
	const truncated = await scan(path, first.result.cursor);
	assert.equal(truncated.result.decision.kind, "rebuild");
	assert.deepEqual(truncated.lines, ['{"id":"new"}']);
	const replacement = join(root, "replacement.jsonl");
	await writeFile(replacement, '{"id":"new"}\n{"id":"later"}\n');
	await rename(replacement, path);
	const rotated = await scan(path, truncated.result.cursor);
	assert.deepEqual(rotated.lines, ['{"id":"later"}']);
	assert.equal(rotated.result.decision.kind, "append");
});

test("local JSONL cursor rejects an in-scan same-size mutation without returning a cursor", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"one"}\n');
	await assert.rejects(
		scanLocalJsonl({
			path,
			onLine: async () => {
				await writeFile(path, '{"id":"two"}\n');
			},
			prior: undefined,
		}),
		/mutated while scanning/,
	);
});

test("local JSONL cursor rejects a concurrent committed-prefix rewrite plus growth", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"one"}\n');
	await assert.rejects(
		scanLocalJsonl({
			path,
			onLine: async () => {
				await writeFile(path, '{"id":"rewritten"}\n{"id":"grown"}\n');
			},
			prior: undefined,
		}),
		/committed prefix changed while scanning/,
	);
	const retry = await scan(path);
	assert.deepEqual(retry.lines, ['{"id":"rewritten"}', '{"id":"grown"}']);
});

test("local JSONL cursor never clean-appends after a prior-prefix rewrite plus growth", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	await writeFile(path, '{"id":"one"}\n');
	const first = await scan(path);
	await writeFile(path, '{"id":"one"}\n{"id":"two"}\n');
	await assert.rejects(
		scanLocalJsonl({
			path,
			prior: first.result.cursor,
			onLine: async () => {
				await writeFile(
					path,
					'{"id":"rewritten"}\n{"id":"two"}\n{"id":"three"}\n',
				);
			},
		}),
		/committed prefix changed while scanning/,
	);
	const retry = await scan(path);
	assert.deepEqual(retry.lines, [
		'{"id":"rewritten"}',
		'{"id":"two"}',
		'{"id":"three"}',
	]);
});

test("line locations count physical blank lines and recover numbering from legacy cursors", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-local-jsonl-"));
	const path = join(root, "events.jsonl");
	const prefix = '"é"\n\n';
	await writeFile(path, prefix);
	const first = await scan(path);
	assert.equal(first.result.cursor.committed_line_count, 2);
	const { committed_line_count: _count, ...legacy } = first.result.cursor;
	await writeFile(path, `${prefix}bad\npartial`);
	const lines: number[][] = [];
	const tails: number[][] = [];
	const next = await scanLocalJsonl({
		path,
		prior: legacy,
		onLine: async (_line, offset, number) => {
			lines.push([offset, number]);
		},
		onIncompleteLine: async (_line, offset, number) => {
			tails.push([offset, number]);
		},
	});
	assert.deepEqual(lines, [[Buffer.byteLength(prefix), 3]]);
	assert.deepEqual(tails, [[Buffer.byteLength(`${prefix}bad\n`), 4]]);
	assert.equal(next.cursor.committed_line_count, 3);
	assert.equal(
		next.cursor.committed_offset_bytes,
		Buffer.byteLength(`${prefix}bad\n`),
	);
});
