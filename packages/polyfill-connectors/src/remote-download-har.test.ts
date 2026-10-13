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
	embedDownloadBodies,
	embedDownloadBodiesInHarFile,
	readDownloadBodies,
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

test("trackRunOwnedDownloads keeps downloads of run-owned pages only, including pages that appear later", () => {
	const owned = fakePage();
	const foreign = fakePage();
	const context = fakeContext([owned, foreign]);
	const ownedSet = new Set<Page>([owned]);
	const tracker = trackRunOwnedDownloads(context, (page) => ownedSet.has(page));

	const ownedDownload = { url: () => "https://example.test/export.zip" };
	const foreignDownload = { url: () => "https://example.test/private.pdf" };
	owned.emit("download", ownedDownload);
	foreign.emit("download", foreignDownload);

	// A popup the run adopts after it opened is followed too.
	const popup = fakePage();
	context.emit("page", popup);
	ownedSet.add(popup);
	const popupDownload = { url: () => "https://example.test/popup.csv" };
	popup.emit("download", popupDownload);

	assert.deepEqual(tracker.downloads(), [ownedDownload, popupDownload]);

	tracker.dispose();
	owned.emit("download", { url: () => "https://example.test/late.zip" });
	assert.equal(tracker.downloads().length, 2);
	assert.equal(owned.listenerCount("download"), 0);
	assert.equal(context.listenerCount("page"), 0);
});

test("readDownloadBodies returns one result per download, in order, with null bytes for failed, missing and unfinished ones", async () => {
	const dir = await mkdtemp(join(tmpdir(), "remote-download-har-"));
	try {
		const file = join(dir, "export.zip");
		await writeFile(file, Buffer.from([1, 2, 3]));
		const bodies = await readDownloadBodies(
			[
				fakeDownload({ path: file, url: "https://example.test/a" }),
				fakeDownload({
					failure: "canceled",
					path: file,
					url: "https://example.test/failed",
				}),
				fakeDownload({
					path: join(dir, "missing.zip"),
					url: "https://example.test/missing",
				}),
				fakeDownload({
					path: () => new Promise<string>(() => undefined),
					url: "https://example.test/stuck",
				}),
			],
			50,
		);
		assert.deepEqual(
			bodies.map((b) => [b.url, b.bytes === null ? null : [...b.bytes]]),
			[
				["https://example.test/a", [1, 2, 3]],
				["https://example.test/failed", null],
				["https://example.test/missing", null],
				["https://example.test/stuck", null],
			],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readDownloadBodies applies ONE deadline to all downloads, not one each", async () => {
	const stuck = () =>
		fakeDownload({
			path: () => new Promise<string>(() => undefined),
			url: "https://example.test/stuck",
		});
	const started = performance.now();
	const bodies = await readDownloadBodies(
		[stuck(), stuck(), stuck(), stuck(), stuck()],
		200,
	);
	const elapsed = performance.now() - started;
	assert.equal(bodies.length, 5);
	assert.ok(
		elapsed < 600,
		`five stuck downloads took ${String(Math.round(elapsed))}ms; one shared 200ms deadline expected`,
	);
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
