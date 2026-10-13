// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext, Download, Page } from "playwright";
import {
	captureDownloadBody,
	embedDownloadBodies,
	embedDownloadBodiesInHarFile,
	trackRunOwnedDownloads,
} from "./remote-download-har.ts";

/** A page double: an EventEmitter typed as the Page surface the tracker uses. */
function fakePage(): Page & EventEmitter {
	return new EventEmitter() as Page & EventEmitter;
}

function fakeContext(
	initial: Page[],
): Pick<BrowserContext, "off" | "on" | "pages"> & EventEmitter {
	const emitter = new EventEmitter();
	return Object.assign(emitter, { pages: () => initial }) as Pick<
		BrowserContext,
		"off" | "on" | "pages"
	> &
		EventEmitter;
}

function fakeDownload(fields: {
	failure?: string | null;
	path: string | (() => Promise<string>);
	url: string;
}): Pick<Download, "failure" | "path" | "url"> {
	return {
		failure: async () => fields.failure ?? null,
		path:
			typeof fields.path === "function"
				? fields.path
				: async () => String(fields.path),
		url: () => fields.url,
	};
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

test("trackRunOwnedDownloads captures downloads of run-owned pages only, including pages that appear later", async () => {
	const dir = await mkdtemp(join(tmpdir(), "remote-download-track-"));
	try {
		const file = (name: string) => join(dir, name);
		await writeFile(file("owned"), "owned-bytes");
		await writeFile(file("foreign"), "foreign-bytes");
		await writeFile(file("popup"), "popup-bytes");
		const owned = fakePage();
		const foreign = fakePage();
		const context = fakeContext([owned, foreign]);
		const ownedSet = new Set<Page>([owned]);
		const tracker = trackRunOwnedDownloads(
			context,
			(page) => ownedSet.has(page),
			{
				pollMs: 5,
				windowMs: 1000,
			},
		);
		owned.emit(
			"download",
			fakeDownload({
				path: file("owned"),
				url: "https://example.test/export.zip",
			}),
		);
		foreign.emit(
			"download",
			fakeDownload({
				path: file("foreign"),
				url: "https://example.test/private.pdf",
			}),
		);
		// A popup the run adopts after it opened is followed too.
		const popup = fakePage();
		context.emit("page", popup);
		ownedSet.add(popup);
		popup.emit(
			"download",
			fakeDownload({
				path: file("popup"),
				url: "https://example.test/popup.csv",
			}),
		);

		const bodies = await tracker.bodies();
		assert.deepEqual(
			bodies.map((b) => [b.url, b.bytes?.toString("utf8") ?? null]),
			[
				["https://example.test/export.zip", "owned-bytes"],
				["https://example.test/popup.csv", "popup-bytes"],
			],
		);
		tracker.dispose();
		owned.emit(
			"download",
			fakeDownload({
				path: file("owned"),
				url: "https://example.test/late.zip",
			}),
		);
		assert.equal((await tracker.bodies()).length, 2);
		assert.equal(owned.listenerCount("download"), 0);
		assert.equal(context.listenerCount("page"), 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stuck download does not cost a later one: capture starts with each download, and a read in progress is never cut off", async () => {
	const dir = await mkdtemp(join(tmpdir(), "remote-download-eager-"));
	try {
		const ready = join(dir, "ready.zip");
		await writeFile(ready, "slow-but-complete");
		const page = fakePage();
		const tracker = trackRunOwnedDownloads(fakeContext([page]), () => true, {
			pollMs: 5,
			windowMs: 300,
			// The read itself takes 250ms.
			read: async (path) => {
				await sleep(250);
				return readFile(path);
			},
		});
		// t=0: A never finishes; B finishes at t=200 and its read runs to t=450.
		page.emit(
			"download",
			fakeDownload({
				path: () => new Promise<string>(() => undefined),
				url: "https://example.test/stuck.zip",
			}),
		);
		page.emit(
			"download",
			fakeDownload({
				path: async () => {
					await sleep(200);
					return ready;
				},
				url: "https://example.test/ready.zip",
			}),
		);
		// "release" at t=100: a deadline counted from here (t=400) would cut
		// B's read, which ends at t=450.
		await sleep(100);
		const bodies = await tracker.bodies();
		assert.deepEqual(
			bodies.map((b) => [
				b.url,
				b.bytes?.toString("utf8") ?? null,
				b.unfinished ?? false,
			]),
			[
				["https://example.test/stuck.zip", null, true],
				["https://example.test/ready.zip", "slow-but-complete", false],
			],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("captureDownloadBody waits for a mirrored file to appear; a failed download is null but not unfinished", async () => {
	const dir = await mkdtemp(join(tmpdir(), "remote-download-mirror-"));
	try {
		const later = join(dir, "later.zip");
		setTimeout(() => {
			writeFile(later, "mirrored").catch(() => undefined);
		}, 60);
		const mirrored = await captureDownloadBody(
			fakeDownload({ path: later, url: "https://example.test/later.zip" }),
			{
				pollMs: 10,
				windowMs: 1000,
			},
		);
		assert.equal(mirrored.bytes?.toString("utf8"), "mirrored");

		const failed = await captureDownloadBody(
			fakeDownload({
				failure: "canceled",
				path: later,
				url: "https://example.test/failed",
			}),
			{ pollMs: 10, windowMs: 1000 },
		);
		assert.deepEqual(failed, {
			bytes: null,
			url: "https://example.test/failed",
		});

		const never = await captureDownloadBody(
			fakeDownload({
				path: join(dir, "never"),
				url: "https://example.test/never",
			}),
			{
				pollMs: 10,
				windowMs: 60,
			},
		);
		assert.deepEqual(never, {
			bytes: null,
			unfinished: true,
			url: "https://example.test/never",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

interface SlotEntry {
	request: { url: string };
	response: { content: { mimeType?: string; size?: number; text?: string } };
	startedDateTime: string;
}

function slotHar(
	url: string,
	count: number,
): { log: { entries: SlotEntry[] } } {
	return {
		log: {
			entries: Array.from({ length: count }, (_, index) => ({
				request: { url },
				response: { content: { mimeType: "application/zip", size: 0 } },
				startedDateTime: new Date(
					Date.UTC(2026, 0, 1, 0, 0, index),
				).toISOString(),
			})),
		},
	};
}

const decoded = (
	entry: { response: { content: { text?: string } } } | undefined,
) =>
	entry?.response.content.text === undefined
		? undefined
		: Buffer.from(entry.response.content.text, "base64").toString("utf8");

test("embedDownloadBodies pairs two downloads of one URL forward, oldest entry first", () => {
	const url = "https://example.test/export.zip";
	const har = slotHar(url, 2);
	const placed = embedDownloadBodies(har, [
		{ bytes: Buffer.from("first"), url },
		{ bytes: Buffer.from("second"), url },
	]);
	assert.equal(placed, 2);
	assert.equal(decoded(har.log.entries[0]), "first");
	assert.equal(decoded(har.log.entries[1]), "second");
});

test("embedDownloadBodies: a missing first download keeps its slot, so the second lands on the second entry", () => {
	const url = "https://example.test/export.zip";
	const har = slotHar(url, 2);
	const placed = embedDownloadBodies(har, [
		{ bytes: null, url },
		{ bytes: Buffer.from("second"), url },
	]);
	assert.equal(placed, 1);
	assert.equal(decoded(har.log.entries[0]), undefined);
	assert.equal(decoded(har.log.entries[1]), "second");
});

test("embedDownloadBodies skips entries that already have a body and leaves other URLs alone", () => {
	const har = {
		log: {
			entries: [
				{
					request: { url: "https://example.test/export.zip" },
					response: { content: { text: "already", size: 7 } },
					startedDateTime: "2026-01-01T00:00:00.000Z",
				},
				{
					request: { url: "https://example.test/export.zip" },
					response: { content: { mimeType: "application/zip", size: 0 } },
					startedDateTime: "2026-01-01T00:00:01.000Z",
				},
				{
					request: { url: "https://example.test/page" },
					response: { content: { text: "<html>", size: 6 } },
					startedDateTime: "2026-01-01T00:00:02.000Z",
				},
			],
		},
	};
	const placed = embedDownloadBodies(har, [
		{ bytes: Buffer.from("zip!"), url: "https://example.test/export.zip" },
		{ bytes: Buffer.from("x"), url: "https://example.test/not-in-har" },
	]);
	assert.equal(placed, 1);
	assert.equal(har.log.entries[0]?.response.content.text, "already");
	assert.deepEqual(har.log.entries[1]?.response.content, {
		encoding: "base64",
		mimeType: "application/zip",
		size: 4,
		text: Buffer.from("zip!").toString("base64"),
	});
	assert.equal(har.log.entries[2]?.response.content.text, "<html>");
});

test("embedDownloadBodiesInHarFile writes back 0600 and leaves a missing HAR alone", async () => {
	const dir = await mkdtemp(join(tmpdir(), "remote-download-har-file-"));
	try {
		const path = join(dir, "run.har");
		await writeFile(
			path,
			JSON.stringify({
				log: {
					entries: [
						{
							request: { url: "https://example.test/export.zip" },
							response: { content: { size: 0 } },
						},
					],
				},
			}),
		);
		const placed = await embedDownloadBodiesInHarFile(path, [
			{ bytes: Buffer.from("ok"), url: "https://example.test/export.zip" },
		]);
		assert.equal(placed, 1);
		const written = JSON.parse(await readFile(path, "utf8")) as {
			log: { entries: { response: { content: { text?: string } } }[] };
		};
		assert.equal(
			written.log.entries[0]?.response.content.text,
			Buffer.from("ok").toString("base64"),
		);
		assert.equal((await stat(path)).mode.toString(8).slice(-3), "600");
		assert.equal(
			await embedDownloadBodiesInHarFile(join(dir, "missing.har"), [
				{ bytes: Buffer.from("ok"), url: "https://example.test/export.zip" },
			]),
			0,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
