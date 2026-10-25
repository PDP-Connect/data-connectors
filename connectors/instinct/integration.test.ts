// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type CollectInstinctArgs,
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
): {
	calls: string[];
	documents: string[];
	graphql: InstinctGraphql;
	variables: unknown[];
} {
	const calls: string[] = [];
	const documents: string[] = [];
	const variables: unknown[] = [];
	const graphql: InstinctGraphql = (query, vars) => {
		const match = /query Pdpp(\w+)/.exec(query);
		assert.ok(match, `unrecognized GraphQL document: ${query.slice(0, 60)}`);
		const operation = match[1] ?? "";
		calls.push(operation);
		documents.push(query);
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
	return { calls, documents, graphql, variables };
}

interface StreamFailureReport {
	readonly message: string;
	readonly retryable: boolean | undefined;
	readonly stream: string;
}

/**
 * Stands in for the runtime's `reportStreamFailure`: records each report and
 * puts the SKIP_RESULT the runtime would emit on the recorded wire.
 */
function failureRecorder(harness: ReturnType<typeof makeRecordingEmit>): {
	report: NonNullable<CollectInstinctArgs["reportStreamFailure"]>;
	reports: StreamFailureReport[];
} {
	const reports: StreamFailureReport[] = [];
	return {
		report: async (stream, message, options = {}) => {
			reports.push({ message, retryable: options.retryable, stream });
			await harness.emit({
				message,
				reason: "stream_collection_failed",
				recovery_hint: {
					action: "retry_by_runtime",
					retryable: options.retryable === true,
				},
				stream,
				type: "SKIP_RESULT",
			});
		},
		reports,
	};
}

type WireMessage = { type: string } & Record<string, unknown>;

function wire(harness: ReturnType<typeof makeRecordingEmit>): WireMessage[] {
	return harness.protocolMessages as unknown as WireMessage[];
}

/** Streams the run checkpointed, in order. */
function stateStreams(harness: ReturnType<typeof makeRecordingEmit>): string[] {
	return wire(harness)
		.filter((message) => message.type === "STATE")
		.map((message) => String(message.stream));
}

/** Run collectInstinct over the happy-path fixtures with some operations replaced. */
async function runCollect(
	requested: ReadonlySet<string>,
	overrides: Readonly<Record<string, ScriptedResponse>> = {},
	transport: Readonly<Record<string, GraphqlFetchResult>> = {},
): Promise<{
	failures: StreamFailureReport[];
	harness: ReturnType<typeof makeRecordingEmit>;
	source: ReturnType<typeof scriptedGraphql>;
}> {
	const source = scriptedGraphql(
		{ ...(await loadHappyPathResponses()), ...overrides },
		transport,
	);
	const harness = makeRecordingEmit(validateRecord);
	const failures = failureRecorder(harness);
	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		reportStreamFailure: failures.report,
		requested,
	});
	return { failures: failures.reports, harness, source };
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
		readonly collectionMode?: "full_refresh" | "incremental";
		readonly detailGaps?: CollectInstinctArgs["detailGaps"];
		readonly overrides?: Readonly<Record<string, ScriptedResponse>>;
		readonly recoveryOnly?: boolean;
		readonly requestDetailGapPage?: CollectInstinctArgs["requestDetailGapPage"];
		readonly state?: Readonly<Record<string, unknown>>;
	} = {},
): Promise<ChatRun & { failures: StreamFailureReport[] }> {
	const responses = {
		...(await loadHappyPathResponses()),
		...options.overrides,
	};
	const source = scriptedGraphql(responses);
	const harness = makeRecordingEmit(validateRecord);
	const failures = failureRecorder(harness);
	await collectInstinct({
		...(options.collectionMode
			? { collectionMode: options.collectionMode }
			: {}),
		detailGaps: options.detailGaps ?? [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		recoveryOnly: options.recoveryOnly === true,
		reportStreamFailure: failures.report,
		...(options.requestDetailGapPage
			? { requestDetailGapPage: options.requestDetailGapPage }
			: {}),
		requested: new Set(["chats", "chat_events"]),
		state: options.state ?? {},
	});
	return { failures: failures.reports, harness, source };
}

function chatEventIds(harness: ChatRun["harness"]): string[] {
	return harness.emitted
		.filter((record) => record.stream === "chat_events")
		.map((record) => String(record.data.id));
}

/**
 * The chats STATE cursor the run ended with, as START would hand it back.
 * It carries the per-chat event checkpoints: chat_events is a parent-detail
 * stream with no STATE of its own.
 */
function chatEventsState(harness: ChatRun["harness"]): Record<string, unknown> {
	const state = harness.protocolMessages.findLast(
		(message) =>
			message.type === "STATE" &&
			(message as { stream?: unknown }).stream === "chats",
	) as { cursor?: unknown } | undefined;
	assert.ok(state, "chats must end with a STATE checkpoint");
	// Hosts hand back the last cursor unwrapped: START.state[stream] = cursor.
	return { chats: state.cursor };
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
		chats: {
			chats: Record<
				string,
				{ newest_created_at: number; newest_ids: string[] }
			>;
		};
	};
	assert.deepEqual(state.chats.chats[MAIN_CHAT], {
		newest_created_at: 1_789_070_050,
		newest_ids: [
			"00000000-0000-4000-8000-000000000107",
			"00000000-0000-4000-8000-000000000108",
			sameSecond.id,
		],
	});
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

// ─── Completeness on the current runtime ───────────────────────────────────

const LIST_STREAMS = [
	"connections",
	"devices",
	"trusted_people",
	"vault_entries",
	"chats",
] as const;

test("every proven list ends with full-scan coverage, then its STATE", async () => {
	const { failures, harness } = await runCollect(ALL_STREAMS);
	assert.deepEqual(failures, []);
	const messages = wire(harness);
	for (const stream of LIST_STREAMS) {
		const coverageAt = messages.findIndex(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === stream &&
				message.state_stream === stream,
		);
		const stateAt = messages.findIndex(
			(message) => message.type === "STATE" && message.stream === stream,
		);
		assert.ok(coverageAt >= 0, `${stream} must report full-scan coverage`);
		assert.ok(stateAt > coverageAt, `${stream} STATE must follow its coverage`);
		const emitted = harness.emitted.filter(
			(record) => record.stream === stream,
		).length;
		assert.equal(messages[coverageAt]?.considered, emitted);
		assert.equal(messages[coverageAt]?.covered, emitted);
	}
	const chatCoverage = messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "chat_events",
	);
	assert.ok(chatCoverage, "chat_events must report its per-chat coverage");
	assert.deepEqual(
		[...(chatCoverage.required_keys as string[])].sort(),
		[MAIN_CHAT, WHATSAPP_CHAT].sort(),
	);
	assert.deepEqual(chatCoverage?.hydrated_keys, chatCoverage?.required_keys);
	assert.equal(chatCoverage?.gap_keys, undefined);
});

