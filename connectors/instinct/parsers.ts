// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure record builders for the Instinct connector. No fetch, no Node I/O, no
// clock reads: every builder takes the already-parsed upstream shape alone, so
// the whole mapping layer is unit testable without a browser (see
// integration.test.ts). Records carry only values Instinct itself reports; the
// time this connector ran is never put in a record (Collection Profile 5.2).

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { parseIsoInstant } from "../../packages/polyfill-connectors/src/time-range.ts";
import type {
	AgentContact,
	Chat,
	ChatCheckpoint,
	ChatEvent,
	ChatReadPlan,
	ConnectionProvider,
	ConnectionsResponse,
	DevicesResponse,
	ImessageDeviceResponse,
	MessagingResponse,
	ProfileResponse,
	TrustedNetworkResponse,
	TrustedPerson,
	VaultResponse,
} from "./types.ts";

/** Epoch-seconds values below this are implausible; above it, treat as ms. */
const EPOCH_SECONDS_CEILING = 1e11;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Normalise Instinct's mixed timestamp encodings to ISO 8601.
 *
 * Instinct is inconsistent on the wire: `myReferralLinks.links[].createdAt`
 * comes back as epoch *seconds* (`1789068259`), while other timestamp fields
 * are declared as strings. Rather than guess one encoding, accept both and
 * return `null` for anything that does not resolve to a real instant — a null
 * is an honest "we could not read this", a wrong date is silent corruption.
 */
export function toIso(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	let millis: number | null = null;
	if (typeof value === "number") {
		millis = value < EPOCH_SECONDS_CEILING ? value * 1000 : value;
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return null;
		}
		if (NUMERIC_RE.test(trimmed)) {
			const numeric = Number(trimmed);
			millis = numeric < EPOCH_SECONDS_CEILING ? numeric * 1000 : numeric;
		} else {
			const parsed = Date.parse(trimmed);
			millis = Number.isNaN(parsed) ? null : parsed;
		}
	}
	if (millis === null || !Number.isFinite(millis)) {
		return null;
	}
	const date = new Date(millis);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Empty and whitespace-only strings are "not set", not a value. */
