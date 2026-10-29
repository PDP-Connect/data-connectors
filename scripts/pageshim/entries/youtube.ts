// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { collectYoutubeBrowser, hasYoutubeSession } from "../../../connectors/youtube/index.ts";
import { youtubePageShimAdapter, collectYoutubeHistoryPageShim } from "../../../connectors/youtube/pageshim.ts";
import { validateRecord } from "../../../connectors/youtube/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";
import { applyRequestedScopeEntries } from "../requested-scope-entries.ts";
declare const PAGESHIM_CONNECTOR_VERSION: string;
const streams = ["profile", "subscriptions", "playlists", "playlist_items", "likes", "watch_later", "watch_history"];
function scopeEntries(page: ShimPage): unknown {
	let read: (() => unknown) | undefined;
	try { read = (page as ShimPage & { requestedScopeEntries?: () => unknown }).requestedScopeEntries; } catch { return undefined; }
	return read?.call(page);
}
(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage, initialState: Record<string, unknown>, supportsState: boolean,
) => runOnPageShim(page, {
	platform: "youtube",
	scopes: streams.map((stream) => "youtube." + stream),
	version: PAGESHIM_CONNECTOR_VERSION,
	loginUrl: "https://www.youtube.com/",
	loginMessage: "Sign in to YouTube, then return here.",
	prepareProbe: async (facade) => { await facade.goto("https://www.youtube.com/"); },
	probe: (facade) => hasYoutubeSession(youtubePageShimAdapter(facade as never)),
	validateRecord,
	prepareRequested: (requested) => applyRequestedScopeEntries(requested, scopeEntries(page), "youtube"),
	collect: async (raw) => {
		const ctx = raw as unknown as Parameters<typeof collectYoutubeBrowser>[0];
		const requested = new Map(ctx.requested);
		requested.delete("watch_history");
		const adapted = youtubePageShimAdapter(ctx.page);
		await collectYoutubeBrowser({ ...ctx, page: adapted, requested });
		if (ctx.requested.has("watch_history")) await collectYoutubeHistoryPageShim({ ...ctx, page: adapted });
	},
	toScope: (_stream, records) => ({ records }),
	emptyScopeFromCheckpoint: true,
	summarize: (scopes) => {
		const details = Object.fromEntries(streams.map((stream) => [stream,
			(scopes["youtube." + stream] as { records?: unknown[] } | undefined)?.records?.length ?? 0]));
		const count = Object.values(details).reduce((sum, value) => sum + value, 0);
		return { count, label: count === 1 ? "record" : "records", details };
	},
}, initialState, supportsState);
