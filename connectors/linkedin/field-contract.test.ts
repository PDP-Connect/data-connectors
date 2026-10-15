// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The field-reading contract, end to end through `collectLinkedIn`.
 *
 * PDPP LinkedIn replaces the legacy collector, so a stream reported complete
 * authorizes deleting stored rows. A stream may be complete only when its
 * enumeration ended verifiably AND every mapped field of every row was read
 * (or the source said it is empty). These tests feed every mapped source
 * path, and every container on the way to it, a malformed value, and assert
 * that the run does not crash, that the stream is not complete, and that the
 * affected field is left out of its row instead of being emitted as `null`.
 *
 * The second half pins every concrete counterexample from the three review
 * rounds of this port.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectLinkedIn } from "./index.ts";
import { validateRecord } from "./schemas.ts";

type Json = unknown;
type Path = readonly string[];
type Root = "dash" | "me" | "page" | "resolved";

const MEMBER = "urn:li:fsd_profile:m1";
const ALL_STREAMS = [
	"profile",
	"experience",
	"education",
	"skills",
	"languages",
	"connections",
];

const image = (segment: string) => ({
	artifacts: [{ fileIdentifyingUrlPathSegment: segment }],
	rootUrl: "https://media.example/",
});

/** Every mapped source path holds a valid value. */
function baseFixture(): Record<Root, Json> {
	return structuredClone({
		dash: {
			firstName: "Ada",
			geoLocation: { geo: { defaultLocalizedName: "London, England" } },
			headline: "Engineer",
			industry: { name: "Computing" },
			lastName: "Lovelace",
			location: {
				basicLocation: { countryCode: "GB" },
				preferredGeoPlace: "London",
			},
			profileEducations: {
				elements: [
					{
						dateRange: { end: { year: 1835 }, start: { year: 1830 } },
						degreeName: "Mathematics",
						entityUrn: "urn:edu:1",
						fieldOfStudy: "Analysis",
						grade: "First",
						school: {
							logo: {
								"com.linkedin.common.VectorImage": image("logo-typed.png"),
								vectorImage: image("logo.png"),
							},
							name: "Home School",
						},
						schoolLogo: { vectorImage: image("logo-old.png") },
						schoolName: "Home",
					},
				],
			},
			profileLanguages: {
				elements: [
					{
						entityUrn: "urn:lang:1",
						name: "French",
						proficiency: "Professional",
					},
				],
			},
			profilePicture: {
				displayImageReference: { vectorImage: image("dash.jpg") },
			},
			profilePositionGroups: {
				elements: [
					{
						company: { name: "Analytical" },
						dateRange: { start: { month: 1, year: 2020 } },
						entityUrn: "urn:group:1",
						name: "Analytical Group",
						profilePositionInPositionGroup: {
							elements: [
								{
									companyName: "Analytical Engines",
									dateRange: { start: { month: 1, year: 2020 } },
									description: "Builds engines",
									employmentType: { name: "Full-time" },
									entityUrn: "urn:pos:1",
									geoLocationName: "London, UK",
									locationName: "London",
									title: "Engineer",
								},
							],
						},
						title: "Group title",
					},
					{
						company: { name: "Babbage" },
						dateRange: {
							end: { month: 6, year: 2019 },
							start: { year: 2010 },
						},
						description: "Assisted",
						entityUrn: "urn:group:2",
						geoLocationName: "Cambridge, UK",
						locationName: "Cambridge",
						name: "Babbage Co",
						title: "Assistant",
					},
				],
			},
			profileSkills: {
				elements: [
					{
						endorsementCount: 5,
						endorsements: 5,
						entityUrn: "urn:skill:1",
						name: "Programming",
					},
					{
						entityUrn: "urn:cat:1",
						name: "Category",
						skills: [
							{
								endorsementCount: 3,
								endorsements: 3,
								entityUrn: "urn:skill:2",
								name: "Mathematics",
							},
						],
					},
				],
			},
			summary: "Writes programs.",
		},
		me: {
			miniProfile: {
				firstName: "Ada",
				lastName: "Lovelace",
				occupation: "Engineer (me)",
				picture: {
					artifacts: [{ fileIdentifyingUrlPathSegment: "me-bare.jpg" }],
					"com.linkedin.common.VectorImage": image("me-typed.jpg"),
					rootUrl: "https://media.example/",
				},
				publicIdentifier: "ada",
			},
			publicIdentifier: "ada",
		},
		page: {
			elements: [{ connectedMember: MEMBER, createdAt: 1_700_000_000_000 }],
			paging: { count: 40, start: 0, total: 1 },
		},
		resolved: {
			firstName: "Charles",
			headline: "Inventor",
			lastName: "Babbage",
			occupation: "Inventor (occupation)",
			publicIdentifier: "charles",
		},
	});
}

// ─── Harness ─────────────────────────────────────────────────────────────

interface Routes {
	connections?: (start: number) => Json;
	dash?: (decoration: string | null) => Json;
	me?: Json;
	resolve?: (path: string) => Json;
}

/** Default test collections represent complete sections; paging-specific
 *  tests leave their explicit evidence untouched. */