test("a GraphQL error on connected services fails that stream with no checkpoint; the rest completes", async () => {
	const { failures, harness } = await runCollect(ALL_STREAMS, {
		InstinctConnections: await fixture("connections-partial-error"),
	});
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.stream, "connections");
	assert.equal(failures[0]?.retryable, true);
	assert.match(String(failures[0]?.message), /whoopConnection/);
	assert.ok(!stateStreams(harness).includes("connections"));
	assert.ok(
		!harness.emitted.some((record) => record.stream === "connections"),
		"a failed list emits no partial inventory",
	);
	for (const stream of [
		"profile",
		"agent_contact",
		"devices",
		"trusted_people",
		"vault_entries",
		"chats",
	]) {
		assert.ok(stateStreams(harness).includes(stream), `${stream} checkpoints`);
	}
});

test("Instinct's no-relay answer on the local iMessage read is not a failure", async () => {
	const { failures, harness } = await runCollect(new Set(["connections"]), {
		InstinctImessageDevice: await fixture("imessage-device-error"),
	});
	assert.deepEqual(failures, []);
	assert.ok(
		!wire(harness).some((message) => message.type === "SKIP_RESULT"),
		"the no-relay answer is not reported as a skipped part of the stream",
	);
	assert.deepEqual(stateStreams(harness), ["connections"]);
	const imessage = harness.emitted.filter(
		(record) => record.data.provider === "imessage",
	);
	assert.equal(imessage.length, 1);
	assert.equal(imessage[0]?.data.id, "imessage:default");
	assert.equal(imessage[0]?.data.account_email, "ada@icloud.example");
});

