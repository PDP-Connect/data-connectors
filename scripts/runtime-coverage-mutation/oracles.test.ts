// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { StreamRows } from "../../connectors/linkedin/field-read.ts";
import { read } from "../../connectors/linkedin/field-read.ts";
import {
	buildConnectionRows,
	buildEducationRows,
	buildExperienceRows,
	buildProfileRows,
	type ProfileSources,
} from "../../connectors/linkedin/parsers.ts";
import {
	createStreamIntegrity,
	FIELDS_UNAVAILABLE_REASON,
} from "../../packages/polyfill-connectors/src/stream-integrity.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

const STATE = (stream: string): EmittedMessage => ({
	type: "STATE",
	stream,
	cursor: { complete: true },
});

const skip = (stream: string, retryable: boolean): EmittedMessage => ({
	type: "SKIP_RESULT",
	stream,
	reason: "source_unreadable",
	message: "A source segment could not be read.",
	recovery_hint: { action: "retry_by_runtime", retryable },
});

function assertCovered<T>(rows: StreamRows<T>, count = 1): void {
	assert.equal(rows.considered, count);
	assert.equal(rows.covered, count);
	assert.equal(rows.records.length, count);
	assert.deepEqual(rows.omittedRows, {});
	assert.deepEqual(rows.unavailableFields, {});
}

function assertWithheld<T>(
	rows: StreamRows<T>,
	fields: Readonly<Record<string, string>>,
): void {
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 0);
	assert.deepEqual(rows.records, []);
	assert.deepEqual(rows.omittedRows, { withheld_unreadable_fields: 1 });
	assert.deepEqual(
		rows.unavailableFields,
		Object.fromEntries(
			Object.entries(fields).map(([field, reason]) => [field, { [reason]: 1 }]),
		),
	);
}

function assertOmitted<T>(rows: StreamRows<T>, reason: string): void {
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 0);
	assert.deepEqual(rows.records, []);
	assert.deepEqual(rows.omittedRows, { [reason]: 1 });
	assert.deepEqual(rows.unavailableFields, {});
}

function completeProfileSources(
	dashOverrides: Record<string, unknown> = {},
	miniProfileOverrides: Record<string, unknown> = {},
): ProfileSources {
	return {
		connectionCount: read(0),
		dash: {
			firstName: "First",
			headline: "Headline",
			industry: null,
			lastName: "Last",
			location: { preferredGeoPlace: "Place" },
			profilePositionGroups: {
				elements: [],
				paging: { start: 0, total: 0 },
			},
			summary: null,
			...dashOverrides,
		},
		dashSource: "decoration",
		me: { miniProfile: { occupation: "Occupation", ...miniProfileOverrides } },
		publicIdentifier: "profile-key",
	};
}

function sparseProfileSources(): ProfileSources {
	return {
		connectionCount: read(0),
		dash: {
			firstName: "First",
			headline: "Headline",
			lastName: "Last",
			location: { preferredGeoPlace: "Place" },
			profilePositionGroups: { elements: [] },
		},
		dashSource: "decoration",
		me: { miniProfile: { occupation: "Occupation" } },
		publicIdentifier: "profile-key",
	};
}

async function fixtureWire(steps: unknown[]): Promise<EmittedMessage[]> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL(
				"../../packages/polyfill-connectors/src/__fixtures__/stream-integrity-connector.ts",
				import.meta.url,
			),
		),
		env: { PDPP_TEST_STEPS: JSON.stringify(steps) },
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});
	return result.messages.filter((message) => message.type !== "PROGRESS");
}

function assertStateWithheld(
	messages: readonly EmittedMessage[],
	stream: string,
): void {
	assert.equal(
		messages.some(
			(message) => message.type === "STATE" && message.stream === stream,
		),
		false,
		"a stream with undeclared loss must not advance its checkpoint",
	);
}

test("profile malformed full name identifies only full_name omission", () => {
	assertWithheld(
		buildProfileRows(completeProfileSources({ firstName: 17, lastName: null })),
		{ full_name: "malformed" },
	);
});

