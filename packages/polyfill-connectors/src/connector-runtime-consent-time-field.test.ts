// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import {
	connectorEntrypoint,
	manifestPath,
	packageRoot,
} from "./connector-paths.ts";
import {
	consentTimeFieldResolver,
	makeEmitRecord,
	withholdsBoundedProgress,
} from "./connector-runtime.ts";
import { readPolyfillManifests } from "./manifest-registry.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const SINCE = "2026-01-01T00:00:00Z";
const UNTIL = "2026-02-01T00:00:00Z";
const IN_RANGE = "2026-01-15T12:00:00.000Z";
const BEFORE = "2025-12-31T23:59:59.999Z";
const AT_UNTIL = "2026-02-01T00:00:00.000Z";

interface ManifestStream {
	consent_time_field?: string | null;
	name: string;
	schema?: { properties?: Record<string, { format?: string; type?: unknown }> };
}

/**
 * Every `runConnector` connector with its manifest streams, read from disk
 * rather than from the generated table, so the sweep cross-checks it.
 */
const connectors = readPolyfillManifests()
	.map(({ file, manifest }) => ({
		key: file.replace(/\.json$/u, ""),
		streams: (manifest as { streams: ManifestStream[] }).streams,
	}))
	.filter(({ key }) => {
		const entry = connectorEntrypoint(key);
		return (
			existsSync(entry) && readFileSync(entry, "utf8").includes("runConnector(")
		);
	});

function connectorKeys(): string[] {
	return readPolyfillManifests()
		.map(({ file }) => file.replace(/\.json$/u, ""))
		.sort((a, b) => a.localeCompare(b));
}

/**
 * True when the manifest declares a `date-time` consent field for the stream.
 * A string with no format is not eligible (Collection Profile §5.1).
 */
function isTimestampField(stream: ManifestStream): boolean {
	const field = stream.consent_time_field;
	if (!field) return false;
	const property = stream.schema?.properties?.[field];
	const types = Array.isArray(property?.type)
		? property.type
		: [property?.type];
	return types.includes("string") && property?.format === "date-time";
}

