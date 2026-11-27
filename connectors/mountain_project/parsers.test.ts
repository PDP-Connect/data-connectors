// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildSavedRouteRecords,
	buildTickRecords,
	cleanText,
	parseCsv,
	parseExportTable,
	parseProfilePage,
	parseSessionConfig,
	profilePath,
	routeIdFromUrl,
	sessionFromConfig,
	TICK_COLUMNS,
	TODO_COLUMNS,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const PROFILE_URL =
	"https://www.mountainproject.com/user/999000000001/alex-example";

function tickRows() {
	const table = parseExportTable(fixture("tick-export.csv"), TICK_COLUMNS);
	assert.ok(table.ok);
	return table.rows;
}

test("parseCsv reads quotes, doubled quotes, CRLF, a BOM and line breaks inside a quoted field", () => {
	const rows = parseCsv('﻿a,"b, c","say ""hi"""\r\n1,"two\nlines",3\n\n');
	assert.deepEqual(rows, [
		["a", "b, c", 'say "hi"'],
		["1", "two\nlines", "3"],
	]);
});

test("parseCsv keeps empty trailing fields and refuses an unterminated quote", () => {
	assert.deepEqual(parseCsv("a,,\n"), [["a", "", ""]]);
	assert.throws(() => parseCsv('a,"b\n'), /unterminated/);
});

test("parseExportTable keys rows by header and fails when a required column is missing", () => {
	assert.equal(tickRows().length, 7);
	const missing = parseExportTable("Date,Route\n2026-01-01,x\n", TICK_COLUMNS);
	assert.equal(missing.ok, false);
	if (!missing.ok) assert.match(missing.message, /Notes/);
	const truncated = parseExportTable('Date,Route\n"2026', TICK_COLUMNS);
	assert.equal(truncated.ok, false);
});

test("an empty export or a header-only export is an empty list", () => {
	for (const body of ["", "\n", `${TICK_COLUMNS.join(",")}\n`]) {
		const table = parseExportTable(body, TICK_COLUMNS);
		assert.ok(table.ok);
		assert.deepEqual(table.rows, []);
	}
});

test("buildTickRecords keys same-route same-day ticks by their order in the export", () => {
	const { records, unreadable } = buildTickRecords(tickRows());
	assert.equal(unreadable, 0);
	assert.deepEqual(
		records.map((r) => r.id),
		[
			"105700001:2026-10-04:1",
			"105700001:2026-10-04:2",
			"105700001:2026-10-04:3",
			"105700002:2026-09-20:1",
			"105700003:2026-09-12:1",
			"105700004:2026-08-30:1",
			"105700005:2025-07-01:1",
		],
	);
});

test("buildTickRecords maps every column", () => {
	const [first, , third, fourth, , sixth, seventh] = buildTickRecords(
		tickRows(),
	).records;
	assert.deepEqual(first, {
		id: "105700001:2026-10-04:1",
		date: "2026-10-04",
		route_id: "105700001",
		route_name: "Example Arete",
		route_url: "https://www.mountainproject.com/route/105700001/example-arete",
		rating: "5.10a",
		rating_code: 5500,
		location: ["Colorado", "Boulder", "Eldorado Canyon SP", "Example Wall"],
		avg_stars: 3.1,
		your_stars: 3,
		route_type: ["Sport"],
		your_rating: "5.10b",
		length_ft: 80,
		pitches: 1,
		style: "Lead",
		lead_style: "Redpoint",
		notes: 'Clipped the anchors, finally. Felt "easy" today.',
	});
	assert.equal(third?.notes, "Second lap\nafter lunch.");
	assert.equal(fourth?.your_stars, null, "-1 stars is no rating");
	assert.deepEqual(fourth?.route_type, ["Trad", "Alpine"]);
	assert.equal(fourth?.lead_style, null);
	assert.equal(sixth?.length_ft, null);
	assert.equal(sixth?.rating, "5.11 V1+");
	assert.equal(seventh?.style, null);
	assert.equal(seventh?.rating_code, null);
});

test("every built tick, saved route and the profile validate against the schemas", () => {
	for (const record of buildTickRecords(tickRows()).records) {
		assert.ok(validateRecord("ticks", { ...record }).ok, record.id);
	}
	const todo = parseExportTable(fixture("todo-export.csv"), TODO_COLUMNS);
	assert.ok(todo.ok);
	for (const record of buildSavedRouteRecords(todo.rows).records) {
		assert.ok(validateRecord("saved_routes", { ...record }).ok, record.id);
	}
	const profile = parseProfilePage(
		fixture("profile.html"),
		PROFILE_URL,
		"999000000001",
	);
	assert.ok(profile.ok);
	assert.ok(validateRecord("profile", { ...profile.record }).ok);
});

