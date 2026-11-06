// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import {
	type AccountIdentityMessage,
	accountIdentityMessageSchema,
	accountIdFromSource,
	createAccountIdentityReporter,
	reportAccountIdentity,
	requireAccountIdentity,
} from "./account-identity.ts";
import {
	AccountIdentityScanner,
	type AccountIdentityUse,
	listConnectorSourceFiles,
} from "./account-identity-call-scan.ts";
import {
	assertAccountIdentity,
	captureAccountIdentity,
} from "./account-identity-test-support.ts";
import {
	packageRoot as PACKAGE_ROOT,
	repoRoot as REPO_ROOT,
} from "./connector-paths.ts";
import { isKnownMessageType } from "./scenario/wire-registry.ts";
import {
	noteRecordEmitted,
	runConnectorProtocolSubprocess,
} from "./test-harness.ts";

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
	const directEmits: string[] = [];
	const scanner = new AccountIdentityScanner(
		join(PACKAGE_ROOT, "tsconfig.json"),
	);
	try {
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
			const uses = listConnectorSourceFiles(join(root, name)).map((file) =>
				scanner.use(file),
			);
			if (uses.some((use) => use.reportCalls > 0)) {
				reporting.push(name);
			}
			if (uses.some((use) => use.wireTypeLiterals > 0)) {
				directEmits.push(name);
			}
		}
	} finally {
		scanner.close();
	}
	assert.deepEqual(declared, reporting);
	assert.deepEqual(
		directEmits,
		[],
		"a connector must report through reportAccountIdentity, not write the wire message itself",
	);
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

// ─── The call scan itself ───────────────────────────────────────────────

const ACCOUNT_IDENTITY_MODULE = join(
	PACKAGE_ROOT,
	"src",
	"account-identity.ts",
);

/**
 * Writes `files` (name → source, `MODULE` standing for the import path of the
 * real account-identity module as seen from that file) into a scratch
 * project, scans each, and returns the use per file.
 */