export function nullableText(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function nullableFlag(value: boolean | null | undefined): boolean | null {
	return value ?? null;
}

function roundedPercent(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	// Instinct reports battery as a percentage; some clients send 0-1 floats.
	const percent = value > 0 && value <= 1 ? value * 100 : value;
	return Math.round(percent);
}

export function profileRecord(response: ProfileResponse): RecordData | null {
	const user = response.data?.authSession?.user;
	if (!user) {
		return null;
	}
	return {
		agent_to_agent_enabled: nullableFlag(
			response.data?.agentToAgentSettings?.enabled,
		),
		email: nullableText(user.email),
		enabled_feature_flags: [...(user.enabledFeatureFlags ?? [])].sort(),
		has_location_data: nullableFlag(response.data?.locationDataStatus?.hasData),
		id: user.id,
		linked_sign_in_providers: (response.data?.linkedProviders ?? []).map(
			(provider) => ({
				provider: provider.provider,
				subject: nullableText(provider.sub),
			}),
		),
		name: nullableText(user.name),
		onboarding_step: nullableText(user.onboardingStep),
		phone_number: nullableText(user.phoneNumber),
		roles: [...(user.roles ?? [])].sort(),
		training_data_opt_out: nullableFlag(user.preferences?.trainingDataOptOut),
	};
}

export function agentContactRecord(agentContact: AgentContact): RecordData {
	return {
		agent_mail_status: nullableText(agentContact.agentMailStatus),
		agent_phone_number: nullableText(agentContact.agentPhoneNumber),
		agent_phone_status: nullableText(agentContact.agentPhoneStatus),
		email: nullableText(agentContact.email),
		id: "agent_contact",
		sms_phone_number: nullableText(agentContact.smsPhoneNumber),
		voice_calls_enabled: nullableFlag(agentContact.voiceCallsEnabled),
		voice_phone_number: nullableText(agentContact.voicePhoneNumber),
		whatsapp_channel_phone_number: nullableText(
			agentContact.whatsAppChannelPhoneNumber,
		),
	};
}

interface ConnectionSeed {
	readonly accountEmail?: string | null | undefined;
	readonly accountName?: string | null | undefined;
	readonly connectedAt?: unknown;
	readonly connectionId?: string | null | undefined;
	readonly isConnected?: boolean | null | undefined;
	readonly isDefault?: boolean | null | undefined;
	readonly isRevoked?: boolean | null | undefined;
	readonly provider: ConnectionProvider;
	readonly services?: RecordData[] | undefined;
	readonly workspaceName?: string | null | undefined;
}

function connectionRecord(seed: ConnectionSeed): RecordData {
	// The provider is always present, so `<provider>:<id>` is stable even when
	// Instinct gives a singleton connection no id of its own.
	const suffix = nullableText(seed.connectionId) ?? "default";
	return {
		account_email: nullableText(seed.accountEmail),
		account_name: nullableText(seed.accountName),
		connected_at: toIso(seed.connectedAt),
		connection_id: nullableText(seed.connectionId),
		id: `${seed.provider}:${suffix}`,
		is_connected: nullableFlag(seed.isConnected),
		is_default: nullableFlag(seed.isDefault),
		is_revoked: nullableFlag(seed.isRevoked),
		provider: seed.provider,
		services: seed.services ?? [],
		workspace_name: nullableText(seed.workspaceName),
	};
}

export function connectionRecords(response: ConnectionsResponse): RecordData[] {
	const data = response.data;
	if (!data) {
		return [];
	}
	const seeds: ConnectionSeed[] = [];

	for (const connection of data.googleWorkspaceConnections ?? []) {
		seeds.push({
			accountEmail: connection.email,
			accountName: connection.email,
			connectionId: connection.id,
			isDefault: connection.isDefault,
			isRevoked: connection.isRevoked,
			provider: "google_workspace",
			services: (connection.services ?? [])
				.filter((service) => nullableText(service.serviceId) !== null)
				.map((service) => ({
					connected: nullableFlag(service.connected),
					label: nullableText(service.label),
					notification_issue: nullableFlag(service.notificationIssue),
					read_only: nullableFlag(service.readOnly),
					service_id: nullableText(service.serviceId) ?? "",
				})),
		});
	}
	for (const connection of data.outlookConnections ?? []) {
		seeds.push({
			accountEmail: connection.email,
			accountName: connection.displayName ?? connection.email,
			connectionId: connection.id,
			isDefault: connection.isDefault,
			isRevoked: connection.isRevoked,
			provider: "outlook",
		});
	}
	for (const connection of data.linearConnections ?? []) {
		seeds.push({
			accountEmail: connection.email,
			accountName: connection.displayName,
			connectionId: connection.id,
			isDefault: connection.isDefault,
			isRevoked: connection.isRevoked,
			provider: "linear",
			workspaceName: connection.organizationName,
		});
	}
	for (const connection of data.notionConnections ?? []) {
		seeds.push({
			connectionId: connection.id,
			isDefault: connection.isDefault,
			isRevoked: connection.isRevoked,
			provider: "notion",
			workspaceName: connection.workspaceName,
		});
	}
	if (data.githubConnection) {
		seeds.push({
			accountEmail: data.githubConnection.email,
			accountName:
				data.githubConnection.username ?? data.githubConnection.displayName,
			connectionId: data.githubConnection.id,
			isRevoked: data.githubConnection.isRevoked,
			provider: "github",
		});
	}
	if (data.slackCanvasConnection) {
		seeds.push({
			connectionId: data.slackCanvasConnection.teamId,
			isRevoked: data.slackCanvasConnection.isRevoked,
			provider: "slack",
			workspaceName: data.slackCanvasConnection.teamName,
		});
	}
	if (data.granolaConnection) {
		seeds.push({
			accountEmail: data.granolaConnection.accountEmail,
			connectionId: data.granolaConnection.id,
			provider: "granola",
			workspaceName: data.granolaConnection.workspaceName,
		});
	}
	if (data.shopWalletConnection) {
		seeds.push({
			accountEmail: data.shopWalletConnection.email,
			connectionId: data.shopWalletConnection.id,
			isRevoked: data.shopWalletConnection.isRevoked,
			provider: "shop_wallet",
		});
	}
	if (data.whoopConnection) {
		const first = nullableText(data.whoopConnection.firstName);
		const last = nullableText(data.whoopConnection.lastName);
		seeds.push({
			accountEmail: data.whoopConnection.email,
			accountName: [first, last].filter((part) => part !== null).join(" "),
			connectionId: data.whoopConnection.id,
			provider: "whoop",
		});
	}
	if (data.stripeLinkConnection) {
		seeds.push({
			isConnected: data.stripeLinkConnection.connected,
			provider: "stripe_link",
		});
	}
	return seeds.map((seed) => connectionRecord(seed));
}

export function messagingConnectionRecords(
	response: MessagingResponse,
): RecordData[] {
	const whatsapp = response.data?.whatsappChannelConnection;
	if (!whatsapp) {
		return [];
	}
	return [
		connectionRecord({
			accountName: whatsapp.phoneNumber,
			connectionId: whatsapp.userId,
			isConnected: true,
			provider: "whatsapp",
		}),
	];
}

/**
 * Instinct splits iMessage across two resolvers: `imessageConnection` holds
 * the linked iCloud email, `imessageLocalConnection` holds the device relay.
 * They describe one connection, so they merge into one record under a single
 * stable key rather than racing each other for the `imessage:` slot.
 */
export function imessageConnectionRecord(
	messaging: MessagingResponse,
	device: ImessageDeviceResponse,
): RecordData | null {
	const icloudEmail = nullableText(
		messaging.data?.imessageConnection?.icloudEmail,
	);
	const local = device.data?.imessageLocalConnection ?? null;
	if (icloudEmail === null && local === null) {
		return null;
	}
	return connectionRecord({
		accountEmail: icloudEmail,
		accountName: local?.accountHandle ?? icloudEmail,
		// When the local relay was linked, as Instinct reports it. No other
		// connection resolver reports a time.
		connectedAt: local?.connectedAt ?? null,
		// The relay device is the connection's own id when one exists; the
		// iCloud-only case has no id of its own and falls back to `default`.
		connectionId: local?.preferredDeviceId ?? null,
		isConnected: local === null ? null : true,
		provider: "imessage",
	});
}

export function deviceRecords(response: DevicesResponse): RecordData[] {
	return (response.data?.devices ?? []).map((device) => ({
		battery_level: roundedPercent(device.batteryLevel),
		created_at: toIso(device.createdAt),
		device_type: nullableText(device.deviceType),
		hostname: nullableText(device.hostname),
		id: device.id,
		is_charging: nullableFlag(device.isCharging),
		is_connected: nullableFlag(device.isConnected),
		name: nullableText(device.name),
		os_version: nullableText(device.osVersion),
	}));
}

type Relationship = "blocked" | "contact" | "incoming_request" | "sent_request";

export function trustedPeopleRecords(
	response: TrustedNetworkResponse,
): RecordData[] {
	const data = response.data;
	if (!data) {
		return [];
	}
	const records: RecordData[] = [];
	const pages: Array<{
		items: readonly TrustedPerson[];
		relationship: Relationship;
	}> = [
		{
			items: data.trustedNetworkContacts?.items ?? [],
			relationship: "contact",
		},
		{
			items: data.trustedNetworkBlockedPeople?.items ?? [],
			relationship: "blocked",
		},
		{
			items: data.trustedNetworkRequests?.items ?? [],
			relationship: "incoming_request",
		},
	];
	for (const page of pages) {
		for (const person of page.items) {
			records.push({
				created_at: toIso(person.createdAt),
				display_name: nullableText(person.displayName),
				expires_at: toIso(person.expiresAt),
				// Blocked people carry `decisionGeneration` where the other lists
				// carry `generation`; both are the same concurrency token.
				generation: person.generation ?? person.decisionGeneration ?? null,
				id: `${page.relationship}:${person.id}`,
				person_id: person.id,
				phone_numbers: [...(person.phoneNumbers ?? [])].sort(),
				relationship: page.relationship,
				status: nullableText(person.status),
			});
		}
	}
	for (const request of data.trustedNetworkSentRequests ?? []) {
		const phone = nullableText(request.phoneNumber);
		records.push({
			created_at: toIso(request.createdAt),
			display_name: null,
			expires_at: toIso(request.expiresAt),
			generation: null,
			id: `sent_request:${request.id}`,
			person_id: request.id,
			phone_numbers: phone === null ? [] : [phone],
			relationship: "sent_request",
			status: null,
		});
	}
	return records;
}

/**
 * Vault records are an inventory, never a disclosure: entry kind, label, and
 * which field *names* hold a value. No vault value is ever requested from
 * Instinct (the `vaultEntries` resolver does not return them) or emitted.
 *
 * Instinct gives an entry no id, so the key is `<kind>:<label>`. Two entries
 * of one kind can share a label (or both have none); the second and later
 * ones, in Instinct's order, get `#2`, `#3`, ... so neither overwrites the
 * other. The first keeps the plain key, which is what earlier versions
 * emitted.
 */
export function vaultEntryRecords(response: VaultResponse): RecordData[] {
	const data = response.data;
	if (!data) {
		return [];
	}
	const kindFieldKeys = new Map<string, string[]>();
	for (const kind of data.vaultKinds ?? []) {
		kindFieldKeys.set(kind.kind, [...(kind.subfieldKeys ?? [])]);
	}
	const seen = new Map<string, number>();
	return (data.vaultEntries ?? []).map((entry) => {
		const fields = entry.fields ?? [];
		const declaredKeys = kindFieldKeys.get(entry.kind) ?? [];
		const entryKeys = fields.map((field) => field.key);
		const fieldKeys = [...new Set([...declaredKeys, ...entryKeys])].sort();
		const name = nullableText(entry.name);
		const base = `${entry.kind}:${name ?? "unnamed"}`;
		const occurrence = (seen.get(base) ?? 0) + 1;
		seen.set(base, occurrence);
		return {
			field_keys: fieldKeys,
			id: occurrence === 1 ? base : `${base}#${String(occurrence)}`,
			is_agent_entry: nullableFlag(entry.isAgentEntry),
			kind: entry.kind,
			name,
			populated_field_keys: fields
				.filter((field) => field.populated === true)
				.map((field) => field.key)
				.sort(),
		};
	});
}

/** Upper bound for one chat-event text field (content, tool I/O, thinking). */
export const CHAT_EVENT_TEXT_MAX = 1_000_000;

/**
 * Chat text is kept whole, but routed through `safeTextPreview` so a payload
 * carrying NULs or other control bytes becomes `null` instead of breaking the
 * Postgres JSONB invariant downstream.
 */
function chatText(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const result = safeTextPreview(value, CHAT_EVENT_TEXT_MAX);
	return result.kind === "text" ? result.preview : null;
}

/** Nesting bound for a copied block; deeper values are dropped. */
const BLOCK_MAX_DEPTH = 8;

/**
 * One value of a copied block, with every string routed through
 * `safeTextPreview` (an unsafe string or key is dropped) so no nested leaf can
 * carry a NUL or other control byte past the JSONB invariant.
 */
function safeBlockValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		return chatText(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "boolean" || value === null || value === undefined) {
		return value ?? null;
	}
	if (depth >= BLOCK_MAX_DEPTH || typeof value !== "object") {
		return null;
	}
	if (Array.isArray(value)) {
		return value.map((item) => safeBlockValue(item, depth + 1));
	}
	const entries: [string, unknown][] = [];
	for (const [key, field] of Object.entries(value)) {
		const safeKey = chatText(key);
		const safe = safeBlockValue(field, depth + 1);
		if (safeKey !== null && safeKey === key && safe !== null) {
			entries.push([key, safe]);
		}
	}
	return Object.fromEntries(entries);
}

