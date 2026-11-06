// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	type AccountIdentityMessage,
	accountIdentityMessageSchema,
	accountIdFromSource,
	createAccountIdentityReporter,
	reportAccountIdentity,
} from "./account-identity.ts";
import {
	packageRoot as PACKAGE_ROOT,
	repoRoot as REPO_ROOT,
} from "./connector-paths.ts";
import { isKnownMessageType } from "./scenario/wire-registry.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

test("the runtime schema agrees with the JSON schema's shared corpus", () => {
	// schemas/account-identity.schema.test.mjs checks the JSON schema against
	// the same corpus, so the spec's machine-readable half and this projection
	// cannot drift apart.
	const corpus = JSON.parse(
		readFileSync(
			join(REPO_ROOT, "schemas", "fixtures", "account-identity-corpus.json"),
			"utf8",
		),
	) as { invalid: { message: unknown; rule: string }[]; valid: unknown[] };
	for (const message of corpus.valid) {
		assert.equal(
			accountIdentityMessageSchema.safeParse(message).success,
			true,
			JSON.stringify(message),
		);
	}
	for (const { message, rule } of corpus.invalid) {
		assert.equal(
			accountIdentityMessageSchema.safeParse(message).success,
			false,
			rule,
		);
	}
	const message = { type: "ACCOUNT_IDENTITY", account_id: "a".repeat(256) };
	assert.equal(accountIdentityMessageSchema.safeParse(message).success, true);
	assert.equal(
		accountIdentityMessageSchema.safeParse({
			...message,
			account_id: "a".repeat(257),
		}).success,
		false,
	);
});

test("accountIdFromSource passes strings through and writes integers as digits", () => {
	assert.equal(accountIdFromSource("user-abc"), "user-abc");
	assert.equal(accountIdFromSource(1_234_567), "1234567");
	assert.equal(accountIdFromSource(9_007_199_254_740_993n), "9007199254740993");
	for (const unusable of [
		"",
		" id",
		"a b",
		-1,
		1.5,
		Number.NaN,
		Number.MAX_SAFE_INTEGER + 2,
		null,
		undefined,
		{},
		[],
		true,
	]) {
		assert.equal(accountIdFromSource(unusable), undefined, String(unusable));
	}
});

test("the reporter writes the first id once and ignores the same id again", async () => {
	const written: AccountIdentityMessage[] = [];
	const report = createAccountIdentityReporter((message) => {
		written.push(message);
		return Promise.resolve();
	});
	await report("u-1");
	await report("u-1");
	assert.deepEqual(written, [{ type: "ACCOUNT_IDENTITY", account_id: "u-1" }]);
});

test("the reporter fails the run on a different second id or an invalid id, without echoing the id", async () => {
	const written: AccountIdentityMessage[] = [];
	const report = createAccountIdentityReporter((message) => {
		written.push(message);
		return Promise.resolve();
	});
	await assert.rejects(
		() => report("not valid"),
		(err: unknown) =>
			Reflect.get(Object(err), "code") === "account_identity_invalid" &&
			!String(err).includes("not valid"),
	);
	await report("u-1");
	await assert.rejects(
		() => report("u-2"),
		(err: unknown) =>
			Reflect.get(Object(err), "code") === "account_identity_conflict" &&
			!String(err).includes("u-2"),
	);
	assert.equal(written.length, 1);
});

test("replay and recording accept ACCOUNT_IDENTITY as a known message type", () => {
	assert.equal(isKnownMessageType("ACCOUNT_IDENTITY"), true);
	assert.equal(isKnownMessageType("ACCOUNT_IDENTITIES"), false);
});

const FIXTURE = "src/test-fixtures/account-identity-fixture.ts";
const startMessage = () => ({
	type: "START" as const,
	scope: { streams: [{ name: "items" }] },
});

function wireLines(rawStdout: string): Record<string, unknown>[] {
	return rawStdout
		.split("\n")
		.filter((line) => line.trim())
		.map((line): Record<string, unknown> => JSON.parse(line));
}

test("through the real runtime, a connector that learns the id after a record sends one message before DONE", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		start: startMessage(),
	});
	const types = wireLines(result.rawStdout).map((line) => line.type);
	assert.deepEqual(
		types.filter((t) => t === "RECORD" || t === "ACCOUNT_IDENTITY"),
		["RECORD", "ACCOUNT_IDENTITY"],
	);
	assert.equal(types.at(-1), "DONE");
	const identity = wireLines(result.rawStdout).filter(
		(line) => line.type === "ACCOUNT_IDENTITY",
	);
	assert.deepEqual(identity, [
		{ type: "ACCOUNT_IDENTITY", account_id: "synthetic-user-0001" },
	]);
});

test("through the real runtime, reporting the same id twice still sends one message", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		env: { FIXTURE_MODE: "twice_same" },
		start: startMessage(),
	});
	assert.equal(
		wireLines(result.rawStdout).filter((l) => l.type === "ACCOUNT_IDENTITY")
			.length,
		1,
	);
});

test("through the real runtime, a different second id fails the run", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		env: { FIXTURE_MODE: "twice_different" },
		start: startMessage(),
	});
	const done = result.messages.findLast((m) => m.type === "DONE");
	assert.equal(Reflect.get(Object(done), "status"), "failed");
	assert.equal(
		Reflect.get(Object(done?.error), "code"),
		"account_identity_conflict",
	);
});

test("through the real runtime, an unusable id sends nothing, so the host can fail the run", async () => {
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		env: { FIXTURE_MODE: "invalid" },
		start: startMessage(),
	});
	assert.equal(
		wireLines(result.rawStdout).some((l) => l.type === "ACCOUNT_IDENTITY"),
		false,
	);
});

test("reportAccountIdentity sends a usable id and reports false for an unusable one", async () => {
	const written: AccountIdentityMessage[] = [];
	const reporter = createAccountIdentityReporter((m) => {
		written.push(m);
		return Promise.resolve();
	});
	assert.equal(await reportAccountIdentity(undefined, reporter), false);
	assert.equal(await reportAccountIdentity("", reporter), false);
	assert.equal(await reportAccountIdentity(-1, reporter), false);
	assert.deepEqual(written, []);
	assert.equal(await reportAccountIdentity(424_242, reporter), true);
	assert.equal(await reportAccountIdentity("424242", reporter), true);
	assert.deepEqual(written, [
		{ type: "ACCOUNT_IDENTITY", account_id: "424242" },
	]);
});

test("a connector declares account_identity if and only if its source reports one, and the inventory agrees", () => {
	const root = join(REPO_ROOT, "connectors");
	const declared: string[] = [];
	const reporting: string[] = [];
	for (const name of readdirSync(root).sort()) {
		const manifestPath = join(root, name, "manifest.json");
		if (!existsSync(manifestPath)) {
			continue;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			account_identity?: string;
		};
		if (manifest.account_identity === "required") {
			declared.push(name);
		}
		const calls = readdirSync(join(root, name))
			.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
			.some((file) =>
				/\breportAccountIdentity\(/u.test(
					readFileSync(join(root, name, file), "utf8"),
				),
			);
		if (calls) {
			reporting.push(name);
		}
	}
	assert.deepEqual(declared, reporting);
	assert.ok(declared.length > 0);
	const inventory = readFileSync(
		join(REPO_ROOT, "docs", "account-identity-inventory.md"),
		"utf8",
	);
	const implemented = [
		...inventory.matchAll(/^\| `([a-z_0-9]+)` \|[^\n]*\| Implemented;/gmu),
	]
		.map((match) => match[1])
		.sort();
	assert.deepEqual(implemented, declared);
});
