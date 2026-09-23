// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the LinkedIn connector. Records are parser-derived
 * (see parsers.test.ts) rather than hand-shaped to the manifest contract —
 * the connector now emits real records via `collectLinkedIn`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	connectionsSchema,
	educationSchema,
	experienceSchema,
	languagesSchema,
	profileSchema,
	skillsSchema,
	validateRecord,
} from "./schemas.ts";

const PROFILE_RECORD = {
	connection_count: 842,
	current_company: "Acme",
	current_position_title: "Staff Engineer",
	full_name: "Alex Rivera",
	headline: "Staff Engineer at Acme",
	id: "alexrivera",
	industry: "Software Development",
	location: "San Francisco Bay Area",
	profile_picture_url: "https://media.example/avatar.jpg",
	public_url: "https://www.linkedin.com/in/alexrivera/",
	summary: "Builds reliable data infrastructure.",
};

const EXPERIENCE_RECORD = {
	company: "Acme",
	description: "Led the data platform team.",
	employment_type: null,
	end_date: null,
	id: "urn:li:fsd_profilePosition:100",
	location: "Remote",
	start_date: "2021-03",
	title: "Staff Engineer",
};

const EDUCATION_RECORD = {
	degree: "B.S.",
	end_date: "2017",
	field_of_study: "Computer Science",
	grade: "3.9 GPA",
	id: "urn:li:fsd_profileEducation:200",
	logo_url: "https://media.example/school-logo.png",
	school: "State University",
	start_date: "2013",
};

const SKILL_RECORD = {
	endorsement_count: 42,
	id: "skill-300",
	name: "Distributed Systems",
};

const LANGUAGE_RECORD = {
	id: "lang-0",
	name: "Spanish",
	proficiency: "Professional working proficiency",
};

const CONNECTION_RECORD = {
	connected_at: "2023-11-14T22:13:20.000Z",
	full_name: "Jamie Lee",
	headline: "PM at Acme",
	id: "urn:li:fsd_profile:abc123",
	profile_url: "https://www.linkedin.com/in/jamielee/",
};

test("profile schema accepts a parser-shaped record", () => {
	const result = profileSchema.safeParse(PROFILE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts null connection_count and profile_picture_url (never guessed when unavailable)", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		connection_count: null,
		profile_picture_url: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a negative connection_count", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, connection_count: -1 })
			.success,
		false,
	);
});

test("experience schema accepts a current role (null end_date)", () => {
	const result = experienceSchema.safeParse(EXPERIENCE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("experience schema rejects a full ISO datetime (D4: partial date only)", () => {
	assert.equal(
		experienceSchema.safeParse({
			...EXPERIENCE_RECORD,
			start_date: "2021-03-01T00:00:00.000Z",
		}).success,
		false,
	);
});

test("experience schema rejects an invented day precision (YYYY-MM-DD)", () => {
	assert.equal(
		experienceSchema.safeParse({
			...EXPERIENCE_RECORD,
			start_date: "2021-03-15",
		}).success,
		false,
	);
});

test("education schema accepts a parser-shaped record", () => {
	const result = educationSchema.safeParse(EDUCATION_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("education schema accepts null grade and logo_url (never guessed when unavailable)", () => {
	const result = educationSchema.safeParse({
		...EDUCATION_RECORD,
		grade: null,
		logo_url: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("skills schema accepts a parser-shaped record", () => {
	const result = skillsSchema.safeParse(SKILL_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("languages schema accepts a parser-shaped record", () => {
	const result = languagesSchema.safeParse(LANGUAGE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("languages schema accepts a null proficiency", () => {
	const result = languagesSchema.safeParse({
		...LANGUAGE_RECORD,
		proficiency: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("connections schema accepts a parser-shaped record", () => {
	const result = connectionsSchema.safeParse(CONNECTION_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("connections schema accepts an unresolved connection (all enrichment null)", () => {
	const result = connectionsSchema.safeParse({
		connected_at: null,
		full_name: null,
		headline: null,
		id: "urn:li:fsd_profile:xyz789",
		profile_url: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a non-URL public_url (parser captured a label)", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, public_url: "Alex Rivera" })
			.success,
		false,
	);
});

test("skills schema rejects a missing name (manifest-required field)", () => {
	const { name: _omit, ...withoutName } = SKILL_RECORD;
	assert.equal(skillsSchema.safeParse(withoutName).success, false);
});

test("skills schema rejects a negative endorsement_count", () => {
	assert.equal(
		skillsSchema.safeParse({ ...SKILL_RECORD, endorsement_count: -1 }).success,
		false,
	);
});

test("validateRecord routes all six streams and passes unknown streams through", () => {
	assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
	assert.equal(validateRecord("experience", EXPERIENCE_RECORD).ok, true);
	assert.equal(validateRecord("education", EDUCATION_RECORD).ok, true);
	assert.equal(validateRecord("skills", SKILL_RECORD).ok, true);
	assert.equal(validateRecord("languages", LANGUAGE_RECORD).ok, true);
	assert.equal(validateRecord("connections", CONNECTION_RECORD).ok, true);
	assert.equal(validateRecord("recommendations", { id: "x" }).ok, true);
});
