// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

// Connector-local adapters use only the documented PageShim facade. They do
// not probe absent members (which the mobile harness records as stub hits).
type Page = BrowserCollectContext["page"];
export function youtubePageShimAdapter(facade: Pick<Page, "goto" | "evaluate" | "waitForFunction">): Page {
	return {
		goto: (url: string, options?: unknown) => facade.goto(url, options as never),
		evaluate: facade.evaluate.bind(facade),
		waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		locator: (selector: string) => ({
			count: () => facade.evaluate((value) => document.querySelectorAll(value).length, selector),
			first: () => ({
				click: () => facade.evaluate((value) => {
					const element = document.querySelector<HTMLElement>(value);
					if (!element) throw new Error("youtube_click_target_missing");
					element.click();
				}, selector),
			}),
		}),
		waitForFunction: async (fn: Parameters<Page["evaluate"]>[0], arg: unknown, options?: { timeout?: number }) => {
			const handle = await facade.waitForFunction(fn as never, arg, options);
			// The facade only returns dispose; reread rather than claiming the
			// unsupported JSHandle.jsonValue capability.
			return { dispose: () => handle.dispose(), jsonValue: () => facade.evaluate(fn, arg) };
		},
	} as unknown as Page;
}

import { collectYoutubeBrowser, hasYoutubeSession, youtubeRecordId, parseCount, resolveWatchedDate, videoIdentity } from "./index.ts";
import { readVideos } from "./browser-dom.ts";
import { readListEnd, enumerationEnded } from "./page-evidence.ts";

// Without correlated response/DOM evidence, history is a bounded prefix, not
// an inventory. No cursor is emitted for this partial mobile read.
export async function collectYoutubeHistoryPageShim(ctx: Parameters<typeof collectYoutubeBrowser>[0]): Promise<void> {
	const stream = "watch_history";
	if (ctx.requested.get(stream)?.time_range) {
		await ctx.emit({ type: "SKIP_RESULT", stream, reason: "scope_not_supported",
			message: "Watch history provides dates without watch times, so a time_range cannot be applied.",
			recovery_hint: { action: "not_retriable", retryable: false } });
		return;
	}
	const incomplete = () => ctx.emit({ type: "SKIP_RESULT", stream,
		reason: "inventory_not_proven_complete",
		message: "inventory_not_proven_complete: Mobile history has no correlated continuation response evidence; only the visible prefix was read.",
		recovery_hint: { action: "retry_by_runtime", retryable: true } });
	try {
		await ctx.page.goto("https://www.youtube.com/feed/history");
		if (!(await hasYoutubeSession(ctx.page))) { await incomplete(); return; }
		const end = await ctx.page.evaluate(readListEnd as never, { kind: "history", sessionPresent: true }) as unknown as ReturnType<typeof readListEnd>;
		if (end.pageBlocked) { await incomplete(); return; }
		const batch = await ctx.page.evaluate(readVideos as never, { mode: "history", offset: 0, limit: 50 }) as unknown as import("./browser-dom.ts").HistoryVideoPage;
		if (batch.totalRows === 0 && end.verifiedEmpty && enumerationEnded(end, 0)) {
			const finalEnd = await ctx.page.evaluate(readListEnd as never, {
				kind: "history", sessionPresent: await hasYoutubeSession(ctx.page),
			}) as unknown as ReturnType<typeof readListEnd>;
			if (!finalEnd.verifiedEmpty || !enumerationEnded(finalEnd, 0)) { await incomplete(); return; }
			await ctx.emit({ type: "STATE", stream, cursor: { verified_empty_at: new Date().toISOString(), evidence: "youtube_page_data_empty" } });
			return;
		}
		const browserDate = await ctx.page.evaluate(() => { const d = new Date(); return [d.getFullYear(), d.getMonth(), d.getDate()]; });
		const date = new Date(browserDate[0]!, browserDate[1]!, browserDate[2]!, 12);
		const seen = new Set<string>();
		for (const [position, video] of batch.rows.entries()) {
			if (!video) break;
			const identity = videoIdentity(video);
			if (seen.has(identity)) continue;
			seen.add(identity);
			await ctx.emitRecord(stream, {
				id: await youtubeRecordId("history|" + identity), position,
				watched_date: resolveWatchedDate(video.watched_date_label ?? null, date),
				watched_date_label: video.watched_date_label ?? null,
				video_id: video.video_id, video_url: video.video_url, video_title: video.video_title,
				channel_title: video.channel_title, channel_url: video.channel_url,
				view_count: parseCount(video.views_text), views_text: video.views_text ?? null,
				description: video.description,
			});
		}
		await incomplete();
	} catch { await incomplete(); }
}
