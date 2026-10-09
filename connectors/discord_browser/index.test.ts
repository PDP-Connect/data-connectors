// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
	assertUserFacingProgress,
	DIAGNOSTIC_LINE_MAX_CHARS,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import {
	APP_URL,
	collectDiscordBrowser,
	type DiscordCollectContext,
	type DiscordCollectOptions,
	ensureDiscordSession,
	LOGIN_URL,
	MAX_MESSAGES_PER_RUN,
	MAX_SERVERS_PER_RUN,
	MESSAGE_WINDOW_DAYS,
	probeDiscordBrowserSession,
	REQUEST_PAUSE_MAX_MS,
	REQUEST_PAUSE_MIN_MS,
} from "./index.ts";
import { apiGetExpression, WATCH_EXPRESSION } from "./page-script.ts";
import { validateRecord } from "./schemas.ts";

const ORIGIN = "https://discord.com";
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-01T00:00:00Z");
/** Invented. The tests assert it never leaves the fake page. */
const TOKEN = "synthetic-session-token.unit-test.0123456789abcdef";
const SUPER_PROPERTIES = "c3ludGhldGljLXVuaXQtdGVzdC1zdXBlci1wcm9wZXJ0aWVz";
const OWNER = "552071489126400001";
const OTHER = "735204448665600002";
const SERVER_A = "797751587635200003";
const SERVER_B = "970693646745600004";
const SERVER_C = "1175889484185600005";
const ALL = ["profile", "servers", "connections", "messages"];
/** Discord's fixed results per search page. */
const SEARCH_PAGE = 25;

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	);
const USER = fixture("user-me.json");
const CONNECTIONS = fixture("connections.json");

const flake = (ms: number, sequence = 0): string =>
	String(((BigInt(ms) - 1_420_070_400_000n) << 22n) | BigInt(sequence));

interface RawMessage {
	author: { id: string };
	channel_id: string;
	content: string;
	hit: true;
	id: string;
	timestamp: string;
}

/** `count` messages, newest first, one minute apart, ending at `newestMs`. */
function messagesBy(
	author: string,
	count: number,
	newestMs = NOW - DAY_MS,
	stepMs = 60_000,
): RawMessage[] {
	return Array.from({ length: count }, (_, index) => {
		const ms = newestMs - index * stepMs;
		return {
			id: flake(ms, index % 4096),
			author: { id: author },
			channel_id: "797751839293440006",
			content: `Synthetic message ${index}`,
			hit: true,
			timestamp: new Date(ms).toISOString(),
		};
	});
}

interface Answer {
	body: unknown;
	status: number;
}
type Responder = (path: string, call: number) => Answer;
const ok = (body: unknown): Answer => ({ status: 200, body });

/** discord.com's API over a set of servers and their search listings. */
function discordApi(
	servers: Record<string, RawMessage[]>,
	override?: (path: string, call: number) => Answer | undefined,
): Responder {
	return (path, call) => {
		const custom = override?.(path, call);
		if (custom) return custom;
		if (path === "/users/@me") return ok(USER);
		if (path === "/users/@me/guilds") {
			return ok(
				Object.keys(servers).map((id) => ({ id, name: `Synthetic ${id}` })),
			);
		}
		if (path === "/users/@me/connections") return ok(CONNECTIONS);
		const url = new URL(path, ORIGIN);
		const match = /^\/guilds\/(\d+)\/messages\/search$/.exec(url.pathname);
		if (match?.[1]) {
			assert.equal(url.searchParams.get("author_id"), OWNER);
			assert.equal(url.searchParams.get("sort_by"), "timestamp");
			assert.equal(url.searchParams.get("sort_order"), "desc");
			const all = servers[match[1]] ?? [];
			const offset = Number(url.searchParams.get("offset"));
			return ok({
				total_results: all.length,
				messages: all.slice(offset, offset + 25).map((message) => [message]),
			});
		}
		return { status: 404, body: { message: "404: Not Found", code: 0 } };
	};
}

interface ApiCall {
	credentials: string;
	headers: Record<string, string>;
	method: string;
	path: string;
	version: string;
}

interface FakeOptions {
	/** The API version in the client's own request path. */
	apiVersion?: string;
	/** When the stand-in client sends its own authorized request. */
	clientRequestAt?: "nudge" | "watch";
	respond?: Responder;
	signedIn?: () => boolean;
	startUrl?: string;
	/** How the stand-in client sends its own request, or "none": it stays idle. */
	transport?: "fetch" | "none" | "xhr";
}

/**
 * A stand-in discord.com page. The page expressions run unchanged in a
 * separate JavaScript realm that has its own XMLHttpRequest and fetch, and a
 * client that sends an authorized request only when the owner moves around
 * the app. `returned` holds every value an evaluation handed back.
 */
