// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for `scaleReplayDelayMs`/`REPLAY_TIME_SCALE`
 * (subprocess-fetch-preloads.ts) — the pure arithmetic
 * `writeReplayBridgePreload`'s generated `.mjs` source applies to every
 * `setTimeout`/`setInterval` delay it intercepts in a replaying subprocess.
 *
 * This is the arithmetic ONLY. The generated preload source itself runs
 * inside a spawned subprocess (a template-literal string, not an importable
 * module) and can't be unit-tested in-process — that end-to-end behavior
 * (relative ordering preserved, a paced replay actually completing fast) is
 * covered by bin/scenario-cli.test.ts instead. The inline copy of this same
 * arithmetic embedded in the generated source (see `writeReplayBridgePreload`'s
 * template literal) MUST stay byte-equivalent to `scaleReplayDelayMs` below —
 * there is no way to import this function into the subprocess, so a change
 * here must be mirrored there by hand (both files carry a doc comment saying
 * so).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createClockObserver,
	createTraceReplayClock,
	REPLAY_TIME_SCALE,
	scaleReplayDelayMs,
	writeRecordPreload,
	writeReplayBridgePreload,
} from "./subprocess-fetch-preloads.ts";

test("REPLAY_TIME_SCALE is 100 (the documented, printed factor)", () => {
	assert.equal(
		REPLAY_TIME_SCALE,
		100,
		"bin/scenario-verify.ts's printed line and this constant must agree",
	);
});

test("scaleReplayDelayMs: scales a typical pacing delay down by REPLAY_TIME_SCALE, rounded up", () => {
	assert.equal(scaleReplayDelayMs(1000), 10, "a 1s pace scales to 10ms");
	assert.equal(scaleReplayDelayMs(20_000), 200, "a 20s pace scales to 200ms");
	assert.equal(
		scaleReplayDelayMs(30_000),
		300,
		"a 30s backoff scales to 300ms",
	);
});

test("scaleReplayDelayMs: relative ordering is preserved — a longer delay still scales to a longer delay", () => {
	const pace = scaleReplayDelayMs(20_000);
	const backoff = scaleReplayDelayMs(30_000);
	assert.ok(
		backoff > pace,
		`a 30s backoff (${String(backoff)}ms scaled) must stay longer than a 20s pace (${String(pace)}ms scaled)`,
	);
});

test("scaleReplayDelayMs: rounds UP (ceil), never down to a false zero for a nonzero delay", () => {
	// 1ms / 100 = 0.01 -> ceil to 1, not floor to 0. A nonzero recorded delay
	// must never scale to a 0ms timer, which some code could misread as "did
	// not wait at all" rather than "waited a negligible amount".
	assert.equal(scaleReplayDelayMs(1), 1);
	assert.equal(scaleReplayDelayMs(50), 1);
	assert.equal(scaleReplayDelayMs(99), 1);
	assert.equal(scaleReplayDelayMs(100), 1);
	assert.equal(scaleReplayDelayMs(101), 2);
});

test("scaleReplayDelayMs: zero and negative delays floor at 0", () => {
	assert.equal(scaleReplayDelayMs(0), 0);
	assert.equal(
		scaleReplayDelayMs(-5),
		0,
		"a nonsensical negative delay must not scale to a negative timer",
	);
});

test("scaleReplayDelayMs: missing/undefined delay (setTimeout(fn) with no delay arg) treats it as 0, not NaN", () => {
	// globalThis.setTimeout(fn) with no delay argument is valid JS (delay
	// defaults to 0 per the HTML/Node timer spec) — the generated preload's
	// inline copy guards this with `(delayMs ?? 0)` before dividing, so
	// undefined must not propagate to NaN and silently break the connector's
	// timer.
	assert.equal(scaleReplayDelayMs(undefined), 0);
});

// ─── createClockObserver: RECORD-time observation is transparent ──────────

