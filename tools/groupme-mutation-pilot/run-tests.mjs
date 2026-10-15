// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream } from "node:fs";
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
				...tests.map((name) => `reports/a2-emitted/connectors/groupme/${name}.test.js`),
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
const capture = capturePath && isUnactivated ? createWriteStream(capturePath) : null;
const child = spawn(process.execPath, args, {
	cwd: process.cwd(),
	env: process.env,
	stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	capture?.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("error", (error) => {
	capture?.end();
	console.error(error);
	process.exitCode = 1;
});
child.on("close", (code, signal) => {
	capture?.end();
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
});