function fakeDiscord(options: FakeOptions = {}) {
	const signedIn = options.signedIn ?? (() => true);
	const respond = options.respond ?? discordApi({});
	const version = options.apiVersion ?? "v9";
	const calls: ApiCall[] = [];
	const visits: string[] = [];
	const returned: string[] = [];
	let clientRequests = 0;
	let watchClientRequestSent = false;
	let context: vm.Context;

	const hostFetch = async (
		input: unknown,
		init?: { credentials?: string; headers?: unknown; method?: string },
	): Promise<Response> => {
		const url = new URL(String(input), ORIGIN);
		// The stand-in client's own requests.
		if (/\/(collectibles-categories|experiments)$/.test(url.pathname)) {
			clientRequests += 1;
			return new Response("[]");
		}
		const match = /^\/api\/(v\d+)(\/.*)$/.exec(url.pathname);
		assert.ok(match, `not an API path: ${url.pathname}`);
		const headers: Record<string, string> = {};
		for (const [name, value] of (init?.headers ?? []) as [string, string][]) {
			headers[name] = value;
		}
		calls.push({
			path: `${match[2]}${url.search}`,
			version: String(match[1]),
			headers,
			method: init?.method ?? "GET",
			credentials: init?.credentials ?? "",
		});
		const answer = respond(`${match[2]}${url.search}`, calls.length);
		return new Response(
			typeof answer.body === "string"
				? answer.body
				: JSON.stringify(answer.body),
			{ status: answer.status },
		);
	};

	const load = (target: string): void => {
		const url = new URL(target);
		// Signed out, the app sends every page to the sign-in form.
		if (url.origin === ORIGIN && !signedIn()) url.pathname = "/login";
		const location = {
			origin: url.origin,
			pathname: url.pathname,
			get href() {
				return `${this.origin}${this.pathname}`;
			},
		};
		const onApp = () => location.origin === ORIGIN && signedIn();
		const link = (path: string) => ({
			click: () => {
				location.pathname = path;
				vm.runInContext("__clientRequest()", context);
			},
		});
		const document = {
			querySelector: (selector: string) => {
				if (!onApp()) return null;
				if (selector.includes('aria-label="User area"')) return {};
				if (selector === 'a[href="/shop"]') return link("/shop");
				if (selector === 'a[href="/channels/@me"]') {
					return link("/channels/@me");
				}
				return null;
			},
		};
		context = vm.createContext({
			AbortController,
			clearTimeout,
			dispatchEvent: () => true,
			document,
			fetch: hostFetch,
			Headers,
			history: {
				pushState: (_state: unknown, _title: string, path: string) => {
					location.pathname = path;
				},
			},
			location,
			Request,
			setTimeout,
			URL,
		});
		const headers = JSON.stringify({
			Authorization: TOKEN,
			"X-Super-Properties": SUPER_PROPERTIES,
			"X-Installation-ID": "synthetic-installation-id",
			"X-Discord-Locale": "en-US",
			"Content-Type": "application/json",
		});
		const own = `/api/${version}/collectibles-categories`;
		vm.runInContext(
			`
			globalThis.XMLHttpRequest = class { open() {} setRequestHeader() {} send() {} };
			globalThis.PopStateEvent = class {};
			globalThis.__nativeOpen = XMLHttpRequest.prototype.open;
			globalThis.__nativeFetch = fetch;
			globalThis.__clientRequest = () => {
				const transport = ${JSON.stringify(options.transport ?? "xhr")};
				if (transport === "none") return;
				if (transport === "fetch") {
					fetch("https://discord.com/api/${version}/experiments");
					fetch(${JSON.stringify(ORIGIN + own)}, { headers: ${headers} });
					return;
				}
				// A request with no Authorization comes first and must be ignored.
				const anonymous = new XMLHttpRequest();
				anonymous.open("GET", "/api/${version}/experiments");
				anonymous.setRequestHeader("X-Super-Properties", "anonymous");
				anonymous.send();
				const request = new XMLHttpRequest();
				request.open("GET", ${JSON.stringify(own)});
				for (const [name, value] of Object.entries(${headers}))
					request.setRequestHeader(name, value);
				request.send();
			};`,
			context,
		);
	};

	const page = {
		goto: async (url: string) => {
			visits.push(url);
			load(url);
			return null;
		},
		evaluate: async (
			expression: unknown,
			_arg: unknown,
			_options: unknown,
			isolatedContext: unknown,
		) => {
			assert.equal(typeof expression, "string");
			assert.equal(isolatedContext, false, "evaluate in the page's own world");
			const value = await vm.runInContext(String(expression), context);
			// The client can send its own request as soon as the watch installed
			// its hooks, with no navigation from the connector.
			if (
				options.clientRequestAt === "watch" &&
				!watchClientRequestSent &&
				String(expression) === WATCH_EXPRESSION
			) {
				watchClientRequestSent = true;
				vm.runInContext("__clientRequest()", context);
			}
			// A result crosses to the host as JSON, as on PageShim.
			const text = JSON.stringify(value) ?? "null";
			returned.push(text);
			return JSON.parse(text);
		},
	} as unknown as DiscordCollectContext["page"];

	load(options.startUrl ?? "about:blank");
	return {
		page,
		calls,
		visits,
		returned,
		clientRequests: () => clientRequests,
		/** A navigation the owner or the site makes, not the connector. */
		ownerOpens: load,
		inPage: (expression: string): unknown =>
			vm.runInContext(expression, context),
	};
}

function harness(
	fake: ReturnType<typeof fakeDiscord>,
	names: string[] = ALL,
	state: Record<string, unknown> = {},
	extra: {
		collectionMode?: "full_refresh" | "incremental";
		timeRange?: { since?: string; until?: string };
	} = {},
) {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const ctx: DiscordCollectContext = {
		collectionMode: extra.collectionMode,
		page: fake.page,
		state,
		requested: new Map(
			names.map((name) => [
				name,
				{
					name,
					...(extra.timeRange && name === "messages"
						? { time_range: extra.timeRange }
						: {}),
				} as StreamScope,
			]),
		),
		emit: async (message: EmittedMessage) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const parsed = validateRecord(stream, data);
			assert.equal(parsed.ok, true, JSON.stringify(parsed));
			records.push({ stream, data });
		},
	};
	const of = (stream: string) =>
		records.filter((r) => r.stream === stream).map((r) => r.data);
	const cursor = (stream: string) =>
		(
			messages.find((m) => m.type === "STATE" && m.stream === stream) as
				| { cursor: unknown }
				| undefined
		)?.cursor;
	const skips = () =>
		messages.filter((m) => m.type === "SKIP_RESULT") as Array<{
			message: string;
			reason: string;
			recovery_hint?: unknown;
			stream: string;
		}>;
	return { ctx, messages, records, of, cursor, skips };
}

/** Collection with no real waiting; `pauses` receives every delay asked for. */
function fast(
	pauses: number[] = [],
	extra: DiscordCollectOptions = {},
): DiscordCollectOptions {
	return {
		delay: async (ms) => {
			pauses.push(ms);
		},
		now: () => NOW,
		random: () => 0.5,
		...extra,
	};
}

/** The pauses between API requests, apart from the half-second page polls. */
const requestPauses = (pauses: number[]) =>
	pauses.filter((ms) => ms >= REQUEST_PAUSE_MIN_MS);

async function captureDiagnostics(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		await fn();
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	return lines;
}

const searches = (fake: ReturnType<typeof fakeDiscord>) =>
	fake.calls.filter((call) => call.path.includes("/messages/search"));

test("the probe reads the page and nothing else", async () => {
	const signedIn = fakeDiscord({ startUrl: APP_URL });
	assert.equal(await probeDiscordBrowserSession(signedIn.page), true);
	assert.deepEqual(signedIn.visits, []);
	assert.deepEqual(signedIn.calls, []);
	// It leaves the page's own request functions alone.
	assert.equal(
		signedIn.inPage("XMLHttpRequest.prototype.open === __nativeOpen"),
		true,
	);
	assert.equal(signedIn.inPage("fetch === __nativeFetch"), true);

	const signedOut = fakeDiscord({ startUrl: APP_URL, signedIn: () => false });
	assert.equal(await probeDiscordBrowserSession(signedOut.page), false);
	const elsewhere = fakeDiscord({ startUrl: "https://example.com/" });
	assert.equal(await probeDiscordBrowserSession(elsewhere.page), false);
	assert.equal(await probeDiscordBrowserSession(fakeDiscord().page), false);
});

test("a live session needs no sign-in", async () => {
	const fake = fakeDiscord({ startUrl: APP_URL });
	await ensureDiscordSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: fake.page,
			assist: async () => {
				throw new Error("unexpected assistance");
			},
		}),
	);
	assert.deepEqual(fake.visits, []);
});

test("without a session, the owner signs in on the login page", async () => {
	let signedIn = false;
	const fake = fakeDiscord({ signedIn: () => signedIn });
	const statuses: string[] = [];
	await ensureDiscordSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: fake.page,
			assist: async () => {
				// The owner signs in, and Discord moves them into the app.
				signedIn = true;
				fake.ownerOpens(APP_URL);
				return "assist-1";
			},
			completeAssistance: async (_id: string, status: string) => {
				statuses.push(status);
			},
		}),
	);
	// The check opens the app and the handoff opens the sign-in page. After
	// that the connector only watches: it never navigates or fills a form.
	assert.deepEqual(fake.visits, [APP_URL, LOGIN_URL]);
	assert.deepEqual(statuses, ["resolved"]);
	assert.deepEqual(fake.calls, []);
});

