// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildConnectionRecord,
	buildEducationRecords,
	buildExperienceRecords,
	buildLanguageRecords,
	buildProfileRecord,
	buildSkillRecords,
	connectedAtOf,
	endDateOf,
	locationNameOf,
	partialDateFromPoint,
	profileUrlFor,
	startDateOf,
	subEntityId,
	vectorImageUrl,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { VoyagerProfileElement } from "./types.ts";

// ─── D4 partial dates ────────────────────────────────────────────────────

test("partialDateFromPoint: year + month -> YYYY-MM", () => {
	assert.equal(partialDateFromPoint({ month: 3, year: 2021 }), "2021-03");
});

test("partialDateFromPoint: year only -> YYYY", () => {
	assert.equal(partialDateFromPoint({ year: 2021 }), "2021");
});

test("partialDateFromPoint: pads single-digit month", () => {
	assert.equal(partialDateFromPoint({ month: 1, year: 1999 }), "1999-01");
});

test("partialDateFromPoint: missing year -> null (never invents a date)", () => {
	assert.equal(partialDateFromPoint({ month: 5 }), null);
	assert.equal(partialDateFromPoint(undefined), null);
});

test("partialDateFromPoint: out-of-range month is dropped, not invented", () => {
	assert.equal(partialDateFromPoint({ month: 13, year: 2020 }), "2020");
	assert.equal(partialDateFromPoint({ month: 0, year: 2020 }), "2020");
});

// startDateOf / endDateOf: dash `dateRange` vs legacy `timePeriod` vs inline

test("startDateOf: reads dash dateRange.start", () => {
	assert.equal(
		startDateOf({ dateRange: { start: { month: 6, year: 2019 } } }),
		"2019-06",
	);
});

test("startDateOf: reads legacy timePeriod.startDate", () => {
	assert.equal(
		startDateOf({ timePeriod: { startDate: { month: 6, year: 2019 } } }),
		"2019-06",
	);
});

test("startDateOf: reads inline startDate (oldest legacy shape)", () => {
	assert.equal(startDateOf({ startDate: { year: 2015 } }), "2015");
});

test("endDateOf: null end (no end field) means Present -> null", () => {
	assert.equal(endDateOf({ dateRange: { start: { year: 2019 } } }), null);
});

test("endDateOf: dash dateRange.end present -> partial date", () => {
	assert.equal(
		endDateOf({ dateRange: { end: { month: 12, year: 2022 } } }),
		"2022-12",
	);
});

test("startDateOf/endDateOf: undefined node -> null, not a throw", () => {
	assert.equal(startDateOf(undefined), null);
	assert.equal(endDateOf(undefined), null);
});

// ─── vectorImageUrl ───────────────────────────────────────────────────────

test("vectorImageUrl: builds URL from largest artifact", () => {
	assert.equal(
		vectorImageUrl({
			artifacts: [
				{ fileIdentifyingUrlPathSegment: "small.jpg" },
				{ fileIdentifyingUrlPathSegment: "large.jpg" },
			],
			rootUrl: "https://media.example/",
		}),
		"https://media.example/large.jpg",
	);
});

test("vectorImageUrl: no artifacts -> null", () => {
	assert.equal(vectorImageUrl({ artifacts: [] }), null);
	assert.equal(vectorImageUrl(undefined), null);
});

// ─── subEntityId ──────────────────────────────────────────────────────────

test("subEntityId: prefers entityUrn when present", () => {
	assert.equal(
		subEntityId("urn:li:fsd_profilePosition:123", "exp", 0),
		"urn:li:fsd_profilePosition:123",
	);
});

test("subEntityId: falls back to positional id when urn absent", () => {
	assert.equal(subEntityId(undefined, "exp-0", 2), "exp-0-2");
	assert.equal(subEntityId("", "exp-0", 2), "exp-0-2");
});

// ─── profileUrlFor / locationNameOf ───────────────────────────────────────

test("profileUrlFor: builds the canonical public profile URL", () => {
	assert.equal(
		profileUrlFor("alexrivera"),
		"https://www.linkedin.com/in/alexrivera/",
	);
});

