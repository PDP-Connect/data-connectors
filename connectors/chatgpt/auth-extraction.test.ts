// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The browser-side auth extraction runs the connector's real expression against
 * synthetic page sources. A token is only worth returning with the user id that
 * sits in the same session object: the id names the account the token reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { CHATGPT_AUTH_EXTRACTION_EXPRESSION } from "./index.ts";

interface Sources {
	bootstrap?: unknown;
	endpoint?: unknown;
	nextData?: unknown;
}

interface Extracted {
	accessToken: string | null;
	deviceId: string | null;
	userId: string | null;
}

async function extract(sources: Sources): Promise<Extracted> {
	const element = (body: unknown) =>
		body === undefined ? null : { textContent: JSON.stringify(body) };
	const elements: Record<string, { textContent: string } | null> = {
		"client-bootstrap": element(sources.bootstrap),
		__NEXT_DATA__: element(
			sources.nextData === undefined
				? undefined
				: { props: { pageProps: { session: sources.nextData } } },
		),
	};
	return (await runInNewContext(CHATGPT_AUTH_EXTRACTION_EXPRESSION, {
		decodeURIComponent,
		document: {
			cookie: "oai-did=synthetic-device",
			getElementById: (id: string) => elements[id] ?? null,
		},
		fetch: () =>
			sources.endpoint === undefined
				? Promise.resolve({ ok: false })
				: Promise.resolve({
						json: () => Promise.resolve(sources.endpoint),
						ok: true,
					}),
	})) as Extracted;
}

const WITH_ID = (token: string, id: string) => ({
	accessToken: token,
	user: { id },
});
const TOKEN_ONLY = (token: string) => ({ accessToken: token });

for (const source of ["endpoint", "bootstrap", "nextData"] as const) {
	test(`${source}: a session with a token and a user id returns both`, async () => {
		const got = await extract({ [source]: WITH_ID("token-a", "user-a") });
		assert.equal(got.accessToken, "token-a");
		assert.equal(got.userId, "user-a");
	});

	test(`${source}: a token-only session returns no user id`, async () => {
		const got = await extract({ [source]: TOKEN_ONLY("token-a") });
		assert.equal(got.accessToken, "token-a");
		assert.equal(got.userId, null);
	});

	test(`${source}: an id with no token is not a session`, async () => {
		const got = await extract({ [source]: { user: { id: "user-a" } } });
		assert.equal(got.accessToken, null);
		assert.equal(got.userId, null);
	});
}

test("a token-only session response and a bootstrap with the same token and an id find the id", async () => {
	const got = await extract({
		bootstrap: WITH_ID("token-a", "user-a"),
		endpoint: TOKEN_ONLY("token-a"),
	});
	assert.equal(got.accessToken, "token-a");
	assert.equal(got.userId, "user-a");
});

test("a token-only session response and Next data with an id find the id", async () => {
	const got = await extract({
		endpoint: TOKEN_ONLY("token-a"),
		nextData: WITH_ID("token-a", "user-a"),
	});
	assert.equal(got.accessToken, "token-a");
	assert.equal(got.userId, "user-a");
});

test("a token is never paired with the id of another session", async () => {
	// The endpoint token has no id. The bootstrap holds a different complete
	// session. The result is that complete session, token and id together.
	const got = await extract({
		bootstrap: WITH_ID("token-b", "user-b"),
		endpoint: TOKEN_ONLY("token-a"),
	});
	assert.deepEqual(
		{ accessToken: got.accessToken, userId: got.userId },
		{ accessToken: "token-b", userId: "user-b" },
	);
});

test("the first complete session wins over later complete sessions", async () => {
	const got = await extract({
		bootstrap: WITH_ID("token-b", "user-b"),
		endpoint: WITH_ID("token-a", "user-a"),
	});
	assert.deepEqual(
		{ accessToken: got.accessToken, userId: got.userId },
		{ accessToken: "token-a", userId: "user-a" },
	);
});

test("no source with a token returns no token and no id", async () => {
	const got = await extract({});
	assert.equal(got.accessToken, null);
	assert.equal(got.userId, null);
});
