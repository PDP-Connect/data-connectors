// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import type { DiscoveryFetch, DiscoveryFetchResponse } from "./discovery.ts";
import { collectAddressBook } from "./index.ts";

const BOOK_URL = "https://contacts.example/addressbooks/owner/card/";
const BOOK_KEY = "https://contacts.example/addressbooks/owner/card";
const CONTACTS = [
	{
		href: "/addressbooks/owner/card/alice.vcf",
		uid: "alice",
		name: "Alice Example",
	},
	{ href: "/addressbooks/owner/card/bob.vcf", uid: "bob", name: "Bob Example" },
	{
		href: "/addressbooks/owner/card/carol.vcf",
		uid: "carol",
		name: "Carol Example",
	},
];

function response(text: string): DiscoveryFetchResponse {
	return {
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		}),
		headers: { get: () => null },
		status: 207,
	};
}

function memberResponse(contact: (typeof CONTACTS)[number]): string {
	return `<D:response><D:href>${contact.href}</D:href><D:propstat><D:prop><D:getetag>${contact.uid}</D:getetag></D:prop></D:propstat></D:response>`;
}

function vcardResponse(contact: (typeof CONTACTS)[number]): string {
	return `<D:response><D:href>${contact.href}</D:href><D:propstat><D:prop><D:getetag>${contact.uid}</D:getetag><C:address-data>BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${contact.uid}\r\nFN:${contact.name}\r\nEND:VCARD\r\n</C:address-data></D:prop></D:propstat></D:response>`;
}

const quietSyncResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:sync-token>next-token</D:sync-token></D:multistatus>`;
const initialSyncResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${CONTACTS.map(memberResponse).join("")}<D:sync-token>next-token</D:sync-token></D:multistatus>`;
const multigetResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${CONTACTS.map(vcardResponse).join("")}</D:multistatus>`;

test("collectAddressBook: legacy token without an initialization boundary re-enumerates iCloud-style member-only responses", async () => {
	const syncTokens: string[] = [];
	const fetchImpl: DiscoveryFetch = (_url, init) => {
		assert.equal(init.method, "REPORT");
		if (init.body?.includes("addressbook-multiget")) {
			return Promise.resolve(response(multigetResponse));
		}
		assert.match(init.body ?? "", /sync-collection/);
		const token =
			/<D:sync-token>(.*?)<\/D:sync-token>/.exec(init.body ?? "")?.[1] ?? "";
		syncTokens.push(token);
		return Promise.resolve(
			response(token ? quietSyncResponse : initialSyncResponse),
		);
	};
	const state = {
		contacts: {
			[BOOK_KEY]: { fingerprints: {}, sync_token: "legacy-token" },
		},
	};
	const newState: Record<string, unknown> = structuredClone(state);
	const records: RecordData[] = [];

	const result = await collectAddressBook({
		authHeader: "Basic fixture",
		book: { url: BOOK_URL },
		bookCursor: openFingerprintCursor({ fingerprints: {} }),
		collectionMode: undefined,
		emit: () => Promise.resolve(),
		emitRecord: (_stream, data) => {
			records.push(data);
			return Promise.resolve();
		},
		fetchImpl,
		newState,
		progress: () => Promise.resolve(),
		requested: new Map([["contacts", {}]]),
		state,
		trustedOrigins: ["https://contacts.example"],
	});

	assert.equal(records.length, 3);
	assert.equal(result.contactsConsidered, 3);
	assert.equal(result.contactsCovered, 3);
	assert.equal(result.contactsBoundaryEstablished, true);
	assert.deepEqual(
		syncTokens,
		[""],
		"legacy state must withhold its unproven token once",
	);
	const saved = newState.contacts as Record<
		string,
		{ initial_sync_completed?: boolean; sync_token?: string }
	>;
	assert.equal(saved[BOOK_KEY]?.initial_sync_completed, true);
	assert.equal(saved[BOOK_KEY]?.sync_token, "next-token");

	const followUpState = structuredClone(newState);
	const followUpRecords: RecordData[] = [];
	const followUp = await collectAddressBook({
		authHeader: "Basic fixture",
		book: { url: BOOK_URL },
		bookCursor: openFingerprintCursor({ fingerprints: {} }),
		collectionMode: undefined,
		emit: () => Promise.resolve(),
		emitRecord: (_stream, data) => {
			followUpRecords.push(data);
			return Promise.resolve();
		},
		fetchImpl,
		newState: followUpState,
		progress: () => Promise.resolve(),
		requested: new Map([["contacts", {}]]),
		state: newState,
		trustedOrigins: ["https://contacts.example"],
	});

	assert.equal(followUpRecords.length, 0);
	assert.equal(followUp.contactsBoundaryEstablished, false);
	assert.deepEqual(
		syncTokens,
		["", "next-token"],
		"the initialized follow-up must resume its quiet token",
	);
});
async function collectFixture(
	state: Record<string, unknown>,
	fetchImpl: DiscoveryFetch,
	requested = new Map([["contacts", {}]]),
) {
	const newState: Record<string, unknown> = structuredClone(state);
	const records: Array<{ stream: string; data: RecordData }> = [];
	const result = await collectAddressBook({
		authHeader: "Basic fixture",
		book: { url: BOOK_URL },
		bookCursor: openFingerprintCursor({ fingerprints: {} }),
		collectionMode: undefined,
		emit: () => Promise.resolve(),
		emitRecord: (stream, data) => {
			records.push({ stream, data });
			return Promise.resolve();
		},
		fetchImpl,
		newState,
		progress: () => Promise.resolve(),
		requested,
		state,
		trustedOrigins: ["https://contacts.example"],
	});
	return { newState, records, result };
}

function fullInventory(contacts: typeof CONTACTS): string {
	return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${contacts.map(vcardResponse).join("")}<D:sync-token>fixture-next</D:sync-token></D:multistatus>`;
}

