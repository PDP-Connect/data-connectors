// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectInstinct,
	describeGraphqlErrors,
	graphqlEvaluateArgs,
	hasSignedInUser,
	instinctAllowsInteractiveAuthRepair,
	resolveConnectionGates,
} from "./index.ts";
import { nullableText, toIso } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { GraphqlFetchResult, InstinctGraphql } from "./types.ts";

const OBSERVED_AT = "2026-09-22T19:30:00.000Z";
const ALL_STREAMS = new Set([
	"agent_contact",
	"chat_events",
	"chats",
	"connections",
	"devices",
	"profile",
	"trusted_people",
	"vault_entries",
]);

interface SkipResult {
	readonly message?: unknown;
	readonly reason?: unknown;
	readonly stream?: unknown;
}

/** The SKIP_RESULT protocol messages the collector emitted, in order. */
function skipResults(harness: {
	protocolMessages: Array<{ type: string }>;
}): SkipResult[] {
	return harness.protocolMessages.filter(
		(message): message is { type: string } & SkipResult =>
			message.type === "SKIP_RESULT",
	);
}

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(fixturesDir("instinct"), `${name}.json`), "utf8"),
	) as unknown;
}

/** A fixture, or a function of the call's variables for paginated reads. */
type ScriptedResponse =
	| unknown
	| ((variables: Readonly<Record<string, unknown>>) => unknown);

/**
 * Route by the operation name baked into each GraphQL document. Matching on
 * the document rather than call order keeps the mock load-bearing: reorder
 * the collector and the mock still answers correctly, but rename or drop an
 * operation and the test fails loudly instead of silently returning the
 * wrong fixture.
 */
function scriptedGraphql(
	responses: Readonly<Record<string, ScriptedResponse>>,
	overrides: Readonly<Record<string, GraphqlFetchResult>> = {},
): { calls: string[]; graphql: InstinctGraphql; variables: unknown[] } {
	const calls: string[] = [];
	const variables: unknown[] = [];
	const graphql: InstinctGraphql = (query, vars) => {
		const match = /query Pdpp(\w+)/.exec(query);
		assert.ok(match, `unrecognized GraphQL document: ${query.slice(0, 60)}`);
		const operation = match[1] ?? "";
		calls.push(operation);
		variables.push(vars);
		const override = overrides[operation];
		if (override) {
			return Promise.resolve(override);
		}
		const scripted = responses[operation];
		assert.ok(
			scripted !== undefined,
			`no fixture wired for operation ${operation}`,
		);
		const json =
			typeof scripted === "function" ? scripted(vars ?? {}) : scripted;
		return Promise.resolve({ json, status: 200 });
	};
	return { calls, graphql, variables };
}

const MAIN_CHAT = "chat-01TESTMAINTESTTESTTESTTEST";
const WHATSAPP_CHAT = "chat-01TESTWHATSAPPTESTTESTTEST";

interface ChatHistoryPages {
	readonly page1: unknown;
	readonly page2: unknown;
	readonly whatsapp: unknown;
}

async function loadChatHistoryPages(): Promise<ChatHistoryPages> {
	const [page1, page2, whatsapp] = await Promise.all([
		fixture("chat-history-page1"),
		fixture("chat-history-page2"),
		fixture("chat-history-whatsapp"),
	]);
	return { page1, page2, whatsapp };
}

/**
 * Answer `chatHistory` by chat and cursor: the main chat has two windows
 * (newest first, then older behind `chat-cursor-page-2`), the WhatsApp chat
 * one. An unknown chat or cursor fails the test rather than guessing.
 */
function chatHistoryRouter(
	pages: ChatHistoryPages,
): (variables: Readonly<Record<string, unknown>>) => unknown {
	return (variables) => {
		if (variables.chatId === WHATSAPP_CHAT) {
			return pages.whatsapp;
		}
		assert.equal(variables.chatId, MAIN_CHAT, "unexpected chatId");
		if (variables.cursor === null || variables.cursor === undefined) {
			return pages.page1;
		}
		assert.equal(variables.cursor, "chat-cursor-page-2", "unexpected cursor");
		return pages.page2;
	};
}

