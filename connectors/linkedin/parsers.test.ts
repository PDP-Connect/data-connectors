// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addRow,
	assembleRow,
	at,
	EMPTY,
	emptyStreamRows,
	epochMillis,
	type FieldRead,
	firstOf,
	partialDate,
	read,
	unavailable,
	vectorImageUrl,
} from "./field-read.ts";
import {
	buildConnectionRows,
	buildEducationRows,
	buildExperienceRows,
	buildLanguageRows,
	buildProfileRows,
	buildSkillRows,
	collectionAt,
	dateOf,
	type ProfileSources,
	profileFieldReads,
	profileUrlFor,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const readValue = <T>(outcome: FieldRead<T>): T | undefined =>
	outcome.kind === "read" ? outcome.value : undefined;

// ─── The reading contract ────────────────────────────────────────────────

test("at: absent key, explicit null, and wrong container type are distinct", () => {
	assert.deepEqual(at({ a: { b: "x" } }, ["a", "b"]), read("x"));
	assert.deepEqual(at({ a: {} }, ["a", "b"]), unavailable("absent"));
	assert.deepEqual(at({ a: null }, ["a", "b"]), EMPTY);
	assert.deepEqual(at({ a: 42 }, ["a", "b"]), unavailable("malformed"));
	assert.deepEqual(at({ a: ["b"] }, ["a", "b"]), unavailable("malformed"));
});

test("firstOf: first read wins; a malformed source without a read is unavailable", () => {
	assert.deepEqual(
		firstOf([unavailable("malformed"), read("fallback")], "empty"),
		read("fallback"),
	);
	assert.deepEqual(
		firstOf([unavailable("malformed"), EMPTY], "empty"),
		unavailable("malformed"),
	);
	assert.deepEqual(
		firstOf([unavailable("absent"), EMPTY], "unavailable"),
		EMPTY,
	);
	assert.deepEqual(
		firstOf([unavailable("absent")], "unavailable"),
		unavailable("absent"),
	);
	assert.deepEqual(firstOf([unavailable("absent")], "empty"), EMPTY);
});

test("collectionAt requires a verified first-page end and rejects contradictory paging", () => {
	assert.deepEqual(
		collectionAt({ skills: { elements: [] } }, "skills"),
		unavailable("walk_unverified"),
	);
	assert.deepEqual(
		collectionAt({ skills: { elements: [], paging: null } }, "skills"),
		unavailable("malformed"),
	);
	assert.deepEqual(
		collectionAt({ skills: { elements: [], paging: { start: 0 } } }, "skills"),
		unavailable("walk_unverified"),
	);
	assert.deepEqual(
		collectionAt(
			{ skills: { elements: [], paging: { start: 1, total: 1 } } },
			"skills",
		),
		unavailable("walk_unverified"),
	);
	assert.deepEqual(
		collectionAt(
			{ skills: { elements: ["one"], paging: { start: 0, total: 2 } } },
			"skills",
		),
		unavailable("walk_unverified"),
	);
	assert.deepEqual(
		collectionAt(
			{ skills: { elements: ["one"], paging: { start: 0, total: 0 } } },
			"skills",
		),
		unavailable("malformed"),
	);
	assert.deepEqual(
		collectionAt(
			{ skills: { elements: [], paging: { start: 0, total: 0 } } },
			"skills",
		),
		read([]),
	);
});

test("assembleRow: an unavailable field makes the row uncovered; addRow withholds it whole", () => {
	const shape = { id: { safeParse: () => ({ success: true }) } };
	const spec = {
		required: ["id"],
		schema: { safeParse: () => ({ success: true }) },
		shape,
	};
	const outcome = assembleRow(spec, {
		id: read("row-1"),
		note: EMPTY,
		title: unavailable("malformed"),
	});
	assert.deepEqual(outcome, {
		kind: "assembled",
		record: { id: "row-1", note: null },
		unavailable: [{ field: "title", reason: "malformed" }],
	});
	const rows = emptyStreamRows();
	addRow(rows, outcome);
	assert.deepEqual(rows, {
		considered: 1,
		covered: 0,
		omittedRows: { withheld_unreadable_fields: 1 },
		records: [],
		unavailableFields: { title: { malformed: 1 } },
	});
	assert.deepEqual(assembleRow(spec, { id: unavailable("malformed") }), {
		kind: "omitted",
		reason: "id_malformed",
	});
});

// ─── D4 partial dates ────────────────────────────────────────────────────

test("partialDate: year + month -> YYYY-MM, year only -> YYYY", () => {
	assert.deepEqual(partialDate({ month: 3, year: 2021 }), read("2021-03"));
	assert.deepEqual(partialDate({ month: 1, year: 1999 }), read("1999-01"));
	assert.deepEqual(partialDate({ year: 2021 }), read("2021"));
	assert.deepEqual(partialDate({ month: null, year: 2021 }), read("2021"));
});

test("partialDate: a point without a readable year or with an invalid month is malformed, never dropped to less precision", () => {
	for (const point of [
		{ month: 5 },
		{ year: "2020" },
		{ year: 2020.5 },
		{ year: 0 },
		{ month: 13, year: 2020 },
		{ month: 0, year: 2020 },
		{ month: "5", year: 2020 },
		42,
	]) {
		assert.deepEqual(
			partialDate(point),
			unavailable("malformed"),
			JSON.stringify(point),
		);
	}
});

test("dateOf: reads dash dateRange, legacy timePeriod, and inline points", () => {
	assert.deepEqual(
		dateOf({ dateRange: { start: { month: 6, year: 2019 } } }, "start"),
		read("2019-06"),
	);
	assert.deepEqual(
		dateOf({ timePeriod: { startDate: { month: 6, year: 2019 } } }, "start"),
		read("2019-06"),
	);
	assert.deepEqual(
		dateOf({ startDate: { year: 2015 } }, "start"),
		read("2015"),
	);
	assert.deepEqual(dateOf({ start: { year: 2015 } }, "start"), read("2015"));
	assert.deepEqual(
		dateOf({ dateRange: { end: { month: 12, year: 2022 } } }, "end"),
		read("2022-12"),
	);
});

test("dateOf: no end anywhere means ongoing (empty); a malformed end anywhere is unavailable", () => {
	assert.deepEqual(
		dateOf({ dateRange: { start: { year: 2019 } } }, "end"),
		EMPTY,
	);
	assert.deepEqual(
		dateOf({ dateRange: { start: { year: 2019 } }, end: 42 }, "end"),
		unavailable("malformed"),
	);
	assert.deepEqual(dateOf({ dateRange: 42 }, "end"), unavailable("malformed"));
});

// ─── Images and timestamps ───────────────────────────────────────────────

test("vectorImageUrl: builds URL from the largest artifact", () => {
	assert.deepEqual(
		vectorImageUrl({
			artifacts: [
				{ fileIdentifyingUrlPathSegment: "small.jpg" },
				{ fileIdentifyingUrlPathSegment: "large.jpg" },
			],
			rootUrl: "https://media.example/",
		}),
		read("https://media.example/large.jpg"),
	);
});

test("vectorImageUrl: no artifacts key is absent, an empty list is empty, an unreadable artifact is malformed", () => {
	assert.deepEqual(vectorImageUrl({}), unavailable("absent"));
	assert.deepEqual(vectorImageUrl({ artifacts: [] }), EMPTY);
	assert.deepEqual(vectorImageUrl({ artifacts: 42 }), unavailable("malformed"));
	assert.deepEqual(
		vectorImageUrl({ artifacts: [{}] }),
		unavailable("malformed"),
	);
	assert.deepEqual(
		vectorImageUrl({
			artifacts: [{ fileIdentifyingUrlPathSegment: "a" }],
			rootUrl: 1,
		}),
		unavailable("malformed"),
	);
});

test("epochMillis: ISO-8601; zero is not reported; malformed or out of range never throws", () => {
	assert.deepEqual(
		epochMillis(1_700_000_000_000),
		read("2023-11-14T22:13:20.000Z"),
	);
	assert.deepEqual(epochMillis(0), EMPTY);
	assert.deepEqual(epochMillis(-5), unavailable("malformed"));
	assert.deepEqual(epochMillis("bad"), unavailable("malformed"));
	assert.deepEqual(epochMillis(1e20), unavailable("malformed"));
});

// ─── profile ─────────────────────────────────────────────────────────────

test("profileUrlFor: builds the canonical public profile URL", () => {
	assert.equal(
		profileUrlFor("alexrivera"),
		"https://www.linkedin.com/in/alexrivera/",
	);
});

function profileSources(
	dash: Record<string, unknown>,
	me: Record<string, unknown> = {},
): ProfileSources {
	const withCompleteCollections = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(withCompleteCollections);
		if (typeof value !== "object" || value === null) return value;
		const collection = Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				withCompleteCollections(child),
			]),
		);
		return Array.isArray(collection.elements) &&
			!Object.hasOwn(collection, "paging")
			? {
					...collection,
					paging: { start: 0, total: collection.elements.length },
				}
			: collection;
	};
	return {
		connectionCount: read(0),
		dash: withCompleteCollections({
			industry: null,
			location: null,
			profilePositionGroups: { elements: [] },
			summary: null,
			...dash,
		}) as Record<string, unknown>,
		dashSource: "decoration",
		me,
		publicIdentifier: "alexrivera",
	};
}

