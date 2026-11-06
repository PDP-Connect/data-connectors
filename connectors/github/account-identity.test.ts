// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub reports its numeric user id (`/user` `id`) as the account id. The
 * recorded `/user` body is the committed pilot fixture (id 424242, a
 * synthetic value). The run is a real connector subprocess with `fetch`
 * answered from that file.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertAccountIdentity,
	repoPath,
	runAndReadWire,
	stubFetchEnv,
} from "../../packages/polyfill-connectors/src/account-identity-test-support.ts";
import {
	connectorEntrypoint,
	packageRoot,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";

const USER_BODY = repoPath(
	"connectors",
	"github",
	"fixtures",
	"scrubbed",
	"pilot-real-shape",
	"api",
	"user.json",
);

function run(streams: string[]) {
	return runAndReadWire({
		cwd: packageRoot,
		entrypoint: connectorEntrypoint("github"),
		env: {
			GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-token",
			...stubFetchEnv([
				{ prefix: "https://api.github.com/user", bodyFile: USER_BODY },
				{ prefix: "https://api.github.com/gists", status: 200 },
			]),
		},
		start: {
			type: "START",
			scope: { streams: streams.map((name) => ({ name })) },
		},
	});
}

test("a run that collects the user stream reports the numeric user id", async () => {
	assertAccountIdentity(await run(["user"]), "424242");
});

test("a run that does not collect a user stream still reports the id", async () => {
	assertAccountIdentity(await run(["gists"]), "424242");
});

test("the id comes before the first record", async () => {
	// The wire helper above also checks this; naming it here keeps the order
	// visible in the connector's own test, on a run that really emits a record.
	const wire = await run(["user"]);
	const identityAt = wire.findIndex((m) => m.type === "ACCOUNT_IDENTITY");
	const firstRecordAt = wire.findIndex((m) => m.type === "RECORD");
	assert.ok(firstRecordAt > 0, "the run emits a record");
	assert.ok(
		identityAt >= 0 && identityAt < firstRecordAt,
		"ACCOUNT_IDENTITY must come before the first RECORD",
	);
});

test("a run whose /user answer carries no id fails before it reads a stream", async () => {
	// `{}` from `/user`: a source that gives no usable id must fail the run
	// before any read, not leave the host to find the id missing at the end.
	const wire = await runAndReadWire({
		cwd: packageRoot,
		entrypoint: connectorEntrypoint("github"),
		env: {
			GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-token",
			...stubFetchEnv([{ prefix: "https://api.github.com/user" }]),
		},
		start: { type: "START", scope: { streams: [{ name: "user" }] } },
	});
	const done = wire.find((m) => m.type === "DONE");
	assert.equal(
		Reflect.get(Object(done), "status"),
		"failed",
		"a missing id fails the run",
	);
	assert.equal(
		Reflect.get(Object(done?.error), "code"),
		"account_identity_missing",
	);
	assert.deepEqual(
		wire.filter((m) => m.type === "RECORD"),
		[],
		"no record is emitted",
	);
	assert.equal(
		wire.some((m) => m.type === "STATE"),
		false,
		"no state is committed",
	);
});
