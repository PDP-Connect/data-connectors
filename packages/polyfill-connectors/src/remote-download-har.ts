// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Download bodies in a remote-CDP HAR recording.
 *
 * Playwright's HAR tracer keeps no body for a response that turned into a
 * download, so a replay through `routeFromHAR` cannot serve the file and a
 * connector that collects through a download (an export ZIP) fails replay.
 * While recording over remote CDP, `acquireRemoteCdpBrowser` keeps the
 * downloads of run-owned pages, captures each body from the moment the
 * download starts (Playwright deletes download artifacts with the context,
 * so they must be read before it closes), and writes them into the HAR entry
 * for the download's URL after the HAR export. A download still unfinished
 * at release is counted and logged, never silently dropped.
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
 *
 * Contract: each download's file has 30s to become readable here, counted
 * from that download's OWN start (`PDPP_REMOTE_DOWNLOAD_CAPTURE_WINDOW_MS`
 * overrides it); a read that has started is never cut off. Release seals
 * tracking: a download that starts after that is not captured, and is
 * counted and logged as late.
 */

import { existsSync, statSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { BrowserContext, Download, Page } from "playwright";

/**
 * One tracked download, in start order: its URL and its bytes, or null when
 * it failed, its file never became readable here in time, or it was still
 * unfinished at release (`unfinished`). A null still holds its place, so the
 * downloads after it pair correctly.
 */
export interface DownloadBody {
	bytes: Buffer | null;
	unfinished?: boolean;
	url: string;
}

export interface RunOwnedDownloads {
	/**
	 * Seals tracking (a download that starts after this is not captured; it
	 * is counted and logged as late), then waits for every capture already
	 * running and returns the bodies in start order. When it resolves no
	 * capture, poll or timer of this tracker is still running.
	 */
	bodies: () => Promise<DownloadBody[]>;
	/** Stop listening; captures already started keep running. */
	dispose: () => void;
	/** Download events that arrived after `bodies()` sealed tracking. */
	late: () => number;
}

export interface DownloadCaptureOptions {
	/**
	 * How long a download's file may take to become readable here, counted
	 * from the download's OWN start (not from release). A read that has
	 * started is never cut off by it. Default 30s; a host can set
	 * `PDPP_REMOTE_DOWNLOAD_CAPTURE_WINDOW_MS` (see
	 * `downloadCaptureOptionsFromEnv`).
	 */
	windowMs?: number;
	/** Interval for checking whether the (mirrored) file has appeared. */
	pollMs?: number;
	/** Reads the finished file. Injectable for tests. */
	read?: (path: string) => Promise<Buffer>;
}

const DOWNLOAD_CAPTURE_WINDOW_MS = 30_000;
const DOWNLOAD_FILE_POLL_MS = 250;

/** `PDPP_REMOTE_DOWNLOAD_CAPTURE_WINDOW_MS`, when it is a positive number. */
export function downloadCaptureOptionsFromEnv(
	env: NodeJS.ProcessEnv,
): DownloadCaptureOptions {
	const windowMs = Number(env.PDPP_REMOTE_DOWNLOAD_CAPTURE_WINDOW_MS);
	return Number.isFinite(windowMs) && windowMs > 0 ? { windowMs } : {};
}

function fileSize(path: string): number {
	try {
		return existsSync(path) ? statSync(path).size : 0;
	} catch {
		return 0;
	}
}

/**
 * Starts capturing one download's body NOW (call it when the download
 * starts) and returns a promise that always resolves, never rejects.
 *
 * Two phases. "Ready": the download finished (`path()` resolved, no
 * `failure()`) and its file is readable here with a non-zero size; for a
 * remote browser the host's mirror may copy it back a little later, so the
 * file is polled for, with one last check when the window ends. "Read": its
 * bytes are read. The window (`windowMs`, from this download's own start)
 * applies only to becoming ready: a download not ready by then resolves
 * `unfinished`. Once the read has started it runs to the end. Every timer is
 * cleared when the promise resolves. Polls are counted, not timed with the
 * clock, because the clock is traced during a scenario recording.
 */
export function captureDownloadBody(
	download: Pick<Download, "failure" | "path" | "url">,
	{
		pollMs = DOWNLOAD_FILE_POLL_MS,
		read = (path) => readFile(path),
		windowMs = DOWNLOAD_CAPTURE_WINDOW_MS,
	}: DownloadCaptureOptions = {},
): Promise<DownloadBody> {
	const url = download.url();
	return new Promise<DownloadBody>((resolve) => {
		let settled = false;
		let reading = false;
		let readyPath: string | null = null;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		let wakePoll: (() => void) | null = null;
		const stopPolling = (): void => {
			clearTimeout(pollTimer);
			wakePoll?.();
			wakePoll = null;
		};
		const finish = (body: DownloadBody): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(windowTimer);
			stopPolling();
			resolve(body);
		};
		const readFrom = (path: string): void => {
			reading = true;
			clearTimeout(windowTimer);
			stopPolling();
			read(path).then(
				(bytes) => finish({ bytes, url }),
				() => finish({ bytes: null, url }),
			);
		};
		const windowTimer = setTimeout(() => {
			if (reading || settled) {
				return;
			}
			// One last look at the window end: a file that landed during the
			// final poll sleep still counts.
			if (readyPath && fileSize(readyPath) > 0) {
				readFrom(readyPath);
				return;
			}
			finish({ bytes: null, unfinished: true, url });
		}, windowMs);
		const poll = async (): Promise<void> => {
			const path = await download.path();
			if (settled) {
				return;
			}
			if (!path || (await download.failure())) {
				finish({ bytes: null, url });
				return;
			}
			readyPath = path;
			while (!(settled || reading)) {
				if (fileSize(path) > 0) {
					readFrom(path);
					return;
				}
				await new Promise<void>((wake) => {
					wakePoll = wake;
					pollTimer = setTimeout(wake, pollMs);
				});
			}
		};
		poll().catch(() => finish({ bytes: null, url }));
	});
}

