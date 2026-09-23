#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Instinct Connector (v0.1.0).
 *
 * Instinct (instinct.com, Spear Street Technology) is an invite-only personal
 * AI agent the owner reaches over SMS, WhatsApp, voice, and email. The web
 * app at app.instinct.com is mostly an account console (/workspace, /vault,
 * /trusted-networks, /settings), plus an /agent chat page hidden behind the
 * `agent_chat` / `mobile_chat` feature flags. The flag gates only the page:
 * the `chats` and `chatHistory` resolvers behind it answer for any signed-in
 * owner, and they hold the agent's full conversation log across channels.
 *
 *   chats           — the owner's chats with the agent (e.g. `main`, which
 *                     aggregates every channel, and `whatsapp_channel`)
 *   chat_events     — every event in those chats: the owner's messages and
 *                     the agent's tool calls, tool responses, interactions,
 *                     and errors. The agent's replies over WhatsApp/SMS are
 *                     sent through tool calls, so they live in `tool_arguments`
 *                     rather than as `message` events.
 *   profile         — identity, sign-in phone, roles, feature flags, the two
 *                     privacy preferences, and agent-to-agent posture
 *   agent_contact   — the SMS/voice/WhatsApp numbers and mailbox Instinct
 *                     assigned to this owner's agent
 *   connections     — every outside account wired into the agent
 *   devices         — devices enrolled so the agent can drive them
 *   trusted_people  — the agent-to-agent trust list, both directions
 *   vault_entries   — inventory of the vault: kinds, labels, which fields are
 *                     filled. Never values; the resolver does not return them
 *                     and this connector never asks.
 *
 * Source class: structured web endpoint (authoring guide §1, rung 3). One
 * GraphQL endpoint, `POST https://api.instinct.com/-/api/graphql`, is what the
 * web app itself consumes. Schema introspection is disabled in production, so
 * the operation documents below were read out of the app's own JS bundles and
 * each one is verified against a live account.
 *
 * Auth: cookie session on api.instinct.com, established by signing in at
 * app.instinct.com. Sign-in is a phone number plus an SMS one-time code behind
 * a Cloudflare Turnstile challenge, so there is no credential pair to seal and
 * no scriptable login. First connection is an owner `manual_action` in the
 * isolated Instinct browser profile; the session then persists in that profile
 * and later runs reuse it. `ensureSession` proves the session with a real
 * `authSession` read before any collection starts.
 *
 * Pagination: account-state streams are one small read each. `chats` pages by
 * `limit`/`cursor`; `chatHistory` returns the newest window first with a
 * cursor to older windows (each window ascending by `createdAt`, epoch
 * seconds). A first run backfills everything; later runs page only until they
 * reach the per-chat checkpoint in `chat_events` STATE. All loops are bounded.
 *
 * Reachability probe: permanently exempt. api.instinct.com answers nothing
 * useful unauthenticated and Instinct is invite-only private beta, so there is
 * no unauthenticated endpoint to probe (see CONNECTOR-CHECKLIST.md's exemption
 * rule; this is the browser-automation-behind-a-login-wall case).
 *
 * Deliberately not collected: `myReferralLinks`. Its `url` field is a live
 * bearer invite — anyone holding it can consume an invite slot — so exporting
 * it would move a working credential into the owner's record store for no
 * analytical gain.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { z } from "zod";
import { manualAction } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	type InteractionRequest,
	type InteractionResponse,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	advanceCheckpoint,
	agentContactRecord,
	chatEventRecord,
	chatRecord,
	connectionRecords,
	deviceRecords,
	eventEpochSeconds,
	imessageConnectionRecord,
	isNewEvent,
	messagingConnectionRecords,
	profileRecord,
	trustedPeopleRecords,
	vaultEntryRecords,
} from "./parsers.ts";
import {
	agentContactResponseSchema,
	chatHistoryResponseSchema,
	chatsResponseSchema,
	connectionsResponseSchema,
	devicesResponseSchema,
	imessageDeviceResponseSchema,
	messagingResponseSchema,
	profileResponseSchema,
	trustedNetworkResponseSchema,
	validateRecord,
	vaultResponseSchema,
} from "./schemas.ts";
import type {
	Chat,
	ChatCheckpoint,
	ChatEvent,
	ConnectionFeatureGates,
	GraphqlError,
	GraphqlFetchResult,
	InstinctGraphql,
} from "./types.ts";