async function bounded(
	connector: string,
	stream: string,
	data: Record<string, unknown>,
): Promise<EmittedMessage[]> {
	const messages: EmittedMessage[] = [];
	const gate = makeEmitRecord({
		requested: new Map([
			[stream, { name: stream, time_range: { since: SINCE, until: UNTIL } }],
		]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-05-03T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver(connector),
	});
	await gate.emit(stream, data);
	return messages;
}

test("the generated consent-time-field modules match the manifests on disk", () => {
	const scratch = mkdtempSync(join(tmpdir(), "consent-time-fields-drift-"));
	try {
		execFileSync(
			"node",
			[
				"--experimental-strip-types",
				join(packageRoot, "scripts/generate-consent-time-fields.ts"),
				scratch,
			],
			{ cwd: packageRoot, stdio: "pipe" },
		);
		const tracked = join(packageRoot, "src/generated");
		const regenerate =
			"regenerate with `node --experimental-strip-types scripts/generate-consent-time-fields.ts`";
		assert.equal(
			readFileSync(join(scratch, "consent-time-fields.generated.ts"), "utf8"),
			readFileSync(join(tracked, "consent-time-fields.generated.ts"), "utf8"),
			regenerate,
		);
		// One slice per manifest, no extra, each current.
		const expected = readdirSync(join(scratch, "consent-time-fields")).sort();
		assert.deepEqual(
			readdirSync(join(tracked, "consent-time-fields")).sort(),
			expected,
			regenerate,
		);
		assert.deepEqual(
			expected,
			connectorKeys().map((key) => `${key}.generated.ts`),
			"one slice per connector manifest",
		);
		for (const name of expected) {
			assert.equal(
				readFileSync(join(scratch, "consent-time-fields", name), "utf8"),
				readFileSync(join(tracked, "consent-time-fields", name), "utf8"),
				`${name}: ${regenerate}`,
			);
		}
	} finally {
		rmSync(scratch, { force: true, recursive: true });
	}
});

// One fixture per way connectors name their consent field. Before the fix,
// each of these returned nothing because the runtime read `date`.
const families = new Map<string, { connector: string; stream: string }>();
for (const { key, streams } of connectors) {
	for (const stream of streams) {
		if (!isTimestampField(stream) || stream.consent_time_field === "date") {
			continue;
		}
		const field = stream.consent_time_field as string;
		if (!families.has(field)) {
			families.set(field, { connector: key, stream: stream.name });
		}
	}
}

for (const [field, { connector, stream }] of families) {
	test(`family ${field} (${connector}/${stream}): bounded emit keeps in-range and drops out-of-range records`, async () => {
		const kept = await bounded(connector, stream, {
			id: "in",
			[field]: IN_RANGE,
		});
		assert.equal(kept.length, 1, "an in-range record must be emitted");
		assert.equal(
			(await bounded(connector, stream, { id: "early", [field]: BEFORE }))
				.length,
			0,
			"a record before since must be excluded",
		);
		assert.equal(
			(await bounded(connector, stream, { id: "late", [field]: AT_UNTIL }))
				.length,
			0,
			"until is exclusive",
		);
		assert.equal(
			(await bounded(connector, stream, { id: "dated", date: IN_RANGE }))
				.length,
			0,
			"an in-range `date` must not stand in for the declared field",
		);
	});
}

test("every bounded stream of every runConnector connector keeps its in-range records or reports scope_not_supported", async () => {
	let timestampStreams = 0;
	let unsupportedStreams = 0;
	const failures: string[] = [];
	// Sequential: each connector is one subprocess and the output is compared per stream.
	for (const { key, streams } of connectors) {
		const records = streams.flatMap((stream) => {
			const field = stream.consent_time_field ?? "observed_at";
			return [
				{ data: { id: "in", [field]: IN_RANGE }, stream: stream.name },
				{ data: { id: "early", [field]: BEFORE }, stream: stream.name },
				{ data: { id: "late", [field]: AT_UNTIL }, stream: stream.name },
			];
		});
		// biome-ignore lint/performance/noAwaitInLoops: one subprocess at a time keeps the sweep's load bounded
		const result = await runConnectorProtocolSubprocess({
			cwd: fileURLToPath(new URL("../../..", import.meta.url)),
			entrypoint: fileURLToPath(
				new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
			),
			env: {
				PDPP_TEST_CONNECTOR_NAME: key,
				PDPP_TEST_RECORDS: JSON.stringify(records),
			},
			start: {
				scope: {
					streams: streams.map((stream) => ({
						name: stream.name,
						time_range: { since: SINCE, until: UNTIL },
					})),
				},
				type: "START",
			},
		});
		for (const stream of streams) {
			const kept = result.messages
				.filter((m) => m.type === "RECORD" && m.stream === stream.name)
				.map((m) => (m as { key: string }).key);
			const skip = result.messages.find(
				(m) => m.type === "SKIP_RESULT" && m.stream === stream.name,
			) as { reason?: string } | undefined;
			if (isTimestampField(stream)) {
				timestampStreams += 1;
				if (kept.join() !== "in" || skip) {
					failures.push(`${key}/${stream.name}: kept [${kept}]`);
				}
			} else {
				unsupportedStreams += 1;
				if (kept.length > 0 || skip?.reason !== "scope_not_supported") {
					failures.push(
						`${key}/${stream.name}: kept [${kept}], skip ${skip?.reason}`,
					);
				}
			}
		}
		const done = result.messages.findLast((m) => m.type === "DONE");
		if (done?.type !== "DONE" || done.status !== "succeeded") {
			failures.push(`${key}: DONE ${JSON.stringify(done)}`);
		}
	}
	assert.deepEqual(failures, []);
	console.log(
		`sweep: ${connectors.length} connectors, ${timestampStreams} timestamp streams kept in-range records, ${unsupportedStreams} streams reported scope_not_supported`,
	);
});

test("YouTube watch_history (no timestamp consent field) reports scope_not_supported", async () => {
	assert.equal(consentTimeFieldResolver("youtube")("watch_history"), null);
	const result = await runConnectorProtocolSubprocess({
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
		),
		env: {
			PDPP_TEST_CONNECTOR_NAME: "youtube",
			PDPP_TEST_RECORDS: JSON.stringify([
				{
					data: { id: "v1", watched_date: "2026-01-15" },
					stream: "watch_history",
				},
			]),
		},
		start: {
			scope: {
				streams: [
					{ name: "watch_history", time_range: { since: SINCE, until: UNTIL } },
				],
			},
			type: "START",
		},
	});
	assert.deepEqual(
		result.messages
			.filter((m) => m.type === "RECORD" || m.type === "SKIP_RESULT")
			.map((m) => [m.type, (m as { reason?: string }).reason ?? null]),
		[["SKIP_RESULT", "scope_not_supported"]],
	);
});

