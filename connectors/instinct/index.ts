#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Instinct Connector.
 *
 * Instinct (instinct.com, Spear Street Technology) is an invite-only personal
 * AI agent the owner reaches over SMS, WhatsApp, voice, and email. The web
 * app at app.instinct.com is mostly an account console (/workspace, /vault,
 * /trusted-networks, /settings), plus an /agent chat page hidden behind the
 * `agent_chat` / `mobile_chat` feature flags. The flag gates only the page:
 * the `chats` and `chatHistory` resolvers behind it answer for any signed-in
 * owner, and they hold the agent's conversation log across channels.
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
 * no scriptable login. `ensureSession` reads `authSession` from the page as
 * it is (one navigation to the app only when the page is elsewhere). A
 * signed-out answer opens the app's own sign-in page and hands it to the
 * person through `manualBrowserLogin`; readiness is the same `authSession`
 * read on that page, which never navigates it. Session errors are thrown as
 * bare codes so the runtime keeps them.
 *
 * Mobile (PageShim): the same collector runs in the phone's WebView through
 * `collectInstinctOnPage`, and `probeInstinctSession` is the host's
 * non-navigating session probe. The host opens the app's sign-in page, so the
 * GraphQL POST leaves from app.instinct.com exactly as on desktop: a
 * same-site request to api.instinct.com with the page's own cookies.
 *
 * Completeness: a stream is checkpointed only after its whole list was read
 * and Instinct reported no error on it. List streams end with a full-scan
 * DETAIL_COVERAGE and then STATE. A list that cannot be proven (a GraphQL
 * error on its path, an unrecognised answer, a repeated cursor, the page
 * guard) fails that stream through `reportStreamFailure` with no STATE, and
 * the other streams continue. `chat_events` accounts per chat: a chat whose
 * history cannot be read to the checkpoint gets a DETAIL_GAP, keeps its prior
 * checkpoint, and is read again on the next run.
 *
 * Pagination: account-state streams are one small read each. `chats` pages by
 * `limit`/`cursor`; `chatHistory` returns the newest window first with a
 * cursor to older windows (each window ascending by `createdAt`, epoch
 * seconds). A first run backfills everything; later runs page only until they
 * reach the per-chat checkpoint in the chats STATE. All loops are bounded.
 *
 * Time ranges (Collection Profile 5.1, 5.2): records carry only times
 * Instinct reports. profile, agent_contact, connections and vault_entries
 * have no source time, so they declare no consent_time_field and are not
 * collected under a time_range (the runtime reports scope_not_supported).
 * devices and trusted_people filter on `created_at`, chats on
 * `last_event_at` (its newest event), chat_events on `created_at`. A
 * `chat_events` `since` is pushed down: paging stops at the first window
 * older than it. The per-chat checkpoint records how far down the history
 * was delivered (`covered_since`), so a later run with an earlier `since`
 * reads the older part instead of skipping it. A run whose events are
 * filtered by `resources`, or that read an event at or after `until`, keeps
 * the prior checkpoints. `until` cannot be pushed down: the history is
 * newest first and has no upper-bound parameter.
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
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	createConnectorFailure,
	type EmittedMessage,
	type EnsureSessionArgs,
	emitDetailCoverage,
	emitDetailGap,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	agentContactRecord,
	type ChatEventsScope,
	chatEventRecord,
	chatReadPlan,
	chatRecord,
	connectionRecords,
	deviceRecords,
	eventEpochSeconds,
	imessageConnectionRecord,
	messagingConnectionRecords,
	newestEventAt,
	nextCheckpoint,
	profileRecord,
	shouldEmitEvent,
	stopBelowSecond,
	toIso,
	deliveredAll,
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
	ChatReadPlan,
	ConnectionFeatureGates,
	GraphqlError,
	GraphqlFetchResult,
	ImessageDeviceResponse,
	InstinctGraphql,
	ProfileResponse,
	TrustedNetworkResponse,
} from "./types.ts";

const APP_ORIGIN = "https://app.instinct.com";
const APP_URL = `${APP_ORIGIN}/workspace`;
/** The app's own sign-in route; `returnTo` brings the person back to the workspace. */
export const SIGN_IN_URL = `${APP_ORIGIN}/signin?returnTo=%2Fworkspace`;
const API_URL = "https://api.instinct.com/-/api/graphql";

// ─── Error codes ───────────────────────────────────────────────────────────
//
// Every code is bare snake_case so the runtime keeps it as the terminal
// `code` (session-establish.ts recovers a code only when the whole message is
// one). Each has owner-facing copy in manifest.json reason_display_messages.

/** Signed out, or the person did not finish signing in. Not retryable. */
export const INSTINCT_AUTH_FAILED = "instinct_auth_failed";
/** The session check got no usable answer. Retryable. */
export const INSTINCT_INTERRUPTED = "instinct_interrupted";
const INSTINCT_RATE_LIMITED = "instinct_rate_limited";
const INSTINCT_SERVER_ERROR = "instinct_server_error";
const INSTINCT_REQUEST_REJECTED = "instinct_request_rejected";
const INSTINCT_SOURCE_UNREADABLE = "instinct_source_unreadable";
const INSTINCT_STREAM_INCOMPLETE = "instinct_stream_incomplete";

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

// The session check asks for the signed-in user alone, so no other resolver's
// failure can be read as a sign-out.
const SESSION_QUERY = `query PdppInstinctSession {
  authSession { user { id } }
}`;

