// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The env contract that hands a connector subprocess its artifact spool and
 * outbox.
 *
 * A connector runs as a child process; the outbox and blob spool live with
 * the collector runner that spawned it. `@pdpp/collector-runtime` forwards
 * only the device token, base URL and run id to the child, so a connector had
 * no way to learn where either store lives — which is why artifact capture,
 * although implemented, returned `unavailable` on every ordinary run.
 *
 * `CollectorConnectorSpec.env` is the runtime's caller-populated channel to
 * the child (it is spread last in `spawnConnector`, so it wins over ambient
 * environment). These two variables travel that channel. Defining them once
 * here keeps the writer (`bin/collector-runner.ts`) and the reader (a
 * connector's `collect()`) on one contract rather than two string literals
 * that can drift apart.
 *
 * Both stores are safe to share between the runner and the child: the outbox
 * is SQLite in WAL mode with a 5s busy timeout, and the spool promotes
 * content-addressed objects by writing a pid-scoped temp file and renaming it.
 */

import { dirname, join } from "node:path";

/** Absolute path of the durable outbox the child should enqueue into. */
export const ARTIFACT_OUTBOX_PATH_ENV = "PDPP_ARTIFACT_OUTBOX_PATH";

/** Absolute root of the content-addressed blob spool the child should write. */
export const ARTIFACT_SPOOL_ROOT_ENV = "PDPP_ARTIFACT_SPOOL_ROOT";

/** The connection this run collects for, so enqueued rows are attributable. */
export const ARTIFACT_SOURCE_INSTANCE_ENV = "PDPP_ARTIFACT_SOURCE_INSTANCE_ID";

export interface ArtifactCaptureEnvInput {
	outboxPath: string;
	sourceInstanceId: string;
	spoolRoot?: string;
}

/**
 * The spool sits beside the outbox by default, so one queue path configures
 * both stores and a per-connection queue keeps its own bytes.
 */
export function defaultArtifactSpoolRoot(outboxPath: string): string {
	return join(dirname(outboxPath), "blob-spool");
}

/** Build the child env that enables artifact capture for this run. */
export function buildArtifactCaptureEnv(
	input: ArtifactCaptureEnvInput,
): Record<string, string> {
	return {
		[ARTIFACT_OUTBOX_PATH_ENV]: input.outboxPath,
		[ARTIFACT_SOURCE_INSTANCE_ENV]: input.sourceInstanceId,
		[ARTIFACT_SPOOL_ROOT_ENV]:
			input.spoolRoot ?? defaultArtifactSpoolRoot(input.outboxPath),
	};
}

export interface ResolvedArtifactCaptureEnv {
	outboxPath: string;
	sourceInstanceId: string;
	spoolRoot: string;
}

/**
 * Read the contract back inside the connector child.
 *
 * Returns null when the run did not supply it — a fixture, a dry run, or a
 * caller that has not opted in. That is a capability statement, and the
 * connector records it as `unavailable` rather than failing the run.
 */
export function resolveArtifactCaptureEnv(
	env: NodeJS.ProcessEnv = process.env,
): ResolvedArtifactCaptureEnv | null {
	const outboxPath = env[ARTIFACT_OUTBOX_PATH_ENV]?.trim();
	const sourceInstanceId = env[ARTIFACT_SOURCE_INSTANCE_ENV]?.trim();
	if (!(outboxPath && sourceInstanceId)) {
		return null;
	}
	const spoolRoot = env[ARTIFACT_SPOOL_ROOT_ENV]?.trim();
	return {
		outboxPath,
		sourceInstanceId,
		spoolRoot: spoolRoot || defaultArtifactSpoolRoot(outboxPath),
	};
}