function plainBlock(value: unknown): Record<string, unknown> | null {
	if (value === null || value === undefined || typeof value !== "object") {
		return null;
	}
	if (Array.isArray(value)) {
		return null;
	}
	const safe = safeBlockValue(value, 0) as Record<string, unknown>;
	return Object.keys(safe).length === 0 ? null : safe;
}

/**
 * A chat record. `lastEventAt` is the time of the newest event in the chat's
 * history (the first window `chatHistory` returns), or null when the history
 * is empty or could not be read. It is the chat's consent time: the chat
 * falls inside a time range when its latest activity does.
 */
export function chatRecord(chat: Chat, lastEventAt: string | null): RecordData {
	return {
		id: chat.id,
		last_event_at: lastEventAt,
		pending_turn_started_at: toIso(chat.pendingTurnStartedAt),
		source: nullableText(chat.source),
		status: nullableText(chat.status),
		title: nullableText(chat.title),
	};
}

export function chatEventRecord(chatId: string, event: ChatEvent): RecordData {
	const message = event.message ?? null;
	const tool = event.toolInvocation ?? null;
	const response = event.toolResponse ?? null;
	return {
		action: plainBlock(event.action),
		attachments: (message?.attachments ?? []).map((attachment) => ({
			byte_size:
				typeof attachment.byteSize === "number"
					? Math.round(attachment.byteSize)
					: null,
			filename: nullableText(attachment.filename),
			id: nullableText(attachment.id),
			kind: nullableText(attachment.kind),
			mime_type: nullableText(attachment.mimeType),
		})),
		chat_id: chatId,
		content: chatText(message?.content),
		created_at: toIso(event.createdAt),
		draft_field: plainBlock(event.draftField),
		error_message: chatText(event.error?.message),
		has_screenshot: event.screenshot !== null && event.screenshot !== undefined,
		id: event.id,
		interaction: plainBlock(event.interaction),
		interaction_response: plainBlock(event.interactionResponse),
		message_id: nullableText(message?.id),
		origin_agent_display_name: nullableText(message?.origin?.agentDisplayName),
		origin_kind: nullableText(message?.origin?.kind),
		read_at: toIso(message?.readAt),
		role: nullableText(message?.role),
		thinking: chatText(event.thinking?.thinking),
		tool_arguments: chatText(tool?.arguments),
		tool_call_id: nullableText(tool?.toolId ?? response?.toolId),
		tool_is_error: response?.isError ?? null,
		tool_name: nullableText(tool?.toolName ?? response?.toolName),
		tool_response: chatText(response?.response),
		type: event.type,
	};
}

