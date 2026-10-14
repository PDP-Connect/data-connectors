// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Technical detail for the run log, kept apart from owner-facing PROGRESS text.
 *
 * Hosts show `PROGRESS.message` to the owner verbatim (the Vana mobile sheet,
 * the desktop status line, the operator console). Codes, counts, concurrency,
 * HTTP statuses and field names belong here instead. The protocol has no LOG
 * event, so a diagnostic is one stderr line:
 *
 *   [<source>-diagnostic] <event> {"key":"value",...}
 *
 * `<source>` is the connector name (or a shared module such as `runtime`).
 * `<event>` is a short snake_case code. The JSON tail is optional and must
 * carry only bounded, non-secret facts: no tokens, cookies, email bodies,
 * message text or account identifiers. Hosts keep stderr as the run log;
 * `bin/connector-dev.ts` prints it live.
 *
 * Use `console.error`, not `process.stderr`: the PageShim host passes a bare
 * `process` with no stderr, so a stderr write would throw there.
 */

export type ConnectorDiagnosticFields = Readonly<
	Record<string, boolean | number | string | null | undefined>
>;

/** Receives the full line, prefix included. Tests replace it to read lines. */
export type ConnectorDiagnosticSink = (line: string) => void;

/** Longest line written. Some hosts truncate console lines; keep them short. */
export const CONNECTOR_DIAGNOSTIC_MAX_CHARS = 2000;

/**
 * Budget for one line on the phone host, which truncates a message 160
 * characters past its own prefix. A connector that emits several report lines
 * (the layout diagnostics) measures each formatted line against this, so a
 * line is never cut mid-field.
 */
export const DIAGNOSTIC_LINE_MAX_CHARS = 150;

const defaultSink: ConnectorDiagnosticSink = (line) => {
	console.error(line);
};

let sink: ConnectorDiagnosticSink = defaultSink;

export function setConnectorDiagnosticSink(
	next: ConnectorDiagnosticSink | undefined,
): void {
	sink = next ?? defaultSink;
}

/** Format one diagnostic line without writing it. */
export function formatConnectorDiagnostic(
	source: string,
	event: string,
	fields?: ConnectorDiagnosticFields,
): string {
	const defined = fields
		? Object.fromEntries(
				Object.entries(fields).filter(([, value]) => value !== undefined),
			)
		: {};
	const tail =
		Object.keys(defined).length > 0 ? ` ${JSON.stringify(defined)}` : "";
	const line = `[${source}-diagnostic] ${event}${tail}`;
	return line.length > CONNECTOR_DIAGNOSTIC_MAX_CHARS
		? `${line.slice(0, CONNECTOR_DIAGNOSTIC_MAX_CHARS - 1)}…`
		: line;
}

/** Write one diagnostic line to the run log. Never throws. */
export function connectorDiagnostic(
	source: string,
	event: string,
	fields?: ConnectorDiagnosticFields,
): void {
	try {
		sink(formatConnectorDiagnostic(source, event, fields));
	} catch {
		// A diagnostic must never fail a run.
	}
}

/**
 * Words and shapes that mark PROGRESS text as technical rather than
 * owner-facing. Used by `assertUserFacingProgress` in tests.
 */
export const PROGRESS_TECHNICAL_PATTERN =
	/\b[a-z]+_[a-z_]+\b|\b\w+=\S|\bhttps?\b|\bHTTP\b|\b429\b|\d+ms\b|[{}[\]]|\bnull\b|\bundefined\b|\bmismatch\b|\bconcurrency\b|\bpreflight\b|\bcircuit\b|\blane\b|\bselector\b|\bprobe\b|\.json\b|\bPDPP_|\bDETAIL_|\bSKIP_RESULT\b/;

/**
 * Throw when a PROGRESS message reads as technical. `allow` lists exact
 * messages or patterns that are owner-facing despite matching (for example
 * a product name that contains an underscore).
 */
export function assertUserFacingProgress(
	messages: readonly unknown[],
	allow: readonly (RegExp | string)[] = [],
): void {
	for (const message of messages) {
		if (
			typeof message !== "object" ||
			message === null ||
			(message as { type?: unknown }).type !== "PROGRESS"
		) {
			continue;
		}
		const text = String((message as { message?: unknown }).message ?? "");
		if (
			allow.some((rule) =>
				typeof rule === "string" ? rule === text : rule.test(text),
			)
		) {
			continue;
		}
		const match = PROGRESS_TECHNICAL_PATTERN.exec(text);
		if (match) {
			throw new Error(
				`PROGRESS must be owner-facing plain English; "${match[0]}" in: ${text}`,
			);
		}
	}
}
