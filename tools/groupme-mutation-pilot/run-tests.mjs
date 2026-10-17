// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";

const tests = [
	"attachment-detail-coverage",
	"attachments-stream",
	"auth-probe",
	"blob-security",
	"carry-forward-projection",
	"collection",
	"completeness-anchor",
	"incremental-frontier",
	"index",
	"production-dedup",
	"schemas",
	"setup-contract",
	"skip-result-boundary-claim-contract",
	"stream-coverage",
];
const mode = process.env.MUTATION_MODE === "a2" ? "a2" : "a1";
const args =
	mode === "a2"
		? [
				"--enable-source-maps",
				"--test",
				"--test-reporter=tap",
				...tests.map(
					(name) => `reports/a2-emitted/connectors/groupme/${name}.test.js`,
				),
			]
		: [
				"--import",
				"tsx",
				"--test",
				"--test-reporter=tap",
				...tests.map((name) => `connectors/groupme/${name}.test.ts`),
			];

const capturePath = process.env.MUTATION_CAPTURE_BASELINE;
const isUnactivated = !process.env.__STRYKER_ACTIVE_MUTANT__;
const capture =
	capturePath && isUnactivated ? createWriteStream(capturePath) : null;
const activeMutantId = process.env.__STRYKER_ACTIVE_MUTANT__;
const rawTapDir = process.env.MUTATION_RAW_TAP_DIR;
const rawTapPath =
	activeMutantId && rawTapDir
		? `${rawTapDir}/${createHash("sha256").update(activeMutantId).digest("hex")}.tap`
		: null;
if (rawTapPath) mkdirSync(rawTapDir, { recursive: true });
const mutantTap = rawTapPath
	? createWriteStream(rawTapPath, { mode: 0o600 })
	: null;
const child = spawn(process.execPath, args, {
	cwd: process.cwd(),
	env: process.env,
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	capture?.write(chunk);
	mutantTap?.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
	capture?.end();
	mutantTap?.end();
	console.error(error);
	process.exitCode = 1;
});
child.on("close", (code, signal) => {
	const finish = () => {
		if (mutantTap && process.env.MUTATION_RAW_TAP_INDEX) {
			appendFileSync(
				process.env.MUTATION_RAW_TAP_INDEX,
				`${JSON.stringify({ mutantId: activeMutantId, path: rawTapPath, exitCode: code, signal })}\n`,
				{ mode: 0o600 },
			);
		}
		if (capture) {
			const timingFile = process.env.MUTATION_TIMING_FILE;
			if (timingFile) {
				appendFileSync(
					resolve(timingFile),
					`${JSON.stringify({
						event: "instrumented-unactivated-baseline",
						mode,
						path: basename(capturePath),
						exitCode: code,
						signal,
					})}\n`,
					{ mode: 0o600 },
				);
			}
		}
		process.exitCode = code ?? 1;
	};
	const streams = [capture, mutantTap].filter(Boolean);
	if (streams.length === 0) finish();
	else {
		let remaining = streams.length;
		for (const stream of streams)
			stream.end(() => {
				if (--remaining === 0) finish();
			});
	}
});
