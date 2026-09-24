// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the Instinct connector.
 *
 * Two layers live here, per docs/connector-authoring-guide.md §3:
 *
 *   1. `*ResponseSchema` — parsers for what api.instinct.com's GraphQL
 *      endpoint puts on the wire. Every upstream response is `unknown`
 *      until one of these parses it.
 *   2. `*RecordSchema` — the emitted record shapes, mirroring
 *      manifests/instinct.json stream-for-stream and field-for-field.
 *      src/manifest-reconcile.ts (via bin/reconcile-manifests.test.ts)
 *      enforces that they stay in lockstep.
 *
 * Instinct's GraphQL layer answers `200` with a partially-populated `data`
 * plus an `errors[]` array when one resolver fails (observed live on
 * `whoopConnection` and `imessageLocalConnection`). The response schemas
 * model that explicitly — a failed path is `null` data plus an error entry,
 * not an exception — so index.ts can emit SKIP_RESULT for the stream that
 * lost its source and still collect everything else.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const E164_RE = /^\+[1-9]\d{6,14}$/;

const isoDateTime = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const nullableIsoDateTime = isoDateTime.nullable();
const nullableE164 = z
	.string()
	.regex(E164_RE, "must be an E.164 phone number")
	.nullable();
const nullableEmail = z.string().email().nullable();
const nullableBool = z.boolean().nullable();
const nullableInt = z.number().int().nullable();
const stringArray = z.array(z.string());

// ─── Upstream response shapes ──────────────────────────────────────────────

/**
 * A GraphQL error entry. `path` is what tells us *which* stream lost its
 * source, so it is the one field we care about beyond the message.
 */
export const graphqlErrorSchema = z.object({
	message: z.string(),
	path: z.array(z.union([z.string(), z.number()])).nullish(),
});

/** Envelope wrapper: `{ data, errors }` with data shaped by the caller. */
export function graphqlEnvelope<T extends z.ZodTypeAny>(
	data: T,
): z.ZodObject<{
	data: z.ZodNullable<T>;
	errors: z.ZodOptional<z.ZodNullable<z.ZodArray<typeof graphqlErrorSchema>>>;
}> {
	return z.object({
		data: data.nullable(),
		errors: z.array(graphqlErrorSchema).nullish(),
	});
}

const linkedProviderSchema = z.object({
	provider: z.string(),
	sub: z.string().nullish(),
});

export const profileResponseSchema = graphqlEnvelope(
	z.object({
		agentToAgentSettings: z
			.object({ enabled: z.boolean().nullish() })
			.nullish(),
		authSession: z
			.object({
				user: z
					.object({
						email: z.string().nullish(),
						enabledFeatureFlags: z.array(z.string()).nullish(),
						id: z.string().min(1),
						name: z.string().nullish(),
						onboardingStep: z.string().nullish(),
						phoneNumber: z.string().nullish(),
						preferences: z
							.object({ trainingDataOptOut: z.boolean().nullish() })
							.nullish(),
						profilePictureUrl: z.string().nullish(),
						roles: z.array(z.string()).nullish(),
					})
					.nullish(),
			})
			.nullish(),
		linkedProviders: z.array(linkedProviderSchema).nullish(),
		locationDataStatus: z.object({ hasData: z.boolean().nullish() }).nullish(),
	}),
);

export const agentContactSchema = z.object({
	agentMailStatus: z.string().nullish(),
	agentPhoneNumber: z.string().nullish(),
	agentPhoneStatus: z.string().nullish(),
	email: z.string().nullish(),
	smsPhoneNumber: z.string().nullish(),
	voiceCallsEnabled: z.boolean().nullish(),
	voicePhoneNumber: z.string().nullish(),
	whatsAppChannelPhoneNumber: z.string().nullish(),
});

export const agentContactResponseSchema = graphqlEnvelope(
	z.object({ agentContact: agentContactSchema.nullish() }),
);

const googleServiceSchema = z.object({
	connected: z.boolean().nullish(),
	label: z.string().nullish(),
	notificationIssue: z.boolean().nullish(),
	readOnly: z.boolean().nullish(),
	serviceId: z.string().nullish(),
});

