// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic COROS answers, real connector runtime. Run only as a test subprocess.
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { corosApi } from "./fake-coros.ts";
import { type CorosCollectContext, collectCorosBrowser } from "./index.ts";
import { validateRecord } from "./schemas.ts";

export const NOW = new Date("2026-11-10T18:00:00.000Z");
const api = corosApi();

/** On Training Hub's origin and signed in to the US region: every read answers as the fake account would. */
const page = {
	goto: async () => null,
	evaluate: async (_fn: unknown, arg: { path: string }) => ({
		kind: "response",
		retryAfter: null,
		region: 1,
		...api(arg.path),
	}),
} as unknown as CorosCollectContext["page"];

// The connector's own name, so its manifest's consent fields bound each stream.
runConnector({
	name: "coros_browser",
	validateRecord,
	collect: (ctx) =>
		collectCorosBrowser(
			{ ...ctx, page },
			{ requestDelayMs: 0, refreshSettleMs: 0, sleep: async () => {} },
			NOW,
		),
});
