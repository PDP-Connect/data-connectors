// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The frames of a failure's stack, for the host's crash telemetry: where in
 * connector or runtime code a run broke, and nothing else.
 *
 * A raw `error.stack` starts with the error message, which can quote a page,
 * a name or an address, and its frames carry absolute paths under the
 * person's home directory and the provider site's script URLs. None of that
 * is handed over. Each line is kept only when it is a stack frame (V8
 * `at ...`, WebKit/Firefox `fn@file:line:col`) whose file sits under a
 * known code root, and only the part of the path from that root on is kept,
 * written as `    at <root-relative file>:<line>[:<col>]` with no function
 * name. Message lines, URLs, `node:` internals, `node_modules`, `eval` and
 * `<anonymous>` frames are dropped.
 *
 * Roots, as hosts load connector code:
 *   vana-connector/<id>.js           a bundle the host named with
 *                                     `//# sourceURL=` (PageShim hosts)
 *   collection-profiles/<id>/...     a host-installed artifact (Desktop)
 *   connectors/<id>/...              a data-connectors checkout
 *   packages/polyfill-connectors/... this runtime, from a checkout
 *
 * The host still applies its own sanitizer before anything leaves the
 * device; this keeps the hand-off itself free of personal data.
 *
 * Example: an error whose stack is
 *   "TypeError: jane@example.com\n    at f (/Users/jane/x/connectors/strava/index.ts:12:3)"
 * gives "    at connectors/strava/index.ts:12:3".
 */

export const ERROR_STACK_MAX_FRAMES = 16;
const STACK_MAX_CHARS = 16_384;

const V8_FRAME = /^\s*at\s+(?:.*?\s\()?(.+?):(\d{1,7})(?::(\d{1,7}))?\)?\s*$/u;
// A WebKit/Firefox frame's file must end in a script extension, so a
// message line such as `failed for jane@example.com:443` never reads as one.
const AT_FRAME =
	/^[^@]*@([^\s@]+\.(?:[cm]?js|tsx?|jsx))(?:\?[^\s:]*)?:(\d{1,7})(?::(\d{1,7}))?\s*$/u;

const FOREIGN_FILE =
	/^(?:[a-z][a-z0-9+.-]*-extension:|https?:|blob:|data:|webkit-masked-url:|node:|wasm:|about:)|\beval\b|<anonymous>|^native$|(?:^|\/)node_modules\//iu;

const ROOT =
	/(?:^|\/)((?:vana-connector|collection-profiles|connectors|packages\/polyfill-connectors)\/[A-Za-z0-9_.@/-]+)$/u;

function rootRelative(file: string): string | undefined {
	if (FOREIGN_FILE.test(file)) return undefined;
	let path = file;
	if (/^file:\/\//iu.test(path)) {
		try {
			path = decodeURIComponent(path.replace(/^file:\/\//iu, ""));
		} catch {
			return undefined;
		}
	}
	path = path.replace(/\\/gu, "/").replace(/[?#].*$/u, "");
	const kept = ROOT.exec(path)?.[1];
	if (kept === undefined || kept.split("/").includes("..")) return undefined;
	return kept;
}

/**
 * Root-relative frame lines of `error`'s stack, newline-joined, at most
 * {@link ERROR_STACK_MAX_FRAMES}; `undefined` when none qualifies.
 */
export function errorStackFrames(error: unknown): string | undefined {
	const stack =
		error && typeof error === "object"
			? (error as { stack?: unknown }).stack
			: undefined;
	if (typeof stack !== "string") return undefined;
	const frames: string[] = [];
	for (const line of stack.slice(0, STACK_MAX_CHARS).split("\n")) {
		const match = V8_FRAME.exec(line) ?? AT_FRAME.exec(line);
		if (!match?.[1] || !match[2]) continue;
		const file = rootRelative(match[1].trim());
		if (file === undefined) continue;
		frames.push(`    at ${file}:${match[2]}${match[3] ? `:${match[3]}` : ""}`);
		if (frames.length >= ERROR_STACK_MAX_FRAMES) break;
	}
	return frames.length > 0 ? frames.join("\n") : undefined;
}