test("locationNameOf: prefers preferredGeoPlace + countryCode when present", () => {
	assert.equal(
		locationNameOf({
			location: {
				basicLocation: { countryCode: "US" },
				preferredGeoPlace: "San Francisco Bay Area",
			},
		}),
		"San Francisco Bay Area, US",
	);
});

test("locationNameOf: falls back to geoLocation default name", () => {
	assert.equal(
		locationNameOf({
			geoLocation: { geo: { defaultLocalizedName: "Austin, Texas" } },
		}),
		"Austin, Texas",
	);
});

test("locationNameOf: neither present -> null", () => {
	assert.equal(locationNameOf({}), null);
});

// ─── buildProfileRecord ────────────────────────────────────────────────────

test("buildProfileRecord: maps core fields and derives current position from open-ended group", () => {
	const profile: VoyagerProfileElement = {
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

	const record = buildProfileRecord(
		"alexrivera",
		profile,
		undefined,
		undefined,
		null,
	);
	assert.equal(record.id, "alexrivera");
	assert.equal(record.full_name, "Alex Rivera");
	assert.equal(record.headline, "Staff Engineer at Acme");
	assert.equal(record.current_company, "Acme");
	assert.equal(record.current_position_title, "Staff Engineer");
	assert.equal(record.public_url, "https://www.linkedin.com/in/alexrivera/");
	assert.equal(record.industry, "Software Development");
	assert.equal(record.location, "San Francisco, California, United States");
	assert.equal(record.connection_count, null);
	assert.equal(record.profile_picture_url, null);

	const result = validateRecord("profile", record);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("buildProfileRecord: industry is null when the real observed shape (industry.name) is absent (never guessed)", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{},
		undefined,
		undefined,
		null,
	);
	assert.equal(record.industry, null);
});

test("buildProfileRecord: falls back to /me occupation when dash headline absent", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{},
		"Engineer at Acme",
		undefined,
		null,
	);
	assert.equal(record.headline, "Engineer at Acme");
});

test("buildProfileRecord: passes through the caller-supplied connection count", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{},
		undefined,
		undefined,
		842,
	);
	assert.equal(record.connection_count, 842);
});

test("buildProfileRecord: profile_picture_url prefers the dash profile's own image over /me's miniProfile", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{
			profilePicture: {
				displayImageReference: {
					vectorImage: {
						artifacts: [{ fileIdentifyingUrlPathSegment: "dash.jpg" }],
						rootUrl: "https://media.example/dash/",
					},
				},
			},
		},
		undefined,
		{
			picture: {
				artifacts: [{ fileIdentifyingUrlPathSegment: "me.jpg" }],
				rootUrl: "https://media.example/me/",
			},
		},
		null,
	);
	assert.equal(
		record.profile_picture_url,
		"https://media.example/dash/dash.jpg",
	);
});

test("buildProfileRecord: profile_picture_url falls back to /me miniProfile picture (typed VectorImage key) when the dash profile has none", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{},
		undefined,
		{
			picture: {
				"com.linkedin.common.VectorImage": {
					artifacts: [{ fileIdentifyingUrlPathSegment: "me.jpg" }],
					rootUrl: "https://media.example/me/",
				},
			},
		},
		null,
	);
	assert.equal(record.profile_picture_url, "https://media.example/me/me.jpg");
});

test("buildProfileRecord: profile_picture_url falls back to /me miniProfile picture (bare shape) when the dash profile has none", () => {
	const record = buildProfileRecord(
		"alexrivera",
		{},
		undefined,
		{
			picture: {
				artifacts: [{ fileIdentifyingUrlPathSegment: "me-bare.jpg" }],
				rootUrl: "https://media.example/me-bare/",
			},
		},
		null,
	);
	assert.equal(
		record.profile_picture_url,
		"https://media.example/me-bare/me-bare.jpg",
	);
});

test("buildProfileRecord: profile_picture_url is null when neither source has an image (never guessed)", () => {
	const record = buildProfileRecord("alexrivera", {}, undefined, {}, null);
	assert.equal(record.profile_picture_url, null);
});

