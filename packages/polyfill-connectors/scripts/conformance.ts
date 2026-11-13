#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `conformance <connector>` — the one command a connector author runs to
 * find out whether their connector is ready for review.
 *
 * Steps:
 *
 *   1. manifest present + parseable, declares its own streams
 *   2. a test file exists, and its own suite passes
 *   3. pilot-real-shape fixture present (locks emitted-record shape
 *      against schema drift — src/pilot-fixture-test-helper.ts)
 *   4. evidence: a committed replay claim bound to this exact code
 *      (scripts/connector-evidence-summary.ts decides bound/stale/none)
 *   5. coverage: declared coverage strategies are emitted and exercised by
 *      the shared coverage oracle
 *   6. version: a new connector starts at 0.1.0 — ADVISORY
 *   7. shared helpers: jobs done by hand that the package already does — ADVISORY
 *   8. semantics: optional manifest declarations left undecided — ADVISORY
 *   9. mock-mutation verdict (scripts/mock-mutation-check.ts) — ADVISORY
 *
 * Steps 4-8 are pure functions in scripts/conformance-readiness.ts.
 *
 * HONESTY CONTRACT:
 *   - A check that cannot run reports UNKNOWN. It never becomes a PASS.
 *   - ADVISORY steps print, they do not fail: each is a decision for the
 *     author, and some do not apply to every connector.
 *   - Passing every step means "nothing mechanical is wrong". It does NOT
 *     mean the connector works against a real account. The evidence step
 *     says whether the author recorded such a run; a reviewer still reads
 *     the PR (CONNECTOR-REVIEW.md).
 *
 * Usage (from the repository root):
 *   npm run conformance -- <connector>
 *   npm run conformance -- <connector> --json
 *   npm run conformance -- <connector> --static   (skip tests and mock mutation; used by CI)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import { KNOWN_SCAFFOLD_CONNECTORS } from "../src/connector-conformance-roster.ts";
import {
	connectorsDir as CONNECTORS_DIR,
	fixturesDir,
	packageRoot as PACKAGE_ROOT,
	repoRoot,
	manifestPath as seamManifestPath,
} from "../src/connector-paths.ts";
import {
	computeDeclarationDigest,
	computeSourceDigest,
} from "../src/scenario/validate.ts";
import {
	checkCoverageProof,
	checkEvidence,
	checkSemantics,
	checkSharedHelpers,
	checkVersion,
	parseUnexercisedCoverage,
	type ReadinessManifest,
	type Step,
	type Verdict,
} from "./conformance-readiness.ts";
import { evaluateConnectorEvidence } from "./connector-evidence-summary.ts";

function manifestPath(connector: string): string {
	return seamManifestPath(connector);
}