test("any other error on the local iMessage read fails connections", async () => {
	const { failures, harness } = await runCollect(new Set(["connections"]), {
		InstinctImessageDevice: {
			data: { imessageLocalConnection: null },
			errors: [
				{ message: "relay timed out", path: ["imessageLocalConnection"] },
			],
		},
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["connections"],
	);
	assert.deepEqual(stateStreams(harness), []);
});

test("a 500 on one stream fails that stream only, retryably", async () => {
	const { failures, harness } = await runCollect(
		ALL_STREAMS,
		{},
		{ InstinctDevices: { json: null, status: 500 } },
	);
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["devices"],
	);
	assert.equal(failures[0]?.retryable, true);
	assert.ok(!stateStreams(harness).includes("devices"));
	assert.ok(stateStreams(harness).includes("chats"));
});

test("an unrecognised answer fails the stream as not retryable", async () => {
	const { failures } = await runCollect(new Set(["vault_entries"]), {
		InstinctVault: { data: { vaultEntries: [{ kind: 7 }] } },
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["vault_entries"],
	);
	assert.equal(failures[0]?.retryable, false);
});

test("a GraphQL error on devices fails devices with no checkpoint", async () => {
	const { failures, harness } = await runCollect(new Set(["devices"]), {
		InstinctDevices: {
			data: { devices: null },
			errors: [{ message: "internal server error", path: ["devices"] }],
		},
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["devices"],
	);
	assert.deepEqual(stateStreams(harness), []);
});

test("a signed-out answer mid-run stops the whole run with a bare code", async () => {
	await assert.rejects(
		runCollect(ALL_STREAMS, {}, { InstinctVault: { json: null, status: 401 } }),
		(error: unknown) =>
			(error as { code?: unknown }).code === "instinct_auth_failed",
	);
});

interface TrustedPage {
	readonly cursor: string | null;
	readonly items: readonly Record<string, unknown>[];
}

function person(id: string): Record<string, unknown> {
	return {
		createdAt: 1_789_068_259,
		displayName: `Person ${id}`,
		generation: 1,
		id,
		phoneNumbers: ["+15550100000"],
	};
}

/** Answer the trusted-network query per list from its own cursor. */
function trustedRouter(lists: {
	readonly blocked?: Readonly<Record<string, TrustedPage>>;
	readonly contacts: Readonly<Record<string, TrustedPage>>;
	readonly requests: Readonly<Record<string, TrustedPage>>;
	readonly sent?: readonly Record<string, unknown>[];
}): (variables: Readonly<Record<string, unknown>>) => unknown {
	const page = (
		table: Readonly<Record<string, TrustedPage>>,
		cursor: unknown,
	): TrustedPage => {
		const key = typeof cursor === "string" ? cursor : "start";
		const found = table[key];
		assert.ok(found, `unexpected trusted cursor ${key}`);
		return found;
	};
	return (variables) => ({
		data: {
			agentToAgentSettings: { enabled: true },
			trustedNetworkBlockedPeople: page(
				lists.blocked ?? { start: { cursor: null, items: [] } },
				variables.blockedCursor,
			),
			trustedNetworkContacts: page(lists.contacts, variables.contactsCursor),
			trustedNetworkRequests: page(lists.requests, variables.requestsCursor),
			trustedNetworkSentRequests: lists.sent ?? [],
		},
	});
}

test("a trust list that ends early does not restart while another keeps paging", async () => {
	const { failures, harness, source } = await runCollect(
		new Set(["trusted_people"]),
		{
			InstinctTrustedNetwork: trustedRouter({
				contacts: {
					c2: { cursor: null, items: [person("c-2")] },
					start: { cursor: "c2", items: [person("c-1")] },
				},
				requests: {
					r2: { cursor: "r3", items: [person("r-2")] },
					r3: { cursor: null, items: [person("r-3")] },
					start: { cursor: "r2", items: [person("r-1")] },
				},
			}),
		},
	);
	assert.deepEqual(failures, []);
	assert.equal(
		source.calls.filter((call) => call === "InstinctTrustedNetwork").length,
		3,
	);
	assert.deepEqual(
		harness.emitted.map((record) => String(record.data.id)).sort(),
		[
			"contact:c-1",
			"contact:c-2",
			"incoming_request:r-1",
			"incoming_request:r-2",
			"incoming_request:r-3",
		],
	);
	assert.deepEqual(stateStreams(harness), ["trusted_people"]);
});

test("a full page of sent trust requests cannot be proven complete", async () => {
	const sent = Array.from({ length: 20 }, (_, index) => ({
		createdAt: 1_789_068_400,
		expiresAt: 1_789_154_800,
		id: `sent-${String(index)}`,
		phoneNumber: "+15550105555",
	}));
	const { failures, harness } = await runCollect(new Set(["trusted_people"]), {
		InstinctTrustedNetwork: trustedRouter({
			contacts: { start: { cursor: null, items: [] } },
			requests: { start: { cursor: null, items: [] } },
			sent,
		}),
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["trusted_people"],
	);
	assert.equal(failures[0]?.retryable, false);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("a trust-list cursor that comes back again fails the stream instead of the run", async () => {
	const { failures, harness } = await runCollect(new Set(["trusted_people"]), {
		InstinctTrustedNetwork: trustedRouter({
			contacts: {
				again: { cursor: "again", items: [person("c-2")] },
				start: { cursor: "again", items: [person("c-1")] },
			},
			requests: { start: { cursor: null, items: [] } },
		}),
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["trusted_people"],
	);
	assert.deepEqual(stateStreams(harness), []);
});

test("a chat-list cursor that repeats fails chats and chat_events with no checkpoint", async () => {
	const chats = (await fixture("chats")) as {
		data: { chats: { cursor: string | null } };
	};
	chats.data.chats.cursor = "again";
	const { failures, harness, source } = await runChats({
		overrides: { InstinctChats: chats },
	});
	assert.deepEqual(failures.map((failure) => failure.stream).sort(), [
		"chat_events",
		"chats",
	]);
	assert.deepEqual(stateStreams(harness), []);
	assert.ok(!source.calls.includes("InstinctChatHistory"));
});

function failingMainChat(
	pages: ChatHistoryPages,
	failure: unknown,
): (variables: Readonly<Record<string, unknown>>) => unknown {
	const healthy = chatHistoryRouter(pages);
	return (variables) =>
		variables.chatId === MAIN_CHAT ? failure : healthy(variables);
}

test("a chat whose history fails gets a DETAIL_GAP; the other chat checkpoints", async () => {
	const pages = await loadChatHistoryPages();
	const { failures, harness } = await runChats({
		overrides: {
			InstinctChatHistory: failingMainChat(
				pages,
				await fixture("chat-history-error"),
			),
		},
	});
	assert.deepEqual(failures, []);
	const gap = wire(harness).find((message) => message.type === "DETAIL_GAP");
	assert.equal(gap?.stream, "chat_events");
	assert.equal(gap?.parent_stream, "chats");
	assert.equal(gap?.record_key, MAIN_CHAT);
	assert.equal(gap?.reason, "temporary_unavailable");
	assert.deepEqual(gap?.detail_locator, {
		chat_id: MAIN_CHAT,
		kind: "instinct.chat_history",
	});
	const coverage = wire(harness).find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "chat_events",
	);
	assert.deepEqual(coverage?.gap_keys, [MAIN_CHAT]);
	assert.deepEqual(coverage?.hydrated_keys, [WHATSAPP_CHAT]);
	assert.deepEqual(chatEventIds(harness), [
		"00000000-0000-4000-8000-000000000201",
	]);
	const state = chatEventsState(harness) as {
		chats: { chats: Record<string, unknown> };
	};
	assert.deepEqual(Object.keys(state.chats.chats), [WHATSAPP_CHAT]);
});

test("a gapped chat keeps its prior checkpoint", async () => {
	const first = await runChats();
	const prior = chatEventsState(first.harness) as {
		chats: { chats: Record<string, unknown> };
	};
	const pages = await loadChatHistoryPages();
	const { harness } = await runChats({
		overrides: {
			InstinctChatHistory: failingMainChat(pages, { data: null }),
		},
		state: prior,
	});
	const state = chatEventsState(harness) as {
		chats: { chats: Record<string, unknown> };
	};
	assert.deepEqual(state.chats.chats[MAIN_CHAT], prior.chats.chats[MAIN_CHAT]);
});

test("a rate-limited history read is a rate_limited gap, not a failed run", async () => {
	const source = scriptedGraphql(await loadHappyPathResponses(), {
		InstinctChatHistory: { json: null, status: 429 },
	});
	const harness = makeRecordingEmit(validateRecord);
	const failures = failureRecorder(harness);
	await collectInstinct({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		graphql: source.graphql,
		observedAt: OBSERVED_AT,
		progress: async () => {
			/* unused */
		},
		reportStreamFailure: failures.report,
		requested: new Set(["chats", "chat_events"]),
	});
	assert.deepEqual(failures.reports, []);
	const gaps = wire(harness).filter((message) => message.type === "DETAIL_GAP");
	assert.deepEqual(
		gaps.map((gap) => [
			gap.reason,
			(gap.detail as { http_status?: unknown }).http_status,
		]),
		[
			["rate_limited", 429],
			["rate_limited", 429],
		],
	);
	assert.deepEqual(stateStreams(harness), ["chats"]);
});

function pendingGap(
	chatId: string,
	gapId: string,
): NonNullable<CollectInstinctArgs["detailGaps"]>[number] {
	return {
		detail_locator: { chat_id: chatId, kind: "instinct.chat_history" },
		gap_id: gapId,
		lease_id: `lease-${gapId}`,
		parent_stream: "chats",
		record_key: chatId,
		status: "pending",
		stream: "chat_events",
	};
}

test("a chat read completely resolves the gap an earlier run left for it", async () => {
	const { harness } = await runChats({
		detailGaps: [pendingGap(MAIN_CHAT, "gap-1")],
	});
	const recovered = wire(harness).filter(
		(message) => message.type === "DETAIL_GAP_RECOVERED",
	);
	assert.deepEqual(recovered, [
		{
			gap_id: "gap-1",
			lease_id: "lease-gap-1",
			record_key: MAIN_CHAT,
			reference_only: true,
			stream: "chat_events",
			type: "DETAIL_GAP_RECOVERED",
		},
	]);
});

test("a recovery-only run reads only the gapped chats and writes no STATE", async () => {
	const { harness, source } = await runChats({
		detailGaps: [pendingGap(WHATSAPP_CHAT, "gap-2")],
		recoveryOnly: true,
	});
	assert.deepEqual(source.calls, ["InstinctChatHistory"]);
	assert.deepEqual(chatEventIds(harness), [
		"00000000-0000-4000-8000-000000000201",
	]);
	assert.deepEqual(stateStreams(harness), []);
	assert.ok(
		wire(harness).some(
			(message) =>
				message.type === "DETAIL_GAP_RECOVERED" && message.gap_id === "gap-2",
		),
	);
});

test("a full_refresh run ignores the chat checkpoints", async () => {
	const first = await runChats();
	const { harness } = await runChats({
		collectionMode: "full_refresh",
		state: chatEventsState(first.harness),
	});
	assert.equal(chatEventIds(harness).length, 14);
});

// ─── Review round 1 ────────────────────────────────────────────────────────

test("a list record that would fail its schema fails the stream instead of being checkpointed", async () => {
	const devices = (await fixture("devices")) as {
		data: { devices: Array<Record<string, unknown>> };
	};
	const first = devices.data.devices[0];
	assert.ok(first);
	first.name = "x".repeat(201);
	const { failures, harness } = await runCollect(new Set(["devices"]), {
		InstinctDevices: devices,
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["devices"],
	);
	assert.equal(failures[0]?.retryable, false);
	assert.match(String(failures[0]?.message), /name/);
	assert.ok(!String(failures[0]?.message).includes("xxxx"), "no values");
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("a chat event that would fail its schema makes the chat a gap and keeps its checkpoint", async () => {
	const first = await runChats();
	const prior = chatEventsState(first.harness) as {
		chats: { chats: Record<string, unknown> };
	};
	const whatsapp = (await fixture("chat-history-whatsapp")) as {
		data: { chatHistory: { events: Array<Record<string, unknown>> } };
	};
	whatsapp.data.chatHistory.events.push({
		createdAt: 1_789_999_999,
		id: "00000000-0000-4000-8000-000000000299",
		message: {
			attachments: [],
			content: "late",
			id: "msg-0299TEST",
			origin: { agentDisplayName: "y".repeat(201), kind: "agent" },
			readAt: null,
			role: "user",
		},
		type: "message",
	});
	const pages = await loadChatHistoryPages();
	const { harness } = await runChats({
		overrides: {
			InstinctChatHistory: chatHistoryRouter({ ...pages, whatsapp }),
		},
		state: prior,
	});
	const gap = wire(harness).find((message) => message.type === "DETAIL_GAP");
	assert.ok(gap, "the chat must surface as a DETAIL_GAP");
	assert.equal(gap.record_key, WHATSAPP_CHAT);
	assert.equal(gap.reason, "retry_exhausted");
	assert.equal(
		(gap.detail as { class?: unknown }).class,
		"instinct_record_invalid",
	);
	assert.ok(
		!harness.emitted.some((record) => record.data.chat_id === WHATSAPP_CHAT),
	);
	const state = chatEventsState(harness) as {
		chats: { chats: Record<string, unknown> };
	};
	assert.deepEqual(
		state.chats.chats[WHATSAPP_CHAT],
		prior.chats.chats[WHATSAPP_CHAT],
	);
});

test("without the account's feature flags, connections fails instead of skipping gated resolvers", async () => {
	const profile = (await fixture("profile")) as {
		data: { authSession: { user: Record<string, unknown> } };
	};
	profile.data.authSession.user.enabledFeatureFlags = null;
	const { failures, harness, source } = await runCollect(
		new Set(["connections", "profile"]),
		{ InstinctProfile: profile },
	);
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["connections"],
	);
	assert.ok(!source.calls.includes("InstinctConnections"));
	assert.deepEqual(stateStreams(harness), ["profile"]);
});

test("an account read that errors without a user fails streams, not the session", async () => {
	const { failures, harness } = await runCollect(
		new Set(["profile", "connections", "devices"]),
		{
			InstinctProfile: {
				data: null,
				errors: [{ message: "internal server error", path: ["authSession"] }],
			},
		},
	);
	assert.deepEqual(failures.map((failure) => failure.stream).sort(), [
		"connections",
		"profile",
	]);
	assert.deepEqual(stateStreams(harness), ["devices"]);
});

test("the chat history query never selects a bearer link", async () => {
	const { source } = await runChats();
	const history = source.documents.find((document) =>
		document.includes("PdppInstinctChatHistory"),
	);
	assert.ok(history);
	assert.doesNotMatch(history, /\burl\b|signedUrl/);
});

test("nested chat blocks drop strings that cannot be stored", async () => {
	const page1 = (await fixture("chat-history-page1")) as {
		data: { chatHistory: { events: Array<Record<string, unknown>> } };
	};
	page1.data.chatHistory.events.push({
		createdAt: 1_789_070_055,
		draftField: {
			content: "ok",
			label: "Note",
			userValue: "a\u0000b",
			nested: [{ value: "c\u0000d", keep: "fine" }],
		},
		id: "00000000-0000-4000-8000-000000000110",
		type: "draft_field",
	});
	const pages = await loadChatHistoryPages();
	const { harness } = await runChats({
		overrides: {
			InstinctChatHistory: chatHistoryRouter({ ...pages, page1 }),
		},
	});
	const record = harness.emitted.find(
		(entry) => entry.data.id === "00000000-0000-4000-8000-000000000110",
	);
	assert.ok(record, "the event is still emitted");
	assert.ok(!JSON.stringify(record.data).includes("\\u0000"));
	assert.deepEqual(record.data.draft_field, {
		content: "ok",
		label: "Note",
		nested: [{ keep: "fine" }],
	});
});

// ─── Review round 2 ────────────────────────────────────────────────────────

test("singleton streams prove their one record before STATE", async () => {
	const { harness } = await runCollect(new Set(["profile", "agent_contact"]));
	const messages = wire(harness);
	for (const stream of ["profile", "agent_contact"]) {
		const coverageAt = messages.findIndex(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		const stateAt = messages.findIndex(
			(message) => message.type === "STATE" && message.stream === stream,
		);
		assert.ok(coverageAt >= 0 && stateAt > coverageAt, stream);
		assert.equal(messages[coverageAt]?.considered, 1);
	}
});

test("an agent with no contact details is proven empty, not skipped", async () => {
	const { harness } = await runCollect(new Set(["agent_contact"]), {
		InstinctAgentContact: { data: { agentContact: null } },
	});
	const messages = wire(harness);
	assert.ok(!messages.some((message) => message.type === "SKIP_RESULT"));
	const coverage = messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(coverage?.considered, 0);
	assert.deepEqual(stateStreams(harness), ["agent_contact"]);
});

test("a missing list in an answer is not an empty list", async () => {
	const connections = await runCollect(new Set(["connections"]), {
		InstinctConnections: { data: {} },
	});
	assert.deepEqual(
		connections.failures.map((failure) => failure.stream),
		["connections"],
	);
	assert.deepEqual(stateStreams(connections.harness), []);

	const trusted = await runCollect(new Set(["trusted_people"]), {
		InstinctTrustedNetwork: {
			data: {
				trustedNetworkBlockedPeople: { cursor: null, items: [] },
				trustedNetworkContacts: { cursor: null, items: null },
				trustedNetworkRequests: { cursor: null, items: [] },
				trustedNetworkSentRequests: [],
			},
		},
	});
	assert.deepEqual(
		trusted.failures.map((failure) => failure.stream),
		["trusted_people"],
	);

	const pages = await loadChatHistoryPages();
	const chats = await runChats({
		overrides: {
			InstinctChatHistory: failingMainChat(pages, {
				data: { chatHistory: { cursor: null, events: null } },
			}),
		},
	});
	const gap = wire(chats.harness).find(
		(message) => message.type === "DETAIL_GAP",
	);
	assert.equal(gap?.record_key, MAIN_CHAT);
});

test("records that would share a key fail the list instead of overwriting each other", async () => {
	const vault = (await fixture("vault")) as {
		data: { vaultEntries: Array<Record<string, unknown>> };
	};
	const first = vault.data.vaultEntries[0];
	assert.ok(first);
	vault.data.vaultEntries.push({ ...first });
	const { failures, harness } = await runCollect(new Set(["vault_entries"]), {
		InstinctVault: vault,
	});
	assert.deepEqual(
		failures.map((failure) => failure.stream),
		["vault_entries"],
	);
	assert.equal(failures[0]?.retryable, false);
	assert.ok(
		!String(failures[0]?.message).includes("Example Airline"),
		"no entry names in the failure",
	);
	assert.equal(harness.emitted.length, 0);
	assert.deepEqual(stateStreams(harness), []);
});

test("every page of pending gaps is read, and a gap is handled once", async () => {
	const pages: Array<NonNullable<CollectInstinctArgs["detailGaps"]>> = [
		[pendingGap(MAIN_CHAT, "gap-1"), pendingGap(WHATSAPP_CHAT, "gap-2")],
		[],
	];
	let requests = 0;
	const { harness } = await runChats({
		detailGaps: [pendingGap(MAIN_CHAT, "gap-1")],
		requestDetailGapPage: () => {
			const page = pages[Math.min(requests, pages.length - 1)] ?? [];
			requests += 1;
			return Promise.resolve(page);
		},
	});
	const recovered = wire(harness)
		.filter((message) => message.type === "DETAIL_GAP_RECOVERED")
		.map((message) => message.gap_id);
	assert.deepEqual(recovered, ["gap-1", "gap-2"]);
	assert.equal(requests, 2);
});

test("a recovery-only run asks for a gap page when START carried none", async () => {
	let requests = 0;
	const { harness, source } = await runChats({
		recoveryOnly: true,
		requestDetailGapPage: () => {
			requests += 1;
			return Promise.resolve(
				requests === 1 ? [pendingGap(WHATSAPP_CHAT, "gap-3")] : [],
			);
		},
	});
	assert.deepEqual(source.calls, ["InstinctChatHistory"]);
	assert.ok(
		wire(harness).some(
			(message) =>
				message.type === "DETAIL_GAP_RECOVERED" && message.gap_id === "gap-3",
		),
	);
	assert.deepEqual(stateStreams(harness), []);
});

// ─── Review round 3 ────────────────────────────────────────────────────────

test("chat_events keeps its checkpoints in the chats STATE, written after the event coverage", async () => {
	const { harness } = await runChats();
	const messages = wire(harness);
	assert.deepEqual(stateStreams(harness), ["chats"]);
	const coverageAt = messages.findIndex(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "chat_events",
	);
	const stateAt = messages.findIndex((message) => message.type === "STATE");
	assert.equal(messages[coverageAt]?.state_stream, "chats");
	assert.ok(
		stateAt > coverageAt,
		"the parent STATE follows the child coverage",
	);
	const lastEvent = harness.events.findLastIndex(
		(event) => event.kind === "record" && event.stream === "chat_events",
	);
	const stateEvent = harness.events.findIndex(
		(event) => event.kind === "message" && event.message.type === "STATE",
	);
	assert.ok(stateEvent > lastEvent);
});

test("chat_events without chats is out of scope, not collected orphaned", async () => {
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
		requested: new Set(["chat_events"]),
	});
	const skip = wire(harness).find((message) => message.type === "SKIP_RESULT");
	assert.equal(skip?.reason, "scope_not_supported");
	assert.equal(skip?.stream, "chat_events");
	assert.ok(!source.calls.includes("InstinctChatHistory"));
	assert.equal(harness.emitted.length, 0);
});

test("a chat record that cannot be stored fails chat_events too", async () => {
	const chats = (await fixture("chats")) as {
		data: { chats: { chats: Array<Record<string, unknown>> } };
	};
	const first = chats.data.chats.chats[0];
	assert.ok(first);
	first.title = "t".repeat(501);
	const { failures, harness, source } = await runChats({
		overrides: { InstinctChats: chats },
	});
	assert.deepEqual(failures.map((failure) => failure.stream).sort(), [
		"chat_events",
		"chats",
	]);
	assert.ok(!source.calls.includes("InstinctChatHistory"));
	assert.deepEqual(stateStreams(harness), []);
});

test("a page without its cursor is not the end of the list", async () => {
	const chats = (await fixture("chats")) as {
		data: { chats: Record<string, unknown> };
	};
	delete chats.data.chats.cursor;
	const list = await runChats({ overrides: { InstinctChats: chats } });
	assert.deepEqual(list.failures.map((failure) => failure.stream).sort(), [
		"chat_events",
		"chats",
	]);

	const pages = await loadChatHistoryPages();
	const page1 = structuredClone(pages.page1) as {
		data: { chatHistory: Record<string, unknown> };
	};
	delete page1.data.chatHistory.cursor;
	const history = await runChats({
		overrides: {
			InstinctChatHistory: chatHistoryRouter({ ...pages, page1 }),
		},
	});
	const gap = wire(history.harness).find(
		(message) => message.type === "DETAIL_GAP",
	);
	assert.equal(gap?.record_key, MAIN_CHAT);

	const trusted = await runCollect(new Set(["trusted_people"]), {
		InstinctTrustedNetwork: {
			data: {
				trustedNetworkBlockedPeople: { cursor: null, items: [] },
				trustedNetworkContacts: { items: [] },
				trustedNetworkRequests: { cursor: null, items: [] },
				trustedNetworkSentRequests: [],
			},
		},
	});
	assert.deepEqual(
		trusted.failures.map((failure) => failure.stream),
		["trusted_people"],
	);
});

test("a new event in the checkpoint's second on the next page is still read", async () => {
	const first = await runChats();
	const pages = await loadChatHistoryPages();
	// The newest window holds only the already-collected events of the
	// checkpoint's second; the next window holds a new event of that second.
	const page1 = structuredClone(pages.page1) as {
		data: {
			chatHistory: {
				cursor: string | null;
				events: Array<{ createdAt: number }>;
			};
		};
	};
	page1.data.chatHistory.events = page1.data.chatHistory.events.filter(
		(event) => event.createdAt === 1_789_070_050,
	);
	assert.ok(page1.data.chatHistory.events.length > 0);
	const sameSecond = {
		createdAt: 1_789_070_050,
		id: "00000000-0000-4000-8000-000000000111",
		message: {
			attachments: [],
			content: "same second, older window",
			id: "msg-0111TEST",
			origin: null,
			readAt: null,
			role: "user",
		},
		type: "message",
	};
	const page2 = structuredClone(pages.page2) as {
		data: { chatHistory: { events: unknown[] } };
	};
	page2.data.chatHistory.events.push(sameSecond);
	const { harness, source } = await runChats({
		overrides: {
			InstinctChatHistory: chatHistoryRouter({ ...pages, page1, page2 }),
		},
		state: chatEventsState(first.harness),
	});
	assert.deepEqual(chatEventIds(harness), [sameSecond.id]);
	assert.deepEqual(
		historyCalls(source, MAIN_CHAT).map((vars) => vars.cursor),
		[null, "chat-cursor-page-2"],
	);
});
