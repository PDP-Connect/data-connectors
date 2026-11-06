// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub reports its numeric user id (`/user` `id`) as the account id. The
 * recorded `/user` body is the committed pilot fixture (id 424242, a
 * synthetic value). The run is a real connector subprocess with `fetch`
 * answered from that file.
 */

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
