// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validateBaselineTap } from "./report-integrity.mjs";

const mode = process.argv[2];
if (!new Set(["baseline", "a1", "a2"]).has(mode)) {
	throw new Error("Usage: node measure.mjs baseline|a1|a2");
}

const reportsPath = resolve(process.env.PILOT_REPORT_DIR ?? "reports");
mkdirSync(reportsPath, { recursive: true });
const command =
	mode === "baseline"
		? {
				executable: process.execPath,
				args: ["tools/groupme-mutation-pilot/run-tests.mjs"],
				name: "node tools/groupme-mutation-pilot/run-tests.mjs (A1 baseline)",
			}
		: {
				executable: process.execPath,
				args: [
					"tools/groupme-mutation-pilot/node_modules/@stryker-mutator/core/bin/stryker.js",
					"run",
					"tools/groupme-mutation-pilot/stryker.config.mjs",
				],
				name: `node @stryker-mutator/core/bin/stryker.js run tools/groupme-mutation-pilot/stryker.config.mjs (${mode})`,
			};
const stdoutPath = resolve(reportsPath, `${mode}.stdout`);
const stderrPath = resolve(reportsPath, `${mode}.stderr`);
const statePath = resolve(reportsPath, `${mode}.state.json`);
const baselinePath = resolve(
	reportsPath,
	mode === "baseline" ? "baseline.tap" : `${mode}.instrumented-baseline.tap`,
);
const mutationReportPath = resolve(reportsPath, `groupme-${mode}.json`);
const timeReceiptPath = resolve(reportsPath, `${mode}.gnu-time.txt`);
const rawTapDir = resolve(reportsPath, `${mode}-mutant-tap`);
const rawTapIndexPath = resolve(reportsPath, `${mode}-mutant-tap-index.jsonl`);
const timingPath = resolve(reportsPath, "timing.jsonl");
const startedAt = new Date().toISOString();
const startedClock = performance.now();
rmSync(timeReceiptPath, { force: true });
rmSync(rawTapDir, { recursive: true, force: true });
rmSync(rawTapIndexPath, { force: true });
const checkoutHead = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
const prHead = process.env.PR_HEAD_SHA ?? null;
if (process.env.GITHUB_ACTIONS === "true" && !prHead)
	throw new Error("PR_HEAD_SHA is required in GitHub Actions");
if (prHead && checkoutHead !== prHead)
	throw new Error(`Checked out ${checkoutHead}, expected PR head ${prHead}`);
const initialState = {
	mode,
	populationKind: "derived from report.config.mutate by summarize.mjs",
	status: "started; incomplete until normal child close",
	startedAt,
	command: command.name,
	checkoutHead,
	prHead,
	prBase: process.env.PR_BASE_SHA ?? null,
	mergeSha: process.env.PR_MERGE_SHA ?? process.env.GITHUB_SHA ?? null,
};
writeFileSync(statePath, `${JSON.stringify(initialState, null, 2)}\n`, {
	mode: 0o600,
});
appendFileSync(
	timingPath,
	`${JSON.stringify({ event: "command-start", mode, startedAt, command: command.name })}\n`,
	{ mode: 0o600 },
);
const stdoutFile = createWriteStream(stdoutPath, { mode: 0o600 });
const stderrFile = createWriteStream(stderrPath, { mode: 0o600 });
const run =
	mode === "baseline"
		? command
		: {
				executable: "/usr/bin/time",
				args: [
					"-o",
					timeReceiptPath,
					"-f",
					"elapsedSeconds=%e,userSeconds=%U,systemSeconds=%S,maxRssKiB=%M",
					command.executable,
					...command.args,
				],
			};
