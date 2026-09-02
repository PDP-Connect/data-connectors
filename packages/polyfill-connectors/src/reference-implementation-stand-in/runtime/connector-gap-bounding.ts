// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Stand-in for `reference-implementation/runtime/connector-gap-bounding.ts` —
// see ../../README.md for why this directory exists and what it is (and is
// not) safe to vendor.
//
// This file is NOT a byte-identical copy of the real module: the real module
// is 1,000+ lines covering a whole connector-output bounding/projection
// policy cluster (gap diagnostics, scope normalization, recovery hints,
// browser-surface posture, etc.), most of which
// `connector-runtime-session-watchdog.test.ts` never touches. Only the two
// functions that test dynamically imports —
// `boundConnectorErrorCode`/`boundConnectorErrorMessage` — plus their exact,
// self-contained dependency chain (`CONNECTOR_ERROR_MESSAGE_MAX`,
// `CONNECTOR_ERROR_CODE_RE`, and `redactStderrTail` from the sibling
// `stderr-redact.ts`, itself vendored byte-identical) are extracted here,
// byte-identical to their source, from
// `reference-implementation/runtime/connector-gap-bounding.ts` at
// `PDP-Connect/pdpp` commit c0357945b2f6925f84a4f6c1b23491890f72ee4b.
//
// Confirmed safe to extract in isolation: both functions' only dependency
// outside this file's own constants is `redactStderrTail`, which the sibling
// `stderr-redact.ts` stand-in already vendors byte-identical and which has
// zero imports of its own.

import { redactStderrTail } from "./stderr-redact.ts";

const CONNECTOR_ERROR_MESSAGE_MAX = 500;

/**
 * Sanitize a connector-authored error message before persisting it as
 * `connector_error_message` on a terminal spine event.  The message is
 * connector-authored and therefore untrusted: apply the same redaction
 * as redactStderrTail and cap the length.
 *
 * `declaredReasonTokens` is optional and additive — omitted callers see
 * byte-identical behavior to before. When supplied (see
 * `runtime/declared-reason-tokens.ts`), a token in the set survives
 * `redactStderrTail`'s length-based `LONG_OPAQUE_RE` pass instead of being
 * collapsed to `[REDACTED]` — see that module's doc for why a categorical,
 * connector-declared fault-class name (e.g. `venmo_probe_transport_error`)
 * is not the kind of secret that heuristic exists to catch.
 */
export function boundConnectorErrorMessage(
	value: unknown,
	declaredReasonTokens?: ReadonlySet<string>,
): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const { text } = redactStderrTail(
		value,
		declaredReasonTokens ? { declaredReasonTokens } : {},
	);
	if (text.length <= CONNECTOR_ERROR_MESSAGE_MAX) {
		return text;
	}
	return `${text.slice(0, CONNECTOR_ERROR_MESSAGE_MAX - 1)}…`;
}

// Mirrors packages/polyfill-connectors/src/connector-runtime.ts's
// CONNECTOR_ERROR_CODE_RE — the two run in different processes (connector
// child vs. RS-side runtime) so cannot literally share a module, but the
// contract MUST match: short, lowercase, snake_case only.
const CONNECTOR_ERROR_CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Validate a connector-declared `error.code` before it is copied verbatim
 * onto `connector_error_code` (see `buildTerminalConnectorFields` below).
 * Unlike `boundConnectorErrorMessage`, this does NOT redact/truncate —
 * `code` is a typed, non-secret channel by contract, so anything that
 * doesn't already match the strict charset/length is untrustworthy and
 * dropped (fails closed to `null`) rather than passed through in any form.
 * A dropped code still leaves the (redacted) `message` field for the owner
 * to read — this only withholds the free-form value from the unredacted
 * column, it never surfaces it elsewhere.
 */
export function boundConnectorErrorCode(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	return CONNECTOR_ERROR_CODE_RE.test(value) ? value : null;
}