function completeCollectionsForFixture(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(completeCollectionsForFixture);
	if (typeof value !== "object" || value === null) return value;
	const collection = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			completeCollectionsForFixture(child),
		]),
	);
	return Array.isArray(collection.elements) && !Object.hasOwn(collection, "paging")
		? { ...collection, paging: { start: 0, total: collection.elements.length } }
		: collection;
}

function routesFor(fixture: Record<Root, Json>): Routes {
	return {
		connections: (start) =>
			start === 0
				? fixture.page
				: { elements: [], paging: { count: 40, start } },
		// Field-contract cases focus on row shape; collections default to a
		// verified complete inventory unless a test supplies paging evidence.
		dash: () => ({ elements: [completeCollectionsForFixture(fixture.dash)] }),
		me: fixture.me,
		resolve: () => ({ results: { [MEMBER]: fixture.resolved } }),
	};
}

function fakePage(routes: Routes): Page {
	const respond = (path: string): Json => {
		if (path.startsWith("/voyager/api/me")) return routes.me;
		if (
			path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
		) {
			const decoration = /decorationId=([^&]+)/u.exec(path)?.[1] ?? null;
			return routes.dash?.(decoration) ?? { _error: "no dash route" };
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			const start = Number(/start=(\d+)/u.exec(path)?.[1] ?? "0");
			return routes.connections?.(start) ?? { _error: "no connections route" };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return routes.resolve?.(path) ?? { _error: "no resolve route" };
		}
		return { _error: `unhandled path: ${path}` };
	};
	return {
		evaluate: async (fn: unknown, arg: unknown) => {
			const g = globalThis as { document?: unknown; fetch?: unknown };
			const priorDocument = g.document;
			const priorFetch = g.fetch;
			g.document = { cookie: 'JSESSIONID="ajax:1"' };
			g.fetch = async (path: string) => {
				const body = respond(path);
				const failed =
					typeof body === "object" &&
					body !== null &&
					"_error" in (body as Record<string, unknown>);
				return {
					json: async () => body,
					ok: !failed,
					status: failed ? 500 : 200,
				};
			};
			try {
				return await (fn as (a: unknown) => unknown)(arg);
			} finally {
				g.document = priorDocument;
				g.fetch = priorFetch;
			}
		},
		goto: async () => null,
	} as unknown as Page;
}

/** Run with `setTimeout` mocked and drained, so polite delays cost nothing. */
async function withoutDelays<T>(run: () => Promise<T>): Promise<T> {
	mock.timers.enable({ apis: ["setTimeout"] });
	let draining = true;
	const drain = () => {
		if (!draining) return;
		mock.timers.runAll();
		setImmediate(drain);
	};
	setImmediate(drain);
	try {
		return await run();
	} finally {
		draining = false;
		mock.timers.reset();
	}
}

async function collect(
	routes: Routes,
	streams: readonly string[] = ALL_STREAMS,
) {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = {
		assist: async (): Promise<never> => {
			throw new Error("assist not available in this test");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: recording.emit,
		emitRecord: recording.emitRecord,
		emittedAt: "2026-10-15T12:00:00.000Z",
		page: fakePage(routes),
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map(streams.map((name) => [name, { name }])),
		scope: { streams: streams.map((name) => ({ name })) },
		sendInteraction: async (): Promise<never> => {
			throw new Error("sendInteraction not available in this test");
		},
		state: {},
	} as BrowserCollectContext;
	await withoutDelays(() => collectLinkedIn(ctx));
	return recording;
}

type Recording = Awaited<ReturnType<typeof collect>>;

interface StreamOutcome {
	complete: boolean;
	coverage: {
		considered: number | undefined;
		covered: number | undefined;
	} | null;
	gaps: Array<Extract<EmittedMessage, { type: "SKIP_RESULT" }>>;
	records: Array<Record<string, unknown>>;
	/** Emit attempts the output schema rejected. A partial row would land
	 *  here, not in `records`, so it must be counted too. */
	rejected: number;
}

/** Complete: one DETAIL_COVERAGE with covered === considered, and no gap. */
function outcomeOf(recording: Recording, stream: string): StreamOutcome {
	const coverage = recording.protocolMessages.filter(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === stream,
	);
	const gaps = recording.protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			message.type === "SKIP_RESULT" && message.stream === stream,
	);
	const only = coverage.length === 1 ? (coverage[0] ?? null) : null;
	return {
		complete:
			only !== null &&
			typeof only.considered === "number" &&
			only.considered === only.covered &&
			gaps.length === 0,
		coverage:
			only === null
				? null
				: { considered: only.considered, covered: only.covered },
		gaps,
		records: recording.emitted
			.filter((record) => record.stream === stream)
			.map((record) => record.data as Record<string, unknown>),
		rejected: recording.skipped.filter((record) => record.stream === stream)
			.length,
	};
}

/** The stream emitted no row, and its gap names each unreadable field. A
 *  withheld row is still considered, so the stream is never complete. */
