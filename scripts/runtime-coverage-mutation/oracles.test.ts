// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import {
	buildConnectionRow,
	buildEducationRows,
	buildExperienceRows,
	buildProfileRow,
} from "../../connectors/linkedin/parsers.ts";
import {
	fieldValue,
	type RowRead,
} from "../../packages/polyfill-connectors/src/field-reader.ts";
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

function assertUncoveredWithOmissions(
	row: RowRead,
	fields: readonly string[],
): void {
	assert.equal(row.covered, false, "malformed mapped values must be uncovered");
	if (!row.covered) {
		assert.deepEqual(
			row.omissions.map((omission) => omission.field),
			fields,
			"the malformed source value must identify its mapped omission",
		);
	}
}

function assertCovered(
	row: RowRead,
): asserts row is Extract<RowRead, { covered: true }> {
	assert.equal(row.covered, true, "the readable control row must be covered");
}

function readableProfileRow(
	profileOverrides: Record<string, unknown> = {},
	miniOverrides: Record<string, unknown> = {},
) {
	return buildProfileRow(
		"profile-key",
		{
			firstName: "First",
			lastName: "Last",
			headline: "Headline",
			location: { preferredGeoPlace: "Place" },
			profilePositionGroups: { elements: [] },
			...profileOverrides,
		},
		{ miniProfile: { occupation: "Occupation", ...miniOverrides } },
		fieldValue(0),
	);
}

async function fixtureWire(steps: unknown[]) {
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
	assertUncoveredWithOmissions(
		readableProfileRow({ firstName: 17, lastName: null }),
		["full_name"],
	);
});

test("profile malformed headline without occupation fallback identifies headline omission", () => {
	assertUncoveredWithOmissions(
		readableProfileRow({ headline: 17 }, { occupation: 23 }),
		["headline"],
	);
});

test("profile malformed picture alternatives identify profile_picture_url omission", () => {
	assertUncoveredWithOmissions(
		readableProfileRow(
			{ profilePicture: { displayImageReference: { vectorImage: 17 } } },
			{ picture: 23 },
		),
		["profile_picture_url"],
	);
});

test("profile malformed preferredGeoPlace without another location identifies location omission", () => {
	assertUncoveredWithOmissions(
		readableProfileRow({ location: { preferredGeoPlace: 17 } }),
		["location"],
	);
});

test("profile readable fields produce a covered mapped profile control", () => {
	const row = readableProfileRow();
	assertCovered(row);
	assert.deepEqual(
		[row.data.full_name, row.data.headline, row.data.location],
		["First Last", "Headline", "Place"],
	);
});

test("profile headline uses a readable occupation as a complete source fallback", () => {
	const row = readableProfileRow(
		{ headline: 17 },
		{ occupation: "Occupation fallback" },
	);
	assertCovered(row);
	assert.equal(row.data.headline, "Occupation fallback");
});

test("connection malformed first name component identifies full_name omission", () => {
	const row = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: 17, lastName: "Readable", publicIdentifier: "profile-key" },
	);
	assertUncoveredWithOmissions(row, ["full_name"]);
});

test("connection malformed last name component identifies full_name omission", () => {
	const row = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: "Readable", lastName: 17, publicIdentifier: "profile-key" },
	);
	assertUncoveredWithOmissions(row, ["full_name"]);
});

test("connection readable name components compose into one mapped full name", () => {
	const row = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: "First", lastName: "Last", publicIdentifier: "profile-key" },
	);
	assertCovered(row);
	assert.equal(row.data.full_name, "First Last");
});

test("experience bare start and explicit empty end preserve source precision", () => {
	const row = buildExperienceRows([
		{ title: "Role", start: { year: 2010, month: 4 }, end: null },
	])[0];
	assert.ok(row);
	assertCovered(row);
	assert.deepEqual([row.data.start_date, row.data.end_date], ["2010-04", null]);
});

test("experience malformed bare end identifies end_date omission", () => {
	const row = buildExperienceRows([
		{ title: "Role", start: { year: 2010 }, end: { year: "bad" } },
	])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["end_date"]);
});

test("education malformed bare end identifies end_date omission", () => {
	const row = buildEducationRows([
		{ schoolName: "School", start: { year: 2010 }, end: { year: "bad" } },
	])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["end_date"]);
});

