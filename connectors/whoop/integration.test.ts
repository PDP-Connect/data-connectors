// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "patchright";
import type { Page } from "playwright";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectWhoop,
	ensureWhoopSession,
	makeWhoopPageFetch,
	parseFetchTextForTest,
	probeWhoopReadinessOnOwnerPage,
	probeWhoopReadinessPage,
	type WhoopFetch,
	whoopAllowsInteractiveAuthRepair,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { WhoopFetchResult } from "./types.ts";

const NOW = new Date("2026-08-13T00:00:00.000Z");

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(fixturesDir("whoop"), name), "utf8"),
	) as unknown;
}

function scriptedFetch(
	bootstrap: unknown,
	cycles: unknown,
): { calls: string[]; fetch: WhoopFetch } {
	const calls: string[] = [];
	let cycleCalls = 0;
	return {
		calls,
		fetch: (path) => {
			calls.push(path);
			if (path.startsWith("/users-service")) {
				return Promise.resolve({ status: 200, json: bootstrap });
			}
			cycleCalls += 1;
			return Promise.resolve({
				status: 200,
				json: cycleCalls === 1 ? cycles : [],
			});
		},
	};
}

test("collectWhoop emits six validated streams before post-record state", async () => {
	const bootstrap = await fixture("bootstrap.json");
	const cycles = await fixture("cycles.json");
	const source = scriptedFetch(bootstrap, cycles);
	const harness = makeRecordingEmit(validateRecord);

	await collectWhoop({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		fetchPath: source.fetch,
		now: NOW,
		requested: new Set([
			"profile",
			"body",
			"cycles",
			"recoveries",
			"sleeps",
			"workouts",
		]),
		state: {},
	});

	assert.deepEqual(
		new Set(harness.emitted.map((record) => record.stream)),
		new Set(["profile", "body", "cycles", "recoveries", "sleeps", "workouts"]),
	);
	assert.equal(
		harness.emitted.filter((record) => record.stream === "cycles").length,
		2,
	);
	assert.equal(
		harness.emitted.filter((record) => record.stream === "recoveries").length,
		1,
	);
	const lastRecord = harness.events.reduce(
		(last, event, index) => (event.kind === "record" ? index : last),
		-1,
	);
	const firstAggregateState = harness.events.findIndex(
		(event) =>
			event.kind === "message" &&
			event.message.type === "STATE" &&
			event.message.stream === "cycles",
	);
	assert.ok(firstAggregateState > lastRecord);
	assert.ok(source.calls.every((path) => !path.includes("accessToken")));
	assert.ok(
		source.calls
			.filter((path) => path.includes("cycles/details"))
			.every((path) => !path.includes("apiVersion")),
	);
});

test("collectWhoop filters unrequested streams and carries incremental overlap", async () => {
	const source = scriptedFetch(await fixture("bootstrap.json"), {
		records: await fixture("cycles.json"),
	});
	const harness = makeRecordingEmit(validateRecord);
	await collectWhoop({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		fetchPath: source.fetch,
		now: NOW,
		requested: new Set(["workouts"]),
		state: { workouts: { through: "2026-08-10T00:00:00.000Z" } },
	});
	assert.deepEqual(
		new Set(harness.emitted.map((record) => record.stream)),
		new Set(["workouts"]),
	);
	const cycleCall = source.calls.find((path) =>
		path.includes("cycles/details"),
	);
	assert.ok(
		cycleCall?.includes(encodeURIComponent("2026-08-03T00:00:00.000Z")),
	);
});

for (const [label, result, pattern] of [
	["401", { status: 401, json: null }, /owner_repair_required/u],
	["403", { status: 403, json: null }, /owner_repair_required/u],
	["429", { status: 429, json: null }, /rate_limited/u],
	["500", { status: 500, json: null }, /http_500/u],
	[
		"invalid JSON",
		{ status: 200, json: null, invalidJson: true },
		/invalid_json/u,
	],
] as const) {
	test(`collectWhoop fails closed on ${label} without state`, async () => {
		const harness = makeRecordingEmit(validateRecord);
		const fetchPath: WhoopFetch = () =>
			Promise.resolve(result satisfies WhoopFetchResult);
		await assert.rejects(
			collectWhoop({
				emit: harness.emit,
				emitRecord: harness.emitRecord,
				fetchPath,
				now: NOW,
				requested: new Set(["cycles"]),
				state: {},
			}),
			pattern,
		);
		assert.equal(
			harness.protocolMessages.some((message) => message.type === "STATE"),
			false,
		);
	});
}