test("a run reads the four streams with the client's own headers", async () => {
	const fake = fakeDiscord({
		apiVersion: "v10",
		respond: discordApi({
			[SERVER_A]: [
				...messagesBy(OWNER, 2),
				...messagesBy(OTHER, 1, NOW - 2 * DAY_MS),
			],
			[SERVER_B]: [],
		}),
	});
	const h = harness(fake);
	const pauses: number[] = [];
	await collectDiscordBrowser(h.ctx, fast(pauses));

	assert.deepEqual(fake.visits, [APP_URL]);
	assert.deepEqual(
		fake.calls.map((call) => call.path),
		[
			"/users/@me",
			"/users/@me/guilds",
			"/users/@me/connections",
			`/guilds/${SERVER_A}/messages/search?author_id=${OWNER}&sort_by=timestamp&sort_order=desc&offset=0`,
			`/guilds/${SERVER_B}/messages/search?author_id=${OWNER}&sort_by=timestamp&sort_order=desc&offset=0`,
		],
	);
	for (const call of fake.calls) {
		// The version comes from the client's own request path.
		assert.equal(call.version, "v10");
		assert.equal(call.method, "GET");
		assert.equal(call.credentials, "include");
		assert.deepEqual(call.headers, {
			authorization: TOKEN,
			"x-super-properties": SUPER_PROPERTIES,
			"x-installation-id": "synthetic-installation-id",
			"x-discord-locale": "en-US",
		});
	}
	// One request at a time, each after a 3-5 s pause.
	assert.equal(requestPauses(pauses).length, fake.calls.length - 1);
	for (const pause of requestPauses(pauses)) {
		assert.ok(pause >= REQUEST_PAUSE_MIN_MS && pause <= REQUEST_PAUSE_MAX_MS);
	}

	assert.equal(h.of("profile").length, 1);
	assert.equal(h.of("profile")[0]?.id, OWNER);
	assert.deepEqual(
		h.of("servers").map((record) => record.id),
		[SERVER_A, SERVER_B],
	);
	assert.equal(h.of("connections").length, 2);
	// The other author's hit is not kept.
	assert.equal(h.of("messages").length, 2);
	assert.ok(h.of("messages").every((record) => record.server_id === SERVER_A));
	// The search answer does not name the server; the record does.
	assert.equal(h.of("messages")[0]?.server_name, `Synthetic ${SERVER_A}`);
	assert.deepEqual(h.skips(), []);
	assert.deepEqual(h.cursor("messages"), {
		queue: [SERVER_A, SERVER_B],
		servers: {
			[SERVER_A]: {
				newest_id: h.of("messages")[0]?.id,
				floor_ms: NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
				until_ms: null,
			},
			[SERVER_B]: {
				newest_id: null,
				floor_ms: NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
				until_ms: null,
			},
		},
	});
	assertUserFacingProgress(h.messages);
});

test("the client's headers never leave the page", async () => {
	const echo = `{"id":"${OWNER}","username":"sample.user","bio":"${TOKEN}","token":"${TOKEN}"}`;
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 3) }, (path) =>
			path === "/users/@me" ? { status: 200, body: echo } : undefined,
		),
	});
	const h = harness(fake);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	assert.equal(h.of("messages").length, 3);
	const outside = JSON.stringify([
		fake.returned,
		h.messages,
		h.records,
		lines,
		h.ctx.state,
	]);
	for (const secret of [TOKEN, SUPER_PROPERTIES]) {
		assert.equal(outside.includes(secret), false);
	}
	// A response that repeats the token is redacted before it is returned.
	assert.equal(h.of("profile")[0]?.bio, "[redacted]");
	// A linked account's access token is dropped in the page.
	assert.equal(outside.includes("synthetic-third-party-token"), false);
	assert.equal(outside.includes("access_token"), false);
	// Once a request was seen, the page has its own functions back.
	assert.equal(
		fake.inPage("XMLHttpRequest.prototype.open === __nativeOpen"),
		true,
	);
	assert.equal(fake.inPage("fetch === __nativeFetch"), true);
});

test("an escaped token is redacted once the JSON is decoded", async () => {
	const escaped = TOKEN.replaceAll(".", "\\u002e");
	// The credential is JSON-escaped in the raw body, so it only appears
	// after decoding; a check on the undecoded text would let it cross.
	const echo = `{"id":"${OWNER}","username":"sample.user","bio":"${escaped}","${escaped}":"x"}`;
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 1) }, (path) =>
			path === "/users/@me" ? { status: 200, body: echo } : undefined,
		),
	});
	const h = harness(fake);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	const outside = JSON.stringify([
		fake.returned,
		h.messages,
		h.records,
		lines,
		h.ctx.state,
	]);
	assert.equal(outside.includes(TOKEN), false);
	assert.equal(h.of("profile")[0]?.bio, "[redacted]");
});

test("a client that uses fetch is read the same way", async () => {
	const fake = fakeDiscord({
		transport: "fetch",
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 1) }),
	});
	const h = harness(fake);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	assert.equal(h.of("messages").length, 1);
	assert.equal(fake.calls[0]?.headers.authorization, TOKEN);
	// Two client requests on the way to Shop, two on the way back to Friends.
	assert.equal(fake.clientRequests(), 4);
	assert.equal(fake.inPage("location.pathname"), "/channels/@me");
	assert.ok(lines.some((line) => line.includes('"ct":"fetch"')));
	// The one coverage line fits the phone host's budget with every field.
	const coverage = lines.find((line) =>
		line.startsWith("[discord_browser-diagnostic] coverage "),
	);
	assert.ok(coverage);
	assert.ok(
		coverage.length <= DIAGNOSTIC_LINE_MAX_CHARS,
		`${coverage.length} chars: ${coverage}`,
	);
});

test("an idle client is captured after the nudge, and reported", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 1) }),
	});
	const h = harness(fake, ["messages"]);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	const line = lines.find((entry) => entry.includes("header_capture"));
	assert.ok(line);
	// Six polls before the nudge, then one more for the captured headers.
	assert.ok(line.includes('"n":"nudged"'), line);
	assert.ok(line.includes('"v":9'), line);
	assert.ok(line.includes('"ct":"xhr"'), line);
	assert.ok(line.includes('"ms":3500'), line);
	assert.ok(line.length <= DIAGNOSTIC_LINE_MAX_CHARS, String(line.length));
	// The line names no header or value.
	for (const secret of [TOKEN, SUPER_PROPERTIES, "authorization"])
		assert.equal(line.includes(secret), false);
});