function assertWithheld(
	outcome: StreamOutcome,
	fields: readonly string[],
	label = "",
): void {
	assert.equal(outcome.complete, false, `${label}: stream reported complete`);
	const named = new Set(
		outcome.gaps.flatMap((gap) =>
			Object.keys(
				(gap.diagnostics as { unavailable_fields?: object } | undefined)
					?.unavailable_fields ?? {},
			),
		),
	);
	for (const field of fields) {
		assert.ok(named.has(field), `${label}: gap does not name ${field}`);
	}
	assert.deepEqual(outcome.records, [], `${label}: uncovered row was emitted`);
	assert.equal(outcome.rejected, 0, `${label}: a partial row was emitted`);
}

function setPath(root: Json, path: Path, value: Json): void {
	let node = root as Record<string, unknown>;
	for (const key of path.slice(0, -1)) {
		if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
		node = node[key] as Record<string, unknown>;
	}
	node[path.at(-1) as string] = value;
}

function deletePath(root: Json, path: Path): void {
	let node: unknown = root;
	for (const key of path.slice(0, -1)) {
		if (typeof node !== "object" || node === null) return;
		node = (node as Record<string, unknown>)[key];
	}
	if (typeof node === "object" && node !== null) {
		delete (node as Record<string, unknown>)[path.at(-1) as string];
	}
}

// ─── Malformed values ────────────────────────────────────────────────────

type LeafKind = "text" | "required" | "date" | "image" | "count" | "timestamp";

const MALFORMED_LEAF: Readonly<Record<LeafKind, readonly Json[]>> = {
	count: ["many", -1, 1.5, "1.5", {}, [], true],
	date: [
		42,
		"2020",
		[2020],
		true,
		{ month: 5 },
		{ year: "2020" },
		{ month: 13, year: 2020 },
		{ month: 0, year: 2020 },
		{ month: "5", year: 2020 },
		{ year: 2020.5 },
		{ year: 0 },
	],
	image: [
		42,
		"x",
		[],
		true,
		{ artifacts: 42 },
		{ artifacts: [42] },
		{ artifacts: [null] },
		{ artifacts: [{}] },
		{ artifacts: [{ fileIdentifyingUrlPathSegment: 42 }] },
		{ artifacts: [{ fileIdentifyingUrlPathSegment: "a.jpg" }], rootUrl: 42 },
		{
			artifacts: [{ fileIdentifyingUrlPathSegment: "a.jpg" }],
			rootUrl: "not a url ",
		},
	],
	required: [42, { v: 1 }, ["x"], true, null],
	text: [42, { v: 1 }, ["x"], true],
	timestamp: ["bad", 1e20, -5, {}, [], true],
};

/** Keys whose `null` is not an empty value: a collection or a wrapper the
 *  stream's enumeration depends on. */
const STRICT_CONTAINERS = new Set([
	"elements",
	"profileEducations",
	"profileLanguages",
	"profilePositionGroups",
	"profilePositionInPositionGroup",
	"skills",
]);

/** Malformed values for the container at `path`. */
function malformedContainer(path: Path): readonly Json[] {
	const last = path.at(-1) as string;
	const next = /^\d+$/u.test(last);
	// `{}` and an unknown-key-only object are records with no readable content.
	if (next) return [42, "x", [], true, null, {}, { unknownKey: 1 }];
	if (last === "elements" || last === "skills")
		return [42, "x", {}, true, null];
	if (last === "artifacts") return [42, "x", {}, true];
	return STRICT_CONTAINERS.has(last)
		? [42, "x", [], true, null]
		: [42, "x", [], true];
}

interface Source {
	kind: LeafKind;
	path: Path;
	root: Root;
}

interface FieldCase {
	/** Paths whose malformed value can also break this field, without
	 *  clearing anything (the current-position choice reads end dates). */
	dependencies?: readonly Source[];
	field: string;
	/** Container paths not to inject into, relative to the source root. */
	notContainers?: readonly Path[];
	rowId: string;
	sources: readonly Source[];
	stream: string;
}

const dash = (kind: LeafKind, ...path: string[]): Source => ({
	kind,
	path,
	root: "dash",
});
const me = (kind: LeafKind, ...path: string[]): Source => ({
	kind,
	path,
	root: "me",
});

const GROUP_1 = ["profilePositionGroups", "elements", "0"];
const POSITION_1 = [
	...GROUP_1,
	"profilePositionInPositionGroup",
	"elements",
	"0",
];
const GROUP_2 = ["profilePositionGroups", "elements", "1"];
const EDUCATION_1 = ["profileEducations", "elements", "0"];
const SKILL_1 = ["profileSkills", "elements", "0"];
const SKILL_2 = ["profileSkills", "elements", "1", "skills", "0"];
const LANGUAGE_1 = ["profileLanguages", "elements", "0"];

const DATE_PATHS: Readonly<Record<"start" | "end", readonly Path[]>> = {
	end: [
		["dateRange", "end"],
		["dateRange", "endDate"],
		["timePeriod", "end"],
		["timePeriod", "endDate"],
		["end"],
		["endDate"],
	],
	start: [
		["dateRange", "start"],
		["dateRange", "startDate"],
		["timePeriod", "start"],
		["timePeriod", "startDate"],
		["start"],
		["startDate"],
	],
};

