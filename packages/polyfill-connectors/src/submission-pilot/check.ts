// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { decodeEscapedText } from "../../../../connectors/anthropic/safe-escape.ts";
import {
	isApiSubmissionPilot,
	type Step,
} from "../../scripts/conformance-readiness.ts";
import {
	connectorEntrypoint,
	fixturesDir,
	manifestPath,
	repoRoot,
} from "../connector-paths.ts";

const reference = z
	.object({ stream: z.string().min(1), key: z.string().min(1) })
	.strict();
const path = z
	.array(z.union([z.string(), z.number().int().nonnegative()]))
	.min(1);
const response = z
	.object({
		url: z.url(),
		body: z.unknown(),
		status: z.number().int().min(200).max(299).optional(),
	})
	.strict();
const scenario = z
	.object({
		streams: z.array(z.string().min(1)).min(1).max(50),
		responses: z.array(response).min(1).max(100),
	})
	.strict();
const safeExplanation = z
	.string()
	.trim()
	.max(1000)
	.regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u);
const exemption = z
	.object({
		not_applicable: z
			.object({
				reason: safeExplanation.min(20),
				reference: safeExplanation.min(5),
			})
			.strict(),
	})
	.strict();
const inventoryRecord = reference.extend({
	op: z.enum(["upsert", "delete"]).default("upsert"),
});
const refresh = scenario.extend({
	records: z.array(inventoryRecord).min(1).max(1000),
});

const deletions = z.union([
	scenario.extend({ deleted: z.array(reference).min(1).max(100) }),
	exemption,
]);
const text = z.union([
	scenario.extend({
		values: z
			.array(reference.extend({ field: path, source: z.string() }))
			.min(1)
			.max(100),
	}),
	exemption,
]);
const counts = z.union([
	scenario.extend({
		stream: z.string().min(1),
		total: path,
		items: path,
		records: z.array(inventoryRecord).min(1).max(1000),
	}),
	exemption,
]);
const fixtureSchema = z
	.object({
		schema: z.literal("pdpp.submission-fixture/1"),
		environment: z
			.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().max(2000))
			.refine(
				(env) =>
					Object.keys(env).length <= 30 &&
					Object.keys(env).every(
						(key) =>
							!/^(?:NODE|NPM|TSX|TS_NODE|DYLD|LD|PDPP|VANA|SUBMISSION|HOME|PATH|TMP)/.test(
								key,
							),
					),
			),
		refresh,
		deletions,
		text,
		counts,
	})
	.strict();
type Scenario = z.infer<typeof scenario>;
type Fixture = z.infer<typeof fixtureSchema>;
type Frame = {
	type: string;
	stream?: string;
	key?: string;
	op?: string;
	data?: unknown;
	cursor?: unknown;
	status?: string;
	considered?: number;
	covered?: number;
};

export const SUBMISSION_STEPS = [
	"submission refresh",
	"submission deletions",
	"submission text",
	"submission counts",
] as const;
const fixtureFile = "fixtures/submission-pilot.json";
const remedy = `Add the reviewed ${fixtureFile} contract; see packages/polyfill-connectors/docs/submission-pilot.md. Run conformance with --submission-pilot.`;

const inCheckout = (checkout: string, file: string) =>
	join(checkout, relative(repoRoot, file));

function at(value: unknown, keys: readonly (string | number)[]): unknown {
	return keys.reduce<unknown>(
		(current, key) =>
			current !== null && typeof current === "object"
				? Reflect.get(current, key)
				: undefined,
		value,
	);
}
function hasString(value: unknown, expected: string): boolean {
	if (value === expected) return true;
	return (
		value !== null &&
		typeof value === "object" &&
		Object.values(value).some((item) => hasString(item, expected))
	);
}
function identity(record: { stream?: string; key?: string }) {
	return JSON.stringify([record.stream, record.key]);
}

function assertInventory(
	records: Frame[],
	expected: z.infer<typeof inventoryRecord>[],
) {
	const actual = records
		.map((record) =>
			JSON.stringify([record.stream, record.key, record.op ?? "upsert"]),
		)
		.sort();
	const wanted = expected
		.map((record) => JSON.stringify([record.stream, record.key, record.op]))
		.sort();
	assert.equal(
		new Set(wanted).size,
		wanted.length,
		"duplicate expected identities and operations",
	);
	assert.deepEqual(
		actual,
		wanted,
		"fixture inventory identities and operations must match expected source records",
	);
}

