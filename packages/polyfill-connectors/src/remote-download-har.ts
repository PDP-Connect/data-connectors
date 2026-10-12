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

/** A finished download's URL and bytes, read before the context closes. */
export interface DownloadBody {
	bytes: Buffer;
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
 * Reads the bytes of each finished download whose file is on this machine.
 * A failed, unfinished (past the deadline) or missing download is skipped;
 * this never throws, because it runs inside `release()`.
 */
export async function readDownloadBodies(
	downloads: readonly Pick<Download, "failure" | "path" | "url">[],
	deadlineMs = DOWNLOAD_READ_DEADLINE_MS,
): Promise<DownloadBody[]> {
	const bodies: DownloadBody[] = [];
	for (const download of downloads) {
		// Sequential on purpose: bounded per download, and a release() that
		// fans out file reads gains nothing.
		const body = await readOneDownload(download, deadlineMs);
		if (body) {
			bodies.push(body);
		}
	}
	return bodies;
}

async function readOneDownload(
	download: Pick<Download, "failure" | "path" | "url">,
	deadlineMs: number,
): Promise<DownloadBody | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const path = await Promise.race([
			download.path(),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), deadlineMs);
			}),
		]);
		if (!path || (await download.failure()) || !existsSync(path)) {
			return null;
		}
		return { bytes: await readFile(path), url: download.url() };
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
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
}

/**
 * Writes each body into the LAST entry for its URL that has no body yet, as
 * base64. Returns how many bodies were placed. Mutates `har`.
 */
export function embedDownloadBodies(
	har: { log?: { entries?: HarContentEntry[] } },
	bodies: readonly DownloadBody[],
): number {
	const entries = har.log?.entries ?? [];
	let placed = 0;
	for (const body of bodies) {
		const entry = entries.findLast(
			(candidate) =>
				candidate.request?.url === body.url &&
				candidate.response !== undefined &&
				!candidate.response.content?.text,
		);
		if (!entry?.response) {
			continue;
		}
		entry.response.content = {
			...entry.response.content,
			encoding: "base64",
			size: body.bytes.length,
			text: body.bytes.toString("base64"),
		};
		placed += 1;
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
	if (bodies.length === 0) {
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
