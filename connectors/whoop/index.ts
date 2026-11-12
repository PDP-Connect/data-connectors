#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	type EnsureSessionArgs,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	bodyRecord,
	cycleRecord,
	parseBootstrapResponse,
	parseCyclesResponse,
	profileRecord,
	recoveryRecord,
	sleepRecords,
	workoutRecords,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	WhoopBootstrap,
	WhoopCycleRecord,
	WhoopFetchResult,
} from "./types.ts";

const API_BASE = "https://api.prod.whoop.com";
const APP_URL = "https://app.whoop.com";
const BOOTSTRAP_PATH = "/users-service/v2/bootstrap?apiVersion=7";
const HISTORY_FALLBACK = "2015-09-01T00:00:00.000Z";
const WINDOW_DAYS = 200;
const OVERLAP_DAYS = 7;
const MAX_WINDOWS = 40;
const DAY_MS = 86_400_000;
const AGGREGATE_STREAMS = [
	"cycles",
	"recoveries",
	"sleeps",
	"workouts",
] as const;

export type WhoopFetch = (path: string) => Promise<WhoopFetchResult>;

interface CollectWhoopArgs {
	emit: (message: EmittedMessage) => Promise<void>;
	emitRecord: (stream: string, data: RecordData) => Promise<void>;
	fetchPath: WhoopFetch;
	now: Date;
	requested: ReadonlySet<string>;
	state: Record<string, unknown>;
}

function decodeJsonResponse(status: number, text: string): WhoopFetchResult {
	try {
		return { status, json: JSON.parse(text) as unknown };
	} catch {
		return { status, json: null, invalidJson: true };
	}
}

