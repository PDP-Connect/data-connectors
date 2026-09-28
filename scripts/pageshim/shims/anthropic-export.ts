// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Node and Playwright calls that connectors/anthropic/index.ts makes to
// download and read the Claude export, mapped onto the PageShim host.
// build.mjs resolves these imports of that one file to this module:
//   node:fs, node:fs/promises, node:os, node:crypto,
//   bounded-zip-archive.ts, download-queue.ts, playwright-download.ts.
// Other modules in the bundle keep the throwing stubs.
//
// Desktop flow (attemptDownload + readExportZip in index.ts):
//   attachDownloadQueue -> goto(/export/{org}/download/{nonce})
//   -> waitForNextDownload -> mkdtemp -> savePlaywrightDownload(zip file)
//   -> openSync/statSync -> readZipEntriesFromFile -> closeSync -> rm
// PageShim flow, same calls:
//   goto(download URL) is not navigated; the URL is kept.
//   waitForNextDownload -> page.captureDownload(url): the host mints the
//     signed URL in the claude.ai document and fetches the ZIP natively.
//     {ready:false} -> no download, so the connector polls again.
//   savePlaywrightDownload -> page.extractZipEntries(): the host inflates
//     the .json entries. The result is kept in memory under the zip path.
//   readZipEntriesFromFile -> entries from that result.
// A host error that will not clear on retry (spent nonce, auth, bad URL,
// unreadable archive) is thrown from savePlaywrightDownload, which the
// connector does not catch, so the run ends with that error.
//
// Host blobs: index.ts spools each conversation/project source object to
// PDPP_BLOB_SPOOL_DIR. The PageShim host has no blob store, so writeFileSync
// discards the bytes. createHash still computes the real sha256 for blob_ref.

import type { ShimPage } from "../runtime.ts";

type CaptureResult = { ok: boolean; ready?: boolean; error?: string };
type ExtractResult =
	| { ok: true; names: string[]; json: Record<string, unknown> }
	| { ok: false; error: string };
export interface ExportHostPage extends ShimPage {
	captureDownload: (url: string, opts?: unknown) => Promise<CaptureResult>;
	extractZipEntries: (
		handle: string | null,
		opts?: unknown,
	) => Promise<ExtractResult>;
}

const CLAUDE_ORIGIN = "https://claude.ai";
const OLD_FORMAT_DOWNLOAD = /\/export\/[^/]+\/download\/[^/?#]+/;

let host: ExportHostPage | null = null;
let armedUrl: string | null = null;
/** Extracted archives, keyed by the path index.ts thinks it saved to. */
const archives = new Map<string, Extract<ExtractResult, { ok: true }>>();
const openFiles = new Map<number, string>();
let nextFd = 3;

type Download = { terminal?: Error };

/** The entry calls this once, before collect(). */
export function bindExportHost(shim: ExportHostPage): void {
	host = shim;
}

/** Wraps the Playwright page facade: a navigation to the old-format
 * download URL is kept for captureDownload instead of being loaded. */
export function withExportDownloads<T extends object>(page: T): T {
	return new Proxy(page, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (key !== "goto" || typeof value !== "function") return value;
			return (url: string, opts?: unknown) => {
				if (OLD_FORMAT_DOWNLOAD.test(url)) {
					armedUrl = url;
					return Promise.resolve(null);
				}
				// Anything off claude.ai here is a multi-part export_url. Do not
				// move the WebView to a storage host; waitForNextDownload ends
				// the run with a named error.
				if (new URL(url).origin !== CLAUDE_ORIGIN) return Promise.resolve(null);
				return value.call(target, url, opts);
			};
		},
	});
}

// ── download-queue.ts ────────────────────────────────────────────────────

export function attachDownloadQueue(_page: unknown) {
	return {
		detach: () => {
			armedUrl = null;
		},
		pendingCount: () => 0,
		async waitForNextDownload(): Promise<Download | null> {
			const url = armedUrl;
			armedUrl = null;
			if (!host) throw new Error("pageshim: export host is not bound");
			if (!url) {
				// The new multi-part format gives one-shot storage URLs that the
				// host's captureDownload does not accept.
				return {
					terminal: new Error(
						"Claude returned the multi-part export format. This app can only download the single-archive format, so no data was imported.",
					),
				};
			}
			let r: CaptureResult;
			try {
				r = await host.captureDownload(url);
			} catch (error) {
				// The host throws only for outcomes a retry cannot fix.
				return {
					terminal: error instanceof Error ? error : new Error(String(error)),
				};
			}
			return r?.ok && r.ready ? {} : null;
		},
	};
}

// ── playwright-download.ts ───────────────────────────────────────────────

