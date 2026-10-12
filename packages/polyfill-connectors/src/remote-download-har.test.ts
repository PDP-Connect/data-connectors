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

test("readDownloadBodies reads finished local files and skips failed, missing and unfinished downloads", async () => {
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
			bodies.map((b) => [b.url, [...b.bytes]]),
			[["https://example.test/a", [1, 2, 3]]],
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("embedDownloadBodies fills the last body-less entry for the URL and leaves others alone", () => {
	const har = {
		log: {
			entries: [
				{
					request: { url: "https://example.test/export.zip" },
					response: { content: { mimeType: "application/zip", size: 0 } },
				},
				{
					request: { url: "https://example.test/export.zip" },
					response: { content: { mimeType: "application/zip", size: 0 } },
				},
				{
					request: { url: "https://example.test/page" },
					response: { content: { text: "<html>", size: 6 } },
				},
			],
		},
	};
	const placed = embedDownloadBodies(har, [
		{ bytes: Buffer.from("zip!"), url: "https://example.test/export.zip" },
		{ bytes: Buffer.from("x"), url: "https://example.test/not-in-har" },
	]);
	assert.equal(placed, 1);
	assert.equal(har.log.entries[0]?.response.content.text, undefined);
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
