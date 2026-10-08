// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the anthropic_live connector: claude.ai JSON -> records.
// No Playwright calls, so they are unit-tested in isolation.
//
// conversations and messages use the field names of connectors/anthropic
// (the export connector) so the two can be compared record for record.
// account_plan uses the field names of the chatgpt connector's account_plan.

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	RawConversation,
	RawMessage,
	RawOrganization,
	RawSubscriptionDetails,
	RawUsage,
	RawUsageLimit,
	RawUsageWindow,
} from "./types.ts";

const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NON_SLUG_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /^_+|_+$/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function bool(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function isoOrNull(value: unknown): string | null {
	return typeof value === "string" && ISO_DT_RE.test(value) ? value : null;
}

function safeText(value: unknown, max: number): string | null {
	const text = str(value);
	if (text === null) return null;
	const parsed = pdppSafeText.max(max).safeParse(text);
	return parsed.success ? parsed.data : null;
}

/**
 * `conversations` record. `message_count` is known only when the detail was
 * fetched (the list carries no count); pass null otherwise.
 */
export function buildConversationRecord(
	raw: RawConversation,
	messageCount: number | null,
): RecordData | null {
	const id = str(raw.uuid);
	if (id === null) return null;
	return {
		id,
		title: safeText(str(raw.name) ?? str(raw.summary), 4000),
		create_time: isoOrNull(raw.created_at),
		update_time: isoOrNull(raw.updated_at),
		project_id: str(raw.project_uuid),
		model: str(raw.model),
		message_count: messageCount,
		is_starred: bool(raw.is_starred),
	};
}

/** Same precedence as the export parser: `text`, then the text blocks. */
export function flattenMessageText(raw: RawMessage): string {
	const text = str(raw.text);
	if (text !== null) return text;
	if (!Array.isArray(raw.content)) return "";
	return raw.content
		.map((block) =>
			isRecord(block) && block.type === "text" ? (str(block.text) ?? "") : "",
		)
		.filter(Boolean)
		.join("\n");
}

function safeJson(value: unknown): boolean {
	if (typeof value === "string") return pdppSafeText.safeParse(value).success;
	if (value === null || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(safeJson);
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, item]) => pdppSafeText.safeParse(key).success && safeJson(item),
		)
	);
}

/**
 * `messages` record. claude.ai records the model on the conversation, not
 * on a message (no rendering of the detail endpoint carries one), so `model`
 * is the conversation's model at the time this message was collected, on
 * assistant messages only, and `model_source` says so. It is wrong for a
 * message written before the model was switched in a conversation that was
 * first collected after the switch.
 */
export function buildMessageRecord(
	raw: RawMessage,
	conversationId: string,
	conversationModel: string | null,
): RecordData | null {
	const id = str(raw.uuid);
	if (id === null) return null;
	const role = str(raw.sender);
	const model = role === "assistant" ? conversationModel : null;
	return {
		id,
		conversation_id: conversationId,
		role,
		parent_id: str(raw.parent_message_uuid),
		content: safeText(flattenMessageText(raw), 10_000_000),
		model,
		model_source: model === null ? null : "conversation",
		create_time: isoOrNull(raw.created_at),
		update_time: isoOrNull(raw.updated_at),
		attachments: Array.isArray(raw.attachments)
			? raw.attachments.filter(isRecord).filter(safeJson)
			: null,
	};
}

/** The later of a message's created_at and updated_at, as epoch ms. */
export function messageChangedAtMs(raw: RawMessage): number {
	const created = Date.parse(str(raw.created_at) ?? "");
	const updated = Date.parse(str(raw.updated_at) ?? "");
	return Math.max(
		Number.isFinite(created) ? created : 0,
		Number.isFinite(updated) ? updated : 0,
	);
}

function capabilities(org: RawOrganization): string[] {
	return Array.isArray(org.capabilities)
		? org.capabilities.filter((c): c is string => typeof c === "string")
		: [];
}

/**
 * Plan family from the organization's capabilities. `claude_max` and `raven`
 * (Team/Enterprise) and `claude_pro` were observed. An organization with
 * only free-tier capabilities and no billing is "free"; claude.ai reports
 * that as `billing_type: "none"`. Anything else is null, never guessed.
 */