export function checkManifest(connector: string): Step {
	const file = manifestPath(connector);
	if (!existsSync(file)) {
		return {
			detail: `no manifest at connectors/${connector}/manifest.json`,
			name: "manifest",
			nextAction: `create connectors/${connector}/manifest.json — copy the shape of an existing manifest (e.g. connectors/ynab/manifest.json) and declare this connector's streams`,
			verdict: "FAIL",
		};
	}
	try {
		const manifest = JSON.parse(readFileSync(file, "utf8")) as {
			capabilities?: { public_listing?: { tier?: string } };
			streams?: unknown;
		};
		const streams = Array.isArray(manifest.streams)
			? manifest.streams.length
			: 0;
		if (streams === 0) {
			return {
				detail: "manifest declares no streams",
				name: "manifest",
				nextAction: `add at least one entry to the "streams" array in connectors/${connector}/manifest.json`,
				verdict: "FAIL",
			};
		}
		const tier = manifest.capabilities?.public_listing?.tier ?? "unset";
		return {
			detail: `${streams} stream(s), lifecycle tier "${tier}"`,
			name: "manifest",
			verdict: "PASS",
		};
	} catch (err) {
		return {
			detail: `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			name: "manifest",
			nextAction: `fix the JSON syntax error in connectors/${connector}/manifest.json`,
			verdict: "FAIL",
		};
	}
}

function checkTests(connector: string): Step {
	const dir = join(CONNECTORS_DIR, connector);
	if (!existsSync(dir)) {
		return {
			detail: `no connector directory at connectors/${connector}`,
			name: "tests",
			nextAction: `create connectors/${connector}/ — copy the layout of an existing connector (index.ts, schemas.ts, *.test.ts)`,
			verdict: "FAIL",
		};
	}
	const testFiles = readdirSync(dir).filter(
		(f) => f.endsWith(".test.ts") && !f.startsWith("__mutation_scratch_"),
	);
	if (testFiles.length === 0) {
		return {
			detail:
				"no test file — cannot be checked, which is not the same as passing",
			name: "tests",
			nextAction: `add a connectors/${connector}/integration.test.ts that exercises real collection logic — see packages/polyfill-connectors/docs/connector-authoring-guide.md`,
			verdict: "UNKNOWN",
		};
	}
	try {
		execFileSync(
			process.execPath,
			["--test", "--import", "tsx", ...testFiles.map((f) => join(dir, f))],
			{
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
				// A passing suite can print more than the 1 MB default (chatgpt's
				// diagnostics run to ~3 MB), and ENOBUFS would read as a failure.
				maxBuffer: 64 * 1024 * 1024,
				stdio: "pipe",
				timeout: 300_000,
			},
		);
		return {
			detail: `${testFiles.length} test file(s) pass`,
			name: "tests",
			verdict: "PASS",
		};
	} catch {
		return {
			detail: `suite FAILS — run: npx tsx --test connectors/${connector}/*.test.ts`,
			name: "tests",
			nextAction: `run \`npx tsx --test connectors/${connector}/*.test.ts\` locally and fix the failing assertion(s) before anything else here matters`,
			verdict: "FAIL",
		};
	}
}

const PILOT_GUIDE =
	'packages/polyfill-connectors/docs/connector-authoring-guide.md, "The pilot-real-shape fixture"';

function pilotProvenance(dir: string): string {
	try {
		const parsed = JSON.parse(
			readFileSync(join(dir, "provenance.json"), "utf8"),
		) as { class?: unknown };
		return typeof parsed.class === "string" ? parsed.class : "unlabelled";
	} catch {
		return "unlabelled";
	}
}

function checkPilotFixture(connector: string): Step {
	const dir = join(fixturesDir(connector), "scrubbed", "pilot-real-shape");
	if (!existsSync(dir)) {
		return {
			detail:
				"no pilot-real-shape fixture — emitted-record shape is not locked against schema drift",
			name: "pilot fixture",
			nextAction: `add connectors/${connector}/fixtures/scrubbed/pilot-real-shape/records/<stream>.jsonl: synthetic rows with the field shapes a real run emits (connector-init writes a starter set), plus a pilot-fixture.test.ts that calls registerPilotFixtureTests. Never commit real account rows there (${PILOT_GUIDE})`,
			verdict: "UNKNOWN",
		};
	}
	const records = join(dir, "records");
	const streams = existsSync(records)
		? readdirSync(records).filter((f) => f.endsWith(".jsonl")).length
		: 0;
	if (streams > 0) {
		return {
			detail: `${streams} stream fixture(s) present (provenance: ${pilotProvenance(dir)})`,
			name: "pilot fixture",
			verdict: "PASS",
		};
	}
	return {
		detail: `${streams} stream fixture(s) present`,
		name: "pilot fixture",
		nextAction: `connectors/${connector}/fixtures/scrubbed/pilot-real-shape/records/ has no .jsonl files — add one synthetic, shape-real file per stream (${PILOT_GUIDE})`,
		verdict: "UNKNOWN",
	};
}

function checkMockMutation(connector: string): Step {
	try {
		const out = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				join(PACKAGE_ROOT, "scripts", "mock-mutation-check.ts"),
				`--connector=${connector}`,
				"--json",
			],
			{ cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe", timeout: 600_000 },
		);
		const parsed = JSON.parse(out) as Array<{
			detail: string;
			verdict: string;
		}>;
		const [first] = parsed;
		if (!first) {
			return {
				advisory: true,
				detail: "no result",
				name: "mock mutation",
				verdict: "UNKNOWN",
			};
		}
		const verdict = first.verdict as Verdict;
		let nextAction: string | undefined;
		if (verdict === "UNKNOWN") {
			nextAction = `this connector's test(s) have no request-path-matching literal (identifier === "/foo", .startsWith("/foo"), .includes("/foo")) — if it makes real HTTP requests, add a fake-server/route assertion that checks the actual path, not just query params or headers`;
		} else if (verdict === "WEAK") {
			nextAction =
				"one or more path literals are decorative (the suite still passes when corrupted) — see the literal(s) named in the detail above and add an assertion that fails when that exact path is wrong";
		}
		return {
			advisory: true,
			detail: first.detail,
			name: "mock mutation",
			...(nextAction ? { nextAction } : {}),
			verdict,
		};
	} catch (err) {
		return {
			advisory: true,
			detail: `could not run: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
			name: "mock mutation",
			nextAction: `run \`node --import tsx scripts/mock-mutation-check.ts --connector=${connector}\` directly to see the underlying error`,
			verdict: "UNKNOWN",
		};
	}
}

/** Concatenated non-test source of a connector, for the static readiness checks. */
function connectorSource(connector: string): string {
	const root = join(CONNECTORS_DIR, connector);
	const parts: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) {
				if (!["evidence", "fixtures", "node_modules"].includes(entry)) {
					walk(path);
				}
			} else if (
				/\.(?:[cm]?[jt]s)$/.test(entry) &&
				!/\.test\.[cm]?[jt]s$/.test(entry)
			) {
				parts.push(`// ${relative(root, path)}\n${readFileSync(path, "utf8")}`);
			}
		}
	};
	if (existsSync(root)) walk(root);
	return parts.join("\n");
}