const child = spawn(run.executable, run.args, {
	cwd: process.cwd(),
	env: {
		...process.env,
		...(mode === "baseline" ? {} : { MUTATION_MODE: mode }),
		MUTATION_CAPTURE_BASELINE: baselinePath,
		MUTATION_TIMING_FILE: timingPath,
		MUTATION_REPORT_ROOT: reportsPath,
		MUTATION_RAW_TAP_DIR: rawTapDir,
		MUTATION_RAW_TAP_INDEX: rawTapIndexPath,
		PILOT_REPORT_DIR: reportsPath,
		MUTATION_TYPESCRIPT_BIN: resolve("node_modules/typescript/bin/tsc"),
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
let terminationSignal = null;
let forceKillTimer = null;
const terminate = (signal) => {
	if (terminationSignal) return;
	terminationSignal = signal;
	const at = new Date().toISOString();
	writeFileSync(
		statePath,
		`${JSON.stringify({ ...initialState, status: `terminated by ${signal}; incomplete`, terminationSignal: signal, terminatedAt: at }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	appendFileSync(
		timingPath,
		`${JSON.stringify({ event: "termination-requested", mode, signal, at })}\n`,
		{ mode: 0o600 },
	);
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch {}
	forceKillTimer = setTimeout(() => {
		try {
			process.kill(
				process.platform === "win32" ? child.pid : -child.pid,
				"SIGKILL",
			);
		} catch {}
	}, 5000);
};
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
child.stdout.on("data", (chunk) => {
	stdoutFile.write(chunk);
	process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
	stderrFile.write(chunk);
	process.stderr.write(chunk);
});

const result = await new Promise((resolveResult) => {
	child.on("error", (error) => resolveResult({ error }));
	child.on("close", (exitCode, signal) => resolveResult({ exitCode, signal }));
});
clearTimeout(forceKillTimer);
process.off("SIGTERM", terminate);
process.off("SIGINT", terminate);
stdoutFile.end();
stderrFile.end();
if (result.error) {
	const state = {
		...initialState,
		status: "failed to start",
		error: result.error.message,
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	console.error(`Unable to start ${mode}; inspect the private artifact.`);
	process.exitCode = 1;
} else {
	const durationMs = Math.round(performance.now() - startedClock);
	let baseline;
	try {
		const tap = readFileSync(baselinePath, "utf8");
		baseline = validateBaselineTap(tap);
		baseline.sha256 = createHash("sha256").update(tap).digest("hex");
		baseline.path = `reports/${mode === "baseline" ? "baseline.tap" : `${mode}.instrumented-baseline.tap`}`;
		writeFileSync(
			resolve(
				reportsPath,
				`${mode === "baseline" ? "baseline" : `${mode}.instrumented-baseline`}-summary.json`,
			),
			`${JSON.stringify(baseline, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch (error) {
		baseline = { valid: false, reason: error.message };
	}
	let timeReceipt = null;
	if (mode !== "baseline" && existsSync(timeReceiptPath)) {
		timeReceipt = Object.fromEntries(
			readFileSync(timeReceiptPath, "utf8")
				.trim()
				.split(",")
				.map((field) => field.split("=")),
		);
	}
	const finalStatus = terminationSignal
		? "terminated; incomplete"
		: result.exitCode === 0 &&
				baseline?.valid &&
				(mode === "baseline" || (existsSync(mutationReportPath) && timeReceipt))
			? "completed"
			: "failed";
	const state = {
		...initialState,
		status: finalStatus,
		finishedAt: new Date().toISOString(),
		durationMs,
		exitCode: result.exitCode,
		signal: result.signal,
		commandBoundary:
			mode === "baseline"
				? "14-file node:test baseline"
				: "Single /usr/bin/time around Stryker startup, baseline discovery, canary/mutation campaign and reporting; excludes npm setup",
		baseline,
		mutationReportPresent:
			mode === "baseline" ? null : existsSync(mutationReportPath),
		resources: timeReceipt
			? {
					accounting:
						"GNU /usr/bin/time child-process accounting at whole Stryker arm boundary",
					...timeReceipt,
					maxRssDefinition:
						"GNU %M high-water maximum resident set size in KiB; maximum process, not aggregate process-tree RSS",
				}
			: null,
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, {
		mode: 0o600,
	});
	appendFileSync(
		timingPath,
		`${JSON.stringify({ event: mode === "baseline" ? "baseline-total" : "stryker-total", mode, durationMs, exitCode: result.exitCode, signal: result.signal, baselineValid: baseline?.valid ?? null, resources: timeReceipt })}\n`,
		{ mode: 0o600 },
	);
	if (finalStatus !== "completed") {
		console.error(
			`${mode} incomplete or invalid; inspect the private artifact.`,
		);
		process.exitCode = result.exitCode || 1;
	} else console.log(`${mode} completed in ${durationMs} ms.`);
}