export function makeWhoopPageFetch(page: Page): WhoopFetch {
	// The token source (0 cookie, 1 whoop.security.accessToken, 2 Cognito) that
	// last answered with a 2xx. The page body tries it first, so a run whose
	// cookie token is refused pays the 401 once, not on every request.
	let preferredSource: number | null = null;
	return async (path: string): Promise<WhoopFetchResult> => {
		const { source, ...result } = await page.evaluate(
			async ({
				apiBase,
				requestPath,
				preferredSource,
			}): Promise<{
				invalidJson?: boolean;
				json: unknown;
				source?: number;
				status: number;
			}> => {
				// The web app's own access token, read and used here and never
				// returned. WHOOP's web app (whoop-web 5.1.10, app.whoop.com
				// assets/shared.js WhoopAuth.putState) writes the token it got from
				// the login response to both the `whoop-auth-token` cookie (domain
				// .whoop.com, raw value, its own Cookies.put: no encodeURIComponent)
				// and localStorage `whoop.security.accessToken` (angular-local-storage
				// with prefix "whoop", which may JSON-quote a string). Its readState
				// takes the localStorage value first and the cookie second; its API
				// interceptor then sends `bearer ` + that token, as here. The cookie
				// is read first here: the sign-in on id.whoop.com hands the session
				// over in .whoop.com cookies (clearState also removes
				// whoop-auth-refresh-token and whoop-auth-expiry cookies that putState
				// never writes), so right after sign-in the cookie is the one store
				// known to hold a token; after putState both hold the same value.
				// When the stores disagree and the first token is refused with a
				// 401, the next distinct one is tried once in the same call: on the
				// remote surface, fresh sign-ins whose cookie was accepted still got
				// a 401 on the first read, and the other store is where the app
				// itself would have looked. URL-decoding and unquoting are
				// defensive: a JWT is unchanged by either, and a quoted localStorage
				// string needs the quotes gone. The Cognito key is kept last for
				// sessions written by older builds of the app; the current bundle
				// has no such key. (No named helper here: this body is serialized
				// into the page, where a transpiler's name helper would not exist.)
				const candidates: Array<{ source: number; value: string }> = [];
				try {
					const cookiePrefix = "whoop-auth-token=";
					const authCookie = document.cookie
						.split(";")
						.map((cookie) => cookie.trim())
						.find((cookie) => cookie.startsWith(cookiePrefix));
					for (let source = 0; source < 3; source += 1) {
						let raw: string | null | undefined;
						try {
							if (source === 0) {
								raw = authCookie?.slice(cookiePrefix.length);
							} else if (source === 1) {
								raw = localStorage.getItem("whoop.security.accessToken");
							} else {
								const cognitoKey = Object.keys(localStorage).find(
									(key) =>
										key.startsWith("CognitoIdentityServiceProvider.") &&
										key.endsWith(".accessToken"),
								);
								raw = cognitoKey ? localStorage.getItem(cognitoKey) : null;
							}
						} catch {
							// A store that cannot be read (storage disabled for the
							// origin) gives no token; the others still count.
							continue;
						}
						if (!raw) continue;
						let value = raw;
						try {
							value = decodeURIComponent(value);
						} catch {
							// Not URL-encoded after all: use it as it is.
						}
						if (value.startsWith('"')) {
							try {
								const parsed: unknown = JSON.parse(value);
								value = typeof parsed === "string" ? parsed : "";
							} catch {
								value = "";
							}
						}
						value = value.trim();
						if (value && !candidates.some((c) => c.value === value)) {
							candidates.push({ source, value });
						}
					}
				} catch {
					return { status: 401, json: null };
				}
				// The source that answered the previous read goes first.
				const preferredIndex = candidates.findIndex(
					(c) => c.source === preferredSource,
				);
				if (preferredIndex > 0) {
					candidates.unshift(...candidates.splice(preferredIndex, 1));
				}
				const first = candidates[0];
				if (!first) {
					return { status: 401, json: null };
				}
				const second = candidates[1];
				const url = `${apiBase}${requestPath}`;
				let attempt = first;
				let response: Response;
				try {
					response = await fetch(url, {
						credentials: "include",
						headers: {
							accept: "application/json",
							authorization: `bearer ${attempt.value}`,
						},
					});
				} catch {
					return { status: 0, json: null };
				}
				if (response.status === 401 && second) {
					// One retry with the next distinct token; a failed retry keeps
					// the 401 it was answering.
					try {
						const retry = await fetch(url, {
							credentials: "include",
							headers: {
								accept: "application/json",
								authorization: `bearer ${second.value}`,
							},
						});
						attempt = second;
						response = retry;
					} catch {
						// The first answer stands.
					}
				}
				const text = await response.text();
				try {
					return {
						status: response.status,
						json: JSON.parse(text) as unknown,
						source: attempt.source,
					};
				} catch {
					return {
						status: response.status,
						json: null,
						invalidJson: true,
						source: attempt.source,
					};
				}
			},
			{ apiBase: API_BASE, requestPath: path, preferredSource },
		);
		if (source !== undefined && result.status >= 200 && result.status < 300) {
			preferredSource = source;
		}
		return result;
	};
}

function assertSourceResponse(
	result: WhoopFetchResult,
	endpoint: string,
): unknown {
	if (result.status === 401 || result.status === 403) {
		throw new Error(
			`whoop_owner_repair_required: ${String(result.status)} on ${endpoint}`,
		);
	}
	if (result.status === 429) {
		throw new Error(`whoop_rate_limited: 429 on ${endpoint}`);
	}
	if (result.status < 200 || result.status >= 300) {
		throw new Error(`whoop_http_${String(result.status)}: ${endpoint}`);
	}
	if (result.invalidJson) {
		throw new Error(`whoop_invalid_json: ${endpoint}`);
	}
	return result.json;
}

export async function fetchBootstrap(
	fetchPath: WhoopFetch,
): Promise<WhoopBootstrap> {
	const result = await fetchPath(BOOTSTRAP_PATH);
	return parseBootstrapResponse(assertSourceResponse(result, "bootstrap"));
}

export async function probeWhoopReadinessPage(
	page: Page,
): Promise<WhoopBootstrap | null> {
	await page
		.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	const result = await makeWhoopPageFetch(page)(BOOTSTRAP_PATH);
	if (result.status === 401 || result.status === 403) {
		return null;
	}
	return parseBootstrapResponse(
		assertSourceResponse(result, "bootstrap-after-owner-login"),
	);
}

/** Readiness check for the owner's sign-in tab. Do not navigate it: while
 *  WHOOP auth can open an identity-provider popup, the opener may remain on
 *  the app origin with refreshed cookie/localStorage credentials. Probe only
 *  after that page is back on the app origin. */