test("collectWhoop rejects bootstrap and aggregate schema drift", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await assert.rejects(
		collectWhoop({
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			fetchPath: scriptedFetch({ account: {} }, []).fetch,
			now: NOW,
			requested: new Set(["cycles"]),
			state: {},
		}),
	);
	await assert.rejects(
		collectWhoop({
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			fetchPath: scriptedFetch(await fixture("bootstrap.json"), [
				{ cycle: { id: "drift" } },
			]).fetch,
			now: NOW,
			requested: new Set(["cycles"]),
			state: {},
		}),
	);
});

test("manual login re-probes source truth and unattended repair does not prompt", async () => {
	const bootstrap = await fixture("bootstrap.json");
	let fetchCount = 0;
	let manualCount = 0;
	const page = {
		goto: () => Promise.resolve(null),
	} as Pick<Page, "goto"> as Page;
	const fetchPath: WhoopFetch = () => {
		fetchCount += 1;
		return Promise.resolve(
			fetchCount === 1
				? { status: 401, json: null }
				: { status: 200, json: bootstrap },
		);
	};
	await ensureWhoopSession({
		fetchPath,
		interactive: true,
		manualLogin: () => {
			manualCount += 1;
			return Promise.resolve();
		},
		page,
		sendInteraction: () =>
			Promise.resolve({
				request_id: "fixture",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
	});
	assert.equal(fetchCount, 2);
	assert.equal(manualCount, 1);

	await assert.rejects(
		ensureWhoopSession({
			fetchPath: () => Promise.resolve({ status: 401, json: null }),
			interactive: false,
			manualLogin: () => {
				throw new Error("must not prompt");
			},
			page,
			sendInteraction: () =>
				Promise.resolve({
					request_id: "fixture",
					status: "success",
					type: "INTERACTION_RESPONSE",
				}),
		}),
		/unattended refresh cannot open interactive login/u,
	);
	assert.equal(
		whoopAllowsInteractiveAuthRepair({ PDPP_RUN_TRIGGER_KIND: "scheduled" }),
		false,
	);
});

test("WHOOP readiness probe treats unauthenticated responses as not ready only", async () => {
	let status = 401;
	const page = {
		goto: () => Promise.resolve(null),
		evaluate: () => Promise.resolve({ status, json: null }),
	} as unknown as Page;

	assert.equal(await probeWhoopReadinessPage(page), null);
	status = 403;
	assert.equal(await probeWhoopReadinessPage(page), null);
	status = 429;
	await assert.rejects(probeWhoopReadinessPage(page), /whoop_rate_limited/u);
});

test("WHOOP owner-page readiness waits for the app redirect without navigating", async () => {
	let currentUrl = "https://identity.whoop.com/login";
	let navigationCount = 0;
	let evaluateCount = 0;
	const bootstrap = await fixture("bootstrap.json");
	const page = {
		url: () => currentUrl,
		goto: () => {
			navigationCount += 1;
			return Promise.resolve(null);
		},
		evaluate: () => {
			evaluateCount += 1;
			return Promise.resolve({ status: 200, json: bootstrap });
		},
	} as unknown as Page;

	assert.equal(await probeWhoopReadinessOnOwnerPage(page), null);
	assert.equal(evaluateCount, 0);
	currentUrl = "https://app.whoop.com/";
	assert.ok(await probeWhoopReadinessOnOwnerPage(page));
	assert.equal(navigationCount, 0);
	assert.equal(evaluateCount, 1);
});

test("WHOOP owner-page readiness treats navigation races and status zero as not ready", async () => {
	let evaluate: () => Promise<unknown> = () =>
		Promise.reject(new Error("context destroyed"));
	const page = {
		url: () => "https://app.whoop.com/",
		evaluate: () => evaluate(),
	} as unknown as Page;
	assert.equal(await probeWhoopReadinessOnOwnerPage(page), null);
	evaluate = () => Promise.resolve({ status: 0, json: null });
	assert.equal(await probeWhoopReadinessOnOwnerPage(page), null);
});

test("WHOOP streamed sign-in keeps one Patchright tab through collection entry", async () => {
	const bootstrap = await fixture("bootstrap.json");
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		await context.route("https://app.whoop.com/**", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>WHOOP fixture</title>",
			}),
		);
		await context.route("https://api.prod.whoop.com/**", (route) => {
			const cors = {
				"access-control-allow-credentials": "true",
				"access-control-allow-headers": "accept, authorization",
				"access-control-allow-origin": "https://app.whoop.com",
			};
			if (route.request().method() === "OPTIONS") {
				return route.fulfill({ status: 204, headers: cors });
			}
			const hasSession =
				route.request().headers().authorization === "bearer fixture-token";
			return route.fulfill({
				status: hasSession ? 200 : 401,
				headers: cors,
				contentType: "application/json",
				body: JSON.stringify(hasSession ? bootstrap : {}),
			});
		});
		let openedPages = 0;
		context.on("page", () => {
			openedPages += 1;
		});
		const page = (await context.newPage()) as unknown as Page;
		openedPages = 0;
		const completions: string[] = [];
		await ensureWhoopSession({
			assist: async () => {
				await page.goto("https://app.whoop.com/login");
				await page.evaluate(() => {
					document.cookie = "whoop-auth-token=fixture-token; path=/";
				});
				await page.goto("https://app.whoop.com/");
				return "whoop_fixture_handoff";
			},
			completeAssistance: async (_id, status) => {
				completions.push(status);
			},
			fetchPath: makeWhoopPageFetch(page),
			interactive: true,
			page,
			sendInteraction: async () => {
				throw new Error("unexpected manual-action fallback");
			},
		});

		assert.deepEqual(completions, ["resolved"]);
		assert.equal(openedPages, 0);
		assert.equal(context.pages().length, 1);
		assert.equal(new URL(page.url()).origin, "https://app.whoop.com");
		await context.close();
	} finally {
		await browser.close();
	}
});