async function loadHappyPathResponses(): Promise<
	Record<string, ScriptedResponse>
> {
	const [
		profile,
		agentContact,
		connections,
		messaging,
		imessage,
		devices,
		trusted,
		vault,
		chats,
		chatPages,
	] = await Promise.all([
		fixture("profile"),
		fixture("agent-contact"),
		fixture("connections"),
		fixture("messaging"),
		fixture("imessage-device"),
		fixture("devices"),
		fixture("trusted-network"),
		fixture("vault"),
		fixture("chats"),
		loadChatHistoryPages(),
	]);
	return {
		InstinctAgentContact: agentContact,
		InstinctChatHistory: chatHistoryRouter(chatPages),
		InstinctChats: chats,
		InstinctConnections: connections,
		InstinctDevices: devices,
		InstinctImessageDevice: imessage,
		InstinctMessaging: messaging,
		InstinctProfile: profile,
		InstinctTrustedNetwork: trusted,
		InstinctVault: vault,
	};
}

test("collectInstinct emits every stream, every record schema-valid", async () => {
	const source = scriptedGraphql(await loadHappyPathResponses());
	const harness = makeRecordingEmit(validateRecord);

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			// progress is runtime-owned; the collector only needs it callable.
		},
		requested: ALL_STREAMS,
	});

	const streams = new Set(harness.emitted.map((record) => record.stream));
	assert.deepEqual([...streams].sort(), [...ALL_STREAMS].sort());
	assert.equal(
		skipResults(harness).length,
		0,
		"happy path must not skip a stream",
	);
	assert.equal(
		harness.skipped.length,
		0,
		"every emitted record must pass its schema",
	);

	const profile = harness.emitted.find(
		(record) => record.stream === "profile",
	)?.data;
	assert.equal(profile?.id, "user-01TESTTESTTESTTESTTESTTEST");
	assert.equal(profile?.agent_to_agent_enabled, true);
	assert.equal(profile?.has_location_data, false);
	assert.equal(profile?.observed_at, OBSERVED_AT);

	const agentContact = harness.emitted.find(
		(record) => record.stream === "agent_contact",
	)?.data;
	assert.equal(agentContact?.id, "agent_contact");
	assert.equal(agentContact?.email, "adalovelace@mail.instinct.com");
});

test("connections flatten every provider into stable `<provider>:<id>` keys", async () => {
	const source = scriptedGraphql(await loadHappyPathResponses());
	const harness = makeRecordingEmit(validateRecord);

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: new Set(["connections"]),
	});

	const ids = harness.emitted
		.filter((record) => record.stream === "connections")
		.map((record) => String(record.data.id))
		.sort();
	assert.deepEqual(ids, [
		"github:gh-conn-01TEST",
		"google_workspace:gw-conn-01TEST",
		"imessage:device-01TEST",
		"linear:lin-conn-01TEST",
		"slack:T0TEST",
		"stripe_link:default",
		"whatsapp:user-01TESTTESTTESTTESTTESTTEST",
	]);

	// The local iMessage relay supersedes the iCloud-email-only record rather
	// than emitting a second iMessage connection under a different key.
	const imessage = harness.emitted.filter(
		(record) =>
			record.stream === "connections" && record.data.provider === "imessage",
	);
	assert.equal(imessage.length, 1);
	assert.equal(imessage[0]?.data.account_name, "ada@icloud.example");

	const google = harness.emitted.find(
		(record) => record.data.id === "google_workspace:gw-conn-01TEST",
	)?.data;
	assert.deepEqual(google?.services, [
		{
			connected: true,
			label: "Gmail",
			notification_issue: false,
			read_only: false,
			service_id: "gmail",
		},
		{
			connected: true,
			label: "Calendar",
			notification_issue: false,
			read_only: true,
			service_id: "calendar",
		},
		{
			connected: false,
			label: "Drive",
			notification_issue: null,
			read_only: null,
			service_id: "drive",
		},
	]);
});