test("buildProfileRows: maps core fields and derives current position from the open-ended group", () => {
	const rows = buildProfileRows(
		profileSources({
			firstName: "Alex",
			geoLocation: {
				geo: {
					defaultLocalizedName: "San Francisco, California, United States",
				},
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
							paging: { start: 0, total: 1 },
						},
					},
				],
			},
			summary: "Builds reliable data infrastructure.",
		}),
	);
	assert.equal(rows.covered, 1);
	const [record] = rows.records;
	assert.deepEqual(record, {
		connection_count: 0,
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
	assert.equal(validateRecord("profile", record).ok, true);
});

test("profileFieldReads: location joins preferredGeoPlace and countryCode, else geoLocation", () => {
	const location = (dash: Record<string, unknown>) =>
		readValue(
			profileFieldReads(profileSources(dash)).location as FieldRead<string>,
		);
	assert.equal(
		location({
			location: {
				basicLocation: { countryCode: "US" },
				preferredGeoPlace: "San Francisco Bay Area",
			},
		}),
		"San Francisco Bay Area, US",
	);
	assert.equal(location({ location: { preferredGeoPlace: "Paris" } }), "Paris");
	assert.equal(
		location({
			geoLocation: { geo: { defaultLocalizedName: "Austin, Texas" } },
			location: { countryCode: "US", postalCode: "78701" },
		}),
		"Austin, Texas",
	);
});

