#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CI's informational "what's established about this connector" summary —
 * acceptance test 2 from the scenario-evidence work: "a published PR shows
 * machine-generated claims that CI checked", readable by a maintainer with
 * no account on the provider.
 *
 * Reads, for every connector a PR touches, the committed
 * `connectors/<name>/evidence/claim.json` (the `pdpp.connector-claim/1`
 * record `bin/scenario-verify.ts --json` writes — see
 * `docs/connector-authoring-guide.md`'s "Scenario replay evidence" section
 * for the authoring convention), recomputes the connector's CURRENT source
 * and declaration digests with the exact same functions
 * `bin/scenario-record.ts`/`bin/scenario-verify.ts` use
 * (`computeSourceDigest`/`computeDeclarationDigest`, src/scenario/validate.ts),
 * and reports whether the claim is still BOUND to this code (digests match)
 * or STALE (code changed since the claim was captured).
 *
 * Does NOT re-execute anything against a real provider — "who produced
 * this evidence" is always `author-run`; a maintainer live run is always
 * reported as not established. This script proves CODE BINDING, never
 * CURRENTNESS against the live provider.
 *
 * INFORMATIONAL BY DESIGN: the CLI entry point below exits nonzero ONLY
 * when a COMMITTED claim.json fails to parse as the shape this schema
 * version requires — a connector with no claim at all is a normal, honest
 * "evidence: none" row, never a failure. The calling workflow must never
 * add this job to a required/blocking check.
 *
 * Pure, exported, unit-tested core (`evaluateConnectorEvidence`,
 * `renderSummaryMarkdown`, `labelsForRows`) with a thin CLI `main()` at the
 * bottom — same split this package's other `scripts/check-*.ts` gates use.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	connectorDir as resolveConnectorDir,
	manifestPath as resolveManifestPath,
} from "../src/connector-paths.ts";
import {
	computeDeclarationDigest,
	computeSourceDigest,
} from "../src/scenario/validate.ts";

/** The subset of `pdpp.connector-claim/1` this summary reads. Mirrors
 *  `writeClaimRecord`'s own shape (bin/scenario-verify.ts) — kept as a
 *  loose, independently-validated type here rather than imported, because
 *  this script's whole job is to NOT trust a committed file's shape
 *  without checking it first (the file was written by someone else's run,
 *  possibly an older scenario-verify.ts version). */
export interface ConnectorClaimRecord {
	captured_at: string;
	captured_with: {
		declaration_digest: string | null;
		source_digest: string | null;
	};
	claim: string;
	coverage: readonly string[];
	drivers: readonly string[];
	limitations: readonly string[];
	runs: number;
	schema: string;
	scenario_path: string;
	verified_at: string;
}

export type ClaimReadResult =
	| { readonly status: "malformed"; readonly error: string }
	| { readonly status: "none" }
	| { readonly claim: ConnectorClaimRecord; readonly status: "ok" };

const EXPECTED_SCHEMA = "pdpp.connector-claim/1";

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDigestPair(value: unknown): value is {
	declaration_digest: string | null;
	source_digest: string | null;
} {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const v = value as Record<string, unknown>;
	const isStringOrNull = (x: unknown) => x === null || typeof x === "string";
	return (
		isStringOrNull(v.source_digest) && isStringOrNull(v.declaration_digest)
	);
}

/**
 * Reads and shape-validates one connector's committed claim. The ONLY
 * reason this ever returns `malformed` (the one condition that fails this
 * script's CLI exit code) is a committed file that doesn't match
 * `pdpp.connector-claim/1`'s shape — a missing file is `none`, never an
 * error.
 */
