// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fixture-backed stand-ins for the Slack Web API and the connector runtime,
// shared by this connector's tests. Nothing here runs in production.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { SlackBrowserCollectContext } from "./collector.ts";
import { validateRecord } from "./schemas.ts";
import type { SignedInTeam, SlackBrowserOptions } from "./types.ts";
import {
	type SlackApiClient,
	SlackApiError,
	type SlackApiPage,
	SlackSessionLostError,
} from "./web-api.ts";

/** The fixtures describe a week ending here: 1790553600 as Slack counts it. */
export const FIXTURE_NOW = new Date("2026-09-28T00:00:00Z");
export const FIXTURE_NOW_SECONDS = 1_790_553_600;

export const TEAM: SignedInTeam = {
	id: "T0123456789",
	name: "Acme",
	domain: "acme",
	url: "https://acme.slack.com/",
};

export const DEFAULT_OPTIONS: SlackBrowserOptions = {
	channelAllowlist: [],
	channelTypes: ["public", "private", "im", "mpim"],
	lookbackDays: 7,
	workspace: "",
};

export const ALL_STREAMS = [
	"workspace",
	"channels",
	"users",
	"messages",
	"message_attachments",
	"reactions",
	"files",
	"user_groups",
	"reminders",
	"stars",
];

const SESSION_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked"]);

function fixtureUrl(name: string): URL {
	return new URL(`./fixtures/api/${name}.json`, import.meta.url);
}

export function fixture(name: string): unknown {
	return JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
}

function fixtureIfPresent(name: string): unknown {
	return existsSync(fixtureUrl(name)) ? fixture(name) : undefined;
}

export interface ApiCall {
	method: string;
	params: Record<string, string>;
}

/** The fixture that answers one Web API call, the way the fake Slack does. */
export function fixtureAnswer(
	method: string,
	params: Record<string, string>,
): unknown {
	switch (method) {
		case "conversations.history": {
			const channel = params.channel ?? "";
			if (params.latest !== undefined) {
				return (
					fixtureIfPresent(`conversations.history-${channel}-threads`) ?? {
						ok: true,
						messages: [],
						has_more: false,
					}
				);
			}
			const page = params.cursor === undefined ? "p1" : "p2";
			return fixture(`conversations.history-${channel}-${page}`);
		}
		case "conversations.replies":
			return (
				fixtureIfPresent(
					`conversations.replies-${params.channel ?? ""}-${params.ts ?? ""}`,
				) ?? { ok: false, error: "thread_not_found" }
			);
		default:
			return fixture(method);
	}
}

export interface FakeApi extends SlackApiClient {
	calls: ApiCall[];
}

/**
 * A client that answers from the fixtures and fails the way the real one
 * does: an `ok: false` answer becomes the error the real client would throw.
 * `override` may answer a call itself, with a value or an Error to throw.
 */
export function fakeApi(
	override: (call: ApiCall) => unknown = () => undefined,
): FakeApi {
	const calls: ApiCall[] = [];
	return {
		calls,
		async call(_teamId, method, params) {
			const call = { method, params };
			calls.push(call);
			const answer = override(call) ?? fixtureAnswer(method, params);
			if (answer instanceof Error) {
				throw answer;
			}
			const envelope = answer as { ok?: boolean; error?: string };
			if (envelope.ok !== true) {
				const reason = envelope.error ?? "unknown";
				throw SESSION_ERRORS.has(reason)
					? new SlackSessionLostError(reason)
					: new SlackApiError(method, reason, false, 200);
			}
			return answer;
		},
	};
}

type StateMessage = Extract<EmittedMessage, { type: "STATE" }>;

export interface Harness {
	ctx: SlackBrowserCollectContext;
	messages: EmittedMessage[];
	records: Array<{ stream: string; data: RecordData }>;
	of: (stream: string) => RecordData[];
	state: (stream: string) => Record<string, unknown> | undefined;
	skips: () => Array<Extract<EmittedMessage, { type: "SKIP_RESULT" }>>;
	gaps: () => Array<Extract<EmittedMessage, { type: "DETAIL_GAP" }>>;
	coverage: () => Array<Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>>;
}

export function harness(
	streams: readonly string[],
	options: {
		mode?: "full_refresh" | "incremental";
		state?: Record<string, unknown>;
		timeRange?: { since?: string; until?: string };
	} = {},
): Harness {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const ctx: SlackBrowserCollectContext = {
		...(options.mode === undefined ? {} : { collectionMode: options.mode }),
		emit: async (message) => {
			messages.push(message);
		},
		emitRecord: async (stream, data) => {
			const checked = validateRecord(stream, data);
			assert.equal(checked.ok, true, JSON.stringify(checked));
			records.push({ stream, data });
		},
		emittedAt: FIXTURE_NOW.toISOString(),
		progress: async () => {
			// Progress is host-facing only.
		},
		requested: new Map(
			streams.map((name) => [
				name,
				{
					name,
					...(options.timeRange ? { time_range: options.timeRange } : {}),
				} as StreamScope,
			]),
		),
		state: options.state ?? {},
	};
	return {
		ctx,
		messages,
		records,
		of: (stream) =>
			records.filter((r) => r.stream === stream).map((r) => r.data),
		state: (stream) => {
			const cursor = messages.find(
				(m): m is StateMessage => m.type === "STATE" && m.stream === stream,
			)?.cursor;
			return cursor !== null && typeof cursor === "object"
				? (cursor as Record<string, unknown>)
				: undefined;
		},
		skips: () =>
			messages.filter(
				(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
					m.type === "SKIP_RESULT",
			),
		gaps: () =>
			messages.filter(
				(m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
					m.type === "DETAIL_GAP",
			),
		coverage: () =>
			messages.filter(
				(m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
					m.type === "DETAIL_COVERAGE",
			),
	};
}

// ─── A fake app.slack.com page ──────────────────────────────────────────

export type Fetcher = (
	url: URL,
	init: RequestInit,
) => Response | Promise<Response>;

export interface FakeSlackWorld {
	fetch: Fetcher;
	origin?: string;
	/** What the web client's local config lists; a team without a token is one the client is not signed in to. */
	teams?: Record<
		string,
		{ domain?: string; name?: string; token?: string; url?: string }
	>;
}

/**
 * Runs an in-page function in this process against a fake app.slack.com:
 * `location`, `localStorage` and `fetch` are swapped in for the call.
 */
export async function withSlackGlobals<T>(
	world: FakeSlackWorld,
	run: () => Promise<T>,
): Promise<T> {
	const origin = world.origin ?? "https://app.slack.com";
	const savedFetch = globalThis.fetch;
	const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	const savedStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage",
	);
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { origin },
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) =>
				key === "localConfig_v2" && world.teams
					? JSON.stringify({ teams: world.teams })
					: null,
		},
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		world.fetch(new URL(String(input), origin), init ?? {})) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = savedFetch;
		for (const [name, saved] of [
			["location", savedLocation],
			["localStorage", savedStorage],
		] as const) {
			if (saved) {
				Object.defineProperty(globalThis, name, saved);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	}
}

/** A page whose `evaluate` runs the function here, inside the fake world. */
export function fakeApiPage(world: FakeSlackWorld): SlackApiPage {
	return {
		evaluate: async (fn: unknown, arg: unknown) =>
			withSlackGlobals(world, async () =>
				typeof fn === "function" ? fn(arg) : undefined,
			),
	} as unknown as SlackApiPage;
}

export const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
