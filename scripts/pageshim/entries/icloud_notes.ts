// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { collectAllStreams, probeICloudNotesSession } from "../../../connectors/icloud_notes/index.ts";
import { validateRecord } from "../../../connectors/icloud_notes/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_CONNECTOR_VERSION: string;

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage, initialState: Record<string, unknown>, supportsState: boolean,
) => runOnPageShim(page, {
	platform: "icloud_notes",
	scopes: ["icloud_notes.profile", "icloud_notes.notes", "icloud_notes.folders"],
	version: PAGESHIM_CONNECTOR_VERSION,
	loginUrl: "https://www.icloud.com/notes",
	loginMessage: "Sign in to iCloud Notes, then return here.",
	prepareProbe: async (pw) => { await pw.goto("https://www.icloud.com/notes"); },
	probe: (pw) => probeICloudNotesSession(pw as never),
	validateRecord,
	collect: (ctx) => collectAllStreams(ctx as never),
	emptyScopeFromCheckpoint: true,
	toScope: (_stream, records) => ({ records }),
	summarize: (scopes) => {
		const count = Object.values(scopes).reduce<number>((total, scope) =>
			total + ((scope as { records?: unknown[] }).records?.length ?? 0), 0);
		return { count, label: count === 1 ? "item" : "items", details: count + " iCloud items" };
	},
}, initialState, supportsState);
