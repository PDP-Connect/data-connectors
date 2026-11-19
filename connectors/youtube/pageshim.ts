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