test("profileFieldReads: dash-only fields the decoration omits are unavailable, not null", () => {
	const reads = profileFieldReads({
		...profileSources({}),
		dash: { firstName: "Alex" },
	});
	for (const field of ["industry", "location", "summary", "current_company"]) {
		assert.equal(reads[field]?.kind, "unavailable", field);
	}
});

test("profileFieldReads: headline and name parts fall back to /me; an empty dash string is a value", () => {
	const reads = profileFieldReads(
		profileSources(
			{ firstName: "", lastName: "DashLast" },
			{
				miniProfile: {
					firstName: "MeFirst",
					lastName: "MeLast",
					occupation: "Engineer at Acme",
				},
			},
		),
	);
	assert.equal(
		readValue(reads.headline as FieldRead<string>),
		"Engineer at Acme",
	);
	assert.equal(readValue(reads.full_name as FieldRead<string>), "DashLast");
});

test("profileFieldReads: a malformed firstName cannot be laundered through lastName", () => {
	for (const dash of [
		{ firstName: 17, joinedName: "Readable Name", lastName: "Readable" },
		{ firstName: "Readable", joinedName: "Readable Name", lastName: 17 },
	]) {
		const reads = profileFieldReads(profileSources(dash));
		assert.deepEqual(reads.full_name, unavailable("malformed"));
		const rows = buildProfileRows(profileSources(dash));
		assert.deepEqual(rows.records, []);
		assert.equal(rows.considered, 1);
		assert.equal(rows.covered, 0);
		assert.equal(rows.unavailableFields.full_name?.malformed, 1);
	}
});