/**
 * Captures downloads started on pages the run owns, each from the moment it
 * starts. Every page of the context is watched, but a download is kept only
 * if `owns(page)` holds when it starts; ownership is never inferred from the
 * context.
 */
export function trackRunOwnedDownloads(
	context: Pick<BrowserContext, "off" | "on" | "pages">,
	owns: (page: Page) => boolean,
	options: DownloadCaptureOptions = {},
): RunOwnedDownloads {
	const captures: Promise<DownloadBody>[] = [];
	const listeners = new Map<Page, (download: Download) => void>();
	let sealed = false;
	let late = 0;
	const watch = (page: Page): void => {
		if (listeners.has(page)) {
			return;
		}
		const onDownload = (download: Download): void => {
			if (!owns(page)) {
				return;
			}
			if (sealed) {
				late += 1;
				return;
			}
			captures.push(captureDownloadBody(download, options));
		};
		listeners.set(page, onDownload);
		page.on("download", onDownload);
	};
	for (const page of context.pages()) {
		watch(page);
	}
	context.on("page", watch);
	return {
		bodies: async () => {
			// Seal first: everything accepted from here on is in `captures`,
			// so the wait below covers every capture this tracker started.
			sealed = true;
			const bodies = await Promise.all(captures);
			if (late > 0) {
				process.stderr.write(
					`[browser-launch] remote HAR: ${String(late)} download(s) started after release began; not captured\n`,
				);
			}
			return bodies;
		},
		dispose: () => {
			context.off("page", watch);
			for (const [page, onDownload] of listeners) {
				page.off("download", onDownload);
			}
			listeners.clear();
		},
		late: () => late,
	};
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
	const unfinished = bodies.filter((body) => body.unfinished).length;
	process.stderr.write(
		`[browser-launch] remote HAR: embedded ${String(placed)}/${String(bodies.length)} download body(ies); ${String(unfinished)} unfinished at release (no body)\n`,
	);
	if (placed > 0) {
		await writeFile(path, JSON.stringify(har), "utf8");
		await chmod(path, 0o600);
	}
	return placed;
}