function dateSources(row: Path, edge: "start" | "end"): Source[] {
	return DATE_PATHS[edge].map((path) => dash("date", ...row, ...path));
}

function textSources(row: Path, ...paths: Path[]): Source[] {
	return paths.map((path) => dash("text", ...row, ...path));
}

function rowCases(
	stream: string,
	rowId: string,
	fields: Record<string, Source[]>,
): FieldCase[] {
	return Object.entries(fields).map(([field, sources]) => ({
		field,
		rowId,
		sources,
		stream,
	}));
}

const FIELD_CASES: readonly FieldCase[] = [
	// profile
	{
		field: "full_name",
		rowId: "ada",
		sources: [
			dash("text", "firstName"),
			me("text", "miniProfile", "firstName"),
		],
		stream: "profile",
	},
	{
		field: "full_name",
		rowId: "ada",
		sources: [dash("text", "lastName"), me("text", "miniProfile", "lastName")],
		stream: "profile",
	},
	{
		field: "headline",
		rowId: "ada",
		sources: [
			dash("text", "headline"),
			me("text", "miniProfile", "occupation"),
		],
		stream: "profile",
	},
	{
		field: "summary",
		rowId: "ada",
		sources: [dash("text", "summary")],
		stream: "profile",
	},
	{
		field: "industry",
		rowId: "ada",
		sources: [dash("text", "industry", "name")],
		stream: "profile",
	},
	{
		field: "location",
		rowId: "ada",
		sources: [
			dash("text", "location", "preferredGeoPlace"),
			dash("text", "location", "basicLocation", "countryCode"),
			dash("text", "geoLocation", "geo", "defaultLocalizedName"),
		],
		stream: "profile",
	},
	{
		field: "profile_picture_url",
		rowId: "ada",
		sources: [
			dash("image", "profilePicture", "displayImageReference", "vectorImage"),
			me("image", "miniProfile", "picture", "com.linkedin.common.VectorImage"),
			me("image", "miniProfile", "picture"),
		],
		stream: "profile",
	},
	{
		dependencies: [...dateSources(GROUP_1, "end")],
		field: "current_company",
		rowId: "ada",
		sources: textSources(GROUP_1, ["company", "name"], ["name"]),
		stream: "profile",
	},
	{
		dependencies: [
			...dateSources(GROUP_1, "end"),
			...dateSources(POSITION_1, "end"),
		],
		field: "current_position_title",
		// The group's own title is only a fallback when the position has none.
		sources: [
			dash("text", ...POSITION_1, "title"),
			dash("text", ...GROUP_1, "title"),
		],
		rowId: "ada",
		stream: "profile",
	},
	// experience: a position inside a group, and a group without positions
	...rowCases("experience", "urn:pos:1", {
		company: [
			...textSources(POSITION_1, ["companyName"]),
			...textSources(GROUP_1, ["company", "name"], ["name"]),
		],
		description: textSources(POSITION_1, ["description"]),
		employment_type: textSources(POSITION_1, ["employmentType", "name"]),
		end_date: dateSources(POSITION_1, "end"),
		id: [dash("text", ...POSITION_1, "entityUrn")],
		location: textSources(POSITION_1, ["locationName"], ["geoLocationName"]),
		start_date: dateSources(POSITION_1, "start"),
		title: textSources(POSITION_1, ["title"]),
	}),
	...rowCases("experience", "urn:group:2", {
		company: textSources(GROUP_2, ["company", "name"], ["name"]),
		description: textSources(GROUP_2, ["description"]),
		end_date: dateSources(GROUP_2, "end"),
		id: [dash("text", ...GROUP_2, "entityUrn")],
		location: textSources(GROUP_2, ["locationName"], ["geoLocationName"]),
		start_date: dateSources(GROUP_2, "start"),
		title: textSources(GROUP_2, ["title"]),
	}),
	// education
	...rowCases("education", "urn:edu:1", {
		degree: textSources(EDUCATION_1, ["degreeName"]),
		end_date: dateSources(EDUCATION_1, "end"),
		field_of_study: textSources(EDUCATION_1, ["fieldOfStudy"]),
		grade: textSources(EDUCATION_1, ["grade"]),
		id: [dash("text", ...EDUCATION_1, "entityUrn")],
		logo_url: [
			dash("image", ...EDUCATION_1, "school", "logo", "vectorImage"),
			dash(
				"image",
				...EDUCATION_1,
				"school",
				"logo",
				"com.linkedin.common.VectorImage",
			),
			dash("image", ...EDUCATION_1, "schoolLogo", "vectorImage"),
		],
		school: textSources(EDUCATION_1, ["schoolName"], ["school", "name"]),
		start_date: dateSources(EDUCATION_1, "start"),
	}),
	// skills: a flat skill and a skill inside a category
	...[
		["urn:skill:1", SKILL_1],
		["urn:skill:2", SKILL_2],
	].flatMap(([rowId, row]) =>
		rowCases("skills", rowId as string, {
			endorsement_count: [
				dash("count", ...(row as Path), "endorsementCount"),
				dash("count", ...(row as Path), "endorsements"),
			],
			id: [dash("required", ...(row as Path), "entityUrn")],
			name: [dash("required", ...(row as Path), "name")],
		}),
	),
	// languages
	...rowCases("languages", "urn:lang:1", {
		id: [dash("required", ...LANGUAGE_1, "entityUrn")],
		name: [dash("required", ...LANGUAGE_1, "name")],
		proficiency: textSources(LANGUAGE_1, ["proficiency"]),
	}),
	// connections: the listed edge and its resolved member profile
	{
		field: "id",
		rowId: MEMBER,
		sources: [
			{
				kind: "required",
				path: ["elements", "0", "connectedMember"],
				root: "page",
			},
		],
		stream: "connections",
	},
	{
		field: "connected_at",
		rowId: MEMBER,
		sources: [
			{ kind: "timestamp", path: ["elements", "0", "createdAt"], root: "page" },
		],
		stream: "connections",
	},
	{
		field: "full_name",
		rowId: MEMBER,
		sources: [{ kind: "text", path: ["firstName"], root: "resolved" }],
		stream: "connections",
	},
	{
		field: "full_name",
		rowId: MEMBER,
		sources: [{ kind: "text", path: ["lastName"], root: "resolved" }],
		stream: "connections",
	},
	{
		field: "headline",
		rowId: MEMBER,
		sources: [
			{ kind: "text", path: ["headline"], root: "resolved" },
			{ kind: "text", path: ["occupation"], root: "resolved" },
		],
		stream: "connections",
	},
	{
		field: "profile_url",
		rowId: MEMBER,
		sources: [{ kind: "text", path: ["publicIdentifier"], root: "resolved" }],
		stream: "connections",
	},
];