test("profileFieldReads: profile picture prefers the dash image, then /me typed, then /me bare", () => {
	const picture = (
		dash: Record<string, unknown>,
		me: Record<string, unknown>,
	) => profileFieldReads(profileSources(dash, me)).profile_picture_url;
	const image = (segment: string) => ({
		artifacts: [{ fileIdentifyingUrlPathSegment: segment }],
		rootUrl: "https://media.example/",
	});
	assert.deepEqual(
		picture(
			{
				profilePicture: {
					displayImageReference: { vectorImage: image("dash.jpg") },
				},
			},
			{ miniProfile: { picture: image("me.jpg") } },
		),
		read("https://media.example/dash.jpg"),
	);
	assert.deepEqual(
		picture(
			{},
			{
				miniProfile: {
					picture: { "com.linkedin.common.VectorImage": image("typed.jpg") },
				},
			},
		),
		read("https://media.example/typed.jpg"),
	);
	assert.deepEqual(
		picture({}, { miniProfile: { picture: image("bare.jpg") } }),
		read("https://media.example/bare.jpg"),
	);
	assert.deepEqual(picture({}, {}), EMPTY);
});

test("profileFieldReads: the basic fallback cannot supply decoration-only fields", () => {
	const reads = profileFieldReads({
		...profileSources({ firstName: "Alex", lastName: "Rivera" }),
		dashSource: "basic",
	});
	assert.equal(readValue(reads.full_name as FieldRead<string>), "Alex Rivera");
	for (const field of [
		"industry",
		"location",
		"summary",
		"current_company",
		"current_position_title",
	]) {
		assert.deepEqual(reads[field], unavailable("source_unavailable"), field);
	}
});

// ─── experience (D3: group expands to N positions) ───────────────────────

test("buildExperienceRows: group with sub-positions expands 1:1", () => {
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
					{
						dateRange: { start: { year: 2022 } },
						title: "Staff Engineer",
					},
				],
				paging: { start: 0, total: 2 },
			},
		},
	]);
	assert.equal(rows.considered, 2);
	assert.equal(rows.covered, 2);
	const [senior, staff] = rows.records;
	assert.equal(senior?.title, "Senior Engineer");
	assert.equal(senior?.start_date, "2019");
	assert.equal(senior?.end_date, "2022");
	assert.equal(senior?.employment_type, "Full-time");
	assert.equal(
		staff?.company,
		"Acme",
		"a position without its own company takes the group's",
	);
	assert.equal(staff?.end_date, null);
	assert.equal(
		staff?.employment_type,
		null,
		"absent employmentType is empty, never guessed",
	);
	for (const record of rows.records) {
		assert.equal(validateRecord("experience", record).ok, true);
	}
});

test("buildExperienceRows: group without sub-positions expands to one row", () => {
	const rows = buildExperienceRows([
		{
			dateRange: { start: { month: 1, year: 2018 } },
			locationName: "Remote",
			name: "SoloCo",
			title: "Founder",
		},
	]);
	assert.equal(rows.covered, 1);
	assert.equal(rows.records[0]?.company, "SoloCo");
	assert.equal(rows.records[0]?.title, "Founder");
	assert.equal(rows.records[0]?.start_date, "2018-01");
	assert.equal(rows.records[0]?.location, "Remote");
	assert.equal(rows.records[0]?.id, "exp-group-0");
});

test("buildExperienceRows: an empty section is an empty inventory", () => {
	assert.deepEqual(buildExperienceRows([]).records, []);
	assert.equal(buildExperienceRows([]).considered, 0);
});

test("buildExperienceRows: a readable row with one malformed field is withheld whole and stays considered", () => {
	const rows = buildExperienceRows([
		{ title: "Former role", start: { year: 2010 }, end: 42 },
	]);
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 0);
	assert.deepEqual(rows.records, []);
	assert.deepEqual(rows.omittedRows, { withheld_unreadable_fields: 1 });
	assert.deepEqual(rows.unavailableFields, { end_date: { malformed: 1 } });
});

// ─── education ───────────────────────────────────────────────────────────