const APP_URL = "https://app.instinct.com/workspace";
const API_URL = "https://api.instinct.com/-/api/graphql";

/**
 * Instinct's own feature flags for the two connection resolvers the web app
 * gates. Asking for a resolver this account is not flagged for makes Instinct
 * answer 200 with `internal server error` on that path.
 */
const WHOOP_FLAG = "whoop";
const STRIPE_LINK_FLAG = "link_payments";

/** Trusted-network pages are 20 items; 25 pages is far past any real list. */
const MAX_TRUSTED_PAGES = 25;
const TRUSTED_PAGE_SIZE = 20;

// ─── GraphQL documents ─────────────────────────────────────────────────────
//
// Read out of app.instinct.com's JS bundles (introspection is disabled in
// production) and each one verified against a live account.

const PROFILE_QUERY = `query PdppInstinctProfile {
  authSession { user { id name email roles enabledFeatureFlags onboardingStep profilePictureUrl phoneNumber preferences { trainingDataOptOut } } }
  agentToAgentSettings { enabled }
  locationDataStatus { hasData }
  linkedProviders { provider sub }
}`;

const AGENT_CONTACT_QUERY = `query PdppInstinctAgentContact {
  agentContact { smsPhoneNumber voicePhoneNumber voiceCallsEnabled whatsAppChannelPhoneNumber email agentMailStatus agentPhoneNumber agentPhoneStatus }
}`;

const CONNECTIONS_QUERY = `query PdppInstinctConnections($showWhoop: Boolean!, $showStripeLink: Boolean!) {
  googleWorkspaceConnections { id email isDefault isRevoked services { serviceId label connected notificationIssue readOnly } }
  outlookConnections { id email displayName isDefault isRevoked }
  linearConnections { id organizationName displayName email isDefault isRevoked }
  notionConnections { id workspaceName isDefault isRevoked }
  githubConnection { id username displayName email isRevoked }
  slackCanvasConnection { teamId teamName isRevoked }
  granolaConnection { id workspaceName accountEmail }
  shopWalletConnection { id email isRevoked }
  whoopConnection @include(if: $showWhoop) { id email firstName lastName }
  stripeLinkConnection @include(if: $showStripeLink) { connected }
}`;

const MESSAGING_QUERY = `query PdppInstinctMessaging {
  whatsappChannelConnection { userId phoneNumber }
  imessageConnection { icloudEmail }
}`;

// Kept out of MESSAGING_QUERY: `imessageLocalConnection` 500s for accounts
// with no local iMessage relay, and a combined query would drag the healthy
// WhatsApp and iCloud fields down with it.
const IMESSAGE_DEVICE_QUERY = `query PdppInstinctImessageDevice {
  imessageLocalConnection { userId connectedAt preferredDeviceId accountHandle }
}`;

const DEVICES_QUERY = `query PdppInstinctDevices {
  devices { id name hostname osVersion isConnected batteryLevel isCharging deviceType createdAt }
}`;

const TRUSTED_QUERY = `query PdppInstinctTrustedNetwork($limit: Int!, $contactsCursor: String, $requestsCursor: String, $blockedCursor: String) {
  agentToAgentSettings { enabled }
  trustedNetworkContacts(limit: $limit, cursor: $contactsCursor) { items { id generation displayName phoneNumbers createdAt } cursor }
  trustedNetworkBlockedPeople(limit: $limit, cursor: $blockedCursor) { items { id decisionGeneration displayName phoneNumbers createdAt } cursor }
  trustedNetworkRequests(limit: $limit, cursor: $requestsCursor) { items { id generation status displayName phoneNumbers createdAt expiresAt } cursor }
  trustedNetworkSentRequests(limit: $limit) { id phoneNumber createdAt expiresAt }
}`;