test("a failed GraphQL path skips that stream instead of losing the run", async () => {
	const responses = await loadHappyPathResponses();
	const source = scriptedGraphql(responses, {
		InstinctConnections: {
			json: await fixture("connections-partial-error"),
			status: 200,
		},
		InstinctImessageDevice: {
			json: await fixture("imessage-device-error"),
			status: 200,
		},
	});
	const harness = makeRecordingEmit(validateRecord);

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: ALL_STREAMS,
	});

	const skip = skipResults(harness).find(
		(entry) => entry.stream === "connections",
	);
	assert.ok(skip, "the failed resolver must surface as a SKIP_RESULT");
	assert.match(String(skip.message), /whoopConnection/);
	assert.match(String(skip.message), /imessageLocalConnection/);

	// Everything that did not depend on the broken resolver still collected,
	// and WhatsApp still made it through from the healthy messaging query.
	assert.ok(
		harness.emitted.some((record) => record.stream === "profile"),
		"profile must survive a connections-side failure",
	);
	assert.ok(
		harness.emitted.some(
			(record) => record.data.id === "whatsapp:user-01TESTTESTTESTTESTTESTTEST",
		),
		"healthy messaging records must still be emitted",
	);
});

test("trusted-network pagination dedupes the unpaginated sent requests", async () => {
	const responses = await loadHappyPathResponses();
	let page = 0;
	const pages = [
		await fixture("trusted-network-page1"),
		await fixture("trusted-network-page2"),
	];
	const harness = makeRecordingEmit(validateRecord);
	const graphql: InstinctGraphql = (query) => {
		if (query.includes("PdppInstinctTrustedNetwork")) {
			const json = pages[Math.min(page, pages.length - 1)];
			page += 1;
			return Promise.resolve({ json, status: 200 });
		}
		const match = /query Pdpp(\w+)/.exec(query);
		return Promise.resolve({
			json: responses[match?.[1] ?? ""],
			status: 200,
		});
	};

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: new Set(["trusted_people"]),
	});

	const ids = harness.emitted.map((record) => String(record.data.id)).sort();
	assert.deepEqual(ids, [
		"contact:tn-contact-01TEST",
		"contact:tn-contact-02TEST",
		"sent_request:tn-sent-01TEST",
	]);
	assert.equal(page, 2, "pagination must stop when every cursor is null");
});

test("vault records are an inventory: names and field keys, never values", async () => {
	const source = scriptedGraphql(await loadHappyPathResponses());
	const harness = makeRecordingEmit(validateRecord);

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: new Set(["vault_entries"]),
	});

	const login = harness.emitted.find(
		(record) => record.data.id === "login:Example Airline",
	)?.data;
	assert.deepEqual(login?.field_keys, ["password", "totp", "username"]);
	assert.deepEqual(login?.populated_field_keys, ["password", "username"]);

	// The emitted rows must carry field *names* only — no field the connector
	// emits may hold anything that looks like a stored secret value.
	const serialized = JSON.stringify(harness.emitted);
	assert.ok(
		!serialized.includes('"value"'),
		"no vault record may carry a value field",
	);
});

test("connection feature gates follow the account's own flags", () => {
	assert.deepEqual(resolveConnectionGates(["link_payments", "agent_mail"]), {
		showStripeLink: true,
		showWhoop: false,
	});
	assert.deepEqual(resolveConnectionGates([]), {
		showStripeLink: false,
		showWhoop: false,
	});
	assert.deepEqual(resolveConnectionGates(["whoop", "link_payments"]), {
		showStripeLink: true,
		showWhoop: true,
	});
});

