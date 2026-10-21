// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared test harness for connector integration tests.
 *
 * Every integration test needs a fake `emit` + `emitRecord` pair that
 * captures what the collect() layer would push over the wire. Until
 * this file existed, each connector rolled its own, and the hand-rolled
 * `emitRecord` skipped the zod shape-check that the production runtime
 * applies. That meant a record that would SKIP_RESULT in production
 * silently landed in `.emitted` inside tests — tests looked green,
 * truth looked different.
 *
 * `makeRecordingEmit(validateRecord)` fixes that. It mirrors the
 * runtime's RECORD path: records that pass the zod check land in
 * `.emitted`; records that fail land in `.skipped`. Pass no validator
 * and you get pass-through mode for tests where the shape-check isn't
 * what's under test (e.g. pure scope-filter gates).
 *
 * This module has no side effects at import time. It exports only
 * factories and pure helpers.
 */

import { spawn } from "node:child_process";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { stringifyForJsonl } from "@pdpp/connector-protocol";
import type {
	DetailGapStartEntry,
	EmittedMessage,
	RecordData,
	ValidateRecord,
} from "./connector-runtime.ts";

const VM_RSS_STATUS_RE = /VmRSS:\s*(\d+)\s*kB/;

/** Parent pid and start time (in clock ticks since boot) from /proc/<pid>/stat. */
function readProcStat(
	pid: number,
): { parentPid: number; startTime: string } | null {
	try {
		const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
		// Fields after the command name, which may itself contain ") ".
		const fields = stat
			.slice(stat.lastIndexOf(")") + 1)
			.trim()
			.split(/\s+/u);
		const parentPid = Number(fields[1]);
		const startTime = fields[19];
		if (!Number.isSafeInteger(parentPid) || startTime === undefined)
			return null;
		return { parentPid, startTime };
	} catch {
		return null; // The process exited while /proc was being read.
	}
}

// Best effort: called from timer and stream callbacks, so it must never throw.
// A pid is signalled only if it still has the start time seen in the scan, so
// a descendant that exited and whose pid was reused is left alone.
function killLinuxProcessTree(rootPid: number): void {
	const kill = (pid: number, startTime?: string): void => {
		if (startTime !== undefined && readProcStat(pid)?.startTime !== startTime) {
			return;
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone (ESRCH) or not ours to signal (EPERM).
		}
	};

	for (let pass = 0; pass < 2; pass += 1) {
		const childrenByParent = new Map<
			number,
			{ pid: number; startTime: string }[]
		>();
		let entries: Dirent[];
		try {
			entries = readdirSync("/proc", { withFileTypes: true });
		} catch {
			break;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
			const pid = Number(entry.name);
			const stat = readProcStat(pid);
			if (!stat) continue;
			const children = childrenByParent.get(stat.parentPid) ?? [];
			children.push({ pid, startTime: stat.startTime });
			childrenByParent.set(stat.parentPid, children);
		}

		const descendants: { pid: number; startTime: string }[] = [];
		const pending = [rootPid];
		const seen = new Set(pending);
		while (pending.length > 0) {
			const parentPid = pending.shift();
			if (parentPid === undefined) continue;
			for (const child of childrenByParent.get(parentPid) ?? []) {
				if (seen.has(child.pid)) continue;
				seen.add(child.pid);
				descendants.push(child);
				pending.push(child.pid);
			}
		}

		for (const { pid, startTime } of descendants.reverse())
			kill(pid, startTime);
	}

	kill(rootPid);
}

/** A record that passed (or bypassed) shape-check and would flow
 *  downstream as a RECORD in production. */
export interface EmittedRecord {
	data: RecordData;
	stream: string;
}

/** A record that failed shape-check — the runtime would convert this
 *  to a SKIP_RESULT. Tests can assert on `.skipped` to catch fixture
 *  drift. */
export interface SkippedRecord {
	issues: Array<{ message: string; path: string }>;
	stream: string;
}

/** A single event in the unified call-order trace. `.events` interleaves
 *  emitRecord() calls and emit() calls in the order the helper made
 *  them. Needed when a test has to prove something like "STATE emitted
 *  AFTER the last RECORD" — the separate `.emitted` / `.protocolMessages`
 *  arrays can't express cross-kind ordering because they're two lists
 *  with no shared sequence. */
export type RecordedEvent =
	| { kind: "record"; stream: string; data: RecordData; skipped: false }
	| {
			kind: "record-skipped";
			stream: string;
			issues: Array<{ message: string; path: string }>;
			skipped: true;
	  }
	| { kind: "message"; message: EmittedMessage };

