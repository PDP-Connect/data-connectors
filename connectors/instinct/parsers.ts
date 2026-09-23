// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure record builders for the Instinct connector. No fetch, no Node I/O, no
// clock reads — every builder takes the already-parsed upstream shape plus the
// run's single `observedAt` timestamp, so the whole mapping layer is unit
// testable without a browser (see integration.test.ts).

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	AgentContact,
	Chat,
	ChatCheckpoint,
	ChatEvent,
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

export function profileRecord(
	response: ProfileResponse,
	observedAt: string,
): RecordData | null {
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
		observed_at: observedAt,
		onboarding_step: nullableText(user.onboardingStep),
		phone_number: nullableText(user.phoneNumber),
		profile_picture_url: nullableText(user.profilePictureUrl),
		roles: [...(user.roles ?? [])].sort(),
		training_data_opt_out: nullableFlag(user.preferences?.trainingDataOptOut),
	};
}

export function agentContactRecord(
	agentContact: AgentContact,
	observedAt: string,
): RecordData {
	return {
		agent_mail_status: nullableText(agentContact.agentMailStatus),
		agent_phone_number: nullableText(agentContact.agentPhoneNumber),
		agent_phone_status: nullableText(agentContact.agentPhoneStatus),
		email: nullableText(agentContact.email),
		id: "agent_contact",
		observed_at: observedAt,
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
	readonly connectionId?: string | null | undefined;
	readonly isConnected?: boolean | null | undefined;
	readonly isDefault?: boolean | null | undefined;
	readonly isRevoked?: boolean | null | undefined;
	readonly provider: ConnectionProvider;
	readonly services?: RecordData[] | undefined;
	readonly workspaceName?: string | null | undefined;
}

function connectionRecord(
	seed: ConnectionSeed,
	observedAt: string,
): RecordData {
	// The provider is always present, so `<provider>:<id>` is stable even when
	// Instinct gives a singleton connection no id of its own.
	const suffix = nullableText(seed.connectionId) ?? "default";
	return {
		account_email: nullableText(seed.accountEmail),
		account_name: nullableText(seed.accountName),
		connection_id: nullableText(seed.connectionId),
		id: `${seed.provider}:${suffix}`,
		is_connected: nullableFlag(seed.isConnected),
		is_default: nullableFlag(seed.isDefault),
		is_revoked: nullableFlag(seed.isRevoked),
		observed_at: observedAt,
		provider: seed.provider,
		services: seed.services ?? [],
		workspace_name: nullableText(seed.workspaceName),
	};
}

export function connectionRecords(
	response: ConnectionsResponse,
	observedAt: string,
): RecordData[] {
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
	return seeds.map((seed) => connectionRecord(seed, observedAt));
}

export function messagingConnectionRecords(
	response: MessagingResponse,
	observedAt: string,
): RecordData[] {
	const whatsapp = response.data?.whatsappChannelConnection;
	if (!whatsapp) {
		return [];
	}
	return [
		connectionRecord(
			{
				accountName: whatsapp.phoneNumber,
				connectionId: whatsapp.userId,
				isConnected: true,
				provider: "whatsapp",
			},
			observedAt,
		),
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
	observedAt: string,
): RecordData | null {
	const icloudEmail = nullableText(
		messaging.data?.imessageConnection?.icloudEmail,
	);
	const local = device.data?.imessageLocalConnection ?? null;
	if (icloudEmail === null && local === null) {
		return null;
	}
	return connectionRecord(
		{
			accountEmail: icloudEmail,
			accountName: local?.accountHandle ?? icloudEmail,
			// The relay device is the connection's own id when one exists; the
			// iCloud-only case has no id of its own and falls back to `default`.
			connectionId: local?.preferredDeviceId ?? null,
			isConnected: local === null ? null : true,
			provider: "imessage",
		},
		observedAt,
	);
}

export function deviceRecords(
	response: DevicesResponse,
	observedAt: string,
): RecordData[] {
	return (response.data?.devices ?? []).map((device) => ({
		battery_level: roundedPercent(device.batteryLevel),
		created_at: toIso(device.createdAt),
		device_type: nullableText(device.deviceType),
		hostname: nullableText(device.hostname),
		id: device.id,
		is_charging: nullableFlag(device.isCharging),
		is_connected: nullableFlag(device.isConnected),
		name: nullableText(device.name),
		observed_at: observedAt,
		os_version: nullableText(device.osVersion),
	}));
}

type Relationship = "blocked" | "contact" | "incoming_request" | "sent_request";

export function trustedPeopleRecords(
	response: TrustedNetworkResponse,
	observedAt: string,
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
				observed_at: observedAt,
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
			observed_at: observedAt,
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
 */
export function vaultEntryRecords(
	response: VaultResponse,
	observedAt: string,
): RecordData[] {
	const data = response.data;
	if (!data) {
		return [];
	}
	const kindFieldKeys = new Map<string, string[]>();
	for (const kind of data.vaultKinds ?? []) {
		kindFieldKeys.set(kind.kind, [...(kind.subfieldKeys ?? [])]);
	}
	return (data.vaultEntries ?? []).map((entry) => {
		const fields = entry.fields ?? [];
		const declaredKeys = kindFieldKeys.get(entry.kind) ?? [];
		const entryKeys = fields.map((field) => field.key);
		const fieldKeys = [...new Set([...declaredKeys, ...entryKeys])].sort();
		const name = nullableText(entry.name);
		return {
			field_keys: fieldKeys,
			id: `${entry.kind}:${name ?? "unnamed"}`,
			is_agent_entry: nullableFlag(entry.isAgentEntry),
			kind: entry.kind,
			name,
			observed_at: observedAt,
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

function plainBlock(value: unknown): Record<string, unknown> | null {
	if (value === null || value === undefined || typeof value !== "object") {
		return null;
	}
	if (Array.isArray(value)) {
		return null;
	}
	const entries = Object.entries(value).filter(
		([, field]) => field !== null && field !== undefined,
	);
	return entries.length === 0 ? null : Object.fromEntries(entries);
}

export function chatRecord(chat: Chat, observedAt: string): RecordData {
	return {
		id: chat.id,
		observed_at: observedAt,
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
		has_screenshot: nullableText(event.screenshot?.url) !== null,
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

/** True when the event is newer than the checkpoint (or there is none). */
export function isNewEvent(
	event: ChatEvent,
	checkpoint: ChatCheckpoint | null,
): boolean {
	if (checkpoint === null) {
		return true;
	}
	const seconds = eventEpochSeconds(event);
	if (seconds === null) {
		// Unreadable timestamps are emitted rather than silently dropped; the
		// record key is the event id, so a repeat upserts instead of duplicating.
		return true;
	}
	if (seconds > checkpoint.newest_created_at) {
		return true;
	}
	return (
		seconds === checkpoint.newest_created_at &&
		!checkpoint.newest_ids.includes(event.id)
	);
}

/** Advance a checkpoint over a batch of events. */
export function advanceCheckpoint(
	checkpoint: ChatCheckpoint | null,
	events: readonly ChatEvent[],
): ChatCheckpoint | null {
	let newest = checkpoint?.newest_created_at ?? null;
	let ids = new Set(checkpoint?.newest_ids ?? []);
	for (const event of events) {
		const seconds = eventEpochSeconds(event);
		if (seconds === null) {
			continue;
		}
		if (newest === null || seconds > newest) {
			newest = seconds;
			ids = new Set([event.id]);
		} else if (seconds === newest) {
			ids.add(event.id);
		}
	}
	return newest === null
		? null
		: { newest_created_at: newest, newest_ids: [...ids].sort() };
}