test("full stale-token boundary prunes cursor inventory, quiet delta retains it", async () => {
	const initial = await collectFixture({}, () =>
		Promise.resolve(response(fullInventory(CONTACTS))),
	);
	const quiet = await collectFixture(initial.newState, () =>
		Promise.resolve(response(quietSyncResponse)),
	);
	let requests = 0;
	const resync = await collectFixture(initial.newState, () => {
		requests += 1;
		return Promise.resolve(
			requests === 1
				? { ...response(""), status: 507 }
				: response(fullInventory(CONTACTS.slice(0, 1))),
		);
	});
	const fingerprints = (value: Record<string, unknown>) =>
		(
			value.contacts as Record<string, { fingerprints: Record<string, string> }>
		)[BOOK_KEY]?.fingerprints ?? {};
	assert.equal(requests, 2);
	assert.equal(resync.result.contactsBoundaryEstablished, true);
	assert.equal(Object.keys(fingerprints(initial.newState)).length, 3);
	assert.equal(Object.keys(fingerprints(quiet.newState)).length, 3);
	assert.equal(Object.keys(fingerprints(resync.newState)).length, 1);
	assert.ok(
		(Object.keys(fingerprints(resync.newState))[0] ?? "").includes("alice.vcf"),
	);
	let fallbackRequests = 0;
	const fallback = await collectFixture(initial.newState, () => {
		fallbackRequests += 1;
		return Promise.resolve(
			fallbackRequests === 1
				? { ...response(""), status: 501 }
				: response(fullInventory(CONTACTS.slice(0, 1))),
		);
	});
	assert.equal(fallbackRequests, 2);
	assert.deepEqual(
		fingerprints(resync.newState),
		fingerprints(fallback.newState),
	);
	assert.equal(
		resync.records.filter(({ data }) => data.deleted === true).length,
		0,
		"like the fallback, pruning changes STATE, not explicit tombstone emission",
	);
});

test("CATEGORIES group member UIDs match emitted contact UIDs", async () => {
	const xml = fullInventory(CONTACTS).replaceAll(
		"END:VCARD",
		"CATEGORIES:Friends\r\nEND:VCARD",
	);
	const collected = await collectFixture(
		{},
		() => Promise.resolve(response(xml)),
		new Map([
			["contacts", {}],
			["contact_groups", {}],
		]),
	);
	const contacts = collected.records.filter(
		({ stream }) => stream === "contacts",
	);
	const groups = collected.records.filter(
		({ stream }) => stream === "contact_groups",
	);
	assert.equal(groups.length, 1);
	assert.deepEqual(
		groups[0]?.data.member_uids,
		contacts.map(({ data }) => data.uid),
	);
	assert.deepEqual(groups[0]?.data.member_uids, ["alice", "bob", "carol"]);
});
