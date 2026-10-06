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
 * HISTORY: an earlier version of the clock-trace mechanism armed
 * observation/replay at PROCESS START rather than at the connector's own
 * START message, so module loading — most of it `tsx`'s own TypeScript-
 * transform work for this file and its dependents, via a persistent
 * on-disk cache with a DIFFERENT hit/miss shape under record's unisolated
 * execution vs. replay's sandboxed one — called the patched `Date.now()`/
 * `new Date()` a different number of times before this fixture's
 * `collect()` even ran, shifting which trace index its 3 real calls
 * landed on between record and replay. Fixed two ways, both entirely
 * tooling-side (no hook, call, or any other change to connector-
 * runtime.ts or any other shipped connector-artifact file): each
 * preload's own armOnStartLine peeks at this process's OWN stdin for
 * the START line (see writeRecordPreload/writeReplayBridgePreload,
 * subprocess-fetch-preloads.ts) and arms observation/replay at that
 * point — identical in both modes, module-loading work never traced —
 * without consuming or altering what connector-runtime.ts's own
 * readline interface reads from the same stream; and `TSX_DISABLE_CACHE`
 * (set in both `bin/scenario-record.ts` and `bin/scenario-verify.ts`)
 * disables tsx's cache in both subprocesses so its loader's own clock
 * reads, if any remain, are at least equal.
 * `bin/scenario-verify-strict.test.ts`'s "an UNMODIFIED record/replay
 * roundtrip" test proves this fixture's 3 values now replay EXACTLY from
 * the trace, with no fallback/synthesis. Tests here also use
 * `--dump-records` to read back whatever the bridge ACTUALLY produced
 * rather than asserting a hand-predicted value, which is how the
 * original index-alignment drift was found in the first place.
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