const PROFILE_QUERY = `query PdppInstinctProfile {
  authSession { user { id name email roles enabledFeatureFlags onboardingStep phoneNumber preferences { trainingDataOptOut } } }
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
// `signedUrl`/`url` values are short-lived bearer links, so neither is asked
// for: attachments come without them, and a screenshot is selected only by
// its type name, which says one exists.
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
      screenshot { __typename }
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
/**
 * A page.evaluate that failed because the page moved or closed under it
 * (the app still redirecting after sign-in, a reload): the request never
 * reached Instinct, so it is read like one that did not complete (status 0),
 * which is retryable. On the mobile PageShim host the same event surfaces as
 * an evaluation that answered nothing (the host turns a page error into
 * null), which the host adapter reports as an invalid transfer marker, or
 * as a failed transfer when the page moved while a large answer was being
 * read back in chunks.
 */
export function isPageInterruption(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Execution context was destroyed|context or browser has been closed|Target (?:page, context or browser )?(?:has been )?closed|frame was detached|Navigating frame was detached|navigation|PageShim evaluation (?:returned an invalid transfer marker|transfer failed)/i.test(
		message,
	);
}

export function makeInstinctGraphql(
	page: Pick<Page, "evaluate">,
): InstinctGraphql {
	return async (query, variables = {}) => {
		try {
			return await evaluateGraphql(page, query, variables);
		} catch (error) {
			if (isPageInterruption(error)) {
				return { json: null, status: 0 };
			}
			throw error;
		}
	};
}

async function evaluateGraphql(
	page: Pick<Page, "evaluate">,
	query: string,
	variables: Readonly<Record<string, unknown>>,
): Promise<GraphqlFetchResult> {
	return await page.evaluate(
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
 * The classified failure for a transport-level outcome, or null when the
 * response is a readable 2xx. GraphQL-level `errors[]` are not judged here:
 * Instinct answers 200 with partial data when one resolver fails, and each
 * stream decides what that means for its own completeness.
 */
function transportFailure(
	result: GraphqlFetchResult,
	operation: string,
): Error | null {
	const { status } = result;
	if (status === 401 || status === 403) {
		return createConnectorFailure(
			INSTINCT_AUTH_FAILED,
			`Instinct answered ${String(status)} on ${operation}; the session is no longer signed in.`,
			{ retryable: false },
		);
	}
	if (status === 429) {
		return createConnectorFailure(
			INSTINCT_RATE_LIMITED,
			`Instinct asked to slow down (429) on ${operation}.`,
			{ retryable: true },
		);
	}
	if (status === 0 || status >= 500) {
		return createConnectorFailure(
			INSTINCT_SERVER_ERROR,
			status === 0
				? `The ${operation} request did not complete.`
				: `Instinct answered ${String(status)} on ${operation}.`,
			{ retryable: true },
		);
	}
	if (status < 200 || status >= 300) {
		return createConnectorFailure(
			INSTINCT_REQUEST_REJECTED,
			`Instinct refused ${operation} with ${String(status)}.`,
			{ retryable: false },
		);
	}
	if (result.invalidJson === true) {
		return createConnectorFailure(
			INSTINCT_SOURCE_UNREADABLE,
			`Instinct answered ${operation} with a body that is not JSON.`,
			{ retryable: false },
		);
	}
	return null;
}

function assertTransport(
	result: GraphqlFetchResult,
	operation: string,
): unknown {
	const failure = transportFailure(result, operation);
	if (failure !== null) {
		throw failure;
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

// ─── Stream failures ───────────────────────────────────────────────────────

/**
 * Portable recovery hints (Collection Profile 5.5) for a failure retrying
 * cannot fix. A retryable failure carries none and keeps the runtime's
 * default.
 */
type RecoveryAction = "not_retriable" | "retry_on_connector_upgrade";

/** A stream whose list could not be proven complete this run. */
export class StreamIncomplete extends Error {
	readonly hint: RecoveryAction | undefined;
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean, hint?: RecoveryAction) {
		super(message);
		this.name = "StreamIncomplete";
		this.retryable = retryable;
		this.hint = retryable ? undefined : hint;
	}
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined;
	}
	const { code } = error as { code?: unknown };
	return typeof code === "string" ? code : undefined;
}

/**
 * The recovery hint for a failure retrying cannot fix: an answer this
 * connector cannot read needs a connector update, a refused request needs
 * nothing this connector can do.
 */
function errorHint(error: unknown): RecoveryAction | undefined {
	if (error instanceof StreamIncomplete) {
		return error.hint;
	}
	switch (errorCode(error)) {
		case INSTINCT_SOURCE_UNREADABLE:
			return "retry_on_connector_upgrade";
		case INSTINCT_REQUEST_REJECTED:
			return "not_retriable";
		default:
			return undefined;
	}
}

function errorRetryable(error: unknown): boolean {
	if (error instanceof StreamIncomplete) {
		return error.retryable;
	}
	const { retryable } = error as { retryable?: unknown };
	return retryable === true;
}

/** An unrecognised response shape: retrying will not help, a connector update will. */
function unreadable(operation: string, error: z.ZodError): StreamIncomplete {
	const issues = error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
	return new StreamIncomplete(
		`Instinct answered ${operation} in a shape this connector does not recognise (${issues}).`,
		false,
		"retry_on_connector_upgrade",
	);
}

/** Instinct reported an error on this read, so its answer cannot be trusted as whole. */
function graphqlFailure(
	operation: string,
	errors: readonly GraphqlError[] | null | undefined,
): StreamIncomplete | null {
	const note = describeGraphqlErrors(errors);
	return note === null
		? null
		: new StreamIncomplete(
				`Instinct reported an error on ${operation} (${note}), so it was not read completely.`,
				true,
			);
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

export type SessionState = "signed_in" | "signed_out" | "unknown";

/** GraphQL error wording that means "not signed in". */
const SIGNED_OUT_ERROR =
	/\b(?:unauthenticated|unauthori[sz]ed|not authenticated|not logged in|not signed in|login required|sign-?in required)\b/i;

/**
 * What one `authSession` read says about the session. 401/403, a readable
 * answer with no user and no error, or one whose every error says the
 * request is not signed in, is signed out. A request that did not complete,
 * a 429 or 5xx, a body this connector cannot read, or any other GraphQL
 * error says nothing either way.
 */
export function classifySession(result: GraphqlFetchResult): SessionState {
	const { status } = result;
	if (status === 401 || status === 403) {
		return "signed_out";
	}
	if (status < 200 || status >= 300 || result.invalidJson === true) {
		return "unknown";
	}
	const parsed = profileResponseSchema.safeParse(result.json);
	if (!parsed.success) {
		return "unknown";
	}
	if (typeof parsed.data.data?.authSession?.user?.id === "string") {
		return "signed_in";
	}
	const errors = parsed.data.errors ?? [];
	return errors.every((error) => SIGNED_OUT_ERROR.test(error.message))
		? "signed_out"
		: "unknown";
}

/** One `authSession` read on the page as it is. Never navigates. */
async function readSession(graphql: InstinctGraphql): Promise<SessionState> {
	try {
		return classifySession(await graphql(SESSION_QUERY));
	} catch {
		// The page was mid-navigation or closed: no evidence either way.
		return "unknown";
	}
}

/**
 * Whether the page's own session is signed in: one `authSession` read on the
 * page as it is. Never navigates, so it is the PageShim probe, polled while
 * the person signs in on the app's sign-in page. A page that is not on the
 * app (the request then cannot carry the session) or an answer that says
 * nothing either way reads as not signed in.
 */
export async function probeInstinctSession(
	page: Pick<Page, "evaluate">,
): Promise<boolean> {
	return (await readSession(makeInstinctGraphql(page))) === "signed_in";
}

const SESSION_CHECK_RETRIES = 2;
const SESSION_RETRY_DELAY_MS = 2000;
const SIGN_IN_TIMEOUT_SECONDS = 30 * 60;
const SIGN_IN_PROBE_INTERVAL_MS = 5000;

const SIGN_IN_MESSAGE =
	"Sign in to Instinct in the secure browser: enter your phone number, complete the check, and type the SMS code. Collection starts once Instinct answers for your account.";

const realDelay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export interface EnsureInstinctSessionArgs
	extends Pick<
		EnsureSessionArgs,
		"assist" | "capture" | "completeAssistance" | "sendInteraction"
	> {
	readonly graphql: InstinctGraphql;
	readonly interactive: boolean;
	readonly page: Pick<Page, "goto" | "url">;
}

/** Test seams: production uses the real clock and the default cadence. */
export interface SessionTimings {
	readonly delay?: (ms: number) => Promise<void>;
	readonly probeIntervalMs?: number;
	readonly probeWindowMs?: number;
}

function onAppOrigin(page: Pick<Page, "url">): boolean {
	try {
		return new URL(page.url()).origin === APP_ORIGIN;
	} catch {
		return false;
	}
}

export async function ensureInstinctSession(
	args: EnsureInstinctSessionArgs,
	timings: SessionTimings = {},
): Promise<void> {
	const delay = timings.delay ?? realDelay;
	const { page } = args;
	// The GraphQL call runs from the app origin, so a page that is elsewhere
	// (a fresh about:blank) is moved there once. A page already on the app is
	// read where it is.
	if (!onAppOrigin(page)) {
		await page
			.goto(APP_URL, { timeout: 30_000, waitUntil: "domcontentloaded" })
			.catch((): undefined => undefined);
	}
	let state = await readSession(args.graphql);
	for (
		let retry = 0;
		state === "unknown" && retry < SESSION_CHECK_RETRIES;
		retry += 1
	) {
		await delay(SESSION_RETRY_DELAY_MS);
		state = await readSession(args.graphql);
	}
	if (state === "signed_in") {
		return;
	}
	if (state === "unknown") {
		connectorDiagnostic("instinct", "session_check_no_answer", {
			reads: SESSION_CHECK_RETRIES + 1,
		});
		throw new Error(INSTINCT_INTERRUPTED);
	}
	if (!args.interactive) {
		connectorDiagnostic("instinct", "signed_out_unattended", {});
		throw new Error(INSTINCT_AUTH_FAILED);
	}

	try {
		await page.goto(SIGN_IN_URL, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
	} catch {
		connectorDiagnostic("instinct", "sign_in_page_not_opened", {});
		throw new Error(INSTINCT_INTERRUPTED);
	}
	const readiness = async (): Promise<boolean> =>
		(await readSession(args.graphql)) === "signed_in";
	// The streamed handoff (assist + readiness on the page) either resolves
	// with a ready session or throws: a timeout or a closed page are the
	// person not finishing the sign-in, reported under this connector's code.
	try {
		await manualBrowserLogin({
			assist: args.assist,
			autoProbeIntervalMs: timings.probeIntervalMs ?? SIGN_IN_PROBE_INTERVAL_MS,
			...(timings.probeWindowMs === undefined
				? {}
				: { autoProbeWindowMs: timings.probeWindowMs }),
			capture: args.capture,
			completeAssistance: args.completeAssistance,
			isProbeSuccessful: (ok) => ok,
			message: SIGN_IN_MESSAGE,
			page: page as Page,
			probe: readiness,
			readinessProbe: readiness,
			readinessProbeOnHandoffPage: true,
			sendInteraction: args.sendInteraction,
			timeoutSeconds: SIGN_IN_TIMEOUT_SECONDS,
		});
	} catch (error) {
		const code = errorCode(error);
		if (
			code === "browser_handoff_readiness_timed_out" ||
			code === "browser_sign_in_cancelled"
		) {
			connectorDiagnostic("instinct", "sign_in_not_completed", { code });
			throw new Error(INSTINCT_AUTH_FAILED);
		}
		throw error;
	}
	// The person is signed in and nothing of this connector is in flight. The
	// sign-in page may still be redirecting, so collection starts from the
	// workspace, and only a signed-out answer there stops it.
	await page
		.goto(APP_URL, { timeout: 30_000, waitUntil: "domcontentloaded" })
		.catch((): undefined => undefined);
	if ((await readSession(args.graphql)) === "signed_out") {
		connectorDiagnostic("instinct", "signed_out_after_sign_in", {});
		throw new Error(INSTINCT_AUTH_FAILED);
	}
}

// ─── Collection ────────────────────────────────────────────────────────────

export interface CollectInstinctArgs
	extends Partial<
		Pick<
			BrowserCollectContext,
			| "collectionMode"
			| "detailGaps"
			| "recoveryOnly"
			| "reportStreamFailure"
			| "requestDetailGapPage"
		>
	> {
	readonly emit: (message: EmittedMessage) => Promise<void>;
	readonly emitRecord: (stream: string, data: RecordData) => Promise<void>;
	readonly graphql: InstinctGraphql;
	/**
	 * The run's clock, kept only in STATE cursors of the account-state
	 * streams (Collection Profile 5.3). Never written into a record.
	 */
	readonly observedAt: string;
	readonly progress: (
		message: string,
		extra?: Record<string, unknown>,
	) => Promise<void>;
	readonly requested: ReadonlySet<string>;
	/**
	 * Each requested stream's START scope (`resources`, `time_range`). The
	 * runtime applies both to every record; the collector reads them to push
	 * the bounds down to Instinct and to keep checkpoints honest.
	 */
	readonly scopes?: ReadonlyMap<string, InstinctStreamScope>;
	/** Stream-keyed state from START; only the chats STATE is read. */
	readonly state?: Readonly<Record<string, unknown>>;
}

/** The part of one START scope stream this collector reads. */
export type InstinctStreamScope = ChatEventsScope;

/**
 * Streams Instinct reports no time for. They declare no consent_time_field,
 * so a time_range cannot apply to them: the desktop runtime withholds them
 * before collect and reports scope_not_supported; the PageShim host reports
 * it after collect, so the collector itself must not read them either.
 */
export const UNTIMED_STREAMS: ReadonlySet<string> = new Set([
	"agent_contact",
	"connections",
	"profile",
	"vault_entries",
]);

/** True when this run collects `stream`. */
function collects(args: CollectInstinctArgs, stream: string): boolean {
	if (!args.requested.has(stream)) {
		return false;
	}
	return !(
		UNTIMED_STREAMS.has(stream) &&
		args.scopes?.get(stream)?.time_range !== undefined
	);
}

/**
 * False when the stream's `resources` list leaves out `key`: the runtime
 * would drop the record, so it is not read at all.
 */
function resourceWanted(
	args: CollectInstinctArgs,
	stream: string,
	key: string,
): boolean {
	const resources = args.scopes?.get(stream)?.resources;
	return resources === undefined || resources.includes(key);
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

/**
 * Fail the requested ones of `streams` for this run: no STATE, and the
 * runtime ends the run failed while the other streams keep going. A signed-out
 * answer stops the whole run instead, and an error that is neither a
 * classified Instinct failure nor a StreamIncomplete is a bug and propagates.
 */
async function failStreams(
	args: CollectInstinctArgs,
	streams: readonly string[],
	error: unknown,
): Promise<void> {
	const code = errorCode(error);
	if (code === INSTINCT_AUTH_FAILED) {
		throw error;
	}
	if (!(error instanceof StreamIncomplete) && code === undefined) {
		throw error;
	}
	const message = error instanceof Error ? error.message : String(error);
	const retryable = errorRetryable(error);
	const hint = errorHint(error);
	const recoveryHint =
		hint === undefined ? undefined : { action: hint, retryable };
	for (const stream of streams) {
		if (!collects(args, stream)) {
			continue;
		}
		connectorDiagnostic("instinct", "stream_failed", { retryable, stream });
		if (!args.reportStreamFailure) {
			throw createConnectorFailure(INSTINCT_STREAM_INCOMPLETE, message, {
				retryable,
				...(recoveryHint === undefined ? {} : { recoveryHint }),
			});
		}
		await args.reportStreamFailure(stream, message, {
			retryable,
			...(recoveryHint === undefined ? {} : { recoveryHint }),
		});
	}
}

/** Run one read; on failure, fail `streams` and answer null. */
async function readOrFail<T>(
	args: CollectInstinctArgs,
	streams: readonly string[],
	read: () => Promise<T>,
): Promise<{ value: T } | null> {
	try {
		return { value: await read() };
	} catch (error) {
		await failStreams(args, streams, error);
		return null;
	}
}

async function checkpoint(
	emit: CollectInstinctArgs["emit"],
	stream: string,
	observedAt: string,
): Promise<void> {
	await emit({ cursor: { observed_at: observedAt }, stream, type: "STATE" });
}

/**
 * Why some of these records would not pass the stream's schema (counts and
 * field paths only, never values), or null when every one passes. The
 * runtime drops a record that fails its schema, so a stream must not claim
 * completeness over one.
 */
export function schemaProblems(
	stream: string,
	records: readonly RecordData[],
): string | null {
	let failed = 0;
	const paths = new Set<string>();
	for (const record of records) {
		const result = validateRecord(stream, record);
		if (!result.ok) {
			failed += 1;
			for (const issue of result.issues) {
				paths.add(issue.path || "(record)");
			}
		}
	}
	return failed === 0
		? null
		: `${String(failed)} ${stream} record(s) did not pass this connector's schema (${[...paths].slice(0, 5).join(", ")}).`;
}