const VAULT_QUERY = `query PdppInstinctVault {
  vaultEntries { kind name isAgentEntry fields { key populated } }
  vaultKinds { kind subfieldKeys }
}`;

// The app's own /agent page issues these two. Attachment and screenshot
// `signedUrl`/`url` values are short-lived bearer links: attachments are asked
// for without them, and screenshots only report whether one exists.
const CHATS_QUERY = `query PdppInstinctChats($limit: Int, $cursor: String) {
  chats(limit: $limit, cursor: $cursor) { cursor chats { id title source status pendingTurnStartedAt } }
}`;

const CHAT_HISTORY_QUERY = `query PdppInstinctChatHistory($chatId: ID!, $limit: Int, $cursor: String) {
  chatHistory(chatId: $chatId, limit: $limit, cursor: $cursor) {
    cursor
    events {
      id type createdAt
      message { id role content readAt origin { kind agentDisplayName } attachments { id kind mimeType filename byteSize } }
      error { message }
      toolInvocation { toolName toolId arguments }
      toolResponse { toolName toolId response isError }
      interaction { interactionId interactionType title body question options actionSummary targetMode deviceName plan }
      interactionResponse { interactionId approved selected text summary dismissed }
      screenshot { url }
      thinking { thinking }
      action { actionType coordinate text key scrollDirection scrollAmount command }
      draftField { label before content userValue userEditedAt }
    }
  }
}`;

/** Page sizes and bounded guards for the chat list and each chat's history. */
const CHATS_PAGE_SIZE = 50;
const MAX_CHAT_LIST_PAGES = 20;
const CHAT_HISTORY_PAGE_SIZE = 50;
const MAX_CHAT_HISTORY_PAGES = 400;

// ─── Transport ─────────────────────────────────────────────────────────────

/**
 * Build the in-page GraphQL caller.
 *
 * The request runs inside the signed-in app origin with `credentials:
 * "include"`, so the session cookie rides along without this connector ever
 * reading, storing, or forwarding it.
 */
export interface GraphqlEvaluateArgs {
	readonly apiUrl: string;
	readonly document: string;
	readonly vars: Readonly<Record<string, unknown>>;
}

/**
 * The exact request descriptor handed into the page. Split out so the URL and
 * operation the connector actually posts are assertable without a browser.
 */
export function graphqlEvaluateArgs(
	query: string,
	variables: Readonly<Record<string, unknown>> = {},
): GraphqlEvaluateArgs {
	return { apiUrl: API_URL, document: query, vars: variables };
}

/**
 * Build the in-page GraphQL caller.
 *
 * The request runs inside the signed-in app origin with `credentials:
 * "include"`, so the session cookie rides along without this connector ever
 * reading, storing, or forwarding it.
 */
export function makeInstinctGraphql(page: Page): InstinctGraphql {
	return async (query, variables = {}) =>
		await page.evaluate(
			async ({
				apiUrl,
				document,
				vars,
			}: GraphqlEvaluateArgs): Promise<GraphqlFetchResult> => {
				let response: Response;
				try {
					response = await fetch(apiUrl, {
						body: JSON.stringify({ query: document, variables: vars }),
						credentials: "include",
						headers: {
							accept: "application/json",
							"content-type": "application/json",
						},
						method: "POST",
					});
				} catch {
					return { json: null, status: 0 };
				}
				const text = await response.text();
				try {
					return { json: JSON.parse(text) as unknown, status: response.status };
				} catch {
					return { invalidJson: true, json: null, status: response.status };
				}
			},
			graphqlEvaluateArgs(query, variables),
		);
}

/**
 * Turn a transport-level outcome into either the JSON body or a thrown,
 * classified error. GraphQL-level `errors[]` are deliberately NOT thrown here
 * — Instinct answers 200 with partial data when one resolver fails, and the
 * right response is to skip that stream, not to lose the whole run.
 */
