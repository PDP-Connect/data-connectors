#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Slack browser connector (v0.1.0).
 *
 * The browser-session profile of the Slack source. `slack` stays the archive
 * profile (an archive tool over a pasted session token); this profile needs no
 * token from the owner. The owner signs in to Slack in the connector's own
 * browser, and collection calls the Slack Web API from that signed-in
 * app.slack.com page, exactly the way the web client does: same-origin
 * `fetch('/api/<method>')` with the session token the client keeps in local
 * storage. The token is read inside the page and never leaves it. Both
 * profiles declare the same source, and for every stream this profile
 * declares the record contract is the archive profile's, so a reader cannot
 * tell which profile collected a record.
 *
 * Streams: workspace, channels, users, messages (with message_attachments,
 * reactions and files hung off each message), user_groups, reminders, stars.
 * The archive profile's channel_stats, channel_memberships, canvases and
 * dm_read_states are not declared here: each would cost one call per
 * conversation for little that the other streams do not already say.
 *
 * Bounds: calls are paced and retried on Slack's rate-limit and 5xx answers;
 * each conversation is read back to the lookback floor (SLACK_LOOKBACK_DAYS,
 * default 7; 0 for everything) and at most MAX_PAGES_PER_CONVERSATION pages.
 * See collector.ts for the cursor and thread rules.
 *
 * Reachability probe: permanently exempt. Every method needs the owner's
 * session, and slack.com serves nothing useful unauthenticated (the
 * browser-automation-behind-a-login-wall case in CONNECTOR-CHECKLIST.md).
 *
 * Tested surfaces (as of 2026-09-28):
 *   - One workspace on a paid plan, signed in with Google, en-US
 *   - ~420 conversations, a week of history, bot-heavy channels
 *
 * Known untested:
 *   - Enterprise Grid workspaces and Slack Connect shared channels
 *   - Workspaces that require an app-approved browser or SSO re-prompt
 *   - Sign-in with a password, or with email magic link
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { readOptions } from "../../packages/polyfill-connectors/src/connector-options.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectSlackBrowser } from "./collector.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ConversationKind,
	SignedInTeam,
	SlackBrowserOptions,
} from "./types.ts";
import {
	APP_ORIGIN,
	createSlackApiClient,
	readSignedInTeams,
} from "./web-api.ts";

export const CLIENT_URL = `${APP_ORIGIN}/client`;
export const SIGNIN_URL = "https://slack.com/signin";
/**
 * A lightweight same-origin page to call the API from. Collection runs for a
 * long time, and the full web client would keep a socket open and compete
 * for the same rate limits.
 */
export const LIGHT_URL = `${APP_ORIGIN}/robots.txt`;
const CLIENT_LOAD_TIMEOUT_MS = 90_000;
const CLIENT_POLL_MS = 2000;
const SIGN_IN_TIMEOUT_S = 30 * 60;
const SIGN_IN_KEEPALIVE_MS = 60_000;
const CONVERSATION_KINDS: readonly ConversationKind[] = [
	"public",
	"private",
	"im",
	"mpim",
];
/** Where Slack parks a browser after sign-in: a "launch the desktop app" page on the workspace domain. */
const DESKTOP_LAUNCH_PATH_RE =
	/^\/(?:ssb\/redirect|ssb\/signin_redirect|checkcookie)/;
const SIGNIN_PATH_RE = /\/signin/;
const WORKSPACE_PREFIX_RE = /^https?:\/\//;
const WORKSPACE_SUFFIX_RE = /\.slack\.com.*$/;
/** The record field scope.time_range applies to, per stream. Streams without a time field are never filtered. */
const TIME_RANGE_FIELD: Record<string, string> = {
	channels: "created_at",
	files: "created_at",
	messages: "sent_at",
	reminders: "scheduled_at",
	stars: "starred_at",
	user_groups: "created_at",
	workspace: "fetched_at",
};

export type SlackSessionPage = Pick<Page, "context">;
export type SlackClientPage = Pick<Page, "evaluate" | "goto" | "url">;

/**
 * Whether the browser profile holds a signed-in Slack session, without
 * navigating: the session cookie exists and the web client answers without
 * sending the browser to the sign-in page. It runs while the owner is part
 * way through signing in, so a false answer only means "not yet".
 */
export async function probeSlackSession(
	page: SlackSessionPage,
): Promise<boolean> {
	try {
		const context = page.context();
		const cookies = await context.cookies([
			`${APP_ORIGIN}/`,
			"https://slack.com/",
		]);
		if (
			!cookies.some(
				(cookie) => cookie.name === "d" && cookie.value.startsWith("xoxd-"),
			)
		) {
			return false;
		}
		const response = await context.request.get(CLIENT_URL, {
			maxRedirects: 5,
			timeout: 15_000,
		});
		try {
			return (
				response.status() === 200 &&
				!SIGNIN_PATH_RE.test(new URL(response.url()).pathname)
			);
		} finally {
			await response.dispose();
		}
	} catch {
		return false;
	}
}