test("createClockObserver: now() returns EXACTLY what the real clock returns, unmodified", () => {
	const realValues = [1000, 1001, 1005, 1005, 2000];
	let i = 0;
	const observer = createClockObserver(() => {
		const v = realValues[i];
		i += 1;
		return v as number;
	});
	for (const expected of realValues) {
		assert.equal(
			observer.now(),
			expected,
			"observing must never alter the value the real clock returned",
		);
	}
});

test("createClockObserver: getTrace() accumulates every observed value, in call order", () => {
	const realValues = [42, 7, 7, 1_000_000];
	let i = 0;
	const observer = createClockObserver(() => {
		const v = realValues[i];
		i += 1;
		return v as number;
	});
	for (const _ of realValues) {
		observer.now();
	}
	assert.deepEqual(observer.getTrace(), realValues);
});

test("createClockObserver: getTrace() is empty before any call, and grows by exactly one per call", () => {
	const observer = createClockObserver(() => 123);
	assert.deepEqual(observer.getTrace(), []);
	observer.now();
	assert.equal(observer.getTrace().length, 1);
	observer.now();
	observer.now();
	assert.equal(observer.getTrace().length, 3);
});

test("createClockObserver: a realNow that THROWS propagates, rather than being swallowed into a bogus observed value", () => {
	const observer = createClockObserver(() => {
		throw new Error("clock unavailable");
	});
	assert.throws(() => observer.now(), /clock unavailable/);
	assert.deepEqual(
		observer.getTrace(),
		[],
		"a throwing call must not be recorded as an observation",
	);
});

// ─── createTraceReplayClock: REPLAY-time trace consumption + fallback ─────

test("createTraceReplayClock: consumes the trace IN ORDER, one value per call", () => {
	const clock = createTraceReplayClock([10, 20, 30], 999);
	assert.equal(clock.now(), 10);
	assert.equal(clock.now(), 20);
	assert.equal(clock.now(), 30);
});

test("createTraceReplayClock: once the trace is exhausted, falls back to a 1ms-per-call counter from the trace's LAST value", () => {
	const clock = createTraceReplayClock([10, 20, 30], 999);
	clock.now();
	clock.now();
	clock.now();
	assert.equal(clock.now(), 31, "first overflow call: last trace value + 1");
	assert.equal(clock.now(), 32, "second overflow call: last trace value + 2");
	assert.equal(clock.now(), 33);
});

test("createTraceReplayClock: an EMPTY (declared) trace falls back to fallbackStartMs from the very first call", () => {
	const clock = createTraceReplayClock([], 500);
	assert.equal(clock.now(), 501);
	assert.equal(clock.now(), 502);
});

test("createTraceReplayClock: beyondTraceCount() is 0 while the trace still covers every call", () => {
	const clock = createTraceReplayClock([10, 20, 30], 999);
	clock.now();
	clock.now();
	assert.equal(clock.beyondTraceCount(), 0);
});

test("createTraceReplayClock: beyondTraceCount() increments exactly once per overflow call", () => {
	const clock = createTraceReplayClock([10], 999);
	clock.now();
	assert.equal(clock.beyondTraceCount(), 0);
	clock.now();
	assert.equal(clock.beyondTraceCount(), 1);
	clock.now();
	assert.equal(clock.beyondTraceCount(), 2);
});

test("createTraceReplayClock: an UNDEFINED trace (never recorded — an old scenario) behaves identically value-wise to an empty one, but NEVER counts toward beyondTraceCount", () => {
	const declaredEmpty = createTraceReplayClock([], 500);
	const undeclared = createTraceReplayClock(undefined, 500);
	assert.equal(undeclared.now(), declaredEmpty.now());
	assert.equal(undeclared.now(), declaredEmpty.now());
	assert.equal(undeclared.beyondTraceCount(), 0);
	assert.equal(declaredEmpty.beyondTraceCount(), 2);
});

test("createTraceReplayClock: a one-entry trace consumes that entry, then overflows from it", () => {
	const clock = createTraceReplayClock([777], 1);
	assert.equal(clock.now(), 777, "the single recorded value, exactly");
	assert.equal(
		clock.now(),
		778,
		"first overflow: trace's last (only) value + 1",
	);
	assert.equal(clock.beyondTraceCount(), 1);
});