test("buildEducationRows: maps school/degree/field/dates/grade/logo", () => {
	const rows = buildEducationRows([
		{
			dateRange: { end: { year: 2017 }, start: { year: 2013 } },
			degreeName: "B.S.",
			fieldOfStudy: "Computer Science",
			grade: "3.9 GPA",
			school: {
				logo: {
					vectorImage: {
						artifacts: [{ fileIdentifyingUrlPathSegment: "logo.png" }],
						rootUrl: "https://media.example/school/",
					},
				},
			},
			schoolName: "State University",
		},
	]);
	assert.equal(rows.covered, 1);
	assert.deepEqual(rows.records[0], {
		degree: "B.S.",
		end_date: "2017",
		field_of_study: "Computer Science",
		grade: "3.9 GPA",
		id: "edu-0",
		logo_url: "https://media.example/school/logo.png",
		school: "State University",
		start_date: "2013",
	});
	assert.equal(validateRecord("education", rows.records[0]).ok, true);
});

test("buildEducationRows: absent grade and logo are empty (never guessed)", () => {
	const rows = buildEducationRows([{ schoolName: "State University" }]);
	assert.equal(rows.covered, 1);
	assert.equal(rows.records[0]?.grade, null);
	assert.equal(rows.records[0]?.logo_url, null);
});

test("buildEducationRows: logo falls back through the typed VectorImage key, then schoolLogo", () => {
	const logo = (row: Record<string, unknown>) =>
		buildEducationRows([{ schoolName: "School", ...row }]).records[0]?.logo_url;
	assert.equal(
		logo({
			school: {
				logo: {
					"com.linkedin.common.VectorImage": {
						artifacts: [{ fileIdentifyingUrlPathSegment: "typed.png" }],
						rootUrl: "https://media.example/typed/",
					},
				},
			},
		}),
		"https://media.example/typed/typed.png",
	);
	assert.equal(
		logo({
			schoolLogo: {
				vectorImage: {
					artifacts: [{ fileIdentifyingUrlPathSegment: "legacy.png" }],
					rootUrl: "https://media.example/legacy/",
				},
			},
		}),
		"https://media.example/legacy/legacy.png",
	);
});

test("buildEducationRows: a row with no readable content is omitted, not an all-null row", () => {
	for (const row of [{ schoolLogo: 42 }, { school: {} }, {}]) {
		const rows = buildEducationRows([row]);
		assert.equal(rows.considered, 1, JSON.stringify(row));
		assert.equal(rows.covered, 0, JSON.stringify(row));
		assert.deepEqual(rows.records, [], JSON.stringify(row));
		assert.deepEqual(rows.omittedRows, { no_readable_content: 1 });
	}
});

// ─── skills (flat and categorized) ───────────────────────────────────────

test("buildSkillRows: flat skill list", () => {
	const rows = buildSkillRows([
		{
			endorsementCount: 12,
			entityUrn: "urn:skill:ds",
			name: "Distributed Systems",
		},
		{ endorsementCount: 0, entityUrn: "urn:skill:ts", name: "TypeScript" },
	]);
	assert.equal(rows.covered, 2);
	assert.equal(rows.records[0]?.name, "Distributed Systems");
	assert.equal(rows.records[0]?.endorsement_count, 12);
	assert.equal(rows.records[1]?.endorsement_count, 0);
});

test("buildSkillRows: categorized list flattens to one row per skill", () => {
	const rows = buildSkillRows([
		{
			name: "Tools & Technologies",
			skills: [
				{ endorsements: 5, entityUrn: "urn:skill:k8s", name: "Kubernetes" },
				{ entityUrn: "urn:skill:docker", name: "Docker" },
			],
		},
	]);
	assert.equal(rows.considered, 2);
	assert.equal(rows.covered, 2);
	assert.equal(rows.records[0]?.endorsement_count, 5);
	assert.equal(rows.records[1]?.name, "Docker");
	assert.equal(rows.records[1]?.endorsement_count, null);
});

test("buildSkillRows: a skill without a name is omitted and uncovered", () => {
	const rows = buildSkillRows([
		{ endorsementCount: 3, entityUrn: "urn:skill:unnamed" },
	]);
	assert.deepEqual(rows.records, []);
	assert.deepEqual(rows.omittedRows, { name_absent: 1 });
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 0);
});

// ─── languages ───────────────────────────────────────────────────────────