export interface RecordingEmit {
	emit: (msg: EmittedMessage) => Promise<void>;
	emitRecord: (
		stream: string,
		data: RecordData,
		options?: { beforeEmit?: () => Promise<void> } | "id" | "name",
	) => Promise<void>;
	emitted: EmittedRecord[];
	/** Unified time-ordered trace of every emit() and emitRecord() call,
	 *  in invocation order. Use this when the assertion is cross-kind
	 *  ordering (e.g. "STATE lands after the last RECORD"). */
	events: RecordedEvent[];
	protocolMessages: EmittedMessage[];
	skipped: SkippedRecord[];
}

export interface ConnectorSubprocessResult {
	code: number | null;
	messages: EmittedMessage[];
	/** Peak resident set size (bytes) sampled from /proc/<pid>/status while
	 *  the child ran, at `peakRssPollIntervalMs` resolution. `null` when
	 *  `peakRssPollIntervalMs` was not requested, or on a platform without
	 *  /proc (non-Linux) — callers that need this proof should assert it is
	 *  non-null rather than silently skip on an unsupported platform, so a
	 *  CI environment that can't run the check is visible, not silently
	 *  green. A sampled peak (not a V8 heap-limit flag): --max-old-space-size
	 *  only bounds the V8-managed heap, NOT Buffer/ArrayBuffer allocations
	 *  (Buffers live in Node's external/arrayBuffers memory) — the exact
	 *  allocation shape a whole-file readFile()/ZipEntry.data() produces. RSS
	 *  sampling has no such blind spot: it measures real process memory
	 *  regardless of which allocator produced it. */
	peakRssBytes: number | null;
	rawStdout: string;
	signal: NodeJS.Signals | null;
	stderr: string;
}

export interface ConnectorSubprocessOptions {
	allowFailedDone?: boolean;
	cwd: string;
	entrypoint: string;
	env?: NodeJS.ProcessEnv;
	/** When set, poll /proc/<pid>/status at this interval (ms) for VmRSS and
	 *  report the peak via the result's `peakRssBytes`. Opt-in: the extra
	 *  poll timer is pure overhead for the many tests that don't need a
	 *  memory proof. */
	peakRssPollIntervalMs?: number;
	/** Set false for a run whose stdout is too large to hold twice: `rawStdout`
	 *  is then "" and `messages` is unchanged. Callers that assert on
	 *  `rawStdout` must keep the default (true). */
	retainRawStdout?: boolean;
	start: {
		collection_scope?: string;
		/** Mirrors the real runtime's START `collection_mode` field, so a test can
		 *  exercise the owner-triggered full-refresh bypass end to end rather than
		 *  reaching past the wire to construct a CollectContext by hand. */
		collection_mode?: "full_refresh" | "incremental";
		/** Currently-pending detail gaps to replay on START, mirroring the real runtime's `detail_gaps` field. */
		detail_gaps?: readonly DetailGapStartEntry[];
		scope: {
			streams: Array<{
				name: string;
				resources?: string[];
				time_range?: { since?: string; until?: string };
			}>;
		};
		state?: Record<string, unknown>;
		type: "START";
	};
	timeoutMs?: number;
}

/**
 * Returns an emit/emitRecord pair that validates records through
 * `validateRecord`. Records that pass land in `.emitted`; records that
 * fail land in `.skipped` (same semantics as the runtime's RECORD
 * shape-check). The `.emit` side-channel records any direct protocol
 * messages (PROGRESS, STATE, SKIP_RESULT, INTERACTION) the helper
 * under test emits.
 *
 * If `validateRecord` is omitted, `emitRecord` is pass-through — useful
 * for tests where the helper is a pure function and the shape-check
 * isn't the point (e.g. scope-filter gates, ordering invariants on
 * synthetic data that intentionally omits fields).
 */
export function makeRecordingEmit(
	validateRecord?: ValidateRecord,
): RecordingEmit {
	const emitted: EmittedRecord[] = [];
	const skipped: SkippedRecord[] = [];
	const protocolMessages: EmittedMessage[] = [];
	const events: RecordedEvent[] = [];

	const emit = (msg: EmittedMessage): Promise<void> => {
		protocolMessages.push(msg);
		events.push({ kind: "message", message: msg });
		return Promise.resolve();
	};

	const emitRecord = async (
		stream: string,
		data: RecordData,
		options?: { beforeEmit?: () => Promise<void> } | "id" | "name",
	): Promise<void> => {
		if (validateRecord) {
			const result = validateRecord(stream, data);
			if (!result.ok) {
				skipped.push({ stream, issues: result.issues });
				events.push({
					kind: "record-skipped",
					stream,
					issues: result.issues,
					skipped: true,
				});
				return;
			}
		}
		if (typeof options === "object") await options.beforeEmit?.();
		emitted.push({ stream, data });
		events.push({ kind: "record", stream, data, skipped: false });
	};

	return { emit, emitRecord, emitted, events, skipped, protocolMessages };
}