export function readClaimFile(claimPath: string): ClaimReadResult {
	if (!existsSync(claimPath)) {
		return { status: "none" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(claimPath, "utf8"));
	} catch (err) {
		return {
			status: "malformed",
			error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { status: "malformed", error: "not a JSON object" };
	}
	const v = parsed as Record<string, unknown>;
	if (v.schema !== EXPECTED_SCHEMA) {
		return {
			status: "malformed",
			error: `schema field is ${JSON.stringify(v.schema)}, expected ${JSON.stringify(EXPECTED_SCHEMA)}`,
		};
	}
	if (typeof v.connector !== "string" || v.connector.length === 0) {
		return { status: "malformed", error: "missing or empty connector" };
	}
	if (typeof v.captured_at !== "string" || typeof v.verified_at !== "string") {
		return {
			status: "malformed",
			error: "missing or non-string captured_at/verified_at",
		};
	}
	if (typeof v.claim !== "string" || v.claim.length === 0) {
		return { status: "malformed", error: "missing or empty claim" };
	}
	if (!isStringArray(v.limitations)) {
		return { status: "malformed", error: "limitations is not a string array" };
	}
	if (!isStringArray(v.coverage)) {
		return { status: "malformed", error: "coverage is not a string array" };
	}
	if (!isStringArray(v.drivers)) {
		return { status: "malformed", error: "drivers is not a string array" };
	}
	if (typeof v.runs !== "number") {
		return { status: "malformed", error: "runs is not a number" };
	}
	if (!isDigestPair(v.captured_with)) {
		return {
			status: "malformed",
			error: "captured_with is not a valid digest pair",
		};
	}
	if (typeof v.scenario_path !== "string" || v.scenario_path.length === 0) {
		return { status: "malformed", error: "missing or empty scenario_path" };
	}
	return {
		status: "ok",
		claim: {
			captured_at: v.captured_at,
			captured_with: v.captured_with,
			claim: v.claim,
			coverage: v.coverage,
			drivers: v.drivers,
			limitations: v.limitations,
			runs: v.runs,
			schema: v.schema,
			scenario_path: v.scenario_path,
			verified_at: v.verified_at,
		},
	};
}

export type EvidenceStatus = "bound" | "malformed" | "none" | "stale";

export interface ConnectorEvidenceRow {
	readonly claim?: string;
	readonly capturedAt?: string;
	readonly connector: string;
	readonly malformedError?: string;
	readonly notEstablished: readonly string[];
	readonly status: EvidenceStatus;
	readonly verifiedAt?: string;
}

const MAINTAINER_LIVE_RUN_NOT_ESTABLISHED =
	"maintainer live run against the real provider (this is an author-run replay claim, never re-executed by CI)";

/**
 * The one place a claim's digests are compared against the connector's
 * CURRENT on-disk digests to decide bound vs. stale. `undefined` current
 * digests (connector directory/manifest missing — should not happen for a
 * connector this PR actually changed, but checked rather than assumed)
 * can never read as bound: this function never calls a claim BOUND without
 * two real, present, equal digest pairs.
 */
function isBound(
	claim: ConnectorClaimRecord,
	currentSourceDigest: string | undefined,
	currentDeclarationDigest: string | undefined,
): boolean {
	return (
		claim.captured_with.source_digest !== null &&
		claim.captured_with.declaration_digest !== null &&
		claim.captured_with.source_digest === currentSourceDigest &&
		claim.captured_with.declaration_digest === currentDeclarationDigest
	);
}

/**
 * Evaluates one connector's evidence row. `claimPath` is passed in (rather
 * than derived here from `connector`) so a test can point it at a fixture
 * without touching the real `connectors/` tree.
 */
export function evaluateConnectorEvidence(
	connector: string,
	claimPath: string,
	currentSourceDigest: string | undefined,
	currentDeclarationDigest: string | undefined,
): ConnectorEvidenceRow {
	const read = readClaimFile(claimPath);
	if (read.status === "none") {
		return { connector, status: "none", notEstablished: [] };
	}
	if (read.status === "malformed") {
		return {
			connector,
			status: "malformed",
			malformedError: read.error,
			notEstablished: [],
		};
	}
	const { claim } = read;
	const bound = isBound(claim, currentSourceDigest, currentDeclarationDigest);
	return {
		connector,
		status: bound ? "bound" : "stale",
		claim: claim.claim,
		capturedAt: claim.captured_at,
		verifiedAt: claim.verified_at,
		notEstablished: [...claim.limitations, MAINTAINER_LIVE_RUN_NOT_ESTABLISHED],
	};
}

/** One short Markdown table per connector — the acceptance test's "shows
 *  machine-generated claims that CI checked" surface. Deterministic row
 *  order (the order `rows` was given in, never re-sorted) so a snapshot-
 *  style test can assert on exact output. */
export function renderSummaryMarkdown(
	rows: readonly ConnectorEvidenceRow[],
): string {
	if (rows.length === 0) {
		return "No connector under `connectors/` changed in this PR.\n";
	}
	const sections = rows.map((row) => {
		const lines = [`### \`${row.connector}\``, ""];
		if (row.status === "none") {
			lines.push(
				"No committed claim (`evidence/claim.json` not found). **evidence: none** — this connector has no established replay evidence yet.",
			);
			return lines.join("\n");
		}
		if (row.status === "malformed") {
			lines.push(
				`**evidence: none** — the committed \`evidence/claim.json\` is malformed: ${row.malformedError}. Fix or regenerate it (see docs/connector-authoring-guide.md, "Scenario replay evidence").`,
			);
			return lines.join("\n");
		}
		const boundLabel = row.status === "bound" ? "BOUND" : "STALE";
		lines.push(
			"| Field | Value |",
			"|---|---|",
			`| Claim | \`${row.claim}\` |`,
			`| Captured | ${row.capturedAt} |`,
			`| Verified by author | ${row.verifiedAt} |`,
			`| Code binding | ${boundLabel}${row.status === "stale" ? " — connector code or manifest changed since this claim was captured" : ""} |`,
			`| Produced by | author-run (not re-executed by CI) |`,
			"",
			"Not established:",
			...row.notEstablished.map((item) => `- ${item}`),
		);
		return lines.join("\n");
	});
	return `${sections.join("\n\n")}\n`;
}

const LABEL_FOR_STATUS: Record<EvidenceStatus, string> = {
	bound: "evidence: author-replay",
	stale: "evidence: stale",
	none: "evidence: none",
	malformed: "evidence: none",
};

export const ALL_EVIDENCE_LABELS: readonly string[] = [
	...new Set(Object.values(LABEL_FOR_STATUS)),
];

/** The dedup'd set of labels this PR's connector rows call for — a PR
 *  touching several connectors in different states gets every applicable
 *  label, not just the first/worst one. */
export function labelsForRows(rows: readonly ConnectorEvidenceRow[]): string[] {
	return [...new Set(rows.map((row) => LABEL_FOR_STATUS[row.status]))];
}

async function main(): Promise<void> {
	const connectors = process.argv.slice(2);
	if (connectors.length === 0) {
		process.stdout.write(
			"connector-evidence-summary: no changed connectors passed; nothing to do.\n",
		);
		return;
	}
	const rows: ConnectorEvidenceRow[] = [];
	let anyMalformed = false;
	for (const connector of connectors) {
		const dir = resolveConnectorDir(connector);
		const claimPath = join(dir, "evidence", "claim.json");
		const manifest = resolveManifestPath(connector);
		const currentSourceDigest = existsSync(dir)
			? computeSourceDigest(dir)
			: undefined;
		const currentDeclarationDigest = existsSync(manifest)
			? computeDeclarationDigest(manifest)
			: undefined;
		const row = evaluateConnectorEvidence(
			connector,
			claimPath,
			currentSourceDigest,
			currentDeclarationDigest,
		);
		rows.push(row);
		if (row.status === "malformed") {
			anyMalformed = true;
			process.stderr.write(
				`[connector-evidence-summary] ${connector}: evidence/claim.json is malformed: ${row.malformedError}\n`,
			);
		}
	}

	const summary = renderSummaryMarkdown(rows);
	process.stdout.write(summary);
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) {
		const { appendFileSync } = await import("node:fs");
		appendFileSync(summaryFile, summary);
	}
	const labels = labelsForRows(rows);
	const labelsFile = process.env.CONNECTOR_EVIDENCE_LABELS_FILE;
	if (labelsFile) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(labelsFile, labels.join("\n"));
	}

	if (anyMalformed) {
		process.stderr.write(
			"[connector-evidence-summary] FAIL — one or more committed claim.json files are malformed (missing evidence is fine; a broken committed file is not).\n",
		);
		process.exitCode = 1;
	}
}

if (process.argv[1]?.endsWith("connector-evidence-summary.ts")) {
	main().catch((err) => {
		process.stderr.write(
			`[connector-evidence-summary] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
		process.exitCode = 1;
	});
}
