// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Slack Web API, called from inside the owner's signed-in
 * app.slack.com page.
 *
 * Slack's web client authenticates its API calls with a session token it
 * keeps in the page's local storage (`localConfig_v2.teams[<team>].token`)
 * plus the browser's own cookies. Both are only usable from the app.slack.com
 * origin: the workspace's own domain and slack.com refuse cross-origin calls.
 * So every call is a same-origin `fetch('/api/<method>')` run by
 * `page.evaluate` on an app.slack.com page. The token is read inside the
 * page and never returned to the connector process, and nothing here writes
 * it anywhere.
 *
 * The in-page function reports what happened rather than throwing, so the
 * connector can tell a lost session from a rate limit from a network fault.
 * Retries, pacing and the auth-versus-transient classification live on the
 * Node side, where they can be unit-tested.
 */

import type { Page } from "playwright";
import { z } from "zod";
import { envelopeSchema, signedInTeamsSchema } from "./schemas.ts";
import type { SignedInTeam } from "./types.ts";

export const APP_ORIGIN = "https://app.slack.com";
/** Slack's own guidance for Tier 3 methods is about one call per second; this stays under it with headroom for retries. */
export const REQUEST_PAUSE_MS = 350;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 1500;
const RATE_LIMIT_FALLBACK_S = 5;

/** Slack's answers that mean the session itself is no good; retrying cannot help. */
const SESSION_ERRORS = new Set([
	"invalid_auth",
	"not_authed",
	"token_revoked",
	"token_expired",
	"account_inactive",
	"team_access_not_granted",
]);

/** What the in-page call returns. It never throws: a throw in the page becomes network_error. */
export const callOutcomeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("wrong_origin"), origin: z.string() }),
	z.object({ kind: z.literal("no_session") }),
	z.object({ kind: z.literal("network_error"), message: z.string() }),
	z.object({
		kind: z.literal("http"),
		status: z.number(),
		retryAfterSeconds: z.number().nullable(),
		body: z.string(),
	}),
]);

export type SlackCallOutcome = z.infer<typeof callOutcomeSchema>;

export type SlackApiPage = Pick<Page, "evaluate">;

/** A durable rejection of the browser session; the owner has to sign in again. */
export class SlackSessionLostError extends Error {
	readonly code = "slack_session_lost";
	readonly slackError: string | null;
	constructor(slackError: string | null) {
		super(
			slackError === null
				? "slack_session_lost"
				: `slack_session_lost: ${slackError}`,
		);
		this.name = "SlackSessionLostError";
		this.slackError = slackError;
	}
}

/** A method that did not answer usefully, after retries where they applied. */
export class SlackApiError extends Error {
	readonly httpStatus: number | null;
	readonly method: string;
	readonly reason: string;
	readonly retryable: boolean;
	constructor(
		method: string,
		reason: string,
		retryable: boolean,
		httpStatus: number | null,
	) {
		super(`slack_api_${method}: ${reason}`);
		this.name = "SlackApiError";
		this.method = method;
		this.reason = reason;
		this.retryable = retryable;
		this.httpStatus = httpStatus;
	}
}

export interface SlackApiClient {
	/** One Web API call for `teamId`; resolves to the parsed JSON answer, `ok: true`. */
	call(
		teamId: string,
		method: string,
		params: Record<string, string>,
	): Promise<unknown>;
}

interface InPageCallInput {
	method: string;
	origin: string;
	params: Record<string, string>;
	teamId: string;
	timeoutMs: number;
}

/**
 * Runs in the page. Self-contained: Playwright serialises the function, so it
 * can only use its argument and browser globals.
 */