export const connectionsResponseSchema = graphqlEnvelope(
	z.object({
		githubConnection: z
			.object({
				displayName: z.string().nullish(),
				email: z.string().nullish(),
				id: z.string().nullish(),
				isRevoked: z.boolean().nullish(),
				username: z.string().nullish(),
			})
			.nullish(),
		googleWorkspaceConnections: z
			.array(
				z.object({
					email: z.string().nullish(),
					id: z.string().nullish(),
					isDefault: z.boolean().nullish(),
					isRevoked: z.boolean().nullish(),
					services: z.array(googleServiceSchema).nullish(),
				}),
			)
			.nullish(),
		granolaConnection: z
			.object({
				accountEmail: z.string().nullish(),
				id: z.string().nullish(),
				workspaceName: z.string().nullish(),
			})
			.nullish(),
		linearConnections: z
			.array(
				z.object({
					displayName: z.string().nullish(),
					email: z.string().nullish(),
					id: z.string().nullish(),
					isDefault: z.boolean().nullish(),
					isRevoked: z.boolean().nullish(),
					organizationName: z.string().nullish(),
				}),
			)
			.nullish(),
		notionConnections: z
			.array(
				z.object({
					id: z.string().nullish(),
					isDefault: z.boolean().nullish(),
					isRevoked: z.boolean().nullish(),
					workspaceName: z.string().nullish(),
				}),
			)
			.nullish(),
		outlookConnections: z
			.array(
				z.object({
					displayName: z.string().nullish(),
					email: z.string().nullish(),
					id: z.string().nullish(),
					isDefault: z.boolean().nullish(),
					isRevoked: z.boolean().nullish(),
				}),
			)
			.nullish(),
		shopWalletConnection: z
			.object({
				email: z.string().nullish(),
				id: z.string().nullish(),
				isRevoked: z.boolean().nullish(),
			})
			.nullish(),
		slackCanvasConnection: z
			.object({
				isRevoked: z.boolean().nullish(),
				teamId: z.string().nullish(),
				teamName: z.string().nullish(),
			})
			.nullish(),
		stripeLinkConnection: z
			.object({ connected: z.boolean().nullish() })
			.nullish(),
		whoopConnection: z
			.object({
				email: z.string().nullish(),
				firstName: z.string().nullish(),
				id: z.string().nullish(),
				lastName: z.string().nullish(),
			})
			.nullish(),
	}),
);

export const messagingResponseSchema = graphqlEnvelope(
	z.object({
		imessageConnection: z
			.object({ icloudEmail: z.string().nullish() })
			.nullish(),
		whatsappChannelConnection: z
			.object({
				phoneNumber: z.string().nullish(),
				userId: z.string().nullish(),
			})
			.nullish(),
	}),
);

export const imessageDeviceResponseSchema = graphqlEnvelope(
	z.object({
		imessageLocalConnection: z
			.object({
				accountHandle: z.string().nullish(),
				connectedAt: z.union([z.string(), z.number()]).nullish(),
				preferredDeviceId: z.string().nullish(),
				userId: z.string().nullish(),
			})
			.nullish(),
	}),
);

export const devicesResponseSchema = graphqlEnvelope(
	z.object({
		devices: z
			.array(
				z.object({
					batteryLevel: z.number().nullish(),
					createdAt: z.union([z.string(), z.number()]).nullish(),
					deviceType: z.string().nullish(),
					hostname: z.string().nullish(),
					id: z.string().min(1),
					isCharging: z.boolean().nullish(),
					isConnected: z.boolean().nullish(),
					name: z.string().nullish(),
					osVersion: z.string().nullish(),
				}),
			)
			.nullish(),
	}),
);

export const trustedPersonSchema = z.object({
	createdAt: z.union([z.string(), z.number()]).nullish(),
	decisionGeneration: z.number().nullish(),
	displayName: z.string().nullish(),
	expiresAt: z.union([z.string(), z.number()]).nullish(),
	generation: z.number().nullish(),
	id: z.string().min(1),
	phoneNumbers: z.array(z.string()).nullish(),
	status: z.string().nullish(),
});

const trustedPageSchema = z.object({
	cursor: z.string().nullish(),
	items: z.array(trustedPersonSchema).nullish(),
});

export const trustedNetworkResponseSchema = graphqlEnvelope(
	z.object({
		agentToAgentSettings: z
			.object({ enabled: z.boolean().nullish() })
			.nullish(),
		trustedNetworkBlockedPeople: trustedPageSchema.nullish(),
		trustedNetworkContacts: trustedPageSchema.nullish(),
		trustedNetworkRequests: trustedPageSchema.nullish(),
		trustedNetworkSentRequests: z
			.array(
				z.object({
					createdAt: z.union([z.string(), z.number()]).nullish(),
					expiresAt: z.union([z.string(), z.number()]).nullish(),
					id: z.string().min(1),
					phoneNumber: z.string().nullish(),
				}),
			)
			.nullish(),
	}),
);

