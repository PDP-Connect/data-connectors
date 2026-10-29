// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The wire form of an enumeration the connector could not prove complete.
 *
 * Collection Profile §5.5 and §5.8 give that case one reason and one error
 * code, `stream_collection_failed`. A runtime certifies a stream-scoped
 * failure, and so preserves the streams the failure did not touch, only from
 * a SKIP_RESULT with that exact reason and a failed DONE with that exact code.
 *
 * A connector reports the case with its own cause, because the cause is what
 * its owner-facing copy and its tests describe. The runtime owns the wire
 * contract: `portableUnprovenEnumerationSkip` rewrites the reason to the
 * portable one and keeps the connector's cause in `diagnostics.original_reason`.
 * The profile defines no sub-reason member on SKIP_RESULT. `message` and
 * `recovery_hint` pass through unchanged; `diagnostics` is the extension
 * member `@pdpp/connector-protocol` already carries on SKIP_RESULT.
 */

import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";

export const PORTABLE_ENUMERATION_FAILURE_REASON = "stream_collection_failed";

/**
 * Connector causes that mean "the end of this enumeration was not observed".
 * A cause belongs here only when it says nothing else: a deferred window, a
 * deliberate cap, or an unreadable row each have their own reason.
 */
export const UNPROVEN_ENUMERATION_CAUSES: ReadonlySet<string> = new Set([
	"inventory_not_proven_complete",
	"linkedin_enumeration_unproven",
]);

export type SkipResultMessage = Extract<
	EmittedMessage,
	{ type: "SKIP_RESULT" }
>;

/** Whether a message is a connector's unproven-enumeration SKIP_RESULT. Takes
 *  any message shape, so the desktop runtime and PageShim share this one
 *  predicate. */
export function isUnprovenEnumerationSkip(message: {
	type: string;
	reason?: unknown;
}): message is SkipResultMessage {
	return (
		message.type === "SKIP_RESULT" &&
		typeof message.reason === "string" &&
		UNPROVEN_ENUMERATION_CAUSES.has(message.reason)
	);
}

/** Whether the connector's hint says a later run can finish the enumeration. */
export function unprovenEnumerationRetryable(skip: SkipResultMessage): boolean {
	const hint = skip.recovery_hint;
	return typeof hint === "object" && hint !== null && hint.retryable === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SKIP_RESULT a runtime puts on the wire for an unproven enumeration. The
 * connector's cause survives in `diagnostics.original_reason`; a cause that an
 * earlier hop already recorded there is kept, since that is the first one.
 */
export function portableUnprovenEnumerationSkip(
	skip: SkipResultMessage,
): SkipResultMessage {
	const { diagnostics } = skip;
	const detail =
		diagnostics === undefined
			? {}
			: isPlainObject(diagnostics)
				? diagnostics
				: { original_diagnostics: diagnostics };
	return {
		...skip,
		reason: PORTABLE_ENUMERATION_FAILURE_REASON,
		diagnostics: {
			...detail,
			original_reason: detail.original_reason ?? skip.reason,
		},
	};
}