test("a client request sent while watching is captured passively, and reported", async () => {
	const fake = fakeDiscord({
		clientRequestAt: "watch",
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 1) }),
	});
	const h = harness(fake, ["messages"]);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	const line = lines.find((entry) => entry.includes("header_capture"));
	assert.ok(line);
	assert.ok(line.includes('"n":"passive"'), line);
	assert.ok(line.includes('"ms":500'), line);
	assert.equal(fake.inPage("location.pathname"), "/channels/@me");
});

test("an idle client ends the run with nothing read", async () => {
	const fake = fakeDiscord({ transport: "none" });
	const h = harness(fake);
	const pauses: number[] = [];
	await collectDiscordBrowser(h.ctx, fast(pauses));
	assert.deepEqual(fake.calls, []);
	assert.deepEqual(h.records, []);
	assert.deepEqual(
		h.skips().map((skip) => [skip.stream, skip.reason]),
		ALL.map((stream) => [stream, "discord_client_request_not_seen"]),
	);
	assert.equal(
		h.messages.some((m) => m.type === "STATE"),
		false,
	);
	// It waited its 30 s, in half-second steps, and no longer.
	assert.equal(
		pauses.filter((ms) => ms === 500).length <= 30 + 60,
		true,
		String(pauses.length),
	);
	assert.equal(requestPauses(pauses).length, 0);
});

test("the page reader refuses every other path", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: [] }),
	});
	await collectDiscordBrowser(harness(fake).ctx, fast());
	const before = fake.calls.length;
	for (const path of [
		"/users/@me/channels",
		"/users/@me/relationships",
		"/users/@me/settings",
		`/channels/${SERVER_A}/messages`,
		`/guilds/${SERVER_A}/messages/search?author_id=${OTHER}&content=x`,
		`/guilds/${SERVER_A}/members`,
		"/users/@me?x=1",
	]) {
		assert.deepEqual(
			await (fake.page.evaluate as never as (...a: unknown[]) => unknown)(
				apiGetExpression(path, 1000),
				undefined,
				undefined,
				false,
			),
			{ kind: "refused" },
			path,
		);
	}
	assert.equal(fake.calls.length, before);
});

test("a signed-out app ends the run before any request", async () => {
	const fake = fakeDiscord({ signedIn: () => false });
	const h = harness(fake);
	await collectDiscordBrowser(h.ctx, fast());
	assert.deepEqual(fake.calls, []);
	assert.deepEqual(
		h.skips().map((skip) => skip.reason),
		ALL.map(() => "discord_sign_in_required"),
	);
});

test("a 401 part way ends the run at once and keeps what was read", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 3) }, (path) =>
			path === "/users/@me/guilds"
				? { status: 401, body: fixture("unauthorized.json") }
				: undefined,
		),
	});
	const h = harness(fake);
	await collectDiscordBrowser(h.ctx, fast());
	assert.deepEqual(
		fake.calls.map((call) => call.path),
		["/users/@me", "/users/@me/guilds"],
	);
	assert.equal(h.of("profile").length, 1);
	assert.deepEqual(
		h.skips().map((skip) => [skip.stream, skip.reason]),
		["servers", "connections", "messages"].map((stream) => [
			stream,
			"discord_sign_in_required",
		]),
	);
	assert.ok(h.skips().every((skip) => skip.recovery_hint !== undefined));
});

test("a captcha or account check ends the run without a retry", async () => {
	for (const answer of [
		{ status: 400, body: fixture("captcha-required.json") },
		{ status: 403, body: { message: "Verify your account", code: 40_002 } },
		{ status: 403, body: fixture("missing-access.json") },
	]) {
		const fake = fakeDiscord({
			respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 3) }, (path) =>
				path === "/users/@me/connections" ? answer : undefined,
			),
		});
		const h = harness(fake);
		await collectDiscordBrowser(h.ctx, fast());
		assert.equal(fake.calls.at(-1)?.path, "/users/@me/connections");
		assert.equal(fake.calls.length, 3);
		assert.deepEqual(
			h.skips().map((skip) => [skip.stream, skip.reason]),
			[
				["connections", "discord_verification_required"],
				["messages", "discord_verification_required"],
			],
		);
	}
});

test("a captcha on a server search ends the run too", async () => {
	const fake = fakeDiscord({
		respond: discordApi(
			{ [SERVER_A]: messagesBy(OWNER, 3), [SERVER_B]: [] },
			(path) =>
				path.startsWith(`/guilds/${SERVER_A}/`)
					? { status: 403, body: fixture("captcha-required.json") }
					: undefined,
		),
	});
	const h = harness(fake);
	await collectDiscordBrowser(h.ctx, fast());
	assert.equal(searches(fake).length, 1);
	assert.deepEqual(
		h.skips().map((skip) => skip.reason),
		["discord_verification_required"],
	);
});

test("one short 429 is waited out once; a second ends the run", async () => {
	let limited = 0;
	const fake = fakeDiscord({
		respond: discordApi(
			{ [SERVER_A]: messagesBy(OWNER, 30), [SERVER_B]: messagesBy(OWNER, 2) },
			(path, call) => {
				// The connections request, then the second page of server A.
				if (
					(path === "/users/@me/connections" && call === 3) ||
					path.endsWith("offset=25")
				) {
					limited += 1;
					return { status: 429, body: fixture("rate-limited.json") };
				}
				return undefined;
			},
		),
	});
	const h = harness(fake);
	const pauses: number[] = [];
	await collectDiscordBrowser(h.ctx, fast(pauses));
	assert.equal(limited, 2);
	// The first 429 was retried after its 1.5 s on top of the usual pause.
	assert.equal(
		fake.calls.filter((call) => call.path === "/users/@me/connections").length,
		2,
	);
	assert.equal(pauses.filter((ms) => ms === 4000 + 1500).length, 1);
	assert.equal(h.of("connections").length, 2);
	// The second 429 ended the run: server B was never searched.
	assert.equal(fake.calls.at(-1)?.path.endsWith("offset=25"), true);
	assert.deepEqual(
		h.skips().map((skip) => [skip.stream, skip.reason]),
		[["messages", "discord_rate_limited"]],
	);
	// The first page is kept, but an interrupted walk writes no coverage: the
	// next run starts over from the newest message.
	assert.equal(h.of("messages").length, 25);
	const state = h.cursor("messages") as {
		queue: string[];
		servers: Record<string, unknown>;
	};
	assert.deepEqual(state.queue, [SERVER_A, SERVER_B]);
	assert.equal(state.servers[SERVER_A], undefined);
	assert.equal(state.servers[SERVER_B], undefined);
});

test("a long or account-wide 429 ends the run without a retry", async () => {
	for (const body of [
		{ message: "You are being rate limited.", retry_after: 60, global: false },
		{ message: "You are being rate limited.", retry_after: 1, global: true },
		"<html>rate limited</html>",
	]) {
		const fake = fakeDiscord({
			respond: discordApi({ [SERVER_A]: [] }, (path) =>
				path === "/users/@me" ? { status: 429, body } : undefined,
			),
		});
		const h = harness(fake);
		await collectDiscordBrowser(h.ctx, fast());
		assert.equal(fake.calls.length, 1);
		assert.deepEqual(
			h.skips().map((skip) => skip.reason),
			ALL.map(() => "discord_rate_limited"),
		);
	}
});

