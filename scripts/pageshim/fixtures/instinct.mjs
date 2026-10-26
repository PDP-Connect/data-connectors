// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. Serves app.instinct.com pages and the one GraphQL endpoint
// on api.instinct.com for the PageShim harness, answering every operation the
// instinct connector sends with its own synthetic fixtures
// (connectors/instinct/fixtures, invented values). The API answers only a
// POST that comes from the app origin, so a passing run proves the connector
// posts from the signed-in app page as it does on desktop. Signed out,
// `authSession` is null and every other operation is refused as
// unauthenticated. CORS (including the preflight) is fulfilled by the
// harness. The real Instinct API, its cookie session and a WebView on a
// device are not exercised here.

import { readFileSync } from "node:fs";

const APP_ORIGIN = "https://app.instinct.com";
const dir = new URL("../../../connectors/instinct/fixtures/", import.meta.url);
const fx = (name) =>
	JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));

const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});

let loggedIn = true;
export const setLoggedIn = (value) => {
	loggedIn = value;
};

const MAIN_CHAT = "chat-01TESTMAINTESTTESTTESTTEST";
const WHATSAPP_CHAT = "chat-01TESTWHATSAPPTESTTESTTEST";

const responses = {
	InstinctAgentContact: fx("agent-contact"),
	InstinctChats: fx("chats"),
	InstinctConnections: fx("connections"),
	InstinctDevices: fx("devices"),
	InstinctImessageDevice: fx("imessage-device"),
	InstinctMessaging: fx("messaging"),
	InstinctProfile: fx("profile"),
	InstinctTrustedNetwork: fx("trusted-network"),
	InstinctVault: fx("vault"),
};
const history = {
	page1: fx("chat-history-page1"),
	page2: fx("chat-history-page2"),
	whatsapp: fx("chat-history-whatsapp"),
};
const profileUser = responses.InstinctProfile.data.authSession.user;

/** The main chat has two windows (newest first), the WhatsApp chat one. */
function chatHistory(variables) {
	if (variables.chatId === WHATSAPP_CHAT && variables.cursor == null)
		return history.whatsapp;
	if (variables.chatId !== MAIN_CHAT) return undefined;
	if (variables.cursor == null) return history.page1;
	return variables.cursor === "chat-cursor-page-2" ? history.page2 : undefined;
}

export const requests = [];

const page = () => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: "<!doctype html><html><head><title>Instinct</title></head><body>Instinct fixture</body></html>",
});

export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	if (url.hostname !== "api.instinct.com") return page();
	if (request.method === "OPTIONS")
		return { status: 204, contentType: "text/plain", body: "" };
	if (
		url.pathname !== "/-/api/graphql" ||
		request.method !== "POST" ||
		request.headers?.origin !== APP_ORIGIN
	)
		return json({ errors: [{ message: "Bad request" }] }, 400);
	let body;
	try {
		body = JSON.parse(request.postData ?? "");
	} catch {
		return json({ errors: [{ message: "Bad request" }] }, 400);
	}
	const operation = /query Pdpp(\w+)/.exec(String(body?.query))?.[1] ?? "";
	const variables = body?.variables ?? {};
	requests.push({ operation, variables });
	if (operation === "InstinctSession") {
		return json({
			data: {
				authSession: loggedIn ? { user: { id: profileUser.id } } : null,
			},
		});
	}
	if (!loggedIn) {
		return json({
			data: null,
			errors: [{ message: "Unauthenticated" }],
		});
	}
	const answer =
		operation === "InstinctChatHistory"
			? chatHistory(variables)
			: responses[operation];
	return answer === undefined
		? json({ errors: [{ message: `Unexpected ${operation}` }] }, 400)
		: json(answer);
}

export const instinctFixtures = {
	hosts: /^https:\/\/(?:app|api)\.instinct\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://app.instinct.com/signin?returnTo=%2Fworkspace",
	homeUrl: "https://app.instinct.com/workspace",
};

const STREAMS = [
	"profile",
	"agent_contact",
	"connections",
	"devices",
	"trusted_people",
	"vault_entries",
	"chats",
	"chat_events",
];

export const pageshimCase = {
	fixtures: instinctFixtures,
	scopes: STREAMS.map((stream) => `instinct.${stream}`),
	// Every record carries the time this run observed it.
	volatileRecordFields: ["observed_at"],
	exportSummary: {
		count: 33,
		label: "records",
		details: {
			profile: 1,
			agent_contact: 1,
			connections: 7,
			devices: 2,
			trusted_people: 4,
			vault_entries: 2,
			chats: 2,
			chat_events: 14,
		},
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: Object.fromEntries(STREAMS.map((stream) => [stream, 0])),
	},
};