test("buildLanguageRows: maps name + proficiency", () => {
	const rows = buildLanguageRows([
		{
			entityUrn: "urn:language:spanish",
			name: "Spanish",
			proficiency: "Professional working proficiency",
		},
		{ entityUrn: "urn:language:french", name: "French" },
	]);
	assert.equal(rows.covered, 2);
	assert.equal(
		rows.records[0]?.proficiency,
		"Professional working proficiency",
	);
	assert.equal(rows.records[1]?.proficiency, null);
	for (const record of rows.records) {
		assert.equal(validateRecord("languages", record).ok, true);
	}
});

test("buildLanguageRows: no languages is an empty inventory", () => {
	assert.deepEqual(buildLanguageRows([]).records, []);
});

// ─── connections ─────────────────────────────────────────────────────────

test("buildConnectionRows: resolved profile gives full enrichment", () => {
	const rows = buildConnectionRows(
		[
			{
				connectedMember: "urn:li:fsd_profile:abc123",
				createdAt: 1_700_000_000_000,
			},
		],
		() => ({
			firstName: "Jamie",
			headline: "PM at Acme",
			lastName: "Lee",
			publicIdentifier: "jamielee",
		}),
	);
	assert.equal(rows.covered, 1);
	assert.deepEqual(rows.records[0], {
		connected_at: "2023-11-14T22:13:20.000Z",
		full_name: "Jamie Lee",
		headline: "PM at Acme",
		id: "urn:li:fsd_profile:abc123",
		profile_url: "https://www.linkedin.com/in/jamielee/",
	});
	assert.equal(validateRecord("connections", rows.records[0]).ok, true);
});

test("buildConnectionRows: malformed enrichment is omitted while the listed edge remains", () => {
	for (const resolved of [
		{
			firstName: 17,
			joinedName: "Readable Name",
			lastName: "Readable",
			publicIdentifier: "profile-key",
		},
		{
			firstName: "Readable",
			joinedName: "Readable Name",
			lastName: 17,
			publicIdentifier: "profile-key",
		},
	]) {
		const rows = buildConnectionRows(
			[{ connectedMember: "urn:li:fsd_profile:member-key" }],
			() => resolved,
		);
		assert.equal(rows.records.length, 1);
		assert.equal(rows.considered, 1);
		assert.equal(rows.covered, 1);
		assert.equal(Object.hasOwn(rows.records[0] ?? {}, "full_name"), false);
	}
});

test("buildExperienceRows: bare start is readable and a malformed bare end withholds the row", () => {
	const readable = buildExperienceRows([
		{ title: "Role", start: { year: 2010 } },
	]);
	assert.equal(readable.records[0]?.start_date, "2010");
	assert.equal(readable.covered, 1);

	const malformed = buildExperienceRows([
		{ title: "Role", start: { year: 2010 }, end: 2020 },
	]);
	assert.deepEqual(malformed.records, []);
	assert.equal(malformed.considered, 1);
	assert.equal(malformed.covered, 0);
	assert.equal(malformed.unavailableFields.end_date?.malformed, 1);
});

test("buildEducationRows: a malformed bare end withholds the whole row", () => {
	const rows = buildEducationRows([
		{ schoolName: "School", start: { year: 2010 }, end: { year: "string" } },
	]);
	assert.deepEqual(rows.records, []);
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 0);
	assert.equal(rows.unavailableFields.end_date?.malformed, 1);
});

test("buildConnectionRows: source-backed blank names stay blank", () => {
	const rows = buildConnectionRows(
		[{ connectedMember: "urn:li:fsd_profile:blank-name" }],
		() => ({ firstName: " ", lastName: "" }),
	);
	assert.equal(rows.records[0]?.full_name, "");
	assert.equal(rows.covered, 1);
});

test("buildConnectionRows: an unresolved member keeps its edge and omits unavailable enrichment", () => {
	const rows = buildConnectionRows(
		[{ connectedMember: "urn:li:fsd_profile:xyz789" }],
		() => undefined,
	);
	assert.deepEqual(rows.records, [{ id: "urn:li:fsd_profile:xyz789" }]);
	assert.equal(rows.considered, 1);
	assert.equal(rows.covered, 1);
	assert.deepEqual(rows.unavailableFields, {});
});

test("buildConnectionRows: a row without a member URN cannot be keyed and is omitted", () => {
	const rows = buildConnectionRows([{}], () => undefined);
	assert.deepEqual(rows.records, []);
	assert.deepEqual(rows.omittedRows, { id_absent: 1 });
});