// ─── A preload's OWN bookkeeping must never read the clock it patches ─────
//
// The index-alignment limitation `ClockTraceExhaustedLimitation` exists to
// disclose (see claims.ts) is only meaningful if, once a preload has
// patched `Date.now()`/`new Date()`, the ONLY code that subsequently reads
// through that patch is the connector's own logic (plus whatever the
// surrounding runtime calls on the connector's behalf, which is identical
// in record and replay by construction — see connector-runtime.ts). If a
// preload's OWN setup code (fetch/HAR-matching bookkeeping, bridge
// handshake, report writers) called the patched clock for its own
// purposes, record and replay would almost certainly call it a DIFFERENT
// number of times before the connector's first call runs (direct,
// unisolated execution vs. bridge/isolated execution are differently
// shaped), silently shifting every trace index — exactly the drift a past
// investigation chased into `node_modules/tsx`'s own module-transform
// loader (see this file's and bin/scenario-verify.ts's history for that
// finding: tsx's loader, not this package's code, is what actually reads
// the patched clock a different number of times under sandboxed vs.
// unisolated execution — not fixable from inside a preload, since tsx is a
// separate `--import` entry, not a module this preload's template can wrap).
// This test guards the part that IS this package's responsibility: that
// neither generated preload's OWN code is ever the source of such drift.
//
// A plain substring scan (not a parser) is deliberate and sufficient here:
// the invariant under test is "this generated source contains no bare,
// no-argument call to the live clock," which is a textual fact about the
// template, not a behavior that needs a running subprocess to observe.
// `new Date(someArg)` (constructing from a known value, e.g. FIXED_NOW_ISO)
// is intentionally NOT flagged — only a bare, argument-less read of the
// live clock is forbidden outside the one designated patch-definition
// block (which legitimately mentions `Date.now`/`new Date` in prose
// comments only, never as an executable bare call — stripped below).
function assertNoBareLiveClockCalls(generatedSrc: string, label: string): void {
	const withoutComments = generatedSrc
		.split("\n")
		.map((line) => line.replace(/\/\/.*$/, ""))
		.join("\n");
	const bareDateNowCalls = withoutComments.match(/\bDate\.now\(\)/g) ?? [];
	const bareNewDateCalls = withoutComments.match(/\bnew Date\(\)/g) ?? [];
	const barePerformanceNowCalls =
		withoutComments.match(/\bperformance\.now\(\)/g) ?? [];
	assert.deepEqual(
		{
			bareDateNowCalls: bareDateNowCalls.length,
			bareNewDateCalls: bareNewDateCalls.length,
			barePerformanceNowCalls: barePerformanceNowCalls.length,
		},
		{ bareDateNowCalls: 0, bareNewDateCalls: 0, barePerformanceNowCalls: 0 },
		`${label}: a generated preload's own bookkeeping must never call the live clock directly (only through the captured real reference, or not at all)`,
	);
}

test("writeRecordPreload: the generated preload's own code never calls Date.now()/new Date()/performance.now() directly", () => {
	const dir = mkdtempSync(join(tmpdir(), "clock-preload-text-check-"));
	try {
		const preloadPath = writeRecordPreload(join(dir, "capture.json"), {
			dir,
		});
		assertNoBareLiveClockCalls(
			readFileSync(preloadPath, "utf8"),
			"writeRecordPreload",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeReplayBridgePreload: the generated preload's own code never calls Date.now()/new Date()/performance.now() directly", () => {
	const dir = mkdtempSync(join(tmpdir(), "clock-preload-text-check-"));
	try {
		const preloadPath = writeReplayBridgePreload("http://127.0.0.1:1/", {
			workspace: { dir },
			fixedNowIso: "2026-01-01T00:00:00.000Z",
			clockTrace: [1, 2, 3],
		});
		assertNoBareLiveClockCalls(
			readFileSync(preloadPath, "utf8"),
			"writeReplayBridgePreload",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
