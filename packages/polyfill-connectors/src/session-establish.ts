// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session establishment: the runtime-owned window between browser acquisition
 * and collect(), where a connector's `ensureSession`/`probeSession` hooks run
 * and any failure is classified retryable-or-not.
 *
 * This module owns the establishment flow and its terminal-error
 * classification — including the post-submit credential-safety invariant: once
 * a connector reports (via `EnsureSessionArgs.onCredentialSubmit`) that a
 * saved credential has been submitted to the provider's real sign-in form,
 * every subsequently propagated fault is forced non-retryable regardless of
 * the connector's `retryablePattern`, so a scheduler redispatch can never
 * resubmit a stored password from a fresh process.
 *
 * `connector-runtime.ts` is the production consumer (see `runInBrowser`);
 * tests exercise the same exports through this module boundary.
 */

import type {
	AssistanceCompletionStatus,
	AssistanceRequest,
	InteractionRequest,
	InteractionResponse,
} from "@pdpp/connector-protocol";
import type { ProgressExtra } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type { BrowserContext, Page } from "playwright";
import { manualAction } from "./browser-handoff.ts";
import type { CaptureSession } from "./fixture-capture.ts";
import {
	isConnectorErrorCodeShaped,
	TerminalError,
	type TerminalErrorDetails,
} from "./terminal-error.ts";

export const DEFAULT_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|timeout/i;

/**
 * Mark a named session-establishment phase. Calling this updates the run's
 * last-establishment-progress marker (which the watchdog reads) and, when
 * capture is active, triggers a best-effort durable diagnostic capture for the
 * phase. Best-effort and bounded: a checkpoint SHALL NOT be able to hang the
 * watchdog and a failed capture never fails the run.
 */
export type SessionCheckpointFn = (label: string) => Promise<void>;