function run(
	checkout: string,
	connector: string,
	fixture: Fixture,
	input: Scenario,
	state: unknown = null,
) {
	assert.equal(
		new Set(input.streams).size,
		input.streams.length,
		"duplicate selected streams",
	);
	const scratch = mkdtempSync(join(tmpdir(), "submission-fixture-"));
	try {
		const config = join(scratch, "config.json");
		const observations = join(scratch, "requests.jsonl");
		writeFileSync(
			config,
			JSON.stringify({ responses: input.responses, observations }),
		);
		const child = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--import",
				fileURLToPath(new URL("fixture-fetch.mjs", import.meta.url)),
				inCheckout(checkout, connectorEntrypoint(connector)),
			],
			{
				cwd: checkout,
				env: {
					PATH: process.env.PATH,
					TMPDIR: process.env.TMPDIR,
					...fixture.environment,
					SUBMISSION_FIXTURE_CONFIG: config,
				},
				input: `${JSON.stringify({ type: "START", run_id: "submission-pilot", now: "2026-11-18T00:00:00Z", collection_mode: "full_refresh", scope: { streams: input.streams.map((name) => ({ name })) }, state, bindings: { network: {} } })}\n`,
				encoding: "utf8",
				timeout: 20_000,
				killSignal: "SIGKILL",
				maxBuffer: 4 * 1024 * 1024,
			},
		);
		assert.equal(
			child.error,
			undefined,
			"connector must terminate within the fixture budget",
		);
		const calls = existsSync(observations)
			? readFileSync(observations, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map(
						(line) =>
							JSON.parse(line) as { route?: number; forbidden?: boolean },
					)
			: [];
		assert.ok(
			!calls.some((call) => call.forbidden || call.route === -1),
			"fixture attempted an undeclared request, socket or subprocess",
		);
		assert.ok(calls.length <= 200, "fixture request budget exceeded");
		for (let index = 0; index < input.responses.length; index += 1)
			assert.ok(
				calls.some((call) => call.route === index),
				`provider response ${index} was not exercised`,
			);
		const frames = child.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Frame);
		assert.equal(
			frames.filter((frame) => frame.type === "DONE").length,
			1,
			"one terminal DONE required",
		);
		assert.equal(
			frames.find((frame) => frame.type === "DONE")?.status,
			"succeeded",
			"fixture collection must succeed",
		);
		assert.equal(child.status, 0, "fixture process must succeed");
		assert.ok(
			frames
				.filter((frame) => frame.type === "RECORD")
				.every((frame) => input.streams.includes(frame.stream ?? "")),
			"unrequested stream emitted",
		);
		const records = frames.filter((frame) => frame.type === "RECORD");
		assert.equal(
			new Set(records.map(identity)).size,
			records.length,
			"fixture must not emit conflicting or duplicate records for one stream/key",
		);
		return frames;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Run the pilot's real-entrypoint behavioral checks; ordinary conformance does not call this. */