test("experience month-only start identifies start_date omission", () => {
	const row = buildExperienceRows([
		{ title: "Role", startDate: { month: 4 } },
	])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["start_date"]);
});

test("experience invalid-month start identifies start_date omission", () => {
	const row = buildExperienceRows([
		{ title: "Role", startDate: { year: 2010, month: 13 } },
	])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["start_date"]);
});

test("experience absent and null end dates map to nullable ongoing controls", () => {
	const rows = buildExperienceRows([
		{ title: "Role", startDate: { year: 2010 } },
		{ title: "Role", startDate: { year: 2010 }, endDate: null },
	]);
	assert.equal(rows.length, 2);
	for (const row of rows) assertCovered(row);
	assert.deepEqual(
		rows.map((row) => [row.data.start_date, row.data.end_date]),
		[
			["2010", null],
			["2010", null],
		],
	);
});

test("profile malformed group end cannot produce a covered current role", () => {
	const row = buildProfileRow(
		"profile-key",
		{
			firstName: "First",
			lastName: "Last",
			headline: "Headline",
			location: { preferredGeoPlace: "Place" },
			profilePositionGroups: {
				elements: [
					{
						title: "Role",
						endDate: { year: "bad" },
						profilePositionInPositionGroup: { elements: [{ title: "Role" }] },
					},
				],
			},
		},
		{ miniProfile: { occupation: "Occupation" } },
		fieldValue(0),
	);
	assertUncoveredWithOmissions(row, [
		"current_company",
		"current_position_title",
	]);
});

test("education malformed schoolLogo identifies logo_url omission", () => {
	const row = buildEducationRows([{ schoolName: "School", schoolLogo: 17 }])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["logo_url"]);
});

test("education malformed schoolLogo artifacts identify logo_url omission", () => {
	const row = buildEducationRows([
		{ schoolName: "School", schoolLogo: { vectorImage: { artifacts: 17 } } },
	])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["logo_url"]);
});

test("education empty synthetic school identifies school omission", () => {
	const row = buildEducationRows([{ school: {} }])[0];
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["school"]);
});

test("connection malformed string timestamp identifies connected_at omission", () => {
	let row: ReturnType<typeof buildConnectionRow> | undefined;
	assert.doesNotThrow(() => {
		row = buildConnectionRow(
			{ connectedMember: "urn:li:fsd_profile:member-key", createdAt: "bad" },
			{ firstName: "Name", publicIdentifier: "profile-key" },
		);
	});
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["connected_at"]);
});

test("connection out-of-range numeric timestamp identifies connected_at omission without throwing", () => {
	let row: ReturnType<typeof buildConnectionRow> | undefined;
	assert.doesNotThrow(() => {
		row = buildConnectionRow(
			{ connectedMember: "urn:li:fsd_profile:member-key", createdAt: 1e20 },
			{ firstName: "Name", publicIdentifier: "profile-key" },
		);
	});
	assert.ok(row);
	assertUncoveredWithOmissions(row, ["connected_at"]);
});

test("connection zero timestamp maps to covered not-reported null", () => {
	const row = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key", createdAt: 0 },
		{ firstName: "Name", publicIdentifier: "profile-key" },
	);
	assertCovered(row);
	assert.equal(row.data.connected_at, null);
});

test("connection absent timestamp maps to covered not-reported null", () => {
	const row = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: "Name", publicIdentifier: "profile-key" },
	);
	assertCovered(row);
	assert.equal(row.data.connected_at, null);
});

test("connection readable timestamp maps to ISO-8601", () => {
	const row = buildConnectionRow(
		{
			connectedMember: "urn:li:fsd_profile:member-key",
			createdAt: 1_700_000_000_000,
		},
		{ firstName: "Name", publicIdentifier: "profile-key" },
	);
	assertCovered(row);
	assert.equal(row.data.connected_at, "2023-11-14T22:13:20.000Z");
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

test("stream integrity preserves unrelated checkpoints and clean stream checkpoints", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "row-key", "fields_unavailable");
	assert.equal(
		integrity.gate(STATE("other")).some((message) => message.type === "STATE"),
		true,
	);
	assertStateWithheld(integrity.gate(STATE("items")), "items");
	assert.equal(createStreamIntegrity().gate(STATE("items")).length, 1);
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
