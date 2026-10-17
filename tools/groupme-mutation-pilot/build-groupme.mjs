// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

if (process.env.MUTATION_MODE !== "a2") {
	throw new Error("The emitted-test build command is only valid for A2");
}

const testRoots = [
	"connectors/groupme/attachment-detail-coverage.test.ts",
	"connectors/groupme/attachments-stream.test.ts",
	"connectors/groupme/auth-probe.test.ts",
	"connectors/groupme/blob-security.test.ts",
	"connectors/groupme/carry-forward-projection.test.ts",
	"connectors/groupme/collection.test.ts",
	"connectors/groupme/completeness-anchor.test.ts",
	"connectors/groupme/incremental-frontier.test.ts",
	"connectors/groupme/index.test.ts",
	"connectors/groupme/production-dedup.test.ts",
	"connectors/groupme/schemas.test.ts",
	"connectors/groupme/setup-contract.test.ts",
	"connectors/groupme/skip-result-boundary-claim-contract.test.ts",
	"connectors/groupme/stream-coverage.test.ts",
];
const outputRoot = resolve("reports/a2-emitted");
const reportRoot = resolve(process.env.MUTATION_REPORT_ROOT ?? "reports");
const timingPath = resolve(process.env.MUTATION_TIMING_FILE ?? "reports/timing.jsonl");
const compileStarted = performance.now();
mkdirSync(outputRoot, { recursive: true });
const referenceContractEntry = fileURLToPath(
	import.meta.resolve("@pdpp/reference-contract/evidence"),
);
const referenceContractRoot = resolve(dirname(dirname(referenceContractEntry)));
const referenceContractStage = resolve("reports/a2-reference-contract-source");
const referenceContractOutput = resolve(
	outputRoot,
	"node_modules/@pdpp/reference-contract",
);
for (const subpath of ["common", "evidence"]) {
	const source = resolve(referenceContractRoot, subpath);
	const destination = resolve(referenceContractStage, subpath);
	mkdirSync(dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true });
}
copyFileSync(
	resolve(referenceContractRoot, "package.json"),
	resolve(referenceContractStage, "package.json"),
);

const tsc = resolve(
	process.env.MUTATION_TYPESCRIPT_BIN ?? "node_modules/typescript/bin/tsc",
);
const commonCompilerArgs = [
	"--noCheck",
	"--module",
	"NodeNext",
	"--moduleResolution",
	"NodeNext",
	"--target",
	"ES2024",
	"--rewriteRelativeImportExtensions",
	"--sourceMap",
];
const localGraphCompile = spawnSync(
	process.execPath,
	[
		tsc,
		...commonCompilerArgs,
		"--preserveSymlinks",
		"--rootDir",
		".",
		"--outDir",
		outputRoot,
		...testRoots,
	],
	{ encoding: "utf8" },
);
writeFileSync(resolve(reportRoot, "a2-build.stdout"), localGraphCompile.stdout ?? "", {
	mode: 0o600,
});
writeFileSync(resolve(reportRoot, "a2-build.stderr"), localGraphCompile.stderr ?? "", {
	mode: 0o600,
});
if (localGraphCompile.error || localGraphCompile.status !== 0) {
	throw localGraphCompile.error ?? new Error(`TypeScript graph emit exited ${localGraphCompile.status}`);
}
const packageCompile = spawnSync(
	process.execPath,
	[
		tsc,
		...commonCompilerArgs,
		"--rootDir",
		referenceContractStage,
		"--outDir",
		referenceContractOutput,
		resolve(referenceContractStage, "common/index.ts"),
		resolve(referenceContractStage, "evidence/index.ts"),
	],
	{ encoding: "utf8" },
);
writeFileSync(
	resolve(reportRoot, "a2-build.stdout"),
	packageCompile.stdout ?? "",
	{ mode: 0o600, flag: "a" },
);
writeFileSync(
	resolve(reportRoot, "a2-build.stderr"),
	packageCompile.stderr ?? "",
	{ mode: 0o600, flag: "a" },
);
if (packageCompile.error || packageCompile.status !== 0) {
	throw packageCompile.error ?? new Error(`Reference-contract overlay emit exited ${packageCompile.status}`);
}