/**
 * Records sharing one primary key would overwrite each other while coverage
 * counts both, so a list holding any cannot be checkpointed as complete.
 */
export function duplicateKeys(
	stream: string,
	records: readonly RecordData[],
): string | null {
	const ids = new Set(records.map((record) => String(record.id)));
	const repeated = records.length - ids.size;
	return repeated === 0
		? null
		: `${String(repeated)} ${stream} record(s) share a key with another record, so the list cannot be stored without losing one.`;
}

/**
 * Emit a proven list: its records, the full-scan coverage that says the
 * whole list was read, then its STATE. Only called once the list's end was
 * observed with no error on its path. A record that would fail its schema
 * fails the stream instead, before anything is emitted.
 */
async function emitProvenList(
	args: CollectInstinctArgs,
	stream: string,
	records: readonly RecordData[],
): Promise<void> {
	const problems =
		schemaProblems(stream, records) ?? duplicateKeys(stream, records);
	if (problems !== null) {
		await failStreams(
			args,
			[stream],
			new StreamIncomplete(problems, false, "retry_on_connector_upgrade"),
		);
		return;
	}
	for (const record of records) {
		await args.emitRecord(stream, record);
	}
	await args.emit(buildFullScanCoverageMessage(stream, records.length));
	await checkpoint(args.emit, stream, args.observedAt);
}