test("profile malformed headline without occupation fallback identifies headline omission", () => {
	assertWithheld(
		buildProfileRows(
			completeProfileSources({ headline: 17 }, { occupation: 23 }),
		),
		{ headline: "malformed" },
	);
});

test("profile malformed picture alternatives identify profile_picture_url omission", () => {
	assertWithheld(
		buildProfileRows(
			completeProfileSources(
				{ profilePicture: { displayImageReference: { vectorImage: 17 } } },
				{ picture: 23 },
			),
		),
		{ profile_picture_url: "malformed" },
	);
});

test("profile malformed preferredGeoPlace without another location identifies location omission", () => {
	assertWithheld(
		buildProfileRows(
			completeProfileSources({ location: { preferredGeoPlace: 17 } }),
		),
		{ location: "malformed" },
	);
});

test("profile complete explicit-empty fields and verified empty roles emit a covered record", () => {
	const rows = buildProfileRows(completeProfileSources());
	assertCovered(rows);
	const profile = rows.records[0];
	assert.ok(profile);
	assert.deepEqual(
		[
			profile.full_name,
			profile.headline,
			profile.location,
			profile.industry,
			profile.summary,
			profile.current_company,
			profile.current_position_title,
		],
		["First Last", "Headline", "Place", null, null, null, null],
	);
});

test("profile readable occupation is a complete headline fallback", () => {
	const rows = buildProfileRows(
		completeProfileSources(
			{ headline: 17 },
			{ occupation: "Occupation fallback" },
		),
	);
	assertCovered(rows);
	assert.equal(rows.records[0]?.headline, "Occupation fallback");
});

test("profile preserves blank industry and summary as readable values", () => {
	const rows = buildProfileRows(
		completeProfileSources({ industry: { name: "" }, summary: "" }),
	);
	assertCovered(rows);
	assert.deepEqual(
		[rows.records[0]?.industry, rows.records[0]?.summary],
		["", ""],
	);
});

test("profile sparse optional fields and unverified roles remain unavailable", () => {
	assertWithheld(buildProfileRows(sparseProfileSources()), {
		current_company: "walk_unverified",
		current_position_title: "walk_unverified",
		industry: "absent",
		summary: "absent",
	});
});

test("profile contradictory role paging does not prove an empty role set", () => {
	assertWithheld(
		buildProfileRows(
			completeProfileSources({
				profilePositionGroups: {
					elements: [],
					paging: { start: 0, total: 1 },
				},
			}),
		),
		{
			current_company: "walk_unverified",
			current_position_title: "walk_unverified",
		},
	);
});

test("profile basic source cannot supply decoration-only fields", () => {
	const sources = completeProfileSources({
		industry: { name: "Incidental" },
		summary: "Incidental",
	});
	assertWithheld(buildProfileRows({ ...sources, dashSource: "basic" }), {
		current_company: "source_unavailable",
		current_position_title: "source_unavailable",
		industry: "source_unavailable",
		location: "source_unavailable",
		summary: "source_unavailable",
	});
});

test("profile complete nonempty role walk derives a readable current role", () => {
	const rows = buildProfileRows(
		completeProfileSources({
			profilePositionGroups: {
				elements: [
					{
						company: { name: "Company" },
						profilePositionInPositionGroup: {
							elements: [{ start: { year: 2020 }, title: "Current role" }],
							paging: { start: 0, total: 1 },
						},
					},
				],
				paging: { start: 0, total: 1 },
			},
		}),
	);
	assertCovered(rows);
	assert.deepEqual(
		[rows.records[0]?.current_company, rows.records[0]?.current_position_title],
		["Company", "Current role"],
	);
});

test("profile malformed group end cannot become a current role", () => {
	assertWithheld(
		buildProfileRows(
			completeProfileSources({
				profilePositionGroups: {
					elements: [
						{
							company: { name: "Company" },
							end: { year: "bad" },
							profilePositionInPositionGroup: {
								elements: [{ start: { year: 2020 }, title: "Former role" }],
								paging: { start: 0, total: 1 },
							},
						},
					],
					paging: { start: 0, total: 1 },
				},
			}),
		),
		{
			current_company: "malformed",
			current_position_title: "malformed",
		},
	);
});