export interface EnsureSessionArgs {
	assist: (req: AssistanceRequest) => Promise<string>;
	capture: CaptureSession | null;
	/**
	 * Mark a session-establishment phase (e.g. "sign-in-loaded", "email-submit",
	 * "2fa-decision", "final-verify"). Resets the watchdog's no-progress deadline
	 * and captures a phase diagnostic. Optional for connectors that do not adopt
	 * checkpoints; the runtime still frames the window with its own checkpoints.
	 */
	checkpoint: SessionCheckpointFn;
	completeAssistance: (
		assistanceRequestId: string,
		status: AssistanceCompletionStatus,
		extra?: { message?: string },
	) => Promise<void>;
	context: BrowserContext;
	/** Credentials resolved by the runtime's declared setup auth strategy. */
	credentials: Readonly<Record<string, string>>;
	/**
	 * Call this at the exact line `ensureSession` submits a saved credential to
	 * the provider's real sign-in form (the `.click()`/`.fill()` that sends the
	 * password) — not before, not after. Once called, any error `ensureSession`
	 * subsequently throws is forced non-retryable by the runtime regardless of
	 * `retryablePattern`: a fault that happens after a password has already
	 * been typed into a live form must never cause a fresh process to redispatch
	 * and resubmit that same password. Calling this has no effect on errors
	 * thrown BEFORE the call — those still go through the ordinary
	 * `retryablePattern` classification untouched.
	 */
	onCredentialSubmit: () => void;
	page: Page;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
	sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

export interface ProbeSessionArgs {
	context: BrowserContext;
	page: Page;
}

export interface SessionEstablishArgs {
	assist: EnsureSessionArgs["assist"];
	capture: CaptureSession | null;
	checkpoint: SessionCheckpointFn;
	completeAssistance: EnsureSessionArgs["completeAssistance"];
	context: BrowserContext;
	credentials?: EnsureSessionArgs["credentials"];
	name: string;
	page: Page;
	progress: EnsureSessionArgs["progress"];
	/**
	 * Resolve and apply static-secret credentials on demand, only on a dead-probe
	 * path (see `establishSession`'s doc comment) — whether or not `ensureSession`
	 * is also declared. A connector whose seeded browser profile already carries
	 * a live session must never pay for credential resolution — resolving a
	 * declared `auth` strategy can itself raise a `credentials` INTERACTION or
	 * fail the run, neither of which should happen on a connection that never
	 * needed a credential this run. Absent for connectors with no `auth`
	 * declared, and never consulted on the live-probe path regardless. Returns
	 * the freshly resolved credentials so a caller that goes on to invoke
	 * `ensureSession` in the same call (the both-hooks dead-probe path) passes
	 * it the real values rather than the stale pre-resolution snapshot captured
	 * in this arguments object.
	 */
	resolveDeferredCredentials?: () => Promise<Readonly<Record<string, string>>>;
	retryablePattern: RegExp;
	sendInteraction: EnsureSessionArgs["sendInteraction"];
}

function retryablePatternMatches(pattern: RegExp, value: string): boolean {
	pattern.lastIndex = 0;
	const matched = pattern.test(value);
	pattern.lastIndex = 0;
	return matched;
}

/**
 * `postSubmit` forces `retryable: false` unconditionally, WITHOUT consulting
 * `retryablePattern` at all — a saved credential was already submitted to the
 * provider's real sign-in form, so a fault occurring after that point can
 * never be safely retried from a fresh process, no matter what vocabulary the
 * error message happens to share with the connector's legitimate pre-submit
 * retry patterns (e.g. a bare "timeout" or a shared transport-error term).
 * This is the single point that closes the naming-collision defect class: it
 * decides "did the credential already go out" once, centrally, instead of
 * leaving every connector's regex to (fail to) encode that distinction.
 */
export function buildSessionEstablishTerminalError(
	name: string,
	message: string,
	retryablePattern: RegExp = DEFAULT_RETRYABLE_PATTERN,
	postSubmit = false,
): TerminalErrorDetails {
	const terminalMessage = `${name}_session_failed: ${message}`;
	return {
		message: terminalMessage,
		retryable:
			!postSubmit &&
			(retryablePatternMatches(retryablePattern, message) ||
				retryablePatternMatches(retryablePattern, terminalMessage)),
	};
}

/**
 * Run whichever session-management flow the connector configured.
 * Throws TerminalError if the session is dead and we couldn't recover.
 *
 * Priority when a connector declares BOTH hooks: probeSession runs FIRST. A
 * live probe returns immediately — `ensureSession` never runs, and no static
 * credential is resolved or required, because a pre-authenticated browser
 * profile is sufficient on its own. Only a dead probe falls through to
 * `ensureSession` (automated re-auth, unchanged: resolved credentials,
 * `onCredentialSubmit`, the same non-retryable-after-submit classification).
 *
 * A connector with only `ensureSession` (no `probeSession`) runs it directly,
 * unchanged. A connector with only `probeSession` (no `ensureSession`) keeps
 * the prior read-only-probe + manual_action-fallback path, unchanged. Neither
 * hook: the connector assumes the session is live.
 *
 * The runtime frames the window with a `begin` checkpoint before delegating
 * and a `probe` checkpoint around the read-only probe path so the watchdog
 * has progress markers even for connectors that do not checkpoint themselves.
 *
 * Credential deferral: a valid pre-authenticated browser profile must be
 * sufficient on its own — static secrets are only required when an
 * interactive login is actually needed. `resolveDeferredCredentials`, when
 * supplied, is called ONLY after a probe reports the session is dead, never
 * on the live-probe path — this now applies whether or not `ensureSession` is
 * also declared. This keeps a connection with a live session from ever
 * resolving (or being asked for) a stored credential it does not need. When
 * no `resolveDeferredCredentials` is supplied, behavior is unchanged.
 */
export async function establishSession(
	hooks: {
		ensureSession: ((args: EnsureSessionArgs) => Promise<void>) | undefined;
		probeSession: ((args: ProbeSessionArgs) => Promise<boolean>) | undefined;
	},
	args: SessionEstablishArgs,
): Promise<void> {
	const { ensureSession, probeSession } = hooks;
	const {
		assist,
		capture,
		checkpoint,
		completeAssistance,
		context,
		credentials: initialCredentials = {},
		page,
		name,
		resolveDeferredCredentials,
		retryablePattern,
		sendInteraction,
		progress,
	} = args;

	await checkpoint("session-establish:begin");

	// Both hooks: probe first. A live session skips ensureSession (and any
	// credential resolution) entirely; a dead probe falls through to the same
	// ensureSession call below that a probeSession-less connector would run,
	// after resolving credentials exactly like the probe-only dead path does.
	// `resolvedCredentials` carries the freshly resolved values into
	// ensureSession below — `initialCredentials` (captured before this
	// function ran resolveDeferredCredentials) would otherwise still be the
	// stale empty object from the deferred-credentials call site.
	let resolvedCredentials: Readonly<Record<string, string>> | undefined;
	if (
		typeof ensureSession === "function" &&
		typeof probeSession === "function"
	) {
		await checkpoint("session-establish:probe");
		if (await probeSession({ context, page })) {
			return;
		}
		resolvedCredentials = await resolveDeferredCredentials?.();
	}

	if (typeof ensureSession === "function") {
		// Set once `ensureSession` reports it has submitted a saved credential to
		// the provider's real sign-in form. Scoped to this one establishSession()
		// call — a fresh process gets a fresh `false`, which is correct: the
		// credential wasn't submitted yet IN THIS process, even if a prior
		// process's submission is what's being retried. That's exactly the case
		// this primitive exists to stop: this call is the resubmission risk.
		let credentialSubmitted = false;
		try {
			await ensureSession({
				assist,
				capture,
				checkpoint,
				completeAssistance,
				context,
				credentials: resolvedCredentials ?? initialCredentials,
				onCredentialSubmit: () => {
					credentialSubmitted = true;
				},
				page,
				sendInteraction,
				progress,
			});
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const terminalError = buildSessionEstablishTerminalError(
				name,
				message,
				retryablePattern,
				credentialSubmitted,
			);
			// `message` is about to be redacted (`boundConnectorErrorMessage`) before
			// it reaches the owner — free-form text is untrusted by contract. Most
			// connector ensureSession throw sites (heb.ts, usaa.ts, etc.) already
			// throw a bare `Error("some_snake_case_reason")`: the ENTIRE thrown
			// message is already a short, non-PII, machine-actionable token — the
			// exact shape the unredacted `code` channel exists for (terminal-error.ts).
			// Recover it as `code` here so the redaction below cannot destroy it: a
			// long/opaque-looking-but-innocuous token like
			// "heb_verification_code_not_provided" (35 chars) would otherwise be
			// wholesale-matched by stderr-redact.ts's LONG_OPAQUE_RE and collapsed to
			// a bare "[REDACTED]" with zero diagnostic value. A compound message
			// (anything with a space or colon, e.g. "source_unavailable: USAA
			// reported...") fails the code charset and is correctly left to the
			// redacted `message` channel only.
			const code = isConnectorErrorCodeShaped(message) ? message : undefined;
			throw new TerminalError(terminalError.message, {
				retryable: terminalError.retryable,
				cause: err,
				...(code ? { code } : {}),
			});
		}
	}

	if (typeof probeSession !== "function") {
		return;
	}
	await checkpoint("session-establish:probe");
	if (await probeSession({ context, page })) {
		return;
	}

	// Session is confirmed dead only past this point — safe to pay for
	// credential resolution now. `resolveDeferredCredentials` populates the
	// same `credentials` object `collect()` receives (see `runInBrowser`); it
	// runs the connector's declared `auth` strategy exactly as
	// `resolveCredentials` always has, including registering secrets for
	// capture redaction, just deferred until the probe proves it's needed.
	await resolveDeferredCredentials?.();

	await manualAction(
		{
			page,
			reason: "login",
			message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
			timeoutSeconds: 1800,
		},
		sendInteraction,
	);
	await checkpoint("session-establish:probe-after-manual");
	if (await probeSession({ context, page })) {
		return;
	}

	throw new TerminalError(`${name}_session_required`);
}