export const vaultResponseSchema = graphqlEnvelope(
	z.object({
		vaultEntries: z
			.array(
				z.object({
					fields: z
						.array(
							z.object({
								key: z.string(),
								populated: z.boolean().nullish(),
							}),
						)
						.nullish(),
					isAgentEntry: z.boolean().nullish(),
					kind: z.string().min(1),
					name: z.string().nullish(),
				}),
			)
			.nullish(),
		vaultKinds: z
			.array(
				z.object({
					kind: z.string().min(1),
					subfieldKeys: z.array(z.string()).nullish(),
				}),
			)
			.nullish(),
	}),
);

// ─── Chat history ──────────────────────────────────────────────────────────
//
// `chats` and `chatHistory` back the app's /agent page. The `agent_chat`
// feature flag hides that page but does not gate the resolvers. `createdAt`
// is epoch seconds on the wire. Each event populates the one block its
// `type` names; the rest are null.

const epochOrIso = z.union([z.string(), z.number()]).nullish();
const looseBlock = z.record(z.string(), z.unknown()).nullish();

export const chatSchema = z.object({
	id: z.string().min(1),
	pendingTurnStartedAt: epochOrIso,
	source: z.string().nullish(),
	status: z.string().nullish(),
	title: z.string().nullish(),
});

export const chatsResponseSchema = graphqlEnvelope(
	z.object({
		chats: z
			.object({
				chats: z.array(chatSchema).nullish(),
				cursor: z.string().nullish(),
			})
			.nullish(),
	}),
);

export const chatEventSchema = z.object({
	action: looseBlock,
	createdAt: epochOrIso,
	draftField: looseBlock,
	error: z.object({ message: z.string().nullish() }).nullish(),
	id: z.string().min(1),
	interaction: looseBlock,
	interactionResponse: looseBlock,
	message: z
		.object({
			attachments: z
				.array(
					z.object({
						byteSize: z.number().nullish(),
						filename: z.string().nullish(),
						id: z.string().nullish(),
						kind: z.string().nullish(),
						mimeType: z.string().nullish(),
					}),
				)
				.nullish(),
			content: z.string().nullish(),
			id: z.string().min(1),
			origin: z
				.object({
					agentDisplayName: z.string().nullish(),
					kind: z.string().nullish(),
				})
				.nullish(),
			readAt: epochOrIso,
			role: z.string().nullish(),
		})
		.nullish(),
	screenshot: z.object({ url: z.string().nullish() }).nullish(),
	thinking: z.object({ thinking: z.string().nullish() }).nullish(),
	toolInvocation: z
		.object({
			arguments: z.string().nullish(),
			toolId: z.string().nullish(),
			toolName: z.string().nullish(),
		})
		.nullish(),
	toolResponse: z
		.object({
			isError: z.boolean().nullish(),
			response: z.string().nullish(),
			toolId: z.string().nullish(),
			toolName: z.string().nullish(),
		})
		.nullish(),
	type: z.string().min(1),
});

export const chatHistoryResponseSchema = graphqlEnvelope(
	z.object({
		chatHistory: z
			.object({
				cursor: z.string().nullish(),
				events: z.array(chatEventSchema).nullish(),
			})
			.nullish(),
	}),
);

// ─── Emitted record shapes ─────────────────────────────────────────────────

export const profileRecordSchema = z.object({
	agent_to_agent_enabled: nullableBool,
	email: nullableEmail,
	enabled_feature_flags: stringArray,
	has_location_data: nullableBool,
	id: z.string().min(1),
	linked_sign_in_providers: z.array(
		z.object({ provider: z.string(), subject: z.string().nullable() }),
	),
	name: pdppSafeText.max(200).nullable(),
	observed_at: nullableIsoDateTime,
	onboarding_step: pdppSafeText.max(64).nullable(),
	phone_number: nullableE164,
	profile_picture_url: z.string().url().nullable(),
	roles: stringArray,
	training_data_opt_out: nullableBool,
});

export const agentContactRecordSchema = z.object({
	agent_mail_status: pdppSafeText.max(64).nullable(),
	agent_phone_number: nullableE164,
	agent_phone_status: pdppSafeText.max(64).nullable(),
	email: nullableEmail,
	id: z.literal("agent_contact"),
	observed_at: nullableIsoDateTime,
	sms_phone_number: nullableE164,
	voice_calls_enabled: nullableBool,
	voice_phone_number: nullableE164,
	whatsapp_channel_phone_number: nullableE164,
});