const MEMBER_URN = "urn:li:fsd_profile:member-key";

function connectionRows(
	createdAt: unknown,
	resolved: Record<string, unknown>,
): StreamRows {
	return buildConnectionRows(
		[
			{
				connectedMember: MEMBER_URN,
				...(createdAt === undefined ? {} : { createdAt }),
			},
		],
		() => resolved,
	);
}

const resolvedName = { firstName: "Name", publicIdentifier: "profile-key" };

test("connection malformed first name component identifies full_name omission", () => {
	assertWithheld(
		connectionRows(undefined, {
			firstName: 17,
			lastName: "Readable",
			publicIdentifier: "profile-key",
		}),
		{ full_name: "malformed" },
	);
});

test("connection malformed last name component identifies full_name omission", () => {
	assertWithheld(
		connectionRows(undefined, {
			firstName: "Readable",
			lastName: 17,
			publicIdentifier: "profile-key",
		}),
		{ full_name: "malformed" },
	);
});

test("connection readable name components compose into one mapped full name", () => {
	const rows = connectionRows(undefined, {
		firstName: "First",
		lastName: "Last",
		publicIdentifier: "profile-key",
	});
	assertCovered(rows);
	assert.equal(rows.records[0]?.full_name, "First Last");
});

test("connection source-backed blank name remains a readable blank", () => {
	const rows = connectionRows(undefined, {
		firstName: " ",
		lastName: "",
		publicIdentifier: "profile-key",
	});
	assertCovered(rows);
	assert.equal(rows.records[0]?.full_name, "");
});

test("experience bare start retains source precision and explicit null end", () => {
	const rows = buildExperienceRows([
		{ title: "Role", start: { year: 2010, month: 4 }, end: null },
	]);
	assertCovered(rows);
	assert.deepEqual(
		[rows.records[0]?.start_date, rows.records[0]?.end_date],
		["2010-04", null],
	);
});

test("experience malformed bare end identifies end_date omission", () => {
	assertWithheld(
		buildExperienceRows([
			{ title: "Role", start: { year: 2010 }, end: { year: "bad" } },
		]),
		{ end_date: "malformed" },
	);
});

test("education malformed bare end identifies end_date omission", () => {
	assertWithheld(
		buildEducationRows([
			{ schoolName: "School", start: { year: 2010 }, end: { year: "bad" } },
		]),
		{ end_date: "malformed" },
	);
});

test("experience month-only start identifies start_date omission", () => {
	assertWithheld(
		buildExperienceRows([{ title: "Role", startDate: { month: 4 } }]),
		{ start_date: "malformed" },
	);
});

test("experience invalid-month start identifies start_date omission", () => {
	assertWithheld(
		buildExperienceRows([
			{ title: "Role", startDate: { year: 2010, month: 13 } },
		]),
		{ start_date: "malformed" },
	);
});

test("experience absent and null end map to nullable ongoing controls", () => {
	const rows = buildExperienceRows([
		{ title: "Role", startDate: { year: 2010 } },
		{ title: "Role", startDate: { year: 2010 }, endDate: null },
	]);
	assertCovered(rows, 2);
	assert.deepEqual(
		rows.records.map((row) => [row.start_date, row.end_date]),
		[
			["2010", null],
			["2010", null],
		],
	);
});

test("education malformed schoolLogo identifies logo_url omission", () => {
	assertWithheld(
		buildEducationRows([{ schoolName: "School", schoolLogo: 17 }]),
		{ logo_url: "malformed" },
	);
});

test("education malformed schoolLogo artifacts identify logo_url omission", () => {
	assertWithheld(
		buildEducationRows([
			{ schoolName: "School", schoolLogo: { vectorImage: { artifacts: 17 } } },
		]),
		{ logo_url: "malformed" },
	);
});

test("education empty synthetic school is omitted for no readable content", () => {
	assertOmitted(buildEducationRows([{ school: {} }]), "no_readable_content");
});

test("education malformed school with readable degree identifies school omission", () => {
	assertWithheld(
		buildEducationRows([{ degreeName: "Degree", school: { name: 17 } }]),
		{ school: "malformed" },
	);
});