export async function savePlaywrightDownload(
	download: Download,
	path: string,
): Promise<void> {
	if (download.terminal) throw download.terminal;
	if (!host) throw new Error("pageshim: export host is not bound");
	const r = await host.extractZipEntries(null);
	if (!r?.ok)
		throw new Error(
			`The Claude export archive could not be read: ${r?.error ?? "no result"}`,
		);
	archives.set(path, r);
}

// ── bounded-zip-archive.ts ───────────────────────────────────────────────

// Copied from bounded-zip-archive.ts, which does not export them;
// pageshim.test.mjs fails if the copies drift. Desktop refuses the whole
// archive on any of these names, on a duplicate name, or on a symlink. The
// host does not report symlink bits, so that one check is not ported.
const UNSAFE_ZIP_ENTRY_NAME_RE =
	/(^[/\\])|(\.\.[/\\])|(\.\.$)|(^[A-Za-z]:)|(\\\\)|\0/;
const WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE = /(^|[/\\])\s*\.\.\s*($|[/\\])/;

export function readZipEntriesFromFile(
	fd: number,
	_fileSize: number,
	policy: { maxEntries: number },
) {
	const archive = archives.get(openFiles.get(fd) ?? "");
	if (!archive) throw new Error("pageshim: no extracted archive for this file");
	// Desktop counts every central-directory record, directories included.
	if (archive.names.length > policy.maxEntries)
		throw new Error(
			`ZIP has ${archive.names.length} entries, more than the ${policy.maxEntries} allowed`,
		);
	const seen = new Set<string>();
	for (const name of archive.names) {
		if (
			UNSAFE_ZIP_ENTRY_NAME_RE.test(name) ||
			WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE.test(name)
		)
			throw new Error(
				`zip entry '${name}' has an unsafe name (path traversal, absolute path, drive/UNC root, or embedded NUL)`,
			);
		if (seen.has(name))
			throw new Error(`zip declares more than one entry named '${name}'`);
		seen.add(name);
	}
	const files = archive.names.filter((name) => !name.endsWith("/"));
	return files.map((name) => ({
		name,
		data: () => {
			// The host inflates only .json entries that parse.
			if (!Object.hasOwn(archive.json, name)) return { toString: () => "" };
			const text = JSON.stringify(archive.json[name]);
			return { toString: () => text };
		},
	}));
}

// ── node:fs, node:fs/promises, node:os ───────────────────────────────────

export function openSync(path: string): number {
	if (!archives.has(path)) throw new Error(`ENOENT: ${path}`);
	const fd = nextFd++;
	openFiles.set(fd, path);
	return fd;
}
export function statSync(path: string): { size: number } {
	if (!archives.has(path)) throw new Error(`ENOENT: ${path}`);
	return { size: 0 };
}
export function closeSync(fd: number): void {
	openFiles.delete(fd);
}
export function writeFileSync(): void {}
export const tmpdir = (): string => "/pageshim-tmp";
export async function mkdtemp(prefix: string): Promise<string> {
	return `${prefix}${nextFd++}`;
}
export async function rm(dir: string): Promise<void> {
	for (const path of archives.keys())
		if (path.startsWith(`${dir}/`)) archives.delete(path);
}

// ── node:crypto ──────────────────────────────────────────────────────────

export function randomUUID(): string {
	const b = crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createHash(algorithm: string) {
	if (algorithm !== "sha256")
		throw new Error(`pageshim: createHash(${algorithm}) is not available`);
	const chunks: Uint8Array[] = [];
	return {
		update(data: Uint8Array | string) {
			chunks.push(
				typeof data === "string" ? new TextEncoder().encode(data) : data,
			);
			return this;
		},
		digest(encoding: string) {
			if (encoding !== "hex")
				throw new Error(`pageshim: digest(${encoding}) is not available`);
			const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
			let at = 0;
			for (const c of chunks) {
				all.set(c, at);
				at += c.length;
			}
			return sha256Hex(all);
		},
	};
}

// FIPS 180-4 SHA-256. Synchronous because index.ts hashes synchronously;
// WebCrypto's digest is async only.
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(msg: Uint8Array): string {
	const bitLen = msg.length * 8;
	const padded = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6) >>> 0);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
	view.setUint32(padded.length - 4, bitLen >>> 0);
	const H = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	]);
	const W = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
			const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
			W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = H;
		for (let i = 0; i < 64; i++) {
			const t1 =
				(h +
					(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
					((e & f) ^ (~e & g)) +
					K[i] +
					W[i]) >>>
				0;
			const t2 =
				((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
					((a & b) ^ (a & c) ^ (b & c))) >>>
				0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		H[0] += a;
		H[1] += b;
		H[2] += c;
		H[3] += d;
		H[4] += e;
		H[5] += f;
		H[6] += g;
		H[7] += h;
	}
	return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}
