// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for connector-evidence-summary.ts's pure core: the digest-binding
 * decision (`evaluateConnectorEvidence`), the Markdown summary
 * (`renderSummaryMarkdown`), and the label set (`labelsForRows`) — no
 * filesystem, no subprocess, no git. `readClaimFile`'s shape validation
 * (the thing that decides `malformed` vs `none`) gets its own tmpdir-backed
 * tests since it's the one function here that actually touches a file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ALL_EVIDENCE_LABELS,
	evaluateConnectorEvidence,
	labelsForRows,
	readClaimFile,
	renderSummaryMarkdown,
} from "./connector-evidence-summary.ts";

function withTmpDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "connector-evidence-summary-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function validClaim(overrides = {}) {
	return {
		schema: "pdpp.connector-claim/1",
		connector: "toy",
		captured_at: "2026-10-05T00:00:00.000Z",
		verified_at: "2026-10-05T00:01:00.000Z",
		claim: "diagnostic_replay",
		limitations: ["some limitation"],
		coverage: [],
		runs: 1,
		drivers: ["recorded-http"],
		captured_with: { source_digest: "abc123", declaration_digest: "def456" },
		verified_subject: { source_digest: "abc123", declaration_digest: "def456" },
		scenario_path: "toy.scenario.json",
		scenario_status: "candidate oracle",
		...overrides,
	};
}

// ─── readClaimFile ──────────────────────────────────────────────────────

test("readClaimFile: a missing file reads as 'none', not an error", () => {
	withTmpDir((dir) => {
		const result = readClaimFile(join(dir, "nope.json"));
		assert.deepEqual(result, { status: "none" });
	});
});

test("readClaimFile: a well-formed claim reads as 'ok'", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(path, JSON.stringify(validClaim()));
		const result = readClaimFile(path);
		assert.equal(result.status, "ok");
		assert.equal(result.claim.claim, "diagnostic_replay");
	});
});

test("readClaimFile: invalid JSON is 'malformed', not a thrown exception", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(path, "{not json");
		const result = readClaimFile(path);
		assert.equal(result.status, "malformed");
		assert.match(result.error, /not valid JSON/);
	});
});

test("readClaimFile: a JSON array (not an object) is 'malformed'", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(path, "[]");
		const result = readClaimFile(path);
		assert.equal(result.status, "malformed");
		assert.match(result.error, /not a JSON object/);
	});
});

test("readClaimFile: wrong schema value is 'malformed'", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(validClaim({ schema: "something-else/1" })),
		);
		const result = readClaimFile(path);
		assert.equal(result.status, "malformed");
		assert.match(result.error, /schema field/);
	});
});

test("readClaimFile: captured_with with a non-string, non-null digest is 'malformed'", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: 123, declaration_digest: null },
				}),
			),
		);
		const result = readClaimFile(path);
		assert.equal(result.status, "malformed");
		assert.match(result.error, /captured_with/);
	});
});

test("readClaimFile: limitations as a non-array is 'malformed'", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(validClaim({ limitations: "not an array" })),
		);
		const result = readClaimFile(path);
		assert.equal(result.status, "malformed");
		assert.match(result.error, /limitations/);
	});
});

// ─── evaluateConnectorEvidence: digest-binding decision ────────────────

test("evaluateConnectorEvidence: no claim file -> status 'none'", () => {
	withTmpDir((dir) => {
		const row = evaluateConnectorEvidence(
			"toy",
			join(dir, "claim.json"),
			"cur-src",
			"cur-decl",
		);
		assert.deepEqual(row, {
			connector: "toy",
			status: "none",
			notEstablished: [],
		});
	});
});

test("evaluateConnectorEvidence: a malformed claim surfaces its error, never computes a binding", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(path, "{broken");
		const row = evaluateConnectorEvidence("toy", path, "cur-src", "cur-decl");
		assert.equal(row.status, "malformed");
		assert.match(row.malformedError, /not valid JSON/);
	});
});

test("evaluateConnectorEvidence: current digests matching captured_with exactly -> BOUND", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: "src1", declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, "src1", "decl1");
		assert.equal(row.status, "bound");
	});
});

test("evaluateConnectorEvidence: a differing CURRENT source digest -> STALE", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: "src1", declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, "src2-CHANGED", "decl1");
		assert.equal(row.status, "stale");
	});
});

test("evaluateConnectorEvidence: a differing CURRENT declaration digest (manifest changed) -> STALE", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: "src1", declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, "src1", "decl2-CHANGED");
		assert.equal(row.status, "stale");
	});
});

test("evaluateConnectorEvidence: a null captured_with digest (legacy/incomplete claim) never reads as BOUND, even if current happens to equal null", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: null, declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, undefined, "decl1");
		assert.equal(row.status, "stale");
	});
});

test("evaluateConnectorEvidence: undefined CURRENT digests (connector dir/manifest missing) never read as BOUND", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					captured_with: { source_digest: "src1", declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, undefined, undefined);
		assert.equal(row.status, "stale");
	});
});

