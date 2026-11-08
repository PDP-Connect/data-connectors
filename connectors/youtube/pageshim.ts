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

import {
	type CapturedExchange,
	createPageExchangeCapture,
	type ExchangeCapturePage,
	type ExchangeRule,
	type PageExchangeCapture,
} from "../../packages/polyfill-connectors/src/page-exchange-capture.ts";
import type {
	HistoryBrowseResponse,
	HistoryResponseSource,
	HistoryResponseSourceDiagnostics,
	HistoryResponseSourceFactory,
} from "./index.ts";

/** The capture's name in the page. */
export const HISTORY_CAPTURE_NAME = "youtube_history";
/** Browse responses buffered between polls before the capture overflows. */
export const HISTORY_CAPTURE_MAX_BUFFERED = 48;
/** The browse endpoint the Desktop tracker reads: page data and continuations. */
export const HISTORY_CAPTURE_RULES: readonly ExchangeRule[] = [{
	url: /^https:\/\/(?:www|m)\.youtube\.com\/youtubei\/v1\/browse(?:[?#]|$)/,
	method: "POST",
}];

function browseResponse(exchange: CapturedExchange): HistoryBrowseResponse {
	return {
		url: () => exchange.url,
		requestJson: () => {
			if (exchange.requestBody === null) throw new Error("youtube_history_request_unreadable");
			return JSON.parse(exchange.requestBody) as unknown;
		},
		status: () => exchange.status,
		json: async () => {
			if (exchange.responseText === null) throw new Error("youtube_history_response_unreadable");
			return JSON.parse(exchange.responseText) as unknown;
		},
	};
}

/**
 * Watch history's browse responses on PageShim, from the shared in-page
 * capture. The capture is created before the history page loads (so a host
 * with page_init_script runs it at document start) and attached after.
 * Responses reach the Desktop tracker on each poll, in arrival order. A
 * full buffer, a replaced document or an unreadable drain makes the source
 * incomplete, so the walk cannot claim the list ended. When the capture was
 * installed after load, a continuation the page sent before then is missed;
 * the tracker then cannot correlate later tokens and fails closed.
 */
export function pageShimHistoryResponses(page: ExchangeCapturePage): HistoryResponseSourceFactory {
	return (): HistoryResponseSource => {
		let capture: PageExchangeCapture | null = null;
		let listener: ((response: HistoryBrowseResponse) => void) | null = null;
		let generation = 0;
		const state: HistoryResponseSourceDiagnostics = {
			mode: null, attached: false, earlyTrafficMissed: null,
			overflowed: false, documentReplaced: false, drainFailed: false,
		};
		const attach = async (): Promise<void> => {
			if (!capture || generation !== 0) return;
			const attached = await capture.attach().catch(() => null);
			if (!attached) return;
			generation = attached.generation;
			state.attached = true;
			state.earlyTrafficMissed = attached.earlyTrafficMissed;
		};
		return {
			listen(next) {
				listener = next;
			},
			dispose() {
				listener = null;
			},
			async beforeNavigation() {
				capture = await createPageExchangeCapture(page, {
					name: HISTORY_CAPTURE_NAME,
					rules: HISTORY_CAPTURE_RULES,
					maxBuffered: HISTORY_CAPTURE_MAX_BUFFERED,
				});
				state.mode = capture.mode;
			},
			afterNavigation: attach,
			async poll() {
				// A document that was still loading may have refused the install.
				await attach();
				if (!capture || generation === 0) return;
				let drain;
				try {
					drain = await capture.drain();
				} catch {
					state.drainFailed = true;
					return;
				}
				state.overflowed ||= drain.overflowed;
				if (drain.documentReplaced || drain.generation !== generation) state.documentReplaced = true;
				for (const exchange of drain.exchanges) {
					if (exchange.generation !== generation) {
						state.documentReplaced = true;
						continue;
					}
					listener?.(browseResponse(exchange));
				}
			},
			get complete() {
				return state.attached && !state.overflowed && !state.documentReplaced && !state.drainFailed;
			},
			get diagnostics() {
				return { ...state };
			},
		};
	};
}