test("the connections query asks only for the resolvers the account is flagged for", async () => {
	const source = scriptedGraphql(await loadHappyPathResponses());
	const harness = makeRecordingEmit(validateRecord);

	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: new Set(["connections"]),
	});

	const connectionsCall = source.calls.indexOf("InstinctConnections");
	assert.ok(connectionsCall >= 0);
	// profile.json carries link_payments but not whoop.
	assert.deepEqual(source.variables[connectionsCall], {
		showStripeLink: true,
		showWhoop: false,
	});
});

test("toIso accepts epoch seconds, epoch millis, and ISO; rejects the rest", () => {
	assert.equal(toIso(1_789_068_259), "2026-09-10T19:24:19.000Z");
	assert.equal(toIso(1_789_068_259_000), "2026-09-10T19:24:19.000Z");
	assert.equal(toIso("1789068259"), "2026-09-10T19:24:19.000Z");
	assert.equal(toIso("2026-08-01T12:00:00.000Z"), "2026-08-01T12:00:00.000Z");
	assert.equal(toIso(null), null);
	assert.equal(toIso(undefined), null);
	assert.equal(toIso(""), null);
	assert.equal(toIso("   "), null);
	assert.equal(toIso("not a date"), null);
	assert.equal(toIso({}), null);
});

test("nullableText treats blank strings as unset rather than empty values", () => {
	assert.equal(nullableText("  ada  "), "ada");
	assert.equal(nullableText(""), null);
	assert.equal(nullableText("   "), null);
	assert.equal(nullableText(null), null);
	assert.equal(nullableText(42), null);
});

test("hasSignedInUser distinguishes a live session from a signed-out one", async () => {
	assert.equal(hasSignedInUser(await fixture("profile")), true);
	assert.equal(hasSignedInUser({ data: { authSession: null } }), false);
	assert.equal(hasSignedInUser({ data: null }), false);
	assert.equal(hasSignedInUser(null), false);
	assert.equal(hasSignedInUser("<!doctype html>"), false);
});

test("describeGraphqlErrors names the failing path", () => {
	assert.equal(describeGraphqlErrors(null), null);
	assert.equal(describeGraphqlErrors([]), null);
	assert.equal(
		describeGraphqlErrors([
			{ message: "internal server error", path: ["whoopConnection"] },
			{ message: "boom" },
		]),
		"whoopConnection: internal server error; boom",
	);
});

test("only a manual run may open an interactive login", () => {
	assert.equal(instinctAllowsInteractiveAuthRepair({}), true);
	assert.equal(
		instinctAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "manual" }),
		true,
	);
	assert.equal(
		instinctAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "schedule" }),
		false,
	);
});

test("every operation posts to Instinct's single GraphQL path", () => {
	const args = graphqlEvaluateArgs(
		"query PdppInstinctProfile { authSession { user { id } } }",
	);
	const url = new URL(args.apiUrl);

	assert.ok(
		url.pathname === "/-/api/graphql",
		`expected the GraphQL path, got ${url.pathname}`,
	);
	assert.equal(url.host, "api.instinct.com");
	assert.equal(url.protocol, "https:");
	assert.deepEqual(args.vars, {});
	assert.match(args.document, /PdppInstinctProfile/);

	// Variables ride in the POST body, never the path — the connector has
	// exactly one endpoint and discriminates by operation.
	const withVars = graphqlEvaluateArgs("query PdppInstinctConnections { a }", {
		showStripeLink: true,
		showWhoop: false,
	});
	assert.ok(new URL(withVars.apiUrl).pathname === "/-/api/graphql");
	assert.deepEqual(withVars.vars, { showStripeLink: true, showWhoop: false });
});

interface ChatRun {
	readonly harness: ReturnType<typeof makeRecordingEmit>;
	readonly source: ReturnType<typeof scriptedGraphql>;
}

async function runChats(
	options: {
		readonly overrides?: Readonly<Record<string, ScriptedResponse>>;
		readonly state?: Readonly<Record<string, unknown>>;
	} = {},
): Promise<ChatRun> {
	const responses = {
		...(await loadHappyPathResponses()),
		...options.overrides,
	};
	const source = scriptedGraphql(responses);
	const harness = makeRecordingEmit(validateRecord);
	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		requested: new Set(["chats", "chat_events"]),
		state: options.state ?? {},
	});
	return { harness, source };
}

