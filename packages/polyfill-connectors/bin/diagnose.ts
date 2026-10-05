#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * diagnose — explain one recorded connector run without a browser or a
 * network (Collection Profile 0.2.0, Sections 5.10 and 5.11).
 *
 * Reads the run summary `bin/connector-dev.ts` wrote and prints the failure's
 * primary cause, the contributing findings, every recorded fact with its
 * provenance and scope, the recovery-hint verdict (an instruction, or only
 * the connector's suggestion), and the connector's own error text verbatim.
 * It reads one local file and writes to standard output; it sends nothing
 * anywhere.
 *
 * Usage:
 *   pnpm exec tsx bin/diagnose.ts <run-id | summary.json> [--json]
 *
 * `<run-id>` is `<connector>/<stamp>`, which connector-dev prints after each
 * run; it names `runs/<connector>/<stamp>-summary.json`. A path to any
 * summary file also works. `--json` prints the diagnosis object instead of
 * text, for scripts and agents.
 *
 * Exit code: 0 when a diagnosis was printed (whatever the run's outcome);
 * 2 for a usage error or a file that is not a run summary.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRoot as PACKAGE_ROOT } from "../src/connector-paths.ts";
import {
	diagnoseRun,
	parseDiagnosisInput,
	renderDiagnosis,
} from "../src/failure-diagnosis.ts";

const RUN_ID_RE = /^([A-Za-z0-9_-]+)\/([0-9T.Z-]+)$/u;

/**
 * The summary path for a run id. Mirrors connector-dev's `defaultSummaryPath`
 * (`runs/<connector>/<stamp>-summary.json`, with `:` in the stamp replaced
 * by `-`); `bin/diagnose.test.ts` pins the two together.
 */
export function summaryPathForRunId(runId: string): string | undefined {
	const match = RUN_ID_RE.exec(runId);
	if (!(match?.[1] && match[2])) {
		return;
	}
	return join(PACKAGE_ROOT, "runs", match[1], `${match[2]}-summary.json`);
}

function resolveSummaryPath(target: string): string | undefined {
	if (existsSync(target)) {
		return target;
	}
	const fromRunId = summaryPathForRunId(target);
	return fromRunId && existsSync(fromRunId) ? fromRunId : undefined;
}

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.stderr.write(
		"Usage: diagnose <run-id | summary.json> [--json]\n" +
			"  run-id: <connector>/<stamp>, as printed by connector-dev\n",
	);
	process.exit(2);
}

function main(argv: readonly string[]): void {
	const json = argv.includes("--json");
	const targets = argv.filter((arg) => arg !== "--json");
	const [target] = targets;
	if (!target || targets.length > 1 || target.startsWith("--")) {
		fail("diagnose takes exactly one run id or summary path");
	}
	const path = resolveSummaryPath(target);
	if (!path) {
		fail(`no run summary found for ${target}`);
	}
	let input: ReturnType<typeof parseDiagnosisInput>;
	try {
		input = parseDiagnosisInput(JSON.parse(readFileSync(path, "utf8")));
	} catch (err) {
		fail(`${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
	const diagnosis = diagnoseRun(input);
	process.stdout.write(
		json
			? `${JSON.stringify(diagnosis, null, 2)}\n`
			: `${renderDiagnosis(diagnosis).join("\n")}\n`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