function assertTransport(
	result: GraphqlFetchResult,
	operation: string,
): unknown {
	if (result.status === 401 || result.status === 403) {
		throw new Error(
			`instinct_owner_repair_required: ${String(result.status)} on ${operation}`,
		);
	}
	if (result.status === 429) {
		throw new Error(`instinct_rate_limited: 429 on ${operation}`);
	}
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`instinct_http_${String(result.status)}: ${operation}`);
	}
	if (result.invalidJson === true) {
		throw new Error(`instinct_parse_error: ${operation}`);
	}
	return result.json;
}

/** Human-readable summary of the GraphQL errors attached to one response. */
export function describeGraphqlErrors(
	errors: readonly GraphqlError[] | null | undefined,
): string | null {
	if (!errors || errors.length === 0) {
		return null;
	}
	return errors
		.map((error) => {
			const path = (error.path ?? []).map((part) => String(part)).join(".");
			return path.length > 0 ? `${path}: ${error.message}` : error.message;
		})
		.join("; ");
}

// ─── Session ───────────────────────────────────────────────────────────────

/**
 * Unattended runs must never open an interactive login. A scheduled refresh
 * that finds a dead session fails with a classified error instead, so the
 * orchestrator can ask the owner rather than hanging on a browser nobody is
 * looking at.
 */
export function instinctAllowsInteractiveAuthRepair(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const trigger = env.PDPP_RUN_TRIGGER_KIND?.trim();
	return !trigger || trigger === "manual";
}

/** True when the profile response carries a real signed-in user. */
export function hasSignedInUser(json: unknown): boolean {
	const parsed = profileResponseSchema.safeParse(json);
	return (
		parsed.success &&
		typeof parsed.data.data?.authSession?.user?.id === "string"
	);
}

export async function ensureInstinctSession(args: {
	capture?: Parameters<typeof manualAction>[0]["capture"];
	graphql: InstinctGraphql;
	interactive: boolean;
	page: Page;
	sendInteraction: (
		request: InteractionRequest,
	) => Promise<InteractionResponse>;
}): Promise<void> {
	await args.page
		.goto(APP_URL, { timeout: 30_000, waitUntil: "domcontentloaded" })
		.catch((): undefined => undefined);

	const initial = await args.graphql(PROFILE_QUERY);
	if (
		initial.status >= 200 &&
		initial.status < 300 &&
		hasSignedInUser(initial.json)
	) {
		return;
	}
	if (
		initial.status !== 200 &&
		initial.status !== 401 &&
		initial.status !== 403
	) {
		assertTransport(initial, "authSession");
	}
	if (!args.interactive) {
		throw new Error(
			"instinct_owner_repair_required: unattended refresh cannot open interactive login",
		);
	}

	await manualAction(
		{
			...(args.capture ? { capture: args.capture } : {}),
			message:
				"Sign in to Instinct in the secure browser — enter your phone number, complete the Turnstile check, and type the SMS code — then respond success. PDPP will verify the session before collecting.",
			page: args.page,
			reason: "login",
			timeoutSeconds: 1800,
		},
		args.sendInteraction,
	);

	const reprobe = await args.graphql(PROFILE_QUERY);
	assertTransport(reprobe, "authSession");
	if (!hasSignedInUser(reprobe.json)) {
		throw new Error(
			"instinct_owner_repair_required: still signed out after manual login",
		);
	}
}

// ─── Collection ────────────────────────────────────────────────────────────

export interface CollectInstinctArgs {
	readonly emit: (message: EmittedMessage) => Promise<void>;
	readonly emitRecord: (stream: string, data: RecordData) => Promise<void>;
	readonly graphql: InstinctGraphql;
	readonly observedAt: string;
	readonly progress: (
		message: string,
		extra?: Record<string, unknown>,
	) => Promise<void>;
	readonly requested: ReadonlySet<string>;
	/** Stream-keyed state from START; only `chat_events` reads it. */
	readonly state?: Readonly<Record<string, unknown>>;
}