interface ProfileRead {
	/** The account's feature flags, or null when the read did not prove them. */
	readonly flags: readonly string[] | null;
	readonly profile: ProfileResponse;
}

async function readProfile(args: CollectInstinctArgs): Promise<ProfileRead> {
	const raw = assertTransport(await args.graphql(PROFILE_QUERY), "authSession");
	const parsed = profileResponseSchema.safeParse(raw);
	if (!parsed.success) {
		throw unreadable("authSession", parsed.error);
	}
	const user = parsed.data.data?.authSession?.user;
	if (typeof user?.id !== "string") {
		const failure = graphqlFailure("the account read", parsed.data.errors);
		if (failure !== null) {
			// An error, not an empty session: it says nothing about sign-in.
			throw failure;
		}
		throw createConnectorFailure(
			INSTINCT_AUTH_FAILED,
			"Instinct no longer answers for a signed-in account.",
			{ retryable: false },
		);
	}
	const flagsFailed = (parsed.data.errors ?? []).some(
		(error) => error.path?.[0] === "authSession",
	);
	return {
		flags:
			Array.isArray(user.enabledFeatureFlags) && !flagsFailed
				? user.enabledFeatureFlags
				: null,
		profile: parsed.data,
	};
}

/**
 * Read the profile. Returns the account's feature flags, which the
 * connections query needs to decide which feature-gated resolvers it may ask
 * for; null when they could not be read, in which case connections fails
 * rather than skip a resolver the account may use.
 */
async function collectProfile(
	args: CollectInstinctArgs,
): Promise<readonly string[] | null> {
	const read = await readOrFail(args, ["profile", "connections"], () =>
		readProfile(args),
	);
	if (read === null) {
		return null;
	}
	const { flags, profile } = read.value;
	if (flags === null) {
		await failStreams(
			args,
			["connections"],
			new StreamIncomplete(
				"Instinct did not return this account's feature flags, so it is unknown which connected services to ask for.",
				true,
			),
		);
	}
	if (!collects(args, "profile")) {
		return flags;
	}
	const failure = graphqlFailure("the profile read", profile.errors);
	const record = profileRecord(profile);
	if (failure !== null || record === null) {
		await failStreams(
			args,
			["profile"],
			failure ?? new StreamIncomplete("Instinct returned no profile.", true),
		);
		return flags;
	}
	await emitProvenList(args, "profile", [record]);
	return flags;
}

async function collectAgentContact(args: CollectInstinctArgs): Promise<void> {
	const read = await readOrFail(args, ["agent_contact"], async () => {
		const raw = assertTransport(
			await args.graphql(AGENT_CONTACT_QUERY),
			"agentContact",
		);
		const parsed = agentContactResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw unreadable("agentContact", parsed.error);
		}
		const failure = graphqlFailure("agentContact", parsed.data.errors);
		if (failure !== null) {
			throw failure;
		}
		return parsed.data.data?.agentContact ?? null;
	});
	if (read === null) {
		return;
	}
	// Answered without error and without details: this agent has no contact
	// channels assigned yet, which is proven-empty rather than unknown.
	await emitProvenList(
		args,
		"agent_contact",
		read.value === null ? [] : [agentContactRecord(read.value)],
	);
}

/**
 * Whether every error on the local-iMessage read is the one Instinct gives
 * an account with no local iMessage relay: `internal server error` on the
 * `imessageLocalConnection` path, observed live. That answer means "no
 * relay", not a failed read.
 */
export function isNoRelayAnswer(
	errors: readonly GraphqlError[] | null | undefined,
): boolean {
	return (
		errors !== null &&
		errors !== undefined &&
		errors.length > 0 &&
		errors.every(
			(error) =>
				error.path?.length === 1 &&
				error.path[0] === "imessageLocalConnection" &&
				error.message === "internal server error",
		)
	);
}

async function readConnections(
	args: CollectInstinctArgs,
	gates: ConnectionFeatureGates,
): Promise<RecordData[]> {
	const connections = connectionsResponseSchema.safeParse(
		assertTransport(
			await args.graphql(CONNECTIONS_QUERY, {
				showStripeLink: gates.showStripeLink,
				showWhoop: gates.showWhoop,
			}),
			"connections",
		),
	);
	if (!connections.success) {
		throw unreadable("connections", connections.error);
	}
	const connectionsError = graphqlFailure(
		"connected services",
		connections.data.errors,
	);
	if (connectionsError !== null) {
		throw connectionsError;
	}
	const connected = connections.data.data;
	if (
		connected === null ||
		!Array.isArray(connected.googleWorkspaceConnections) ||
		!Array.isArray(connected.outlookConnections) ||
		!Array.isArray(connected.linearConnections) ||
		!Array.isArray(connected.notionConnections)
	) {
		throw new StreamIncomplete(
			"Instinct did not return every connected-service list.",
			true,
		);
	}

	const messaging = messagingResponseSchema.safeParse(
		assertTransport(await args.graphql(MESSAGING_QUERY), "messaging"),
	);
	if (!messaging.success) {
		throw unreadable("messaging", messaging.error);
	}
	const messagingError = graphqlFailure(
		"messaging connections",
		messaging.data.errors,
	);
	if (messagingError !== null) {
		throw messagingError;
	}
	if (messaging.data.data === null) {
		throw new StreamIncomplete(
			"Instinct returned no messaging connections.",
			true,
		);
	}

	const imessage = imessageDeviceResponseSchema.safeParse(
		assertTransport(
			await args.graphql(IMESSAGE_DEVICE_QUERY),
			"imessageLocalConnection",
		),
	);
	if (!imessage.success) {
		throw unreadable("imessageLocalConnection", imessage.error);
	}
	let relay: ImessageDeviceResponse = imessage.data;
	if (isNoRelayAnswer(imessage.data.errors)) {
		relay = { data: null };
	} else {
		const relayError = graphqlFailure(
			"the local iMessage relay",
			imessage.data.errors,
		);
		if (relayError !== null) {
			throw relayError;
		}
	}

	const records = [
		...connectionRecords(connections.data),
		...messagingConnectionRecords(messaging.data),
	];
	// Both iMessage resolvers feed one record, built after both answered.
	const imessageRecord = imessageConnectionRecord(messaging.data, relay);
	if (imessageRecord !== null) {
		records.push(imessageRecord);
	}
	return records;
}

async function collectConnections(
	args: CollectInstinctArgs,
	gates: ConnectionFeatureGates,
): Promise<void> {
	const read = await readOrFail(args, ["connections"], () =>
		readConnections(args, gates),
	);
	if (read !== null) {
		await emitProvenList(args, "connections", read.value);
	}
}