export function checkSubmissionBehavior(
	checkout: string,
	connector: string,
	staticOnly = false,
): Step[] {
	if (!/^[a-z][a-z0-9_]{0,79}$/.test(connector))
		throw new Error("invalid connector directory key");
	try {
		if (
			!isApiSubmissionPilot(
				JSON.parse(
					readFileSync(inCheckout(checkout, manifestPath(connector)), "utf8"),
				),
			)
		)
			return [];
	} catch {
		/* The ordinary manifest check reports unreadable declarations. */
	}
	if (staticOnly)
		return SUBMISSION_STEPS.map((name) => ({
			name,
			verdict: "UNKNOWN",
			detail: "Static conformance does not execute the submission fixture.",
			nextAction: remedy,
		}));
	let fixture: Fixture;
	try {
		const bytes = readFileSync(
			inCheckout(
				checkout,
				join(fixturesDir(connector), "submission-pilot.json"),
			),
			"utf8",
		);
		assert.ok(
			Buffer.byteLength(bytes) <= 2 * 1024 * 1024,
			"fixture exceeds 2 MiB",
		);
		fixture = fixtureSchema.parse(JSON.parse(bytes));
	} catch {
		return SUBMISSION_STEPS.map((name) => ({
			name,
			verdict: "FAIL",
			detail:
				"Submission fixture is missing or malformed; no behavioral pass is established.",
			nextAction: remedy,
		}));
	}
	const cases: [
		(typeof SUBMISSION_STEPS)[number],
		() => void,
		typeof exemption._output | undefined,
	][] = [
		[
			"submission refresh",
			() => {
				const manifest = JSON.parse(
					readFileSync(inCheckout(checkout, manifestPath(connector)), "utf8"),
				) as { streams: { name: string; required?: boolean }[] };
				for (const stream of manifest.streams.filter(
					(stream) => stream.required !== false,
				))
					assert.ok(
						fixture.refresh.streams.includes(stream.name),
						"refresh must exercise every required stream",
					);
				assert.ok(
					fixture.refresh.streams.every((name) =>
						manifest.streams.some((stream) => stream.name === name),
					),
					"refresh may select only declared streams",
				);
				const expected = fixture.refresh.records.map(identity).sort();
				const expectedOperations = new Map(
					fixture.refresh.records.map((record) => [
						identity(record),
						record.op,
					]),
				);
				assert.equal(
					new Set(expected).size,
					expected.length,
					"duplicate expected record keys",
				);
				for (const stream of fixture.refresh.streams)
					assert.ok(
						fixture.refresh.records.some(
							(record) => record.stream === stream && record.op === "upsert",
						),
						"empty refresh fixture cannot prove retention",
					);
				const first = run(checkout, connector, fixture, fixture.refresh);
				const states = first.filter((frame) => frame.type === "STATE");
				for (const stream of fixture.refresh.streams)
					assert.equal(
						states.filter((frame) => frame.stream === stream).length,
						1,
						"refresh needs the real checkpoint for each stream",
					);
				assert.ok(
					states.every((frame) => Object.hasOwn(frame, "cursor")),
					"refresh must capture the emitted cursor",
				);
				const second = run(
					checkout,
					connector,
					fixture,
					fixture.refresh,
					Object.fromEntries(
						states.map((frame) => [frame.stream, frame.cursor]),
					),
				);
				const records = (frames: Frame[]) =>
					frames
						.filter((frame) => frame.type === "RECORD")
						.sort((a, b) => identity(a).localeCompare(identity(b)));
				for (const frames of [first, second]) {
					for (const record of records(frames))
						assert.equal(
							record.op ?? "upsert",
							expectedOperations.get(identity(record)),
							"full-refresh operations must match the reviewed inventory",
						);
				}
				for (const frames of [first, second])
					assert.deepEqual(
						records(frames).map(identity).sort(),
						expected,
						"full_refresh must emit the complete expected inventory on both runs",
					);
				assert.deepEqual(
					records(second).map(({ stream, key, op, data }) => ({
						stream,
						key,
						op,
						data,
					})),
					records(first).map(({ stream, key, op, data }) => ({
						stream,
						key,
						op,
						data,
					})),
					"unchanged full-refresh values must survive checkpoint replay",
				);
			},
			undefined,
		],
		[
			"submission deletions",
			() => {
				const input = fixture.deletions;
				if ("not_applicable" in input) return;
				const frames = run(checkout, connector, fixture, input);
				for (const deleted of input.deleted)
					assert.ok(
						frames.some(
							(frame) =>
								frame.type === "RECORD" &&
								identity(frame) === identity(deleted) &&
								frame.op === "delete",
						),
						"deleted source item must emit op:delete with its original key",
					);
			},
			"not_applicable" in fixture.deletions ? fixture.deletions : undefined,
		],
		[
			"submission text",
			() => {
				const input = fixture.text;
				if ("not_applicable" in input) return;
				assert.ok(
					input.values.some(
						({ source }) =>
							/\p{Cc}/u.test(source.replace(/[\t\n\r]/g, "")) &&
							/\\u(?:00[0189][0-9a-f]|005c)/i.test(source),
					),
					"text fixture must include actual forbidden controls and an ambiguous literal escape",
				);
				const frames = run(checkout, connector, fixture, input);
				for (const value of input.values) {
					assert.ok(
						input.responses.some((route) =>
							hasString(route.body, value.source),
						),
						"expected text must occur in the provider response",
					);
					const record = frames.find(
						(frame) =>
							frame.type === "RECORD" && identity(frame) === identity(value),
					);
					assert.ok(record, "control-bearing source row must not disappear");
					assert.equal(
						record.op ?? "upsert",
						"upsert",
						"control-bearing source record must remain a live upsert",
					);
					const encoded = at(record.data, value.field);
					assert.equal(
						typeof encoded,
						"string",
						"expected an inline emitted text field",
					);
					assert.ok(
						pdppSafeText.safeParse(encoded).success,
						"emitted text must satisfy the transport character contract",
					);
					assert.equal(
						decodeEscapedText(String(encoded)),
						value.source,
						"emitted text must round-trip the full source value",
					);
				}
			},
			"not_applicable" in fixture.text ? fixture.text : undefined,
		],
		[
			"submission counts",
			() => {
				const input = fixture.counts;
				if ("not_applicable" in input) return;
				const totals = input.responses.map((route) =>
					at(route.body, input.total),
				);
				assert.ok(
					totals.every(
						(value) =>
							typeof value === "number" &&
							Number.isSafeInteger(value) &&
							value >= 0,
					),
					"count fixture requires observed source totals",
				);
				const rows = input.responses.map((route) =>
					at(route.body, input.items),
				);
				assert.ok(
					rows.every(Array.isArray),
					"count fixture requires source item arrays",
				);
				const returned = rows.reduce<number>(
					(sum, value) => sum + (Array.isArray(value) ? value.length : 0),
					0,
				);
				const advertised = Math.max(...totals.map(Number));
				assert.ok(
					returned > 0 && advertised > returned,
					"count fixture must contain a real source-count shortfall",
				);
				assert.deepEqual(
					input.streams,
					[input.stream],
					"shortfall probe selects only the counted stream",
				);
				const frames = run(checkout, connector, fixture, input);
				const emittedRecords = frames.filter(
					(frame) => frame.type === "RECORD" && frame.stream === input.stream,
				);
				const emitted = emittedRecords.length;
				assert.equal(
					input.records.length,
					returned,
					"shortfall expectations must cover every valid source row",
				);
				assertInventory(emittedRecords, input.records);
				assert.equal(
					new Set(emittedRecords.map(identity)).size,
					emitted,
					"shortfall must retain distinct source records",
				);
				assert.equal(
					emitted,
					returned,
					"source-count shortfall must preserve every valid fixture row",
				);
				assert.ok(
					!frames.some(
						(frame) => frame.type === "STATE" && frame.stream === input.stream,
					),
					"incomplete inventory must not advance its checkpoint",
				);
				assert.ok(
					frames.some(
						(frame) =>
							frame.type === "DETAIL_COVERAGE" &&
							frame.stream === input.stream &&
							(frame.considered ?? 0) >= advertised &&
							frame.covered === emitted &&
							(frame.considered ?? 0) > (frame.covered ?? 0),
					),
					"source-count shortfall must remain successful with incomplete measured coverage",
				);
			},
			"not_applicable" in fixture.counts ? fixture.counts : undefined,
		],
	];
	return cases.map(([name, check, exempt]) => {
		if (exempt)
			return {
				name,
				advisory: true,
				verdict: "ADVISORY",
				detail: `Not applicable, author declaration: ${exempt.not_applicable.reason}; reference: ${exempt.not_applicable.reference}`,
				nextAction:
					"Review this capability assertion and explicitly disposition it in the submission evidence.",
			};
		try {
			check();
			return {
				name,
				verdict: "PASS",
				detail:
					"Real-entrypoint synthetic fixture passed the shared behavioral assertions.",
			};
		} catch (error) {
			const detail =
				error instanceof assert.AssertionError
					? error.message.split("\n")[0]
					: "Fixture execution failed; inspect its declared responses and connector output.";
			return {
				name,
				verdict: "FAIL",
				detail: detail || "Submission behavior failed.",
				nextAction: remedy,
			};
		}
	});
}