interface Injection {
	clear: readonly Source[];
	label: string;
	root: Root;
	path: Path;
	value: Json;
}

/** Each malformed value at each source leaf and at every container on the
 *  way to it. The field's other sources are cleared, so no readable fallback
 *  can satisfy it. */
function injectionsFor(fieldCase: FieldCase): Injection[] {
	const injections: Injection[] = [];
	const seen = new Set<string>();
	const add = (injection: Injection) => {
		const key = `${injection.root}:${JSON.stringify(injection.path)}:${JSON.stringify(injection.value)}`;
		if (seen.has(key)) return;
		seen.add(key);
		injections.push(injection);
	};
	for (const source of fieldCase.sources) {
		const clear = fieldCase.sources.filter((other) => other !== source);
		for (const value of MALFORMED_LEAF[source.kind]) {
			add({
				clear,
				label: "leaf",
				path: source.path,
				root: source.root,
				value,
			});
		}
		for (let depth = 1; depth < source.path.length; depth += 1) {
			const container = source.path.slice(0, depth);
			for (const value of malformedContainer(container)) {
				add({
					clear,
					label: "container",
					path: container,
					root: source.root,
					value,
				});
			}
		}
	}
	for (const dependency of fieldCase.dependencies ?? []) {
		for (const value of MALFORMED_LEAF[dependency.kind]) {
			add({
				clear: [],
				label: "dependency",
				path: dependency.path,
				root: dependency.root,
				value,
			});
		}
	}
	return injections;
}

function fixtureWith(injection: Injection): Record<Root, Json> {
	const fixture = baseFixture();
	for (const source of injection.clear)
		deletePath(fixture[source.root], source.path);
	setPath(
		fixture[injection.root],
		injection.path,
		structuredClone(injection.value),
	);
	return fixture;
}

// ─── Control: the full fixture is complete ───────────────────────────────

test("contract control: every stream of the fully readable fixture is complete", async () => {
	const recording = await collect(routesFor(baseFixture()));
	for (const stream of ALL_STREAMS) {
		const outcome = outcomeOf(recording, stream);
		assert.equal(
			outcome.complete,
			true,
			`${stream}: ${JSON.stringify(outcome)}`,
		);
	}
	const [profile] = outcomeOf(recording, "profile").records;
	assert.deepEqual(profile, {
		connection_count: 1,
		current_company: "Analytical",
		current_position_title: "Engineer",
		full_name: "Ada Lovelace",
		headline: "Engineer",
		id: "ada",
		industry: "Computing",
		location: "London, GB",
		profile_picture_url: "https://media.example/dash.jpg",
		public_url: "https://www.linkedin.com/in/ada/",
		summary: "Writes programs.",
	});
	assert.deepEqual(
		outcomeOf(recording, "experience").records.map((r) => r.id),
		["urn:pos:1", "urn:group:2"],
	);
	assert.deepEqual(outcomeOf(recording, "connections").records, [
		{
			connected_at: "2023-11-14T22:13:20.000Z",
			full_name: "Charles Babbage",
			headline: "Inventor",
			id: MEMBER,
			profile_url: "https://www.linkedin.com/in/charles/",
		},
	]);
});

// ─── Property: every malformed mapped field blocks completeness ──────────