test("a search index that is not ready is waited for once, then skipped", async () => {
	const fake = fakeDiscord({
		respond: discordApi(
			{ [SERVER_A]: messagesBy(OWNER, 2), [SERVER_B]: messagesBy(OWNER, 2) },
			(path) =>
				path.startsWith(`/guilds/${SERVER_A}/`)
					? { status: 202, body: fixture("search-index-not-ready.json") }
					: undefined,
		),
	});
	const h = harness(fake);
	const pauses: number[] = [];
	await collectDiscordBrowser(h.ctx, fast(pauses));
	assert.deepEqual(
		searches(fake).map((call) => call.path.split("/")[2]),
		[SERVER_A, SERVER_A, SERVER_B],
	);
	assert.equal(pauses.filter((ms) => ms === 4000 + 2000).length, 1);
	assert.equal(h.of("messages").length, 2);
	assert.deepEqual(
		h.skips().map((skip) => [skip.stream, skip.reason]),
		[
			["messages", "discord_servers_skipped"],
			["messages", "discord_run_limit_reached"],
		],
	);
	// The skipped server has no coverage, so it still counts as waiting.
	assert.equal(
		(h.cursor("messages") as { servers: Record<string, unknown> }).servers[
			SERVER_A
		],
		undefined,
	);
	// The skipped server goes to the back of the queue with the others.
	assert.deepEqual((h.cursor("messages") as { queue: string[] }).queue, [
		SERVER_A,
		SERVER_B,
	]);
});

test("a server that refuses the search is skipped; three in a row end the run", async () => {
	const refuse = (ids: string[]) => (path: string) =>
		ids.some((id) => path.startsWith(`/guilds/${id}/`))
			? { status: 403, body: fixture("missing-access.json") }
			: undefined;
	const one = fakeDiscord({
		respond: discordApi(
			{ [SERVER_A]: messagesBy(OWNER, 1), [SERVER_B]: messagesBy(OWNER, 2) },
			refuse([SERVER_A]),
		),
	});
	const first = harness(one);
	await collectDiscordBrowser(first.ctx, fast());
	assert.equal(first.of("messages").length, 2);
	assert.deepEqual(
		first.skips().map((skip) => skip.reason),
		["discord_servers_skipped", "discord_run_limit_reached"],
	);

	const ids = [SERVER_A, SERVER_B, SERVER_C, "1300000000000000006"];
	const all = fakeDiscord({
		respond: discordApi(
			Object.fromEntries(ids.map((id) => [id, messagesBy(OWNER, 1)])),
			refuse(ids),
		),
	});
	const second = harness(all);
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(searches(all).length, 3);
	assert.deepEqual(
		second.skips().map((skip) => skip.reason),
		["discord_verification_required"],
	);
});

test("a server error or a lost page interrupts the run", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: [] }, (path) =>
			path === "/users/@me/guilds"
				? { status: 503, body: "upstream" }
				: undefined,
		),
	});
	const h = harness(fake);
	await collectDiscordBrowser(h.ctx, fast());
	assert.equal(fake.calls.length, 2);
	assert.deepEqual(
		h.skips().map((skip) => skip.reason),
		["servers", "connections", "messages"].map(
			() => "discord_collection_interrupted",
		),
	);
});

test("an answer of another shape stops the run as unreadable", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: [] }, (path) =>
			path === "/users/@me/guilds" ? ok({ guilds: [] }) : undefined,
		),
	});
	const h = harness(fake);
	await collectDiscordBrowser(h.ctx, fast());
	assert.equal(fake.calls.length, 2);
	assert.deepEqual(
		h.skips().map((skip) => skip.reason),
		["servers", "connections", "messages"].map(
			() => "discord_source_unreadable",
		),
	);
});

test("messages older than the window are not read", async () => {
	const edge = NOW - MESSAGE_WINDOW_DAYS * DAY_MS;
	const fake = fakeDiscord({
		respond: discordApi({
			[SERVER_A]: [
				...messagesBy(OWNER, 30, edge + 30 * 60_000),
				...messagesBy(OWNER, 60, edge - 60_000),
			],
		}),
	});
	const h = harness(fake, ["messages"]);
	await collectDiscordBrowser(h.ctx, fast());
	assert.equal(h.of("messages").length, 30);
	// The walk stopped at the first old message: two pages, not four.
	assert.equal(searches(fake).length, 2);
	assert.deepEqual(h.skips(), []);
});

test("a malformed hit does not stop pagination", async () => {
	const all = messagesBy(OWNER, 50);
	const groupsAt = (offset: number) =>
		all
			.slice(offset, offset + SEARCH_PAGE)
			.map((message, index) =>
				offset + index === 3
					? [{ author: { id: OWNER }, hit: true }]
					: [message],
			);
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: all }, (path) => {
			const url = new URL(path, ORIGIN);
			if (!url.pathname.endsWith("/messages/search")) return undefined;
			const offset = Number(url.searchParams.get("offset"));
			return {
				status: 200,
				body: { total_results: all.length, messages: groupsAt(offset) },
			};
		}),
	});
	const h = harness(fake, ["messages"]);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(h.ctx, fast()),
	);
	// The unreadable group is not counted, but the raw position still advances
	// the listing, so the second page is read.
	assert.equal(h.of("messages").length, 49);
	assert.deepEqual(
		searches(fake).map((call) => call.path.split("offset=")[1]),
		["0", "25"],
	);
	const unreadable = lines.find((line) =>
		line.includes("search_hits_unreadable"),
	);
	assert.ok(unreadable);
	assert.ok(unreadable.includes('"positions":"3"'), unreadable);
});

test("the unreadable-position report fits the line budget at a full page", async () => {
	const all = messagesBy(OWNER, 10_000);
	const lastOffset = 9_975;
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: all }, (path) => {
			const url = new URL(path, ORIGIN);
			if (!url.pathname.endsWith("/messages/search")) return undefined;
			const offset = Number(url.searchParams.get("offset"));
			if (offset !== lastOffset) return undefined;
			// A full page with every other group unreadable: 13 four-digit
			// positions that do not collapse into one range.
			return {
				status: 200,
				body: {
					total_results: all.length,
					messages: all
						.slice(offset, offset + SEARCH_PAGE)
						.map((message, index) =>
							index % 2 === 0
								? [{ author: { id: OWNER }, hit: true }]
								: [message],
						),
				},
			};
		}),
	});
	const h = harness(fake, ["messages"]);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(
			h.ctx,
			fast([], { maxMessages: 20_000, maxRequests: 500 }),
		),
	);
	const unreadable = lines.filter((line) =>
		line.includes("search_hits_unreadable"),
	);
	assert.ok(unreadable.length >= 2, String(unreadable.length));
	for (const line of unreadable) {
		assert.ok(line.length <= DIAGNOSTIC_LINE_MAX_CHARS, `${line.length}: ${line}`);
	}
});

