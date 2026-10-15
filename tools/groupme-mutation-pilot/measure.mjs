// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
const timingPath = resolve(reportsPath, "timing.jsonl");
const startedAt = new Date().toISOString();
const startedClock = performance.now();
const initialState = {
	mode,
	populationKind:
		process.env.MUTATION_CANARY_CONTROL === "1"
			? "bounded canary-only local control"
			: "fixed full pilot ranges",
	status: "started; incomplete until normal child close",
	startedAt,
	command: command.name,
	checkoutHead: process.env.GITHUB_SHA ?? null,
	prHead: process.env.PR_HEAD_SHA ?? null,
	prBase: process.env.PR_BASE_SHA ?? null,
	mergeSha: process.env.PR_MERGE_SHA ?? null,
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
const child = spawn(command.executable, command.args, {
	cwd: process.cwd(),
	env: {
		...process.env,
		...(mode === "baseline" ? {} : { MUTATION_MODE: mode }),
		MUTATION_CAPTURE_BASELINE: baselinePath,
		MUTATION_TIMING_FILE: timingPath,
		MUTATION_REPORT_ROOT: reportsPath,
		PILOT_REPORT_DIR: reportsPath,
		MUTATION_TYPESCRIPT_BIN: resolve("node_modules/typescript/bin/tsc"),
	},
	stdio: ["ignore", "pipe", "pipe"],
});
const resources = startResourceMonitor(child.pid);
child.stdout.on("data", (chunk) => {
	stdoutFile.write(chunk);
	process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
	stderrFile.write(chunk);
	process.stderr.write(chunk);
});
child.on("error", (error) => {
	stdoutFile.end();
	stderrFile.end();
	const state = { ...initialState, status: "failed to start", error: error.message };
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	console.error(`Unable to start ${mode}; inspect the private artifact.`);
	process.exitCode = 1;
});
child.on("close", (exitCode, signal) => {
	const resourceSummary = resources.finish();
	stdoutFile.end();
	stderrFile.end();
	const durationMs = Math.round(performance.now() - startedClock);
	let baseline;
	try {
		const tap = awaitReadText(baselinePath);
		baseline = validateBaselineTap(tap);
		baseline.sha256 = createHashText(tap);
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
	const finalStatus =
		exitCode === 0 && baseline?.valid && (mode === "baseline" || existsSync(mutationReportPath))
			? "completed"
			: "failed";
	const state = {
		...initialState,
		status: finalStatus,
		finishedAt: new Date().toISOString(),
		durationMs,
		exitCode,
		signal,
		commandBoundary:
			mode === "baseline"
				? "14-file node:test baseline"
				: "Stryker total: startup, instrumentation, sandbox, build, dry run, mutant runs and report",
		baseline,
		mutationReportPresent: mode === "baseline" ? null : existsSync(mutationReportPath),
		resources: resourceSummary,
	};
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	appendFileSync(
		timingPath,
		`${JSON.stringify({
			event: mode === "baseline" ? "baseline-total" : "stryker-total",
			mode,
			durationMs,
			exitCode,
			signal,
			baselineValid: baseline?.valid ?? null,
			resources: resourceSummary,
		})}\n`,
		{ mode: 0o600 },
	);
	if (finalStatus !== "completed") {
		console.error(`${mode} incomplete or invalid; inspect the private artifact.`);
		process.exitCode = exitCode || 1;
	} else {
		console.log(`${mode} completed in ${durationMs} ms.`);
	}
});

function awaitReadText(path) {
	return readFileSync(path, "utf8");
}

function createHashText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function startResourceMonitor(rootPid) {
	if (process.platform !== "linux" || !rootPid) {
		return { finish: () => ({ supported: false }) };
	}
	const pageSize = Number(
		spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).stdout?.trim(),
	);
	const clockTicks = Number(
		spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout?.trim(),
	);
	const maxCpuTicksByPid = new Map();
	let peakTreeRssBytes = 0;
	let peakProcessCount = 0;
	let sampleCount = 0;
	const sample = () => {
		const pids = descendants(rootPid);
		let treeRssBytes = 0;
		for (const pid of pids) {
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
				const cpuTicks = Number(fields[11]) + Number(fields[12]);
				const rssPages = Number(fields[21]);
				maxCpuTicksByPid.set(
					pid,
					Math.max(maxCpuTicksByPid.get(pid) ?? 0, cpuTicks),
				);
				treeRssBytes += rssPages * pageSize;
			} catch {
				// The process can exit between reading the child list and its stat.
			}
		}
		peakTreeRssBytes = Math.max(peakTreeRssBytes, treeRssBytes);
		peakProcessCount = Math.max(peakProcessCount, pids.size);
		sampleCount += 1;
	};
	sample();
	const interval = setInterval(sample, 1000);
	return {
		finish() {
			clearInterval(interval);
			sample();
			const cpuTicks = [...maxCpuTicksByPid.values()].reduce(
				(sum, value) => sum + value,
				0,
			);
			return {
				supported: true,
				sampler: "Linux /proc process-tree samples every 1000 ms",
				cpuSeconds: clockTicks ? Number((cpuTicks / clockTicks).toFixed(2)) : null,
				peakAggregateRssMiB: pageSize
					? Number((peakTreeRssBytes / 1024 / 1024).toFixed(1))
					: null,
				peakProcessCount,
				sampleCount,
				limitations:
					"short-lived descendants can fall between samples; RSS sums process mappings and can double-count shared pages",
			};
		},
	};
}

function descendants(rootPid) {
	const found = new Set();
	const pending = [rootPid];
	while (pending.length) {
		const pid = pending.pop();
		if (!pid || found.has(pid)) continue;
		found.add(pid);
		try {
			const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map(Number);
			pending.push(...children);
		} catch {
			// The process can exit between samples.
		}
	}
	return found;
}