test("evaluateConnectorEvidence: notEstablished always includes the maintainer-live-run disclosure, alongside the claim's own limitations", () => {
	withTmpDir((dir) => {
		const path = join(dir, "claim.json");
		writeFileSync(
			path,
			JSON.stringify(
				validClaim({
					limitations: ["network isolation: process-local only"],
					captured_with: { source_digest: "src1", declaration_digest: "decl1" },
				}),
			),
		);
		const row = evaluateConnectorEvidence("toy", path, "src1", "decl1");
		assert.ok(
			row.notEstablished.includes("network isolation: process-local only"),
		);
		assert.ok(
			row.notEstablished.some((l) => l.includes("maintainer live run")),
		);
	});
});

// ─── renderSummaryMarkdown ──────────────────────────────────────────────

test("renderSummaryMarkdown: no changed connectors renders a short, honest note", () => {
	const md = renderSummaryMarkdown([]);
	assert.match(md, /No connector under `connectors\/` changed/);
});

test("renderSummaryMarkdown: a 'none' row names the connector and says evidence: none", () => {
	const md = renderSummaryMarkdown([
		{ connector: "foo", status: "none", notEstablished: [] },
	]);
	assert.match(md, /### `foo`/);
	assert.match(md, /evidence: none/);
});

test("renderSummaryMarkdown: a 'malformed' row surfaces the parse error text", () => {
	const md = renderSummaryMarkdown([
		{
			connector: "foo",
			status: "malformed",
			malformedError: "schema field is wrong",
			notEstablished: [],
		},
	]);
	assert.match(md, /schema field is wrong/);
	assert.match(md, /evidence: none/);
});

test("renderSummaryMarkdown: a 'bound' row prints the claim, dates, and BOUND — no stale caveat text", () => {
	const md = renderSummaryMarkdown([
		{
			connector: "foo",
			status: "bound",
			claim: "diagnostic_replay",
			capturedAt: "2026-10-05T00:00:00.000Z",
			verifiedAt: "2026-10-05T00:01:00.000Z",
			notEstablished: ["maintainer live run against the real provider"],
		},
	]);
	assert.match(md, /`diagnostic_replay`/);
	assert.match(md, /BOUND/);
	assert.ok(!md.includes("STALE"));
	assert.match(md, /author-run/);
	assert.match(md, /maintainer live run against the real provider/);
});

test("renderSummaryMarkdown: a 'stale' row prints STALE with the drift caveat sentence", () => {
	const md = renderSummaryMarkdown([
		{
			connector: "foo",
			status: "stale",
			claim: "diagnostic_replay",
			capturedAt: "2026-10-05T00:00:00.000Z",
			verifiedAt: "2026-10-05T00:01:00.000Z",
			notEstablished: [],
		},
	]);
	assert.match(
		md,
		/STALE — connector code or manifest changed since this claim was captured/,
	);
});

test("renderSummaryMarkdown: multiple connectors render as independent sections, in the given order", () => {
	const md = renderSummaryMarkdown([
		{ connector: "aaa", status: "none", notEstablished: [] },
		{ connector: "zzz", status: "none", notEstablished: [] },
	]);
	assert.ok(md.indexOf("### `aaa`") < md.indexOf("### `zzz`"));
});

// ─── labelsForRows ──────────────────────────────────────────────────────

test("labelsForRows: a bound-only PR gets exactly 'evidence: author-replay'", () => {
	const labels = labelsForRows([
		{ connector: "foo", status: "bound", notEstablished: [] },
	]);
	assert.deepEqual(labels, ["evidence: author-replay"]);
});

test("labelsForRows: a stale-only PR gets exactly 'evidence: stale'", () => {
	const labels = labelsForRows([
		{ connector: "foo", status: "stale", notEstablished: [] },
	]);
	assert.deepEqual(labels, ["evidence: stale"]);
});

test("labelsForRows: 'none' and 'malformed' both map to 'evidence: none'", () => {
	assert.deepEqual(
		labelsForRows([{ connector: "foo", status: "none", notEstablished: [] }]),
		["evidence: none"],
	);
	assert.deepEqual(
		labelsForRows([
			{ connector: "foo", status: "malformed", notEstablished: [] },
		]),
		["evidence: none"],
	);
});

test("labelsForRows: a PR touching connectors in different states gets every applicable label, deduplicated", () => {
	const labels = labelsForRows([
		{ connector: "a", status: "bound", notEstablished: [] },
		{ connector: "b", status: "stale", notEstablished: [] },
		{ connector: "c", status: "bound", notEstablished: [] },
		{ connector: "d", status: "none", notEstablished: [] },
	]);
	assert.deepEqual(
		new Set(labels),
		new Set(["evidence: author-replay", "evidence: stale", "evidence: none"]),
	);
	assert.equal(labels.length, 3, "each label must appear exactly once");
});

test("labelsForRows: zero rows yields zero labels", () => {
	assert.deepEqual(labelsForRows([]), []);
});

test("ALL_EVIDENCE_LABELS: exactly the three documented label strings, deduplicated", () => {
	assert.deepEqual(
		new Set(ALL_EVIDENCE_LABELS),
		new Set(["evidence: author-replay", "evidence: stale", "evidence: none"]),
	);
});
