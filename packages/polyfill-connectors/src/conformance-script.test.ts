// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkManifest, readinessSteps } from "../scripts/conformance.ts";
import {
	checkCoverageProof,
	checkEvidence,
	checkSemantics,
	checkSharedHelpers,
	checkVersion,
	declaredNoHttpExemption,
	listOpenSemantics,
	parseCoverageRegistry,
	type ReadinessManifest,
	requiredForReview,
	type Step,
	stripComments,
} from "../scripts/conformance-readiness.ts";
import { connectorsDir, repoRoot } from "./connector-paths.ts";

test("JSON conformance identifies its revision, scan mode and dirty subject", () => {
	const marker = join(
		repoRoot,
		`conformance-subject-${String(process.pid)}.txt`,
	);
	writeFileSync(marker, "owned synthetic report input\n", { flag: "wx" });
	try {
		const output = execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"packages/polyfill-connectors/scripts/conformance.ts",
				"readwise",
				"--json",
				"--static",
			],
			{
				cwd: repoRoot,
				encoding: "utf8",
				env: { ...process.env, CONFORMANCE_BASE_REF: "HEAD" },
			},
		);
		const report = JSON.parse(output);
		assert.equal(report.schema, "pdpp.conformance-report/1");
		assert.equal(report.mode, "static");
		assert.equal(report.base_revision, report.subject.revision);
		assert.equal(report.tier, "development");
		assert.equal(
			report.subject.revision,
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
			}).trim(),
		);
		assert.equal(report.subject.clean, false);
		assert.match(report.subject.source_digest, /^[a-f0-9]{64}$/);
		assert.match(report.subject.declaration_digest, /^[a-f0-9]{64}$/);
		assert.ok(
			report.steps.some((step: { name: string }) => step.name === "evidence"),
		);
		assert.equal(
			report.steps.find((step: { name: string }) => step.name === "coverage")
				.required_for_review,
			true,
		);
		assert.equal(
			report.steps.find((step: { name: string }) => step.name === "evidence")
				.required_for_review,
			false,
		);
	} finally {
		rmSync(marker);
	}
});