test("a requested time range narrows the window", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 10, NOW, DAY_MS) }),
	});
	const h = harness(
		fake,
		["messages"],
		{},
		{
			timeRange: {
				since: new Date(NOW - 5 * DAY_MS).toISOString(),
				until: new Date(NOW - 2 * DAY_MS).toISOString(),
			},
		},
	);
	await collectDiscordBrowser(h.ctx, fast());
	assert.deepEqual(
		h.of("messages").map((record) => record.timestamp),
		[3, 4, 5].map((days) => new Date(NOW - days * DAY_MS).toISOString()),
	);
});

test("a wider later range reads below the stored floor", async () => {
	const listing = messagesBy(OWNER, 30, NOW - DAY_MS, DAY_MS);
	const servers = { [SERVER_A]: listing };
	const since = new Date(NOW - 7 * DAY_MS).toISOString();

	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"], {}, { timeRange: { since } });
	await collectDiscordBrowser(first.ctx, fast());
	// Days 1..7 are inside the since bound; the walk stops at day 8.
	assert.equal(first.of("messages").length, 7);
	const afterFirst = first.cursor("messages") as {
		servers: Record<string, { floor_ms: number }>;
	};
	assert.equal(afterFirst.servers[SERVER_A]?.floor_ms, NOW - 7 * DAY_MS);

	// The next run asks for the default 90-day window. It reads days 8..30 and
	// does not emit any of the seven already collected.
	const two = fakeDiscord({ respond: discordApi(servers) });
	const second = harness(two, ["messages"], { messages: afterFirst });
	await collectDiscordBrowser(second.ctx, fast());
	assert.deepEqual(
		second.of("messages").map((record) => record.id),
		listing.slice(7).map((message) => message.id),
	);
});

test("an interrupted expansion does not claim a floor it never reached", async () => {
	const listing = messagesBy(OWNER, 30, NOW - DAY_MS, DAY_MS);
	const servers = { [SERVER_A]: listing };
	const since = new Date(NOW - 7 * DAY_MS).toISOString();

	// The first run reads the newest seven days and records their floor.
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"], {}, { timeRange: { since } });
	await collectDiscordBrowser(first.ctx, fast());
	assert.equal(first.of("messages").length, 7);

	// The unrestricted run is refused before it reads below that floor.
	const two = fakeDiscord({
		respond: discordApi(servers, (path) =>
			path.includes("/messages/search")
				? { status: 403, body: fixture("missing-access.json") }
				: undefined,
		),
	});
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(second.of("messages").length, 0);

	// The next healthy run must still read days 8..30, all 23 of them.
	const three = fakeDiscord({ respond: discordApi(servers) });
	const third = harness(three, ["messages"], {
		messages: second.cursor("messages"),
	});
	await collectDiscordBrowser(third.ctx, fast());
	const collected = new Set([
		...first.of("messages").map((record) => String(record.id)),
		...third.of("messages").map((record) => String(record.id)),
	]);
	assert.equal(collected.size, 30);
});

test("an expansion cut off in the new head still reaches the older floor", async () => {
	const listing = messagesBy(OWNER, 30, NOW - DAY_MS, DAY_MS);
	const since = new Date(NOW - 7 * DAY_MS).toISOString();

	const one = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const first = harness(one, ["messages"], {}, { timeRange: { since } });
	await collectDiscordBrowser(first.ctx, fast());

	// A new message arrives, then the unrestricted run is cut to one message:
	// it ends while still collecting the new head, before the old floor.
	const withNew = {
		[SERVER_A]: [...messagesBy(OWNER, 1, NOW - 60_000), ...listing],
	};
	const two = fakeDiscord({ respond: discordApi(withNew) });
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast([], { maxMessages: 1 }));
	assert.equal(second.of("messages").length, 1);

	// The next run must read below the head, including days 8..30.
	const three = fakeDiscord({ respond: discordApi(withNew) });
	const third = harness(three, ["messages"], {
		messages: second.cursor("messages"),
	});
	await collectDiscordBrowser(third.ctx, fast());
	const collected = new Set([
		...first.of("messages").map((record) => String(record.id)),
		...second.of("messages").map((record) => String(record.id)),
		...third.of("messages").map((record) => String(record.id)),
	]);
	assert.equal(collected.size, 31);
});

test("disjoint ranges do not merge into one covered interval", async () => {
	const listing = messagesBy(OWNER, 90, NOW - DAY_MS, DAY_MS);
	const servers = { [SERVER_A]: listing };
	const until = new Date(NOW - 30 * DAY_MS).toISOString();
	const since = new Date(NOW - 7 * DAY_MS).toISOString();

	// Days 31..90 are collected with an until bound.
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"], {}, { timeRange: { until } });
	await collectDiscordBrowser(first.ctx, fast());
	const firstIds = first.of("messages").map((record) => String(record.id));
	assert.equal(firstIds.length, 60);

	// Days 1..7 are collected with a since bound. The two ranges are disjoint.
	const two = fakeDiscord({ respond: discordApi(servers) });
	const second = harness(
		two,
		["messages"],
		{ messages: first.cursor("messages") },
		{ timeRange: { since } },
	);
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(second.of("messages").length, 7);

	// The full window must read days 8..30 rather than treat them as covered.
	const three = fakeDiscord({ respond: discordApi(servers) });
	const third = harness(three, ["messages"], {
		messages: second.cursor("messages"),
	});
	await collectDiscordBrowser(third.ctx, fast());
	const collected = new Set([
		...firstIds,
		...second.of("messages").map((record) => String(record.id)),
		...third.of("messages").map((record) => String(record.id)),
	]);
	assert.equal(collected.size, 90);
});

test("an unreadable group withholds coverage so the next run recovers it", async () => {
	const all = messagesBy(OWNER, 50);
	const groupsAt = (offset: number) =>
		all
			.slice(offset, offset + SEARCH_PAGE)
			.map((message, index) =>
				offset + index === 3
					? [{ author: { id: OWNER }, hit: true }]
					: [message],
			);
	const broken = fakeDiscord({
		respond: discordApi({ [SERVER_A]: all }, (path) => {
			const url = new URL(path, ORIGIN);
			if (!url.pathname.endsWith("/messages/search")) return undefined;
			const offset = Number(url.searchParams.get("offset"));
			return {
				status: 200,
				body: { total_results: all.length, messages: groupsAt(offset) },
			};
		}),
	});
	const first = harness(broken, ["messages"]);
	const lines = await captureDiagnostics(() =>
		collectDiscordBrowser(first.ctx, fast()),
	);
	// Pagination still advances, so the second page is read, but the 49 records
	// do not prove a complete walk.
	assert.equal(first.of("messages").length, 49);
	assert.deepEqual(
		searches(broken).map((call) => call.path.split("offset=")[1]),
		["0", "25"],
	);
	const unreadable = lines.find((line) =>
		line.includes("search_hits_unreadable"),
	);
	assert.ok(unreadable);
	// A walk with an unreadable group writes no trusted coverage.
	const afterFirst = first.cursor("messages") as {
		servers: Record<string, unknown>;
	};
	assert.equal(afterFirst.servers[SERVER_A], undefined);

	// A healthy second run re-reads the range and recovers the missing message.
	const healthy = fakeDiscord({ respond: discordApi({ [SERVER_A]: all }) });
	const second = harness(healthy, ["messages"], { messages: afterFirst });
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(second.of("messages").length, 50);
	assert.ok(
		second.of("messages").some((record) => String(record.id) === all[3]?.id),
	);
});

