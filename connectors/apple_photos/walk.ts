// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Dir, Stats } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { isBeforeCursor, SUPPORTED_EXTENSIONS } from "./parsers.ts";
import type { DiscoveredFile } from "./types.ts";

const NON_MEDIA_MACOS_METADATA = new Set([
	".DS_Store",
	".Spotlight-V100",
	".fseventsd",
	".Trashes",
	".AppleDouble",
	".TemporaryItems",
	".DocumentRevisions-V100",
]);

function hasSupportedExtension(filename: string): boolean {
	const lower = filename.toLowerCase();
	for (const ext of SUPPORTED_EXTENSIONS) {
		if (lower.endsWith(ext)) {
			return true;
		}
	}
	return false;
}

/**
 * Recursively walk `dir`, yielding one DiscoveredFile per supported media
 * file. Uses async iteration over opendir so entries are streamed rather
 * than materialized into one giant array.
 */
export async function* walkDir(
	dir: string,
	unsupported: Map<string, number>,
	since: string | undefined,
	statFile: (path: string) => Promise<Pick<Stats, "mtime" | "size">> = stat,
	openDir: (path: string) => Promise<Dir> = opendir,
): AsyncGenerator<DiscoveredFile> {
	// The root must open; a failure there is the caller's error to report.
	yield* walkOpened(
		await openDir(dir),
		dir,
		unsupported,
		since,
		statFile,
		openDir,
	);
}

async function* walkOpened(
	handle: Dir,
	dir: string,
	unsupported: Map<string, number>,
	since: string | undefined,
	statFile: (path: string) => Promise<Pick<Stats, "mtime" | "size">>,
	openDir: (path: string) => Promise<Dir>,
): AsyncGenerator<DiscoveredFile> {
	for await (const entry of handle) {
		const entryPath = join(dir, entry.name);
		// macOS keeps these as directories as well as files; skip both.
		if (NON_MEDIA_MACOS_METADATA.has(entry.name)) {
			continue;
		}
		if (entry.isDirectory()) {
			let child: Dir;
			try {
				child = await openDir(entryPath);
			} catch (error) {
				// A folder removed mid-walk is no longer there to read.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
			yield* walkOpened(
				child,
				entryPath,
				unsupported,
				since,
				statFile,
				openDir,
			);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		if (!hasSupportedExtension(entry.name)) {
			if (since !== undefined) {
				let modified: string;
				try {
					modified = (await statFile(entryPath)).mtime.toISOString();
				} catch (error) {
					// A file removed mid-walk is no longer there to skip.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw error;
				}
				if (isBeforeCursor(modified, since)) continue;
			}
			const extension = extname(entry.name).toLowerCase();
			// Do not put arbitrary suffix text, names, or paths in a diagnostic.
			const bucket = /^\.[a-z0-9]{1,12}$/.test(extension)
				? extension
				: extension
					? "(other extension)"
					: "(no extension)";
			unsupported.set(bucket, (unsupported.get(bucket) ?? 0) + 1);
			continue;
		}
		let st: Awaited<ReturnType<typeof statFile>>;
		try {
			st = await statFile(entryPath);
		} catch (error) {
			// A photo removed mid-walk is gone; any other stat failure is real.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		yield {
			path: entryPath,
			sizeBytes: st.size,
			mtimeIso: st.mtime.toISOString(),
		};
	}
}
