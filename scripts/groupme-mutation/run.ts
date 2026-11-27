// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// One official Stryker invocation (default operators, native Vitest, perTest coverage) over
// the changed GroupMe production ranges plus the canary. Stryker's own artifacts decide the
// outcome; this file only selects, runs, and records.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canary, locateCanary } from "./canary.mjs";
import { selectChanges } from "./changes.mjs";
import { readInvocation, verifyInvocation } from "./evidence.mjs";
import { pins, toolsRoot } from "./vitest.config.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const strykerBin = join(
	toolsRoot,
	"node_modules/@stryker-mutator/core/bin/stryker.js",
);
// Inside the 20-minute CI job; a timeout is infrastructure, never an assertion kill.
const strykerTimeoutMs = 15 * 60 * 1000;

const valueFlags = new Set([
	"--mode",
	"--base",
	"--head",
	"--merge-base",
	"--report",
]);

export function parseArgs(argv: string[]) {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!valueFlags.has(flag) || value === undefined || value.startsWith("--"))
			throw new Error(`unknown or incomplete argument: ${flag ?? "(none)"}`);
		flags[flag] = value;
	}
	if (flags["--mode"] !== undefined && flags["--mode"] !== "diff")
		throw new Error("only --mode diff is supported");
	const base = flags["--base"];
	const head = flags["--head"];
	const mergeBase = flags["--merge-base"];
	if (!base || !head || !mergeBase)
		throw new Error("--base, --head, and --merge-base full SHAs are required");
	return { base, head, mergeBase, report: flags["--report"] };
}

function writeJson(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function runStryker(runDir: string, mutate: string[]) {
	const started = Date.now();
	const child = spawnSync(
		process.execPath,
		[
			strykerBin,
			"run",
			"scripts/groupme-mutation/stryker.config.mjs",
			"--mutate",
			mutate.join(","),
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			timeout: strykerTimeoutMs,
			maxBuffer: 512 * 1024 * 1024,
			env: {
				...process.env,
				NO_COLOR: "1",
				// The sandbox ignores node_modules; the real tool root keeps its pins checked.
				GROUPME_MUTATION_TOOLS_ROOT: toolsRoot,
				GROUPME_MUTATION_RUN_DIR: runDir,
				GROUPME_MUTATION_RECEIPT: join(runDir, "owner-receipt.jsonl"),
			},
		},
	);
	writeFileSync(
		join(runDir, "stryker.log"),
		(child.stdout ?? "") + (child.stderr ?? ""),
	);
	return {
		status: child.status,
		signal: child.signal,
		timedOut: child.error?.code === "ETIMEDOUT",
		durationMs: Date.now() - started,
	};
}

export async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	// Validates SHAs and HEAD before any report directory exists.
	const change = await selectChanges(repoRoot, options);
	const runDir = resolve(
		options.report ??
			join(
				homedir(),
				".tmp",
				"groupme-mutation",
				`${options.head.slice(0, 12)}-${randomUUID()}`,
			),
	);
	if (existsSync(runDir))
		throw new Error("report directory already exists: " + runDir);
	mkdirSync(runDir, { recursive: true });
	writeJson(join(runDir, "selection.json"), change);
	const { selection } = change;
	const anchor = locateCanary(
		readFileSync(join(repoRoot, canary.file), "utf8"),
	);
	const canaryRange = `${canary.file}:${String(anchor.line)}-${String(anchor.line)}`;
	const summary: Record<string, unknown> = {
		schema: "groupme-mutation-invocation/1",
		base: options.base,
		head: options.head,
		mergeBase: options.mergeBase,
		selection: {
			disposition: selection.disposition,
			changedFiles: change.changedFiles,
			outOfScopeFiles: change.outOfScopeFiles,
			files: selection.files,
		},
		canaryRange,
		tools: pins,
	};

	const finish = (
		status: string,
		reason: string,
		extra: Record<string, unknown> = {},
	) => {
		writeJson(join(runDir, "summary.json"), {
			...summary,
			status,
			reason,
			...extra,
		});
		console.log(`groupme-mutation: ${status} — ${reason}`);
		console.log(`groupme-mutation: summary ${join(runDir, "summary.json")}`);
		return status === "proven" ? 0 : 1;
	};

	if (selection.disposition === "unsupported")
		return finish(
			"unsupported",
			"a changed GroupMe production file is outside the supported scope; no mutation ran",
		);

	const mutate = [...new Set([...selection.mutate, canaryRange])];
	const stryker = runStryker(runDir, mutate);
	const stopped =
		stryker.timedOut || stryker.signal !== null || stryker.status !== 0;
	if (stopped)
		return finish(
			"incomplete",
			stryker.timedOut
				? "Stryker exceeded the inner timeout; this is infrastructure, not a kill"
				: `Stryker stopped (status ${String(stryker.status)}, signal ${String(stryker.signal)}); this is infrastructure, not a kill`,
			{ stryker },
		);

	let evidence: ReturnType<typeof verifyInvocation>;
	try {
		const invocation = readInvocation(runDir);
		evidence = verifyInvocation({
			...invocation,
			anchor,
			selectedRanges: selection.files
				.filter((file) => file.disposition === "selected")
				.map(({ path, ranges }) => ({ path, ranges })),
		});
	} catch (error) {
		return finish(
			"unproven",
			`canary not proven: ${error instanceof Error ? error.message : String(error)}`,
			{ stryker },
		);
	}
	const changedCode =
		evidence.population.changed > 0
			? { proof: "mutation", population: evidence.population.changed }
			: {
					proof: "none",
					reason: "no changed-code mutants in the selected ranges",
				};
	const code = finish(
		"proven",
		`canary killed by its native owner; changed-code ${changedCode.proof}` +
			(changedCode.proof === "mutation"
				? ` (${String(evidence.population.changed)} mutants: ${JSON.stringify(evidence.population.counts)})`
				: ""),
		{ stryker, evidence, changedCode },
	);
	return code;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
}
