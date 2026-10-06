// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only protocol entry: real runtime envelopes around a routed browser DOM.
import { chromium } from "playwright";
import { runConnector } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectYoutubeBrowser } from "../index.ts";
import { validateRecord } from "../schemas.ts";

runConnector({
	name: "youtube-browser-protocol-fixture",
	timeRangeField: (stream) =>
		stream === "watch_history" ? "watched_date" : "date",
	validateRecord,
	async collect(ctx) {
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			await page.route("https://www.youtube.com/**", async (route) => {
				const row = (date: string, video: string) =>
					`<ytd-item-section-renderer><ytd-item-section-header-renderer><div id="header"><div id="title">${date}</div></div></ytd-item-section-header-renderer><yt-lockup-view-model><a href="/watch?v=${video}"></a><h3 title="Real title"></h3></yt-lockup-view-model></ytd-item-section-renderer>`;
				// The page data lists all four videos and no next page: the source's end.
				const pageData = {
					contents: {
						twoColumnBrowseResultsRenderer: {
							tabs: [
								{
									tabRenderer: {
										selected: true,
										content: {
											sectionListRenderer: {
												contents: [1, 2, 3, 4].map(() => ({
													lockupViewModel: {},
												})),
											},
										},
									},
								},
							],
						},
					},
				};
				const html =
					row("Sep 21, 2026", "olderVideo") +
					row("Sep 22, 2026", "inRangeVideo") +
					row("Unknown", "unknownVideo") +
					row("Sep 23, 2026", "endVideo") +
					`<script>var ytInitialData = ${JSON.stringify(pageData)};</script>`;
				await route.fulfill({
					contentType: "text/html",
					body: `<html><body>${html}</body></html>`,
				});
			});
			const fastPage = new Proxy(page, {
				get(target, key) {
					if (key === "waitForTimeout") return async () => undefined;
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			await collectYoutubeBrowser({ ...ctx, page: fastPage as never });
		} finally {
			await browser.close();
		}
	},
});