async function collectDevices(args: CollectInstinctArgs): Promise<void> {
	const read = await readOrFail(args, ["devices"], async () => {
		const parsed = devicesResponseSchema.safeParse(
			assertTransport(await args.graphql(DEVICES_QUERY), "devices"),
		);
		if (!parsed.success) {
			throw unreadable("devices", parsed.error);
		}
		const failure = graphqlFailure("devices", parsed.data.errors);
		if (failure !== null) {
			throw failure;
		}
		if (!Array.isArray(parsed.data.data?.devices)) {
			throw new StreamIncomplete("Instinct returned no device list.", true);
		}
		return deviceRecords(parsed.data);
	});
	if (read !== null) {
		await emitProvenList(args, "devices", read.value);
	}
}

type TrustedList = "blocked" | "contacts" | "requests";

const TRUSTED_LIST_FIELD = {
	blocked: "trustedNetworkBlockedPeople",
	contacts: "trustedNetworkContacts",
	requests: "trustedNetworkRequests",
} as const satisfies Record<TrustedList, string>;

const TRUSTED_LISTS: readonly TrustedList[] = [
	"contacts",
	"blocked",
	"requests",
];

/**
 * Walk the three paginated trust lists side by side. One query pages all
 * three, so a list that already ended is still answered (from its first page,
 * since its cursor goes back to null); its items and cursor are ignored from
 * then on, which keeps a short list from restarting while a longer one is
 * still paging. Sent requests have no cursor at all: the first page's are
 * kept, and a full page of them cannot be proven to be all of them.
 */
async function readTrustedPeople(
	args: CollectInstinctArgs,
): Promise<RecordData[]> {
	const cursors: Record<TrustedList, string | null> = {
		blocked: null,
		contacts: null,
		requests: null,
	};
	const ended = new Set<TrustedList>();
	const seenCursors = new Set<string>();
	const records = new Map<string, RecordData>();

	for (let page = 0; page < MAX_TRUSTED_PAGES; page += 1) {
		const parsed = trustedNetworkResponseSchema.safeParse(
			assertTransport(
				await args.graphql(TRUSTED_QUERY, {
					blockedCursor: cursors.blocked,
					contactsCursor: cursors.contacts,
					limit: TRUSTED_PAGE_SIZE,
					requestsCursor: cursors.requests,
				}),
				"trustedNetwork",
			),
		);
		if (!parsed.success) {
			throw unreadable("trustedNetwork", parsed.error);
		}
		const failure = graphqlFailure("the trusted network", parsed.data.errors);
		if (failure !== null) {
			throw failure;
		}
		const data = parsed.data.data;
		if (data === null) {
			throw new StreamIncomplete("Instinct returned no trusted network.", true);
		}
		const sent = page === 0 ? data.trustedNetworkSentRequests : [];
		if (!Array.isArray(sent)) {
			throw new StreamIncomplete(
				"Instinct returned no list of sent trust requests.",
				true,
			);
		}
		if (sent.length >= TRUSTED_PAGE_SIZE) {
			throw new StreamIncomplete(
				`Instinct returned a full page of ${String(TRUSTED_PAGE_SIZE)} sent trust requests and offers no way to read past it, so the list may be longer than what was read.`,
				false,
				"not_retriable",
			);
		}
		const open: NonNullable<TrustedNetworkResponse["data"]> = {
			...data,
			trustedNetworkSentRequests: sent,
		};
		for (const list of TRUSTED_LISTS) {
			const field = TRUSTED_LIST_FIELD[list];
			if (ended.has(list)) {
				open[field] = null;
			} else if (!Array.isArray(data[field]?.items)) {
				throw new StreamIncomplete(
					`Instinct returned no ${list} page for the trusted network.`,
					true,
				);
			}
		}
		for (const record of trustedPeopleRecords({ data: open })) {
			records.set(String(record.id), record);
		}
		for (const list of TRUSTED_LISTS) {
			if (ended.has(list)) {
				continue;
			}
			const cursor = data[TRUSTED_LIST_FIELD[list]]?.cursor;
			if (cursor === undefined) {
				throw new StreamIncomplete(
					`Instinct's ${list} page for the trusted network carried no cursor, so its end is unknown.`,
					true,
				);
			}
			const next = cursor;
			if (next === null) {
				ended.add(list);
				cursors[list] = null;
				continue;
			}
			const key = `${list}:${next}`;
			if (seenCursors.has(key)) {
				throw new StreamIncomplete(
					`Instinct handed back a ${list} cursor it had already given, so the trusted network did not page to its end.`,
					true,
				);
			}
			seenCursors.add(key);
			cursors[list] = next;
		}
		if (ended.size === TRUSTED_LISTS.length) {
			return [...records.values()];
		}
	}
	throw new StreamIncomplete(
		`Instinct's trusted network still had more after ${String(MAX_TRUSTED_PAGES)} pages, so it was not read to its end.`,
		true,
	);
}

async function collectTrustedPeople(args: CollectInstinctArgs): Promise<void> {
	const read = await readOrFail(args, ["trusted_people"], () =>
		readTrustedPeople(args),
	);
	if (read !== null) {
		await emitProvenList(args, "trusted_people", read.value);
	}
}

async function collectVaultEntries(args: CollectInstinctArgs): Promise<void> {
	const read = await readOrFail(args, ["vault_entries"], async () => {
		const parsed = vaultResponseSchema.safeParse(
			assertTransport(await args.graphql(VAULT_QUERY), "vault"),
		);
		if (!parsed.success) {
			throw unreadable("vault", parsed.error);
		}
		const failure = graphqlFailure("the vault", parsed.data.errors);
		if (failure !== null) {
			throw failure;
		}
		if (!Array.isArray(parsed.data.data?.vaultEntries)) {
			throw new StreamIncomplete("Instinct returned no vault inventory.", true);
		}
		return vaultEntryRecords(parsed.data);
	});
	if (read !== null) {
		await emitProvenList(args, "vault_entries", read.value);
	}
}

// ─── Chats ─────────────────────────────────────────────────────────────────

const chatCheckpointSchema = z.object({
	covered_since: z.number().int().nullable(),
	newest_created_at: z.number().int().nullable(),
	newest_ids: z.array(z.string()),
});

/**
 * Prior per-chat event checkpoints, from the chats STATE (chat_events is a
 * parent-detail stream with no STATE of its own). START.state carries each
 * stream's last STATE cursor as-is, so this reads the `{ chats }` object the
 * chats STATE below carries. A chat whose checkpoint is unreadable has none,
 * and its history is read again from the start. That includes checkpoints
 * from 0.1.1 and earlier, which carry no `covered_since`: a time-bounded run
 * could have moved them past events it never delivered, so they are not
 * trusted.
 */
export function readChatCheckpoints(
	state: Readonly<Record<string, unknown>> | undefined,
): Record<string, ChatCheckpoint> {
	const cursor = state?.chats;
	if (typeof cursor !== "object" || cursor === null) {
		return {};
	}
	const chats = (cursor as { chats?: unknown }).chats;
	if (typeof chats !== "object" || chats === null || Array.isArray(chats)) {
		return {};
	}
	const marks: Record<string, ChatCheckpoint> = {};
	for (const [chatId, value] of Object.entries(chats)) {
		const parsed = chatCheckpointSchema.safeParse(value);
		if (parsed.success) {
			marks[chatId] = parsed.data;
		}
	}
	return marks;
}