function scanScratch(
	files: Record<string, string>,
): Record<string, AccountIdentityUse> {
	const dir = mkdtempSync(join(tmpdir(), "account-identity-scan-"));
	try {
		for (const [name, source] of Object.entries(files)) {
			const path = join(dir, name);
			mkdirSync(dirname(path), { recursive: true });
			const importPath = relative(dirname(path), ACCOUNT_IDENTITY_MODULE);
			writeFileSync(path, source.replaceAll("MODULE", importPath));
		}
		const tsconfig = join(dir, "tsconfig.json");
		writeFileSync(
			tsconfig,
			JSON.stringify({
				compilerOptions: {
					allowImportingTsExtensions: true,
					module: "NodeNext",
					moduleResolution: "NodeNext",
					noEmit: true,
					skipLibCheck: true,
					target: "ES2023",
					types: [],
				},
				files: Object.keys(files),
			}),
		);
		const scanner = new AccountIdentityScanner(tsconfig);
		try {
			return Object.fromEntries(
				Object.keys(files).map((name) => [name, scanner.use(join(dir, name))]),
			);
		} finally {
			scanner.close();
		}
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

test("the call scan counts real calls and ignores comments, strings and look-alikes", () => {
	const use = scanScratch({
		"real.ts": `import { reportAccountIdentity } from "MODULE";
export const run = (id: string) => reportAccountIdentity(id);`,
		"spaced.ts": `import { reportAccountIdentity } from "MODULE";
export const run = (id: string) => reportAccountIdentity
	(id);`,
		"commented.ts": `import { reportAccountIdentity } from "MODULE";
// await reportAccountIdentity(id);
/* await reportAccountIdentity(id); */
export const text = "reportAccountIdentity(id)";
export const noop = reportAccountIdentity;`,
		"aliased.ts": `import { reportAccountIdentity as report } from "MODULE";
export const run = (id: string) => report(id);`,
		"required.ts": `import { requireAccountIdentity } from "MODULE";
export const run = (id: string) => requireAccountIdentity(id);`,
		"namespace.ts": `import * as identity from "MODULE";
export const run = (id: string) => identity.reportAccountIdentity(id);`,
		"other-module.ts": `import { reportAccountIdentity } from "./local.ts";
export const run = (id: string) => reportAccountIdentity(id);`,
		"local.ts": `export const reportAccountIdentity = (_id: string) => true;
export const run = (id: string) => reportAccountIdentity(id);`,
		"type-only.ts": `import type { AccountIdentityReporter } from "MODULE";
export type Reporter = AccountIdentityReporter;`,
		"nested/deep/module.ts": `import { reportAccountIdentity } from "MODULE";
export const run = (id: string) => reportAccountIdentity(id);`,
	});
	const calls = Object.fromEntries(
		Object.entries(use).map(([name, found]) => [name, found.reportCalls]),
	);
	assert.deepEqual(calls, {
		"real.ts": 1,
		"spaced.ts": 1,
		"commented.ts": 0,
		"aliased.ts": 1,
		"required.ts": 1,
		"namespace.ts": 1,
		"other-module.ts": 0,
		"local.ts": 0,
		"type-only.ts": 0,
		"nested/deep/module.ts": 1,
	});
});

test("the call scan finds a direct wire emit, not a comment about one", () => {
	const use = scanScratch({
		"emit.ts": `export const message = { type: "ACCOUNT_IDENTITY", account_id: "x" };`,
		"comment.ts": `// { type: "ACCOUNT_IDENTITY" }
export const none = 1;`,
	});
	assert.equal(use["emit.ts"]?.wireTypeLiterals, 1);
	assert.equal(use["comment.ts"]?.wireTypeLiterals, 0);
});

test("the call scan refuses a file that is not in its project", () => {
	const scanner = new AccountIdentityScanner(
		join(PACKAGE_ROOT, "tsconfig.json"),
	);
	try {
		assert.throws(
			() => scanner.use(join(REPO_ROOT, "docs", "not-a-source-file.ts")),
			/not part of the scanned project/u,
		);
	} finally {
		scanner.close();
	}
});

test("the source listing walks nested modules and skips tests and fixtures", () => {
	const dir = mkdtempSync(join(tmpdir(), "account-identity-list-"));
	try {
		for (const name of [
			"index.ts",
			"index.test.ts",
			"lib/deep/helper.ts",
			"lib/deep/helper.test.ts",
			"__fixtures__/runtime.ts",
			"fixtures/recorded.ts",
			"notes.md",
		]) {
			const path = join(dir, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "");
		}
		assert.deepEqual(
			listConnectorSourceFiles(dir).map((file) => relative(dir, file)),
			["index.ts", join("lib", "deep", "helper.ts")],
		);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("requireAccountIdentity reports a usable id and throws, naming no id, for an unusable one", async () => {
	const written: AccountIdentityMessage[] = [];
	const reporter = createAccountIdentityReporter((m) => {
		written.push(m);
		return Promise.resolve();
	});
	await assert.rejects(
		() => requireAccountIdentity(undefined, reporter),
		(err: unknown) =>
			Reflect.get(Object(err), "code") === "account_identity_missing",
	);
	await assert.rejects(
		() => requireAccountIdentity("has space", reporter),
		(err: unknown) =>
			Reflect.get(Object(err), "code") === "account_identity_missing",
	);
	assert.deepEqual(written, []);
	await requireAccountIdentity("u-1", reporter);
	await requireAccountIdentity("u-1", reporter);
	assert.deepEqual(written, [{ type: "ACCOUNT_IDENTITY", account_id: "u-1" }]);
	await assert.rejects(
		() => requireAccountIdentity("u-2", reporter),
		(err: unknown) =>
			Reflect.get(Object(err), "code") === "account_identity_conflict",
	);
});

test("the order checks catch a record that comes before the account id", async () => {
	assert.throws(
		() =>
			assertAccountIdentity(
				[
					{ type: "RECORD" },
					{ type: "ACCOUNT_IDENTITY", account_id: "u-1" },
					{ type: "DONE" },
				],
				"u-1",
			),
		/before the first RECORD/u,
	);
	assertAccountIdentity(
		[
			{ type: "ACCOUNT_IDENTITY", account_id: "u-1" },
			{ type: "RECORD" },
			{ type: "DONE" },
		],
		"u-1",
	);
	const late = captureAccountIdentity();
	try {
		noteRecordEmitted();
		await reportAccountIdentity("u-1");
		noteRecordEmitted();
	} finally {
		late.restore();
	}
	assert.equal(late.recordsBeforeIdentity, 1, "only the first record is early");
	const early = captureAccountIdentity();
	try {
		await reportAccountIdentity("u-1");
		noteRecordEmitted();
	} finally {
		early.restore();
	}
	assert.equal(early.recordsBeforeIdentity, 0);
});
