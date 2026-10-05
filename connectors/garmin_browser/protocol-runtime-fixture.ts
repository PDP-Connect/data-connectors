// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic Garmin answers, real connector runtime. Run only as a test subprocess.
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { garminApi } from "./fake-garmin.ts";
import {
	collectGarminBrowser,
	type GarminCollectContext,
	timeRangeFieldFor,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

export const NOW = new Date("2026-09-20T13:30:00.000Z");
const api = garminApi();

/** On the app's origin and signed in: every read answers as the fake account would. */
const page = {
	goto: async () => null,
	evaluate: async (_fn: unknown, arg: { path: string }) => ({
		kind: "response",
		retryAfter: null,
		...api(arg.path),
	}),
} as unknown as GarminCollectContext["page"];

runConnector({
	name: "garmin_browser_synthetic_runtime",
	validateRecord,
	timeRangeField: timeRangeFieldFor,
	collect: (ctx) =>
		collectGarminBrowser(
			{ ...ctx, page },
			{ requestDelayMs: 0, sleep: async () => {} },
			NOW,
		),
});
