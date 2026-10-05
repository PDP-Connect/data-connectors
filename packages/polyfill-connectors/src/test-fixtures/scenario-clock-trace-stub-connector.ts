// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture proving the clock-trace record/replay path
 * (subprocess-fetch-preloads.ts's `createClockObserver`/
 * `createTraceReplayClock`) through a REAL spawned subprocess on BOTH
 * sides — not just the pure functions in isolation.
 *
 * Calls `Date.now()` `PDPP_TEST_CLOCK_CALLS` times (default 3, read fresh
 * so a test can drive a different count) and emits one record carrying
 * every value it saw, in order.
 *
 * NOT a byte-for-byte record/replay reproduction proof: the surrounding
 * runtime (`runConnector`'s own protocol/checkpoint bookkeeping) shares
 * the SAME patched `Date`, and makes a DIFFERENT number of its own
 * Date.now() calls before and after this fixture's `collect()` runs
 * between a RECORD invocation (`writeRecordPreload`'s direct, unisolated
 * execution) and a REPLAY invocation (`writeReplayBridgePreload`'s bridge-
 * based execution) — a real, found index-alignment limitation of a
 * process-wide clock trace, not a bug in this fixture. Tests here use
 * `--dump-records` to read back whatever the bridge ACTUALLY produced
 * rather than asserting a hand-predicted value.
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import type { ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream, data) => ({ ok: true, data });

runConnector({
	name: "scenario-clock-trace-stub-connector",
	validateRecord,
	async collect({ emitRecord }) {
		const callCount = Number(process.env.PDPP_TEST_CLOCK_CALLS ?? "3");
		const values: number[] = [];
		for (let i = 0; i < callCount; i += 1) {
			values.push(Date.now());
		}
		await emitRecord("items", { id: "probe", values });
	},
});
