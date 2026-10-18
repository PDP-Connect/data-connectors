// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectAllStreams } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const VALIDATE_URL = "https://setup.icloud.com/setup/ws/1/validate";
const NOTES_URL = "https://www.icloud.com/notes";
const CK_BASE = "https://p00-ckdatabasews.icloud.com:443";

// Synthetic source responses; no account data or live network is used.
function fixture(
	dsInfo: unknown,
	state: Record<string, unknown> = {},
	streams = ["profile"],
) {
	const harness = makeRecordingEmit(validateRecord);
	const calls: unknown[] = [];
	let href = NOTES_URL;
	const page = {
		url: () => href,
		evaluate: async (_fn: unknown, arg: unknown) => {
			if (arg === "icloud-notes-location") return href;
			if (arg === undefined) {
				return { href, readyState: "complete", blocked: false };
			}
			calls.push(arg);
			if (arg === VALIDATE_URL) {
				return {
					status: 200,
					json: { dsInfo, webservices: { ckdatabasews: { url: CK_BASE } } },
				};
			}
			return { status: 200, json: { records: [] } };
		},
	} as unknown as Page;
	const ctx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("unexpected assist");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-10-17T12:00:00.000Z",
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map(streams.map((name) => [name, { name }])),
		scope: { streams: streams.map((name) => ({ name })) },
		sendInteraction: async (): Promise<never> => {
			throw new Error("unexpected interaction");
		},
		state,
	};
	return {
		harness,
		calls,
		ctx,
		navigate: () => {
			href = "https://www.icloud.com/mail";
		},
	};
}

function profileState(harness: ReturnType<typeof makeRecordingEmit>) {
	const state = harness.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "profile",
	);
	assert.ok(state && state.type === "STATE");
	return state.cursor;
}

test("profile: emits the source fullName with its real dsid using only the existing validate request", async () => {
	const run = fixture({ dsid: "12345", fullName: " Zoë 李 " });
	await collectAllStreams(run.ctx);
	assert.deepEqual(run.calls, [VALIDATE_URL]);
	assert.equal(run.harness.emitted.length, 1);
	assert.equal(run.harness.emitted[0]?.stream, "profile");
	assert.deepEqual(run.harness.emitted[0]?.data, {
		id: "12345",
		user_name: " Zoë 李 ",
	});
	assert.equal(run.harness.skipped.length, 0);
	profileState(run.harness);
	assert.equal(run.harness.events[0]?.kind, "record");
	assert.equal(run.harness.events.at(-1)?.kind, "message");
});

test("profile: absent, blank, and malformed fullName are omitted without invented fallbacks", async () => {
	for (const fullName of [undefined, null, "", "   ", 42, {}, [], "x".repeat(501)]) {
		const run = fixture({
			dsid: "12345",
			fullName,
			appleId: "not-a-display-name@example.test",
		});
		await collectAllStreams(run.ctx);
		assert.deepEqual(run.harness.emitted[0]?.data, { id: "12345" });
		assert.equal(
			Object.hasOwn(run.harness.emitted[0]?.data ?? {}, "user_name"),
			false,
		);
		assert.equal(run.harness.skipped.length, 0);
		profileState(run.harness);
	}
});

test("profile: numeric account IDs remain source identities, while malformed identities never become synthetic keys", async () => {
	for (const dsid of [0, 12345]) {
		const run = fixture({ dsid, fullName: "Test User" });
		await collectAllStreams(run.ctx);
		assert.equal(run.harness.emitted[0]?.data.id, String(dsid));
	}
	for (const dsid of [
		undefined,
		null,
		"",
		" ",
		{},
		[],
		true,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
		"x".repeat(201),
	]) {
		const run = fixture({ dsid, fullName: "Test User" });
		await assert.rejects(collectAllStreams(run.ctx), /icloud_auth_failed/);
		assert.equal(run.harness.emitted.length, 0);
		assert.equal(run.harness.protocolMessages.length, 0);
	}
});

test("profile: fingerprinting suppresses unchanged data and emits changed or removed names", async () => {
	const first = fixture({ dsid: "12345", fullName: "First Name" });
	await collectAllStreams(first.ctx);
	const state = { profile: profileState(first.harness) };
	const same = fixture({ dsid: "12345", fullName: "First Name" }, state);
	await collectAllStreams(same.ctx);
	assert.equal(same.harness.emitted.length, 0);
	profileState(same.harness);
	const changed = fixture({ dsid: "12345", fullName: "New Name" }, state);
	await collectAllStreams(changed.ctx);
	assert.equal(changed.harness.emitted[0]?.data.user_name, "New Name");
	const removed = fixture(
		{ dsid: "12345" },
		{ profile: profileState(changed.harness) },
	);
	await collectAllStreams(removed.ctx);
	assert.deepEqual(removed.harness.emitted[0]?.data, { id: "12345" });
	const switched = fixture({ dsid: "67890", fullName: "Other Account" }, state);
	await collectAllStreams(switched.ctx);
	assert.deepEqual(switched.harness.emitted[0]?.data, {
		id: "67890",
		user_name: "Other Account",
	});
	assert.equal(
		JSON.stringify(profileState(switched.harness)).includes("12345"),
		false,
	);
});

test("profile: stream selection adds no profile calls or records when unrequested", async () => {
	const none = fixture({ dsid: "12345", fullName: "Test User" }, {}, []);
	await collectAllStreams(none.ctx);
	assert.equal(none.calls.length, 0);
	assert.equal(none.harness.emitted.length, 0);
	const notes = fixture({ dsid: "12345", fullName: "Test User" }, {}, ["notes"]);
	await collectAllStreams(notes.ctx);
	assert.equal(notes.calls.length, 3);
	assert.equal(notes.harness.emitted.length, 0);
	const all = fixture({ dsid: "12345", fullName: "Test User" }, {}, [
		"profile",
		"notes",
		"folders",
	]);
	await collectAllStreams(all.ctx);
	assert.equal(all.calls.length, 3);
	assert.equal(all.harness.emitted.length, 1);
	assert.equal(all.harness.emitted[0]?.stream, "profile");
});

test("profile: navigation during record delivery prevents a profile checkpoint", async () => {
	const run = fixture({ dsid: "12345", fullName: "Test User" });
	run.ctx.emitRecord = async (stream, data) => {
		await run.harness.emitRecord(stream, data);
		run.navigate();
	};
	await collectAllStreams(run.ctx);
	assert.equal(
		run.harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "profile",
		),
		false,
	);
	assert.ok(
		run.harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.stream === "profile" &&
				message.reason === "inventory_not_proven_complete" &&
				message.recovery_hint?.action === "retry_by_runtime" &&
				message.recovery_hint?.retryable === true &&
				(message.diagnostics as Record<string, unknown>)?.source_reason === "icloud_navigation_changed",
		),
	);
});

test("profile: manifest and runtime schema declare the optional source name and account primary key", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	);
	const profile = manifest.streams.find(
		(stream: { name: string }) => stream.name === "profile",
	);
	assert.ok(profile);
	assert.deepEqual(profile.primary_key, ["id"]);
	assert.deepEqual(profile.schema.required, ["id"]);
	assert.equal(profile.schema.properties.user_name.type, "string");
	assert.equal(validateRecord("profile", { id: "12345" }).ok, true);
	assert.equal(
		validateRecord("profile", { id: "12345", user_name: "Test User" }).ok,
		true,
	);
	assert.equal(validateRecord("profile", { id: "", user_name: "Test User" }).ok, false);
	assert.equal(validateRecord("profile", { id: "12345", user_name: null }).ok, false);
});
