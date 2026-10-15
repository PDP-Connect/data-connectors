// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const mode = process.argv[2];
if (!new Set(["baseline", "a1", "a2"]).has(mode)) {
	throw new Error("Usage: node measure.mjs baseline|a1|a2");
}

const reportsPath = resolve("reports");
mkdirSync(reportsPath, { recursive: true });
const commands = {
	baseline:
		"node --import tsx --test --test-reporter=tap connectors/groupme/attachment-detail-coverage.test.ts connectors/groupme/attachments-stream.test.ts connectors/groupme/auth-probe.test.ts connectors/groupme/blob-security.test.ts connectors/groupme/carry-forward-projection.test.ts connectors/groupme/collection.test.ts connectors/groupme/completeness-anchor.test.ts connectors/groupme/incremental-frontier.test.ts connectors/groupme/index.test.ts connectors/groupme/production-dedup.test.ts connectors/groupme/schemas.test.ts connectors/groupme/setup-contract.test.ts connectors/groupme/skip-result-boundary-claim-contract.test.ts connectors/groupme/stream-coverage.test.ts",
	a1: "node tools/groupme-mutation-pilot/node_modules/@stryker-mutator/core/bin/stryker.js run tools/groupme-mutation-pilot/stryker.config.mjs",
	a2: "node tools/groupme-mutation-pilot/node_modules/@stryker-mutator/core/bin/stryker.js run tools/groupme-mutation-pilot/stryker.config.mjs",
};
const label = mode === "baseline" ? "baseline" : mode;
const started = performance.now();
const result = await new Promise((resolveResult, reject) => {
	const child = spawn(commands[mode], {
		cwd: process.cwd(),
		env: {
			...process.env,
			...(mode === "baseline" ? {} : { MUTATION_MODE: mode }),
			MUTATION_TIMING_FILE: resolve(reportsPath, "timing.jsonl"),
		},
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.on("error", reject);
	child.on("close", (exitCode, signal) =>
		resolveResult({
			exitCode,
			signal,
			stdout: Buffer.concat(stdout),
			stderr: Buffer.concat(stderr),
		}),
	);
});

const durationMs = Math.round(performance.now() - started);
writeFileSync(resolve(reportsPath, `${label}.stdout`), result.stdout, {
	mode: 0o600,
});
writeFileSync(resolve(reportsPath, `${label}.stderr`), result.stderr, {
	mode: 0o600,
});
appendFileSync(
	resolve(reportsPath, "timing.jsonl"),
	`${JSON.stringify({
		event: mode === "baseline" ? "baseline" : "mutation-run",
		mode,
		command: commands[mode],
		durationMs,
		exitCode: result.exitCode,
		signal: result.signal,
	})}\n`,
	{ mode: 0o600 },
);

if (result.exitCode !== 0) {
	console.error(
		`${mode} exited ${result.exitCode ?? result.signal}; inspect the private workflow artifact.`,
	);
	process.exitCode = result.exitCode ?? 1;
} else {
	console.log(`${mode} completed in ${durationMs} ms.`);
}

if (mode === "baseline" && result.exitCode === 0) {
	const tap = result.stdout.toString("utf8");
	const metric = (name) => {
		const match = tap.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
		return match ? Number(match[1]) : null;
	};
	const baseline = {
		tests: metric("tests"),
		pass: metric("pass"),
		fail: metric("fail"),
		skip: metric("skipped"),
		canaryOwnerTestSeen: tap.includes(
			"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError",
		),
	};
	writeFileSync(
		resolve(reportsPath, "baseline-summary.json"),
		`${JSON.stringify(baseline, null, 2)}\n`,
		{ mode: 0o600 },
	);
	if (
		baseline.tests !== 221 ||
		baseline.pass !== 219 ||
		baseline.fail !== 0 ||
		baseline.skip !== 2 ||
		!baseline.canaryOwnerTestSeen
	) {
		console.error(
			"Baseline differs from the pinned 221-test oracle population.",
		);
		process.exitCode = 1;
	}
}