test("a full-date bound on an instant consent field reports scope_not_supported", async () => {
	assert.deepEqual(consentTimeFieldResolver("claude_code")("messages"), {
		field: "timestamp",
		format: "date-time",
	});
	const result = await runConnectorProtocolSubprocess({
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
		),
		env: {
			PDPP_TEST_CONNECTOR_NAME: "claude_code",
			PDPP_TEST_RECORDS: JSON.stringify([
				{
					data: { id: "m1", timestamp: "2026-01-15T12:00:00Z" },
					stream: "messages",
				},
			]),
		},
		start: {
			scope: {
				streams: [
					{
						name: "messages",
						time_range: { since: "2026-01-01", until: "2026-02-01" },
					},
				],
			},
			type: "START",
		},
	});
	const skips = result.messages.filter(
		(m) => m.type === "RECORD" || m.type === "SKIP_RESULT",
	);
	assert.deepEqual(
		skips.map((m) => [m.type, (m as { reason?: string }).reason ?? null]),
		[["SKIP_RESULT", "scope_not_supported"]],
	);
	assert.match(
		String((skips[0] as { message?: string }).message),
		/since and until for messages must be a date-time with a time-zone offset/,
	);
});

/** Runs a shipped connector's name over the given records with one bounded stream. */
function boundedRun(
	connector: string,
	stream: string,
	records: Array<Record<string, unknown>>,
	timeRange: { since?: string; until?: string },
) {
	return runConnectorProtocolSubprocess({
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
		),
		env: {
			PDPP_TEST_CONNECTOR_NAME: connector,
			PDPP_TEST_RECORDS: JSON.stringify(
				records.map((data) => ({ data, stream })),
			),
		},
		start: {
			scope: { streams: [{ name: stream, time_range: timeRange }] },
			type: "START",
		},
	});
}

for (const connector of ["strava", "strava-browser"]) {
	test(`${connector} compares full-date bounds with start_date_local`, async () => {
		assert.deepEqual(consentTimeFieldResolver(connector)("activities"), {
			field: "start_date_local",
			format: "date",
		});
		const result = await boundedRun(
			connector,
			"activities",
			[
				{ id: "before", start_date_local: "2026-09-15" },
				{ id: "first-day", start_date_local: "2026-09-16" },
				{ id: "last-day", start_date_local: "2026-09-30" },
				{ id: "until-day", start_date_local: "2026-10-01" },
				{
					id: "no-local-day",
					start_date: "2026-09-20",
					start_date_local: null,
				},
				{ id: "instant", start_date_local: "2026-09-20T12:00:00Z" },
			],
			{ since: "2026-09-16", until: "2026-10-01" },
		);
		assert.deepEqual(
			result.messages
				.filter((m) => m.type === "RECORD" || m.type === "SKIP_RESULT")
				.map((m) => (m.type === "RECORD" ? m.key : m.type)),
			["first-day", "last-day"],
		);
	});

	test(`${connector}: an instant bound on start_date_local reports scope_not_supported`, async () => {
		const result = await boundedRun(
			connector,
			"activities",
			[{ id: "a1", start_date_local: "2026-09-20" }],
			{
				since: "2026-09-16T00:00:00Z",
			},
		);
		assert.deepEqual(
			result.messages
				.filter((m) => m.type === "RECORD" || m.type === "SKIP_RESULT")
				.map((m) => `${m.type}:${(m as { reason?: string }).reason ?? ""}`),
			["SKIP_RESULT:scope_not_supported"],
		);
	});
}