test("page fetch keeps Cognito token inside browser evaluation and wrong-origin storage fails typed", async () => {
	const page = {
		evaluate: async (
			fn: (args: { apiBase: string; requestPath: string }) => Promise<unknown>,
			args: unknown,
		) => {
			const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				get: () => {
					throw new Error("denied");
				},
			});
			try {
				return await fn(args as { apiBase: string; requestPath: string });
			} finally {
				if (prior) {
					Object.defineProperty(globalThis, "localStorage", prior);
				} else {
					Reflect.deleteProperty(globalThis, "localStorage");
				}
			}
		},
	} as Pick<Page, "evaluate"> as Page;
	assert.deepEqual(await makeWhoopPageFetch(page)("/probe"), {
		status: 401,
		json: null,
	});
	assert.deepEqual(parseFetchTextForTest(200, "not json"), {
		status: 200,
		json: null,
		invalidJson: true,
	});
});

test("page fetch uses the current WHOOP auth cookie without returning the token", async () => {
	let observedAuthorization: string | null = null;
	const page = {
		evaluate: async (
			fn: (args: { apiBase: string; requestPath: string }) => Promise<unknown>,
			args: unknown,
		) => {
			const priorDocument = Object.getOwnPropertyDescriptor(
				globalThis,
				"document",
			);
			const priorFetch = globalThis.fetch;
			const priorStorage = Object.getOwnPropertyDescriptor(
				globalThis,
				"localStorage",
			);
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: {
					cookie: "whoop-auth-user=fixture; whoop-auth-token=cookie-token",
				},
			});
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: {},
			});
			globalThis.fetch = (_input, init) => {
				observedAuthorization = new Headers(init?.headers).get("authorization");
				return Promise.resolve(
					new Response('{"account":"ok"}', { status: 200 }),
				);
			};
			try {
				return await fn(args as { apiBase: string; requestPath: string });
			} finally {
				globalThis.fetch = priorFetch;
				if (priorDocument) {
					Object.defineProperty(globalThis, "document", priorDocument);
				} else {
					Reflect.deleteProperty(globalThis, "document");
				}
				if (priorStorage) {
					Object.defineProperty(globalThis, "localStorage", priorStorage);
				} else {
					Reflect.deleteProperty(globalThis, "localStorage");
				}
			}
		},
	} as Pick<Page, "evaluate"> as Page;

	assert.deepEqual(await makeWhoopPageFetch(page)("/probe"), {
		status: 200,
		json: { account: "ok" },
	});
	assert.equal(observedAuthorization, "bearer cookie-token");
});