export async function ensureSlackSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const {
		assist,
		capture,
		completeAssistance,
		page,
		progress,
		sendInteraction,
	} = args;
	if (await probeSlackSession(page)) {
		return;
	}
	await page.goto(SIGNIN_URL, { waitUntil: "domcontentloaded" });
	await progress(
		"Sign in to Slack in the browser window that just opened. Collection continues on its own once the session is live.",
	);
	// A host that does not act on ASSISTANCE sees nothing while the owner
	// signs in, and one such host stops a run that is silent for too long.
	const keepalive = setInterval(() => {
		progress(
			"Still waiting for you to sign in to Slack in the browser window.",
		).catch((): undefined => undefined);
	}, SIGN_IN_KEEPALIVE_MS);
	let ready: boolean;
	try {
		ready = await manualBrowserLogin({
			assist,
			capture,
			completeAssistance,
			isProbeSuccessful: (ok) => ok === true,
			message:
				"Sign in to Slack in the secure browser, then continue. PDPP will verify the session before collecting.",
			page,
			probe: () => probeSlackSession(page),
			readinessProbe: probeSlackSession,
			readinessProbeOnHandoffPage: true,
			sendInteraction,
			timeoutSeconds: SIGN_IN_TIMEOUT_S,
		});
	} finally {
		clearInterval(keepalive);
	}
	if (!ready) {
		throw new Error("slack_browser_session_missing");
	}
}

/**
 * Load the web client so it writes its local config, then move to the light
 * page the API is called from. Returns the signed-in workspaces, or nothing
 * when the client did not load a session within the timeout.
 */
export async function openSlackClient(
	page: SlackClientPage,
	pollMs = CLIENT_POLL_MS,
	timeoutMs = CLIENT_LOAD_TIMEOUT_MS,
): Promise<SignedInTeam[]> {
	await page.goto(CLIENT_URL, { waitUntil: "domcontentloaded" });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const teams = await readSignedInTeams(page);
		if (teams.length > 0) {
			await page.goto(LIGHT_URL, { waitUntil: "domcontentloaded" });
			return teams;
		}
		if (Date.now() >= deadline) {
			return [];
		}
		await politeDelay(pollMs);
		const here = new URL(page.url());
		if (
			here.origin !== APP_ORIGIN ||
			DESKTOP_LAUNCH_PATH_RE.test(here.pathname)
		) {
			await page.goto(CLIENT_URL, { waitUntil: "domcontentloaded" });
		}
	}
}

function isConversationKind(value: string): value is ConversationKind {
	return (CONVERSATION_KINDS as readonly string[]).includes(value);
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

export function readSlackBrowserOptions(): SlackBrowserOptions {
	const parsed = readOptions(null, {
		envPrefix: "SLACK_",
		fields: {
			LOOKBACK_DAYS: { parse: "int", default: 7 },
			CHANNEL_ALLOWLIST: { parse: "csv", default: [] },
			CHANNEL_TYPES: { parse: "csv", default: [...CONVERSATION_KINDS] },
			WORKSPACE: { parse: "string", default: "" },
		},
	});
	const kinds = stringList(parsed.CHANNEL_TYPES)
		.map((kind) => kind.toLowerCase())
		.filter(isConversationKind);
	return {
		channelAllowlist: stringList(parsed.CHANNEL_ALLOWLIST),
		channelTypes: kinds.length > 0 ? kinds : [...CONVERSATION_KINDS],
		lookbackDays:
			typeof parsed.LOOKBACK_DAYS === "number" && parsed.LOOKBACK_DAYS >= 0
				? parsed.LOOKBACK_DAYS
				: 7,
		workspace:
			typeof parsed.WORKSPACE === "string" ? parsed.WORKSPACE.trim() : "",
	};
}

/** The signed-in workspaces to read: all of them, or the one SLACK_WORKSPACE names by subdomain, id or name. */
export function selectTeams(
	teams: readonly SignedInTeam[],
	workspace: string,
): SignedInTeam[] {
	if (workspace === "") {
		return [...teams];
	}
	const wanted = workspace
		.replace(WORKSPACE_PREFIX_RE, "")
		.replace(WORKSPACE_SUFFIX_RE, "")
		.toLowerCase();
	return teams.filter(
		(team) =>
			team.id.toLowerCase() === wanted ||
			team.domain.toLowerCase() === wanted ||
			team.name.toLowerCase() === wanted,
	);
}

async function skipEveryStream(
	ctx: BrowserCollectContext,
	reason: string,
	message: string,
): Promise<void> {
	for (const stream of ctx.requested.keys()) {
		await ctx.emit({ type: "SKIP_RESULT", stream, reason, message });
	}
}

/** `timing` is a test seam: how the web client's load is polled. */
export async function collect(
	ctx: BrowserCollectContext,
	timing: { pollMs?: number; timeoutMs?: number } = {},
): Promise<void> {
	const options = readSlackBrowserOptions();
	const signedIn = await openSlackClient(
		ctx.page,
		timing.pollMs,
		timing.timeoutMs,
	);
	if (signedIn.length === 0) {
		await skipEveryStream(
			ctx,
			"sign_in_required",
			"The Slack web client loaded without a signed-in workspace. Sign in again and run the connector once more.",
		);
		return;
	}
	const teams = selectTeams(signedIn, options.workspace);
	if (teams.length === 0) {
		await skipEveryStream(
			ctx,
			"workspace_not_signed_in",
			`SLACK_WORKSPACE names ${options.workspace}, but this browser is signed in to ${signedIn.map((team) => team.domain || team.id).join(", ")}.`,
		);
		return;
	}
	await collectSlackBrowser(
		ctx,
		{
			api: createSlackApiClient(ctx.page, { sleep: politeDelay }),
			now: () => new Date(),
		},
		teams,
		options,
	);
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "slack_browser",
		validateRecord,
		timeRangeField: (stream) => TIME_RANGE_FIELD[stream] ?? "sent_at",
		retryablePattern: /ECONN|ETIMEDOUT|fetch failed|network_error|ratelimited/i,
		browser: { profileName: "slack_browser" },
		ensureSession: ensureSlackSession,
		probeSession: ({ page }) => probeSlackSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collect(ctx),
	});
}