async function callFromPage(input: InPageCallInput): Promise<SlackCallOutcome> {
	if (location.origin !== input.origin) {
		return { kind: "wrong_origin", origin: location.origin };
	}
	let token = "";
	try {
		const config: unknown = JSON.parse(
			localStorage.getItem("localConfig_v2") ?? "{}",
		);
		const teams = (
			config as {
				teams?: Record<string, { token?: unknown } | undefined>;
			} | null
		)?.teams;
		const candidate = teams?.[input.teamId]?.token;
		if (typeof candidate === "string") {
			token = candidate;
		}
	} catch {
		token = "";
	}
	if (token === "") {
		return { kind: "no_session" };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), input.timeoutMs);
	try {
		const response = await fetch(`/api/${input.method}`, {
			body: new URLSearchParams({ ...input.params, token }),
			credentials: "include",
			method: "POST",
			signal: controller.signal,
		});
		const retryAfter = response.headers.get("retry-after");
		const seconds =
			retryAfter === null ? Number.NaN : Number.parseInt(retryAfter, 10);
		return {
			kind: "http",
			status: response.status,
			retryAfterSeconds: Number.isFinite(seconds) ? seconds : null,
			body: await response.text(),
		};
	} catch (error) {
		return {
			kind: "network_error",
			message: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

export async function callSlackInPage(
	page: SlackApiPage,
	teamId: string,
	method: string,
	params: Record<string, string>,
): Promise<SlackCallOutcome> {
	let raw: unknown;
	try {
		raw = await page.evaluate(callFromPage, {
			method,
			origin: APP_ORIGIN,
			params,
			teamId,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
	} catch (error) {
		return {
			kind: "network_error",
			message: `evaluate failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const parsed = callOutcomeSchema.safeParse(raw);
	return parsed.success
		? parsed.data
		: {
				kind: "network_error",
				message: "the page returned an unrecognised result",
			};
}

type Verdict =
	| { kind: "answer"; json: unknown }
	| { kind: "retry"; reason: string; waitMs?: number }
	| { kind: "fatal"; error: Error };

function classifyBody(method: string, status: number, body: string): Verdict {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		return { kind: "retry", reason: "bad_json" };
	}
	const envelope = envelopeSchema.safeParse(json);
	if (!envelope.success) {
		return {
			kind: "fatal",
			error: new SlackApiError(method, "unrecognised_answer", false, status),
		};
	}
	if (envelope.data.ok) {
		return { kind: "answer", json };
	}
	const reason = envelope.data.error ?? "unknown";
	if (SESSION_ERRORS.has(reason)) {
		return { kind: "fatal", error: new SlackSessionLostError(reason) };
	}
	if (reason === "ratelimited") {
		return { kind: "retry", reason, waitMs: RATE_LIMIT_FALLBACK_S * 1000 };
	}
	return {
		kind: "fatal",
		error: new SlackApiError(method, reason, false, status),
	};
}

function classify(method: string, outcome: SlackCallOutcome): Verdict {
	switch (outcome.kind) {
		case "wrong_origin":
			return {
				kind: "fatal",
				error: new SlackApiError(
					method,
					`wrong_origin:${outcome.origin}`,
					false,
					null,
				),
			};
		case "no_session":
			return { kind: "fatal", error: new SlackSessionLostError(null) };
		case "network_error":
			return { kind: "retry", reason: `network_error:${outcome.message}` };
		default:
			break;
	}
	const { status } = outcome;
	if (status === 429) {
		const seconds = outcome.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_S;
		return {
			kind: "retry",
			reason: "ratelimited",
			waitMs: (seconds + 1) * 1000,
		};
	}
	if (status === 401 || status === 403) {
		return { kind: "fatal", error: new SlackSessionLostError(null) };
	}
	if (status >= 500) {
		return { kind: "retry", reason: `http_${status}` };
	}
	if (status < 200 || status >= 300) {
		return {
			kind: "fatal",
			error: new SlackApiError(method, `http_${status}`, false, status),
		};
	}
	return classifyBody(method, status, outcome.body);
}

export interface SlackApiClientDeps {
	maxAttempts?: number;
	pauseMs?: number;
	retryBaseMs?: number;
	sleep: (ms: number) => Promise<void>;
}

/**
 * The paced, retrying client over one page. Every call after the first waits
 * `pauseMs`; a rate-limited, 5xx, malformed or unreachable answer is retried
 * with a growing delay, at most `maxAttempts` times; a session rejection or
 * a method error is thrown at once.
 */
export function createSlackApiClient(
	page: SlackApiPage,
	deps: SlackApiClientDeps,
): SlackApiClient {
	const maxAttempts = deps.maxAttempts ?? MAX_ATTEMPTS;
	const pauseMs = deps.pauseMs ?? REQUEST_PAUSE_MS;
	const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
	let calls = 0;
	return {
		async call(teamId, method, params) {
			if (calls > 0) {
				await deps.sleep(pauseMs);
			}
			calls += 1;
			let lastFailure = "unknown";
			for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
				const verdict = classify(
					method,
					await callSlackInPage(page, teamId, method, params),
				);
				if (verdict.kind === "answer") {
					return verdict.json;
				}
				if (verdict.kind === "fatal") {
					throw verdict.error;
				}
				lastFailure = verdict.reason;
				if (attempt < maxAttempts) {
					await deps.sleep(verdict.waitMs ?? retryBaseMs * attempt);
				}
			}
			throw new SlackApiError(method, lastFailure, true, null);
		},
	};
}

/**
 * Runs in the page: the workspaces the web client is signed in to, without
 * their tokens. Empty off app.slack.com or before the client has loaded.
 */
function readTeamsFromPage(origin: string): unknown {
	if (location.origin !== origin) {
		return [];
	}
	try {
		const config: unknown = JSON.parse(
			localStorage.getItem("localConfig_v2") ?? "{}",
		);
		const teams = (config as { teams?: Record<string, unknown> } | null)?.teams;
		if (!teams || typeof teams !== "object") {
			return [];
		}
		return Object.entries(teams).flatMap(([id, value]) => {
			const team = value as {
				domain?: unknown;
				name?: unknown;
				token?: unknown;
				url?: unknown;
			} | null;
			if (typeof team?.token !== "string" || typeof team.url !== "string") {
				return [];
			}
			return [
				{
					id,
					name: typeof team.name === "string" ? team.name : "",
					domain: typeof team.domain === "string" ? team.domain : "",
					url: team.url.endsWith("/") ? team.url : `${team.url}/`,
				},
			];
		});
	} catch {
		return [];
	}
}

export async function readSignedInTeams(
	page: SlackApiPage,
): Promise<SignedInTeam[]> {
	let raw: unknown;
	try {
		raw = await page.evaluate(readTeamsFromPage, APP_ORIGIN);
	} catch {
		return [];
	}
	const parsed = signedInTeamsSchema.safeParse(raw);
	return parsed.success ? parsed.data : [];
}
