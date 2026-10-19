// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Raw claude.ai response shapes read by the anthropic_live connector. Only
// the keys the parsers read are declared. Every shape was observed against a
// real signed-in session on 2026-10-08 (keys and types only; see index.ts).

/** One element of `GET /api/organizations`. */
export interface RawOrganization {
	uuid?: unknown;
	capabilities?: unknown;
	rate_limit_tier?: unknown;
	raven_type?: unknown;
	billing_type?: unknown;
	plan_display_name?: unknown;
	created_at?: unknown;
}

/** One element of `GET …/chat_conversations` (also the detail's top level). */
export interface RawConversation {
	uuid?: unknown;
	name?: unknown;
	summary?: unknown;
	model?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	is_starred?: unknown;
	project_uuid?: unknown;
	chat_messages?: unknown;
}

/** One element of the detail's `chat_messages[]`. Carries no model field. */
export interface RawMessage {
	uuid?: unknown;
	text?: unknown;
	content?: unknown;
	sender?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	attachments?: unknown;
	parent_message_uuid?: unknown;
}

/** `GET …/subscription_details`. `payment_method` is never read. */
export interface RawSubscriptionDetails {
	status?: unknown;
	billing_interval?: unknown;
	next_charge_at?: unknown;
	plan_ending_at?: unknown;
}

/** One `{ utilization, resets_at }` window of `GET …/usage`. */
export interface RawUsageWindow {
	utilization?: unknown;
	resets_at?: unknown;
}

/** One element of `usage.limits[]`. */
export interface RawUsageLimit {
	kind?: unknown;
	group?: unknown;
	percent?: unknown;
	severity?: unknown;
	resets_at?: unknown;
	is_active?: unknown;
	scope?: unknown;
}

/** `GET …/usage`. Spend and credit members are never read. */
export interface RawUsage {
	limits?: unknown;
	five_hour?: unknown;
	seven_day?: unknown;
}