for (const fieldCase of FIELD_CASES) {
	const sourceNames = fieldCase.sources
		.map((source) => `${source.root}.${source.path.join(".")}`)
		.join(" | ");
	test(`contract: ${fieldCase.stream}.${fieldCase.field} from ${sourceNames} — malformed source never completes`, async () => {
		for (const injection of injectionsFor(fieldCase)) {
			const where = `${injection.label} ${injection.root}.${injection.path.join(".")} = ${JSON.stringify(injection.value)}`;
			let recording: Recording;
			try {
				recording = await collect(routesFor(fixtureWith(injection)));
			} catch (error) {
				assert.fail(`${where}: collect threw ${String(error)}`);
			}
			const outcome = outcomeOf(recording, fieldCase.stream);
			assert.equal(
				outcome.complete,
				false,
				`${where}: stream reported complete`,
			);
			assert.ok(outcome.gaps.length > 0, `${where}: no gap emitted`);
			// A Personal Server upsert replaces the whole record, so a row with
			// an unreadable field is withheld entirely, never emitted partial.
			const row = outcome.records.find(
				(record) => record.id === fieldCase.rowId,
			);
			assert.equal(
				row,
				undefined,
				`${where}: row with unreadable ${fieldCase.field} was emitted`,
			);
			assert.equal(outcome.rejected, 0, `${where}: a partial row was emitted`);
		}
	});
}

// ─── Property: valid empty values are values, and still complete ─────────

const EMPTY_VALUE_CASES: ReadonlyArray<{
	expected: Json;
	field: string;
	path: Path;
	root: Root;
	rowId: string;
	stream: string;
	value: Json;
}> = [
	{
		expected: "",
		field: "title",
		path: [...POSITION_1, "title"],
		root: "dash",
		rowId: "urn:pos:1",
		stream: "experience",
		value: "",
	},
	{
		expected: null,
		field: "description",
		path: [...POSITION_1, "description"],
		root: "dash",
		rowId: "urn:pos:1",
		stream: "experience",
		value: null,
	},
	{
		expected: "",
		field: "school",
		path: [...EDUCATION_1, "schoolName"],
		root: "dash",
		rowId: "urn:edu:1",
		stream: "education",
		value: "",
	},
	{
		expected: null,
		field: "grade",
		path: [...EDUCATION_1, "grade"],
		root: "dash",
		rowId: "urn:edu:1",
		stream: "education",
		value: null,
	},
	{
		expected: "",
		field: "name",
		path: [...SKILL_1, "name"],
		root: "dash",
		rowId: "urn:skill:1",
		stream: "skills",
		value: "",
	},
	{
		expected: "",
		field: "proficiency",
		path: [...LANGUAGE_1, "proficiency"],
		root: "dash",
		rowId: "urn:lang:1",
		stream: "languages",
		value: "",
	},
	{
		expected: "",
		field: "summary",
		path: ["summary"],
		root: "dash",
		rowId: "ada",
		stream: "profile",
		value: "",
	},
	{
		expected: null,
		field: "industry",
		path: ["industry"],
		root: "dash",
		rowId: "ada",
		stream: "profile",
		value: null,
	},
	{
		expected: "",
		field: "headline",
		path: ["headline"],
		root: "resolved",
		rowId: MEMBER,
		stream: "connections",
		value: "",
	},
	{
		expected: null,
		field: "connected_at",
		path: ["elements", "0", "createdAt"],
		root: "page",
		rowId: MEMBER,
		stream: "connections",
		value: 0,
	},
];

for (const emptyCase of EMPTY_VALUE_CASES) {
	test(`contract: ${emptyCase.stream}.${emptyCase.field} = ${JSON.stringify(emptyCase.value)} is a real value and stays complete`, async () => {
		const fixture = baseFixture();
		setPath(fixture[emptyCase.root], emptyCase.path, emptyCase.value);
		const outcome = outcomeOf(
			await collect(routesFor(fixture)),
			emptyCase.stream,
		);
		assert.equal(outcome.complete, true, JSON.stringify(outcome));
		const row = outcome.records.find((record) => record.id === emptyCase.rowId);
		assert.ok(row, "row emitted");
		assert.deepEqual(row[emptyCase.field], emptyCase.expected);
	});
}

// ─── Review regressions ──────────────────────────────────────────────────

function routesWithDash(
	dashElement: Json,
	overrides: Partial<Routes> = {},
): Routes {
	const fixture = baseFixture();
	fixture.dash = dashElement;
	return { ...routesFor(fixture), ...overrides };
}

const VERIFIED_EMPTY_CONNECTIONS: Routes["connections"] = (start) => ({
	elements: [],
	paging: { count: 40, start },
});

test("r1: a repeated connections page withholds coverage and connection_count", async () => {
	const members = Array.from({ length: 40 }, (_, index) => ({
		connectedMember: `urn:li:fsd_profile:a${index}`,
		createdAt: 1_700_000_000_000,
	}));
	const recording = await collect({
		...routesFor(baseFixture()),
		connections: (start) => ({
			elements: members,
			paging: { count: 40, start, total: 80 },
		}),
		resolve: (path) => ({
			results: Object.fromEntries(
				members
					.filter((member) =>
						path.includes(encodeURIComponent(member.connectedMember)),
					)
					.map((member) => [member.connectedMember, { firstName: "A" }]),
			),
		}),
	});
	assert.equal(outcomeOf(recording, "connections").complete, false);
	const profile = outcomeOf(recording, "profile");
	assert.equal(profile.complete, false);
	assertWithheld(profile, ["connection_count"]);
});