test("a tick row with no route URL or no valid date is unreadable, not guessed", () => {
	const rows = tickRows().slice(0, 2);
	const bad = [
		{ ...rows[0], URL: "https://example.com/route/1/x" },
		{ ...rows[1], Date: "2026-02-30" },
		{ ...rows[1], Route: "  " },
	] as Array<Record<string, string>>;
	const { records, unreadable } = buildTickRecords(bad);
	assert.equal(records.length, 0);
	assert.equal(unreadable, 3);
});

test("buildSavedRouteRecords keys by route id and drops a repeated route", () => {
	const table = parseExportTable(fixture("todo-export.csv"), TODO_COLUMNS);
	assert.ok(table.ok);
	const rows = [...table.rows, table.rows[0] as Record<string, string>];
	const { records, duplicates, unreadable } = buildSavedRouteRecords(rows);
	assert.deepEqual(
		records.map((r) => r.id),
		["105700101", "105700102"],
	);
	assert.equal(duplicates, 1);
	assert.equal(unreadable, 0);
	assert.equal(records[1]?.length_ft, null);
	assert.equal(records[0]?.pitches, 4);
});

test("cleanText drops control characters and blank values and folds CRLF to LF", () => {
	assert.equal(cleanText(" a\u0000b\u0007 "), "ab");
	assert.equal(cleanText("tab\there\nline"), "tab\there\nline");
	assert.equal(cleanText("one\r\ntwo\rthree\n"), "one\ntwo\nthree");
	assert.equal(cleanText("   "), null);
	assert.equal(cleanText(undefined), null);
});

// The exports of the project-owned test account, fetched from the signed-in
// browser on 2026-11-11 and committed byte for byte. They carry no owner
// identifier (no user id, name or profile URL): route fields are Mountain
// Project's public catalog, the one note is the text typed when seeding.
test("the test account's real tick export parses into 5 validated ticks", () => {
	const raw = fixture("canary-tick-export.csv");
	// The site writes CRLF inside the quoted note; .gitattributes keeps it.
	assert.ok(raw.includes("\r\n"), "the fixture must keep its CRLF bytes");
	const table = parseExportTable(raw, TICK_COLUMNS);
	assert.ok(table.ok);
	const { records, unreadable } = buildTickRecords(table.rows);
	assert.equal(unreadable, 0);
	assert.deepEqual(
		records.map((r) => r.id),
		[
			"105835104:2026-11-11:1",
			"105872293:2026-11-11:1",
			"105862912:2026-11-11:1",
			"105872293:2026-11-11:2",
			"105732422:2024-06-15:1",
		],
	);
	for (const record of records) {
		assert.ok(validateRecord("ticks", { ...record }).ok, record.id);
	}
	const [boulder, fellHung, serenity, redpoint, follow] = records;
	assert.deepEqual(
		[boulder?.style, boulder?.lead_style, boulder?.route_type],
		["Send", null, ["Boulder"]],
	);
	assert.equal(boulder?.length_ft, null);
	assert.equal(boulder?.rating_code, 20800);
	assert.equal(fellHung?.lead_style, "Fell/Hung");
	assert.equal(serenity?.rating, "5.10d PG13");
	assert.equal(serenity?.style, "TR");
	// The multi-line note comes out of the export with CRLF; the record has LF.
	assert.equal(
		redpoint?.notes,
		"Canary tick, linked pitches 2 and 3\nGear: single rack to 3in",
	);
	assert.equal(redpoint?.lead_style, "Redpoint");
	assert.equal(follow?.pitches, 16);
	assert.equal(follow?.your_stars, null);
	assert.deepEqual(follow?.location, [
		"Nevada",
		"Southern Nevada",
		"Red Rocks",
		"Black Velvet Canyon",
		"Black Velvet Wall",
	]);
});

test("the test account's real to-do export parses into 3 validated saved routes", () => {
	const table = parseExportTable(
		fixture("canary-todo-export.csv"),
		TODO_COLUMNS,
	);
	assert.ok(table.ok);
	const { records, unreadable, duplicates } = buildSavedRouteRecords(
		table.rows,
	);
	assert.equal(unreadable, 0);
	assert.equal(duplicates, 0);
	assert.deepEqual(
		records.map((r) => [r.id, r.route_name, r.pitches]),
		[
			["105717367", "Incredible Hand Crack", 1],
			["105732422", "Epinephrine", 16],
			["105872293", "Corrugation Corner", 3],
		],
	);
	for (const record of records) {
		assert.ok(validateRecord("saved_routes", { ...record }).ok, record.id);
	}
});

