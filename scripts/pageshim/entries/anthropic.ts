// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// anthropic (Claude data export) on PageShim. Mobile has no legacy Claude
// script, so the result shape is new: each scope is {records: [...]}, the
// PDPP records of that stream.
//
// The export download and ZIP read go through the host's captureDownload
// and extractZipEntries; see ../shims/anthropic-export.ts. The host can pass
// committed STATE between runs. The connector emits checkpoints for old-format
// pending exports, but not one-shot URLs from newer multi-part exports.
import { collectAnthropic } from "../../../connectors/anthropic/index.ts";
import { validateRecord } from "../../../connectors/anthropic/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";
import {
	bindExportHost,
	type ExportHostPage,
	withExportDownloads,
} from "../shims/anthropic-export.ts";

// Defined by build.mjs from connectors/anthropic/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

const CLAUDE_ORIGIN = "https://claude.ai";
const STREAMS = [
	"account_profile",
	"conversations",
	"messages",
	"projects",
	"project_documents",
];

// index.ts spools each source object here. The shim discards the bytes.
process.env.PDPP_BLOB_SPOOL_DIR = "/pageshim-blobs";

type Facade = {
	goto: (url: string) => Promise<unknown>;
	evaluate: (code: string) => Promise<unknown>;
};

/** Desktop reads the HttpOnly session cookie from the browser context. The
 * PageShim has no context, so ask Claude's API from the claude.ai document. */
async function probe(page: Facade): Promise<boolean> {
	if ((await page.evaluate("location.origin")) !== CLAUDE_ORIGIN)
		await page.goto(`${CLAUDE_ORIGIN}/new`);
	const ok = await page.evaluate(
		`fetch("${CLAUDE_ORIGIN}/api/organizations", { credentials: "include" })
			.then(async (r) => r.ok && Array.isArray(await r.json()))
			.catch(() => false)`,
	);
	return ok === true;
}

const count = (scope: unknown): number => {
	const records = (scope as { records?: unknown[] } | undefined)?.records;
	return Array.isArray(records) ? records.length : 0;
};

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
) => {
	bindExportHost(page as ExportHostPage);
	return runOnPageShim(page, {
		platform: "claude",
		scopes: STREAMS.map((s) => `claude.${s}`),
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: `${CLAUDE_ORIGIN}/login`,
		loginMessage: "Sign in to Claude, then return here.",
		validateRecord,
		probe: (facade) => probe(facade as never),
		collect: (ctx) =>
			collectAnthropic({
				...ctx,
				page: withExportDownloads(ctx.page as object),
			} as never),
		// blob_ref names a host blob that this host does not store; drop it
		// rather than hand the app a reference it cannot resolve.
		toScope: (_stream, records) => ({
			records: records.map(({ blob_ref: _blobRef, ...record }) => record),
		}),
		summarize: (scopes) => {
			const details = Object.fromEntries(
				STREAMS.map((s) => [s, count(scopes[`claude.${s}`])]),
			);
			const conversations = details.conversations;
			return {
				count: conversations,
				label: conversations === 1 ? "conversation" : "conversations",
				details,
			};
		},
	}, initialState);
};