function chatEventIds(harness: ChatRun["harness"]): string[] {
	return harness.emitted
		.filter((record) => record.stream === "chat_events")
		.map((record) => String(record.data.id));
}

/** The `chat_events` STATE cursor the run ended with, as START would hand it back. */
function chatEventsState(harness: ChatRun["harness"]): Record<string, unknown> {
	const state = harness.protocolMessages.findLast(
		(message) =>
			message.type === "STATE" &&
			(message as { stream?: unknown }).stream === "chat_events",
	) as { cursor?: unknown } | undefined;
	assert.ok(state, "chat_events must end with a STATE checkpoint");
	return { chat_events: { cursor: state.cursor } };
}

function historyCalls(
	source: ChatRun["source"],
	chatId: string,
): Array<Readonly<Record<string, unknown>>> {
	return source.calls
		.map((operation, index) => ({
			operation,
			vars: source.variables[index] as Readonly<Record<string, unknown>>,
		}))
		.filter(
			(call) =>
				call.operation === "InstinctChatHistory" && call.vars.chatId === chatId,
		)
		.map((call) => call.vars);
}

test("a first chat run backfills every history page, every record schema-valid", async () => {
	const { harness, source } = await runChats();

	assert.equal(harness.skipped.length, 0, "every chat record must pass");
	assert.equal(skipResults(harness).length, 0);

	const chats = harness.emitted
		.filter((record) => record.stream === "chats")
		.map((record) => String(record.data.id))
		.sort();
	assert.deepEqual(chats, [MAIN_CHAT, WHATSAPP_CHAT].sort());

	// 8 events on the newest window, 5 on the older one, 1 in WhatsApp.
	assert.equal(chatEventIds(harness).length, 14);
	assert.deepEqual(
		historyCalls(source, MAIN_CHAT).map((vars) => vars.cursor),
		[null, "chat-cursor-page-2"],
	);
	assert.equal(historyCalls(source, WHATSAPP_CHAT).length, 1);

	// Emitted oldest first even though Instinct pages newest first.
	const mainCreated = harness.emitted
		.filter(
			(record) =>
				record.stream === "chat_events" && record.data.chat_id === MAIN_CHAT,
		)
		.map((record) => String(record.data.created_at));
	assert.deepEqual(mainCreated, [...mainCreated].sort());

	const invocation = harness.emitted.find(
		(record) => record.data.type === "tool_invocation",
	)?.data;
	assert.equal(invocation?.tool_name, "send_whatsapp_message");
	assert.equal(invocation?.tool_call_id, "call-01TEST");
	assert.match(String(invocation?.tool_arguments), /table for two/);
});

test("a repeat run with the prior STATE emits no events and stops on the first page", async () => {
	const first = await runChats();
	const { harness, source } = await runChats({
		state: chatEventsState(first.harness),
	});

	assert.equal(harness.skipped.length, 0);
	assert.deepEqual(chatEventIds(harness), []);
	assert.deepEqual(
		historyCalls(source, MAIN_CHAT).map((vars) => vars.cursor),
		[null],
		"paging must stop at the first window that reaches collected events",
	);
	// The checkpoint carries forward unchanged.
	assert.deepEqual(chatEventsState(harness), chatEventsState(first.harness));
});