const OK_RESPONSE = () => new Response('{"account":"ok"}', { status: 200 });

/** A page fetch over this cookie string and localStorage: every Authorization it sends, in order, and `respond` answers each (200 ok by default). */
function pageFetchFor(
	cookie: string,
	storage: Record<string, string>,
	respond: (authorization: string | null) => Response = OK_RESPONSE,
): { authorizations: Array<string | null>; fetchPath: WhoopFetch } {
	const authorizations: Array<string | null> = [];
	const page = {
		evaluate: async (
			fn: (args: {
				apiBase: string;
				requestPath: string;
				preferredSource: number | null;
			}) => Promise<unknown>,
			args: unknown,
		) => {
			const priorDocument = Object.getOwnPropertyDescriptor(
				globalThis,
				"document",
			);
			const priorFetch = globalThis.fetch;
			const priorStorage = Object.getOwnPropertyDescriptor(
				globalThis,
				"localStorage",
			);
			const store = { ...storage };
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: { cookie },
			});
			// Object.keys(localStorage) lists the stored keys, as in a browser.
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: Object.assign(
					Object.create({
						getItem: (key: string) =>
							Object.hasOwn(store, key) ? store[key] : null,
					}),
					store,
				),
			});
			globalThis.fetch = (_input, init) => {
				const authorization = new Headers(init?.headers).get("authorization");
				authorizations.push(authorization);
				return Promise.resolve(respond(authorization));
			};
			try {
				return await fn(
					args as {
						apiBase: string;
						requestPath: string;
						preferredSource: number | null;
					},
				);
			} finally {
				globalThis.fetch = priorFetch;
				if (priorDocument) {
					Object.defineProperty(globalThis, "document", priorDocument);
				} else {
					Reflect.deleteProperty(globalThis, "document");
				}
				if (priorStorage) {
					Object.defineProperty(globalThis, "localStorage", priorStorage);
				} else {
					Reflect.deleteProperty(globalThis, "localStorage");
				}
			}
		},
	} as Pick<Page, "evaluate"> as Page;
	return { authorizations, fetchPath: makeWhoopPageFetch(page) };
}

/** One page fetch with this cookie string and localStorage: the Authorization it sent last (null: no request), all of them in order, and its result. */
async function authorizationFor(
	cookie: string,
	storage: Record<string, string>,
	respond?: (authorization: string | null) => Response,
): Promise<{
	authorization: string | null;
	authorizations: Array<string | null>;
	result: unknown;
}> {
	const { authorizations, fetchPath } = pageFetchFor(cookie, storage, respond);
	const result = await fetchPath("/probe");
	return {
		authorization: authorizations.at(-1) ?? null,
		authorizations,
		result,
	};
}

test("page fetch URL-decodes and unquotes the WHOOP auth cookie, as the web app reads it", async () => {
	for (const cookie of [
		`whoop-auth-token=${encodeURIComponent('"eyJ.cookie-token"')}`,
		`whoop-auth-token=${encodeURIComponent("eyJ.cookie-token")}`,
		"whoop-auth-token=eyJ.cookie-token",
	]) {
		const { authorization, result } = await authorizationFor(
			`whoop-auth-user=fixture; ${cookie}`,
			{},
		);
		assert.equal(authorization, "bearer eyJ.cookie-token", cookie);
		assert.ok(
			!JSON.stringify(result).includes("cookie-token"),
			`${cookie}: the token left the page`,
		);
	}
});

