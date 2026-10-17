// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	materializeSlackdumpApiConfig,
	SLACKDUMP_API_CONFIG_TOML,
} from "./slackdump-api-config.ts";

test("embedded slackdump API config exactly matches the packaged TOML", async () => {
	const expected = await readFile(
		new URL(
			"../../packages/polyfill-connectors/config/slackdump-api-config.toml",
			import.meta.url,
		),
	);
	assert.equal(expected.byteLength, 867);
	assert.deepEqual(Buffer.from(SLACKDUMP_API_CONFIG_TOML), expected);
});

test("materialization creates a private file in the requested state directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "slack-api-config-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const dir = join(root, "nested", "state");
	const path = await materializeSlackdumpApiConfig(dir);
	assert.equal(path, resolve(dir, "slackdump-api-config.toml"));
	assert.equal(await readFile(path, "utf8"), SLACKDUMP_API_CONFIG_TOML);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("unchanged config is not rewritten", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "slack-api-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = await materializeSlackdumpApiConfig(dir);
	const oldTime = new Date("2000-01-01T00:00:00Z");
	await utimes(path, oldTime, oldTime);
	const before = await stat(path);
	assert.equal(await materializeSlackdumpApiConfig(dir), path);
	assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
});

test("changed config is atomically replaced with private embedded content", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "slack-api-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "slackdump-api-config.toml");
	await writeFile(path, "stale config", { mode: 0o644 });
	assert.equal(await materializeSlackdumpApiConfig(dir), path);
	assert.equal(await readFile(path, "utf8"), SLACKDUMP_API_CONFIG_TOML);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("a longer file that starts with the embedded config is replaced", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "slack-api-config-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "slackdump-api-config.toml");
	await writeFile(path, `${SLACKDUMP_API_CONFIG_TOML}# appended\n`);
	assert.equal(await materializeSlackdumpApiConfig(dir), path);
	assert.equal(await readFile(path, "utf8"), SLACKDUMP_API_CONFIG_TOML);
});

test("Slack entrypoint has no escaping module-relative URL asset reads", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /new\s+URL\s*\(\s*["'`]\.\.\//);
});
