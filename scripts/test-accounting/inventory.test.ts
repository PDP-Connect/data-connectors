// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAuthority, suiteEnvironment } from "./authority.ts";
import {
	checkInventory,
	classifyTrackedPath,
	contentDigest,
	fileDigest,
	type Manifest,
	parseInventoryArgs,
	planFor,
	RECEIPT_SCHEMA,
	type Receipt,
	RUN_AUTHORITY_SCHEMA,
	RUN_COMPLETION_SCHEMA,
	readManifest,
	receiptBinding,
	trackedFiles,
	treeDigest,
	verifyReceipts,
} from "./inventory.ts";
import {
	assertNamedSkipMappingsFullyConsumed,
	repositoryPaths,
	configuredNamedSkipMappingIdentities,
	validateNamedSkipMappingTable,
	resolveNamedSkipMapping,
	structuredNodeSummary,
	structuredPythonSummary,
} from "./receipt.ts";

const STALE_NAMED_SKIP_MAPPING_PATTERN = /stale named skip mapping rows/;
const UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN = /not configured for this suite/;
const UNACCOUNTED_EXECUTABLE_TESTS_ALPHA_TEST_PATTERN =
	/unaccounted executable tests.*alpha\.test\.ts/;
const UNACCOUNTED_EXECUTABLE_TESTS_PATTERN = /unaccounted executable tests/;
const SELECTS_NO_EXECUTABLE_TESTS_PATTERN = /selects no executable tests/;
const MATCHES_NON_EXECUTABLE_CLASSIFIED_FILE_PATTERN =
	/matches a non-executable-classified file/;
const INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN =
	/include list matches no tracked file/;
const INVALID_SCHEMAS_PROVENANCE_PATTERN = /invalid schemas|provenance/;
const REPLAYED_PATTERN = /replayed/;
const EXPIRED_PATTERN = /expired/;
const ISSUED_AUTHORITY_FILES_DO_NOT_PATTERN =
	/issued authority|files do not match/;
const COMPLETION_DOES_NOT_BIND_PATTERN = /completion does not bind/;
const COMPLETION_DOES_NOT_BIND_GENERIC_PATTERN =
	/completion does not bind|generic/;
const UNDECLARED_PATTERN = /undeclared/;
const ISSUED_AUTHORITY_STALE_PATTERN = /issued authority|stale/;
const GENERIC_PATTERN = /generic/;
const COMPLETION_DOES_NOT_BIND_SKIPS_PATTERN =
	/completion does not bind|skips do not exactly match/;
const EXACTLY_ONE_MODE_PATTERN = /exactly one mode/;
const REQUIRES_EXACTLY_ONE_VALUE_PATTERN = /requires exactly one value/;
const UNKNOWN_ARGUMENT_PATTERN = /unknown argument/;
const CANNOT_COMBINE_ALL_PATTERN = /cannot combine all/;
const UNEXPLAINED_SKIP_PATTERN = /unexplained skip/;
const NO_STRUCTURED_NODE_EVENTS_PATTERN = /no structured node events/;
const OMITTED_A_SKIP_REASON_PATTERN = /omitted a skip reason/;
const FIXTURE_ENVIRONMENT_NAMES = [
	"FIXTURE_PARENT_TOKEN",
	"FIXTURE_PARENT_ROOT",
];

const digest = async (path: string) => contentDigest(await readFile(path));
const files = [
	"test/helper.js",
	"test/fixture.json",
	"test/alpha.test.js",
	"test/runner.test.mjs",
	"tools/probe.test.py",
	"tools/check.test.sh",
	"src/component.test.tsx",
];