writeFileSync(
	resolve(referenceContractOutput, "package.json"),
	`${JSON.stringify(
		{
			name: "@pdpp/reference-contract",
			version: "0.0.1",
			private: true,
		type: "module",
			exports: {
				"./common": "./common/index.js",
				"./evidence": "./evidence/index.js",
			},
		},
		null,
		2,
	)}\n`,
	{ mode: 0o600 },
);

copyAssets(resolve("connectors"), resolve(outputRoot, "connectors"));
const metadata = resolve(
	"packages/polyfill-connectors/src/manifest-library-metadata.json",
);
if (existsSync(metadata)) {
	const target = resolve(
		outputRoot,
		"packages/polyfill-connectors/src/manifest-library-metadata.json",
	);
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(metadata, target);
}

for (const testRoot of testRoots) {
	const emitted = resolve(outputRoot, testRoot.replace(/\.ts$/, ".js"));
	if (!existsSync(emitted)) throw new Error(`Missing emitted test entry: ${testRoot}`);
}

const runtimeTypeScriptImports = [];
const outputFiles = listFiles(outputRoot);
const emittedJsFiles = outputFiles.filter((path) => path.endsWith(".js"));
for (const file of emittedJsFiles) {
	const source = readFileSync(file, "utf8");
	if (/\b(?:from\s*|import\s*\()\s*["'][^"']+\.ts["']/.test(source)) {
		runtimeTypeScriptImports.push(relative(outputRoot, file));
	}
}
if (runtimeTypeScriptImports.length > 0) {
	throw new Error(
		`Emitted graph retains runtime TypeScript imports: ${runtimeTypeScriptImports.join(", ")}`,
	);
}

const emittedEntry = resolve(outputRoot, "connectors/groupme/index.js");
const entrySource = readFileSync(emittedEntry, "utf8");
const instrumentationHeaderPresent = entrySource.includes(
	"__STRYKER_ACTIVE_MUTANT__",
);
if (!instrumentationHeaderPresent) {
	throw new Error("Emitted GroupMe entry is missing Stryker's activation header");
}

const hash = createHash("sha256");
for (const file of outputFiles.sort()) {
	hash.update(relative(outputRoot, file)).update("\0").update(readFileSync(file));
}
const durationMs = Math.round(performance.now() - compileStarted);
const event = {
	event: "emitted-graph-build",
	mode: "a2",
	durationMs,
	buildCommandInvocations: 1,
	typescriptInvocations: 2,
	testRootCount: testRoots.length,
	emittedJavaScriptFileCount: emittedJsFiles.length,
	emittedGraphFileCount: outputFiles.length,
	runtimeTypeScriptImportCount: runtimeTypeScriptImports.length,
	instrumentationHeaderPresent,
	outputGraphSha256: hash.digest("hex"),
	outputRoot: "reports/a2-emitted",
};
writeFileSync(
	resolve(reportRoot, "a2-emitted-graph.json"),
	`${JSON.stringify(event, null, 2)}\n`,
	{ mode: 0o600 },
);
writeFileSync(
	timingPath,
	`${JSON.stringify(event)}\n`,
	{ flag: "a", mode: 0o600 },
);
console.log(
	`A2 emitted ${emittedJsFiles.length} JavaScript graph files once; graph=${event.outputGraphSha256}; instrumented=${instrumentationHeaderPresent}`,
);

function copyAssets(sourceRoot, destinationRoot) {
	if (!existsSync(sourceRoot)) return;
	cpSync(sourceRoot, destinationRoot, {
		recursive: true,
		filter: (path) => {
			if (statSync(path).isDirectory()) return true;
			return !/\.(?:[cm]?js|[cm]?ts|map|tsbuildinfo)$/.test(path);
		},
	});
}

function listFiles(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(root, entry.name);
		return entry.isDirectory() ? listFiles(path) : [path];
	});
}
