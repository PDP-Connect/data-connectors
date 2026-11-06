// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helpers for tests that run a connector as a subprocess and read its
 * `ACCOUNT_IDENTITY` message off the wire.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { packageRoot, repoRoot } from "./connector-paths.ts";
import {
	type ConnectorSubprocessOptions,
	runConnectorProtocolSubprocess,
} from "./test-harness.ts";

export interface StubFetchRoute {
	/** Absolute path to a committed, recorded response body. */
	bodyFile?: string;
	prefix: string;
	status?: number;
}

const PRELOAD = join(
	packageRoot,
	"src",
	"test-fixtures",
	"stub-fetch-preload.mjs",
);

/** Absolute path of a file under the repo, for `StubFetchRoute.bodyFile`. */
export function repoPath(...parts: string[]): string {
	return join(repoRoot, ...parts);
}

/** `env` entries that make a connector subprocess answer `fetch` from `routes`. */
export function stubFetchEnv(
	routes: readonly StubFetchRoute[],
): NodeJS.ProcessEnv {
	return {
		NODE_OPTIONS: `--import ${PRELOAD}`,
		STUB_FETCH_ROUTES: JSON.stringify(routes),
	};
}

/**
 * Runs a connector entrypoint and returns its wire messages in order. The run
 * may fail after the account id was sent, so a failed DONE is allowed.
 */
export async function runAndReadWire(
	options: ConnectorSubprocessOptions,
): Promise<Record<string, unknown>[]> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		...options,
	});
	return result.rawStdout
		.split("\n")
		.filter((line) => line.trim())
		.map((line): Record<string, unknown> => JSON.parse(line));
}

/**
 * Asserts the run sent exactly one `ACCOUNT_IDENTITY` with `expected`, and
 * that it came before `DONE`.
 */
export function assertAccountIdentity(
	wire: readonly Record<string, unknown>[],
	expected: string,
): void {
	const identity = wire.filter((m) => m.type === "ACCOUNT_IDENTITY");
	assert.deepEqual(identity, [
		{ type: "ACCOUNT_IDENTITY", account_id: expected },
	]);
	const doneAt = wire.findIndex((m) => m.type === "DONE");
	const identityAt = wire.findIndex((m) => m.type === "ACCOUNT_IDENTITY");
	assert.ok(doneAt > identityAt, "ACCOUNT_IDENTITY must come before DONE");
}
