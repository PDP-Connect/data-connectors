// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic WHOOP answers, real connector runtime. Run only as a test subprocess.
import { readFileSync } from "node:fs";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectWhoopBrowser, type WhoopCollectContext } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const bootstrap = fixture("bootstrap.json");
const cycles = fixture("cycles-details.json");
export const NOW = new Date("2026-09-20T12:00:00.000Z");

/** On the app's origin and signed in: every read answers its fixture. */
const page = {
	goto: async () => null,
	evaluate: async (_fn: unknown, arg: { path: string }) => ({
		kind: "response",
		status: 200,
		url: "",
		contentType: "application/json",
		retryAfter: null,
		body: arg.path.startsWith("/users-service") ? bootstrap : cycles,
	}),
} as unknown as WhoopCollectContext["page"];

runConnector({
	name: "whoop_browser_synthetic_runtime",
	validateRecord,
	timeRangeField: "start_at",
	collect: (ctx) =>
		collectWhoopBrowser(
			{ ...ctx, page },
			{ requestDelayMs: 0, sleep: async () => {} },
			NOW,
		),
});
