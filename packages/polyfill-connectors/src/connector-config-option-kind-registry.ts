// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-owned authority for whether a connector config option shapes
 * collection scope or only transport tuning.
 *
 * D10 (scripts/canary/otp-posture.ts): "qualification is proven, never
 * self-declared." A manifest's `options_schema[key].declared_option_kind`
 * is that connector's CLAIM. This registry is the platform's decision, and
 * it is the one connector_instance_config_store.propose() actually trusts
 * -- a manifest cannot widen its own eligibility by mislabeling a
 * collection-shaping knob as "transport" (which self-activates without
 * owner confirmation) instead of "collection_scope" (which does not).
 *
 * Deliberately asymmetric like the OTP posture derivation: a key absent
 * from this registry is NOT trusted as "transport" by omission -- callers
 * must look it up and treat an unknown key as collection_scope (the safer,
 * more restrictive default) rather than silently trusting whatever the
 * manifest wrote. See connector-config-option-kind-honesty.test.ts, which
 * fails the build if a manifest's declared_option_kind disagrees with this
 * registry for any key both sides know about.
 */

export type ConfigOptionKind = "collection_scope" | "transport";

interface ConnectorOptionKinds {
	readonly [optionKey: string]: ConfigOptionKind;
}

/**
 * connector_key -> option key -> platform-decided kind. Only connectors
 * migrated onto the config spine need an entry; a connector absent here
 * falls back to `collection_scope` for every option, so it is over-restricted
 * rather than under-restricted.
 *
 * Keys here are written in the manifest DIRECTORY form (`claude_code`), while
 * a manifest's own `connector_key` is the canonical hyphenated form
 * (`claude-code`). Lookups normalize both sides -- see `normalizeConnectorKey`.
 * Without that, `claude-code` missed `claude_code` entirely and every option
 * silently fell through to the default: safe, but it made the registry's
 * decisions dead letters and left the honesty test with nothing to compare.
 */
const PLATFORM_OPTION_KINDS: Readonly<Record<string, ConnectorOptionKinds>> =
	Object.freeze({
		chatgpt: Object.freeze({
			// Pacing and per-run bounds. A run that stops early defers the rest as
			// resumable gaps, so none of these changes what is eventually collected.
			BACKEND_FETCH_TIMEOUT_MS: "transport",
			BATCH_MAX_PARALLELISM: "transport",
			CIRCUIT_BREAKER: "transport",
			DETAIL_INITIAL_CONCURRENCY_PROBE: "transport",
			DETAIL_MAX_CONCURRENCY_PROBE: "transport",
			DETAIL_PAUSE_MAX_MS_PROBE: "transport",
			DETAIL_PAUSE_MIN_MS_PROBE: "transport",
			DETAIL_RATE_LIMIT_STOP_AFTER: "transport",
			MAX_DETAIL_FETCHES_PER_RUN: "transport",
			MAX_RUN_WALL_CLOCK_MS: "transport",
			MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "transport",
			PACING_BURST_TOLERANCE_MS: "transport",
			PACING_INITIAL_INTERVAL_MS: "transport",
			PACING_MAX_INTERVAL_MS: "transport",
			PACING_MIN_INTERVAL_MS: "transport",
			PACING_RECOVERY_GAIN: "transport",
			RETRY_BUDGET_CAPACITY: "transport",
			RETRY_BUDGET_INITIAL_TOKENS: "transport",
			// These change which records a run emits: the stateless flags drop the
			// unchanged-record suppression, USAGE_DETAIL sets how many conversations
			// the usage summary reads, and SIDE_EFFECT_PROBE skips collection.
			ACCOUNT_PLAN_STATELESS: "collection_scope",
			SIDE_EFFECT_PROBE: "collection_scope",
			USAGE_DETAIL: "collection_scope",
			USAGE_STATELESS: "collection_scope",
		}),
		claude_code: Object.freeze({
			// Both are substring filters over the project folders that get scanned
			// (connectors/claude_code/parsers.ts applyProjectDirScope), so each one
			// decides which sources are collected at all.
			CLAUDE_CODE_PROJECT_EXCLUDE: "collection_scope",
			CLAUDE_CODE_PROJECT_INCLUDE: "collection_scope",
		}),
		gmail: Object.freeze({
			// Attachments above the cap are not downloaded, so it decides which
			// attachments are collected.
			MAX_ATTACHMENT_BYTES: "collection_scope",
			// Page sizes, stall and progress cadence: shape how a run proceeds, not
			// what is eventually collected.
			ATTACHMENT_BACKFILL_PAGE_BYTES: "transport",
			ATTACHMENT_PROGRESS_MIN_BYTES: "transport",
			ATTACHMENT_PROGRESS_MIN_INTERVAL_MS: "transport",
			ATTACHMENT_RECOVERY_PAGE_BYTES: "transport",
			ATTACHMENT_STALL_TIMEOUT_MS: "transport",
			MESSAGES_BACKFILL_WINDOW_UIDS: "transport",
		}),
		google_messages: Object.freeze({
			// Caps how many conversations are scanned after a recency sort, so it
			// decides WHICH chats are collected (connectors/google_messages/index.ts
			// resolveMaxChats).
			GMCLI_MAX_CHATS: "collection_scope",
			// Caps messages fetched per chat, bounding how much history is collected.
			GMCLI_MESSAGES_PER_CHAT_LIMIT: "collection_scope",
			// Subprocess timeout for one helper invocation; changes no selection.
			GMCLI_TIMEOUT_MS: "transport",
		}),
		slack_browser: Object.freeze({
			CHANNEL_ALLOWLIST: "collection_scope",
			CHANNEL_TYPES: "collection_scope",
			LOOKBACK_DAYS: "collection_scope",
			MAX_BACKFILL_DAYS: "collection_scope",
			WORKSPACE: "collection_scope",
		}),
		slack: Object.freeze({
			CHANNEL_ALLOWLIST: "collection_scope",
			CHANNEL_TYPES: "collection_scope",
			MEMBER_ONLY: "collection_scope",
			LOOKBACK_DAYS: "collection_scope",
			SKIP_FILES: "transport",
			RECLAIM_UPLOADS: "transport",
		}),
	});

/**
 * The platform's decision for a given connector+option key. Absence (an
 * unregistered connector, or a key the registry has not classified) is
 * NOT a green light -- callers MUST treat `null` as "not yet proven
 * transport" and default to the collection_scope (never-self-activating)
 * path, never to transport.
 */
/**
 * Manifests carry the canonical hyphenated `connector_key` (`claude-code`);
 * this registry is written in the underscored directory form (`claude_code`).
 * Normalizing to one form makes the lookup independent of which spelling the
 * caller happens to hold.
 */
function normalizeConnectorKey(connectorKey: string): string {
	return connectorKey.replaceAll("-", "_");
}

export function platformOptionKind(
	connectorKey: string,
	optionKey: string,
): ConfigOptionKind | null {
	return (
		PLATFORM_OPTION_KINDS[normalizeConnectorKey(connectorKey)]?.[optionKey] ??
		null
	);
}

/**
 * Resolve the kind the runtime will actually enforce for a manifest-declared
 * option: the platform's classification when registered, otherwise the
 * conservative collection_scope default -- never the manifest's own claim.
 */
export function resolveEnforcedOptionKind(
	connectorKey: string,
	optionKey: string,
): ConfigOptionKind {
	return platformOptionKind(connectorKey, optionKey) ?? "collection_scope";
}
