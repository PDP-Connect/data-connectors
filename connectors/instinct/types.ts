// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Instinct connector. Every shape here is inferred from
// the Zod parsers in schemas.ts rather than hand-written, so a schema change
// is a type error at the call site instead of a silent drift. Kept out of
// index.ts so the pure record builders in parsers.ts can import them without
// pulling in the runtime entry point.

import type { z } from "zod";
import type {
	agentContactResponseSchema,
	agentContactSchema,
	chatEventSchema,
	chatHistoryResponseSchema,
	chatSchema,
	chatsResponseSchema,
	connectionsResponseSchema,
	devicesResponseSchema,
	graphqlErrorSchema,
	imessageDeviceResponseSchema,
	messagingResponseSchema,
	profileResponseSchema,
	trustedNetworkResponseSchema,
	trustedPersonSchema,
	vaultResponseSchema,
} from "./schemas.ts";

export type GraphqlError = z.infer<typeof graphqlErrorSchema>;
export type AgentContact = z.infer<typeof agentContactSchema>;
export type TrustedPerson = z.infer<typeof trustedPersonSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type ChatsResponse = z.infer<typeof chatsResponseSchema>;
export type ChatHistoryResponse = z.infer<typeof chatHistoryResponseSchema>;

export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export type AgentContactResponse = z.infer<typeof agentContactResponseSchema>;
export type ConnectionsResponse = z.infer<typeof connectionsResponseSchema>;
export type MessagingResponse = z.infer<typeof messagingResponseSchema>;
export type ImessageDeviceResponse = z.infer<
	typeof imessageDeviceResponseSchema
>;
export type DevicesResponse = z.infer<typeof devicesResponseSchema>;
export type TrustedNetworkResponse = z.infer<
	typeof trustedNetworkResponseSchema
>;
export type VaultResponse = z.infer<typeof vaultResponseSchema>;

/** What a single in-page GraphQL POST returns before schema parsing. */
export interface GraphqlFetchResult {
	readonly invalidJson?: boolean;
	readonly json: unknown;
	readonly status: number;
}

/** The in-page GraphQL caller index.ts hands to the collect helpers. */
export type InstinctGraphql = (
	query: string,
	variables?: Readonly<Record<string, unknown>>,
) => Promise<GraphqlFetchResult>;

/**
 * Which of Instinct's feature-flagged connection resolvers to ask for.
 *
 * The web app gates `whoopConnection` and `stripeLinkConnection` behind the
 * owner's own feature flags and this connector does the same. Asking for a
 * resolver the account is not flagged for makes Instinct answer `200` with an
 * `internal server error` on that path (observed live on `whoopConnection`),
 * which would otherwise look like a real collection failure.
 */
export interface ConnectionFeatureGates {
	readonly showStripeLink: boolean;
	readonly showWhoop: boolean;
}

/** The provider keys the `connections` stream may emit. */
export type ConnectionProvider =
	| "github"
	| "google_workspace"
	| "granola"
	| "imessage"
	| "linear"
	| "notion"
	| "outlook"
	| "shop_wallet"
	| "slack"
	| "stripe_link"
	| "whatsapp"
	| "whoop";

/**
 * Per-chat incremental checkpoint. `chatHistory` pages newest-first, so the
 * high-water mark is the newest event seen; several events can share one
 * epoch second, so the ids at that second are kept to avoid re-emitting them.
 */
export interface ChatCheckpoint {
	readonly newest_created_at: number;
	readonly newest_ids: readonly string[];
}
