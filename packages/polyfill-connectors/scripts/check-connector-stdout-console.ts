#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: connector source must not write to stdout through `console`.
 *
 * A connector's stdout is the PDPP protocol channel, JSON lines only. Node
 * writes `console.log`, `console.info`, `console.debug`, `console.dir`,
 * `console.table` and `console.trace` to stdout, so one such call corrupts
 * the stream and the host rejects the run ("Malformed PDPP connector JSONL
 * message"). `console.error` and `console.warn` write to stderr, the run log,
 * and stay allowed.
 *
 * Biome cannot express this scope from packages/polyfill-connectors/biome.jsonc:
 * `check-biome.ts` only lints that package, and `connectors/` sits at the repo
 * root. So this script runs Biome from the repo root with a scratch config,
 * the same mechanism as `check-no-await-in-loops-conformance.ts`. Tests and
 * `__fixtures__` are out of scope.
 *
 * Fails on any `lint/suspicious/noConsole` finding under `connectors/`.
 */

import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	connectorsDir,
	repoRoot as REPO_ROOT,
} from "../src/connector-paths.ts";

const BIOME_BIN = join(REPO_ROOT, "node_modules", ".bin", "biome");
const RULE_CATEGORY = "lint/suspicious/noConsole";

interface BiomeDiagnostic {
	category?: string;
	location?: {
		path?: string;
		start?: { line: number; column: number };
	};
}

interface BiomeReport {
	diagnostics: BiomeDiagnostic[];
}

interface Finding {
	column: number;
	line: number;
	path: string;
}

/** Authored connector source: `.ts` outside tests and captured fixtures. */
function connectorSourceFiles(): string[] {
	return readdirSync(connectorsDir, { recursive: true })
		.map(String)
		.filter(
			(rel) =>
				rel.endsWith(".ts") &&
				!rel.endsWith(".test.ts") &&
				!rel
					.split(/[\\/]/)
					.some((part) => part === "__fixtures__" || part === "node_modules"),
		)
		.map((rel) => join("connectors", rel))
		.sort();
}

function collectFindings(): Finding[] {
	const files = connectorSourceFiles();
	if (files.length === 0) {
		throw new Error("no connector source files found under connectors/");
	}
	const scratchConfigPath = join(
		REPO_ROOT,
		`.biome-connector-stdout-console.${process.pid}.jsonc`,
	);
	const reportPath = join(
		mkdtempSync(join(tmpdir(), "pdpp-connector-console-")),
		"report.json",
	);
	const scratchConfig = JSON.stringify({
		root: true,
		linter: {
			rules: {
				suspicious: {
					noConsole: {
						level: "error",
						options: { allow: ["error", "warn"] },
					},
				},
			},
		},
	});
	writeFileSync(scratchConfigPath, scratchConfig);
	try {
		try {
			execFileSync(
				BIOME_BIN,
				[
					"lint",
					`--config-path=${scratchConfigPath}`,
					"--only=suspicious/noConsole",
					"--max-diagnostics=2000",
					"--reporter=json",
					`--reporter-file=${reportPath}`,
					...files,
				],
				{ cwd: REPO_ROOT, stdio: "pipe" },
			);
		} catch {
			// Biome exits non-zero when it reports any finding. The report file
			// carries the result, so the exit code is not checked here.
		}
		const report = JSON.parse(readFileSync(reportPath, "utf8")) as BiomeReport;
		return report.diagnostics
			.filter((d) => d.category === RULE_CATEGORY && d.location?.start)
			.map((d) => ({
				path: d.location?.path ?? "",
				line: d.location?.start?.line ?? 0,
				column: d.location?.start?.column ?? 0,
			}));
	} finally {
		rmSync(scratchConfigPath, { force: true });
		rmSync(dirname(reportPath), { recursive: true, force: true });
	}
}

function main(): void {
	const findings = collectFindings();
	if (findings.length === 0) {
		console.log(
			"[check-connector-stdout-console] no console.log/info/debug/dir/table/trace in connector source; stdout stays protocol-only.",
		);
		return;
	}
	console.error(
		`\n[check-connector-stdout-console] ${findings.length} console call(s) would write to stdout in connector source:`,
	);
	for (const f of findings) {
		console.error(`  ${f.path}:${f.line}:${f.column}`);
	}
	console.error(
		"\nConnector stdout is the PDPP protocol channel. Use console.error (stderr) for diagnostics, or delete the call.",
	);
	process.exit(1);
}

if (isMainModule(import.meta.url)) {
	main();
}