test("a record withheld at or after until blocks that stream's checkpoint", async () => {
	const run = (timestamp: string) =>
		runConnectorProtocolSubprocess({
			cwd: fileURLToPath(new URL("../../..", import.meta.url)),
			entrypoint: fileURLToPath(
				new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
			),
			env: {
				PDPP_TEST_CONNECTOR_NAME: "claude_code",
				PDPP_TEST_EMIT_STATE: "1",
				PDPP_TEST_RECORDS: JSON.stringify([
					{ data: { id: "m1", timestamp }, stream: "messages" },
				]),
			},
			start: {
				scope: {
					streams: [
						{
							name: "messages",
							time_range: {
								since: "2026-01-01T00:00:00Z",
								until: "2026-02-01T00:00:00Z",
							},
						},
					],
				},
				type: "START",
			},
		});
	const kinds = (result: Awaited<ReturnType<typeof run>>) =>
		result.messages
			.filter((m) => m.type === "RECORD" || m.type === "STATE")
			.map((m) => m.type);
	assert.deepEqual(kinds(await run("2026-01-15T00:00:00Z")), [
		"RECORD",
		"STATE",
	]);
	const after = await run("2026-02-01T00:00:00Z");
	assert.deepEqual(kinds(after), []);
	assert.ok(
		after.messages.some(
			(m) =>
				m.type === "PROGRESS" && /STATE for messages not saved/.test(m.message),
		),
	);
	// A record before `since` is withheld too, but it cannot be past the cursor.
	assert.deepEqual(kinds(await run("2025-12-31T00:00:00Z")), ["STATE"]);
});

test("checkpoints and gap-recovery receipts of every stream are held back after an until-withheld record", () => {
	const withheld = new Set(["messages"]);
	const recovered = {
		type: "DETAIL_GAP_RECOVERED",
		stream: "messages",
	} as unknown as EmittedMessage;
	assert.equal(withholdsBoundedProgress(recovered, withheld), true);
	assert.equal(withholdsBoundedProgress(recovered, new Set()), false);
	// Another stream's checkpoint can carry this stream's position.
	assert.equal(
		withholdsBoundedProgress(
			{ type: "STATE", stream: "sessions", cursor: {} } as EmittedMessage,
			withheld,
		),
		true,
	);
	assert.equal(
		withholdsBoundedProgress(
			{ type: "PROGRESS", message: "x" } as EmittedMessage,
			withheld,
		),
		false,
	);
});

test("an until-withheld record on one stream holds back an unbounded stream's checkpoint", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/manifest-consent-time.ts", import.meta.url),
		),
		env: {
			PDPP_TEST_CONNECTOR_NAME: "claude_code",
			PDPP_TEST_EMIT_STATE: "1",
			PDPP_TEST_RECORDS: JSON.stringify([
				{
					data: { id: "m1", timestamp: "2026-01-15T00:00:00Z" },
					stream: "messages",
				},
				{
					data: { id: "a1", timestamp: "2026-02-01T00:00:00Z" },
					stream: "attachments",
				},
			]),
		},
		start: {
			scope: {
				streams: [
					{ name: "messages" },
					{
						name: "attachments",
						time_range: { until: "2026-02-01T00:00:00Z" },
					},
				],
			},
			type: "START",
		},
	});
	assert.deepEqual(
		result.messages
			.filter((m) => m.type === "RECORD" || m.type === "STATE")
			.map((m) => `${m.type}:${(m as { stream: string }).stream}`),
		["RECORD:messages"],
	);
});

