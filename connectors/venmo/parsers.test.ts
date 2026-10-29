// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
	dollarsToCents,
	parseTransactionStory,
	profileRecord,
	userRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { VenmoStory, VenmoUser } from "./types.ts";

const RAW_USER: VenmoUser = {
	id: "1234567890123456789",
	username: "jane_doe",
	first_name: "Jane",
	last_name: "Doe",
	display_name: "Jane Doe",
	phone: "+15555550100",
	profile_picture_url: "https://pics.venmo.com/abc.jpg",
	about: "coffee enthusiast",
	date_joined: "2015-03-04T18:22:01Z",
	is_group: false,
	is_active: true,
	is_business: false,
};

test("dollarsToCents converts a float dollar amount to integer cents", () => {
	assert.equal(dollarsToCents(25), 2500);
	assert.equal(dollarsToCents(9.99), 999);
	assert.equal(dollarsToCents(-5.5), -550);
});

test("dollarsToCents rounds floating-point drift instead of truncating (25.005 -> 2501, not 2500)", () => {
	assert.equal(dollarsToCents(25.005), 2501);
});

test("dollarsToCents returns null for missing or non-finite amounts", () => {
	assert.equal(dollarsToCents(null), null);
	assert.equal(dollarsToCents(undefined), null);
	assert.equal(dollarsToCents(Number.NaN), null);
	assert.equal(dollarsToCents(Number.POSITIVE_INFINITY), null);
	assert.equal(dollarsToCents(Number.NEGATIVE_INFINITY), null);
});

test("userRecord maps every documented field and passes the friends schema", () => {
	const record = userRecord(RAW_USER);
	assert.equal(record.id, RAW_USER.id);
	assert.equal(record.username, "jane_doe");
	assert.equal(record.is_group, false);
	assert.equal(validateRecord("friends", record).ok, true);
});

test("userRecord keeps missing fields absent so a partial snapshot is invalid", () => {
	const record = userRecord({ id: "1" });
	assert.equal(record.username, undefined);
	assert.equal(record.about, undefined);
	assert.equal(record.is_active, undefined);
	assert.equal(validateRecord("friends", record).ok, false);
});

test("profileRecord uses is_business (not is_group/is_active) and passes the profile schema", () => {
	const record = profileRecord(RAW_USER);
	assert.equal(record.is_business, false);
	assert.ok(!("is_group" in record));
	assert.ok(!("is_active" in record));
	assert.equal(validateRecord("profile", record).ok, true);
});

test("profile and friend records normalize zone-less joined dates and preserve null", () => {
	const user = { ...RAW_USER, date_joined: "2020-01-02T03:04:05.123456" };
	const profile = profileRecord(user);
	const friend = userRecord(user);
	assert.equal(profile.date_joined, "2020-01-02T03:04:05.123456Z");
	assert.equal(friend.date_joined, "2020-01-02T03:04:05.123456Z");
	assert.equal(validateRecord("profile", profile).ok, true);
	assert.equal(validateRecord("friends", friend).ok, true);
	assert.equal(profileRecord({ ...user, date_joined: null }).date_joined, null);
	assert.equal(userRecord({ ...user, date_joined: null }).date_joined, null);
});

const RAW_PAY_STORY: VenmoStory = {
	id: "4242424242424242424",
	audience: "private",
	date_created: "2026-07-15T14:30:00Z",
	date_updated: "2026-07-15T14:30:05Z",
	type: "payment",
	app: { name: "iPhone" },
	payment: {
		id: "1111111111111111111",
		action: "pay",
		actor: {
			id: "1234567890123456789",
			username: "jane_doe",
			display_name: "Jane Doe",
		},
		target: {
			user: {
				id: "9876543210987654321",
				username: "john_smith",
				display_name: "John Smith",
			},
		},
		amount: 25,
		date_completed: "2026-07-15T14:30:05Z",
		note: "lunch",
		status: "settled",
	},
};

function validTransactionRecord(
	...args: Parameters<typeof parseTransactionStory>
) {
	const parsed = parseTransactionStory(...args);
	assert.equal(parsed.kind, "record");
	if (parsed.kind !== "record") throw new Error("expected a modeled payment");
	return parsed.record;
}

test("parseTransactionStory converts a pay story to a valid record, correctly deriving is_owner_actor", () => {
	const record = validTransactionRecord(RAW_PAY_STORY, "1234567890123456789");
	assert.equal(record.payment_type, "pay");
	assert.equal(record.amount_cents, 2500);
	assert.equal(
		record.is_owner_actor,
		true,
		"owner is the actor (sender) on a pay story",
	);
	assert.equal(validateRecord("transactions", record).ok, true);
});

test("parseTransactionStory preserves an unknown payment amount as null", () => {
	const missingAmountPayment = { ...RAW_PAY_STORY.payment };
	delete missingAmountPayment.amount;
	for (const payment of [{ ...RAW_PAY_STORY.payment, amount: null }]) {
		const record = validTransactionRecord(
			{ ...RAW_PAY_STORY, payment },
			"1234567890123456789",
		);
		assert.ok(record);
		assert.equal(record.amount_cents, null);
		assert.equal(validateRecord("transactions", record).ok, true);
	}
});

test("parseTransactionStory normalizes zone-less dates and retains alphanumeric payment ids", () => {
	const record = validTransactionRecord(
		{
			...RAW_PAY_STORY,
			date_created: "2026-07-15T14:30:00",
			date_updated: "2026-07-15T14:30:05.123456",
			payment: {
				...RAW_PAY_STORY.payment,
				id: "12A34567890123456",
				date_completed: "2026-07-15T14:30:05",
			},
		},
		RAW_USER.id,
	);
	assert.ok(record);
	assert.equal(record.date_created, "2026-07-15T14:30:00Z");
	assert.equal(record.date_updated, "2026-07-15T14:30:05.123456Z");
	assert.equal(record.date_completed, "2026-07-15T14:30:05Z");
	assert.equal(validateRecord("transactions", record).ok, true);
});