function manifest(overrides: Partial<Manifest> = {}): Manifest {
	return {
		schema: "pdpp.test-accounting/v3",
		inventory_base_sha: "1111111111111111111111111111111111111111",
		suites: [
			{
				id: "node",
				cwd: ".",
				loader: "node-test",
				authority_argument: "--authority",
				command: ["node", "runner.mjs"],
				profiles: [{ id: "default", required: true, skip_reasons: {} }],
				include: ["test/*.test.js", "test/*.test.mjs"],
			},
		],
		exclusions: [
			{
				path: "tools/probe.test.py",
				reason: "python boundary",
				owner: "tooling",
				suite: "node",
				profile: "default",
				expires: "2027-12-31",
			},
			{
				path: "tools/check.test.sh",
				reason: "shell boundary",
				owner: "tooling",
				suite: "node",
				profile: "default",
				expires: "2027-12-31",
			},
			{
				path: "src/component.test.tsx",
				reason: "tsx boundary",
				owner: "tooling",
				suite: "node",
				profile: "default",
				expires: "2027-12-31",
			},
		],
		...overrides,
	};
}
async function fixture({
	expiresAt = "2030-07-23T00:00:00.000Z",
	counts = {
		assertions: 2,
		passed: 2,
		failed: 0,
		skipped: 0,
		skip_reasons: {},
		planned_files: 2,
		completed_files: 2,
	},
	runId = "11111111-1111-4111-8111-111111111111",
}: {
	expiresAt?: string;
	counts?: Receipt["counts"];
	runId?: string;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "pdpp-receipt-"));
	const directory = join(root, "authorities");
	await mkdir(join(root, "test"), { recursive: true });
	await mkdir(directory);
	await writeFile(
		join(root, "test", "alpha.test.js"),
		"export const alpha = true;\n",
	);
	await writeFile(
		join(root, "test", "runner.test.mjs"),
		"export const runner = true;\n",
	);
	await writeFile(join(root, "runner.mjs"), "process.exitCode = 0;\n");
	const localManifest = manifest({ exclusions: [] });
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(localManifest)}\n`,
	);
	const planned = ["test/alpha.test.js", "test/runner.test.mjs"];
	const issued = {
		schema: RUN_AUTHORITY_SCHEMA,
		run_id: runId,
		nonce: "nonce",
		issued_at: "2026-07-23T00:00:00.000Z",
		expires_at: expiresAt,
		suite: "node",
		profile: "default",
		files: planned,
		cwd: ".",
		argv: ["node", "runner.mjs"],
		base_sha: localManifest.inventory_base_sha,
		head_sha: "head",
		source_tree_sha256: "full-tree",
		selection_tree_sha256: treeDigest(root, "head", planned),
		manifest_sha256: fileDigest(root, "test-accounting.manifest.json"),
	};
	const transcript = `${runId}.transcript`;
	await writeFile(
		join(directory, transcript),
		`${JSON.stringify({ event: "start", run_id: runId })}\n${JSON.stringify({ event: "end", run_id: runId, exit_code: 0, signal: null })}\n`,
	);
	await writeFile(
		join(directory, `${runId}.authority.json`),
		`${JSON.stringify(issued)}\n`,
	);
	const completion = {
		schema: RUN_COMPLETION_SCHEMA,
		run_id: runId,
		nonce: "nonce",
		observed: {
			exit_code: 0,
			signal: null,
			transcript,
			transcript_sha256: await digest(join(directory, transcript)),
			counts,
			files: planned,
		},
	};
	await writeFile(
		join(directory, `${runId}.completion.json`),
		`${JSON.stringify(completion)}\n`,
	);
	const receipt: Receipt = {
		schema: RECEIPT_SCHEMA,
		run_id: runId,
		nonce: "nonce",
		suite: "node",
		profile: "default",
		issued_at: issued.issued_at,
		started_at: "2026-07-23T00:00:01.000Z",
		ended_at: "2026-07-23T00:00:02.000Z",
		expires_at: issued.expires_at,
		base_sha: issued.base_sha,
		head_sha: issued.head_sha,
		source_tree_sha256: issued.source_tree_sha256,
		selection_tree_sha256: issued.selection_tree_sha256,
		manifest_sha256: issued.manifest_sha256,
		cwd: ".",
		argv: issued.argv,
		files: planned,
		transcript,
		transcript_sha256: completion.observed.transcript_sha256,
		exit_code: 0,
		signal: null,
		counts,
		authority_sha256: await digest(join(directory, `${runId}.authority.json`)),
		completion_sha256: await digest(
			join(directory, `${runId}.completion.json`),
		),
		binding_sha256: "",
	};
	receipt.binding_sha256 = receiptBinding(receipt);
	return { root, directory, localManifest, planned, receipt };
}
test("classifies suffix tests separately from helpers and fixtures under test directories", () => {
	assert.equal(classifyTrackedPath("test/helper.js").kind, "helper-or-fixture");
	assert.equal(
		classifyTrackedPath("test/fixture.json").kind,
		"helper-or-fixture",
	);
	assert.equal(classifyTrackedPath("test/alpha.test.js").kind, "executable");
	assert.equal(
		classifyTrackedPath("src/component.test.tsx").kind,
		"executable",
	);
	assert.equal(
		classifyTrackedPath("packages/mcp-server/test/smoke-stdio.ts").kind,
		"helper-or-fixture",
	);
});
test("normalizes runner-local receipt paths to Git-root-relative paths", () => {
	assert.deepEqual(
		repositoryPaths("reference-implementation", [
			"test/b.test.js",
			"server/a.test.js",
		]),
		[
			"reference-implementation/server/a.test.js",
			"reference-implementation/test/b.test.js",
		],
	);
});
test("fails closed when a renamed TypeScript test is not planned or excluded", () => {
	const renamed = files.map((path) =>
		path === "test/alpha.test.js" ? "test/alpha.test.ts" : path,
	);
	assert.throws(
		() => checkInventory(manifest(), renamed),
		UNACCOUNTED_EXECUTABLE_TESTS_ALPHA_TEST_PATTERN,
	);
});
test("fails closed when an include glob matches a file that classifies as helper-or-fixture, not executable", () => {
	// Reproduces the exact defect shape found in the mcp-server smoke-stdio migration: a suite's
	// include glob still matches a real tracked file, so the suite is not empty and passes the
	// "selects no executable tests" guard, but the matched file itself misclassifies as
	// helper-or-fixture (e.g. a smoke probe with no .test./.spec. suffix), so it is silently
	// never planned. `checkInventory`'s "no unaccounted executable tests" check cannot catch this
	// because the file is never classified executable in the first place.
	const misclassified = [...files, "test/smoke-probe.mjs"];
	assert.throws(
		() =>
			checkInventory(
				manifest({
					suites: [
						{
							id: "node",
							cwd: ".",
							loader: "node-test",
							authority_argument: "--authority",
							command: ["node", "runner.mjs"],
							profiles: [{ id: "default", required: true, skip_reasons: {} }],
							include: [
								"test/*.test.js",
								"test/*.test.mjs",
								"test/smoke-probe.mjs",
							],
						},
					],
				}),
				misclassified,
			),
		MATCHES_NON_EXECUTABLE_CLASSIFIED_FILE_PATTERN,
	);
});
test("fails closed when a suite's entire include list matches no tracked file", () => {
	assert.throws(
		() =>
			checkInventory(
				manifest({
					suites: [
						{
							id: "node",
							cwd: ".",
							loader: "node-test",
							authority_argument: "--authority",
							command: ["node", "runner.mjs"],
							profiles: [{ id: "default", required: true, skip_reasons: {} }],
							include: ["nowhere/*.test.js"],
						},
					],
				}),
				files,
			),
		INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN,
	);
});
test("does not fail closed when one glob in a multi-extension include list matches nothing, as long as the suite itself is not empty", () => {
	// A multi-extension suite deliberately lists .js/.mjs/.ts variants for the
	// not-yet-fully-migrated fixture files; a glob matching zero files today is expected
	// future-proofing, not a defect, as long as the suite as a whole still selects files.
	assert.doesNotThrow(() =>
		checkInventory(
			manifest({
				suites: [
					{
						id: "node",
						cwd: ".",
						loader: "node-test",
						authority_argument: "--authority",
						command: ["node", "runner.mjs"],
						profiles: [{ id: "default", required: true, skip_reasons: {} }],
						include: ["test/*.test.js", "test/*.test.mjs", "test/*.test.ts"],
					},
				],
			}),
			files,
		),
	);
});
test("fails closed for unrecognized executable tests and empty suites", () => {
	assert.throws(
		() => checkInventory(manifest(), [...files, "outside/new.test.ts"]),
		UNACCOUNTED_EXECUTABLE_TESTS_PATTERN,
	);
	assert.throws(
		() =>
			checkInventory(
				manifest({
					suites: [
						{
							id: "empty",
							cwd: ".",
							loader: "node-test",
							authority_argument: null,
							command: [],
							profiles: ["default"],
							include: ["missing/*.test.js"],
						},
					],
					exclusions: [],
				}),
				files,
			),
		INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN,
	);
});
test("planFor fails closed when a suite's include glob matches a real file but every match is excluded", () => {
	// Distinct from an empty include list: the glob itself matches
	// test/alpha.test.js, so validateIncludeGlobsClassifyExecutable's
	// suite-union check stays silent — the emptiness only appears after
	// exclusions are applied, which only planFor (not the glob-classify
	// check) can see.
	assert.throws(
		() =>
			planFor(
				manifest({
					suites: [
						{
							id: "node",
							cwd: ".",
							loader: "node-test",
							authority_argument: "--authority",
							command: ["node", "runner.mjs"],
							profiles: [{ id: "default", required: true, skip_reasons: {} }],
							include: ["test/alpha.test.js"],
						},
					],
					exclusions: [
						{
							path: "test/alpha.test.js",
							reason: "fully excluded suite fixture",
							owner: "tooling",
							suite: "node",
							profile: "default",
							expires: "2027-12-31",
						},
					],
				}),
				files,
			),
		SELECTS_NO_EXECUTABLE_TESTS_PATTERN,
	);
});
test("rejects invented receipt and transcript without a verifier-issued authority", async () => {
	const { directory, planned, receipt, root } = await fixture();
	await writeFile(
		join(directory, `${receipt.run_id}.authority.json`),
		`${JSON.stringify({ schema: "forged" })}\n`,
	);
	await assert.rejects(
		verifyReceipts(
			manifest({ exclusions: [] }),
			[
				"runner.mjs",
				"test/alpha.test.js",
				"test/runner.test.mjs",
				"test-accounting.manifest.json",
			],
			[receipt],
			{
				root,
				head: "head",
				authorityDirectory: directory,
				sourceTree: "full-tree",
			},
		),
		INVALID_SCHEMAS_PROVENANCE_PATTERN,
	);
	assert.deepEqual(planned, receipt.files);
});
test("accepts only an observed authority run once, then rejects replay and expiry", async () => {
	const value = await fixture();
	const allFiles = [
		"runner.mjs",
		"test/alpha.test.js",
		"test/runner.test.mjs",
		"test-accounting.manifest.json",
	];
	assert.deepEqual(
		(
			await verifyReceipts(value.localManifest, allFiles, [value.receipt], {
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
			})
		).verified,
		["node/default"],
	);
	await assert.rejects(
		verifyReceipts(value.localManifest, allFiles, [value.receipt], {
			root: value.root,
			head: "head",
			authorityDirectory: value.directory,
			sourceTree: "full-tree",
		}),
		REPLAYED_PATTERN,
	);
	const expired = await fixture({
		expiresAt: "2026-07-23T00:00:03.000Z",
		runId: "22222222-2222-4222-8222-222222222222",
	});
	await assert.rejects(
		verifyReceipts(expired.localManifest, allFiles, [expired.receipt], {
			root: expired.root,
			head: "head",
			authorityDirectory: expired.directory,
			sourceTree: "full-tree",
			now: new Date("2026-07-23T00:00:04.000Z"),
		}),
		EXPIRED_PATTERN,
	);
});
test("rejects selection, assertion, skip, profile, and full-tree mutations in an authority receipt", async () => {
	const value = await fixture();
	const allFiles = [
		"runner.mjs",
		"test/alpha.test.js",
		"test/runner.test.mjs",
		"test-accounting.manifest.json",
	];
	const altered = (changes: Partial<Receipt>): Receipt => {
		const next = { ...value.receipt, ...changes };
		return { ...next, binding_sha256: receiptBinding(next) };
	};
	await assert.rejects(
		verifyReceipts(
			value.localManifest,
			allFiles,
			[altered({ files: ["test/alpha.test.js"] })],
			{
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			},
		),
		ISSUED_AUTHORITY_FILES_DO_NOT_PATTERN,
	);
	await assert.rejects(
		verifyReceipts(
			value.localManifest,
			allFiles,
			[altered({ counts: { ...value.receipt.counts, assertions: 1 } })],
			{
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			},
		),
		COMPLETION_DOES_NOT_BIND_PATTERN,
	);
	await assert.rejects(
		verifyReceipts(
			value.localManifest,
			allFiles,
			[
				altered({
					counts: {
						...value.receipt.counts,
						skipped: 1,
						skip_reasons: { "node-tap-no-reason": 1 },
					},
				}),
			],
			{
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			},
		),
		COMPLETION_DOES_NOT_BIND_GENERIC_PATTERN,
	);
	await assert.rejects(
		verifyReceipts(
			value.localManifest,
			allFiles,
			[altered({ profile: "other" })],
			{
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			},
		),
		UNDECLARED_PATTERN,
	);
	await assert.rejects(
		verifyReceipts(
			value.localManifest,
			allFiles,
			[altered({ source_tree_sha256: "different-tree" })],
			{
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			},
		),
		ISSUED_AUTHORITY_STALE_PATTERN,
	);
	const generic = await fixture({
		counts: {
			assertions: 2,
			passed: 1,
			failed: 0,
			skipped: 1,
			skip_reasons: { "node-tap-no-reason": 1 },
			planned_files: 2,
			completed_files: 2,
		},
		runId: "33333333-3333-4333-8333-333333333333",
	});
	const [genericSuite] = generic.localManifest.suites;
	const genericProfile = genericSuite?.profiles[0];
	if (genericProfile && typeof genericProfile !== "string") {
		genericProfile.skip_reasons = { "node-tap-no-reason": 1 };
	}
	await assert.rejects(
		verifyReceipts(generic.localManifest, allFiles, [generic.receipt], {
			root: generic.root,
			head: "head",
			authorityDirectory: generic.directory,
			sourceTree: "full-tree",
			consume: false,
		}),
		GENERIC_PATTERN,
	);
});
test("accepts a complete named profile skip baseline and rejects an added skip", async () => {
	const counts: Receipt["counts"] = {
		assertions: 46,
		passed: 0,
		failed: 0,
		skipped: 46,
		skip_reasons: {
			"fixture service unavailable": 44,
			"optional fixture not selected": 1,
			"requires fixture display": 1,
		},
		planned_files: 2,
		completed_files: 2,
	};
	const value = await fixture({
		counts,
		runId: "44444444-4444-4444-8444-444444444444",
	});
	const allFiles = [
		"runner.mjs",
		"test/alpha.test.js",
		"test/runner.test.mjs",
		"test-accounting.manifest.json",
	];
	const [suite] = value.localManifest.suites;
	const profile = suite?.profiles[0];
	if (profile && typeof profile !== "string") {
		profile.skip_reasons = { ...counts.skip_reasons };
	}
	assert.deepEqual(
		(
			await verifyReceipts(value.localManifest, allFiles, [value.receipt], {
				root: value.root,
				head: "head",
				authorityDirectory: value.directory,
				sourceTree: "full-tree",
				consume: false,
			})
		).verified,
		["node/default"],
	);
	const added: Receipt = {
		...value.receipt,
		counts: {
			...counts,
			assertions: 47,
			skipped: 47,
			skip_reasons: { ...counts.skip_reasons, "unexpected backend": 1 },
		},
		binding_sha256: "",
	};
	added.binding_sha256 = receiptBinding(added);
	await assert.rejects(
		verifyReceipts(value.localManifest, allFiles, [added], {
			root: value.root,
			head: "head",
			authorityDirectory: value.directory,
			sourceTree: "full-tree",
			consume: false,
		}),
		COMPLETION_DOES_NOT_BIND_SKIPS_PATTERN,
	);
});
test("rejects a duplicate configured named-skip mapping row before any lookup set collapses it", () => {
	const row = [
		"alpha",
		"fixture unavailable",
		"fixture",
		["fixture-default"],
	] as const;
	assert.throws(
		() =>
			validateNamedSkipMappingTable({
				profiles: { fixture: ["fixture-default"] },
				rows: [row, row],
			}),
		/duplicate configured mapping row/,
	);
});
test("the exact named-skip mapping join fails closed on stale rows and on unconfigured consumed identities", () => {
	// Property 3, stale/unmatched arm. A configured row that no emitted skip
	// consumed (e.g. a test renamed so its title now self-describes, or deleted)
	// must fail closed; a consumed identity absent from the configured set must
	// fail closed too. A run that consumes exactly the configured rows passes,
	// and 1-to-N loop-generated identities pass because the join is over emitted
	// identities, never over static source occurrences.
	const configured = ["alpha", "beta", "gamma"];
	assert.throws(
		() => assertNamedSkipMappingsFullyConsumed(["alpha", "beta"], configured),
		STALE_NAMED_SKIP_MAPPING_PATTERN,
	);
	assert.throws(
		() =>
			assertNamedSkipMappingsFullyConsumed(
				["alpha", "beta", "gamma", "delta"],
				configured,
			),
		UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN,
	);
	// 1-to-N: three emitted identities from one looped source declaration, all
	// configured, plus an exact one-to-one — every emitted identity resolves.
	assert.doesNotThrow(() =>
		assertNamedSkipMappingsFullyConsumed(
			["alpha", "beta", "gamma", "gamma", "gamma"],
			configured,
		),
	);
});
test("named skip mapping stays profile-aware AND fail-closed in both directions", () => {
	const table = validateNamedSkipMappingTable({
		profiles: { fixture: ["fixture-default", "fixture-optional"] },
		rows: [
			[
				"shared",
				"fixture unavailable",
				"fixture",
				["fixture-default", "fixture-optional"],
			],
			["optional", "fixture unavailable", "fixture", ["fixture-optional"]],
		],
	});
	const ordinary = configuredNamedSkipMappingIdentities(
		"fixture",
		"fixture-default",
		table,
	);
	const optional = configuredNamedSkipMappingIdentities(
		"fixture",
		"fixture-optional",
		table,
	);
	assert.deepEqual(ordinary, ["shared"]);
	assert.deepEqual(optional, ["shared", "optional"]);
	assert.doesNotThrow(() =>
		assertNamedSkipMappingsFullyConsumed(ordinary, ordinary),
	);
	assert.doesNotThrow(() =>
		assertNamedSkipMappingsFullyConsumed(optional, optional),
	);
	assert.throws(
		() => assertNamedSkipMappingsFullyConsumed(ordinary, optional),
		STALE_NAMED_SKIP_MAPPING_PATTERN,
	);
	assert.throws(
		() => assertNamedSkipMappingsFullyConsumed(optional, ordinary),
		UNCONFIGURED_NAMED_SKIP_MAPPING_PATTERN,
	);
	assert.throws(
		() => configuredNamedSkipMappingIdentities("fixture", "unknown", table),
		/unrecognized/,
	);
	assert.throws(
		() =>
			configuredNamedSkipMappingIdentities("unknown", "fixture-default", table),
		/unrecognized/,
	);
});
test("parses accounting options exactly and does not accept authority-directory aliases", () => {
	assert.deepEqual(
		parseInventoryArgs(["--plan", "--suite", "node", "--profile", "default"])
			.suites,
		["node"],
	);
	assert.throws(
		() => parseInventoryArgs(["--check", "--check"]),
		EXACTLY_ONE_MODE_PATTERN,
	);
	assert.throws(
		() => parseInventoryArgs(["--plan", "--suite"]),
		REQUIRES_EXACTLY_ONE_VALUE_PATTERN,
	);
	assert.throws(
		() => parseInventoryArgs(["--check", "--fail-on-unknown"]),
		UNKNOWN_ARGUMENT_PATTERN,
	);
	assert.throws(
		() => parseInventoryArgs(["--check", "--fail-on-unknownly"]),
		UNKNOWN_ARGUMENT_PATTERN,
	);
	assert.throws(
		() => parseInventoryArgs(["--verify", "--authority-directory", "receipts"]),
		UNKNOWN_ARGUMENT_PATTERN,
	);
	assert.throws(
		() => parseInventoryArgs(["--plan", "--suite", "all", "--suite", "node"]),
		CANNOT_COMBINE_ALL_PATTERN,
	);
});
test("uses only structured runner events and rejects generic skips", () => {
	const event = (value: unknown) =>
		`PDPP_TEST_ACCOUNTING_EVENT ${JSON.stringify(value)}`;
	// A self-describing string skip value consumes no exact named-mapping row.
	assert.deepEqual(
		structuredNodeSummary(
			`${event({ type: "test:pass", details: { type: "test" } })}\n${event({ type: "test:pass", details: { type: "test", skip: "backend disabled" } })}\n`,
		),
		{
			assertions: 2,
			passed: 1,
			failed: 0,
			skipped: 1,
			skip_reasons: { "backend disabled": 1 },
			consumed_mapping_identities: [],
		},
	);
	// A `(skipped: ...)` title suffix is self-describing and consumes no row.
	assert.deepEqual(
		structuredNodeSummary(
			`${event({ type: "test:pass", details: { type: "test", name: "fixture path (skipped: local Amazon raw-DOM fixture directory not present)", skip: true } })}\n`,
		),
		{
			assertions: 1,
			passed: 0,
			failed: 0,
			skipped: 1,
			skip_reasons: { "local Amazon raw-DOM fixture directory not present": 1 },
			consumed_mapping_identities: [],
		},
	);
	// A bare boolean skip with no self-describing name resolves through an exact
	// named-mapping row, and that row is recorded as CONSUMED so the suite
	// finalizer's property-3 join can see it.
	assert.deepEqual(
		structuredNodeSummary(
			`${event({ type: "test:pass", details: { type: "test", name: "parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates", skip: true } })}\n`,
		),
		{
			assertions: 1,
			passed: 0,
			failed: 0,
			skipped: 1,
			skip_reasons: { "local Amazon raw-DOM fixture directory not present": 1 },
			consumed_mapping_identities: [
				"parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates",
			],
		},
	);
	assert.throws(
		() =>
			structuredNodeSummary(
				`${event({ type: "test:pass", details: { type: "test", skip: true } })}\n`,
			),
		UNEXPLAINED_SKIP_PATTERN,
	);
	assert.throws(
		() => structuredNodeSummary("# pass 99\n"),
		NO_STRUCTURED_NODE_EVENTS_PATTERN,
	);
});
test("runs Python files directly and derives explicit unittest skips from verbose output", () => {
	const output =
		"test_unit (__main__.Unit.test_unit) ... ok\ntest_x11 (__main__.X11.test_x11) ... skipped 'requires Xvfb'\n\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK (skipped=1)\n";
	assert.deepEqual(structuredPythonSummary(output, 0), {
		assertions: 2,
		passed: 1,
		failed: 0,
		skipped: 1,
		skip_reasons: { "requires Xvfb": 1 },
		consumed_mapping_identities: [],
	});
	assert.throws(
		() =>
			structuredPythonSummary("s\nRan 1 test in 0.001s\n\nOK (skipped=1)\n", 0),
		OMITTED_A_SKIP_REASON_PATTERN,
	);
});
test("the checked authority graph contains direct leaves and the exact package authority runner", async () => {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
	const value = await readManifest(
		join(root, "test-accounting.manifest.json"),
		{ root },
	);
	for (const suite of value.suites) {
		if (suite.id === "polyfill-connectors") {
			assert.equal(suite.execution, "authority-runner");
			assert.equal(suite.authority_argument, "--accounting-authority");
			assert.deepEqual(suite.command, ["node", "scripts/run-tests.mjs"]);
		} else {
			assert.equal(suite.execution, "direct");
			assert.equal(suite.authority_argument, null);
		}
		assert.ok(
			!(suite.command ?? []).some((part) => /authority\.(ts|mjs)/.test(part)),
		);
	}
});
test("the current inventory has exact one-owner coverage and every destination suite is real", async () => {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
	const manifestValue = await readManifest(
		join(root, "test-accounting.manifest.json"),
		{ root },
	);
	const tracked = trackedFiles(root);
	const result = checkInventory(manifestValue, tracked, [], {
		failOnUnknown: true,
		failOnEmpty: true,
	});
	const excluded = manifestValue.exclusions?.length ?? 0;
	const planned = Object.values(result.plans).reduce(
		(sum, paths) => sum + paths.length,
		0,
	);
	assert.equal(result.executable.length, planned + excluded);
	const site = manifestValue.suites.find((suite) => suite.id === "accounting");
	assert.equal(site?.zero_tests, undefined);
	assert.ok((result.plans.accounting?.length ?? 0) > 0);
});
test("the accounting tests have exactly one owner and overlap is rejected", async () => {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
	const value = await readManifest(
		join(root, "test-accounting.manifest.json"),
		{ root },
	);
	const paths = trackedFiles(root);
	const result = checkInventory(value, paths, [], {
		failOnUnknown: true,
		failOnEmpty: true,
	});
	assert.ok((result.plans.accounting?.length ?? 0) >= 5);
	assert.ok(
		result.plans.accounting?.every((path) =>
			path.startsWith("scripts/test-accounting/"),
		),
	);
	const suite = value.suites.find((entry) => entry.id === "accounting");
	assert.ok(suite);
	value.suites.push({ ...suite, id: "overlap" });
	assert.throws(
		() => checkInventory(value, paths),
		/multiple|overlap|more than one/,
	);
});
test("generic environment_unset removes declared sentinels and rejects invalid declarations", async () => {
	const root = await mkdtemp(
		join(tmpdir(), "pdpp-authority-scratch-boundary-"),
	);
	await mkdir(join(root, "scripts", "test-scratch"), { recursive: true });
	await writeFile(
		join(root, "scripts", "test-scratch", "run-command.test.ts"),
		"export {};\n",
	);
	await writeFile(
		join(root, "boundary.mjs"),
		`const names = ${JSON.stringify(FIXTURE_ENVIRONMENT_NAMES)}; const present = names.filter((name) => process.env[name] !== undefined); if (present.length) { console.error(present.join(",")); process.exitCode = 1; }\n`,
	);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fixture@example.test"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
	const localManifest: Manifest = {
		schema: "pdpp.test-accounting/v3",
		inventory_base_sha: "0000000000000000000000000000000000000000",
		suites: [
			{
				id: "renamed-lifecycle",
				cwd: ".",
				loader: "shell",
				authority_argument: null,
				command: [process.execPath, "boundary.mjs"],
				environment_unset: [...FIXTURE_ENVIRONMENT_NAMES],
				profiles: [{ id: "default", required: true, skip_reasons: {} }],
				include: ["scripts/test-scratch/run-command.test.ts"],
			},
		],
		exclusions: [],
	};
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(localManifest)}\n`,
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	localManifest.inventory_base_sha = execFileSync(
		"git",
		["rev-parse", "HEAD"],
		{ cwd: root, encoding: "utf8" },
	).trim();
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(localManifest)}\n`,
	);
	execFileSync("git", ["add", "test-accounting.manifest.json"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	for (const invalid of [
		["BAD-NAME"],
		["FIXTURE_PARENT_TOKEN", "FIXTURE_PARENT_TOKEN"],
	]) {
		const invalidManifest = structuredClone(localManifest);
		const invalidSuite = invalidManifest.suites[0];
		assert.ok(invalidSuite);
		invalidSuite.environment_unset = invalid;
		await writeFile(
			join(root, "test-accounting.manifest.json"),
			JSON.stringify(invalidManifest),
		);
		await assert.rejects(
			readManifest(join(root, "test-accounting.manifest.json"), { root }),
			/unique valid environment names/,
		);
	}
	const conflict = structuredClone(localManifest);
	const conflictSuite = conflict.suites[0];
	assert.ok(conflictSuite);
	conflictSuite.environment = { FIXTURE_PARENT_TOKEN: "conflict" };
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		JSON.stringify(conflict),
	);
	await assert.rejects(
		readManifest(join(root, "test-accounting.manifest.json"), { root }),
		/cannot set/,
	);
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(localManifest)}\n`,
	);
	const noImplicitBoundary = structuredClone(localManifest);
	const noImplicitSuite = noImplicitBoundary.suites[0];
	assert.ok(noImplicitSuite);
	delete noImplicitSuite.environment_unset;
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		JSON.stringify(noImplicitBoundary),
	);
	await assert.doesNotReject(
		readManifest(join(root, "test-accounting.manifest.json"), { root }),
	);
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(localManifest)}\n`,
	);
	const inherited = Object.fromEntries(
		FIXTURE_ENVIRONMENT_NAMES.map((name) => [name, "outer-capability"]),
	);
	const [suite] = localManifest.suites;
	assert.ok(suite);
	const environment = suiteEnvironment(
		{ ...inherited, FIXTURE_UNRELATED: "retained" },
		"default",
		suite,
	);
	assert.equal(environment.FIXTURE_UNRELATED, "retained");
	for (const name of FIXTURE_ENVIRONMENT_NAMES) {
		assert.equal(environment[name], undefined);
	}
	assert.deepEqual(
		(
			await runAuthority({
				root,
				suites: ["renamed-lifecycle"],
				env: inherited,
			})
		).result.verified,
		["renamed-lifecycle/default"],
	);
});
test("reviewed hosted default profile skip baseline is explicit", async () => {
	const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
	const manifestValue = await readManifest(
		join(root, "test-accounting.manifest.json"),
		{ root },
	);
	const suite = manifestValue.suites.find(
		(entry) => entry.id === "polyfill-connectors",
	);
	const defaultProfile = suite?.profiles?.find(
		(entry) => typeof entry !== "string" && entry.id === "default",
	);
	assert.deepEqual(
		typeof defaultProfile === "string"
			? undefined
			: defaultProfile?.skip_reasons,
		{
			"GROUPME_ACCESS_TOKEN unset": 2,
			"local Amazon raw-DOM fixture directory not present": 2,
			"local Chase raw-DOM fixture directory not present": 3,
			"local USAA raw fixture directory not present": 1,
			"requires --experimental-test-module-mocks": 1,
			"run with --expose-gc for a reliable memory-growth comparison": 1,
			"packages/cli does not exist in this repository (not part of the polyfill-connectors extraction)": 1,
			"network isolation unavailable on this host: unshare namespace+procfs-mount dry run exited 1: unshare: write failed /proc/self/uid_map: Operation not permitted — either unprivileged user namespaces are unavailable on this host (kernel sysctl or an LSM policy such as AppArmor's unprivileged-userns restriction is the usual cause), or namespace creation succeeded but the PID-namespace's own `mount -t proc proc /proc` was refused by the kernel (commonly: Docker's default procfs masking combined with a CAP_SYS_ADMIN grant that stops short of full --privileged, producing a kernel \"Mount too revealing\" refusal); pdpp isolation: trusted launcher 'bwrap' not found in any trusted location (/usr/sbin, /usr/bin, /sbin, /bin) — refusing to fall back to a PATH-resolved lookup": 2,
			"requires usable bwrap": 10,
			"requires usable bwrap and unshare bind mounts": 5,
			"requires usable unshare bind mounts": 23,
			"requires usable unshare": 4,
			"requires usable bwrap prerequisites": 19,
			"requires usable unshare prerequisites": 19,
			"requires writable socket location: an ssh-agent-shaped path under $HOME/.ssh/agent": 1,
		},
	);
});
test("default authority selection spawns and completes only required profiles even when an optional predicate is present", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-authority-"));
	await mkdir(join(root, "test"));
	await mkdir(join(root, "other"));
	await writeFile(
		join(root, "test", "a.test.js"),
		"export const selected = true;\n",
	);
	await writeFile(
		join(root, "other", "b.test.js"),
		"export const peer = true;\n",
	);
	await writeFile(
		join(root, "child.mjs"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a fixture — a single-quoted string containing real JS source text (its own backtick template literal) written out to a file, not a forgotten template literal here.
		'import { readFileSync } from "node:fs"; const path = process.argv[process.argv.indexOf("--authority") + 1]; const issued = JSON.parse(readFileSync(path, "utf8")); console.log(`PDPP_TEST_ACCOUNTING_RESULT ${JSON.stringify({ run_id: issued.run_id, nonce: issued.nonce, suite: issued.suite, profile: issued.profile, files: issued.files, counts: { assertions: 1, passed: 1, failed: 0, skipped: 0, skip_reasons: {}, planned_files: 1, completed_files: 1 } })}`);\n',
	);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fixture@example.test"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
	const initialManifest: Manifest = {
		schema: "pdpp.test-accounting/v3",
		inventory_base_sha: "0000000000000000000000000000000000000000",
		suites: [
			{
				id: "node",
				cwd: ".",
				loader: "node-test",
				authority_argument: "--authority",
				command: [process.execPath, "child.mjs"],
				profiles: [
					{ id: "default", required: true, skip_reasons: {} },
					{
						id: "postgres",
						required: false,
						optional_predicate: "PDPP_TEST_POSTGRES=1",
						skip_reasons: {},
					},
				],
				include: ["test/*.test.js"],
			},
			{
				id: "peer",
				cwd: ".",
				loader: "node-test",
				authority_argument: "--authority",
				command: [process.execPath, "child.mjs"],
				profiles: [{ id: "default", required: true, skip_reasons: {} }],
				include: ["other/*.test.js"],
			},
		],
		exclusions: [],
	};
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(initialManifest)}\n`,
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	initialManifest.inventory_base_sha = execFileSync(
		"git",
		["rev-parse", "HEAD"],
		{
			cwd: root,
			encoding: "utf8",
		},
	).trim();
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(initialManifest)}\n`,
	);
	execFileSync("git", ["add", "test-accounting.manifest.json"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	assert.deepEqual(
		(
			await runAuthority({
				root,
				suites: ["node"],
				env: { PDPP_TEST_POSTGRES: "1" },
			})
		).result.verified,
		["node/default"],
	);
});
test("a suite-scoped authority run does not fail closed on an unrelated suite's stale, empty-matching include glob", async () => {
	const root = await mkdtemp(join(tmpdir(), "pdpp-authority-scoped-"));
	await mkdir(join(root, "test"));
	await writeFile(
		join(root, "test", "a.test.js"),
		"export const selected = true;\n",
	);
	await writeFile(
		join(root, "child.mjs"),
		// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a fixture — a single-quoted string containing real JS source text (its own backtick template literal) written out to a file, not a forgotten template literal here.
		'import { readFileSync } from "node:fs"; const path = process.argv[process.argv.indexOf("--authority") + 1]; const issued = JSON.parse(readFileSync(path, "utf8")); console.log(`PDPP_TEST_ACCOUNTING_RESULT ${JSON.stringify({ run_id: issued.run_id, nonce: issued.nonce, suite: issued.suite, profile: issued.profile, files: issued.files, counts: { assertions: 1, passed: 1, failed: 0, skipped: 0, skip_reasons: {}, planned_files: 1, completed_files: 1 } })}`);\n',
	);
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "fixture@example.test"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "fixture"], { cwd: root });
	const initialManifest: Manifest = {
		schema: "pdpp.test-accounting/v3",
		inventory_base_sha: "0000000000000000000000000000000000000000",
		suites: [
			{
				id: "node",
				cwd: ".",
				loader: "node-test",
				authority_argument: "--authority",
				command: [process.execPath, "child.mjs"],
				profiles: [{ id: "default", required: true, skip_reasons: {} }],
				include: ["test/*.test.js"],
			},
			{
				// Stands in for the real mcp-server suite's stale .test.js/.mjs
				// include globs after its tests were renamed to .test.ts/.ts: the
				// suite is declared but its include glob now matches zero tracked
				// files. A suite-scoped run of "node" alone must not fail closed
				// because of this unrelated, unselected suite's empty selection.
				id: "stale-unrelated",
				cwd: ".",
				loader: "node-test",
				authority_argument: "--authority",
				command: [process.execPath, "child.mjs"],
				profiles: [{ id: "default", required: true, skip_reasons: {} }],
				include: ["test/*.test.renamed-away-suffix"],
			},
		],
		exclusions: [],
	};
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(initialManifest)}\n`,
	);
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	initialManifest.inventory_base_sha = execFileSync(
		"git",
		["rev-parse", "HEAD"],
		{
			cwd: root,
			encoding: "utf8",
		},
	).trim();
	await writeFile(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(initialManifest)}\n`,
	);
	execFileSync("git", ["add", "test-accounting.manifest.json"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	assert.deepEqual(
		(await runAuthority({ root, suites: ["node"] })).result.verified,
		["node/default"],
	);
	// Running "stale-unrelated" directly (not as an unrelated bystander this
	// time — it is the selected suite) still fails closed, just earlier and
	// more precisely than before this lane's fix: runAuthority's own
	// pre-selection closure check (validateIncludeGlobsClassifyExecutable,
	// scoped to the suites actually being run) now reports the suite's empty
	// include list directly, ahead of planFor's coarser "selects no
	// executable tests" guard that used to be the first thing to catch it.
	await assert.rejects(
		runAuthority({ root, suites: ["stale-unrelated"] }),
		INCLUDE_LIST_MATCHES_NO_TRACKED_FILE_PATTERN,
	);
});

test("six destination fixture mappings remain exact and server mappings do not resolve", () => {
	const names = configuredNamedSkipMappingIdentities(
		"polyfill-connectors",
		"default",
	);
	assert.deepEqual(names, [
		"parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates",
		"parseOrderDetailDom: local real fixtures yield items and grand_total",
		"parseDashboardAccountsDom: local real capture parses ≥1 account",
		"parseStatementsListDom: local real capture parses ≥1 statement row",
		"parseCurrentActivityDom: local real capture — dashboard-accounts.html parses ≥1 MDS row",
		"parseModernCheckingEra: local statement text parses ≥1 txn (smoke)",
	]);
	for (const name of names) assert.ok(resolveNamedSkipMapping(name));
	assert.equal(
		resolveNamedSkipMapping(
			"Postgres store factory is consistent with the resolver",
		),
		undefined,
	);
	assert.equal(
		resolveNamedSkipMapping(
			"live CDP smoke proves frame, click, and viewport resize against Chromium",
		),
		undefined,
	);
});