/** The whole chat list, or a StreamIncomplete when its end was not observed. */
async function readChatList(args: CollectInstinctArgs): Promise<Chat[]> {
	const chats = new Map<string, Chat>();
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	for (let page = 0; page < MAX_CHAT_LIST_PAGES; page += 1) {
		const parsed = chatsResponseSchema.safeParse(
			assertTransport(
				await args.graphql(CHATS_QUERY, { cursor, limit: CHATS_PAGE_SIZE }),
				"chats",
			),
		);
		if (!parsed.success) {
			throw unreadable("chats", parsed.error);
		}
		const failure = graphqlFailure("the chat list", parsed.data.errors);
		if (failure !== null) {
			throw failure;
		}
		const pageData = parsed.data.data?.chats;
		if (!(pageData && Array.isArray(pageData.chats))) {
			throw new StreamIncomplete("Instinct returned no chat list.", true);
		}
		for (const chat of pageData.chats) {
			chats.set(chat.id, chat);
		}
		if (pageData.cursor === undefined) {
			throw new StreamIncomplete(
				"Instinct's chat-list page carried no cursor, so its end is unknown.",
				true,
			);
		}
		const next = pageData.cursor;
		if (next === null) {
			return [...chats.values()];
		}
		if (seenCursors.has(next)) {
			throw new StreamIncomplete(
				"Instinct handed back a chat-list cursor it had already given, so the chat list did not page to its end.",
				true,
			);
		}
		seenCursors.add(next);
		cursor = next;
	}
	throw new StreamIncomplete(
		`Instinct's chat list still had more after ${String(MAX_CHAT_LIST_PAGES)} pages, so it was not read to its end.`,
		true,
	);
}

type ChatGap = {
	readonly errorClass: string;
	readonly httpStatus?: number;
	readonly kind: "gap";
	readonly message: string;
	readonly reason: "rate_limited" | "retry_exhausted" | "temporary_unavailable";
};

/** One `chatHistory` window: its events (ascending) and the cursor to older ones. */
type HistoryWindow =
	| {
			readonly cursor: string | null;
			readonly events: ChatEvent[];
			readonly kind: "window";
	  }
	| ChatGap;

type HistoryOutcome =
	| {
			/** Every event on the windows read, delivered or not. */
			readonly events: ChatEvent[];
			/** True when the start of the history was reached. */
			readonly ended: boolean;
			readonly kind: "read";
	  }
	| ChatGap;

/**
 * Read one `chatHistory` window. Anything but a readable window with a
 * cursor is a gap for this chat; a signed-out answer stops the run.
 */
async function readHistoryWindow(
	args: CollectInstinctArgs,
	chatId: string,
	cursor: string | null,
	limit: number,
): Promise<HistoryWindow> {
	const result = await args.graphql(CHAT_HISTORY_QUERY, {
		chatId,
		cursor,
		limit,
	});
	const failure = transportFailure(result, "chatHistory");
	if (failure !== null) {
		const code = errorCode(failure) ?? INSTINCT_SERVER_ERROR;
		if (code === INSTINCT_AUTH_FAILED) {
			throw failure;
		}
		return {
			errorClass: code,
			...(result.status > 0 ? { httpStatus: result.status } : {}),
			kind: "gap",
			message: failure.message,
			reason:
				code === INSTINCT_RATE_LIMITED
					? "rate_limited"
					: "temporary_unavailable",
		};
	}
	const parsed = chatHistoryResponseSchema.safeParse(result.json);
	if (!parsed.success) {
		return {
			errorClass: INSTINCT_SOURCE_UNREADABLE,
			kind: "gap",
			message: unreadable("chatHistory", parsed.error).message,
			reason: "temporary_unavailable",
		};
	}
	const history = parsed.data.data?.chatHistory;
	const errorNote = describeGraphqlErrors(parsed.data.errors);
	if (!history || errorNote !== null) {
		return {
			errorClass: "instinct_graphql_error",
			kind: "gap",
			message: errorNote ?? "chatHistory returned nothing",
			reason: "temporary_unavailable",
		};
	}
	if (!Array.isArray(history.events)) {
		return {
			errorClass: "instinct_graphql_error",
			kind: "gap",
			message: "chatHistory returned no event list",
			reason: "temporary_unavailable",
		};
	}
	if (history.cursor === undefined) {
		return {
			errorClass: "instinct_graphql_error",
			kind: "gap",
			message:
				"chatHistory carried no cursor, so the end of the history is unknown",
			reason: "temporary_unavailable",
		};
	}
	return { cursor: history.cursor, events: history.events, kind: "window" };
}

/**
 * Read one chat's history from the newest window down to where this run may
 * stop: the start of the history, or the first window holding an event older
 * than `stopBelowSecond` (the checkpoint's band, or the scope's `since`).
 * `first` is the newest window when it was already read for the chat's
 * `last_event_at`. Anything short of the stop is a gap for this chat.
 */
async function readChatHistory(
	args: CollectInstinctArgs,
	chatId: string,
	prior: ChatCheckpoint | null,
	plan: ChatReadPlan,
	first: HistoryWindow | undefined,
): Promise<HistoryOutcome> {
	const read: ChatEvent[] = [];
	const seenCursors = new Set<string>();
	const stopBelow = stopBelowSecond(prior, plan);
	let cursor: string | null = null;
	for (let page = 0; page < MAX_CHAT_HISTORY_PAGES; page += 1) {
		const window: HistoryWindow =
			page === 0 && first !== undefined
				? first
				: await readHistoryWindow(args, chatId, cursor, CHAT_HISTORY_PAGE_SIZE);
		if (window.kind === "gap") {
			return window;
		}
		read.push(...window.events);
		const next: string | null = window.cursor;
		// Windows are newest first. Only an event older than the stop second
		// proves everything beyond this window is older still: an event in that
		// very second does not, since the next window can still hold another
		// event from the same second.
		const reachedOlder =
			stopBelow !== null &&
			window.events.some((event) => {
				const seconds = eventEpochSeconds(event);
				return seconds !== null && seconds < stopBelow;
			});
		if (next === null || reachedOlder) {
			return { ended: next === null, events: read, kind: "read" };
		}
		if (seenCursors.has(next)) {
			return {
				errorClass: "instinct_cursor_repeated",
				kind: "gap",
				message: "chatHistory handed back a cursor it had already given",
				reason: "temporary_unavailable",
			};
		}
		seenCursors.add(next);
		cursor = next;
	}
	return {
		errorClass: "instinct_history_page_guard",
		kind: "gap",
		message: `chatHistory still had more after ${String(MAX_CHAT_HISTORY_PAGES)} pages`,
		reason: "retry_exhausted",
	};
}

function byCreatedAt(left: ChatEvent, right: ChatEvent): number {
	const leftSeconds = eventEpochSeconds(left) ?? 0;
	const rightSeconds = eventEpochSeconds(right) ?? 0;
	return leftSeconds - rightSeconds || left.id.localeCompare(right.id);
}

/** A chat_events gap an earlier run left pending. */
interface PendingGap {
	readonly gapId: string;
	readonly leaseId?: string;
}

/** chat_events gaps on one page of the host's pending gaps, by chat id. */
function pendingChatGaps(
	detailGaps: CollectInstinctArgs["detailGaps"],
): Map<string, PendingGap[]> {
	const byChat = new Map<string, PendingGap[]>();
	for (const gap of detailGaps ?? []) {
		if (gap.stream !== "chat_events") {
			continue;
		}
		const raw = gap.record_key;
		const key =
			typeof raw === "string"
				? raw
				: typeof raw === "number"
					? String(raw)
					: "";
		if (key === "") {
			continue;
		}
		const list = byChat.get(key) ?? [];
		list.push({
			gapId: gap.gap_id,
			...(gap.lease_id ? { leaseId: gap.lease_id } : {}),
		});
		byChat.set(key, list);
	}
	return byChat;
}

/**
 * Hand every pending chat_events gap to `handle` once: the START page first,
 * then further pages from the runtime until a page holds no gap not already
 * handled (the runtime answers with the gaps still pending, so recovered ones
 * drop out and a re-emitted one comes back once, already handled).
 */
