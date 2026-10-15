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
	startDateOf,
	voyagerDatePoint,
} from "../../connectors/linkedin/parsers.ts";
import {
	fieldValue,
	readField,
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

const skip = (
	stream: string,
	recovery_hint: { action: string; retryable?: boolean },
): EmittedMessage => ({
	type: "SKIP_RESULT",
	stream,
	reason: "source_unreadable",
	message: "A source segment could not be read.",
	recovery_hint,
});

function assertUncovered(row: { covered: boolean }): void {
	assert.equal(
		row.covered,
		false,
		"malformed mapped fields must leave the row uncovered",
	);
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
		"a stream with an undeclared loss must not advance its checkpoint",
	);
}

test("LinkedIn bare experience and education dates cannot produce covered rows", () => {
	const experience = buildExperienceRows([
		{
			profilePositionInPositionGroup: {
				elements: [{ title: "Role", start: { year: 2010 }, end: 2020 }],
			},
		},
	]);
	const education = buildEducationRows([
		{ schoolName: "School", start: { year: 2010 }, end: { year: "bad" } },
	]);
	assert.deepEqual(
		[experience[0]?.covered ?? true, education[0]?.covered ?? true],
		[false, false],
		"both bare date shapes must leave malformed rows uncovered",
	);
});

test("LinkedIn date points reject month-only and invalid-month source values", () => {
	assert.equal(
		readField({ startDate: { month: 4 } }, "startDate", voyagerDatePoint).kind,
		"unavailable",
	);
	assert.equal(
		startDateOf({ startDate: { year: 2010, month: 13 } }).kind,
		"unavailable",
	);
});

test("LinkedIn absent and explicit-null end dates remain valid sparse ongoing-role controls", () => {
	const rows = buildExperienceRows([
		{ title: "Role", startDate: { year: 2010 } },
		{ title: "Role", startDate: { year: 2010 }, endDate: null },
	]);
	assert.equal(rows.length, 2);
	assert.equal(
		rows.every((row) => row.covered),
		true,
	);
});

test("LinkedIn an unreadable group end date cannot become the profile current role", () => {
	const row = buildProfileRow(
		"profile-key",
		{
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
		{ miniProfile: {} },
		fieldValue(0),
	);
	assertUncovered(row);
});

test("LinkedIn malformed profile name, headline, picture, and selected location cannot form a covered row", () => {
	const row = buildProfileRow(
		"profile-key",
		{
			firstName: 17,
			lastName: 23,
			headline: 9,
			location: { preferredGeoPlace: 11 },
			profilePositionGroups: { elements: [] },
			profilePicture: { displayImageReference: { vectorImage: 7 } },
		},
		{
			miniProfile: { occupation: 13, picture: 5 },
		},
		fieldValue(0),
	);
	assertUncovered(row);
});

test("LinkedIn mixed malformed name components stay unavailable in both component orders", () => {
	const malformedFirst = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: 17, lastName: "Readable", publicIdentifier: "profile-key" },
	);
	const malformedLast = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		{ firstName: "Readable", lastName: 17, publicIdentifier: "profile-key" },
	);
	assert.deepEqual(
		[malformedFirst.covered, malformedLast.covered],
		[false, false],
		"both malformed-name component orders must leave the row uncovered",
	);
});

test("LinkedIn malformed education logos and empty synthetic school rows are uncovered", () => {
	const rows = buildEducationRows([
		{ schoolName: "School", schoolLogo: 17 },
		{ schoolName: "School", schoolLogo: { vectorImage: { artifacts: 17 } } },
		{ school: {} },
	]);
	assert.equal(rows.length, 3);
	assert.equal(
		rows.every((row) => !row.covered),
		true,
	);
});

test("LinkedIn malformed connection timestamps are uncovered without throwing", () => {
	for (const createdAt of ["bad", 1e20]) {
		let row: ReturnType<typeof buildConnectionRow> | undefined;
		assert.doesNotThrow(() => {
			row = buildConnectionRow(
				{ connectedMember: "urn:li:fsd_profile:member-key", createdAt },
				{ firstName: "Name", publicIdentifier: "profile-key" },
			);
		});
		assertUncovered(row ?? { covered: true });
	}
});

test("LinkedIn zero and absent connection timestamps remain covered not-reported controls", () => {
	const resolved = { firstName: "Name", publicIdentifier: "profile-key" };
	const zero = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key", createdAt: 0 },
		resolved,
	);
	const absent = buildConnectionRow(
		{ connectedMember: "urn:li:fsd_profile:member-key" },
		resolved,
	);
	assert.equal(zero.covered, true);
	assert.equal(absent.covered, true);
});

test("stream integrity withholds checkpoints after undeclared retryable and non-retryable skips", () => {
	const states = [false, true].map((retryable) => {
		const integrity = createStreamIntegrity();
		integrity.gate(skip("items", { action: "retry_by_runtime", retryable }));
		return integrity
			.gate(STATE("items"))
			.some((message) => message.type === "STATE");
	});
	assert.equal(
		states.every((stateEmitted) => !stateEmitted),
		true,
		"both undeclared skip forms must withhold the checkpoint",
	);
});

test("stream integrity keeps clean and unrelated stream checkpoints independent", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "row-key", "fields_unavailable");
	const other = integrity.gate(STATE("other"));
	assert.equal(
		other.some(
			(message) => message.type === "STATE" && message.stream === "other",
		),
		true,
	);
	const clean = createStreamIntegrity().gate(STATE("items"));
	assert.equal(
		clean.some((message) => message.type === "STATE"),
		true,
	);
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

test("stream integrity passes a clean stream checkpoint", () => {
	const integrity = createStreamIntegrity();
	const messages = integrity.gate(STATE("items"));
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.type, "STATE");
});

test("runtime withholds a partially readable RECORD, its checkpoint, and its hydrated key", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL(
				"../../packages/polyfill-connectors/src/__fixtures__/stream-integrity-connector.ts",
				import.meta.url,
			),
		),
		env: {
			PDPP_TEST_STEPS: JSON.stringify([
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
			]),
		},
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});
	const messages = result.messages.filter(
		(message) => message.type !== "PROGRESS",
	);
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