test("conformance reports the manifest's lifecycle tier", () => {
	const step = checkManifest("google_maps");
	assert.equal(step.verdict, "PASS");
	assert.match(step.detail, /lifecycle tier "supported"/);
	const report = JSON.parse(
		execFileSync(
			process.execPath,
			[
				"--import",
				"tsx",
				"packages/polyfill-connectors/scripts/conformance.ts",
				"google_maps",
				"--json",
				"--static",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		),
	);
	assert.equal(report.tier, "supported");
	for (const name of ["evidence", "pilot fixture"]) {
		assert.equal(
			report.steps.find((finding: { name: string }) => finding.name === name)
				.required_for_review,
			false,
		);
	}
});

test("review requirements preserve tier rules and disclosed legacy exemptions", () => {
	const promotion = {
		isKnownScaffold: false,
		promotedTier: true,
		legacyPromotion: false,
		noHttpExemption: false,
	};
	const finding = (name: string): Step => ({
		name,
		verdict: "UNKNOWN",
		detail: "not established",
	});
	for (const name of [
		"manifest",
		"tests",
		"coverage",
		"evidence",
		"pilot fixture",
		"mock mutation",
	]) {
		assert.equal(requiredForReview(finding(name), promotion), true, name);
	}
	assert.equal(
		requiredForReview(finding("evidence"), {
			...promotion,
			promotedTier: false,
		}),
		false,
	);
	assert.equal(
		requiredForReview(finding("evidence"), {
			...promotion,
			legacyPromotion: true,
		}),
		false,
	);
	assert.equal(
		requiredForReview(finding("coverage"), {
			...promotion,
			isKnownScaffold: true,
		}),
		false,
	);
	assert.equal(
		requiredForReview(finding("mock mutation"), {
			...promotion,
			noHttpExemption: true,
		}),
		false,
	);
	assert.equal(
		requiredForReview(
			{ ...finding("evidence"), verdict: "FAIL" },
			{ ...promotion, legacyPromotion: true },
		),
		true,
	);
});

test("only an explicit leading no-HTTP assertion exempts UNKNOWN mutation", () => {
	const header =
		"#!/usr/bin/env node\n// Copyright\n/**\n * @conformance-no-http Reads the owner's local archive only.\n */\n";
	assert.equal(
		declaredNoHttpExemption(`${header}export {};`),
		"Reads the owner's local archive only.",
	);
	assert.equal(declaredNoHttpExemption(`export {};\n${header}`), undefined);
	assert.equal(
		declaredNoHttpExemption("/**\n * @conformance-no-http   \n */"),
		undefined,
	);
	const context = {
		isKnownScaffold: false,
		promotedTier: true,
		legacyPromotion: false,
		noHttpExemption: true,
	};
	for (const verdict of ["WEAK", "FAIL"] as const) {
		assert.equal(
			requiredForReview(
				{
					name: "mock mutation",
					verdict,
					detail: "path test incomplete",
					advisory: true,
				},
				context,
			),
			true,
		);
	}
	// An optional network binding is not an explicit declaration of no HTTP.
	assert.equal(
		requiredForReview(
			{
				name: "mock mutation",
				verdict: "UNKNOWN",
				detail: "hybrid optional API has no route assertions",
			},
			{ ...context, noHttpExemption: false },
		),
		true,
	);
});

test("conformance points a missing manifest at connectors/<key>/manifest.json", () => {
	const step = checkManifest("no_such_connector");
	assert.equal(step.verdict, "FAIL");
	assert.match(step.detail, /connectors\/no_such_connector\/manifest\.json/);
	assert.doesNotMatch(step.nextAction ?? "", /manifests\//);
});

// ─── evidence ─────────────────────────────────────────────────────────────

test("evidence: no claim is a gap that names the record and verify commands", () => {
	const step = checkEvidence("readwise", "none");
	assert.equal(step.verdict, "UNKNOWN");
	assert.equal(step.advisory, undefined);
	assert.match(step.nextAction ?? "", /bin\/scenario-record\.ts readwise/);
	assert.match(
		step.nextAction ?? "",
		/--json connectors\/readwise\/evidence\/claim\.json/,
	);
});

test("evidence: bound passes, stale is weak, malformed fails", () => {
	const bound = checkEvidence("x", "bound", {
		notEstablished: ["maintainer live run against the real provider"],
	});
	assert.equal(bound.verdict, "PASS");
	assert.match(bound.detail, /does not establish: maintainer live run/);
	assert.equal(checkEvidence("x", "stale").verdict, "WEAK");
	const malformed = checkEvidence("x", "malformed", {
		malformedError: "not valid JSON",
	});
	assert.equal(malformed.verdict, "FAIL");
	assert.match(malformed.detail, /not valid JSON/);
});

// ─── coverage ─────────────────────────────────────────────────────────────

const snapshotManifest: ReadinessManifest = {
	streams: [
		{ coverage_strategy: "snapshot_import_receipt", name: "highlights" },
	],
};

test("coverage: a declared strategy with no coverage report in the source is a gap", () => {
	const step = checkCoverageProof(
		"readwise",
		snapshotManifest,
		'ctx.emit({ type: "STATE", stream: "highlights" });',
		{
			drivers: new Set(),
			unexercised: new Set(),
		},
	);
	assert.equal(step.verdict, "UNKNOWN");
	assert.match(step.detail, /never reports coverage/);
	assert.match(step.nextAction ?? "", /buildFullScanCoverageMessage/);
});

test("coverage: a stream on the KNOWN_UNEXERCISED_COVERAGE ratchet is a gap", () => {
	const step = checkCoverageProof(
		"readwise",
		snapshotManifest,
		"await ctx.emit(buildFullScanCoverageMessage(stream, n));",
		{
			drivers: new Set(["readwise"]),
			unexercised: new Set(["readwise.highlights"]),
		},
	);
	assert.equal(step.verdict, "UNKNOWN");
	assert.match(step.detail, /highlights listed in KNOWN_UNEXERCISED_COVERAGE/);
});

test("coverage: an optional stream on no ratchet passes once the source reports coverage", () => {
	const step = checkCoverageProof(
		"goodreads",
		{
			streams: [
				{ coverage_strategy: "full_inventory", name: "books", required: false },
			],
		},
		"await emitDetailCoverage(ctx, { stream: 'books' });",
		{ drivers: new Set(), unexercised: new Set() },
	);
	assert.equal(step.verdict, "PASS");
});

test("coverage: a coverage_diagnostics receipt counts as a coverage report", () => {
	const step = checkCoverageProof(
		"apple_health",
		snapshotManifest,
		'const COVERAGE_STREAM = "coverage_diagnostics";',
		{
			drivers: new Set(["apple_health"]),
			unexercised: new Set(),
		},
	);
	assert.equal(step.verdict, "PASS");
});

test("parseCoverageRegistry reads the real drivers file without importing it", () => {
	const text = readFileSync(
		join(connectorsDir, "_conformance", "coverage-conformance-drivers.ts"),
		"utf8",
	);
	const { drivers, unexercised } = parseCoverageRegistry(text);
	assert.ok(drivers.has("jellyfin"), "known driver present");
	assert.ok(drivers.has("groupme"), "a driver given as a constant is present");
	assert.ok(unexercised.has("chase.accounts"), "known ratchet entry present");
	assert.ok([...unexercised].every((e) => /^[a-z0-9_]+\.[a-z0-9_]+$/.test(e)));
	assert.deepEqual(parseCoverageRegistry(""), {
		drivers: new Set(),
		unexercised: new Set(),
	});
});

test("coverage: a required stream with no coverage driver is a gap, not a pass", () => {
	const step = checkCoverageProof(
		"readwise",
		snapshotManifest,
		"await ctx.emit(buildFullScanCoverageMessage(stream, n));",
		{ drivers: new Set(["ynab"]), unexercised: new Set() },
	);
	assert.equal(step.verdict, "UNKNOWN");
	assert.match(step.detail, /no coverage driver for readwise/);
});

test("stripComments keeps string contents that look like comment markers", () => {
	const source = [
		'const headers = { Accept: "*/*" };',
		'const path = "//api";',
		"await ctx.emit(buildFullScanCoverageMessage(stream, n)); // done",
		"/** A JSDoc block. */",
	].join("\n");
	const code = stripComments(source);
	assert.match(code, /buildFullScanCoverageMessage/);
	assert.match(code, /"\*\/\*"/);
	assert.match(code, /"\/\/api"/);
	assert.doesNotMatch(code, /done|JSDoc/);
});

test("coverage: a comment that names DETAIL_COVERAGE is not a coverage report", () => {
	const step = checkCoverageProof(
		"x",
		snapshotManifest,
		'// TODO emit DETAIL_COVERAGE\nctx.emit({ type: "STATE" });',
		{
			drivers: new Set(),
			unexercised: new Set(),
		},
	);
	assert.equal(step.verdict, "UNKNOWN");
});

test("readiness steps tolerate a malformed stream entry", () => {
	const manifest = {
		streams: [null, { name: "a", schema: { properties: { b: null } } }],
	} as unknown as ReadinessManifest;
	assert.doesNotThrow(() => listOpenSemantics(manifest));
	assert.equal(
		checkCoverageProof("x", manifest, "", {
			drivers: new Set(),
			unexercised: new Set(),
		}).verdict,
		"PASS",
	);
});

// ─── version ──────────────────────────────────────────────────────────────

test("version: a new connector above 0.1.0 is flagged; 0.1.0 and existing connectors are not", () => {
	const flagged = checkVersion({ version: "0.1.1" }, null);
	assert.equal(flagged?.verdict, "WEAK");
	assert.equal(flagged?.advisory, true);
	assert.match(flagged?.nextAction ?? "", /"version": "0\.1\.0"/);
	assert.equal(checkVersion({ version: "0.1.0" }, null)?.verdict, "PASS");
	assert.equal(checkVersion({ version: "2.3.0" }, "2.2.0"), null);
	assert.equal(checkVersion({ version: "2.3.0" }, undefined), null);
});

// ─── shared helpers ───────────────────────────────────────────────────────

const apiManifest: ReadinessManifest = {
	runtime_requirements: { bindings: {} },
};
const browserManifest: ReadinessManifest = {
	runtime_requirements: { bindings: { browser: { required: true } } },
};

test("shared helpers: an API connector handling 429 itself is told to use the governor", () => {
	const step = checkSharedHelpers(
		'if (response.status === 429) throw new Error("x_rate_limited");',
		apiManifest,
	);
	assert.equal(step.verdict, "WEAK");
	assert.equal(step.advisory, true);
	assert.match(step.nextAction ?? "", /createConnectorHttpGovernor/);
});

test("shared helpers: the governor rule does not apply to browser connectors", () => {
	const step = checkSharedHelpers(
		'if (status === 429) return { retryAfter: headers.get("retry-after") };',
		browserManifest,
	);
	assert.equal(step.verdict, "PASS");
});

test("shared helpers: a connector that uses the governor passes", () => {
	const step = checkSharedHelpers(
		"const gov = createConnectorHttpGovernor({ name, profile }); // handles 429",
		apiManifest,
	);
	assert.equal(step.verdict, "PASS");
});

test("shared helpers: rate-limit errors with no retryablePattern are flagged", () => {
	const source = [
		'throw new Error("x_rate_limited_try_later");',
		"runConnector({ name: 'x', collect });",
	].join("\n");
	const step = checkSharedHelpers(source, browserManifest);
	assert.equal(step.verdict, "WEAK");
	assert.match(step.nextAction ?? "", /retryable-pattern/);
	const withPattern = checkSharedHelpers(
		`${source}\nrunConnector({ retryablePattern: /rate_limited/ });`,
		browserManifest,
	);
	assert.equal(withPattern.verdict, "PASS");
});

test("shared helpers: an HTTP-status error with no retryablePattern is flagged", () => {
	const step = checkSharedHelpers(
		// The source text under test holds a template literal, so build it by parts.
		[
			"throw new Error(`x_http_$",
			"{response.status}`);\nrunConnector({ collect });",
		].join(""),
		browserManifest,
	);
	assert.match(step.nextAction ?? "", /retryable-pattern/);
});

test("shared helpers: a hand-built DETAIL_COVERAGE message is flagged", () => {
	const step = checkSharedHelpers(
		'await ctx.emit({ type: "DETAIL_COVERAGE", stream, considered, covered });',
		apiManifest,
	);
	assert.match(step.nextAction ?? "", /coverage-message/);
});

test("shared helpers: a governed connector still needs a retryablePattern for <name>_rate_limited", () => {
	const source =
		"const gov = createConnectorHttpGovernor({ name, profile });\nrunConnector({ name, collect });";
	const step = checkSharedHelpers(source, apiManifest);
	assert.match(step.nextAction ?? "", /retryable-pattern/);
	assert.equal(
		checkSharedHelpers(
			`${source}\nrunConnector({ retryablePattern: /rate_limited/ });`,
			apiManifest,
		).verdict,
		"PASS",
	);
	// goodreads catches the governor's error and reports a rate_limited skip.
	assert.equal(
		checkSharedHelpers(
			`${source}\nif (error instanceof ConnectorRateLimitedError) return skip;`,
			apiManifest,
		).verdict,
		"PASS",
	);
});

test("shared helpers: a literal HTTP 429 error counts, and a comment does not set retryablePattern", () => {
	const step = checkSharedHelpers(
		'throw new Error("HTTP 429");\n// TODO retryablePattern\nrunConnector({ collect });',
		browserManifest,
	);
	assert.match(step.nextAction ?? "", /retryable-pattern/);
});

// ─── semantics ────────────────────────────────────────────────────────────

test("semantics: lists each undecided optional declaration, advisory only", () => {
	const manifest: ReadinessManifest = {
		streams: [
			{
				coverage_strategy: "full_inventory",
				incremental: true,
				name: "highlights",
				schema: {
					properties: {
						book_id: { type: "string" },
						highlighted_at: { format: "date-time", type: "string" },
					},
				},
			},
			{ name: "books", schema: { properties: { id: { type: "string" } } } },
		],
	};
	const open = listOpenSemantics(manifest);
	const joined = open.join("\n");
	assert.match(joined, /highlights: consent_time_field .*highlighted_at/);
	assert.match(joined, /highlights: query\.aggregations\.group_by_time/);
	assert.match(joined, /highlights: cursor_field/);
	assert.match(joined, /field descriptions — 0 of 3/);
	assert.match(joined, /relationships/);
	assert.match(joined, /reason_display_messages/);
	assert.match(joined, /account streams/);
	const step = checkSemantics(manifest);
	assert.equal(step.verdict, "ADVISORY");
	assert.equal(step.advisory, true);
});

test("semantics: a singleton stream is not asked for a time range or a chart", () => {
	const open = listOpenSemantics({
		reason_display_messages: {},
		streams: [
			{
				coverage_strategy: "singleton_presence",
				name: "account_profile",
				schema: {
					properties: {
						created_at: {
							description: "When the account was created.",
							format: "date-time",
						},
					},
				},
			},
		],
	});
	assert.deepEqual(open, []);
});

// ─── wiring against real connectors ───────────────────────────────────────

test("readinessSteps: steam (governed API connector with a coverage driver) has no coverage or helper gaps", () => {
	const steps = readinessSteps("steam");
	const byName = new Map(steps.map((s) => [s.name, s.verdict]));
	assert.equal(byName.get("coverage"), "PASS");
	assert.equal(byName.get("shared helpers"), "PASS");
	assert.ok(byName.has("evidence"));
	assert.ok(byName.has("semantics"));
	assert.ok(!byName.has("reachability"), "the never-actionable step is gone");
});
