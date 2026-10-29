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
 * Per-chat checkpoint. `chatHistory` pages newest-first, so a chat's events
 * are known as one band of time: every event created at or after
 * `covered_since` (epoch seconds; null means from the start of the history)
 * and up to `newest_created_at` was delivered. Several events can share one
 * epoch second, so the ids at the newest second are kept to avoid re-emitting
 * them. `newest_created_at` is null when no event was in the band.
 *
 * The lower bound is what keeps a time-bounded run honest: a run under
 * `since` reads and delivers only the newer part of a history, and a later
 * run with an earlier `since` (or none) sees from `covered_since` that the
 * older part was never delivered and reads down to it.
 */
export interface ChatCheckpoint {
	readonly covered_since: number | null;
	readonly newest_created_at: number | null;
	readonly newest_ids: readonly string[];
}

/**
 * How this run reads chat histories, derived from the `chat_events` scope.
 * Bounds are in whole epoch seconds, the precision of Instinct's `createdAt`.
 */
export interface ChatReadPlan {
	/**
	 * The oldest second the scope admits: `since` rounded up to a whole
	 * second, or null when the scope has no `since`. Paging stops below it.
	 */
	readonly floor: number | null;
	/**
	 * The first second the scope no longer admits: `until` rounded up to a
	 * whole second, or null when the scope has no `until`.
	 */
	readonly untilSecond: number | null;
	/** True when the scope carries a `time_range`. */
	readonly bounded: boolean;
	/**
	 * False when the runtime drops events by something other than time (a
	 * `resources` list, or a bound this connector cannot read): what was read
	 * is then not what was delivered, so no checkpoint may move.
	 */
	readonly mayAdvance: boolean;
}
