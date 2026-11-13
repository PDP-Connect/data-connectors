// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkManifest, readinessSteps } from "../scripts/conformance.ts";
import {
	checkCoverageProof,
	checkEvidence,
	checkSemantics,
	checkSharedHelpers,
	checkVersion,
	listOpenSemantics,
	parseUnexercisedCoverage,
	type ReadinessManifest,
} from "../scripts/conformance-readiness.ts";
import { connectorsDir } from "./connector-paths.ts";

test("conformance reports the manifest's lifecycle tier", () => {
	const step = checkManifest("google_maps");
	assert.equal(step.verdict, "PASS");
	assert.match(step.detail, /lifecycle tier "supported"/);
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
	assert.equal(checkEvidence("x", "bound").verdict, "PASS");
	assert.equal(checkEvidence("x", "stale").verdict, "WEAK");
	const malformed = checkEvidence("x", "malformed", "not valid JSON");
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
		new Set(),
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
		new Set(["readwise.highlights"]),
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
		new Set(),
	);
	assert.equal(step.verdict, "PASS");
});

test("coverage: a coverage_diagnostics receipt counts as a coverage report", () => {
	const step = checkCoverageProof(
		"apple_health",
		snapshotManifest,
		'const COVERAGE_STREAM = "coverage_diagnostics";',
		new Set(),
	);
	assert.equal(step.verdict, "PASS");
});

test("parseUnexercisedCoverage reads the real ratchet without importing the drivers", () => {
	const text = readFileSync(
		join(connectorsDir, "_conformance", "coverage-conformance-drivers.ts"),
		"utf8",
	);
	const set = parseUnexercisedCoverage(text);
	assert.ok(set.has("chase.accounts"), "known ratchet entry present");
	assert.ok(![...set].some((e) => e.includes("//")), "comments stripped");
	assert.ok([...set].every((e) => /^[a-z0-9_]+\.[a-z0-9_]+$/.test(e)));
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