test("a shipped connector cannot override its manifest's consent field", () => {
	assert.throws(
		() => consentTimeFieldResolver("claude_code", "date"),
		/shipped manifest/u,
	);
	assert.deepEqual(
		consentTimeFieldResolver("youtube-takeout")("watch_history"),
		{
			field: "watched_at",
			format: "date-time",
		},
	);
	assert.equal(consentTimeFieldResolver("unshipped-fixture")("events"), null);
	assert.deepEqual(
		consentTimeFieldResolver("unshipped-fixture", "occurred_at")("events"),
		{
			field: "occurred_at",
			format: "date-time",
		},
	);
});

test("claude_code end to end: a bounded run keeps in-range sessions and messages", async () => {
	const home = mkdtempSync(join(tmpdir(), "pdpp-claude-bounded-"));
	try {
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const project = join(home, "projects", "-tmp-bounded");
		await mkdir(project, { recursive: true });
		const line = (uuid: string, timestamp: string) =>
			JSON.stringify({
				isSidechain: false,
				message: { content: "x" },
				sessionId,
				timestamp,
				type: "user",
				uuid,
			});
		await writeFile(
			join(project, `${sessionId}.jsonl`),
			`${line("00000000-0000-4000-8000-000000000001", BEFORE)}\n${line("00000000-0000-4000-8000-000000000002", IN_RANGE)}\n`,
		);
		const run = (timeRange?: { since: string; until: string }) =>
			runConnectorProtocolSubprocess({
				allowFailedDone: true,
				cwd: fileURLToPath(new URL("../../..", import.meta.url)),
				entrypoint: connectorEntrypoint("claude_code"),
				env: {
					CLAUDE_CODE_HOME: home,
					CLAUDE_CODE_PROJECTS_DIR: join(home, "projects"),
				},
				start: {
					scope: {
						streams: ["sessions", "messages"].map((name) => ({
							name,
							...(timeRange ? { time_range: timeRange } : {}),
						})),
					},
					type: "START",
				},
			});
		const count = (messages: EmittedMessage[], stream: string) =>
			messages.filter((m) => m.type === "RECORD" && m.stream === stream).length;
		const all = await run();
		const inWindow = await run({ since: "2026-01-01T00:00:00Z", until: UNTIL });
		const early = await run({ since: "2025-01-01T00:00:00Z", until: SINCE });
		const done = inWindow.messages.findLast((m) => m.type === "DONE");
		assert.equal(done?.type === "DONE" && done.status, "succeeded");
		assert.equal(count(all.messages, "messages"), 2);
		assert.equal(
			count(inWindow.messages, "messages"),
			1,
			"only the in-range message",
		);
		assert.equal(
			count(early.messages, "messages"),
			1,
			"only the early message",
		);
		assert.ok(count(all.messages, "sessions") >= 1);
	} finally {
		rmSync(home, { force: true, recursive: true });
	}
});

// ---- built artifacts ------------------------------------------------------
// A built connector bundles its own consent slice and is bound to that
// connector. These tests bundle the real runtime with the same esbuild plugin
// the Core and PageShim builders use.

const repoRoot = join(packageRoot, "../..");
const renderModulePath = join(
	packageRoot,
	"scripts/consent-time-fields-render.mjs",
);

async function bundleFixture(
	connectorDirectory: string,
	options: { expectedSlice?: string } = {},
) {
	const { consentSlicePlugin } = await import(
		pathToFileURL(join(repoRoot, "scripts/consent-slice-resolution.mjs")).href
	);
	const { renderSlice } = await import(pathToFileURL(renderModulePath).href);
	const expectedSlice =
		options.expectedSlice ??
		renderSlice(
			connectorDirectory,
			JSON.parse(readFileSync(manifestPath(connectorDirectory), "utf8")),
		);
	const esbuild = await import("esbuild");
	// Inside node_modules so the bundle's external packages resolve.
	const outdir = mkdtempSync(join(repoRoot, "node_modules", ".consent-slice-"));
	try {
		const result = await esbuild.build({
			absWorkingDir: repoRoot,
			bundle: true,
			entryPoints: [
				join(packageRoot, "src/__fixtures__/manifest-consent-time.ts"),
			],
			format: "esm",
			logLevel: "silent",
			metafile: true,
			outfile: join(outdir, "bundle.mjs"),
			packages: "external",
			platform: "node",
			plugins: [
				consentSlicePlugin({
					connectorDirectory,
					expectedSlice,
					repoRoot,
				}),
			],
		});
		return { entrypoint: join(outdir, "bundle.mjs"), outdir, result };
	} catch (error) {
		rmSync(outdir, { force: true, recursive: true });
		throw error;
	}
}