test("an interrupted disjoint expansion cannot omit the uncovered interval", async () => {
	const listing = messagesBy(OWNER, 90, NOW - DAY_MS, DAY_MS);
	const servers = { [SERVER_A]: listing };
	const since = new Date(NOW - 7 * DAY_MS).toISOString();
	const until = new Date(NOW - 30 * DAY_MS).toISOString();

	// Run 1 collects days 1..7 with a since bound.
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"], {}, { timeRange: { since } });
	await collectDiscordBrowser(first.ctx, fast());
	assert.equal(first.of("messages").length, 7);

	// Run 2 asks for days 31..90 and is refused at offset 50 after days 31..50.
	const two = fakeDiscord({
		respond: discordApi(servers, (path) => {
			if (!path.includes("/messages/search")) return undefined;
			const url = new URL(path, ORIGIN);
			return url.searchParams.get("offset") === "50"
				? { status: 403, body: fixture("missing-access.json") }
				: undefined;
		}),
	});
	const second = harness(
		two,
		["messages"],
		{ messages: first.cursor("messages") },
		{ timeRange: { until } },
	);
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(second.of("messages").length, 20);

	// Run 3 asks for the whole window. Days 8..30 were never read and must not
	// be treated as covered by the failed run's resume marker.
	const three = fakeDiscord({ respond: discordApi(servers) });
	const third = harness(three, ["messages"], {
		messages: second.cursor("messages"),
	});
	await collectDiscordBrowser(third.ctx, fast());
	const collected = new Set([
		...first.of("messages").map((record) => String(record.id)),
		...second.of("messages").map((record) => String(record.id)),
		...third.of("messages").map((record) => String(record.id)),
	]);
	assert.equal(collected.size, 90);
});

test("the accepted search result-offset ceiling still marks the server complete", async () => {
	// 10,025 messages means the site's own 9,975 offset ceiling is reached
	// before the listing ends; the product owner accepts that as the range's
	// end, so the walk records full coverage.
	const all = messagesBy(OWNER, 10_025);
	const fake = fakeDiscord({ respond: discordApi({ [SERVER_A]: all }) });
	const h = harness(fake, ["messages"]);
	await collectDiscordBrowser(
		h.ctx,
		fast([], { maxMessages: 20_000, maxRequests: 450 }),
	);
	// 400 pages of 25 up to and including offset 9,975.
	assert.equal(h.of("messages").length, 10_000);
	assert.deepEqual(h.skips(), []);
	const state = h.cursor("messages") as {
		servers: Record<
			string,
			{ floor_ms: number; newest_id: string; until_ms: number | null }
		>;
	};
	assert.equal(state.servers[SERVER_A]?.newest_id, all[0]?.id);
	assert.equal(
		state.servers[SERVER_A]?.floor_ms,
		NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
	);
	assert.equal(state.servers[SERVER_A]?.until_ms, null);
});

test("a legacy cursor without recorded bounds is not trusted", async () => {
	const listing = messagesBy(OWNER, 5);
	const legacy = {
		queue: [SERVER_A],
		servers: {
			[SERVER_A]: {
				newest_id: listing[0]?.id,
				floor_ms: NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
			},
		},
	};
	const fake = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const h = harness(fake, ["messages"], { messages: legacy });
	await collectDiscordBrowser(h.ctx, fast());
	// The missing until_ms makes the cursor untrusted, so the range is re-read.
	assert.deepEqual(
		h.of("messages").map((record) => String(record.id)),
		listing.map((message) => message.id),
	);
});

test("a stored resume marker is dropped rather than trusted", async () => {
	const listing = messagesBy(OWNER, 30, NOW - DAY_MS, DAY_MS);
	// An old cursor could carry a valid-looking range plus a resume offset that
	// skipped an uncovered interval. It must not be trusted.
	const legacy = {
		queue: [SERVER_A],
		servers: {
			[SERVER_A]: {
				newest_id: listing[0]?.id,
				floor_ms: NOW - 7 * DAY_MS,
				until_ms: null,
				backfill: { before_id: listing[15]?.id, offset: 16 },
			},
		},
	};
	const fake = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const h = harness(fake, ["messages"], { messages: legacy });
	await collectDiscordBrowser(h.ctx, fast());
	// The resume marker makes the cursor untrusted, so the range is re-read.
	assert.deepEqual(
		h.of("messages").map((record) => String(record.id)),
		listing.map((message) => message.id),
	);
});

test("an unchanged request still stops at the known head", async () => {
	const listing = messagesBy(OWNER, 5);
	const one = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const first = harness(one, ["messages"]);
	await collectDiscordBrowser(first.ctx, fast());
	assert.equal(first.of("messages").length, 5);

	const two = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast());
	assert.deepEqual(second.of("messages"), []);
	// One search reaches the known head and stops there.
	assert.equal(searches(two).length, 1);
});

test("an interrupted walk writes no coverage and the next run starts over", async () => {
	const listing = messagesBy(OWNER, 70);
	const servers = { [SERVER_A]: listing };

	// Two runs hit the message limit before reaching the end. Neither writes
	// coverage, so the next starts from the newest message again.
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"]);
	await collectDiscordBrowser(first.ctx, fast([], { maxMessages: 40 }));
	assert.equal(first.of("messages").length, 40);
	assert.equal(
		(first.cursor("messages") as { servers: Record<string, unknown> }).servers[
			SERVER_A
		],
		undefined,
	);

	const two = fakeDiscord({ respond: discordApi(servers) });
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast([], { maxMessages: 30 }));
	// Re-emitting already stored messages is acceptable; missing one is not.
	assert.deepEqual(
		second.of("messages").map((record) => record.id),
		listing.slice(0, 30).map((message) => message.id),
	);

	// A healthy run reaches the end and records the whole range.
	const three = fakeDiscord({ respond: discordApi(servers) });
	const third = harness(three, ["messages"], {
		messages: second.cursor("messages"),
	});
	await collectDiscordBrowser(third.ctx, fast());
	assert.equal(third.of("messages").length, 70);
	const afterThird = third.cursor("messages") as {
		servers: Record<string, { floor_ms: number; until_ms: number | null }>;
	};
	assert.equal(
		afterThird.servers[SERVER_A]?.floor_ms,
		NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
	);
	assert.equal(afterThird.servers[SERVER_A]?.until_ms, null);
});