async function forEachPendingGapPage(
	args: CollectInstinctArgs,
	first: CollectInstinctArgs["detailGaps"],
	handle: (fresh: ReadonlyMap<string, readonly PendingGap[]>) => Promise<void>,
): Promise<void> {
	const seen = new Set<string>();
	let page = first ?? [];
	for (;;) {
		const fresh = new Map<string, PendingGap[]>();
		for (const [chatId, gaps] of pendingChatGaps(page)) {
			const unseen = gaps.filter((gap) => !seen.has(gap.gapId));
			for (const gap of unseen) {
				seen.add(gap.gapId);
			}
			if (unseen.length > 0) {
				fresh.set(chatId, unseen);
			}
		}
		if (fresh.size === 0 || !args.requestDetailGapPage) {
			if (fresh.size > 0) {
				await handle(fresh);
			}
			return;
		}
		await handle(fresh);
		page = await args.requestDetailGapPage({ streams: ["chat_events"] });
	}
}

async function emitChatGap(
	args: CollectInstinctArgs,
	chatId: string,
	gap: ChatGap,
): Promise<void> {
	await emitDetailGap(args, {
		error: {
			class: gap.errorClass,
			...(gap.httpStatus === undefined ? {} : { httpStatus: gap.httpStatus }),
			message: gap.message,
		},
		locator: { chat_id: chatId, kind: "instinct.chat_history" },
		parentStream: "chats",
		reason: gap.reason,
		recordKey: chatId,
		stream: "chat_events",
	});
}

/**
 * Read chats' new events and account for them. A chat read down to its stop
 * emits its new in-scope events oldest first and gets its next checkpoint;
 * when the runtime delivered everything read, the gaps earlier runs left for
 * it are resolved. A chat that could not be read, or whose events would not
 * pass the schema, gets a DETAIL_GAP and keeps its prior checkpoint.
 *
 * `listed` chats are read first, each from its prefetched newest window when
 * there is one. Then every page of pending gaps: a gapped chat not read yet
 * (a recovery-only run, or a chat no longer listed) is read directly, since
 * deletion is never inferred. One DETAIL_COVERAGE closes the chats
 * considered. Returns the checkpoints to carry forward.
 */
async function hydrateChats(
	args: CollectInstinctArgs,
	listed: readonly string[],
	firstGapPage: CollectInstinctArgs["detailGaps"],
	prior: Readonly<Record<string, ChatCheckpoint>>,
	plan: ChatReadPlan,
	firstWindows: ReadonlyMap<string, HistoryWindow>,
): Promise<Record<string, ChatCheckpoint>> {
	const next: Record<string, ChatCheckpoint> = {};
	const required: string[] = [];
	const hydrated: string[] = [];
	const delivered: string[] = [];
	const gaps: string[] = [];
	const readChat = async (chatId: string): Promise<void> => {
		required.push(chatId);
		await args.progress(`Reading chat ${String(required.length)}`, {
			stream: "chat_events",
		});
		const mark = prior[chatId] ?? null;
		const keepMark = (): void => {
			if (mark !== null) {
				next[chatId] = mark;
			}
		};
		const outcome = await readChatHistory(
			args,
			chatId,
			mark,
			plan,
			firstWindows.get(chatId),
		);
		if (outcome.kind === "gap") {
			await emitChatGap(args, chatId, outcome);
			gaps.push(chatId);
			keepMark();
			return;
		}
		const records = outcome.events
			.filter((event) => shouldEmitEvent(event, mark, plan))
			.sort(byCreatedAt)
			.map((event) => chatEventRecord(chatId, event));
		const problems = schemaProblems("chat_events", records);
		if (problems !== null) {
			// Emitting the rest and advancing would leave the failed events
			// behind the checkpoint for good: the chat is a gap instead.
			await emitChatGap(args, chatId, {
				errorClass: "instinct_record_invalid",
				kind: "gap",
				message: problems,
				reason: "retry_exhausted",
			});
			gaps.push(chatId);
			keepMark();
			return;
		}
		for (const record of records) {
			await args.emitRecord("chat_events", record);
		}
		const advanced = nextCheckpoint(mark, outcome.events, plan, outcome.ended);
		if (advanced !== null) {
			next[chatId] = advanced;
		}
		hydrated.push(chatId);
		// A pending gap is about the chat's whole history, so it is resolved
		// only when the history is now delivered from its start: a walk that
		// stopped at a `since` floor leaves the older part unrecovered.
		if (
			deliveredAll(outcome.events, plan) &&
			advanced !== null &&
			advanced.covered_since === null
		) {
			delivered.push(chatId);
		}
	};

	for (const chatId of listed) {
		await readChat(chatId);
	}
	await forEachPendingGapPage(args, firstGapPage, async (fresh) => {
		for (const [chatId, pending] of fresh) {
			if (!required.includes(chatId)) {
				await readChat(chatId);
			}
			// A chat whose events were filtered by `resources` was read but not
			// delivered: its gap stays pending for a run that delivers it.
			if (!delivered.includes(chatId)) {
				continue;
			}
			for (const gap of pending) {
				await args.emit({
					gap_id: gap.gapId,
					...(gap.leaseId ? { lease_id: gap.leaseId } : {}),
					record_key: chatId,
					reference_only: true,
					stream: "chat_events",
					type: "DETAIL_GAP_RECOVERED",
				});
			}
		}
	});
	if (required.length > 0 || args.recoveryOnly !== true) {
		await emitDetailCoverage(args, {
			gapKeys: gaps,
			hydratedKeys: hydrated,
			requiredKeys: required,
			stateStream: "chats",
			stream: "chat_events",
		});
	}
	return next;
}

/**
 * The newest history window of each chat whose record this run delivers:
 * its newest event is the chat's `last_event_at`, and when events are read
 * it is also their first window. A chat the `resources` list leaves out is
 * not read unless its events are wanted.
 */
async function readNewestWindows(
	args: CollectInstinctArgs,
	chats: readonly Chat[],
	wantEvents: boolean,
): Promise<Map<string, HistoryWindow>> {
	const windows = new Map<string, HistoryWindow>();
	for (const chat of chats) {
		if (!(wantEvents || resourceWanted(args, "chats", chat.id))) {
			continue;
		}
		windows.set(
			chat.id,
			await readHistoryWindow(
				args,
				chat.id,
				null,
				wantEvents ? CHAT_HISTORY_PAGE_SIZE : 1,
			),
		);
	}
	return windows;
}

/** A chat's `last_event_at` as an ISO string, or null. */
/**
 * True when the newest window proves the chat's latest activity: it
 * answered, every event on it has a readable time, and an empty window is
 * the whole (empty) history rather than a page with more behind it.
 */
function provesLatest(window: HistoryWindow | undefined): boolean {
	if (window?.kind !== "window") {
		return false;
	}
	if (window.events.length === 0) {
		return window.cursor === null;
	}
	return window.events.every((event) => eventEpochSeconds(event) !== null);
}

function lastEventAt(
	window: HistoryWindow | undefined,
	mark: ChatCheckpoint | undefined,
): string | null {
	if (window?.kind === "window" && provesLatest(window)) {
		return newestEventAt(window.events);
	}
	// The newest window did not prove it: the newest event an earlier run
	// delivered is the best known value.
	return mark === undefined || mark.newest_created_at === null
		? null
		: toIso(mark.newest_created_at);
}