test("parseTransactionStory accepts an alphanumeric id on an ordinary payment story", () => {
	const record = validTransactionRecord(
		{
			...RAW_PAY_STORY,
			payment: { ...RAW_PAY_STORY.payment, id: "12A34567890123456" },
		},
		RAW_USER.id,
	);
	assert.ok(record);
	assert.equal(record.payment_id, "12A34567890123456");
	assert.equal(validateRecord("transactions", record).ok, true);
});

test("parseTransactionStory sets is_owner_actor false when the owner is the target, not the actor", () => {
	const record = validTransactionRecord(RAW_PAY_STORY, "9876543210987654321");
	assert.equal(record.is_owner_actor, false);
});

test("parseTransactionStory marks stories without payments unsupported", () => {
	const record = parseTransactionStory(
		{ id: "1", date_created: "2026-01-01T00:00:00Z", type: "transfer" },
		"1234567890123456789",
	);
	assert.deepEqual(record, { kind: "unsupported" });
});

test("parseTransactionStory marks unmodeled payment actions unsupported", () => {
	const record = parseTransactionStory(
		{
			...RAW_PAY_STORY,
			payment: { ...RAW_PAY_STORY.payment, action: "refund" },
		},
		"1234567890123456789",
	);
	assert.deepEqual(record, { kind: "unsupported" });
});

test("parseTransactionStory marks a supported payment without date_created invalid", () => {
	const { date_created: _omit, ...withoutDate } = RAW_PAY_STORY;
	const record = parseTransactionStory(
		withoutDate as VenmoStory,
		"1234567890123456789",
	);
	assert.deepEqual(record, { kind: "invalid", reason: "missing_date_created" });
});

test("parseTransactionStory marks a supported payment without a story id invalid", () => {
	const { id: _omit, ...withoutId } = RAW_PAY_STORY;
	assert.deepEqual(
		parseTransactionStory(withoutId as VenmoStory, RAW_USER.id),
		{
			kind: "invalid",
			reason: "missing_id",
		},
	);
});

test("parseTransactionStory returns a null counterparty (not a throw) when actor/target is absent", () => {
	const record = validTransactionRecord(
		{
			...RAW_PAY_STORY,
			payment: { ...RAW_PAY_STORY.payment, actor: null, target: null },
		},
		"1234567890123456789",
	);
	assert.ok(record);
	assert.equal(record.actor, null);
	assert.equal(record.target, null);
	assert.equal(
		record.is_owner_actor,
		null,
		"explicit null actor leaves ownership unknown",
	);
});

test("optional user observations remain absent without fabricated null", () => {
	for (const field of ["phone", "about"] as const) {
		const partial = { ...RAW_USER };
		delete partial[field];
		for (const [stream, parse] of [
			["profile", profileRecord],
			["friends", userRecord],
		] as const) {
			const record = parse(partial);
			assert.equal(record[field], undefined);
			assert.equal(validateRecord(stream, record).ok, true);
			assert.equal(Object.hasOwn(record, field), false);
		}
	}
});

test("partial payment snapshots cannot validate as complete", () => {
	for (const field of ["amount", "actor"] as const) {
		const payment = { ...RAW_PAY_STORY.payment };
		delete payment[field];
		const parsed = parseTransactionStory(
			{ ...RAW_PAY_STORY, payment },
			RAW_USER.id,
		);
		if (parsed.kind === "record") {
			assert.equal(validateRecord("transactions", parsed.record).ok, false);
			if (field === "actor")
				assert.notEqual(parsed.record.is_owner_actor, false);
		} else assert.equal(parsed.kind, "invalid");
	}
});

test("explicit source nulls remain null, including unknown actor ownership", () => {
	const user = { ...RAW_USER, phone: null, about: null };
	for (const parse of [profileRecord, userRecord]) {
		assert.equal(parse(user).phone, null);
		assert.equal(parse(user).about, null);
	}
	const record = validTransactionRecord(
		{
			...RAW_PAY_STORY,
			payment: {
				...RAW_PAY_STORY.payment,
				amount: null,
				note: null,
				actor: null,
			},
		},
		RAW_USER.id,
	);
	assert.equal(record.amount_cents, null);
	assert.equal(record.note, null);
	assert.equal(record.actor, null);
	assert.equal(record.is_owner_actor, null);
	assert.equal(validateRecord("transactions", record).ok, true);
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { streams: { name: string; schema: object }[] };
	const schema = manifest.streams.find(
		(s) => s.name === "transactions",
	)?.schema;
	assert.ok(schema);
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	addFormats.default(ajv);
	const manifestAccepts = ajv.compile(schema);
	assert.equal(
		manifestAccepts(record),
		true,
		JSON.stringify(manifestAccepts.errors),
	);
});

test("parseTransactionStory treats a payment without an action as unfinished, not unsupported", () => {
	const story = structuredClone(RAW_PAY_STORY);
	assert.ok(story.payment);
	delete story.payment.action;
	assert.deepEqual(parseTransactionStory(story, RAW_USER.id), {
		kind: "invalid",
		reason: "missing_action",
	});
});

test("optional payment note remains absent rather than a source null", () => {
	const payment = { ...RAW_PAY_STORY.payment };
	delete payment.note;
	const record = validTransactionRecord(
		{ ...RAW_PAY_STORY, payment },
		RAW_USER.id,
	);
	assert.equal(Object.hasOwn(record, "note"), false);
	assert.equal(validateRecord("transactions", record).ok, true);
});