test("r1: a basic-fallback {} profile is never complete, and its sections are unavailable", async () => {
	const recording = await collect({
		...routesFor(baseFixture()),
		dash: (decoration) =>
			decoration === null ? { elements: [{}] } : { _error: "http_404" },
	});
	for (const stream of [
		"profile",
		"experience",
		"education",
		"skills",
		"languages",
	]) {
		assert.equal(outcomeOf(recording, stream).complete, false, stream);
	}
});

test("r1: an empty first decoration falls through to the next decoration", async () => {
	const fixture = baseFixture();
	const recording = await collect({
		...routesFor(fixture),
		dash: (decoration) =>
			decoration?.endsWith("-93")
				? { elements: [{}] }
				: { elements: [completeCollectionsForFixture(fixture.dash)] },
	});
	assert.equal(outcomeOf(recording, "profile").complete, true);
});

test("r1: primitive section rows and an unreadable nested collection are not covered", async () => {
	for (const dashElement of [
		{
			...(baseFixture().dash as object),
			profileEducations: { elements: [17] },
		},
		{
			...(baseFixture().dash as object),
			profilePositionGroups: { elements: [17] },
		},
		{
			...(baseFixture().dash as object),
			profilePositionGroups: {
				elements: [
					{
						company: { name: "A" },
						profilePositionInPositionGroup: { elements: {} },
					},
				],
			},
		},
	]) {
		const recording = await collect(routesWithDash(dashElement));
		assert.equal(
			outcomeOf(recording, "education").complete &&
				outcomeOf(recording, "experience").complete,
			false,
		);
	}
});

test("r1: resolver keeps source-backed blank names and rejects a numeric name", async () => {
	const fixture = baseFixture();
	fixture.resolved = { firstName: "", headline: "", lastName: "" };
	const blanks = outcomeOf(await collect(routesFor(fixture)), "connections");
	assert.equal(blanks.complete, true, JSON.stringify(blanks));
	assert.deepEqual(blanks.records[0], {
		connected_at: "2023-11-14T22:13:20.000Z",
		full_name: "",
		headline: "",
		id: MEMBER,
		profile_url: null,
	});

	fixture.resolved = { firstName: 123 };
	const numeric = outcomeOf(await collect(routesFor(fixture)), "connections");
	assert.equal(numeric.complete, false);
	assertWithheld(numeric, ["full_name"]);
});

test("r2: numeric title and object schoolName rows are not covered", async () => {
	const recording = await collect(
		routesWithDash({
			...(baseFixture().dash as object),
			profileEducations: {
				elements: [{ schoolName: { text: "Unreadable school" } }],
			},
			profilePositionGroups: { elements: [{ title: 42 }] },
		}),
	);
	assert.equal(outcomeOf(recording, "experience").complete, false);
	assert.equal(outcomeOf(recording, "education").complete, false);
});

test("r2: malformed current position and location keep the profile incomplete", async () => {
	const outcome = outcomeOf(
		await collect(
			routesWithDash({
				geoLocation: { geo: { defaultLocalizedName: 42 } },
				industry: null,
				profilePositionGroups: { elements: [{ title: 42 }] },
				summary: null,
			}),
		),
		"profile",
	);
	assert.equal(outcome.complete, false);
	assertWithheld(outcome, ["location", "current_position_title"]);
});

test("r2: a full 20-row page at a smaller reported count is not an end", async () => {
	const members = Array.from({ length: 20 }, (_, index) => ({
		connectedMember: `urn:li:fsd_profile:s${index}`,
		createdAt: 1_700_000_000_000,
	}));
	const recording = await collect({
		...routesFor(baseFixture()),
		connections: () => ({ elements: members, paging: { count: 20, start: 0 } }),
	});
	assert.equal(outcomeOf(recording, "connections").complete, false);
	assert.equal(outcomeOf(recording, "profile").complete, false);
});

test("r2: unreadable position containers do not throw and keep streams incomplete", async () => {
	for (const groups of [
		{ elements: {} },
		{
			elements: [
				{
					company: { name: "A" },
					profilePositionInPositionGroup: { elements: {} },
				},
			],
		},
	]) {
		const recording = await collect(
			routesWithDash({
				...(baseFixture().dash as object),
				profilePositionGroups: groups,
			}),
		);
		assert.equal(outcomeOf(recording, "profile").complete, false);
		assert.equal(outcomeOf(recording, "experience").complete, false);
		assert.equal(outcomeOf(recording, "skills").complete, true);
	}
});

test("r3: malformed name, headline and picture with no fallback keep the profile incomplete", async () => {
	const recording = await collect(
		{
			...routesWithDash({
				firstName: 42,
				headline: 42,
				industry: null,
				lastName: 42,
				location: null,
				profilePicture: 42,
				profilePositionGroups: { elements: [] },
				summary: null,
			}),
			connections: VERIFIED_EMPTY_CONNECTIONS,
			me: { publicIdentifier: "p" },
		},
		["profile", "connections"],
	);
	const profile = outcomeOf(recording, "profile");
	assert.equal(profile.complete, false);
	assertWithheld(profile, ["full_name", "headline", "profile_picture_url"]);
	assert.equal(outcomeOf(recording, "connections").complete, true);
});

