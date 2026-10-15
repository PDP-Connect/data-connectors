// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { build } from "esbuild";

const mode = process.env.MUTATION_MODE;
if (mode !== "a2") {
	throw new Error("The GroupMe build command is only valid for A2");
}

const startedAt = performance.now();
const sourcePath = resolve("connectors/groupme/index.ts");
const outputPath = resolve("connectors/groupme/index.instrumented.js");
await build({
	entryPoints: [sourcePath],
	bundle: false,
	format: "esm",
	outfile: outputPath,
	platform: "node",
	target: "node24",
});

const output = readFileSync(outputPath);
const proxy = 'export * from "./index.instrumented.js";\n';
writeFileSync(sourcePath, proxy);

const event = {
	event: "instrumented-build",
	mode,
	durationMs: Math.round(performance.now() - startedAt),
	outputBytes: output.byteLength,
	outputSha256: createHash("sha256").update(output).digest("hex"),
};
if (process.env.MUTATION_TIMING_FILE) {
	appendFileSync(
		process.env.MUTATION_TIMING_FILE,
		`${JSON.stringify(event)}\n`,
		{ mode: 0o600 },
	);
}
