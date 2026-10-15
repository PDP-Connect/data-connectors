// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type FieldRead,
	type RowRead,
	readField,
} from "../../packages/polyfill-connectors/src/field-reader.ts";
import {
	buildConnectionRow,
	buildEducationRows,
	buildExperienceRows,
	buildLanguageRows,
	buildProfileRow,
	buildSkillRows,
	endDateOf,
	locationOf,
	profileUrlFor,
	startDateOf,
	subEntityId,
	voyagerDatePoint,
	voyagerVectorImageUrl,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const read = <T>(value: T): FieldRead<T> => ({ kind: "read", value });
const EMPTY = { kind: "explicit_empty" } as const;

/** A covered row's data, validated against the stream's output schema. */
function coveredData(stream: string, row: RowRead | undefined) {
	assert.ok(row, "row exists");
	assert.equal(
		row.covered,
		true,
		row.covered ? "" : JSON.stringify(row.omissions),
	);
	const result = validateRecord(stream, row.data);
	assert.equal(result.ok, true, JSON.stringify(result));
	return row.data;
}

function omittedFields(row: RowRead | undefined): string[] {
	assert.ok(row, "row exists");
	assert.equal(row.covered, false, "row must be uncovered");
	return row.covered ? [] : row.omissions.map((o) => o.field);
}

const IMAGE = (root: string, segment: string) => ({
	artifacts: [{ fileIdentifyingUrlPathSegment: segment }],
	rootUrl: root,
});

// ─── Date points (D4) ───────────────────────────────────────────────────

test("date points: year + month -> YYYY-MM; year only -> YYYY; month padded", () => {
	assert.deepEqual(
		readField({ d: { year: 2021, month: 3 } }, "d", voyagerDatePoint),
		read("2021-03"),
	);
	assert.deepEqual(
		readField({ d: { year: 2021 } }, "d", voyagerDatePoint),
		read("2021"),
	);
});

test("date points: a point without a readable year, or with a bad month, is unreadable, not dropped", () => {
	for (const point of [
		{},
		{ year: "2021" },
		{ year: 2021, month: 13 },
		{ year: 2021, month: "3" },
		42,
	])
		assert.equal(
			readField({ d: point }, "d", voyagerDatePoint).kind,
			"unavailable",
			JSON.stringify(point),
		);
});

test("start/end dates: dash dateRange, legacy timePeriod, and inline shapes", () => {
	assert.deepEqual(
		startDateOf({ dateRange: { start: { year: 2019, month: 6 } } }),
		read("2019-06"),
	);
	assert.deepEqual(
		startDateOf({ timePeriod: { startDate: { year: 2015 } } }),
		read("2015"),
	);
	assert.deepEqual(startDateOf({ startDate: { year: 2012 } }), read("2012"));
	assert.deepEqual(
		endDateOf({ dateRange: { end: { year: 2022 } } }),
		read("2022"),
	);
});

test("end date absent means Present (empty); an unreadable inline date is not Present", () => {
	assert.deepEqual(endDateOf({ dateRange: { start: { year: 2021 } } }), EMPTY);
	assert.equal(endDateOf({ endDate: { year: "soon" } }).kind, "unavailable");
	assert.equal(endDateOf({ dateRange: 42 }).kind, "unavailable");
});

// ─── Images, ids, location ──────────────────────────────────────────────

test("vector image: largest artifact composed with rootUrl; empty artifacts is no image", () => {
	assert.deepEqual(
		readField(
			{
				i: {
					artifacts: [
						{ fileIdentifyingUrlPathSegment: "s.jpg" },
						{ fileIdentifyingUrlPathSegment: "l.jpg" },
					],
					rootUrl: "https://m.example/",
				},
			},
			"i",
			voyagerVectorImageUrl,
		),
		read("https://m.example/l.jpg"),
	);
	assert.deepEqual(
		readField({ i: { artifacts: [] } }, "i", voyagerVectorImageUrl),
		EMPTY,
	);
});

test("vector image: malformed artifacts or a non-URL composition are unreadable", () => {
	for (const image of [
		{ artifacts: 42 },
		{ artifacts: [{}] },
		IMAGE("", "relative.png"),
		{ artifacts: [{ fileIdentifyingUrlPathSegment: "x" }], rootUrl: 7 },
	])
		assert.equal(
			readField({ i: image }, "i", voyagerVectorImageUrl).kind,
			"unavailable",
			JSON.stringify(image),
		);
});

test("subEntityId: URN when present, positional only when the URN is omitted", () => {
	assert.deepEqual(
		subEntityId({ entityUrn: "urn:li:x:1" }, "edu", 0),
		read("urn:li:x:1"),
	);
	assert.deepEqual(subEntityId({}, "edu", 2), read("edu-2"));
	assert.equal(subEntityId({ entityUrn: 42 }, "edu", 0).kind, "unavailable");
});

test("profileUrlFor: builds the canonical public profile URL", () => {
	assert.equal(
		profileUrlFor("alexrivera"),
		"https://www.linkedin.com/in/alexrivera/",
	);
});

test("location: basicLocation country with place, then geo name, then a bare place", () => {
	assert.deepEqual(
		locationOf({
			location: {
				basicLocation: { countryCode: "us" },
				preferredGeoPlace: "SF Bay Area",
			},
		}),
		read("SF Bay Area, us"),
	);
	assert.deepEqual(
		locationOf({
			geoLocation: {
				geo: { defaultLocalizedName: "Austin, Texas, United States" },
			},
		}),
		read("Austin, Texas, United States"),
	);
	assert.deepEqual(
		locationOf({ location: { preferredGeoPlace: "Paris" } }),
		read("Paris"),
	);
	assert.deepEqual(
		locationOf({ location: { countryCode: "us", postalCode: "78701" } }),
		EMPTY,
	);
});

test("location: a malformed source with no readable alternative is unreadable", () => {
	assert.equal(
		locationOf({ location: { basicLocation: { countryCode: 1 } } }).kind,
		"unavailable",
	);
	assert.equal(locationOf({ geoLocation: { geo: 42 } }).kind, "unavailable");
});

// ─── Profile ────────────────────────────────────────────────────────────

const FULL_PROFILE = {
	firstName: "Alex",
	geoLocation: {
		geo: { defaultLocalizedName: "San Francisco, California, United States" },
	},
	headline: "Staff Engineer at Acme",
	industry: { name: "Software Development" },
	lastName: "Rivera",
	profilePositionGroups: {
		elements: [
			{
				company: { name: "Acme" },
				dateRange: { start: { month: 3, year: 2021 } },
				profilePositionInPositionGroup: {
					elements: [
						{
							companyName: "Acme",
							dateRange: { start: { month: 3, year: 2021 } },
							title: "Staff Engineer",
						},
					],
				},
			},
		],
	},
	summary: "Builds reliable data infrastructure.",
};
const NO_ROLES = { profilePositionGroups: { elements: [] } };

test("profile: maps core fields and derives the current role from the open-ended group", () => {
	const data = coveredData(
		"profile",
		buildProfileRow("alexrivera", FULL_PROFILE, {}, read(842)),
	);
	assert.deepEqual(data, {
		connection_count: 842,
		current_company: "Acme",
		current_position_title: "Staff Engineer",
		full_name: "Alex Rivera",
		headline: "Staff Engineer at Acme",
		id: "alexrivera",
		industry: "Software Development",
		location: "San Francisco, California, United States",
		profile_picture_url: null,
		public_url: "https://www.linkedin.com/in/alexrivera/",
		summary: "Builds reliable data infrastructure.",
	});
});

test("profile: optional fields Voyager omitted read as null; the headline falls back to /me occupation", () => {
	const data = coveredData(
		"profile",
		buildProfileRow(
			"alexrivera",
			NO_ROLES,
			{ miniProfile: { occupation: "Engineer at Acme" } },
			EMPTY,
		),
	);
	assert.equal(data.headline, "Engineer at Acme");
	assert.equal(data.industry, null);
	assert.equal(data.full_name, null);
	assert.equal(data.current_company, null);
});

test("profile: picture prefers the dash image, then /me's typed key, then /me's bare shape", () => {
	const dash = {
		...NO_ROLES,
		profilePicture: {
			displayImageReference: {
				vectorImage: IMAGE("https://m.example/dash/", "dash.jpg"),
			},
		},
	};
	const meBare = {
		miniProfile: { picture: IMAGE("https://m.example/me/", "me.jpg") },
	};
	const meTyped = {
		miniProfile: {
			picture: {
				"com.linkedin.common.VectorImage": IMAGE(
					"https://m.example/typed/",
					"t.jpg",
				),
			},
		},
	};
	assert.equal(
		coveredData("profile", buildProfileRow("a", dash, meBare, EMPTY))
			.profile_picture_url,
		"https://m.example/dash/dash.jpg",
	);
	assert.equal(
		coveredData("profile", buildProfileRow("a", NO_ROLES, meTyped, EMPTY))
			.profile_picture_url,
		"https://m.example/typed/t.jpg",
	);
	assert.equal(
		coveredData("profile", buildProfileRow("a", NO_ROLES, meBare, EMPTY))
			.profile_picture_url,
		"https://m.example/me/me.jpg",
	);
});

// Review counterexample (linkedin-port r3 #1): malformed mapped fields must
// not normalize into a covered profile.
test("profile: malformed name, headline, or picture makes the row uncovered", () => {
	const row = buildProfileRow(
		"p",
		{
			...NO_ROLES,
			firstName: 42,
			lastName: 42,
			headline: 42,
			profilePicture: 42,
			industry: null,
			location: null,
			summary: null,
		},
		{ publicIdentifier: "p" },
		read(0),
	);
	assert.deepEqual(omittedFields(row).sort(), [
		"full_name",
		"headline",
		"profile_picture_url",
	]);
});

test("profile: an unreadable roles list or connection count leaves the row uncovered", () => {
	assert.deepEqual(omittedFields(buildProfileRow("p", {}, {}, read(1))), [
		"current_company",
		"current_position_title",
	]);
	assert.deepEqual(
		omittedFields(
			buildProfileRow(
				"p",
				NO_ROLES,
				{},
				{ kind: "unavailable", reason: "connections walk failed" },
			),
		),
		["connection_count"],
	);
});

// ─── Experience (D3) ────────────────────────────────────────────────────

test("experience: a group with sub-positions expands 1:1", () => {
	const rows = buildExperienceRows([
		{
			company: { name: "Acme" },
			profilePositionInPositionGroup: {
				elements: [
					{
						companyName: "Acme",
						dateRange: { end: { year: 2022 }, start: { year: 2019 } },
						description: "Led backend team.",
						employmentType: { name: "Full-time" },
						title: "Senior Engineer",
					},
					{ dateRange: { start: { year: 2022 } }, title: "Staff Engineer" },
				],
			},
		},
	]);
	assert.equal(rows.length, 2);
	const first = coveredData("experience", rows[0]);
	assert.deepEqual(
		[
			first.title,
			first.start_date,
			first.end_date,
			first.employment_type,
			first.id,
		],
		["Senior Engineer", "2019", "2022", "Full-time", "exp-0-0"],
	);
	const second = coveredData("experience", rows[1]);
	assert.deepEqual(
		[second.company, second.end_date, second.employment_type],
		["Acme", null, null],
	);
});

test("experience: a group without sub-positions is one row", () => {
	const data = coveredData(
		"experience",
		buildExperienceRows([
			{
				dateRange: { start: { month: 1, year: 2018 } },
				locationName: "Remote",
				name: "SoloCo",
				title: "Founder",
			},
		])[0],
	);
	assert.deepEqual(
		[data.company, data.title, data.start_date, data.location, data.id],
		["SoloCo", "Founder", "2018-01", "Remote", "exp-group-0"],
	);
});

test("experience: rows with unreadable dates, unreadable positions, or no content are uncovered", () => {
	assert.deepEqual(
		omittedFields(
			buildExperienceRows([{ title: "CTO", startDate: { year: "2020" } }])[0],
		),
		["start_date"],
	);
	assert.deepEqual(
		omittedFields(
			buildExperienceRows([
				{ title: "CTO", profilePositionInPositionGroup: { elements: 42 } },
			])[0],
		),
		["positions"],
	);
	assert.deepEqual(omittedFields(buildExperienceRows([{}])[0]), [
		"title|company",
	]);
	assert.deepEqual(omittedFields(buildExperienceRows([42])[0]), [
		"id",
		"positions",
	]);
});

// ─── Education ──────────────────────────────────────────────────────────

test("education: maps school, degree, field, dates, grade and logo", () => {
	const data = coveredData(
		"education",
		buildEducationRows([
			{
				dateRange: { end: { year: 2017 }, start: { year: 2013 } },
				degreeName: "B.S.",
				fieldOfStudy: "Computer Science",
				grade: "3.9 GPA",
				school: {
					logo: { vectorImage: IMAGE("https://m.example/school/", "logo.png") },
				},
				schoolName: "State University",
			},
		])[0],
	);
	assert.deepEqual(data, {
		degree: "B.S.",
		end_date: "2017",
		field_of_study: "Computer Science",
		grade: "3.9 GPA",
		id: "edu-0",
		logo_url: "https://m.example/school/logo.png",
		school: "State University",
		start_date: "2013",
	});
});

test("education: logo falls back through the typed key, then schoolLogo; absent grade/logo read null", () => {
	const typed = buildEducationRows([
		{
			school: {
				logo: {
					"com.linkedin.common.VectorImage": IMAGE(
						"https://m.example/t/",
						"t.png",
					),
				},
			},
			schoolName: "T",
		},
	]);
	const legacy = buildEducationRows([
		{
			schoolLogo: { vectorImage: IMAGE("https://m.example/l/", "l.png") },
			schoolName: "L",
		},
	]);
	const bare = buildEducationRows([{ schoolName: "B" }]);
	assert.equal(
		coveredData("education", typed[0]).logo_url,
		"https://m.example/t/t.png",
	);
	assert.equal(
		coveredData("education", legacy[0]).logo_url,
		"https://m.example/l/l.png",
	);
	assert.deepEqual(
		[
			coveredData("education", bare[0]).grade,
			coveredData("education", bare[0]).logo_url,
		],
		[null, null],
	);
});

// Review counterexamples (linkedin-port r3 #2): unreadable logos and
// recognized-key-only objects must not become covered rows.
test("education: an unreadable logo or a row with no school is uncovered", () => {
	assert.deepEqual(
		omittedFields(buildEducationRows([{ schoolLogo: 42 }])[0]).sort(),
		["logo_url", "school"],
	);
	assert.deepEqual(
		omittedFields(
			buildEducationRows([
				{
					schoolName: "College",
					schoolLogo: { vectorImage: { artifacts: 42 } },
				},
			])[0],
		),
		["logo_url"],
	);
	assert.deepEqual(omittedFields(buildEducationRows([{ school: {} }])[0]), [
		"school",
	]);
});

// ─── Skills and languages ───────────────────────────────────────────────

test("skills: flat and categorized lists flatten to one row per skill", () => {
	const flat = buildSkillRows([
		{ endorsementCount: 12, name: "Distributed Systems" },
		{ endorsementCount: 0, name: "TypeScript" },
	]);
	assert.deepEqual(
		flat.map((r) => coveredData("skills", r).endorsement_count),
		[12, 0],
	);
	const categorized = buildSkillRows([
		{
			name: "Tools",
			skills: [{ endorsements: 5, name: "Kubernetes" }, { name: "Docker" }],
		},
	]);
	assert.deepEqual(
		categorized.map((r) => {
			const d = coveredData("skills", r);
			return [d.name, d.endorsement_count];
		}),
		[
			["Kubernetes", 5],
			["Docker", null],
		],
	);
});

test("skills: a skill with no readable name is an uncovered row, not a silently dropped one", () => {
	assert.deepEqual(
		omittedFields(buildSkillRows([{ endorsementCount: 3 }])[0]),
		["name"],
	);
	assert.deepEqual(
		omittedFields(buildSkillRows([{ name: "X", endorsementCount: "3" }])[0]),
		["endorsement_count"],
	);
});

test("languages: name and optional proficiency; a nameless language is uncovered", () => {
	const rows = buildLanguageRows([
		{ name: "Spanish", proficiency: "Professional working proficiency" },
		{ name: "French" },
		{ proficiency: "Native" },
	]);
	assert.equal(
		coveredData("languages", rows[0]).proficiency,
		"Professional working proficiency",
	);
	assert.equal(coveredData("languages", rows[1]).proficiency, null);
	assert.deepEqual(omittedFields(rows[2]), ["name"]);
});

// ─── Connections ────────────────────────────────────────────────────────

test("connections: a resolved member is a covered row", () => {
	const data = coveredData(
		"connections",
		buildConnectionRow(
			{
				connectedMember: "urn:li:fsd_profile:abc123",
				createdAt: 1_700_000_000_000,
			},
			{
				firstName: "Jamie",
				headline: "PM at Acme",
				lastName: "Lee",
				publicIdentifier: "jamielee",
			},
		),
	);
	assert.deepEqual(data, {
		connected_at: "2023-11-14T22:13:20.000Z",
		full_name: "Jamie Lee",
		headline: "PM at Acme",
		id: "urn:li:fsd_profile:abc123",
		profile_url: "https://www.linkedin.com/in/jamielee/",
	});
});

test("connections: createdAt 0 or absent reads as not reported, never the epoch", () => {
	const resolved = { firstName: "J", publicIdentifier: "j" };
	assert.equal(
		coveredData(
			"connections",
			buildConnectionRow({ connectedMember: "urn:a", createdAt: 0 }, resolved),
		).connected_at,
		null,
	);
	assert.equal(
		coveredData(
			"connections",
			buildConnectionRow({ connectedMember: "urn:a" }, resolved),
		).connected_at,
		null,
	);
});

// Review counterexample (linkedin-port r3 connection timestamps) and the
// formerly "null enrichment" path: neither may overwrite a stored row.
test("connections: an unresolved member, a bad timestamp, or no member URN is uncovered", () => {
	assert.deepEqual(
		omittedFields(
			buildConnectionRow({ connectedMember: "urn:x" }, undefined),
		).sort(),
		["full_name|profile_url", "profile"],
	);
	assert.deepEqual(
		omittedFields(
			buildConnectionRow(
				{ connectedMember: "urn:x", createdAt: -5 },
				{ firstName: "J" },
			),
		),
		["connected_at"],
	);
	assert.deepEqual(
		omittedFields(
			buildConnectionRow(
				{ connectedMember: "urn:x", createdAt: "1700000000000" },
				{ firstName: "J" },
			),
		),
		["connected_at"],
	);
	assert.deepEqual(omittedFields(buildConnectionRow({}, { firstName: "J" })), [
		"id",
	]);
});