export function planTypeOf(org: RawOrganization): string | null {
	const caps = capabilities(org);
	if (caps.includes("claude_max")) return "max";
	if (caps.includes("claude_pro")) return "pro";
	if (caps.includes("raven")) return str(org.raven_type) ?? "team";
	const billing = str(org.billing_type);
	if (caps.includes("chat") && (billing === null || billing === "none")) {
		return "free";
	}
	return null;
}

/**
 * The single `account_plan` record, field for field the chatgpt connector's.
 * `subscription` is null when subscription_details was not readable; its
 * fields are then null. `cancels_at` and `scheduled_plan_change` have no
 * observed source and are always null. `will_renew` is inferred for an
 * active subscription only: a next charge and no end date. Payment method and
 * billing identifiers are never read.
 */
export function buildAccountPlanRecord(
	org: RawOrganization,
	subscription: RawSubscriptionDetails | null,
): RecordData | null {
	const accountId = str(org.uuid);
	if (accountId === null) return null;
	const status = subscription ? str(subscription.status) : null;
	const renewsAt = subscription ? isoOrNull(subscription.next_charge_at) : null;
	const expiresAt = subscription
		? isoOrNull(subscription.plan_ending_at)
		: null;
	return {
		id: "account_plan",
		account_id: accountId,
		account_structure: capabilities(org).includes("raven")
			? "workspace"
			: "personal",
		account_created_at: isoOrNull(org.created_at),
		plan_type: planTypeOf(org),
		plan_display_name: safeText(org.plan_display_name, 120),
		subscription_plan: safeText(org.rate_limit_tier, 120),
		has_active_subscription: status === null ? null : status === "active",
		billing_period: subscription
			? safeText(subscription.billing_interval, 40)
			: null,
		// Only an active subscription says whether it renews; any other status
		// (e.g. the observed "past_due") leaves it unknown.
		will_renew:
			status === "active" ? renewsAt !== null && expiresAt === null : null,
		renews_at: renewsAt,
		expires_at: expiresAt,
		cancels_at: null,
		scheduled_plan_change: null,
	};
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(NON_SLUG_RE, "_")
		.replace(SLUG_TRIM_RE, "");
}

function limitRecord(raw: RawUsageLimit): RecordData | null {
	const kind = str(raw.kind);
	if (kind === null) return null;
	const scope = isRecord(raw.scope) ? raw.scope : null;
	const scopeModel =
		scope && isRecord(scope.model) ? str(scope.model.display_name) : null;
	const scopeSurface = scope ? str(scope.surface) : null;
	const suffix = [scopeModel, scopeSurface]
		.filter((part): part is string => part !== null)
		.map(slug)
		.join(":");
	return {
		id: suffix ? `${slug(kind)}:${suffix}` : slug(kind),
		kind: safeText(kind, 80),
		group: safeText(raw.group, 80),
		scope_model: safeText(scopeModel, 120),
		scope_surface: safeText(scopeSurface, 120),
		percent_used: num(raw.percent),
		severity: safeText(raw.severity, 40),
		is_active: bool(raw.is_active),
		resets_at: isoOrNull(raw.resets_at),
	};
}

function windowRecord(
	raw: unknown,
	kind: string,
	group: string,
): RecordData | null {
	if (!isRecord(raw)) return null;
	const window = raw as RawUsageWindow;
	const percent = num(window.utilization);
	if (percent === null) return null;
	return {
		id: kind,
		kind,
		group,
		scope_model: null,
		scope_surface: null,
		percent_used: percent,
		severity: null,
		is_active: null,
		resets_at: isoOrNull(window.resets_at),
	};
}

/**
 * `usage_limits` records: one per limit claude.ai reports. Claude reports
 * the share of each limit used and when it resets, never an absolute cap.
 * Reads `limits[]`; when a response has none, falls back to the older
 * `five_hour` / `seven_day` windows. Returns null when the body is not a
 * usage object, so a drifted response is a parse error, not "no limits".
 */
export function buildUsageLimitRecords(raw: unknown): RecordData[] | null {
	if (!isRecord(raw)) return null;
	const usage = raw as RawUsage;
	if (Array.isArray(usage.limits)) {
		return usage.limits
			.filter(isRecord)
			.map((limit) => limitRecord(limit as RawUsageLimit))
			.filter((record): record is RecordData => record !== null);
	}
	if (!("five_hour" in raw || "seven_day" in raw)) return null;
	return [
		windowRecord(usage.five_hour, "session", "session"),
		windowRecord(usage.seven_day, "weekly_all", "weekly"),
	].filter((record): record is RecordData => record !== null);
}
