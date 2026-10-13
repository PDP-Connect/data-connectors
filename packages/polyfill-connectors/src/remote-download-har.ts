// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Download bodies in a remote-CDP HAR recording.
 *
 * Playwright's HAR tracer keeps no body for a response that turned into a
 * download, so a replay through `routeFromHAR` cannot serve the file and a
 * connector that collects through a download (an export ZIP) fails replay.
 * While recording over remote CDP, `acquireRemoteCdpBrowser` keeps the
 * downloads of run-owned pages, reads their bytes before the context closes
 * (Playwright deletes download artifacts with the context), and writes them
 * into the HAR entry for the download's URL after the HAR export.
 *
 * A body is placed only into an entry the HAR already has. A download the
 * page navigated to has one; Chromium does not report a request for an
 * `<a download>` click to the HAR tracer, so such a download stays absent
 * from the HAR, as before.
 *
 * Only run-owned pages count (see `run-owned-pages.ts`): a download in a tab
 * the browser's owner opened is never read, so it never lands in the HAR.
 *
 * Over `connectOverCDP` the file is written to Playwright's downloads path on
 * the BROWSER's machine. A remote browser's download is therefore readable
 * here only when the host mirrors that directory back (see
 * `PDPP_REMOTE_DOWNLOAD_MIRROR_TIMEOUT_MS` in `playwright-download.ts`); one
 * that is not readable is left out and the HAR entry stays as recorded.
 */

import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { BrowserContext, Download, Page } from "playwright";

/**
 * One tracked download, in start order: its URL and its bytes, or null when
 * it failed, did not finish in time, or its file is not on this machine. A
 * null still holds its place, so the downloads after it pair correctly.
 */
export interface DownloadBody {
	bytes: Buffer | null;
	url: string;
}

export interface RunOwnedDownloads {
	/** Stop listening; already collected downloads stay available. */
	dispose: () => void;
	/** Downloads of run-owned pages, in the order they started. */
	downloads: () => Download[];
}

/**
 * Collects downloads started on pages the run owns. Every page of the context
 * is watched, but a download is kept only if `owns(page)` holds when it
 * starts; ownership is never inferred from the context.
 */
export function trackRunOwnedDownloads(
	context: Pick<BrowserContext, "off" | "on" | "pages">,
	owns: (page: Page) => boolean,
): RunOwnedDownloads {
	const kept: Download[] = [];
	const listeners = new Map<Page, (download: Download) => void>();
	const watch = (page: Page): void => {
		if (listeners.has(page)) {
			return;
		}
		const onDownload = (download: Download): void => {
			if (owns(page)) {
				kept.push(download);
			}
		};
		listeners.set(page, onDownload);
		page.on("download", onDownload);
	};
	for (const page of context.pages()) {
		watch(page);
	}
	context.on("page", watch);
	return {
		dispose: () => {
			context.off("page", watch);
			for (const [page, onDownload] of listeners) {
				page.off("download", onDownload);
			}
			listeners.clear();
		},
		downloads: () => [...kept],
	};
}

const DOWNLOAD_READ_DEADLINE_MS = 30_000;

/**
 * Reads the bytes of every download, all under ONE shared deadline (not one
 * per download), in parallel. Returns one result per download in the same
 * order; a failed, unfinished or missing download gives `bytes: null`. Never
 * throws, because it runs inside `release()`.
 */
export async function readDownloadBodies(
	downloads: readonly Pick<Download, "failure" | "path" | "url">[],
	deadlineMs = DOWNLOAD_READ_DEADLINE_MS,
): Promise<DownloadBody[]> {
	if (downloads.length === 0) {
		return [];
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), deadlineMs);
	});
	try {
		return await Promise.all(
			downloads.map(async (download) => ({
				bytes: await Promise.race([readOneDownload(download), expired]),
				url: download.url(),
			})),
		);
	} finally {
		clearTimeout(timer);
	}
}

async function readOneDownload(
	download: Pick<Download, "failure" | "path">,
): Promise<Buffer | null> {
	try {
		const path = await download.path();
		if (!path || (await download.failure()) || !existsSync(path)) {
			return null;
		}
		return await readFile(path);
	} catch {
		return null;
	}
}

interface HarContentEntry {
	request?: { url?: string };
	response?: {
		content?: {
			encoding?: string;
			mimeType?: string;
			size?: number;
			text?: string;
		};
	};
	startedDateTime?: string;
}

/**
 * Pairs downloads with HAR entries per URL, FORWARD in order: the i-th
 * download of a URL (in start order) goes to the i-th entry for that URL
 * that has no body yet (in start order). A download whose bytes could not be
 * read keeps its slot, so a failed first download does not shift the rest
 * onto the wrong entries. Writes each body as base64 and returns how many
 * were placed. Mutates `har`.
 */
export function embedDownloadBodies(
	har: { log?: { entries?: HarContentEntry[] } },
	downloads: readonly DownloadBody[],
): number {
	const entries = har.log?.entries ?? [];
	const byUrl = new Map<string, DownloadBody[]>();
	for (const download of downloads) {
		byUrl.set(download.url, [...(byUrl.get(download.url) ?? []), download]);
	}
	const started = (entry: HarContentEntry): number => {
		const time = Date.parse(entry.startedDateTime ?? "");
		return Number.isNaN(time) ? 0 : time;
	};
	let placed = 0;
	for (const [url, group] of byUrl) {
		const slots = entries
			.filter(
				(entry) =>
					entry.request?.url === url &&
					entry.response !== undefined &&
					!entry.response.content?.text,
			)
			.sort((left, right) => started(left) - started(right));
		for (const [index, download] of group.entries()) {
			const response = slots[index]?.response;
			if (!(response && download.bytes)) {
				continue;
			}
			response.content = {
				...response.content,
				encoding: "base64",
				size: download.bytes.length,
				text: download.bytes.toString("base64"),
			};
			placed += 1;
		}
	}
	return placed;
}

/**
 * `embedDownloadBodies` on the HAR file at `path`, written back 0600. Best
 * effort like the redaction pass: a missing or unparseable HAR is left alone.
 */
export async function embedDownloadBodiesInHarFile(
	path: string,
	bodies: readonly DownloadBody[],
): Promise<number> {
	if (!bodies.some((body) => body.bytes)) {
		return 0;
	}
	let har: { log?: { entries?: HarContentEntry[] } };
	try {
		har = JSON.parse(await readFile(path, "utf8")) as {
			log?: { entries?: HarContentEntry[] };
		};
	} catch {
		return 0;
	}
	const placed = embedDownloadBodies(har, bodies);
	process.stderr.write(
		`[browser-launch] remote HAR: embedded ${String(placed)}/${String(bodies.length)} download body(ies)\n`,
	);
	if (placed > 0) {
		await writeFile(path, JSON.stringify(har), "utf8");
		await chmod(path, 0o600);
	}
	return placed;
}