async function collectChatStreams(args: CollectInstinctArgs): Promise<void> {
	const wantChats = collects(args, "chats");
	let wantEvents = collects(args, "chat_events");
	if (wantEvents && !wantChats) {
		// Collection Profile 5.1: a connector must not broaden scope. Chat
		// events hang off their chat records and their checkpoints live in
		// the chats STATE, so they are collected only together.
		await args.emit({
			message:
				"Instinct chat events are collected together with their chats; request both streams.",
			reason: "scope_not_supported",
			recovery_hint: { action: "not_retriable", retryable: false },
			stream: "chat_events",
			type: "SKIP_RESULT",
		});
		wantEvents = false;
	}
	if (!wantChats) {
		return;
	}
	const plan = chatReadPlan(args.scopes?.get("chat_events"));
	const prior =
		args.collectionMode === "full_refresh"
			? {}
			: readChatCheckpoints(args.state);

	if (args.recoveryOnly === true) {
		// Recovery-only: re-read just the chats earlier runs left gaps for,
		// from their checkpoints, and stop before any forward walk. No STATE:
		// the next full run reads from the same checkpoints, and the events
		// emitted here upsert by id.
		if (!wantEvents) {
			return;
		}
		let firstGapPage = args.detailGaps ?? [];
		if (pendingChatGaps(firstGapPage).size === 0 && args.requestDetailGapPage) {
			firstGapPage = await args.requestDetailGapPage({
				streams: ["chat_events"],
			});
		}
		if (pendingChatGaps(firstGapPage).size > 0) {
			await hydrateChats(args, [], firstGapPage, prior, plan, new Map());
		}
		return;
	}

	const listed = await readOrFail(args, ["chats", "chat_events"], () =>
		readChatList(args),
	);
	if (listed === null) {
		return;
	}
	const chats = listed.value;
	// Checked before any history is read: a record that cannot be stored
	// fails both streams whatever its latest activity (always a valid time).
	const unread = chats.map((chat) => chatRecord(chat, null));
	const problems =
		schemaProblems("chats", unread) ?? duplicateKeys("chats", unread);
	if (problems !== null) {
		// No chat record, so no event may be stored under it either.
		await failStreams(
			args,
			["chats", "chat_events"],
			new StreamIncomplete(problems, false, "retry_on_connector_upgrade"),
		);
		return;
	}
	const windows = await readNewestWindows(args, chats, wantEvents);
	const records = chats.map((chat) =>
		chatRecord(chat, lastEventAt(windows.get(chat.id), prior[chat.id])),
	);
	const unanswered = chats.filter(
		(chat) =>
			windows.has(chat.id) &&
			!provesLatest(windows.get(chat.id)) &&
			resourceWanted(args, "chats", chat.id),
	);
	if (
		unanswered.length > 0 &&
		args.scopes?.get("chats")?.time_range !== undefined
	) {
		// Under a time range a chat's latest activity decides whether it is
		// in scope, and an unknown one would be dropped without a word.
		await failStreams(
			args,
			["chats", "chat_events"],
			new StreamIncomplete(
				`Instinct did not answer with the latest activity of ${String(unanswered.length)} chat(s), so it is unknown which chats fall in the time range.`,
				true,
			),
		);
		return;
	}
	for (const record of records) {
		await args.emitRecord("chats", record);
	}
	await args.emit(buildFullScanCoverageMessage("chats", records.length));
	// The per-chat event checkpoints live in the chats STATE, written after
	// the events and their coverage. A chats-only run carries them forward.
	let marks: Record<string, ChatCheckpoint> = {};
	if (wantEvents) {
		marks = await hydrateChats(
			args,
			chats.map((chat) => chat.id),
			args.detailGaps,
			prior,
			plan,
			windows,
		);
	} else {
		for (const chat of chats) {
			const mark = prior[chat.id];
			if (mark !== undefined) {
				marks[chat.id] = mark;
			}
		}
	}
	await args.emit({
		cursor: { chats: marks },
		stream: "chats",
		type: "STATE",
	});
}

export async function collectInstinct(
	args: CollectInstinctArgs,
): Promise<void> {
	if (args.recoveryOnly !== true) {
		// The account read serves profile and, through its feature flags,
		// connections; neither requested means it is not made at all.
		let flags: readonly string[] | null = null;
		if (collects(args, "profile") || collects(args, "connections")) {
			await args.progress("Reading your Instinct account", {
				stream: "profile",
			});
			flags = await collectProfile(args);
		}
		if (
			collects(args, "agent_contact") &&
			resourceWanted(args, "agent_contact", "agent_contact")
		) {
			await args.progress("Reading how you reach your agent", {
				stream: "agent_contact",
			});
			await collectAgentContact(args);
		}
		if (collects(args, "connections") && flags !== null) {
			await args.progress("Reading connected services", {
				stream: "connections",
			});
			await collectConnections(args, resolveConnectionGates(flags));
		}
		if (collects(args, "devices")) {
			await args.progress("Reading enrolled devices", { stream: "devices" });
			await collectDevices(args);
		}
		if (collects(args, "trusted_people")) {
			await args.progress("Reading your trusted people", {
				stream: "trusted_people",
			});
			await collectTrustedPeople(args);
		}
		if (collects(args, "vault_entries")) {
			await args.progress("Reading your vault inventory", {
				stream: "vault_entries",
			});
			await collectVaultEntries(args);
		}
	}
	if (collects(args, "chats") || collects(args, "chat_events")) {
		await args.progress("Reading your conversations with your agent", {
			stream: "chat_events",
		});
		await collectChatStreams(args);
	}
}

/**
 * The runtime's collect context, narrowed to what the collector reads. The
 * desktop runtime supplies every member; the mobile PageShim host supplies
 * the page, emit, progress, requested streams, STATE and stream failures, but
 * no run clock, collection mode or detail-gap pages.
 */
export type InstinctPageCollectContext = Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "progress" | "requested" | "state"
> &
	Partial<
		Pick<
			BrowserCollectContext,
			| "collectionMode"
			| "detailGaps"
			| "emittedAt"
			| "recoveryOnly"
			| "reportStreamFailure"
			| "requestDetailGapPage"
		>
	> & { readonly page: Pick<Page, "evaluate"> };

/**
 * Collect from the signed-in page. The one entry point both hosts call: the
 * desktop runtime's `collect` and the PageShim `collect_export`.
 */
export async function collectInstinctOnPage(
	ctx: InstinctPageCollectContext,
): Promise<void> {
	await collectInstinct({
		...(ctx.collectionMode ? { collectionMode: ctx.collectionMode } : {}),
		...(ctx.detailGaps ? { detailGaps: ctx.detailGaps } : {}),
		emit: ctx.emit,
		emitRecord: ctx.emitRecord,
		graphql: makeInstinctGraphql(ctx.page),
		observedAt: ctx.emittedAt ?? new Date().toISOString(),
		progress: ctx.progress,
		recoveryOnly: ctx.recoveryOnly === true,
		...(ctx.reportStreamFailure
			? { reportStreamFailure: ctx.reportStreamFailure }
			: {}),
		...(ctx.requestDetailGapPage
			? { requestDetailGapPage: ctx.requestDetailGapPage }
			: {}),
		requested: new Set(ctx.requested.keys()),
		scopes: ctx.requested,
		state: ctx.state,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		browser: { profileName: "instinct" },
		name: "instinct",
		retryablePattern:
			/ECONN|ETIMEDOUT|timeout|fetch failed|instinct_interrupted|instinct_rate_limited|instinct_server_error/i,
		validateRecord,
		collect: collectInstinctOnPage,
		async ensureSession(args: EnsureSessionArgs) {
			await ensureInstinctSession({
				assist: args.assist,
				capture: args.capture,
				completeAssistance: args.completeAssistance,
				graphql: makeInstinctGraphql(args.page),
				interactive: instinctAllowsInteractiveAuthRepair(),
				page: args.page,
				sendInteraction: args.sendInteraction,
			});
		},
	});
}