// ─── buildExperienceRecords (D3: group expands to N positions) ────────────

test("buildExperienceRecords: group with sub-positions expands 1:1", () => {
	const profile: VoyagerProfileElement = {
		profilePositionGroups: {
			elements: [
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
								companyName: "Acme",
								dateRange: { start: { year: 2022 } },
								title: "Staff Engineer",
							},
						],
					},
				},
			],
		},
	};
	const records = buildExperienceRecords(profile);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.title, "Senior Engineer");
	assert.equal(records[0]?.start_date, "2019");
	assert.equal(records[0]?.end_date, "2022");
	assert.equal(records[0]?.employment_type, "Full-time");
	assert.equal(records[1]?.title, "Staff Engineer");
	assert.equal(records[1]?.end_date, null);
	assert.equal(
		records[1]?.employment_type,
		null,
		"employmentType absent on this position -> null, never guessed",
	);

	for (const record of records) {
		const result = validateRecord("experience", record);
		assert.equal(result.ok, true, JSON.stringify(result));
	}
});

test("buildExperienceRecords: group without sub-positions expands to one record", () => {
	const profile: VoyagerProfileElement = {
		profilePositionGroups: {
			elements: [
				{
					dateRange: { start: { month: 1, year: 2018 } },
					locationName: "Remote",
					name: "SoloCo",
					title: "Founder",
				},
			],
		},
	};
	const records = buildExperienceRecords(profile);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.company, "SoloCo");
	assert.equal(records[0]?.title, "Founder");
	assert.equal(records[0]?.start_date, "2018-01");
	assert.equal(records[0]?.location, "Remote");
});

test("buildExperienceRecords: no position groups -> empty array, not a throw", () => {
	assert.deepEqual(buildExperienceRecords({}), []);
});

// ─── buildEducationRecords ─────────────────────────────────────────────────