export async function probeWhoopReadinessOnOwnerPage(
	page: Page,
): Promise<WhoopBootstrap | null> {
	try {
		if (new URL(page.url()).origin !== APP_URL) return null;
	} catch {
		return null;
	}
	let result: WhoopFetchResult;
	try {
		result = await makeWhoopPageFetch(page)(BOOTSTRAP_PATH);
	} catch {
		// A poll can race the owner tab's navigation back from the identity
		// provider. Retry on the next interval after the execution context settles.
		return null;
	}
	if (result.status === 0 || result.status === 401 || result.status === 403) {
		return null;
	}
	return parseBootstrapResponse(
		assertSourceResponse(result, "bootstrap-after-owner-login"),
	);
}

export function whoopAllowsInteractiveAuthRepair(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const trigger = env.PDPP_RUN_TRIGGER_KIND?.trim();
	return !trigger || trigger === "manual";
}

export async function ensureWhoopSession(args: {
	assist?: EnsureSessionArgs["assist"];
	capture?: Parameters<typeof manualBrowserLogin>[0]["capture"];
	completeAssistance?: EnsureSessionArgs["completeAssistance"];
	fetchPath: WhoopFetch;
	interactive: boolean;
	manualLogin?: () => Promise<void>;
	page: Page;
	sendInteraction: EnsureSessionArgs["sendInteraction"];
}): Promise<void> {
	await args.page
		.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	const initial = await args.fetchPath(BOOTSTRAP_PATH);
	if (initial.status >= 200 && initial.status < 300) {
		parseBootstrapResponse(assertSourceResponse(initial, "bootstrap"));
		return;
	}
	if (initial.status !== 401 && initial.status !== 403) {
		assertSourceResponse(initial, "bootstrap");
	}
	if (!args.interactive) {
		throw new Error(
			"whoop_owner_repair_required: unattended refresh cannot open interactive login",
		);
	}
	if (args.manualLogin) {
		await args.manualLogin();
	} else {
		await manualBrowserLogin({
			...(args.assist ? { assist: args.assist } : {}),
			...(args.capture ? { capture: args.capture } : {}),
			...(args.completeAssistance
				? { completeAssistance: args.completeAssistance }
				: {}),
			isProbeSuccessful: (bootstrap) => bootstrap !== null,
			message:
				"Sign in to WHOOP in the secure browser. The connector will continue automatically once the session is live.",
			page: args.page,
			probe: async () => {
				const reprobe = await args.fetchPath(BOOTSTRAP_PATH);
				return parseBootstrapResponse(
					assertSourceResponse(reprobe, "bootstrap-after-owner-login"),
				);
			},
			readinessProbe: probeWhoopReadinessOnOwnerPage,
			readinessProbeOnHandoffPage: true,
			reason: "login",
			sendInteraction: args.sendInteraction,
			timeoutSeconds: 1800,
		});
	}
	const reprobe = await args.fetchPath(BOOTSTRAP_PATH);
	parseBootstrapResponse(
		assertSourceResponse(reprobe, "bootstrap-after-owner-login"),
	);
}

function addDays(value: Date, days: number): Date {
	return new Date(value.getTime() + days * DAY_MS);
}

function cursorThrough(
	state: Record<string, unknown>,
	stream: string,
): string | null {
	const streamState = state[stream];
	if (
		!streamState ||
		typeof streamState !== "object" ||
		Array.isArray(streamState)
	) {
		return null;
	}
	const through = Reflect.get(streamState, "through");
	return typeof through === "string" && Number.isFinite(Date.parse(through))
		? through
		: null;
}

function earliestAggregateCursor(
	state: Record<string, unknown>,
	requested: ReadonlySet<string>,
): string | null {
	const values = AGGREGATE_STREAMS.filter((stream) => requested.has(stream))
		.map((stream) => cursorThrough(state, stream))
		.filter((value): value is string => value !== null)
		.sort((left, right) => left.localeCompare(right));
	return values[0] ?? null;
}

