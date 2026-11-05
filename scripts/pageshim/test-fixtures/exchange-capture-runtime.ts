// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A synthetic connector that drives createPageExchangeCapture through the
// PageShim page API against the synthetic app in exchange-capture.test.mjs.
// Each step is emitted as one record, so the test can assert what the
// capture saw on a host with and without page_init_script.

import {
	type ExchangeDrain,
	createPageExchangeCapture,
} from "../../../packages/polyfill-connectors/src/page-exchange-capture.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

const APP = "https://capture.test/app";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const summary = (drain: ExchangeDrain) => ({
	generation: drain.generation,
	earlyTrafficMissed: drain.earlyTrafficMissed,
	overflowed: drain.overflowed,
	documentReplaced: drain.documentReplaced,
	exchanges: drain.exchanges.map((exchange) => ({
		seq: exchange.seq,
		generation: exchange.generation,
		path: new URL(exchange.url).pathname,
		transport: exchange.transport,
		method: exchange.method,
		requestBody: exchange.requestBody,
		requestHeaders: exchange.requestHeaders,
		status: exchange.status,
		responseText: exchange.responseText,
	})),
});

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: ["chatgpt.messages"],
		version: "test",
		loginUrl: "https://capture.test/login",
		loginMessage: "login",
		validateRecord: (_stream, data) => ({ ok: true, data }) as never,
		probe: async () => true,
		collect: async ({ page: facade, emitRecord }) => {
			let step = 0;
			const emitStep = (name: string, value: Record<string, unknown>) =>
				emitRecord("messages", { id: `step-${++step}`, step: name, ...value });
			const capture = await createPageExchangeCapture(facade, {
				name: "harness",
				maxBuffered: 3,
				rules: [{ url: /^https:\/\/capture\.test\/api\//, requestHeaders: ["x-op"] }],
			});
			// Drain until `done` holds or the wait runs out; merge what was read.
			const drainUntil = async (done: (drain: ExchangeDrain) => boolean) => {
				let merged: ExchangeDrain | null = null;
				for (let poll = 0; poll < 50; poll += 1) {
					const drain = await capture.drain();
					merged = { ...drain, exchanges: [...(merged?.exchanges ?? []), ...drain.exchanges] };
					if (done(merged)) break;
					await wait(100);
				}
				return summary(merged as ExchangeDrain);
			};
			const has = (path: string) => (drain: ExchangeDrain) =>
				drain.exchanges.some((exchange) => new URL(exchange.url).pathname === path);

			await facade.goto(APP);
			await emitStep("attach", { mode: capture.mode, attach: await capture.attach() });
			await facade.evaluate("(() => { window.scrollTo(0, 3000); return true; })()");
			await emitStep("scroll", { drain: await drainUntil(has("/api/next")) });
			await facade.evaluate("window.__burst(5)");
			await wait(1500);
			await emitStep("burst", { drain: await drainUntil((drain) => drain.exchanges.length >= 3) });
			await facade.goto(APP);
			await emitStep("replaced", {
				drain: await drainUntil((drain) => drain.generation === 0 || has("/api/first")(drain)),
			});
			await emitStep("reattach", { attach: await capture.attach() });
		},
		toScope: (_stream, records) => ({ records }),
		summarize: (scopes) => {
			const count = (scopes["chatgpt.messages"] as { records?: unknown[] } | undefined)?.records?.length ?? 0;
			return { count, label: "steps", details: {} };
		},
	});