test("the message limit writes no coverage; a later run re-reads and completes", async () => {
	const listing = messagesBy(OWNER, 70);
	const servers = {
		[SERVER_A]: listing,
		[SERVER_B]: messagesBy(OWNER, 3, NOW - 3 * DAY_MS),
	};

	// The first run hits the message limit inside server A and writes nothing.
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"]);
	await collectDiscordBrowser(first.ctx, fast([], { maxMessages: 40 }));
	assert.equal(first.of("messages").length, 40);
	assert.deepEqual(
		first.skips().map((skip) => [skip.reason, skip.recovery_hint]),
		[
			[
				"discord_run_limit_reached",
				{ action: "retry_by_runtime", retryable: true },
			],
		],
	);
	assert.deepEqual(first.cursor("messages"), {
		queue: [SERVER_A, SERVER_B],
		servers: {},
	});

	// A later healthy run starts over, reaches the end of both servers, and
	// records full coverage.
	const two = fakeDiscord({ respond: discordApi(servers) });
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast());
	assert.equal(second.of("messages").length, 73);
	const afterSecond = second.cursor("messages");
	assert.deepEqual(afterSecond, {
		queue: [SERVER_A, SERVER_B],
		servers: {
			[SERVER_A]: {
				newest_id: servers[SERVER_A]?.[0]?.id,
				floor_ms: NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
				until_ms: null,
			},
			[SERVER_B]: {
				newest_id: servers[SERVER_B]?.[0]?.id,
				floor_ms: NOW - MESSAGE_WINDOW_DAYS * DAY_MS,
				until_ms: null,
			},
		},
	});
	assert.deepEqual(second.skips(), []);

	// Nothing new: one request per server, each stopping at its first hit.
	const three = fakeDiscord({ respond: discordApi(servers) });
	const third = harness(three, ["messages"], { messages: afterSecond });
	await collectDiscordBrowser(third.ctx, fast());
	assert.deepEqual(third.of("messages"), []);
	assert.equal(searches(three).length, 2);
	assert.deepEqual(third.skips(), []);

	// A full refresh ignores the cursor.
	const four = fakeDiscord({ respond: discordApi(servers) });
	const fourth = harness(
		four,
		["messages"],
		{ messages: afterSecond },
		{ collectionMode: "full_refresh" },
	);
	await collectDiscordBrowser(fourth.ctx, fast());
	assert.equal(fourth.of("messages").length, 73);
});

test("an interrupted walk re-reads after deletions shift the listing", async () => {
	const listing = messagesBy(OWNER, 70);
	const one = fakeDiscord({ respond: discordApi({ [SERVER_A]: listing }) });
	const first = harness(one, ["messages"]);
	await collectDiscordBrowser(first.ctx, fast([], { maxMessages: 40 }));
	// Five collected messages are deleted, so the listing shifts up by five.
	const shifted = [...listing.slice(0, 10), ...listing.slice(15)];
	const two = fakeDiscord({ respond: discordApi({ [SERVER_A]: shifted }) });
	const second = harness(two, ["messages"], {
		messages: first.cursor("messages"),
	});
	await collectDiscordBrowser(second.ctx, fast());
	// No coverage was claimed, so the walk reads the shifted listing whole.
	assert.deepEqual(
		second.of("messages").map((record) => String(record.id)),
		shifted.map((message) => message.id),
	);
});

test("at most 25 servers are searched in a run; the queue carries the rest", async () => {
	const ids = Array.from({ length: 30 }, (_, index) =>
		flake(Date.parse("2022-01-01T00:00:00Z") + index * DAY_MS, index),
	);
	const servers = Object.fromEntries(
		ids.map((id) => [id, messagesBy(OWNER, 1)]),
	);
	const one = fakeDiscord({ respond: discordApi(servers) });
	const first = harness(one, ["messages"]);
	const pauses: number[] = [];
	await collectDiscordBrowser(first.ctx, fast(pauses));
	assert.equal(searches(one).length, MAX_SERVERS_PER_RUN);
	assert.equal(first.of("messages").length, MAX_SERVERS_PER_RUN);
	assert.deepEqual(
		first.skips().map((skip) => skip.reason),
		["discord_run_limit_reached"],
	);
	const state = first.cursor("messages") as { queue: string[] };
	assert.deepEqual(state.queue, [...ids.slice(25), ...ids.slice(0, 25)]);
	assert.equal(requestPauses(pauses).length, one.calls.length - 1);

	// The next run starts with the five servers never searched.
	const two = fakeDiscord({ respond: discordApi(servers) });
	const second = harness(two, ["messages"], { messages: state });
	await collectDiscordBrowser(second.ctx, fast());
	assert.deepEqual(
		searches(two)
			.slice(0, 5)
			.map((call) => call.path.split("/")[2]),
		ids.slice(25),
	);
	assert.equal(second.of("messages").length, 5);
	// Every server has now been searched, so the rotation is not a shortfall.
	assert.deepEqual(second.skips(), []);
});

test("a host that drops STATE on a skip gets deferred work as progress", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 30) }),
	});
	const h = harness(fake, ["messages"]);
	await collectDiscordBrowser(
		h.ctx,
		fast([], { maxMessages: 10, deferredWork: "progress" }),
	);
	assert.equal(h.of("messages").length, 10);
	assert.deepEqual(h.skips(), []);
	assert.ok(
		h.messages.some(
			(m) =>
				m.type === "PROGRESS" &&
				/reached its limit/.test(String((m as { message?: string }).message)),
		),
	);
	assert.ok(h.cursor("messages"));
	assertUserFacingProgress(h.messages);
});

test("the request limit ends a run even when the other limits do not", async () => {
	const fake = fakeDiscord({
		respond: discordApi({ [SERVER_A]: messagesBy(OWNER, 200) }),
	});
	const h = harness(fake, ["messages"]);
	await collectDiscordBrowser(h.ctx, fast([], { maxRequests: 5 }));
	assert.equal(fake.calls.length, 5);
	assert.equal(h.of("messages").length, 75);
	assert.deepEqual(
		h.skips().map((skip) => skip.reason),
		["discord_run_limit_reached"],
	);
});

test("the default limits are the documented ones", () => {
	assert.equal(MAX_MESSAGES_PER_RUN, 1000);
	assert.equal(MAX_SERVERS_PER_RUN, 25);
	assert.equal(MESSAGE_WINDOW_DAYS, 90);
	assert.equal(REQUEST_PAUSE_MIN_MS, 3000);
	assert.equal(REQUEST_PAUSE_MAX_MS, 5000);
});

test("the manifest states the manual, non-background posture", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	);
	const policy = manifest.capabilities.refresh_policy;
	assert.equal(policy.recommended_mode, "manual");
	assert.equal(policy.background_safe, false);
	assert.equal(policy.minimum_interval_seconds, 86_400);
	assert.equal(policy.bot_detection_sensitivity, "high");
	assert.equal(policy.rate_limit_sensitivity, "high");
	assert.equal(manifest.capabilities.public_listing.tier, "development");
	assert.deepEqual(
		manifest.streams.map((stream: { name: string }) => stream.name),
		ALL,
	);
	assert.equal(manifest.mobile.pageshim.login_url, LOGIN_URL);
});