/**
 * Run a connector entrypoint as a real child process and drive the
 * Collection Profile protocol over stdio. Unlike `makeRecordingEmit`,
 * this proves START parsing, stdout JSONL framing, DONE emission, and
 * process exit behavior without importing the connector module directly.
 */
export function runConnectorProtocolSubprocess(
	options: ConnectorSubprocessOptions,
): Promise<ConnectorSubprocessResult> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const retainRawStdout = options.retainRawStdout ?? true;

	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx", options.entrypoint],
			{
				cwd: options.cwd,
				env: {
					...process.env,
					PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
					PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
					...options.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);

		let peakRssBytes: number | null = null;
		let rssPoller: NodeJS.Timeout | undefined;
		const { pid } = child;
		const sampleRss = (): void => {
			try {
				const status = readFileSync(`/proc/${pid}/status`, "utf8");
				const match = VM_RSS_STATUS_RE.exec(status);
				if (match?.[1]) {
					const bytes = Number.parseInt(match[1], 10) * 1024;
					peakRssBytes =
						peakRssBytes === null ? bytes : Math.max(peakRssBytes, bytes);
				}
			} catch {
				// /proc/<pid>/status is unavailable (non-Linux, or the process
				// already exited between the tick firing and the read) -- leave
				// peakRssBytes at its last known value.
			}
		};
		const sampleRssOnOutput = Boolean(options.peakRssPollIntervalMs && pid);
		if (sampleRssOnOutput) {
			// The interval alone can miss a child that finishes before its first
			// tick; sampling at start and on each stdout chunk (below) always
			// yields a value while the child is producing records.
			sampleRss();
			rssPoller = setInterval(sampleRss, options.peakRssPollIntervalMs);
		}

		const messages: EmittedMessage[] = [];
		let rawStdout = "";
		let stderr = "";
		let stdoutBuffer = "";
		let settled = false;
		let timer: NodeJS.Timeout;

		const finish = (fn: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			if (rssPoller) {
				clearInterval(rssPoller);
			}
			fn();
		};

		const killChildTree = (): void => {
			// Once the child has exited its pid may be reused: never signal it.
			if (child.exitCode !== null || child.signalCode !== null) return;
			if (process.platform === "linux" && child.pid) {
				killLinuxProcessTree(child.pid);
				return;
			}
			if (!child.killed) child.kill("SIGKILL");
		};

		const rejectAndKill = (error: Error): void => {
			killChildTree();
			finish(() => reject(error));
		};

		const parseLine = (line: string): void => {
			if (!line.trim()) {
				return;
			}
			try {
				messages.push(JSON.parse(line) as EmittedMessage);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				rejectAndKill(
					new Error(
						`connector emitted invalid JSONL: ${message}; line=${line}`,
					),
				);
			}
		};

		timer = setTimeout(() => {
			rejectAndKill(
				new Error(
					`connector subprocess timed out after ${String(timeoutMs)}ms; stderr=${stderr}`,
				),
			);
		}, timeoutMs);

		// Decode as streams, not per chunk: a multi-byte character split across
		// two pipe chunks would otherwise become U+FFFD in both halves.
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (text: string) => {
			if (sampleRssOnOutput) sampleRss();
			if (retainRawStdout) {
				rawStdout += text;
			}
			stdoutBuffer += text;
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				parseLine(line);
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		});

		child.stderr?.on("data", (text: string) => {
			stderr += text;
		});

		child.on("error", (err) => {
			finish(() => reject(err));
		});

		// 'close' (not 'exit'): 'exit' can fire before the stdio pipes have
		// finished draining their last buffered chunk, so `messages` may still be
		// missing the connector's final PROGRESS/DONE line at that instant. 'close'
		// is documented to fire only after the stdio streams have ended, so every
		// byte the child wrote is guaranteed parsed into `messages` by then.
		child.on("close", (code, signal) => {
			if (stdoutBuffer.trim()) {
				parseLine(stdoutBuffer);
			}
			if (settled) {
				return;
			}
			const done = messages.findLast((m) => m.type === "DONE");
			if (!done) {
				finish(() =>
					reject(
						new Error(
							`connector subprocess exited without DONE: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
						),
					),
				);
				return;
			}
			if (done.status === "failed" && options.allowFailedDone === true) {
				finish(() =>
					resolve({ code, messages, peakRssBytes, rawStdout, signal, stderr }),
				);
				return;
			}
			if (code !== 0 || signal) {
				finish(() =>
					reject(
						new Error(
							`connector subprocess exited non-zero after DONE: code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
						),
					),
				);
				return;
			}
			if (done.status === "failed") {
				finish(() =>
					reject(
						new Error(
							`connector subprocess reported failed: ${done.error?.message ?? "unknown"}; code=${String(code)} stderr=${stderr}`,
						),
					),
				);
				return;
			}
			finish(() =>
				resolve({ code, messages, peakRssBytes, rawStdout, signal, stderr }),
			);
		});

		child.stdin?.end(stringifyForJsonl(options.start));
	});
}