test("routeIdFromUrl accepts only mountainproject.com route URLs", () => {
	assert.equal(
		routeIdFromUrl(
			"https://www.mountainproject.com/route/105748490/the-bastille-crack",
		),
		"105748490",
	);
	assert.equal(
		routeIdFromUrl("https://www.mountainproject.com/area/105744246/x"),
		null,
	);
	assert.equal(
		routeIdFromUrl("http://www.mountainproject.com/route/1/x"),
		null,
	);
});

test("parseSessionConfig reads isLoggedIn and userId from the page's ap.config", () => {
	assert.deepEqual(parseSessionConfig(fixture("profile.html")), {
		loggedIn: true,
		userId: "999000000001",
	});
	assert.deepEqual(
		parseSessionConfig("'isLoggedIn': 0,\n'userId': undefined,\n"),
		{ loggedIn: false, userId: null },
	);
	assert.equal(parseSessionConfig("<html></html>"), null);
});

test("sessionFromConfig normalizes the live window.ap.config values", () => {
	assert.deepEqual(sessionFromConfig({ isLoggedIn: 1, userId: 999000000001 }), {
		loggedIn: true,
		userId: "999000000001",
	});
	assert.deepEqual(sessionFromConfig({ isLoggedIn: 0 }), {
		loggedIn: false,
		userId: null,
	});
	assert.equal(sessionFromConfig(null), null);
	assert.equal(sessionFromConfig({ userId: 5 }), null);
});

test("profilePath reads the id and slug of a profile URL", () => {
	assert.deepEqual(profilePath(PROFILE_URL), {
		id: "999000000001",
		path: "/user/999000000001/alex-example",
	});
	assert.equal(
		profilePath("https://www.mountainproject.com/user/999000000001"),
		null,
	);
	assert.equal(profilePath("https://evil.example/user/1/x"), null);
});

test("parseProfilePage reads name, location, picture, join date and both counts", () => {
	const parsed = parseProfilePage(
		fixture("profile.html"),
		PROFILE_URL,
		"999000000001",
	);
	assert.ok(parsed.ok);
	assert.deepEqual(parsed.record, {
		id: "999000000001",
		display_name: "Alex Example",
		profile_url: PROFILE_URL,
		avatar_url:
			"https://mountainproject.com/assets/avatars/999000000001.jpg?cache=1700000000",
		location: "Boulder, CO",
		member_since: "2019-03-03",
		tick_count: 7,
		todo_count: 2,
	});
});

test("parseProfilePage takes the slug from the page's canonical link, else from the response URL", () => {
	const noSlug = "https://www.mountainproject.com/user/999000000001";
	const fromCanonical = parseProfilePage(
		fixture("profile.html"),
		noSlug,
		"999000000001",
	);
	assert.ok(fromCanonical.ok);
	assert.equal(fromCanonical.record.profile_url, PROFILE_URL);
	const withoutCanonical = fixture("profile.html").replace(
		/<link rel="canonical"[^>]*>\n/,
		"",
	);
	assert.equal(
		parseProfilePage(withoutCanonical, noSlug, "999000000001").ok,
		false,
		"no slug anywhere",
	);
	assert.ok(parseProfilePage(withoutCanonical, PROFILE_URL, "999000000001").ok);
	const otherCanonical = fixture("profile.html").replace(
		'/user/999000000001/alex-example"/>',
		'/user/999/someone-else"/>',
	);
	assert.equal(
		parseProfilePage(otherCanonical, PROFILE_URL, "999000000001").ok,
		false,
		"the page declares another user's profile",
	);
});

test("parseProfilePage refuses another user's page and a page without the name block", () => {
	const other = parseProfilePage(fixture("profile.html"), PROFILE_URL, "999");
	assert.equal(other.ok, false);
	const blank = parseProfilePage(
		"<html><body></body></html>",
		PROFILE_URL,
		"999000000001",
	);
	assert.equal(blank.ok, false);
});

test("parseProfilePage leaves counts null when the profile shows none", () => {
	const html = fixture("profile.html")
		.replace("View All 7", "View All")
		.replace("Sort &amp; Filter All 2", "Sort &amp; Filter");
	const parsed = parseProfilePage(html, PROFILE_URL, "999000000001");
	assert.ok(parsed.ok);
	assert.equal(parsed.record.tick_count, null);
	assert.equal(parsed.record.todo_count, null);
});
