// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker-thread / child-process oracle for the per-element memory bound:
 * validates a pre-built fixture file under a caller-supplied heap limit and
 * reports the result over the parent port (worker) or stdout (child process).
 * Does no fixture construction of its own -- the parent builds the fixture
 * outside any heap constraint and passes only its path and size, so the
 * oracle's heap budget is spent exclusively on the validation call itself.
 */

import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
import { streamGoogleMapsExport } from "./archive-stream.ts";
import { validateGoogleMapsTimelineArtifactFromFile } from "./validation.ts";

const [, , path, fileSizeArg, mode] = process.argv;
if (!(path && fileSizeArg)) {
	console.error(
		"usage: oversized-element-oracle.test.child.ts <path> <fileSize>",
	);
	process.exit(2);
}

const fileSize = Number(fileSizeArg);

function report(result: {
	elements?: number;
	error?: string;
	status?: string;
}): void {
	if (parentPort) {
		parentPort.postMessage(result);
	} else {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
}

// In a worker, process.exit() can stop the thread before a just-posted
// message is delivered, so a worker sets the exit code and ends naturally.
function done(code: number): void {
	if (parentPort) {
		process.exitCode = code;
	} else {
		process.exit(code);
	}
}

if (mode === "whole-buffer") {
	const json = JSON.parse(readFileSync(path, "utf8"));
	report({ status: Array.isArray(json.locations) ? "valid" : "unsupported" });
	done(0);
} else if (mode === "stream") {
	let elements = 0;
	streamGoogleMapsExport(path, (event) => {
		if (event.kind === "element") {
			elements += 1;
		}
	})
		.then(() => {
			report({ elements, status: "valid" });
			done(0);
		})
		.catch((err) => {
			report({ error: String(err) });
			done(1);
		});
} else {
	validateGoogleMapsTimelineArtifactFromFile(path, fileSize, {
		fileSha256: "oracle-probe",
		maxFileBytes: 200 * 1024 * 1024,
	})
		.then((result) => {
			report({ status: result.status });
			done(0);
		})
		.catch((err) => {
			report({ error: String(err) });
			done(1);
		});
}