test("without the cookie, page fetch uses the web app's whoop.security.accessToken, JSON-quoted or bare", async () => {
	for (const stored of [
		JSON.stringify("eyJ.stored-token"),
		"eyJ.stored-token",
	]) {
		const { authorization } = await authorizationFor(
			"whoop-auth-user=fixture",
			{
				"whoop.security.accessToken": stored,
				"whoop.security.refreshToken": JSON.stringify("refresh-not-sent"),
			},
		);
		assert.equal(authorization, "bearer eyJ.stored-token", stored);
	}
});

test("the cookie wins over a stored token, and the old Cognito key is used only when neither is there", async () => {
	const cognito = "CognitoIdentityServiceProvider.client.user.accessToken";
	assert.equal(
		(
			await authorizationFor("whoop-auth-token=eyJ.cookie-token", {
				"whoop.security.accessToken": "eyJ.stale",
				[cognito]: "eyJ.cognito",
			})
		).authorization,
		"bearer eyJ.cookie-token",
	);
	assert.equal(
		(
			await authorizationFor("", {
				"whoop.security.accessToken": "eyJ.stored-token",
				[cognito]: "eyJ.cognito",
			})
		).authorization,
		"bearer eyJ.stored-token",
	);
	assert.equal(
		(await authorizationFor("", { [cognito]: "eyJ.cognito" })).authorization,
		"bearer eyJ.cognito",
	);
});

test("an empty or malformed token is no token: a 401 with no request", async () => {
	const cases: Array<[string, Record<string, string>]> = [
		["whoop-auth-token=", {}],
		[`whoop-auth-token=${encodeURIComponent('"unterminated')}`, {}],
		["", { "whoop.security.accessToken": '""' }],
		["", {}],
	];
	for (const [cookie, storage] of cases) {
		const { authorization, result } = await authorizationFor(cookie, storage);
		assert.equal(authorization, null, cookie);
		assert.deepEqual(result, { status: 401, json: null });
	}
});

test("a 401 on the cookie token is retried once with the stored token, which the next read then uses first", async () => {
	const { authorizations, fetchPath } = pageFetchFor(
		"whoop-auth-token=eyJ.cookie-token",
		{ "whoop.security.accessToken": JSON.stringify("eyJ.stored-token") },
		(authorization) =>
			authorization === "bearer eyJ.stored-token"
				? OK_RESPONSE()
				: new Response("{}", { status: 401 }),
	);
	assert.deepEqual(await fetchPath("/probe"), {
		status: 200,
		json: { account: "ok" },
	});
	assert.deepEqual(authorizations, [
		"bearer eyJ.cookie-token",
		"bearer eyJ.stored-token",
	]);
	// The same page fetch, next request: the store that answered goes first.
	assert.deepEqual(await fetchPath("/next"), {
		status: 200,
		json: { account: "ok" },
	});
	assert.deepEqual(authorizations.slice(2), ["bearer eyJ.stored-token"]);
});

test("a 401 is retried only with a second, different token, and only a 401", async () => {
	const refuse = () => new Response("{}", { status: 401 });
	const same = await authorizationFor(
		"whoop-auth-token=eyJ.one",
		{ "whoop.security.accessToken": "eyJ.one" },
		refuse,
	);
	assert.deepEqual(same.authorizations, ["bearer eyJ.one"]);
	assert.deepEqual(same.result, { status: 401, json: {} });
	const only = await authorizationFor("whoop-auth-token=eyJ.one", {}, refuse);
	assert.deepEqual(only.authorizations, ["bearer eyJ.one"]);
	const both = await authorizationFor(
		"whoop-auth-token=eyJ.one",
		{ "whoop.security.accessToken": "eyJ.two" },
		refuse,
	);
	assert.deepEqual(both.authorizations, ["bearer eyJ.one", "bearer eyJ.two"]);
	assert.deepEqual(both.result, { status: 401, json: {} });
	const server = await authorizationFor(
		"whoop-auth-token=eyJ.one",
		{ "whoop.security.accessToken": "eyJ.two" },
		() => new Response("{}", { status: 500 }),
	);
	assert.deepEqual(server.authorizations, ["bearer eyJ.one"]);
	assert.deepEqual(server.result, { status: 500, json: {} });
});