test("buildEducationRecords: maps school/degree/field/dates/grade/logo", () => {
	const profile: VoyagerProfileElement = {
		profileEducations: {
			elements: [
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
			],
		},
	};
	const records = buildEducationRecords(profile);
	assert.equal(records.length, 1);
	assert.equal(records[0]?.school, "State University");
	assert.equal(records[0]?.degree, "B.S.");
	assert.equal(records[0]?.field_of_study, "Computer Science");
	assert.equal(records[0]?.start_date, "2013");
	assert.equal(records[0]?.end_date, "2017");
	assert.equal(records[0]?.grade, "3.9 GPA");
	assert.equal(records[0]?.logo_url, "https://media.example/school/logo.png");

	const result = validateRecord("education", records[0]);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("buildEducationRecords: grade/logo_url are null when absent (never guessed)", () => {
	const profile: VoyagerProfileElement = {
		profileEducations: {
			elements: [{ schoolName: "State University" }],
		},
	};
	const records = buildEducationRecords(profile);
	assert.equal(records[0]?.grade, null);
	assert.equal(records[0]?.logo_url, null);

	const result = validateRecord("education", records[0]);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("buildEducationRecords: logo_url falls back through the typed VectorImage key, then schoolLogo", () => {
	const withTypedKey = buildEducationRecords({
		profileEducations: {
			elements: [
				{
					school: {
						logo: {
							"com.linkedin.common.VectorImage": {
								artifacts: [{ fileIdentifyingUrlPathSegment: "typed.png" }],
								rootUrl: "https://media.example/typed/",
							},
						},
					},
					schoolName: "Typed-Key School",
				},
			],
		},
	});
	assert.equal(
		withTypedKey[0]?.logo_url,
		"https://media.example/typed/typed.png",
	);

	const withSchoolLogo = buildEducationRecords({
		profileEducations: {
			elements: [
				{
					schoolLogo: {
						vectorImage: {
							artifacts: [{ fileIdentifyingUrlPathSegment: "legacy.png" }],
							rootUrl: "https://media.example/legacy/",
						},
					},
					schoolName: "Legacy-Shape School",
				},
			],
		},
	});
	assert.equal(
		withSchoolLogo[0]?.logo_url,
		"https://media.example/legacy/legacy.png",
	);
});

// ─── buildSkillRecords (dual flat/category shape) ──────────────────────────

test("buildSkillRecords: flat skill list", () => {
	const profile: VoyagerProfileElement = {
		profileSkills: {
			elements: [
				{ endorsementCount: 12, name: "Distributed Systems" },
				{ endorsementCount: 0, name: "TypeScript" },
			],
		},
	};
	const records = buildSkillRecords(profile);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.name, "Distributed Systems");
	assert.equal(records[0]?.endorsement_count, 12);
	assert.equal(records[1]?.endorsement_count, 0);
});

test("buildSkillRecords: categorized skill list flattens to one record per skill", () => {
	const profile: VoyagerProfileElement = {
		profileSkills: {
			elements: [
				{
					name: "Tools & Technologies",
					skills: [{ endorsements: 5, name: "Kubernetes" }, { name: "Docker" }],
				},
			],
		},
	};
	const records = buildSkillRecords(profile);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.name, "Kubernetes");
	assert.equal(records[0]?.endorsement_count, 5);
	assert.equal(records[1]?.name, "Docker");
	assert.equal(records[1]?.endorsement_count, null);
});

test("buildSkillRecords: skips entries with no usable name", () => {
	const profile: VoyagerProfileElement = {
		profileSkills: { elements: [{ endorsementCount: 3 }] },
	};
	assert.deepEqual(buildSkillRecords(profile), []);
});

// ─── buildLanguageRecords ───────────────────────────────────────────────────

test("buildLanguageRecords: maps name + proficiency", () => {
	const profile: VoyagerProfileElement = {
		profileLanguages: {
			elements: [
				{ name: "Spanish", proficiency: "Professional working proficiency" },
				{ name: "French" },
			],
		},
	};
	const records = buildLanguageRecords(profile);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.name, "Spanish");
	assert.equal(records[0]?.proficiency, "Professional working proficiency");
	assert.equal(records[1]?.proficiency, null);

	for (const record of records) {
		const result = validateRecord("languages", record);
		assert.equal(result.ok, true, JSON.stringify(result));
	}
});

test("buildLanguageRecords: no languages -> empty array", () => {
	assert.deepEqual(buildLanguageRecords({}), []);
});

// ─── connectedAtOf / buildConnectionRecord ─────────────────────────────────

test("connectedAtOf: epoch milliseconds -> ISO-8601", () => {
	assert.equal(connectedAtOf(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
});

test("connectedAtOf: zero/absent/negative -> null, never epoch", () => {
	assert.equal(connectedAtOf(0), null);
	assert.equal(connectedAtOf(undefined), null);
	assert.equal(connectedAtOf(-5), null);
});

test("buildConnectionRecord: resolved profile -> full enrichment", () => {
	const record = buildConnectionRecord(
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
	);
	assert.ok(record);
	assert.equal(record?.id, "urn:li:fsd_profile:abc123");
	assert.equal(record?.full_name, "Jamie Lee");
	assert.equal(record?.headline, "PM at Acme");
	assert.equal(record?.profile_url, "https://www.linkedin.com/in/jamielee/");
	assert.equal(record?.connected_at, "2023-11-14T22:13:20.000Z");

	const result = validateRecord("connections", record);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("buildConnectionRecord: unresolved profile -> null enrichment fields, edge still emitted", () => {
	const record = buildConnectionRecord(
		{ connectedMember: "urn:li:fsd_profile:xyz789" },
		undefined,
	);
	assert.ok(record);
	assert.equal(record?.id, "urn:li:fsd_profile:xyz789");
	assert.equal(record?.full_name, null);
	assert.equal(record?.headline, null);
	assert.equal(record?.profile_url, null);
	assert.equal(record?.connected_at, null);

	const result = validateRecord("connections", record);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("buildConnectionRecord: missing connectedMember -> null (cannot key the edge)", () => {
	assert.equal(buildConnectionRecord({}, undefined), null);
});