// `politeDelay` is `new Promise((r) => setTimeout(r, ms))`, so under the
// wrapper below its timer's stack is: the wrapper, the Promise executor,
// `new Promise (<anonymous>)`, `politeDelay (...)`. The match keys on V8's
// function name, so it needs code that keeps its names. The suite runs
// TypeScript unbundled through `node --import tsx` (scripts/test-dispatch.mjs).
// A bundler or minifier that renames politeDelay turns the skip off without an
// error. The test "a politeDelay pause fires on the next tick" then fails,
// since it asserts that the pause is recorded as 0 ms.
const NEW_PROMISE_FRAME = /^\s+at new Promise \(/;
const POLITE_DELAY_FRAME = /^\s+at politeDelay \(/;

/**
 * True when the timer being armed was armed directly by `politeDelay`. The
 * frames, innermost first and after the "Error" header, are [0] the wrapper,
 * [1] the Promise executor, [2] `new Promise`, [3] `politeDelay`. A timer armed
 * by a helper that `politeDelay` calls shifts [2] and [3], so it is not matched.
 */
function armedDirectlyByPoliteDelay(stack: string): boolean {
	const frames = stack.split("\n").slice(1);
	return (
		NEW_PROMISE_FRAME.test(frames[2] ?? "") &&
		POLITE_DELAY_FRAME.test(frames[3] ?? "")
	);
}

/** Installations still live. One patch serves all of them. */
let liveInstallations = 0;
/** The timer the patch replaced. Calls that pass through the patch land here. */
let realSetTimeout: typeof setTimeout = globalThis.setTimeout;

const pacedSetTimeout = ((
	handler: () => void,
	delay?: number,
	...args: unknown[]
) => {
	const isPause =
		liveInstallations > 0 &&
		typeof delay === "number" &&
		delay > 0 &&
		armedDirectlyByPoliteDelay(new Error().stack ?? "");
	return realSetTimeout(handler, isPause ? 0 : delay, ...args);
}) as unknown as typeof setTimeout;

/**
 * Make `politeDelay` pauses fire on the next timer tick until the returned
 * function runs.
 *
 * `politeDelay` is the runtime's anti-bot pacing pause. A test that walks
 * pages through a connector pays it on every page (2.5 s per Whole Foods
 * navigation, about half a second per heb list page) and does not assert on
 * it. Only the timer that `politeDelay` arms itself is shortened, found by the
 * call stack. A watchdog, a polling interval or Playwright's own timeout in the
 * code under test keeps its real duration, and so does a timer armed by a
 * helper that `politeDelay` calls.
 *
 * It patches `globalThis.setTimeout` for the whole process: install it once
 * per test file with `after(skipPoliteDelays())`, which also restores it.
 * Installations may overlap. The first one installs the patch and the last one
 * restored removes it. Each returned function does nothing after its first
 * call.
 *
 * Limit: a `setTimeout` wrapper installed on top of this one that calls
 * through adds a frame, so the pause is not matched and keeps its real delay.
 * That is slower, never a changed result.
 */
export function skipPoliteDelays(): () => void {
	if (liveInstallations === 0) {
		// A caller that saved the patch and restored it after the last restore
		// leaves the patch in place. Never let the patch wrap itself.
		if (globalThis.setTimeout !== pacedSetTimeout) {
			realSetTimeout = globalThis.setTimeout;
		}
		globalThis.setTimeout = pacedSetTimeout;
	}
	liveInstallations += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		liveInstallations -= 1;
		if (liveInstallations === 0) {
			globalThis.setTimeout = realSetTimeout;
		}
	};
}