function historyStart(bootstrap: WhoopBootstrap, cursor: string | null): Date {
	if (cursor) {
		return addDays(new Date(cursor), -OVERLAP_DAYS);
	}
	// WHOOP does not document account.created_at as an exhaustive-history
	// guarantee, but owner data cannot practically predate account creation.
	const candidate = bootstrap.account.created_at;
	return new Date(
		candidate && Number.isFinite(Date.parse(candidate))
			? candidate
			: HISTORY_FALLBACK,
	);
}

function cyclesPath(userId: number, start: Date, end: Date): string {
	const query = new URLSearchParams({
		id: String(userId),
		startTime: start.toISOString(),
		endTime: end.toISOString(),
	});
	return `/core-details-bff/v0/cycles/details?${query.toString()}`;
}

async function emitAggregateRecord(
	record: WhoopCycleRecord,
	requested: ReadonlySet<string>,
	emitRecord: CollectWhoopArgs["emitRecord"],
): Promise<void> {
	if (requested.has("cycles")) {
		await emitRecord("cycles", cycleRecord(record));
	}
	if (requested.has("recoveries")) {
		const recovery = recoveryRecord(record);
		if (recovery) {
			await emitRecord("recoveries", recovery);
		}
	}
	if (requested.has("sleeps")) {
		for (const sleep of sleepRecords(record)) {
			await emitRecord("sleeps", sleep);
		}
	}
	if (requested.has("workouts")) {
		for (const workout of workoutRecords(record)) {
			await emitRecord("workouts", workout);
		}
	}
}

export async function collectWhoop(args: CollectWhoopArgs): Promise<void> {
	const bootstrap = await fetchBootstrap(args.fetchPath);
	if (args.requested.has("profile")) {
		await args.emitRecord("profile", profileRecord(bootstrap));
		await args.emit({
			type: "STATE",
			stream: "profile",
			cursor: { observed_at: args.now.toISOString() },
		});
	}
	if (args.requested.has("body")) {
		await args.emitRecord("body", bodyRecord(bootstrap));
		await args.emit({
			type: "STATE",
			stream: "body",
			cursor: { observed_at: args.now.toISOString() },
		});
	}

	const requestedAggregates = AGGREGATE_STREAMS.filter((stream) =>
		args.requested.has(stream),
	);
	if (requestedAggregates.length === 0) {
		return;
	}

	let start = historyStart(
		bootstrap,
		earliestAggregateCursor(args.state, args.requested),
	);
	let windows = 0;
	while (start < args.now) {
		if (windows >= MAX_WINDOWS) {
			throw new Error(
				"whoop_incomplete_pagination: history exceeded bounded window guard",
			);
		}
		const end = new Date(
			Math.min(addDays(start, WINDOW_DAYS).getTime(), args.now.getTime()),
		);
		const path = cyclesPath(bootstrap.user.id, start, end);
		const records = parseCyclesResponse(
			assertSourceResponse(await args.fetchPath(path), "cycles/details"),
		);
		for (const record of records) {
			await emitAggregateRecord(record, args.requested, args.emitRecord);
		}
		start = end;
		windows += 1;
	}

	for (const stream of requestedAggregates) {
		await args.emit({
			type: "STATE",
			stream,
			cursor: { through: args.now.toISOString() },
		});
	}
}

// Kept exported for hermetic tests that need to prove invalid JSON without a browser.
export const parseFetchTextForTest = decodeJsonResponse;

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "whoop",
		validateRecord,
		retryablePattern:
			/ECONN|ETIMEDOUT|timeout|whoop_rate_limited|whoop_http_5\d\d/i,
		browser: { profileName: "whoop" },
		async ensureSession({
			assist,
			capture,
			completeAssistance,
			page,
			sendInteraction,
		}) {
			const fetchPath = makeWhoopPageFetch(page);
			await ensureWhoopSession({
				assist,
				...(capture ? { capture } : {}),
				completeAssistance,
				fetchPath,
				interactive: whoopAllowsInteractiveAuthRepair(),
				page,
				sendInteraction,
			});
		},
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectWhoop({
				emit: ctx.emit,
				emitRecord: ctx.emitRecord,
				fetchPath: makeWhoopPageFetch(ctx.page),
				now: new Date(ctx.emittedAt),
				requested: new Set(ctx.requested.keys()),
				state: ctx.state,
			});
		},
	});
}
