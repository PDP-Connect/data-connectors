// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the desktop anthropic connector (collectAnthropic with the production
// makeEmitRecord) in Node against the same fixtures as the pageshim harness,
// so pageshim.test.mjs can compare the two record sets. The page is a fake:
// evaluate() runs in this process with fetch routed to resolveFixture, and
// goto() of the export URL fires a Playwright-style download of the archive.

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFixture } from "./anthropic.mjs";

const scratchRoot = fileURLToPath(new URL("../../../.tmp/pageshim/", import.meta.url));
mkdirSync(scratchRoot, { recursive: true });
process.env.PDPP_BLOB_SPOOL_DIR ??= mkdtempSync(join(scratchRoot, "blobs-"));

const { collectAnthropic } = await import(
	"../../../connectors/anthropic/index.ts"
);
const { validateRecord } = await import(
	"../../../connectors/anthropic/schemas.ts"
);
const { makeEmitRecord } = await import(
	"../../../packages/polyfill-connectors/src/connector-runtime.ts"
);
const { makeRecordingEmit } = await import(
	"../../../packages/polyfill-connectors/src/test-harness.ts"
);

const fixtureFetch = async (url) => {
	const r = resolveFixture(String(url));
	return new Response(r.body, {
		status: r.status,
		headers: { "content-type": r.contentType },
	});
};

class FakePage extends EventEmitter {
	constructor(zip) {
		super();
		this.zip = zip;
	}
	async goto(url) {
		if (new URL(url).pathname.includes("/export/")) {
			const download = {
				saveAs: (path) => writeFile(path, this.zip),
				suggestedFilename: () => "export.zip",
			};
			queueMicrotask(() => this.emit("download", download));
		}
		return null;
	}
	async evaluate(fn, arg) {
		// The fixture home page's user menu: name, then plan.
		const spans = [{ textContent: "Sample User" }, { textContent: "Pro plan" }];
		const button = {
			querySelector: () => spans[0],
			querySelectorAll: () => spans,
		};
		const realFetch = globalThis.fetch;
		globalThis.document = { querySelector: () => button };
		globalThis.fetch = fixtureFetch;
		try {
			return await fn(arg);
		} finally {
			globalThis.fetch = realFetch;
			delete globalThis.document;
		}
	}
}

/**
 * Desktop RECORD data per stream (`claude.<stream>` keys), with `blob_ref`
 * removed because the PageShim host has no blob store.
 */
export async function desktopRecords(zip, streams) {
	const harness = makeRecordingEmit(validateRecord);
	const scopeStreams = streams.map((name) => ({ name }));
	const requested = new Map(scopeStreams.map((s) => [s.name, s]));
	const selector = makeEmitRecord({
		requested,
		emit: harness.emit,
		emittedAt: "2026-01-01T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => "date",
	});
	await collectAnthropic({
		page: new FakePage(zip),
		requested,
		scope: { streams: scopeStreams },
		state: {},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		isRecordSelected: selector.isSelected,
		emittedAt: "2026-01-01T00:00:00.000Z",
		progress: async () => {},
	});
	const out = Object.fromEntries(streams.map((s) => [`claude.${s}`, []]));
	for (const m of harness.events) {
		if (m.kind === "record-skipped")
			throw new Error(`desktop record failed its schema: ${m.stream}`);
		if (m.kind !== "record") continue;
		const { blob_ref: _, ...data } = m.data;
		out[`claude.${m.stream}`].push(data);
	}
	return out;
}
