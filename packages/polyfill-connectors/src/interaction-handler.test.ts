// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
	__testing,
	handleInteraction,
	type InteractionMessage,
} from "./interaction-handler.ts";

const {
	buildClickUrl,
	normalizeStatus,
	respondViaTerminal,
	SECRET_FIELD_RE,
	sleepUnlessAborted,
} = __testing;

// Drop a synthetic response file before invoking the handler so waitForFile
// resolves on the first poll.
function dropResponse(requestId: string, body: object): void {
	const path = join(tmpdir(), `pdpp-interaction-${requestId}.response.json`);
	writeFileSync(path, JSON.stringify(body), "utf8");
}

// Each test uses a unique request_id so the tmp-file probe doesn't collide.
function withFreshRequestId(label: string): string {
	return `${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

const ENV_KEYS = ["PDPP_WEB_BASE_URL", "PDPP_REFERENCE_ORIGIN"] as const;

function clearWebBaseEnv(): Record<
	(typeof ENV_KEYS)[number],
	string | undefined
> {
	const saved = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	return saved;
}

function restoreWebBaseEnv(
	saved: Record<(typeof ENV_KEYS)[number], string | undefined>,
): void {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved[key];
		}
	}
}

describe("buildClickUrl", () => {
	let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

	beforeEach(() => {
		saved = clearWebBaseEnv();
	});

	afterEach(() => {
		restoreWebBaseEnv(saved);
	});

	test("returns undefined when runId is not provided", () => {
		assert.equal(buildClickUrl(undefined, "manual_action", "i-1"), undefined);
	});

	test("manual_action produces stream viewer URL with interaction_id", () => {
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "manual_action", "i-42");
		assert.equal(
			url,
			"https://reference.example.com/syncs/run-1/stream?interaction_id=i-42",
		);
	});

	test("non-manual_action kinds produce the run page URL", () => {
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "credentials", "i-42");
		assert.equal(url, "https://reference.example.com/syncs/run-1");
	});

	test("PDPP_WEB_BASE_URL takes priority over PDPP_REFERENCE_ORIGIN", () => {
		process.env.PDPP_WEB_BASE_URL = "https://web.example.com";
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "manual_action", "i-1");
		assert.ok(url?.startsWith("https://web.example.com/"));
	});

	test("falls back to PDPP_REFERENCE_ORIGIN when web URL is unset", () => {
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "manual_action", "i-1");
		assert.ok(url?.startsWith("https://reference.example.com/"));
	});

	test("falls back to localhost when neither env var is set", () => {
		const url = buildClickUrl("run-1", "manual_action", "i-1");
		assert.ok(url?.startsWith("http://localhost:3000/"));
	});

	test("trims whitespace in env values", () => {
		process.env.PDPP_REFERENCE_ORIGIN = "  https://reference.example.com  ";
		const url = buildClickUrl("run-1", "manual_action", "i-1");
		assert.ok(url?.startsWith("https://reference.example.com/"));
	});

	test("treats empty string as unset and falls through to next source", () => {
		process.env.PDPP_WEB_BASE_URL = "";
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "manual_action", "i-1");
		assert.ok(url?.startsWith("https://reference.example.com/"));
	});

	test("missing interactionId still produces a URL with empty query value", () => {
		process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
		const url = buildClickUrl("run-1", "manual_action", undefined);
		assert.equal(
			url,
			"https://reference.example.com/syncs/run-1/stream?interaction_id=",
		);
	});
});

// Regression: the live ChatGPT failure mode `interaction_handler_invalid_response`
// (see tmp/workstreams/pwa-scheduler-status-memo.md) was caused by handlers
// that returned envelopes whose `status` was not in the runtime-validated set
// {success, cancelled, timeout}. The CLI orchestrator path uses
// `handleInteraction`, so its failure paths must also normalize.
describe("normalizeStatus", () => {
	test("preserves contract-allowed statuses", () => {
		assert.equal(normalizeStatus("success"), "success");
		assert.equal(normalizeStatus("cancelled"), "cancelled");
		assert.equal(normalizeStatus("timeout"), "timeout");
	});

	test("maps free-form / legacy statuses to cancelled", () => {
		assert.equal(normalizeStatus("failed"), "cancelled");
		assert.equal(normalizeStatus("error"), "cancelled");
		assert.equal(normalizeStatus(""), "cancelled");
		assert.equal(normalizeStatus(undefined), "cancelled");
		assert.equal(normalizeStatus("anything"), "cancelled");
	});
});

describe("secret field classification", () => {
	test("secret-named credential fields are masked", () => {
		for (const key of [
			"password",
			"Password",
			"totp_secret",
			"api_key",
			"access_token",
			"passphrase",
			"pin",
		]) {
			assert.ok(
				SECRET_FIELD_RE.test(key),
				`${key} should be treated as secret`,
			);
		}
	});

	test("identifying fields stay visible so the operator can see what they typed", () => {
		for (const key of ["username", "email", "account_id", "shipping"]) {
			assert.ok(!SECRET_FIELD_RE.test(key), `${key} should not be masked`);
		}
	});
});

// `handleInteraction` reads `process.stdin.isTTY` asynchronously, so the
// override has to outlive the await — restoring it synchronously in a
// `finally` would put it back before the handler ever looks.
async function withIsTTY<T>(
	value: boolean | undefined,
	body: () => Promise<T>,
): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", {
		configurable: true,
		value,
	});
	try {
		return await body();
	} finally {
		if (descriptor) {
			Object.defineProperty(process.stdin, "isTTY", descriptor);
		} else {
			delete (process.stdin as { isTTY?: boolean }).isTTY;
		}
	}
}

describe("handleInteraction operator instructions", () => {
	function captureStderr(body: () => Promise<void>): Promise<string> {
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		(process.stderr as { write: unknown }).write = (
			chunk: unknown,
		): boolean => {
			chunks.push(String(chunk));
			return true;
		};
		return body()
			.catch((): undefined => undefined)
			.then(() => {
				(process.stderr as { write: unknown }).write = original;
				return chunks.join("");
			});
	}

	test("a non-TTY run keeps the full file-drop instructions — it is the only way in", async () => {
		const request_id = withFreshRequestId("notty");
		dropResponse(request_id, { status: "cancelled" });
		const out = await withIsTTY(undefined, () =>
			captureStderr(async () => {
				await handleInteraction(
					{
						kind: "manual_action",
						message: "Test",
						request_id,
						timeout_seconds: 60,
					},
					{ connectorName: "test" },
				);
			}),
		);

		assert.match(out, /request written to /);
		assert.match(out, /write response JSON to /);
		assert.match(out, /example: echo /);
	});

	test("an interactive run drops the echo example that competed with the live prompt", async () => {
		const request_id = withFreshRequestId("tty");
		dropResponse(request_id, { status: "cancelled" });
		const out = await withIsTTY(true, () =>
			captureStderr(async () => {
				await handleInteraction(
					{
						kind: "manual_action",
						message: "Test",
						request_id,
						timeout_seconds: 60,
					},
					{ connectorName: "test" },
				);
			}),
		);

		// The defect: this line printed directly above a live prompt.
		assert.ok(
			!out.includes("example: echo "),
			`echo example still printed on a TTY:\n${out}`,
		);
		assert.ok(!out.includes("write response JSON to "));
		// The file-drop channel is still reachable, just as one pointer line.
		assert.match(out, /answer below, or drop a response file at /);
	});

	// Regression: before this fix, an interactive run always said "answer
	// below" regardless of `kind`, even though `respondViaTerminal` only
	// understands `otp`/`credentials`/`manual_action`. A kind it doesn't
	// understand must not make that promise.
	test("an interactive run does not promise an inline answer for a kind the terminal path can't handle", async () => {
		const request_id = withFreshRequestId("tty-unsupported");
		dropResponse(request_id, { status: "cancelled" });
		const out = await withIsTTY(true, () =>
			captureStderr(async () => {
				await handleInteraction(
					{
						kind: "some_future_kind",
						message: "Test",
						request_id,
						timeout_seconds: 60,
					},
					{ connectorName: "test" },
				);
			}),
		);

		assert.ok(
			!out.includes("answer below"),
			`promised an inline answer for an unhandled kind:\n${out}`,
		);
		assert.match(out, /drop a response file at /);
	});
});

describe("handleInteraction envelope shape", () => {
	// Force the file-drop path (no TTY) and a tight timeout so the test runs
	// quickly.
	test("returns runtime-valid envelope with exact request_id when status is success", async () => {
		const request_id = withFreshRequestId("ok");
		dropResponse(request_id, { status: "success", data: { code: "123456" } });
		const msg: InteractionMessage = {
			kind: "otp",
			message: "Enter OTP",
			request_id,
			timeout_seconds: 60,
		};
		const out = await handleInteraction(msg, { connectorName: "test" });
		assert.equal(out.type, "INTERACTION_RESPONSE");
		assert.equal(out.request_id, request_id);
		assert.equal(out.status, "success");
		assert.deepEqual(out.data, { code: "123456" });
	});

	test("normalizes free-form 'failed' status to 'cancelled' so runtime validator does not throw", async () => {
		const request_id = withFreshRequestId("failed");
		// Owner writes a legacy envelope with status:"failed". Pre-fix this would
		// surface as `interaction_handler_invalid_response` upstream because the
		// runtime only accepts success|cancelled|timeout.
		dropResponse(request_id, {
			status: "failed",
			error: { code: "user_aborted", message: "owner cancelled" },
		});
		const msg: InteractionMessage = {
			kind: "manual_action",
			message: "Test",
			request_id,
			timeout_seconds: 60,
		};
		const out = await handleInteraction(msg, { connectorName: "test" });
		assert.equal(out.type, "INTERACTION_RESPONSE");
		assert.equal(out.request_id, request_id);
		assert.equal(out.status, "cancelled");
		// Error context is still preserved for the run timeline.
		assert.equal(out.error?.code, "user_aborted");
	});

	test("a non-success response file drops its data from the envelope", async () => {
		await Promise.all(
			["failed", "cancelled", "timeout"].map(async (status) => {
				const request_id = withFreshRequestId(`data_${status}`);
				dropResponse(request_id, { status, data: { code: "123456" } });
				const out = await handleInteraction(
					{ kind: "otp", message: "code", request_id, timeout_seconds: 60 },
					{ connectorName: "test" },
				);
				assert.notEqual(out.status, "success");
				assert.equal(out.data, undefined, `${status} kept data`);
			}),
		);
	});

	test("preserves cancelled status when owner explicitly cancels", async () => {
		const request_id = withFreshRequestId("cancel");
		dropResponse(request_id, { status: "cancelled" });
		const msg: InteractionMessage = {
			kind: "manual_action",
			message: "Test",
			request_id,
			timeout_seconds: 60,
		};
		const out = await handleInteraction(msg, { connectorName: "test" });
		assert.equal(out.status, "cancelled");
	});

	test("never emits an arbitrary status string from the file-drop body", async () => {
		const request_id = withFreshRequestId("garbage");
		dropResponse(request_id, { status: "totally_made_up_status" });
		const msg: InteractionMessage = {
			kind: "manual_action",
			message: "Test",
			request_id,
			timeout_seconds: 60,
		};
		const out = await handleInteraction(msg, { connectorName: "test" });
		assert.ok(["success", "cancelled", "timeout"].includes(out.status));
	});
});

// Regression for the live rehearsal bug: `respondViaTerminal` had no branch
// for `manual_action`, so on a TTY the operator's Enter keypress went
// nowhere — the file-drop path was the only way through, despite the
// instructions above claiming otherwise. These exercise `respondViaTerminal`
// directly with an injected stdin/stdout pair (same DI shape as
// connector-exit.test.ts's PassThrough stdin) so the keystroke-to-response
// path is actually driven, not just asserted by printed instructions.
describe("respondViaTerminal manual_action", () => {
	function fakeTty(): { input: PassThrough; output: PassThrough } {
		const input = new PassThrough();
		const output = new PassThrough();
		output.on("data", () => {
			/* drain writes (the prompt text) so they don't back up */
		});
		return { input, output };
	}

	test("pressing Enter answers success", async () => {
		const io = fakeTty();
		const pending = respondViaTerminal(
			{ kind: "manual_action", message: "Sign in", request_id: "r-enter" },
			io,
		);
		io.input.write("\n");
		assert.deepEqual(await pending, { status: "success" });
	});

	test("typing 'cancel' answers with the protocol's cancelled status", async () => {
		const io = fakeTty();
		const pending = respondViaTerminal(
			{ kind: "manual_action", message: "Sign in", request_id: "r-cancel" },
			io,
		);
		io.input.write("cancel\n");
		assert.deepEqual(await pending, { status: "cancelled" });
	});

	test("'cancel' is case- and whitespace-insensitive", async () => {
		const io = fakeTty();
		const pending = respondViaTerminal(
			{ kind: "manual_action", message: "Sign in", request_id: "r-cancel-2" },
			io,
		);
		io.input.write("  CANCEL  \n");
		assert.deepEqual(await pending, { status: "cancelled" });
	});

	test("terminal success matches what a file-drop success response sends for this kind", async () => {
		// The file-drop contract for manual_action: an owner (or another
		// agent) writes `{"status":"success"}` — no `data`, since nothing
		// downstream (connector-runtime.ts, browser-handoff.ts) reads `data`
		// for this kind. The terminal path must send the same shape.
		const request_id = withFreshRequestId("manual-filedrop");
		dropResponse(request_id, { status: "success" });
		const fileDropEnvelope = await handleInteraction(
			{
				kind: "manual_action",
				message: "Sign in",
				request_id,
				timeout_seconds: 60,
			},
			{ connectorName: "test" },
		);
		assert.equal(fileDropEnvelope.status, "success");
		assert.equal(fileDropEnvelope.data, undefined);

		const io = fakeTty();
		const pending = respondViaTerminal(
			{ kind: "manual_action", message: "Sign in", request_id: "r-match" },
			io,
		);
		io.input.write("\n");
		assert.deepEqual(await pending, {
			status: fileDropEnvelope.status,
		});
	});

	test("an unsupported kind still returns null so the caller falls back to file drop", async () => {
		const io = fakeTty();
		const out = await respondViaTerminal(
			{ kind: "some_future_kind", message: "?", request_id: "r-x" },
			io,
		);
		assert.equal(out, null);
	});
});

// These run the handler in a child process because the defect is the process
// itself staying alive: the losing channel of the terminal/file-drop race kept
// a timer or a raw-mode stdin listener open, so scenario-record printed its
// summary and then hung until the 30-minute interaction timeout.
describe("handleInteraction file drop", () => {
	test("a response file still being written is read once complete, not lost", async () => {
		const request_id = withFreshRequestId("partial");
		const path = join(tmpdir(), `pdpp-interaction-${request_id}.response.json`);
		const body = JSON.stringify({
			status: "success",
			data: { code: "112233" },
		});
		const fd = openSync(path, "w");
		writeSync(fd, body.slice(0, 10));
		// The poll runs every 1.5 s: let it see the partial file first.
		const finish = setTimeout(() => {
			writeSync(fd, body.slice(10));
			closeSync(fd);
		}, 2000);
		try {
			const out = await withIsTTY(undefined, () =>
				handleInteraction(
					{ kind: "otp", message: "code", request_id, timeout_seconds: 60 },
					{ connectorName: "test" },
				),
			);
			assert.equal(out.status, "success");
			assert.deepEqual(out.data, { code: "112233" });
		} finally {
			clearTimeout(finish);
		}
	});

	test("a terminal that cannot answer leaves the file drop to answer", async () => {
		// `credentials` without schema properties has no terminal prompt, so
		// the terminal side resolves with no answer straight away.
		const request_id = withFreshRequestId("noprompt");
		setTimeout(
			() => dropResponse(request_id, { status: "success", data: { u: "x" } }),
			200,
		);
		const out = await withIsTTY(true, () =>
			handleInteraction(
				{
					kind: "credentials",
					message: "sign in",
					request_id,
					timeout_seconds: 60,
				},
				{ connectorName: "test" },
			),
		);
		assert.equal(out.status, "success");
		assert.deepEqual(out.data, { u: "x" });
	});
});

describe("sleepUnlessAborted", () => {
	// The file poll sleeps after a failed read. When the terminal won while
	// that read was pending, the signal is already aborted at this point; a
	// fresh 1.5 s timer would hold the process open after the answer.
	test("resolves at once for an already-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const started = Date.now();
		await sleepUnlessAborted(1500, controller.signal);
		assert.ok(Date.now() - started < 100);
	});

	test("resolves when the signal aborts during the sleep", async () => {
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 20);
		await sleepUnlessAborted(1500, controller.signal);
		assert.ok(Date.now() - started < 500);
	});
});

describe("handleInteraction releases the losing channel", () => {
	const HANDLER_URL = new URL("./interaction-handler.ts", import.meta.url).href;

	// The child fakes a raw-mode TTY on its piped stdin, starts an OTP
	// interaction with a 60 s timeout, then either types the code (terminal
	// wins) or drops a response file (file drop wins). It never ends stdin, so
	// a listener left on it also keeps the child alive.
	function runChild(winner: "terminal" | "file" | "keystrokes"): Promise<{
		code: number | null;
		elapsedMs: number;
		stdout: string;
	}> {
		const request_id = withFreshRequestId(`release_${winner}`);
		const code = [
			`import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";`,
			`import { tmpdir } from "node:os";`,
			`import { join } from "node:path";`,
			`const rawModes = [];`,
			`Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });`,
			`process.stdin.setRawMode = (mode) => { rawModes.push(mode); return process.stdin; };`,
			`const { handleInteraction } = await import(${JSON.stringify(HANDLER_URL)});`,
			`const pending = handleInteraction({ kind: "otp", message: "code", request_id: ${JSON.stringify(request_id)}, timeout_seconds: 60 }, { connectorName: "test" });`,
			`setTimeout(() => {`,
			winner === "terminal"
				? `  process.stdin.emit("data", Buffer.from("123456\\r"));`
				: winner === "keystrokes"
					? // "a", then "\u00e9" split across two chunks, then an emoji
						// erased by Backspace, then "b" and Enter.
						`  for (const c of [Buffer.from("a"), Buffer.from("\\u00e9").subarray(0, 1), Buffer.from("\\u00e9").subarray(1), Buffer.from("\\u{1F600}"), Buffer.from([0x7f]), Buffer.from("b\\r")]) process.stdin.emit("data", c);`
					: `  writeFileSync(join(tmpdir(), "pdpp-interaction-${request_id}.response.json"), JSON.stringify({ status: "success", data: { code: "654321" } }));`,
			`}, 200);`,
			`const out = await pending;`,
			`console.log(JSON.stringify({ status: out.status, code: out.data?.code, rawModes }));`,
		].join("\n");
		const started = Date.now();
		return new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				["--import", "tsx", "--input-type=module", "-e", code],
				{ stdio: ["pipe", "pipe", "ignore"] },
			);
			let stdout = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
			child.on("error", reject);
			child.on("exit", (exitCode) => {
				clearTimeout(killer);
				resolve({ code: exitCode, elapsedMs: Date.now() - started, stdout });
			});
		});
	}

	// The prompt itself also writes to stdout; the result is the last line.
	function lastJsonLine(stdout: string) {
		return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
	}

	test("a typed or pasted terminal answer lets the process exit", async () => {
		const result = await runChild("terminal");
		assert.equal(
			result.code,
			0,
			`child did not exit on its own: ${result.stdout}`,
		);
		assert.ok(result.elapsedMs < 15_000, `child lived ${result.elapsedMs} ms`);
		const out = lastJsonLine(result.stdout);
		// The code and Enter arrive in one chunk, as a paste does.
		assert.equal(out.status, "success");
		assert.equal(out.code, "123456");
		assert.deepEqual(out.rawModes, [true, false]);
	});

	test("masked input keeps split multi-byte characters and erases whole characters", async () => {
		const result = await runChild("keystrokes");
		assert.equal(
			result.code,
			0,
			`child did not exit on its own: ${result.stdout}`,
		);
		const out = lastJsonLine(result.stdout);
		assert.equal(out.status, "success");
		assert.equal(out.code, "a\u00e9b");
	});

	test("a file drop that wins restores the terminal and lets the process exit", async () => {
		const result = await runChild("file");
		assert.equal(
			result.code,
			0,
			`child did not exit on its own: ${result.stdout}`,
		);
		assert.ok(result.elapsedMs < 15_000, `child lived ${result.elapsedMs} ms`);
		const out = lastJsonLine(result.stdout);
		assert.equal(out.status, "success");
		assert.equal(out.code, "654321");
		assert.deepEqual(out.rawModes, [true, false]);
	});
});