/** Epoch seconds for an event, or null when the wire value is unreadable. */
export function eventEpochSeconds(event: ChatEvent): number | null {
	const iso = toIso(event.createdAt);
	return iso === null ? null : Math.floor(Date.parse(iso) / 1000);
}

/** Whole epoch seconds at or after an RFC 3339 instant, or null when unreadable. */
export function ceilEpochSeconds(instant: string | undefined): number | null {
	if (instant === undefined) {
		return null;
	}
	const parsed = parseIsoInstant(instant);
	if (parsed === null) {
		return null;
	}
	const whole = Math.floor(parsed.second / 1000);
	return /[1-9]/.test(parsed.fraction) ? whole + 1 : whole;
}

/** The `chat_events` scope as this connector reads it. */
export interface ChatEventsScope {
	readonly resources?: readonly string[];
	readonly time_range?: { readonly since?: string; readonly until?: string };
}

/**
 * How to read chat histories for this `chat_events` scope. A bound this
 * connector cannot read leaves the runtime to withhold every event, so
 * nothing is pushed down and nothing advances.
 */
export function chatReadPlan(scope: ChatEventsScope | undefined): ChatReadPlan {
	const range = scope?.time_range;
	const floor = ceilEpochSeconds(range?.since);
	const untilSecond = ceilEpochSeconds(range?.until);
	const unreadable =
		(range?.since !== undefined && floor === null) ||
		(range?.until !== undefined && untilSecond === null);
	return {
		bounded: range !== undefined,
		floor: unreadable ? null : floor,
		mayAdvance: !unreadable && scope?.resources === undefined,
		untilSecond: unreadable ? null : untilSecond,
	};
}