function runBundle(
	entrypoint: string,
	name: string,
	stream: string,
	data: Record<string, unknown>,
	timeRange: { since?: string; until?: string },
) {
	return runConnectorProtocolSubprocess({
		cwd: repoRoot,
		entrypoint,
		env: {
			PDPP_TEST_CONNECTOR_NAME: name,
			PDPP_TEST_RECORDS: JSON.stringify([{ data, stream }]),
		},
		start: {
			scope: { streams: [{ name: stream, time_range: timeRange }] },
			type: "START",
		},
	});
}

test("a bundle resolves the consent table to its connector's slice alone", async () => {
	const { outdir, result } = await bundleFixture("reddit");
	try {
		const consentInputs = Object.keys(result.metafile.inputs).filter((input) =>
			input.includes("consent-time-fields"),
		);
		assert.deepEqual(consentInputs, [
			"packages/polyfill-connectors/src/generated/consent-time-fields/reddit.generated.ts",
		]);
	} finally {
		rmSync(outdir, { force: true, recursive: true });
	}
});

test("a bundle bound to a connector applies that connector's manifest fields", async () => {
	const { entrypoint, outdir } = await bundleFixture("reddit");
	try {
		const run = async (created: string) =>
			(
				await runBundle(
					entrypoint,
					"reddit",
					"submitted",
					{ created_utc: created, id: "p1" },
					{ since: SINCE, until: UNTIL },
				)
			).messages.filter((m) => m.type === "RECORD").length;
		assert.equal(await run(IN_RANGE), 1);
		assert.equal(await run(BEFORE), 0);
	} finally {
		rmSync(outdir, { force: true, recursive: true });
	}
});

test("a bundle bound to one connector refuses another connector's name", async () => {
	const { entrypoint, outdir } = await bundleFixture("reddit");
	try {
		const refuses = (name: string) =>
			assert.rejects(
				runBundle(
					entrypoint,
					name,
					"submitted",
					{ created_utc: IN_RANGE, id: "p1" },
					{ since: SINCE, until: UNTIL },
				),
				/bound to reddit/u,
				`name ${JSON.stringify(name)} must not pass as an unshipped fixture`,
			);
		await refuses("amazon");
		await refuses("reddit-extra");
	} finally {
		rmSync(outdir, { force: true, recursive: true });
	}
});

test("a bound bundle accepts the hyphenated spelling of its connector's name", async () => {
	const { entrypoint, outdir } = await bundleFixture("strava_browser");
	try {
		const keptRecords = async (name: string) =>
			(
				await runBundle(
					entrypoint,
					name,
					"activities",
					{ id: "a1", start_date_local: "2026-09-20" },
					{ since: "2026-09-16", until: "2026-10-01" },
				)
			).messages.filter((m) => m.type === "RECORD").length;
		assert.equal(await keptRecords("strava-browser"), 1, "strava-browser");
		assert.equal(await keptRecords("strava_browser"), 1, "strava_browser");
		await assert.rejects(
			runBundle(entrypoint, "strava", "activities", { id: "a1" }, {}),
			/bound to strava_browser/u,
		);
	} finally {
		rmSync(outdir, { force: true, recursive: true });
	}
});

test("a bundle build fails when the connector has no slice", async () => {
	await assert.rejects(
		bundleFixture("no_such_connector", { expectedSlice: "" }),
		/consent-time-field slice .*no_such_connector.*is missing/u,
	);
});

test("a bundle build fails when the slice is stale", async () => {
	await assert.rejects(
		bundleFixture("reddit", {
			expectedSlice: "// what a changed manifest would generate\n",
		}),
		/consent-time-field slice .*reddit.*is stale/u,
	);
});