test("connection malformed string timestamp identifies connected_at omission", () => {
	assertWithheld(connectionRows("bad", resolvedName), {
		connected_at: "malformed",
	});
});

test("connection out-of-range numeric timestamp identifies connected_at omission without throwing", () => {
	assertWithheld(connectionRows(1e20, resolvedName), {
		connected_at: "malformed",
	});
});

test("connection zero timestamp emits covered not-reported null", () => {
	const rows = connectionRows(0, resolvedName);
	assertCovered(rows);
	assert.equal(rows.records[0]?.connected_at, null);
});

test("connection absent timestamp emits covered not-reported null", () => {
	const rows = buildConnectionRows(
		[{ connectedMember: MEMBER_URN }],
		() => resolvedName,
	);
	assertCovered(rows);
	assert.equal(rows.records[0]?.connected_at, null);
});

test("connection readable timestamp maps to ISO-8601", () => {
	const rows = connectionRows(1_700_000_000_000, resolvedName);
	assertCovered(rows);
	assert.equal(rows.records[0]?.connected_at, "2023-11-14T22:13:20.000Z");
});

test("stream integrity withholds checkpoint after non-retryable source unreadable skip", () => {
	const integrity = createStreamIntegrity();
	integrity.gate(skip("items", false));
	assertStateWithheld(integrity.gate(STATE("items")), "items");
});

test("stream integrity withholds checkpoint after undeclared retryable source unreadable skip", () => {
	const integrity = createStreamIntegrity();
	integrity.gate(skip("items", true));
	assertStateWithheld(integrity.gate(STATE("items")), "items");
});

test("stream integrity preserves unrelated checkpoints and clean checkpoints", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "row-key", "fields_unavailable");
	assert.equal(
		integrity.gate(STATE("other")).some((message) => message.type === "STATE"),
		true,
	);
	assertStateWithheld(integrity.gate(STATE("items")), "items");
	assert.deepEqual(createStreamIntegrity().gate(STATE("items")), [
		STATE("items"),
	]);
});

test("stream integrity cannot exempt a refused record through skip metadata", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "row-key", "fields_unavailable");
	integrity.gate({
		type: "SKIP_RESULT",
		stream: "items",
		reason: FIELDS_UNAVAILABLE_REASON,
		message: "A mapped record field could not be read.",
		recovery_hint: { action: "retry_by_runtime", retryable: false },
		continuation: {
			boundary: "page-budget",
			considered: 1,
			covered: 1,
			owner: "runtime",
			remaining: true,
			slice_end: 1,
			slice_start: 0,
		},
	});
	assertStateWithheld(integrity.gate(STATE("items")), "items");
});

test("runtime withholds a partially readable RECORD, checkpoint, and hydrated key", async () => {
	const messages = await fixtureWire([
		{
			op: "record",
			stream: "items",
			data: { id: "row-key", title: null },
			omissions: [
				{ field: "title", reason: "mapped source value is unreadable" },
			],
		},
		{ op: "emit", msg: STATE("items") },
		{
			op: "emit",
			msg: {
				type: "DETAIL_COVERAGE",
				reference_only: true,
				stream: "items",
				state_stream: "items",
				required_keys: ["row-key"],
				hydrated_keys: ["row-key"],
			},
		},
	]);
	assert.equal(
		messages.some((message) => message.type === "RECORD"),
		false,
	);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		false,
	);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === FIELDS_UNAVAILABLE_REASON,
		),
		true,
	);
	const coverage = messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.deepEqual(
		[coverage.required_keys, coverage.hydrated_keys],
		[["row-key"], []],
	);
});

test("runtime emits a valid nullable RECORD and its clean checkpoint", async () => {
	const messages = await fixtureWire([
		{ op: "record", stream: "items", data: { id: "test-key", title: null } },
		{ op: "emit", msg: STATE("items") },
	]);
	const record = messages.find((message) => message.type === "RECORD");
	assert.ok(record?.type === "RECORD");
	assert.equal(record.data.title, null);
	assert.equal(
		messages.some((message) => message.type === "STATE"),
		true,
	);
});