/** True when the checkpoint's band reaches down to `floor` (null: the start). */
function coversDownTo(
	checkpoint: ChatCheckpoint,
	floor: number | null,
): boolean {
	if (checkpoint.covered_since === null) {
		return true;
	}
	return floor !== null && checkpoint.covered_since <= floor;
}

/**
 * True when the band keeps its place in the next checkpoint: it has an
 * event, reaches down to the floor, and is not wholly older than the floor.
 */
function bandContinues(
	checkpoint: ChatCheckpoint | null,
	floor: number | null,
): checkpoint is ChatCheckpoint & { newest_created_at: number } {
	return (
		checkpoint !== null &&
		checkpoint.newest_created_at !== null &&
		coversDownTo(checkpoint, floor) &&
		(floor === null || floor <= checkpoint.newest_created_at)
	);
}

/**
 * The second paging may stop above: once a window holds an event older than
 * it, every older window is older still and already delivered or out of
 * scope. Null means read to the start of the history.
 */
export function stopBelowSecond(
	checkpoint: ChatCheckpoint | null,
	plan: ChatReadPlan,
): number | null {
	if (bandContinues(checkpoint, plan.floor)) {
		return plan.floor === null
			? checkpoint.newest_created_at
			: Math.max(plan.floor, checkpoint.newest_created_at);
	}
	return plan.floor;
}