/** The manifest version on the base branch; null = connector is new; undefined = no base to compare. */
function baseManifestVersion(connector: string): string | null | undefined {
	const git = (args: string[]): string =>
		execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: "pipe",
		});
	for (const ref of ["origin/main", "upstream/main", "main"]) {
		try {
			git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
		} catch {
			continue;
		}
		try {
			const text = git([
				"show",
				`${ref}:connectors/${connector}/manifest.json`,
			]);
			const version = (JSON.parse(text) as { version?: unknown }).version;
			return typeof version === "string" ? version : "";
		} catch {
			return null;
		}
	}
	return undefined;
}

export function readinessSteps(connector: string): Step[] {
	const manifestFile = manifestPath(connector);
	const manifest = JSON.parse(
		readFileSync(manifestFile, "utf8"),
	) as ReadinessManifest;
	const dir = join(CONNECTORS_DIR, connector);
	const source = connectorSource(connector);
	const driversFile = join(
		CONNECTORS_DIR,
		"_conformance",
		"coverage-conformance-drivers.ts",
	);
	const unexercised = existsSync(driversFile)
		? parseUnexercisedCoverage(readFileSync(driversFile, "utf8"))
		: new Set<string>();
	const evidence = evaluateConnectorEvidence(
		connector,
		join(dir, "evidence", "claim.json"),
		computeSourceDigest(dir),
		computeDeclarationDigest(manifestFile),
	);
	const version = checkVersion(manifest, baseManifestVersion(connector));
	return [
		checkEvidence(connector, evidence.status, evidence.malformedError),
		checkCoverageProof(connector, manifest, source, unexercised),
		...(version ? [version] : []),
		checkSharedHelpers(source, manifest),
		checkSemantics(manifest),
	];
}

/**
 * `staticOnly` skips the two steps that execute connector code (its test
 * suite and the mock-mutation run), so CI can report the rest in seconds.
 */
export function runConformance(
	connector: string,
	{ staticOnly = false }: { staticOnly?: boolean } = {},
): Step[] {
	const manifest = checkManifest(connector);
	if (manifest.verdict === "FAIL") {
		return [manifest];
	}
	return [
		manifest,
		...(staticOnly ? [] : [checkTests(connector)]),
		checkPilotFixture(connector),
		...readinessSteps(connector),
		...(staticOnly ? [] : [checkMockMutation(connector)]),
	];
}

const GLYPH: Record<Verdict, string> = {
	ADVISORY: "·",
	FAIL: "✖",
	PASS: "✔",
	UNKNOWN: "?",
	WEAK: "⚠",
};

function main(): void {
	const args = process.argv.slice(2);
	const jsonOut = args.includes("--json");
	const staticOnly = args.includes("--static");
	const connector = args.find((a) => !a.startsWith("--"));
	if (!connector) {
		console.error("usage: conformance <connector> [--json] [--static]");
		process.exit(2);
	}

	const steps = runConformance(connector, { staticOnly });
	const isKnownScaffold = (
		KNOWN_SCAFFOLD_CONNECTORS as readonly string[]
	).includes(connector);

	if (jsonOut) {
		console.log(JSON.stringify({ connector, isKnownScaffold, steps }, null, 2));
	} else {
		console.log(`\nconformance: ${connector}\n`);
		if (isKnownScaffold) {
			console.log(
				`NOTE: ${connector} is a KNOWN SCAFFOLD (src/connector-conformance-roster.ts) — it emits an unconditional SKIP_RESULT and does not collect yet. The pilot-fixture, evidence, coverage and mock-mutation gaps below are expected until real collection is wired up; they are not this connector's next action. Wiring the collector is.\n`,
			);
		}
		for (const s of steps) {
			console.log(`${GLYPH[s.verdict]} ${s.name.padEnd(16)} ${s.detail}`);
			if (s.nextAction) {
				console.log(`  → ${s.nextAction}`);
			}
		}
		const blocking = steps.filter((s) => !s.advisory && s.verdict === "FAIL");
		const unknown = steps.filter((s) => !s.advisory && s.verdict === "UNKNOWN");
		// An advisory WEAK/UNKNOWN still qualifies the all-clear: a decorative mock
		// means the suite that just passed would not have caught a wrong path, which
		// is precisely how jellyfin shipped green and broken.
		const softGaps = steps.filter(
			(s) => s.advisory && (s.verdict === "WEAK" || s.verdict === "UNKNOWN"),
		);
		let summary: string;
		if (blocking.length > 0) {
			summary = `\nNOT READY — ${blocking.length} blocking failure(s).`;
		} else if (unknown.length + softGaps.length > 0) {
			summary = `\nNo blocking failures, but ${unknown.length + softGaps.length} check(s) could not run or found soft spots. That is a gap, not a pass.`;
		} else if (softGaps.length > 0) {
			summary = `\nNo blocking failures, but ${softGaps.length} advisory gap(s) above mean the suite has soft spots. This does NOT mean it works against a real account.`;
		} else {
			summary =
				"\nNothing mechanical is wrong. This does NOT mean it works against a real account — only a real run shows that.";
		}
		console.log(summary);
	}

	process.exit(steps.some((s) => !s.advisory && s.verdict === "FAIL") ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
	main();
}