/** Feature gates the account is actually flagged for, mirroring the web app. */
export function resolveConnectionGates(
	enabledFeatureFlags: readonly string[],
): ConnectionFeatureGates {
	const flags = new Set(enabledFeatureFlags);
	return {
		showStripeLink: flags.has(STRIPE_LINK_FLAG),
		showWhoop: flags.has(WHOOP_FLAG),
	};
}

async function skipStream(
	emit: CollectInstinctArgs["emit"],
	stream: string,
	reason: string,
	message: string,
): Promise<void> {
	await emit({ message, reason, stream, type: "SKIP_RESULT" });
}

async function checkpoint(
	emit: CollectInstinctArgs["emit"],
	stream: string,
	observedAt: string,
): Promise<void> {
	await emit({ cursor: { observed_at: observedAt }, stream, type: "STATE" });
}

/**
 * Read the profile. Returns the parsed feature flags even when the `profile`
 * stream was not requested, because the connections query needs them to decide
 * which feature-gated resolvers it may ask for.
 */
async function collectProfile(
	args: CollectInstinctArgs,
): Promise<readonly string[]> {
	const raw = assertTransport(await args.graphql(PROFILE_QUERY), "authSession");
	const parsed = profileResponseSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(
			`instinct_parse_error: authSession: ${parsed.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	const flags = parsed.data.data?.authSession?.user?.enabledFeatureFlags ?? [];
	if (!args.requested.has("profile")) {
		return flags;
	}
	const record = profileRecord(parsed.data, args.observedAt);
	if (record === null) {
		await skipStream(
			args.emit,
			"profile",
			"not_available",
			describeGraphqlErrors(parsed.data.errors) ??
				"authSession returned no user",
		);
		return flags;
	}
	await args.emitRecord("profile", record);
	await checkpoint(args.emit, "profile", args.observedAt);
	return flags;
}

async function collectAgentContact(args: CollectInstinctArgs): Promise<void> {
	const raw = assertTransport(
		await args.graphql(AGENT_CONTACT_QUERY),
		"agentContact",
	);
	const parsed = agentContactResponseSchema.safeParse(raw);
	const agentContact = parsed.success ? parsed.data.data?.agentContact : null;
	if (!(parsed.success && agentContact)) {
		await skipStream(
			args.emit,
			"agent_contact",
			parsed.success ? "not_available" : "parse_error",
			parsed.success
				? (describeGraphqlErrors(parsed.data.errors) ??
						"agentContact returned no contact details")
				: parsed.error.message,
		);
		return;
	}
	await args.emitRecord(
		"agent_contact",
		agentContactRecord(agentContact, args.observedAt),
	);
	await checkpoint(args.emit, "agent_contact", args.observedAt);
}

async function collectConnections(
	args: CollectInstinctArgs,
	gates: ConnectionFeatureGates,
): Promise<void> {
	const records: RecordData[] = [];
	const notes: string[] = [];

	const connectionsRaw = assertTransport(
		await args.graphql(CONNECTIONS_QUERY, {
			showStripeLink: gates.showStripeLink,
			showWhoop: gates.showWhoop,
		}),
		"connections",
	);
	const connections = connectionsResponseSchema.safeParse(connectionsRaw);
	if (connections.success) {
		records.push(...connectionRecords(connections.data, args.observedAt));
		const errorNote = describeGraphqlErrors(connections.data.errors);
		if (errorNote !== null) {
			notes.push(errorNote);
		}
	} else {
		notes.push(`connections: ${connections.error.message}`);
	}

	const messagingRaw = assertTransport(
		await args.graphql(MESSAGING_QUERY),
		"messaging",
	);
	const messaging = messagingResponseSchema.safeParse(messagingRaw);
	if (messaging.success) {
		records.push(
			...messagingConnectionRecords(messaging.data, args.observedAt),
		);
		const errorNote = describeGraphqlErrors(messaging.data.errors);
		if (errorNote !== null) {
			notes.push(errorNote);
		}
	} else {
		notes.push(`messaging: ${messaging.error.message}`);
	}

	const imessageRaw = assertTransport(
		await args.graphql(IMESSAGE_DEVICE_QUERY),
		"imessageLocalConnection",
	);
	const imessage = imessageDeviceResponseSchema.safeParse(imessageRaw);
	if (imessage.success) {
		const errorNote = describeGraphqlErrors(imessage.data.errors);
		if (errorNote !== null) {
			notes.push(errorNote);
		}
	} else {
		notes.push(`imessageLocalConnection: ${imessage.error.message}`);
	}

	// Both iMessage resolvers feed one record, so it is built after both have
	// answered rather than pushed twice and reconciled afterwards.
	if (messaging.success) {
		const record = imessageConnectionRecord(
			messaging.data,
			imessage.success ? imessage.data : { data: null },
			args.observedAt,
		);
		if (record !== null) {
			records.push(record);
		}
	}

	if (notes.length > 0) {
		await skipStream(
			args.emit,
			"connections",
			"not_available",
			notes.join("; "),
		);
	}
	for (const record of records) {
		await args.emitRecord("connections", record);
	}
	await checkpoint(args.emit, "connections", args.observedAt);
}

async function collectDevices(args: CollectInstinctArgs): Promise<void> {
	const raw = assertTransport(await args.graphql(DEVICES_QUERY), "devices");
	const parsed = devicesResponseSchema.safeParse(raw);
	if (!parsed.success) {
		await skipStream(args.emit, "devices", "parse_error", parsed.error.message);
		return;
	}
	const errorNote = describeGraphqlErrors(parsed.data.errors);
	if (errorNote !== null) {
		await skipStream(args.emit, "devices", "not_available", errorNote);
	}
	for (const record of deviceRecords(parsed.data, args.observedAt)) {
		await args.emitRecord("devices", record);
	}
	await checkpoint(args.emit, "devices", args.observedAt);
}

async function collectTrustedPeople(args: CollectInstinctArgs): Promise<void> {
	let blockedCursor: string | null = null;
	let contactsCursor: string | null = null;
	let requestsCursor: string | null = null;
	let sentRequestsDone = false;
	const seen = new Set<string>();

	for (let page = 0; page < MAX_TRUSTED_PAGES; page += 1) {
		const raw = assertTransport(
			await args.graphql(TRUSTED_QUERY, {
				blockedCursor,
				contactsCursor,
				limit: TRUSTED_PAGE_SIZE,
				requestsCursor,
			}),
			"trustedNetwork",
		);
		const parsed = trustedNetworkResponseSchema.safeParse(raw);
		if (!parsed.success) {
			await skipStream(
				args.emit,
				"trusted_people",
				"parse_error",
				parsed.error.message,
			);
			return;
		}
		const errorNote = describeGraphqlErrors(parsed.data.errors);
		if (errorNote !== null) {
			await skipStream(args.emit, "trusted_people", "not_available", errorNote);
		}
		for (const record of trustedPeopleRecords(parsed.data, args.observedAt)) {
			const key = String(record.id);
			// Sent requests are unpaginated, so they repeat on every page.
			if (
				seen.has(key) ||
				(sentRequestsDone && key.startsWith("sent_request:"))
			) {
				continue;
			}
			seen.add(key);
			await args.emitRecord("trusted_people", record);
		}
		sentRequestsDone = true;

		const data = parsed.data.data;
		blockedCursor = data?.trustedNetworkBlockedPeople?.cursor ?? null;
		contactsCursor = data?.trustedNetworkContacts?.cursor ?? null;
		requestsCursor = data?.trustedNetworkRequests?.cursor ?? null;
		if (
			blockedCursor === null &&
			contactsCursor === null &&
			requestsCursor === null
		) {
			await checkpoint(args.emit, "trusted_people", args.observedAt);
			return;
		}
	}
	throw new Error(
		"instinct_incomplete_pagination: trusted network exceeded the bounded page guard",
	);
}

async function collectVaultEntries(args: CollectInstinctArgs): Promise<void> {
	const raw = assertTransport(await args.graphql(VAULT_QUERY), "vault");
	const parsed = vaultResponseSchema.safeParse(raw);
	if (!parsed.success) {
		await skipStream(
			args.emit,
			"vault_entries",
			"parse_error",
			parsed.error.message,
		);
		return;
	}
	const errorNote = describeGraphqlErrors(parsed.data.errors);
	if (errorNote !== null) {
		await skipStream(args.emit, "vault_entries", "not_available", errorNote);
	}
	for (const record of vaultEntryRecords(parsed.data, args.observedAt)) {
		await args.emitRecord("vault_entries", record);
	}
	await checkpoint(args.emit, "vault_entries", args.observedAt);
}

const chatCheckpointSchema = z.object({
	newest_created_at: z.number().int(),
	newest_ids: z.array(z.string()),
});
const chatEventsStateSchema = z.object({
	cursor: z
		.object({ chats: z.record(z.string(), chatCheckpointSchema) })
		.partial()
		.nullish(),
});

/** Prior per-chat checkpoints, or none when state is absent or unreadable. */
export function readChatCheckpoints(
	state: Readonly<Record<string, unknown>> | undefined,
): Record<string, ChatCheckpoint> {
	const parsed = chatEventsStateSchema.safeParse(state?.chat_events ?? {});
	if (!parsed.success) {
		return {};
	}
	return { ...(parsed.data.cursor?.chats ?? {}) };
}

async function listChats(args: CollectInstinctArgs): Promise<Chat[] | null> {
	const chats: Chat[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_CHAT_LIST_PAGES; page += 1) {
		const raw = assertTransport(
			await args.graphql(CHATS_QUERY, { cursor, limit: CHATS_PAGE_SIZE }),
			"chats",
		);
		const parsed = chatsResponseSchema.safeParse(raw);
		if (!parsed.success) {
			await skipStream(args.emit, "chats", "parse_error", parsed.error.message);
			return null;
		}
		const errorNote = describeGraphqlErrors(parsed.data.errors);
		const pageData = parsed.data.data?.chats;
		if (!pageData) {
			await skipStream(
				args.emit,
				"chats",
				"not_available",
				errorNote ?? "chats returned no list",
			);
			return null;
		}
		chats.push(...(pageData.chats ?? []));
		cursor = pageData.cursor ?? null;
		if (cursor === null) {
			return chats;
		}
	}
	throw new Error(
		"instinct_incomplete_pagination: chat list exceeded the bounded page guard",
	);
}

/**
 * Read one chat's events newer than its checkpoint. `chatHistory` returns
 * the newest window first and a cursor to older windows, so paging stops at
 * the first window that reaches already-collected events.
 */
async function readNewChatEvents(
	args: CollectInstinctArgs,
	chatId: string,
	prior: ChatCheckpoint | null,
): Promise<ChatEvent[] | string> {
	const fresh: ChatEvent[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_CHAT_HISTORY_PAGES; page += 1) {
		const raw = assertTransport(
			await args.graphql(CHAT_HISTORY_QUERY, {
				chatId,
				cursor,
				limit: CHAT_HISTORY_PAGE_SIZE,
			}),
			"chatHistory",
		);
		const parsed = chatHistoryResponseSchema.safeParse(raw);
		if (!parsed.success) {
			return `${chatId}: ${parsed.error.message}`;
		}
		const history = parsed.data.data?.chatHistory;
		if (!history) {
			return `${chatId}: ${describeGraphqlErrors(parsed.data.errors) ?? "chatHistory returned nothing"}`;
		}
		const events = history.events ?? [];
		const newOnes = events.filter((event) => isNewEvent(event, prior));
		fresh.push(...newOnes);
		cursor = history.cursor ?? null;
		if (cursor === null || newOnes.length < events.length) {
			return fresh;
		}
	}
	throw new Error(
		`instinct_incomplete_pagination: chat history for ${chatId} exceeded the bounded page guard`,
	);
}

function byCreatedAt(left: ChatEvent, right: ChatEvent): number {
	const leftSeconds = eventEpochSeconds(left) ?? 0;
	const rightSeconds = eventEpochSeconds(right) ?? 0;
	return leftSeconds - rightSeconds || left.id.localeCompare(right.id);
}

async function collectChats(args: CollectInstinctArgs): Promise<void> {
	const chats = await listChats(args);
	if (chats === null) {
		if (args.requested.has("chat_events")) {
			await skipStream(
				args.emit,
				"chat_events",
				"not_available",
				"chat list unavailable, so no chat history could be read",
			);
		}
		return;
	}

	if (args.requested.has("chats")) {
		for (const chat of chats) {
			await args.emitRecord("chats", chatRecord(chat, args.observedAt));
		}
		await checkpoint(args.emit, "chats", args.observedAt);
	}
	if (!args.requested.has("chat_events")) {
		return;
	}

	const checkpoints = readChatCheckpoints(args.state);
	const failures: string[] = [];
	for (const chat of chats) {
		const prior = checkpoints[chat.id] ?? null;
		const events = await readNewChatEvents(args, chat.id, prior);
		if (typeof events === "string") {
			failures.push(events);
			continue;
		}
		for (const event of [...events].sort(byCreatedAt)) {
			await args.emitRecord("chat_events", chatEventRecord(chat.id, event));
		}
		const next = advanceCheckpoint(prior, events);
		if (next !== null) {
			checkpoints[chat.id] = next;
		}
	}
	if (failures.length > 0) {
		await skipStream(
			args.emit,
			"chat_events",
			"not_available",
			failures.join("; "),
		);
	}
	await args.emit({
		cursor: { chats: checkpoints },
		stream: "chat_events",
		type: "STATE",
	});
}

export async function collectInstinct(
	args: CollectInstinctArgs,
): Promise<void> {
	await args.progress("Reading your Instinct account", { stream: "profile" });
	const flags = await collectProfile(args);

	if (args.requested.has("agent_contact")) {
		await args.progress("Reading how you reach your agent", {
			stream: "agent_contact",
		});
		await collectAgentContact(args);
	}
	if (args.requested.has("connections")) {
		await args.progress("Reading connected services", {
			stream: "connections",
		});
		await collectConnections(args, resolveConnectionGates(flags));
	}
	if (args.requested.has("devices")) {
		await args.progress("Reading enrolled devices", { stream: "devices" });
		await collectDevices(args);
	}
	if (args.requested.has("trusted_people")) {
		await args.progress("Reading your trusted people", {
			stream: "trusted_people",
		});
		await collectTrustedPeople(args);
	}
	if (args.requested.has("vault_entries")) {
		await args.progress("Reading your vault inventory", {
			stream: "vault_entries",
		});
		await collectVaultEntries(args);
	}
	if (args.requested.has("chats") || args.requested.has("chat_events")) {
		await args.progress("Reading your conversations with your agent", {
			stream: "chat_events",
		});
		await collectChats(args);
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		browser: { profileName: "instinct" },
		name: "instinct",
		retryablePattern:
			/ECONN|ETIMEDOUT|timeout|fetch failed|instinct_rate_limited|instinct_http_5\d\d/i,
		timeRangeField: (stream) =>
			stream === "devices" || stream === "chat_events"
				? "created_at"
				: "observed_at",
		validateRecord,
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectInstinct({
				emit: ctx.emit,
				emitRecord: ctx.emitRecord,
				graphql: makeInstinctGraphql(ctx.page),
				observedAt: ctx.emittedAt,
				progress: ctx.progress,
				requested: new Set(ctx.requested.keys()),
				state: ctx.state,
			});
		},
		async ensureSession({ capture, page, sendInteraction }) {
			await ensureInstinctSession({
				...(capture ? { capture } : {}),
				graphql: makeInstinctGraphql(page),
				interactive: instinctAllowsInteractiveAuthRepair(),
				page,
				sendInteraction,
			});
		},
	});
}