/** True when this event was delivered by an earlier run (it is in the band). */
export function isKnownEvent(
	event: ChatEvent,
	checkpoint: ChatCheckpoint | null,
): boolean {
	if (checkpoint === null || checkpoint.newest_created_at === null) {
		return false;
	}
	const seconds = eventEpochSeconds(event);
	if (seconds === null) {
		// Unreadable timestamps are emitted rather than silently dropped; the
		// record key is the event id, so a repeat upserts instead of duplicating.
		return false;
	}
	if (checkpoint.covered_since !== null && seconds < checkpoint.covered_since) {
		return false;
	}
	if (seconds < checkpoint.newest_created_at) {
		return true;
	}
	return (
		seconds === checkpoint.newest_created_at &&
		checkpoint.newest_ids.includes(event.id)
	);
}

/** True when an event read this run is one this run should emit. */
export function shouldEmitEvent(
	event: ChatEvent,
	checkpoint: ChatCheckpoint | null,
	plan: ChatReadPlan,
): boolean {
	if (isKnownEvent(event, checkpoint)) {
		return false;
	}
	const seconds = eventEpochSeconds(event);
	// Older than `since`: read only because a window straddles the bound.
	return seconds === null || plan.floor === null || seconds >= plan.floor;
}

/**
 * True when the runtime delivered every in-scope event this run read, so a
 * checkpoint may move past them. False when the plan does not allow it (a
 * `resources` filter), when an event at or after `until` was read (the
 * runtime withholds it), or when a bounded run read an event with no
 * readable time (the runtime withholds that too).
 */
export function deliveredAll(
	events: readonly ChatEvent[],
	plan: ChatReadPlan,
): boolean {
	if (!plan.mayAdvance) {
		return false;
	}
	const { untilSecond } = plan;
	return events.every((event) => {
		const seconds = eventEpochSeconds(event);
		if (seconds === null) {
			return !plan.bounded;
		}
		return untilSecond === null || seconds < untilSecond;
	});
}

/**
 * The checkpoint a chat carries after this run read `events` (every event on
 * the windows it read) and either reached the start of the history (`ended`)
 * or stopped above `stopBelowSecond`. The prior checkpoint is kept unchanged
 * unless `deliveredAll` holds.
 */
export function nextCheckpoint(
	checkpoint: ChatCheckpoint | null,
	events: readonly ChatEvent[],
	plan: ChatReadPlan,
	ended: boolean,
): ChatCheckpoint | null {
	if (!deliveredAll(events, plan)) {
		return checkpoint;
	}
	const seconds = events.map(eventEpochSeconds);
	const { floor } = plan;
	const keepBand = bandContinues(checkpoint, floor);
	let coveredSince: number | null;
	if (keepBand) {
		coveredSince = checkpoint.covered_since;
	} else if (
		ended &&
		!seconds.some((value) => value !== null && floor !== null && value < floor)
	) {
		// The whole history was read and nothing in it was out of scope.
		coveredSince = null;
	} else {
		coveredSince = floor;
	}
	let newest = keepBand ? checkpoint.newest_created_at : null;
	let ids = new Set(keepBand ? checkpoint.newest_ids : []);
	events.forEach((event, index) => {
		const value = seconds[index];
		if (value === null || value === undefined) {
			return;
		}
		if (floor !== null && value < floor) {
			return;
		}
		if (newest === null || value > newest) {
			newest = value;
			ids = new Set([event.id]);
		} else if (value === newest) {
			ids.add(event.id);
		}
	});
	return {
		covered_since: coveredSince,
		newest_created_at: newest,
		newest_ids: [...ids].sort(),
	};
}

/** The newest event time in one window, as ISO, or null for an empty window. */
export function newestEventAt(events: readonly ChatEvent[]): string | null {
	let newest: number | null = null;
	for (const event of events) {
		const seconds = eventEpochSeconds(event);
		if (seconds !== null && (newest === null || seconds > newest)) {
			newest = seconds;
		}
	}
	return newest === null ? null : toIso(newest);
}
