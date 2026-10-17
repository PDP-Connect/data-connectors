// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const SLACKDUMP_API_CONFIG_FILENAME = "slackdump-api-config.toml";

export const SLACKDUMP_API_CONFIG_TOML = `# Slackdump API limits config with increased retry budgets.
#
# WHY: Slack returns 500 Internal Server Error intermittently on
# conversations.history and conversations.replies calls, especially for
# bot-heavy channels with thousands of threads. Default retry budgets (3
# for tier_3/tier_4) exhaust quickly in those channels, causing slackdump
# to exit with code 6 (application error) mid-dump.
#
# Bumping tier_3 and tier_4 retries 3 -> 20 aligns them with tier_2's
# rate-limit retries. Same exponential backoff applies, so worst-case
# time-per-channel grows but most retries resolve within a few attempts.

workers = 4
download_retries = 5

[tier_2]
  boost = 20
  burst = 3
  retries = 20

[tier_3]
  boost = 60
  burst = 5
  retries = 20

[tier_4]
  boost = 10
  burst = 7
  retries = 20

[per_request]
  conversations = 100
  channels = 100
  replies = 200
`;

/**
 * True when `path` already holds exactly the embedded config. Reads at most one
 * byte more than the embedded text, so a larger file is rejected without being
 * loaded.
 */
async function holdsEmbeddedConfig(path: string): Promise<boolean> {
	const expected = Buffer.from(SLACKDUMP_API_CONFIG_TOML, "utf8");
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, "r");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return false;
		}
		throw error;
	}
	try {
		const buffer = Buffer.alloc(expected.length + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return (
			bytesRead === expected.length &&
			buffer.subarray(0, bytesRead).equals(expected)
		);
	} finally {
		await handle.close();
	}
}

export async function materializeSlackdumpApiConfig(
	dir: string,
): Promise<string> {
	const path = resolve(dir, SLACKDUMP_API_CONFIG_FILENAME);
	await mkdir(resolve(dir), { recursive: true });
	if (await holdsEmbeddedConfig(path)) {
		return path;
	}

	// Exclusive creation and same-directory rename keep concurrent readers safe.
	const tempPath = `${path}.${process.pid}.${process.hrtime.bigint()}.tmp`;
	const temp = await open(tempPath, "wx", 0o600);
	try {
		try {
			await temp.writeFile(SLACKDUMP_API_CONFIG_TOML, "utf8");
		} finally {
			await temp.close();
		}
		await rename(tempPath, path);
	} finally {
		await rm(tempPath, { force: true });
	}
	return path;
}