test("r3: preferredGeoPlace without a country code is read, not dropped", async () => {
	const dashElement = baseFixture().dash as Record<string, unknown>;
	dashElement.location = { preferredGeoPlace: "Paris" };
	delete dashElement.geoLocation;
	const profile = outcomeOf(
		await collect(routesWithDash(dashElement)),
		"profile",
	);
	assert.equal(profile.records[0]?.location, "Paris");
	assert.equal(profile.complete, true);
});

test("r3: education rows with unreadable or missing logo content are not covered", async () => {
	for (const row of [
		{ schoolLogo: 42 },
		{ schoolLogo: { vectorImage: { artifacts: 42 } }, schoolName: "College" },
		{ school: {} },
	]) {
		const recording = await collect(
			routesWithDash({
				...(baseFixture().dash as object),
				profileEducations: { elements: [row] },
			}),
			["education"],
		);
		const outcome = outcomeOf(recording, "education");
		assert.equal(outcome.complete, false, JSON.stringify(row));
		assertWithheld(outcome, [], JSON.stringify(row));
	}
});

test("r3: an unreadable inline end date is never read as a current role", async () => {
	const recording = await collect(
		routesWithDash({
			...(baseFixture().dash as object),
			profilePositionGroups: {
				elements: [{ end: 42, start: { year: 2010 }, title: "Former role" }],
			},
		}),
	);
	const experience = outcomeOf(recording, "experience");
	assert.equal(experience.complete, false);
	assertWithheld(experience, ["end_date"]);
	assertWithheld(outcomeOf(recording, "profile"), ["current_position_title"]);
});

test("r3: unreadable education end points are never read as ongoing", async () => {
	for (const end of [
		{ year: "2020" },
		{ month: 5 },
		{ month: 13, year: 2020 },
	]) {
		const recording = await collect(
			routesWithDash({
				...(baseFixture().dash as object),
				profileEducations: {
					elements: [{ end, schoolName: "College", start: { year: 2010 } }],
				},
			}),
			["education"],
		);
		const outcome = outcomeOf(recording, "education");
		assert.equal(outcome.complete, false, JSON.stringify(end));
		assertWithheld(outcome, ["end_date"], JSON.stringify(end));
	}
});

test("r3: a malformed or out-of-range connection timestamp is reported, not erased or thrown", async () => {
	for (const createdAt of ["bad", 1e20]) {
		const fixture = baseFixture();
		setPath(fixture.page, ["elements", "0", "createdAt"], createdAt);
		const outcome = outcomeOf(
			await collect(routesFor(fixture), ["connections"]),
			"connections",
		);
		assert.equal(outcome.complete, false, String(createdAt));
		assertWithheld(outcome, ["connected_at"], String(createdAt));
	}
});

const CONTENTLESS_GROUPS: ReadonlyArray<readonly Json[]> = [
	[{}],
	[{ unknownKey: 1 }],
	[{ profilePositionInPositionGroup: { elements: [] } }],
	[{}, { company: { name: "Actual company" }, title: "Actual current role" }],
];

for (const streams of [["profile", "connections"], ALL_STREAMS]) {
	test(`r5: a contentless position group never proves empty current_* (${streams.join(",")})`, async () => {
		for (const groups of CONTENTLESS_GROUPS) {
			const fixture = baseFixture();
			setPath(fixture.dash, ["profilePositionGroups", "elements"], groups);
			const recording = await collect(routesFor(fixture), streams);
			const label = JSON.stringify(groups);
			// Every other profile field is readable: only current_* can fail.
			assertWithheld(
				outcomeOf(recording, "profile"),
				["current_company", "current_position_title"],
				label,
			);
			if (streams.includes("experience")) {
				assert.equal(outcomeOf(recording, "experience").complete, false, label);
			}
		}
	});
}

test("withholding: an uncovered row is withheld whole; its readable siblings are emitted and the stream stays partial", async () => {
	const fixture = baseFixture();
	const educations = (
		fixture.dash as { profileEducations: { elements: Json[] } }
	).profileEducations.elements;
	educations.push({ entityUrn: "urn:edu:2", grade: 42, schoolName: "Second" });
	const outcome = outcomeOf(
		await collect(routesFor(fixture), ["education"]),
		"education",
	);
	assert.deepEqual(
		outcome.records.map((record) => record.id),
		["urn:edu:1"],
	);
	assert.deepEqual(outcome.coverage, { considered: 2, covered: 1 });
	assert.equal(outcome.complete, false);
	const diagnostics = outcome.gaps[0]?.diagnostics as Record<string, unknown>;
	assert.deepEqual(diagnostics.unavailable_fields, { grade: { malformed: 1 } });
	assert.deepEqual(diagnostics.omitted_rows, { withheld_unreadable_fields: 1 });
});