export const connectionRecordSchema = z.object({
	account_email: nullableEmail,
	account_name: pdppSafeText.max(200).nullable(),
	connection_id: pdppSafeText.max(200).nullable(),
	id: z.string().min(3),
	is_connected: nullableBool,
	is_default: nullableBool,
	is_revoked: nullableBool,
	observed_at: nullableIsoDateTime,
	provider: z.enum([
		"github",
		"google_workspace",
		"granola",
		"imessage",
		"linear",
		"notion",
		"outlook",
		"shop_wallet",
		"slack",
		"stripe_link",
		"whatsapp",
		"whoop",
	]),
	services: z.array(
		z.object({
			connected: nullableBool,
			label: pdppSafeText.max(200).nullable(),
			notification_issue: nullableBool,
			read_only: nullableBool,
			service_id: z.string(),
		}),
	),
	workspace_name: pdppSafeText.max(200).nullable(),
});

export const deviceRecordSchema = z.object({
	battery_level: nullableInt.refine(
		(value) => value === null || (value >= 0 && value <= 100),
		{ message: "battery_level must be a 0-100 percentage" },
	),
	created_at: nullableIsoDateTime,
	device_type: pdppSafeText.max(64).nullable(),
	hostname: pdppSafeText.max(255).nullable(),
	id: z.string().min(1),
	is_charging: nullableBool,
	is_connected: nullableBool,
	name: pdppSafeText.max(200).nullable(),
	observed_at: nullableIsoDateTime,
	os_version: pdppSafeText.max(100).nullable(),
});

export const trustedPersonRecordSchema = z.object({
	created_at: nullableIsoDateTime,
	display_name: pdppSafeText.max(200).nullable(),
	expires_at: nullableIsoDateTime,
	generation: nullableInt,
	id: z.string().min(3),
	observed_at: nullableIsoDateTime,
	person_id: z.string().min(1).nullable(),
	phone_numbers: stringArray,
	relationship: z.enum([
		"blocked",
		"contact",
		"incoming_request",
		"sent_request",
	]),
	status: pdppSafeText.max(64).nullable(),
});

export const vaultEntryRecordSchema = z.object({
	field_keys: stringArray,
	id: z.string().min(2),
	is_agent_entry: nullableBool,
	kind: pdppSafeText.max(64),
	name: pdppSafeText.max(200).nullable(),
	observed_at: nullableIsoDateTime,
	populated_field_keys: stringArray,
});

export const chatRecordSchema = z.object({
	id: z.string().min(1),
	observed_at: nullableIsoDateTime,
	pending_turn_started_at: nullableIsoDateTime,
	source: pdppSafeText.max(64).nullable(),
	status: pdppSafeText.max(64).nullable(),
	title: pdppSafeText.max(500).nullable(),
});

const chatEventText = pdppSafeText.max(1_000_000).nullable();
const chatEventBlock = z.record(z.string(), z.unknown()).nullable();

/**
 * One event in a chat's history, as Instinct records it: the owner's
 * messages plus the agent's tool calls, tool responses, interactions, and
 * errors. `type` says which of the per-kind columns are populated.
 */
export const chatEventRecordSchema = z.object({
	action: chatEventBlock,
	attachments: z.array(
		z.object({
			byte_size: nullableInt,
			filename: pdppSafeText.max(500).nullable(),
			id: z.string().nullable(),
			kind: pdppSafeText.max(64).nullable(),
			mime_type: pdppSafeText.max(200).nullable(),
		}),
	),
	chat_id: z.string().min(1),
	content: chatEventText,
	created_at: nullableIsoDateTime,
	draft_field: chatEventBlock,
	error_message: chatEventText,
	has_screenshot: z.boolean(),
	id: z.string().min(1),
	interaction: chatEventBlock,
	interaction_response: chatEventBlock,
	message_id: z.string().nullable(),
	origin_agent_display_name: pdppSafeText.max(200).nullable(),
	origin_kind: pdppSafeText.max(64).nullable(),
	read_at: nullableIsoDateTime,
	role: pdppSafeText.max(32).nullable(),
	thinking: chatEventText,
	tool_arguments: chatEventText,
	tool_call_id: z.string().nullable(),
	tool_is_error: nullableBool,
	tool_name: pdppSafeText.max(128).nullable(),
	tool_response: chatEventText,
	type: pdppSafeText.max(64),
});

/** Stream → schema registry. Single source of truth for emitted streams. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	agent_contact: agentContactRecordSchema,
	chat_events: chatEventRecordSchema,
	chats: chatRecordSchema,
	connections: connectionRecordSchema,
	devices: deviceRecordSchema,
	profile: profileRecordSchema,
	trusted_people: trustedPersonRecordSchema,
	vault_entries: vaultEntryRecordSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