test("a new event in the checkpoint's own second is collected, the old ones are not", async () => {
	const first = await runChats();
	const page1 = (await fixture("chat-history-page1")) as {
		data: { chatHistory: { cursor: string | null; events: unknown[] } };
	};
	const sameSecond = {
		createdAt: 1_789_070_050,
		id: "00000000-0000-4000-8000-000000000109",
		message: {
			attachments: [],
			content: "Thanks, that works.",
			id: "msg-0109TEST",
			origin: null,
			readAt: null,
			role: "user",
		},
		type: "message",
	};
	page1.data.chatHistory.events.push(sameSecond);
	const pages = await loadChatHistoryPages();

	const { harness } = await runChats({
		overrides: {
			InstinctChatHistory: chatHistoryRouter({ ...pages, page1 }),
		},
		state: chatEventsState(first.harness),
	});

	// Events 107 and 108 share 1789070050 with the new one; only the new id
	// is past the checkpoint.
	assert.deepEqual(chatEventIds(harness), [sameSecond.id]);
	const state = chatEventsState(harness) as {
		chat_events: {
			cursor: {
				chats: Record<
					string,
					{ newest_created_at: number; newest_ids: string[] }
				>;
			};
		};
	};
	assert.deepEqual(state.chat_events.cursor.chats[MAIN_CHAT], {
		newest_created_at: 1_789_070_050,
		newest_ids: [
			"00000000-0000-4000-8000-000000000107",
			"00000000-0000-4000-8000-000000000108",
			sameSecond.id,
		],
	});
});

test("a chatHistory failure on one chat skips it and still collects the other", async () => {
	const pages = await loadChatHistoryPages();
	const failure = await fixture("chat-history-error");
	const healthy = chatHistoryRouter(pages);
	const { harness } = await runChats({
		overrides: {
			InstinctChatHistory: (variables: Readonly<Record<string, unknown>>) =>
				variables.chatId === MAIN_CHAT ? failure : healthy(variables),
		},
	});

	const skip = skipResults(harness).find(
		(entry) => entry.stream === "chat_events",
	);
	assert.ok(skip, "the failed chat must surface as a SKIP_RESULT");
	assert.match(String(skip.message), new RegExp(MAIN_CHAT));
	assert.match(String(skip.message), /internal server error/);

	assert.deepEqual(chatEventIds(harness), [
		"00000000-0000-4000-8000-000000000201",
	]);
	// The failed chat keeps no checkpoint, so the next run backfills it.
	const state = chatEventsState(harness) as {
		chat_events: { cursor: { chats: Record<string, unknown> } };
	};
	assert.deepEqual(Object.keys(state.chat_events.cursor.chats), [
		WHATSAPP_CHAT,
	]);
});

test("chat events never carry attachment or screenshot links", async () => {
	const { harness } = await runChats();

	const serialized = JSON.stringify(harness.emitted);
	assert.ok(!serialized.includes("signedUrl"), "no signedUrl may be emitted");
	assert.ok(!serialized.includes('"url"'), "no url field may be emitted");
	assert.ok(
		!serialized.includes("files.example.invalid"),
		"no link value may be emitted",
	);

	const screenshot = harness.emitted.find(
		(record) => record.data.type === "screenshot",
	)?.data;
	assert.equal(screenshot?.has_screenshot, true);
	const withAttachment = harness.emitted.find(
		(record) => record.data.message_id === "msg-0091TEST",
	)?.data;
	assert.deepEqual(withAttachment?.attachments, [
		{
			byte_size: 20_480,
			filename: "week.pdf",
			id: "att-01TEST",
			kind: "file",
			mime_type: "application/pdf",
		},
	]);
});

test("chat event epoch-second timestamps become ISO", async () => {
	const { harness } = await runChats();

	const first = harness.emitted.find(
		(record) => record.data.id === "00000000-0000-4000-8000-000000000101",
	)?.data;
	assert.equal(first?.created_at, "2026-09-10T19:53:20.000Z");
	assert.equal(first?.read_at, "2026-09-10T19:53:23.000Z");

	const main = harness.emitted.find(
		(record) => record.stream === "chats" && record.data.id === MAIN_CHAT,
	)?.data;
	assert.equal(main?.pending_turn_started_at, "2026-09-10T19:55:00.000Z");

	for (const record of harness.emitted) {
		if (record.stream === "chat_events") {
			assert.match(
				String(record.data.created_at),
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/,
			);
		}
	}
});
