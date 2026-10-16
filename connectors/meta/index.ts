#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Meta (Instagram) Connector (v0.4.11)
 *
 * Replaces the two legacy Playwright connectors
 * (`connectors/meta/instagram-playwright.js`,
 * `connectors/meta/instagram-ads-playwright.js`) with one connector and one
 * browser profile, per
 * docs/migration/connector-cutover/CONTRACTS.md D6.
 *
 * Login is manual only. Instagram aggressively rate-limits and challenges
 * automated credential entry (see the legacy connector's extensive
 * cookie-banner/2FA/headed-fallback handling), and the manifest declares
 * `human_interaction: ["manual_action"]` / `background_safe: false`
 * accordingly — there is no `AuthConfig`/env-credential auto-login here,
 * unlike reddit or amazon. `ensureSession` hands the page to the owner via
 * `manualBrowserLogin` and re-probes the session cookie until it appears.
 *
 * Streams (docs/migration/connector-cutover/capability-map.json D6), all
 * confirmed live 2026-09-22 against an authenticated account:
 *   profile      `/accounts/web_info/` supplies authenticated identity and
 *                basic fields. A profile navigation then passively captures
 *                one of the three legacy profile GraphQL operations and
 *                polls for its user. Counts and verified status come only
 *                from that observed user; missing enrichment emits a partial
 *                record plus a stream failure.
 *   posts        the owner's own timeline feed connection
 *                (`xdt_api__v1__feed__user_timeline_graphql_connection`),
 *                observed passively off the real `POST /graphql/query`
 *                (`PolarisProfilePostsQuery`) the profile page's own client
 *                JS issues — that request requires page-minted
 *                `fb_dtsg`/`lsd`/`jazoest`/`doc_id` anti-bot tokens and
 *                cannot be constructed from a bare `fetch()` call (confirmed
 *                live; see `fetchAllPosts`'s header note). Declared
 *                `incremental: false` / `coverage_strategy: full_inventory`
 *                (manifests/meta.json). A successful terminal empty
 *                timeline emits completion STATE; other runs walk the full
 *                timeline (no server-provided early-stop cursor is
 *                confirmed) — a second run's re-emit of unchanged posts is
 *                an idempotent id-keyed upsert, not incremental savings yet.
 *   post_likes   child stream of posts (D3): (post, liker) pairs from each
 *                post's `facepile_top_likers` sample. Instagram's web
 *                surface has no full-likers listing endpoint reachable from
 *                a logged-in session — this is a bounded top-likers sample,
 *                not full coverage. See "Known limitations" below.
 *   following    `/api/v1/friendships/{userId}/following/` — paginated,
 *                walked to completion (or reportStreamFailure if the safety
 *                ceiling is hit; see D6, "legacy capped at ~1000, modern must
 *                be complete or report honest coverage"). Confirmed live:
 *                walked to `has_next_page: false` with no failure, 19/19
 *                accounts stable and duplicate-free across two live runs.
 *   ads          Accounts Center DOM scrape (advertisers, ad topics,
 *                targeting categories) merged into one stream with a `kind`
 *                discriminator, per D6's merge of the two legacy connectors.
 *                Accounts Center's UI has visibly changed since the legacy
 *                connectors were written (confirmed live: no bare
 *                "advertisers" list button on first render in one run,
 *                present on a later run of the same session — see "Known
 *                limitations").
 *
 * Known limitations (documented per docs/reference/connector-authoring-guide.md §11):
 *   - post_likes is a bounded top-likers sample per post (Instagram's own
 *     API limit), not the full likers list. There is no known logged-in web
 *     endpoint that returns a post's complete liker list at scale without
 *     per-post UI navigation, which the legacy connector never did either.
 *     Unverified against a real post with real likers: the live test
 *     account has zero posts, so this path is proven by parser unit tests
 *     and a synthetic-but-shape-calibrated pilot fixture, not a live emit.
 *   - posts/post_likes coverage is proven structurally (the request is
 *     observed and parsed correctly) but not against real post data — the
 *     live account has 0 posts. `pilot-real-shape/records/{posts,post_likes}.jsonl`
 *     are synthetic-but-shape-calibrated, not real-derived, for this reason.
 *   - ads scraping depends on Accounts Center's ARIA dialog structure
 *     (`[role="dialog"] [role="list"] [role="listitem"]`), also used by
 *     both legacy connectors. The signed v0.4.1 implementation used fixed
 *     delays before reading these surfaces, while the legacy implementation
 *     waited for matching selectors. v0.4.2 waits for each intended
 *     control/list. v0.4.3 adds bounded failure-step diagnostics, but no
 *     retained sanitized trace identifies which step failed in the latest
 *     partial ads run. A live run on 2026-10-16 found the drift: advertisers
 *     open from the "Manage info" tab ("Advertisers using your activity or
 *     information") and load through "See more"; the ad-topics dialog words
 *     its empty state "You don't currently have any activity-based topics";
 *     the live dialogs carry no ARIA totals. A list without totals counts as
 *     complete only after its own "See more"/"View all" control was clicked
 *     until it was gone and every click loaded rows.
 *     Empty ARIA lists count as reached only when the matching visible
 *     source-authored empty message is present in the active dialog.
 *   - Tested surface: single-account, EN locale, personal (non-business)
 *     account (see the connector cutover report's Live evidence section
 *     for exact per-stream counts and the two-run incremental proof).
 *   - Reachability probe: permanently exempt. This connector is
 *     browser-automation-only against a login wall with no fixed,
 *     unauthenticated-probeable public endpoint (per
 *     packages/polyfill-connectors/CONNECTOR-CHECKLIST.md's Preview-level
 *     exemption rule).
 *
 * CHANGES
 *   v0.4.25 — restores legacy profile capture, stream-gap reporting, initial
 *     posts polling/fallback scroll, authenticated readiness, bounded
 *     navigation retries, and expansion-first category collection.
 *   v0.4.11 (2026-09-30) — requires exact empty evidence for ads surfaces and
 *     a successful terminal empty response for posts completion.
 *   v0.4.4 (2026-09-24) — keep the read-only session-cookie readiness probe
 *     in the owner's sign-in tab instead of opening a sibling about:blank tab.
 *   v0.4.3 (2026-09-24) — reports bounded failure steps for incomplete ads
 *     surfaces so a later sanitized trace can identify the failed UI step.
 *   v0.4.2 (2026-09-24) — waits for Accounts Center's interactive controls
 *     and lists before scraping each ad surface; replaces fixed sleeps that
 *     could sample the DOM before asynchronous dialog/tab content loaded.
 *   v0.4.0 (2026-09-24) — preserves every legacy top-liker field, including
 *     empty profile_pic_url values; adds required liker_ordinal and changes
 *     the post_likes primary key to (post_id, liker_ordinal).
 *   v0.3.3 (2026-09-22) — fills profile.follower_count/following_count/
 *     post_count from a passively observed profile-page GraphQL response
 *     using the same query the legacy connector captured for these fields;
 *     null when the response isn't observed within the timeout, never guessed.
 *   v0.3.1 (2026-09-22) — fixed two live-only defects found on first live
 *     run: (1) `about:blank` origin on the session-cookie-already-live fast
 *     path made every in-page fetch fail closed (`ensureInstagramOrigin`,
 *     mirrors reddit's `ensureRedditJsonOrigin`); (2) `web_info` actually
 *     returns HTML with an embedded Polaris JSON tuple, not a flat JSON
 *     envelope as the original scaffold assumed — rewrote `fetchWebInfoUser`
 *     to parse it, using an iterative (not recursive-named-function) walk
 *     to dodge a `tsx`/esbuild `__name is not defined` in-page-evaluate
 *     transform artifact. Also replaced the invented (404, live-confirmed)
 *     `/api/v1/feed/user/self/` posts endpoint with passive
 *     `page.waitForResponse` capture of the real request, added posts STATE,
 *     and normalized empty-string web_info fields to null.
 *   v0.4.1 (2026-09-24) — owner sign-in assistance now auto-resumes
 *     once the Instagram session cookie is live.
 *   v0.3.0 (2026-09-22) — real collector replacing the
 *     `instagram_graphql_wiring_pending` scaffold; merges both legacy
 *     connectors' streams into profile/posts/post_likes/following/ads per D6.
 *   v0.1.0 — scaffold: session probe only, unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Frame, Page, Request } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	createConnectorFailure,
	type EnsureSessionArgs,
	emitDetailCoverage,
	type ProbeSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { CaptureSession } from "../../packages/polyfill-connectors/src/fixture-capture.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import {
	buildAdRecords,
	dedupeFollowingByUsername,
	FOLLOWING_MAX_PAGES,
	FOLLOWING_PAGE_LIMIT,
	followingRecord,
	postLikeRecords,
	postRecord,
	profileCountsFromGraphQL,
	profileEnrichmentIsComplete,
	profileRecord,
	profileSourceFieldsAreReadable,
} from "./parsers.ts";
import { adsSchema, followingSchema, profileSchema, validateRecord } from "./schemas.ts";
import type {
	InstagramFollowingPage,
	InstagramFollowingUser,
	InstagramProfilePageEnvelope,
	InstagramProfilePageUser,
	InstagramTimelineConnection,
	InstagramTimelineEdge,
	InstagramWebInfoUser,
} from "./types.ts";

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const ACCOUNTS_CENTER_ORIGIN = "https://accountscenter.instagram.com";
const SESSION_COOKIE_RE = /sessionid|ds_user_id/;
const NAVIGATION_ATTEMPTS = 3;
const POSTS_MAX_PAGES = 100;
const ADS_REQUIRED_SURFACES = [
	"advertisers",
	"ad_topics",
	"targeting_categories",
] as const;

type AdsSurface = (typeof ADS_REQUIRED_SURFACES)[number];
type AdsSurfaceStep =
	| "navigation_failed"
	| "control_not_found"
	| "destination_list_not_found"
	| "page_script_failed"
	| "reached_empty";

interface ReachedScrape<T> {
	items: T[];
	reached: boolean;
	step: AdsSurfaceStep | null;
	surface: AdsSurface;
}

// ─── Session ────────────────────────────────────────────────────────────

async function hasSessionCookie(
	context: BrowserCollectContext["context"],
): Promise<boolean> {
	const cookies = await context.cookies(`${INSTAGRAM_ORIGIN}/`);
	return cookies.some(
		(c) => SESSION_COOKIE_RE.test(c.name) && Boolean(c.value),
	);
}

async function hasAuthenticatedWebInfo(page: Page): Promise<boolean> {
	const user = await fetchWebInfoUser(page);
	return Boolean(user && profileRecord(user));
}

async function safeGoto(
	page: Page,
	url: string,
	beforeAttempt?: () => void,
): Promise<boolean> {
	for (let attempt = 0; attempt < NAVIGATION_ATTEMPTS; attempt += 1) {
		beforeAttempt?.();
		try {
			await page.goto(url, {
				timeout: 30_000,
				waitUntil: "domcontentloaded",
			});
			return true;
		} catch {
			// Retry transient navigation failures within the fixed attempt budget.
		}
	}
	return false;
}

export async function probeMetaSession({
	context,
	page,
}: ProbeSessionArgs): Promise<boolean> {
	return (
		(await hasSessionCookie(context)) && (await hasAuthenticatedWebInfo(page))
	);
}

export async function ensureMetaSession({
	assist,
	completeAssistance,
	context,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	if (await hasSessionCookie(context)) {
		return;
	}
	await manualLoginHandoff({
		assist,
		completeAssistance,
		context,
		page,
		sendInteraction,
	});
}

async function manualLoginHandoff({
	assist,
	completeAssistance,
	context,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	"assist" | "completeAssistance" | "context" | "page" | "sendInteraction"
>): Promise<void> {
	await safeGoto(page, `${INSTAGRAM_ORIGIN}/accounts/login/`);

	await manualBrowserLogin({
		assist,
		completeAssistance,
		isProbeSuccessful: (live) => live,
		message:
			"Log in to Instagram. The connector will continue automatically once the session is live.",
		page,
		probe: async () =>
			(await hasSessionCookie(context)) &&
			(await hasAuthenticatedWebInfo(page)),
		readinessProbe: async () =>
			(await hasSessionCookie(context)) &&
			(await hasAuthenticatedWebInfo(page)),
		readinessProbeOnHandoffPage: true,
		reason: "login",
		sendInteraction,
		timeoutSeconds: 1800,
	});

	const live =
		(await hasSessionCookie(context)) && (await hasAuthenticatedWebInfo(page));
	if (!live) {
		throw new Error(
			"meta_login_manual_incomplete: session cookie not present after handoff",
		);
	}
}

// ─── Fetch through the page (preserves session cookie + anti-bot) ────────

/**
 * Put the page on {@link INSTAGRAM_ORIGIN} so a credentialed same-origin
 * `fetch` is possible at all. Every in-page fetch below runs from whatever
 * page the runtime handed `collect()`, which is `about:blank` on the
 * session-cookie-already-live fast path (`ensureMetaSession` only navigates
 * on the manual-login branch) — an unnavigated page has no valid `fetch`
 * origin and every request fails closed with `status: 0`. Mirrors reddit's
 * `ensureRedditJsonOrigin` (src/auto-login/reddit.ts): a no-op once already
 * on-origin, so repeated calls across the many fetches in one run are cheap.
 */
async function ensureInstagramOrigin(page: Page): Promise<boolean> {
	try {
		if (new URL(page.url()).origin === INSTAGRAM_ORIGIN) {
			return true;
		}
	} catch {
		// An unnavigated page (`about:blank`) has no parseable origin — fall
		// through and navigate rather than treating it as a fault.
	}
	return safeGoto(page, `${INSTAGRAM_ORIGIN}/`);
}

async function instagramFetch<T>(
	page: Page,
	path: string,
	headers: Record<string, string> = {},
): Promise<{ json: T | null; status: number }> {
	if (!(await ensureInstagramOrigin(page))) {
		return { json: { error: "instagram_origin_unavailable" } as T, status: 0 };
	}
	return (await page.evaluate(
		async ({ headers: h, origin, path: evalPath }) => {
			try {
				const res = await fetch(`${origin}${evalPath}`, {
					credentials: "include",
					headers: { "x-requested-with": "XMLHttpRequest", ...h },
				});
				const { status } = res;
				let json: unknown = null;
				try {
					json = await res.json();
				} catch {
					json = null;
				}
				return { json, status };
			} catch (err) {
				return { json: { error: String(err) }, status: 0 };
			}
		},
		{ headers, origin: INSTAGRAM_ORIGIN, path },
	)) as { json: T | null; status: number };
}

// ─── Profile (web_info) ───────────────────────────────────────────────────

/**
 * `/accounts/web_info/` returns a full HTML document (confirmed live
 * 2026-09-22, status 200, `content-type` HTML) with the logged-in user's
 * data embedded in one of several `<script type="application/json"
 * data-sjs>` tags as a `["PolarisViewer", <viewerId>, {"data": {...
 * user fields ...}}]` tuple — not a flat JSON envelope as an earlier
 * version of this comment assumed. This does NOT carry
 * follower_count/following_count/media_count (confirmed absent from the
 * live payload); those come from `profile.follower_count` etc. only when a
 * live capture proves a reachable source — see the header's "Known
 * limitations" note on `profile` counts.
 */
export async function fetchWebInfoUser(
	page: Page,
): Promise<InstagramWebInfoUser | null> {
	if (!(await ensureInstagramOrigin(page))) {
		return null;
	}
	try {
		return (await page.evaluate(async (origin) => {
		try {
			const response = await fetch(`${origin}/accounts/web_info/`, {
				credentials: "include",
				headers: { "X-Requested-With": "XMLHttpRequest" },
			});
			if (!response.ok) {
				return null;
			}
			const html = await response.text();
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, "text/html");
			const scripts = doc.querySelectorAll(
				'script[type="application/json"][data-sjs]',
			);

			// Iterative (not recursive-named-function) walk: a nested named
			// function declared inside this page.evaluate closure fails at
			// runtime with `ReferenceError: __name is not defined` (confirmed
			// live 2026-09-22) — tsx's esbuild transform injects a `__name()`
			// call to preserve Function.prototype.name, but that helper only
			// exists in the Node-side bundle, not inside the
			// serialized-and-reparsed in-page closure Playwright actually
			// executes. An explicit stack avoids declaring any named function
			// value inside this closure.
			for (const script of scripts) {
				try {
					const jsonContent: unknown = JSON.parse(script.textContent ?? "");
					const stack: unknown[] = [jsonContent];
					while (stack.length > 0) {
						const node = stack.pop();
						if (!node || typeof node !== "object") {
							continue;
						}
						if (
							Array.isArray(node) &&
							node[0] === "PolarisViewer" &&
							node.length >= 3
						) {
							const found = (node[2] as { data?: unknown } | null)?.data;
							if (found) {
								return found;
							}
							continue;
						}
						for (const key in node as Record<string, unknown>) {
							if (Object.hasOwn(node as Record<string, unknown>, key)) {
								stack.push((node as Record<string, unknown>)[key]);
							}
						}
					}
				} catch {
					// Not every data-sjs script is the Polaris viewer blob; skip.
				}
			}
			return null;
		} catch {
			return null;
		}
		}, INSTAGRAM_ORIGIN)) as InstagramWebInfoUser | null;
	} catch {
		return null;
	}
}

// ─── Profile counts (profile-page GraphQL) ────────────────────────────────

export function isProfilePageGraphQLResponse(response: {
	request: () => {
		method: () => string;
		postData?: () => string | null;
		headers?: () => Record<string, string>;
	};
	url: () => string;
}): boolean {
	const request = response.request();
	const operation =
		request.postData?.() ?? request.headers?.()["x-fb-friendly-name"] ?? "";
	// The profile query is served from `/api/graphql` (confirmed live
	// 2026-10-16, no trailing slash), the posts query from `/graphql/query`.
	return (
		/\/graphql(?:[/?]|$)/.test(response.url()) &&
		request.method() === "POST" &&
		/(?:PolarisProfilePageContentQuery|ProfilePageQuery|UserByUsernameQuery)/.test(
			operation,
		)
	);
}

type ProfileCaptureClock = { sleep: (ms: number) => Promise<void> };
const realProfileCaptureClock: ProfileCaptureClock = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const PROFILE_CAPTURE_INITIAL_DELAY_MS = 3_000;
const PROFILE_CAPTURE_POLL_INTERVAL_MS = 1_000;
const PROFILE_CAPTURE_MAX_POLLS = 30;

type ProfilePageResponse = Parameters<
	typeof isProfilePageGraphQLResponse
>[0] & {
	json: () => Promise<unknown>;
	status: () => number;
};

export async function waitForLegacyProfileCapture(
	matchingResponses: readonly ProfilePageResponse[],
	clock: ProfileCaptureClock = realProfileCaptureClock,
): Promise<ProfilePageResponse | null> {
	await clock.sleep(PROFILE_CAPTURE_INITIAL_DELAY_MS);
	for (let attempt = 0; attempt < PROFILE_CAPTURE_MAX_POLLS; attempt += 1) {
		const latest = matchingResponses.at(-1);
		if (latest) return latest;
		await clock.sleep(PROFILE_CAPTURE_POLL_INTERVAL_MS);
	}
	return matchingResponses.at(-1) ?? null;
}

/**
 * Profile fields come from one of the three legacy profile operations. A
 * missing or malformed user is an incomplete enrichment, not a complete
 * record with guessed nulls.
 */
export async function fetchProfilePageUser(
	page: Page,
	username: string,
	capture: CaptureSession | null,
	clock: ProfileCaptureClock = realProfileCaptureClock,
): Promise<InstagramProfilePageUser | null> {
	const matchingResponses: ProfilePageResponse[] = [];
	const onResponse = (response: ProfilePageResponse): void => {
		if (isProfilePageGraphQLResponse(response))
			matchingResponses.push(response);
	};
	page.on("response", onResponse);
	let response: ProfilePageResponse | null = null;
	try {
		if (
			!(await safeGoto(
				page,
				`${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`,
			))
		) {
			return null;
		}
		response = await waitForLegacyProfileCapture(matchingResponses, clock);
	} finally {
		page.off("response", onResponse);
	}
	if (!response) {
		return null;
	}
	if (response.status() < 200 || response.status() >= 300) return null;
	let envelope: InstagramProfilePageEnvelope | null = null;
	try {
		envelope = (await response.json()) as InstagramProfilePageEnvelope;
	} catch {
		envelope = null;
	}
	capture?.captureHttp("profile-page-user", envelope, {
		status: response.status(),
	});
	return envelope?.data?.user ?? null;
}

// ─── Posts (timeline feed connection) ─────────────────────────────────────

interface TimelineEnvelope {
	error?: unknown;
	errorCode?: unknown;
	error_code?: unknown;
	errors?: unknown[] | null;
	extensions?: {
		code?: unknown;
		is_final?: unknown;
		partial?: unknown;
	} | null;
	ok?: boolean;
	status?: unknown;
	data?: {
		xdt_api__v1__feed__user_timeline_graphql_connection?: InstagramTimelineConnection | null;
	} | null;
}

type CompleteTimelineConnection = InstagramTimelineConnection & {
	edges: InstagramTimelineEdge[];
	page_info: NonNullable<InstagramTimelineConnection["page_info"]> & {
		has_next_page: boolean;
	};
};

/**
 * The owner's own posts are served by a POST to `/graphql/query`
 * (`x-fb-friendly-name: PolarisProfilePostsQuery`, `x-root-field-name:
 * xdt_api__v1__feed__user_timeline_graphql_connection`) whose body carries
 * `fb_dtsg`/`lsd`/`jazoest`/`doc_id` anti-bot tokens minted by the page's own
 * client JS (confirmed live 2026-09-22 via network capture) — there is no
 * bare-fetchable v1 endpoint for this data, unlike `following`. This can only
 * be read by passively observing the request the profile page's own render
 * already issues, not by constructing an equivalent request from
 * `page.evaluate`. Matches the legacy connector's
 * `page.captureNetwork`/`getCapturedResponse` pattern, using Playwright's own
 * `waitForResponse` instead of that bespoke shim.
 */
type PostsTimelineRequest = Pick<
	Request,
	"headers" | "method" | "postData" | "url"
> & {
	frame: () => Frame;
};

function isPostsTimelineRequest(
	request: PostsTimelineRequest,
	page: Page,
): boolean {
	let responsePage: Page | undefined;
	let requestFrame: Frame;
	try {
		requestFrame = request.frame();
		responsePage = requestFrame.page();
	} catch {
		return false;
	}
	const operation = request.postData() ?? "";
	return (
		responsePage === page &&
		requestFrame === page.mainFrame() &&
		request.url().includes("/graphql/") &&
		request.method() === "POST" &&
		/(?:PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery)/.test(
			operation,
		)
	);
}

function postsRequestVariables(request: PostsTimelineRequest): unknown {
	const body = request.postData() ?? "";
	const rawVariables = new URLSearchParams(body).get("variables");
	if (rawVariables !== null) {
		try {
			return JSON.parse(rawVariables) as unknown;
		} catch {
			return null;
		}
	}
	try {
		const parsed = JSON.parse(body) as unknown;
		if (parsed && typeof parsed === "object" && "variables" in parsed) {
			return parsed.variables;
		}
		return parsed;
	} catch {
		return null;
	}
}

function valuesForVariableKeys(
	value: unknown,
	keys: ReadonlySet<string>,
): Array<string | number | null> {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) {
		return value.flatMap((child) => valuesForVariableKeys(child, keys));
	}
	const values: Array<string | number | null> = [];
	for (const [key, child] of Object.entries(value)) {
		if (keys.has(key.toLowerCase())) {
			if (
				typeof child === "string" ||
				typeof child === "number" ||
				child === null
			) {
				values.push(child);
			}
		} else {
			values.push(...valuesForVariableKeys(child, keys));
		}
	}
	return values;
}

const POSTS_USERNAME_VARIABLES = new Set([
	"username",
	"user_name",
	"target_username",
]);
const POSTS_USER_ID_VARIABLES = new Set([
	"user_id",
	"target_user_id",
	"page_id",
]);
const POSTS_CURSOR_VARIABLES = new Set([
	"after",
	"cursor",
	"max_id",
	"end_cursor",
	"next_max_id",
]);

function postsRequestTargetsOwner(
	request: PostsTimelineRequest,
	username: string,
	userId: string | undefined,
): boolean {
	const variables = postsRequestVariables(request);
	const usernames = valuesForVariableKeys(variables, POSTS_USERNAME_VARIABLES);
	const userIds = valuesForVariableKeys(variables, POSTS_USER_ID_VARIABLES);
	const expectedUsername = username.toLowerCase();
	const matchingUsername = usernames.some(
		(value) =>
			typeof value === "string" && value.toLowerCase() === expectedUsername,
	);
	const mismatchingUsername = usernames.some(
		(value) =>
			typeof value !== "string" || value.toLowerCase() !== expectedUsername,
	);
	const matchingUserId = Boolean(
		userId && userIds.some((value) => String(value) === userId),
	);
	const mismatchingUserId = Boolean(
		userId && userIds.some((value) => String(value) !== userId),
	);
	return (
		!mismatchingUsername &&
		!mismatchingUserId &&
		(matchingUsername || matchingUserId)
	);
}

function postsRequestHasCursor(
	request: PostsTimelineRequest,
	expectedCursor: string | null,
): boolean {
	const cursorValues = valuesForVariableKeys(
		postsRequestVariables(request),
		POSTS_CURSOR_VARIABLES,
	);
	const nonemptyCursors = cursorValues.filter(
		(value) => value !== null && value !== "",
	);
	if (expectedCursor === null) return nonemptyCursors.length === 0;
	return (
		nonemptyCursors.length > 0 &&
		nonemptyCursors.every((value) => String(value) === expectedCursor)
	);
}

function isPostsTimelineResponse(
	response: {
		request: () => PostsTimelineRequest;
		url: () => string;
	},
	page: Page,
): boolean {
	return (
		response.url().includes("/graphql/") &&
		isPostsTimelineRequest(response.request(), page)
	);
}

const POSTS_INITIAL_CAPTURE_DELAY_MS = 3_000;
const POSTS_CAPTURE_POLL_INTERVAL_MS = 1_000;
const POSTS_CAPTURE_MAX_POLLS = 30;

type PostsClock = {
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const realPostsClock: PostsClock = {
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		}),
};

/** Mirror the legacy runner's first populated polling tick; capture is last-wins. */
export async function waitForLegacyPostsCapture(
	matchingResponses: unknown[],
	clock: PostsClock = realPostsClock,
	signal?: AbortSignal,
): Promise<unknown | null> {
	await clock.sleep(POSTS_INITIAL_CAPTURE_DELAY_MS, signal);
	if (signal?.aborted) {
		return null;
	}
	for (let attempt = 0; attempt < POSTS_CAPTURE_MAX_POLLS; attempt += 1) {
		await clock.sleep(POSTS_CAPTURE_POLL_INTERVAL_MS, signal);
		if (signal?.aborted) {
			return null;
		}
		const latest = matchingResponses.at(-1);
		if (latest !== undefined) {
			return latest;
		}
	}
	return null;
}

function isLoginOrChallengeUrl(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return /\/(?:accounts\/login|challenge|challenge_action|accounts\/onetap)\b/.test(
			url.pathname,
		);
	} catch {
		return false;
	}
}

/**
 * Page-side login/challenge detector. It must stay self-contained because
 * Playwright serializes it into the page. Only challenge controls count:
 * the captcha widget, the email re-login form, the verification-code
 * inputs and a form posting to /challenge/. Bare words such as "challenge"
 * or "checkpoint" are ordinary profile text (a username, a bio) and prove
 * nothing; URL-level challenges are caught by isLoginOrChallengeUrl.
 */
export function pageShowsLoginOrChallengeControls(): boolean {
	const text = document.body?.innerText.toLowerCase() ?? "";
	return (
		(text.includes("verify you are human") &&
			Boolean(document.querySelector("[data-sitekey]"))) ||
		(text.includes("welcome back") &&
			Boolean(
				document.querySelector('input[type="email"], input[name="email"]'),
			)) ||
		Boolean(
			document.querySelector(
				'input[name="verificationCode"], input[name="security_code"], form[action*="/challenge/"]',
			),
		)
	);
}

async function hasLoginOrChallengePageState(page: Page): Promise<boolean> {
	if (isLoginOrChallengeUrl(page.url())) return true;
	try {
		await page.waitForFunction(pageShowsLoginOrChallengeControls, undefined, {
			timeout: 500,
		});
		return true;
	} catch {
		return false;
	}
}

type PostsTimelineResponse = Parameters<typeof isPostsTimelineResponse>[0] & {
	json: () => Promise<unknown>;
	status: () => number;
};

async function readTimelineConnection(response: {
	json: () => Promise<unknown>;
	status: () => number;
}): Promise<CompleteTimelineConnection | null> {
	const status = response.status();
	if (status < 200 || status >= 300) {
		return null;
	}
	try {
		const body = (await response.json()) as TimelineEnvelope;
		if (
			body?.ok === false ||
			body?.error !== undefined ||
			body?.errorCode !== undefined ||
			body?.error_code !== undefined ||
			(body?.status !== undefined && body.status !== "ok") ||
			body?.extensions?.code === "UNAUTHENTICATED" ||
			body?.extensions?.is_final === false ||
			body?.extensions?.partial === true ||
			(body?.errors != null &&
				(!Array.isArray(body.errors) || body.errors.length > 0))
		) {
			return null;
		}
		const connection =
			body?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
		const edges = connection?.edges;
		const pageInfo = connection?.page_info;
		if (
			!connection ||
			!Array.isArray(edges) ||
			edges.some(
				(edge) => !edge || typeof edge.node !== "object" || edge.node === null,
			) ||
			typeof pageInfo?.has_next_page !== "boolean"
		) {
			return null;
		}
		return {
			...connection,
			edges,
			page_info: {
				...pageInfo,
				has_next_page: pageInfo.has_next_page,
			},
		};
	} catch {
		return null;
	}
}

/**
 * A paginated walk failed after earlier pages were read and validated.
 * Carries those records so the caller can emit them before it reports the
 * stream failure: the run still fails, but the prefix is not thrown away.
 */
class PartialWalkFailure<T> extends Error {
	readonly partial: readonly T[];
	constructor(cause: unknown, partial: readonly T[]) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "PartialWalkFailure";
		this.partial = partial;
	}
}

/**
 * Walk the owner's own timeline feed connection to completion by navigating
 * to the profile page (which triggers the first page as a side effect of
 * rendering) and scrolling to trigger subsequent pages, capturing each
 * `PolarisProfilePostsQuery`-shaped response passively.
 */
export async function fetchAllPosts(
	page: Page,
	username: string,
	capture: CaptureSession | null,
	progress?: (
		message: string,
		extra?: Record<string, unknown>,
	) => Promise<void>,
	delay: (ms: number) => Promise<void> = politeDelay,
	postsClock: PostsClock = realPostsClock,
	expectedUserId?: string,
): Promise<{
	edges: InstagramTimelineEdge[];
	sourceEdgeCount: number;
	truncated: boolean;
}> {
	const edges: InstagramTimelineEdge[] = [];
	const seenIds = new Set<string>();
	let sawValidResponse = false;
	let sawTerminalPage = false;
	let sourceEdgeCount = 0;
	let terminalResponse: unknown = null;
	let initialPageWasTerminal = false;
	let unrecordableSourceEdges = 0;
	const matchingResponses: PostsTimelineResponse[] = [];
	const initialResponses: PostsTimelineResponse[] = [];
	let lastConsumedIndex = -1;
	let initialPageIndex = -1;
	let walkGeneration = 0;
	let documentGeneration = 0;
	let acceptedDocumentGeneration: number | null = null;
	let intendedNavigationUrl: string | null = null;
	let attemptNavigationRequests = new Set<Request>();
	let intendedNavigationResponseSeen = false;
	let expectedContinuationCursor: string | null = null;
	let legacyInitialCapture: Promise<unknown | null> | null = null;
	const legacyCaptureController = new AbortController();
	const requestGenerations = new WeakMap<
		Request,
		{ document: number; walk: number }
	>();
	const pageEvents = page as Page & {
		off?: (event: "response", listener: (response: unknown) => void) => void;
		on?: (event: "response", listener: (response: unknown) => void) => void;
	};
	const onFrameNavigated = (frame: Frame): void => {
		if (frame !== page.mainFrame()) return;
		documentGeneration += 1;
		acceptedDocumentGeneration = null;
		if (intendedNavigationUrl === null || !intendedNavigationResponseSeen) return;
		try {
			const intended = new URL(intendedNavigationUrl);
			const committed = new URL(frame.url());
			if (
				committed.origin === intended.origin &&
				committed.pathname === intended.pathname
			) {
				acceptedDocumentGeneration = documentGeneration;
			}
		} catch {
			acceptedDocumentGeneration = null;
		}
	};
	const onRequest = (request: Request): void => {
		if (intendedNavigationUrl !== null) {
			try {
				if (request.isNavigationRequest()) {
					const requestUrl = new URL(request.url());
					const intendedUrl = new URL(intendedNavigationUrl);
					const redirectedFrom = request.redirectedFrom();
					if (
						request.frame() === page.mainFrame() &&
						((requestUrl.origin === intendedUrl.origin &&
							requestUrl.pathname === intendedUrl.pathname) ||
							(redirectedFrom !== null &&
								attemptNavigationRequests.has(redirectedFrom)))
					) {
						attemptNavigationRequests.add(request);
					}
				}
			} catch {
				// Requests without an inspectable main-frame navigation cannot bind a document.
			}
		}
		if (
			acceptedDocumentGeneration !== null &&
			isPostsTimelineRequest(request, page) &&
			postsRequestTargetsOwner(request, username, expectedUserId)
		) {
			requestGenerations.set(request, {
				document: acceptedDocumentGeneration,
				walk: walkGeneration,
			});
		}
	};
	const responseMatchesCursor = (
		response: PostsTimelineResponse,
		cursor: string | null,
	): boolean => postsRequestHasCursor(response.request(), cursor);
	const responseIsCurrentWalk = (response: PostsTimelineResponse): boolean => {
		const generation = requestGenerations.get(response.request() as Request);
		return (
			generation?.walk === walkGeneration &&
			generation.document === acceptedDocumentGeneration
		);
	};
	const onResponse = (response: unknown): void => {
		try {
			const navigationResponse = response as {
				request: () => Request;
				status: () => number;
				url: () => string;
			};
			if (
				intendedNavigationUrl !== null &&
				attemptNavigationRequests.has(navigationResponse.request())
			) {
				const responseUrl = new URL(navigationResponse.url());
				const intendedUrl = new URL(intendedNavigationUrl);
				intendedNavigationResponseSeen =
					navigationResponse.status() >= 200 &&
					navigationResponse.status() < 300 &&
					responseUrl.origin === intendedUrl.origin &&
					responseUrl.pathname === intendedUrl.pathname;
			}
		} catch {
			// Non-Response events cannot identify the current navigation document.
		}
		if (
			isPostsTimelineResponse(
				response as Parameters<typeof isPostsTimelineResponse>[0],
				page,
			)
		) {
			const timelineResponse = response as PostsTimelineResponse;
			if (responseIsCurrentWalk(timelineResponse)) {
				matchingResponses.push(timelineResponse);
				if (responseMatchesCursor(timelineResponse, null)) {
					initialResponses.push(timelineResponse);
				}
			}
		}
	};
	const observesResponses = typeof pageEvents.on === "function";
	const observesRequests = typeof page.on === "function";
	pageEvents.on?.("response", onResponse);
	if (observesRequests) page.on("request", onRequest);
	page.on("framenavigated", onFrameNavigated);
	const stopObserving = (): void => {
		pageEvents.off?.("response", onResponse);
		if (observesRequests) page.off("request", onRequest);
		page.off("framenavigated", onFrameNavigated);
	};

	let walk: Awaited<ReturnType<typeof walkPagesWithCeiling>>;
	try {
		walk = await walkPagesWithCeiling({
			fetchPage: async (pageNumber) => {
				if (pageNumber === 1) {
					expectedContinuationCursor = null;
				}
				const expectedCursor =
					pageNumber === 1 ? null : expectedContinuationCursor;
				const queued = (): PostsTimelineResponse | undefined => {
					if (!observesResponses) return undefined;
					for (
						let index = lastConsumedIndex + 1;
						index < matchingResponses.length;
						index += 1
					) {
						const candidate = matchingResponses[index];
						if (candidate && responseMatchesCursor(candidate, expectedCursor)) {
							return candidate;
						}
					}
					return undefined;
				};
				let response = pageNumber === 1 ? undefined : queued();
				if (response === undefined) {
					const responsePromise: Promise<PostsTimelineResponse | null> = page
						.waitForResponse(
							(candidate) =>
								isPostsTimelineResponse(candidate, page) &&
								responseIsCurrentWalk(candidate as PostsTimelineResponse) &&
								responseMatchesCursor(
									candidate as PostsTimelineResponse,
									expectedCursor,
								),
							{ timeout: 15_000 },
						)
						.then((response) => response as PostsTimelineResponse)
						.catch(() => null);
					if (pageNumber === 1) {
						if (
							!(await safeGoto(
								page,
								`${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`,
								() => {
									// Requests and responses from each navigation attempt are
									// isolated; a delayed response from a failed attempt cannot
									// certify the successful retry.
									walkGeneration += 1;
									intendedNavigationUrl = `${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`;
									acceptedDocumentGeneration = null;
									attemptNavigationRequests = new Set();
									intendedNavigationResponseSeen = false;
									initialResponses.length = 0;
									lastConsumedIndex = matchingResponses.length - 1;
								},
							))
						) {
							throw new Error(
								"meta_posts_navigation_failed: profile timeline did not load",
							);
						}
						legacyInitialCapture = waitForLegacyPostsCapture(
							initialResponses,
							postsClock,
							legacyCaptureController.signal,
						);
					} else {
						try {
							await page.evaluate(() =>
								window.scrollTo(0, document.body.scrollHeight),
							);
						} catch {
							throw new Error(
								"meta_posts_navigation_failed: timeline page did not advance",
							);
						}
					}
					let awaited = await responsePromise;
					if (!awaited && pageNumber === 1) {
						awaited =
							(await legacyInitialCapture) as PostsTimelineResponse | null;
						if (!awaited) {
							const fallbackResponse = page
								.waitForResponse(
									(candidate) =>
										isPostsTimelineResponse(candidate, page) &&
										responseIsCurrentWalk(candidate as PostsTimelineResponse) &&
										responseMatchesCursor(
											candidate as PostsTimelineResponse,
											expectedCursor,
										),
									{ timeout: 15_000 },
								)
								.catch(() => null);
							try {
								await page.evaluate(() =>
									window.scrollTo(0, document.body.scrollHeight),
								);
							} catch {
								throw new Error(
									"meta_posts_navigation_failed: initial timeline fallback scroll failed",
								);
							}
							awaited = await fallbackResponse;
						}
					}
					if (!awaited) {
						return false;
					}
					response =
						queued() ??
						(awaited && responseIsCurrentWalk(awaited) ? awaited : undefined);
					if (!response) {
						return false;
					}
				}
				const consumedIndex = matchingResponses.indexOf(response);
				if (consumedIndex >= 0) {
					lastConsumedIndex = consumedIndex;
					if (pageNumber === 1) initialPageIndex = consumedIndex;
				}
				const connection = await readTimelineConnection(response);
				if (!connection) {
					throw new Error(
						"meta_posts_timeline_unavailable: matching timeline response was not a successful complete page",
					);
				}
				sawValidResponse = true;
				sourceEdgeCount += connection.edges.length;
				capture?.captureHttp(
					`posts-page-${String(pageNumber - 1).padStart(3, "0")}`,
					connection,
					{ status: response.status() },
				);
				const pageEdges = (connection?.edges ?? []).filter((edge) => {
					if (!edge?.node || typeof edge.node !== "object") {
						unrecordableSourceEdges += 1;
						return false;
					}
					const id =
						edge.node.id ??
						edge.node.pk ??
						edge.node.media_id ??
						edge.node.code;
					if (!id) {
						unrecordableSourceEdges += 1;
						return false;
					}
					if (seenIds.has(id)) {
						return false;
					}
					seenIds.add(id);
					return true;
				});
				edges.push(...pageEdges);
				await progress?.("Fetched Instagram posts page", {
					item_count: pageEdges.length,
					page_index: pageNumber,
					total_seen: edges.length,
				});
				const pageInfo = connection?.page_info;
				if (
					pageInfo?.has_next_page === true &&
					(typeof pageInfo.end_cursor !== "string" || !pageInfo.end_cursor)
				) {
					throw new Error(
						"meta_posts_cursor_unavailable: continuing timeline page had no cursor",
					);
				}
				expectedContinuationCursor = pageInfo?.end_cursor ?? null;
				if (pageInfo?.has_next_page === false) {
					sawTerminalPage = true;
					terminalResponse = response;
					initialPageWasTerminal ||= pageNumber === 1;
					return false;
				}
				await delay(1500);
				return true;
			},
			maxPages: POSTS_MAX_PAGES,
		});
	} catch (error) {
		legacyCaptureController.abort();
		stopObserving();
		throw sawValidResponse && edges.length > 0
			? new PartialWalkFailure(error, edges)
			: error;
	}
	if (!initialPageWasTerminal) {
		legacyCaptureController.abort();
	}

	if (!sawValidResponse) {
		stopObserving();
		throw new Error(
			"meta_posts_response_not_observed: profile page never triggered the posts timeline request",
		);
	}
	if (sawTerminalPage && initialPageWasTerminal) {
		const lastResponse = (await legacyInitialCapture) ?? terminalResponse;
		legacyCaptureController.abort();
		const settledConnection = lastResponse
			? await readTimelineConnection(
					lastResponse as {
						json: () => Promise<unknown>;
						status: () => number;
					},
				)
			: null;
		if (lastResponse && !settledConnection) {
			stopObserving();
			throw new Error(
				"meta_posts_timeline_unavailable: matching timeline response was not a successful complete page",
			);
		}
		if (settledConnection?.edges.length === 0 && initialPageIndex >= 0) {
			// Legacy capture is last-wins, but an empty last response after a
			// populated one is contradictory evidence, not proof of zero posts.
			const windowConnections = await Promise.all(
				matchingResponses
					.slice(initialPageIndex)
					.map((candidate) =>
						readTimelineConnection(candidate as PostsTimelineResponse),
					),
			);
			if (
				windowConnections.some(
					(connection) => (connection?.edges.length ?? 0) > 0,
				)
			) {
				stopObserving();
				throw new Error(
					"meta_posts_timeline_contradictory: an empty timeline response followed posts the source had already returned",
				);
			}
		}
		if (settledConnection) {
			edges.length = 0;
			seenIds.clear();
			sourceEdgeCount = settledConnection.edges.length;
			unrecordableSourceEdges = 0;
			for (const edge of settledConnection.edges) {
				if (!edge?.node || typeof edge.node !== "object") {
					unrecordableSourceEdges += 1;
					continue;
				}
				const id =
					edge.node.id ?? edge.node.pk ?? edge.node.media_id ?? edge.node.code;
				if (!id) {
					unrecordableSourceEdges += 1;
					continue;
				}
				if (seenIds.has(id)) {
					continue;
				}
				seenIds.add(id);
				edges.push(edge);
			}
			if (settledConnection.page_info.has_next_page === true) {
				sawTerminalPage = false;
			}
		}
	}
	stopObserving();
	if (unrecordableSourceEdges > 0) {
		throw new Error(
			"meta_posts_unrecordable_edges: posts timeline included source edges without recordable post ids",
		);
	}
	if (!sawTerminalPage && !walk.truncated) {
		const failure = new Error(
			"meta_posts_terminal_page_not_observed: posts timeline did not include a terminal page",
		);
		throw edges.length > 0 ? new PartialWalkFailure(failure, edges) : failure;
	}
	if (
		sawTerminalPage &&
		sourceEdgeCount === 0 &&
		(await hasLoginOrChallengePageState(page))
	) {
		throw new Error(
			"meta_posts_login_challenge: empty timeline observed while login or challenge state is active",
		);
	}

	return { edges, sourceEdgeCount, truncated: walk.truncated };
}

// ─── Following (paginated friendships listing) ─────────────────────────────

export async function fetchAllFollowing(
	page: Page,
	userId: string,
	capture: CaptureSession | null,
	progress?: (
		message: string,
		extra?: Record<string, unknown>,
	) => Promise<void>,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<{ truncated: boolean; users: InstagramFollowingUser[] }> {
	const users: InstagramFollowingUser[] = [];
	let maxId: string | null = null;

	const walk = await walkPagesWithCeiling({
		fetchPage: async (pageNumber) => {
			const qs = new URLSearchParams({ count: String(FOLLOWING_PAGE_LIMIT) });
			if (maxId) {
				qs.set("max_id", maxId);
			}
			const { json, status } = await instagramFetch<InstagramFollowingPage>(
				page,
				`/api/v1/friendships/${userId}/following/?${qs.toString()}`,
				{ "x-ig-app-id": "936619743392459" },
			);
			capture?.captureHttp(
				`following-page-${String(pageNumber - 1).padStart(3, "0")}`,
				json,
				{ status },
			);
			if (
				status < 200 ||
				status >= 300 ||
				!json ||
				(json.status !== undefined && json.status !== "ok") ||
				json.error !== undefined ||
				!Array.isArray(json.users) ||
				(json.next_max_id != null && typeof json.next_max_id !== "string") ||
				typeof json.has_more !== "boolean" ||
				(json.has_more === true && !json.next_max_id) ||
				(json.has_more === false && Boolean(json.next_max_id))
			) {
				throw new Error(
					"meta_following_page_unavailable: following response did not prove a successful page",
				);
			}
			const pageUsers: InstagramFollowingUser[] = [];
			let unreadable = false;
			for (const user of json.users) {
				const record = user && typeof user === "object" ? followingRecord(user) : null;
				if (!record || !followingSchema.safeParse(record).success) {
					unreadable = true;
					continue;
				}
				pageUsers.push(user);
			}
			// Preserve the readable subset of this page as well as earlier pages.
			users.push(...pageUsers);
			if (unreadable) {
				throw new Error("meta_following_unreadable_row: a mapped following row was unreadable");
			}
			await progress?.("Fetched Instagram following page", {
				item_count: pageUsers.length,
				page_index: pageNumber,
				total_seen: users.length,
			});
			if (!json?.next_max_id) {
				return false;
			}
			maxId = json.next_max_id;
			await delay(800);
			return true;
		},
		maxPages: FOLLOWING_MAX_PAGES,
	}).catch((error: unknown) => {
		// Pages read and validated before the failure are not thrown away.
		throw users.length > 0
			? new PartialWalkFailure(error, dedupeFollowingByUsername(users))
			: error;
	});

	return { truncated: walk.truncated, users: dedupeFollowingByUsername(users) };
}

// ─── Ads (Accounts Center DOM scrape) ──────────────────────────────────────

// Interface rows of the ad-topics dialog: "Special topics" and "See less",
// each followed by its own description (confirmed live 2026-10-16).
const NON_TOPIC_RE = /^(?:special topics?|see less)(?:\s|$)/i;
const AD_TOPICS_EMPTY_MESSAGES = [
	"You don't currently have any activity-based topics",
] as const;

type AdsDialogClassification =
	| { complete: boolean; items: string[]; kind: "data" }
	| { hasPositiveSourceTotal?: true; kind: "loading" }
	| { hasPositiveSourceTotal?: true; kind: "verified_empty" }
	| { hasPositiveSourceTotal?: true; kind: "unavailable" };

type AdsSettleClock = {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

const realAdsSettleClock: AdsSettleClock = {
	now: () => Date.now(),
	sleep: politeDelay,
};

/** Classify a visible Accounts Center list without treating a blank shell as empty. */
export function classifyAdsDialogInPage(args: {
	/** Further exact copy the source uses for an empty list (live ad topics). */
	alternateEmptyMessages?: readonly string[];
	emptyMessage: string;
	/** The scraper expanded the list until its own expansion control was gone, so
	 *  a list with no ARIA totals is the whole list the source offers. Supplied
	 *  totals still must agree. */
	expansionExhausted?: true;
	traversalToken?: string;
	requiredAffordance?: string;
	/** Rows are themselves controls (live advertiser rows), so their text
	 *  counts even though it sits inside a control. */
	rowsAreControls?: true;
	uiOnlyPatternSource?: string;
}): AdsDialogClassification {
	const [normalize] = [
		(text: string): string => text.replace(/\s+/g, " ").trim(),
	] as const;
	const controlSelector = 'a, button, [role="button"], [role="link"]';
	const [visible] = [
		(element: Element): boolean => {
			if (!element.isConnected) return false;
			const rect = element.getBoundingClientRect();
			for (
				let current: Element | null = element;
				current;
				current = current.parentElement
			) {
				const style = getComputedStyle(current);
				if (
					style.display === "none" ||
					style.visibility === "hidden" ||
					style.visibility === "collapse" ||
					style.opacity === "0"
				) {
					return false;
				}
			}
			return rect.width > 0 && rect.height > 0;
		},
	] as const;
	const [visibleText] = [
		(element: Element, excludeControls = false): string => {
			const text: string[] = [];
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const parent = node.parentElement;
				if (!parent || !visible(parent)) continue;
				if (excludeControls && parent.closest(controlSelector)) continue;
				const value = normalize(node.textContent ?? "");
				if (value) text.push(value);
			}
			return normalize(text.join(" "));
		},
	] as const;
	const dialogs = Array.from(
		document.querySelectorAll('[role="dialog"]'),
	).filter(visible);
	const dialog = dialogs.find(
		(candidate) => candidate.querySelector('[role="list"]') !== null,
	);
	if (!dialog) return { kind: "unavailable" };
	if (args.traversalToken) {
		const state = (document as Document & { __pdppAdsTraversal?: AdsTraversalState }).__pdppAdsTraversal;
		if (!state || state.token !== args.traversalToken || state.failed ||
			state.dialog !== dialog || state.url !== document.URL) return {kind: "unavailable"};
	}
	const text = visibleText(dialog);
	const [readPositiveInteger] = [
		(raw: string | null): number | null => {
			const trimmed = raw?.trim();
			if (!trimmed || !/^\d+$/.test(trimmed)) return null;
			const value = Number(trimmed);
			return Number.isSafeInteger(value) ? value : null;
		},
	] as const;
	const hasPositiveSourceTotal = Array.from(
		dialog.querySelectorAll('[role="list"], [role="listitem"]'),
	).some(
		(element) =>
			(readPositiveInteger(element.getAttribute("aria-setsize")) ?? 0) > 0 ||
			(readPositiveInteger(element.getAttribute("aria-rowcount")) ?? 0) > 0,
	);
	const loading: AdsDialogClassification = hasPositiveSourceTotal
		? { hasPositiveSourceTotal: true, kind: "loading" }
		: { kind: "loading" };
	const unavailable: AdsDialogClassification = hasPositiveSourceTotal
		? { hasPositiveSourceTotal: true, kind: "unavailable" }
		: { kind: "unavailable" };
	const [styleVisible] = [
		(element: Element): boolean => {
			for (
				let current: Element | null = element;
				current;
				current = current.parentElement
			) {
				const style = getComputedStyle(current);
				if (
					style.display === "none" ||
					style.visibility === "hidden" ||
					style.visibility === "collapse" ||
					style.opacity === "0"
				) {
					return false;
				}
			}
			return element.isConnected;
		},
	] as const;
	if (
		dialog.matches('[aria-busy="true"]') ||
		// A loading indicator can be an empty, zero-size element; only a
		// style-hidden one is ignored.
		Array.from(
			dialog.querySelectorAll('[aria-busy="true"], [role="progressbar"]'),
		).some(styleVisible) ||
		/\b(?:loading|please wait)\b/i.test(text)
	) {
		return loading;
	}
	if (
		Array.from(dialog.querySelectorAll('[role="alert"]')).some(visible) ||
		/\b(?:could not be loaded|try again|temporarily unavailable|something went wrong|error loading)\b/i.test(
			text,
		)
	) {
		return unavailable;
	}
	const uiOnlyPattern = args.uiOnlyPatternSource
		? new RegExp(args.uiOnlyPatternSource, "i")
		: null;
	const [isKnownUiText] = [
		(text: string): boolean =>
			text === args.requiredAffordance ||
			text === "Removed categories" ||
			(uiOnlyPattern?.test(text) ?? false),
	] as const;
	const [hasHiddenRealText] = [
		(element: Element): boolean => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const parent = node.parentElement;
				if (!parent || visible(parent)) continue;
				if (parent.closest(controlSelector)) continue;
				const value = normalize(node.textContent ?? "");
				if (value && !isKnownUiText(value)) return true;
			}
			return false;
		},
	] as const;
	const items: string[] = [];
	let allListsComplete = true;
	let sawUnknownList = false;
	const lists = Array.from(dialog.querySelectorAll('[role="list"]')).filter(
		(currentList) => {
			if (visible(currentList)) return true;
			// A source empty renderer can accompany a zero-height empty list shell.
			// Hidden lists or unresolved rows cannot use that exception.
			return (
				currentList.querySelector('[role="listitem"]') === null &&
				styleVisible(currentList)
			);
		},
	);
	if (lists.length === 0) return unavailable;
	for (const currentList of lists) {
		const listItems: string[] = [];
		let knownUiRows = 0;
		const advertisedCounts = [
			readPositiveInteger(currentList.getAttribute("aria-setsize")),
			readPositiveInteger(currentList.getAttribute("aria-rowcount")),
			...Array.from(currentList.querySelectorAll('[role="listitem"]')).flatMap(
				(row) => [
				readPositiveInteger(row.getAttribute("aria-setsize")),
				readPositiveInteger(row.getAttribute("aria-rowcount")),
				],
			),
		].filter((count): count is number => count !== null);
		const visibleRows = Array.from(
			currentList.querySelectorAll('[role="listitem"]'),
		).filter(visible);
		for (const row of visibleRows) {
			if (hasHiddenRealText(row)) return loading;
			const fullText = visibleText(row);
			if (!fullText) continue;
			const hasControl = Array.from(row.querySelectorAll(controlSelector)).some(
				visible,
			);
			if (args.requiredAffordance) {
				const requiredAffordance = args.requiredAffordance;
				const hasAffordance = Array.from(
					row.querySelectorAll(controlSelector),
				).some(
					// Exact: the "Removed categories" link is interface, not a
					// category's own Remove control.
					(control) =>
						visible(control) && visibleText(control) === requiredAffordance,
				);
				if (!hasAffordance) {
					if (isKnownUiText(fullText)) knownUiRows += 1;
					else if (hasControl) sawUnknownList = true;
					continue;
				}
			}
			const itemText =
				uiOnlyPattern && hasControl && args.rowsAreControls !== true
					? visibleText(row, true)
					: fullText;
			if (!itemText || (uiOnlyPattern?.test(itemText) ?? false)) {
				if (isKnownUiText(fullText) || isKnownUiText(itemText)) knownUiRows += 1;
				else if (hasControl) sawUnknownList = true;
				continue;
			}
			listItems.push(itemText);
			items.push(itemText);
		}
		if (
			Array.from(currentList.querySelectorAll('[role="listitem"]')).some(
				(row) => !visible(row) && hasHiddenRealText(row),
			)
		) {
			return loading;
		}
		if (listItems.length === 0) {
			if (advertisedCounts.some((count) => count > 0)) {
				return loading;
			}
			// A list of only recognized interface rows is chrome, not an
			// unrecognized section.
			if (lists.length > 1 && knownUiRows === 0) sawUnknownList = true;
			continue;
		}
		const rowPositions = Array.from(
			currentList.querySelectorAll('[role="listitem"]'),
		)
			.filter(visible)
			.map((row) => readPositiveInteger(row.getAttribute("aria-posinset")))
			.filter((value): value is number => value !== null);
		// Every supplied list/row count is evidence; precedence hides conflicts.
		const sourceTotal = advertisedCounts.length > 0 &&
			advertisedCounts.every((count) => count === advertisedCounts[0])
			? (advertisedCounts[0] ?? null) : null;
		const positionsProveComplete =
			rowPositions.length === 0
				? true
				: rowPositions.length === listItems.length &&
					rowPositions
						.slice()
						.sort((a, b) => a - b)
						.every((position, index) => position === index + 1);
		const totalProvesComplete =
			advertisedCounts.length === 0
				? args.expansionExhausted === true
				: sourceTotal !== null && sourceTotal === listItems.length;
		allListsComplete &&= totalProvesComplete && positionsProveComplete;
	}
	if (items.length > 0) {
		return {
			complete: allListsComplete && !sawUnknownList,
			items,
			kind: "data",
		};
	}
	// Any hidden row with text, in any list of the dialog (including a hidden
	// list), may still be revealed, so it is not an empty list yet.
	const hasHiddenRowEvidence = Array.from(
		dialog.querySelectorAll('[role="listitem"]'),
	).some((row) => !visible(row) && normalize(row.textContent ?? "") !== "");
	if (hasHiddenRowEvidence) return loading;
	if (sawUnknownList) return unavailable;

	const [canonical] = [
		(value: string): string =>
			normalize(value).replace(/[\u2018\u2019]/g, "'").toLowerCase(),
	] as const;
	const expectedMessages = [
		args.emptyMessage,
		...(args.alternateEmptyMessages ?? []),
	].map(canonical);
	const hasExactVisibleMessage =
		expectedMessages.includes(canonical(visibleText(dialog))) ||
		Array.from(dialog.querySelectorAll("*")).some(
			(element) =>
				visible(element) &&
				expectedMessages.includes(canonical(visibleText(element))),
		);
	if (hasExactVisibleMessage && hasPositiveSourceTotal) return loading;
	return hasExactVisibleMessage ? { kind: "verified_empty" } : unavailable;
}

/**
 * Scrape all `[role="listitem"]` text within the first open ARIA dialog on
 * the page. Shared by advertisers and ad-topics collection — both legacy
 * connectors used this identical selector chain.
 */
async function scrapeDialogListItems(
	page: Page,
	emptyMessage: string,
	uiOnlyPattern?: RegExp,
	clock: AdsSettleClock = realAdsSettleClock,
	extra: Partial<Parameters<typeof classifyAdsDialogInPage>[0]> = {},
): Promise<{ items: string[]; reached: boolean; step: AdsSurfaceStep | null }> {
	const result = await waitForStableAdsDialog(
		page,
		{
			...extra,
			emptyMessage,
			...(uiOnlyPattern ? { uiOnlyPatternSource: uiOnlyPattern.source } : {}),
		},
		clock,
	);
	return {
		items: result?.kind === "data" ? result.items : [],
		reached:
			result?.kind === "verified_empty" ||
			(result?.kind === "data" && result.complete),
		step:
			result?.kind === "unavailable" || result === null
				? "destination_list_not_found"
				: result.kind === "data" && !result.complete
					? "destination_list_not_found"
					: result.kind === "verified_empty"
						? "reached_empty"
						: null,
	};
}

async function waitForStableAdsDialog(
	page: Page,
	args: Parameters<typeof classifyAdsDialogInPage>[0],
	clock: AdsSettleClock = realAdsSettleClock,
): Promise<AdsDialogClassification | null> {
	const deadline = clock.now() + ADS_DIALOG_TIMEOUT_MS;
	let firstSeenAt = 0;
	let lastSignature: string | null = null;
	let sawData = false;
	let sawPositiveSourceTotal = false;
	while (clock.now() < deadline) {
		const classification = await page.evaluate(classifyAdsDialogInPage, args);
		sawData ||= classification.kind === "data";
		sawPositiveSourceTotal ||=
			classification.kind !== "data" &&
			classification.hasPositiveSourceTotal === true;
		if (classification.kind === "loading") {
			firstSeenAt = 0;
			lastSignature = null;
		} else {
			const signature = JSON.stringify(classification);
			if (signature !== lastSignature) {
				firstSeenAt = clock.now();
				lastSignature = signature;
			} else if (clock.now() - firstSeenAt >= ADS_EMPTY_LIST_SETTLE_MS) {
				// Rows seen earlier contradict a later empty message, so the
				// empty message cannot prove the list empty.
				return classification.kind === "verified_empty" &&
					(sawData || sawPositiveSourceTotal)
					? { kind: "unavailable" }
					: classification;
			}
		}
		await clock.sleep(250);
	}
	return null;
}

/** Wait for a list shell; classification settles source evidence separately. */
async function waitForAdsList(page: Page): Promise<boolean> {
	const shellReady = await waitForAdsCondition(page, () =>
		Boolean(document.querySelector('[role="dialog"] [role="list"]')),
	);
	return shellReady;
}

/** Wait for a DOM condition that identifies the intended Accounts Center
 * control or list. Navigation's `domcontentloaded` event only covers the
 * document shell; these surfaces are populated asynchronously afterward. */
async function waitForAdsCondition(
	page: Page,
	condition: () => boolean,
	timeout = 8_000,
): Promise<boolean> {
	try {
		await page.waitForFunction(condition, undefined, { timeout });
		return true;
	} catch {
		return false;
	}
}

async function closeDialog(page: Page): Promise<void> {
	await page
		.evaluate(() => {
			const dialog = document.querySelector('[role="dialog"]');
			const close = dialog?.querySelector(
				'[aria-label="Close" i]',
			) as HTMLElement | null;
			close?.click();
		})
		.catch((): undefined => undefined);
}

export async function scrapeAdvertisers(
	page: Page,
	clock: AdsSettleClock = realAdsSettleClock,
): Promise<ReachedScrape<string>> {
	if (!(await safeGoto(page, `${ACCOUNTS_CENTER_ORIGIN}/ads/`))) {
		return {
			items: [],
			reached: false,
			step: "navigation_failed",
			surface: "advertisers",
		};
	}
	// Accounts Center moved the advertisers list: the bare advertisers button
	// is gone and the list opens from the "Manage info" tab (confirmed live
	// 2026-10-16). Either entry point proves the page rendered.
	const entryReady = await page
		.waitForFunction(
			([tabLabel]: readonly [string]) =>
				Boolean(
					document.querySelector(
						'[role="button"][aria-label*="advertiser" i], button[aria-label*="advertiser" i]',
					),
				) ||
				Array.from(document.querySelectorAll('[role="tab"]')).some((tab) =>
					(tab.textContent ?? "").includes(tabLabel),
				),
			["Manage info"] as const,
			{ timeout: 8_000 },
		)
		.then(() => true)
		.catch(() => false);
	if (!entryReady) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "advertisers",
		};
	}
	const hasLegacyButton = await page.evaluate(() =>
		Boolean(
			document.querySelector(
				'[role="button"][aria-label*="advertiser" i], button[aria-label*="advertiser" i]',
			),
		),
	);
	if (!hasLegacyButton) {
		return scrapeAdvertisersFromManageInfo(page, clock);
	}

	const clicked = await page.evaluate(() => {
		const btn = document.querySelector(
			'[role="button"][aria-label*="advertiser" i], button[aria-label*="advertiser" i]',
		) as HTMLElement | null;
		if (btn) {
			btn.click();
			return true;
		}
		return false;
	});
	if (!clicked) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "advertisers",
		};
	}
	const listReady = await waitForAdsList(page);
	if (!listReady) {
		await closeDialog(page);
		return {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "advertisers",
		};
	}
	const result = await scrapeDialogListItems(
		page,
		"No advertisers",
		undefined,
		clock,
	);
	await closeDialog(page);
	return { ...result, surface: "advertisers" };
}

const ADS_SEE_MORE_RE = /^see more$/i;
const ADS_MAX_EXPANSIONS = 50;
const ADS_EXPANSION_WAIT_MS = 10_000;

type AdsTraversalRow = { description: string | null; name: string };
type AdsTraversalState = {
 token: string; dialog: Element; lists: Element[]; url: string;
 rows: AdsTraversalRow[]; failed: boolean;
};

/** Browser-local references bind every sample and click to one document/dialog.
 * The serialized token alone cannot revive the proof after navigation. */
function inspectDialogExpansion(args: {
 click: boolean; label: string; token: string; initialize?: boolean;
}): { clicked: boolean; visible: boolean; failed: boolean; loading: boolean; rows: AdsTraversalRow[] } {
 const doc = document as Document & { __pdppAdsTraversal?: AdsTraversalState };
 const [visible] = [(element: Element): boolean => {
  if (!element.isConnected) return false;
  for (let current: Element | null = element; current; current = current.parentElement) {
   const style = getComputedStyle(current);
   if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
 }] as const;
 const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
  candidate => visible(candidate) && candidate.querySelector('[role="list"]') !== null,
 );
 const lists = Array.from(dialog?.querySelectorAll('[role="list"]') ?? []);
 if (args.initialize && dialog) {
  doc.__pdppAdsTraversal = { token: args.token, dialog, lists, url: document.URL, rows: [], failed: false };
 }
 const state = doc.__pdppAdsTraversal;
 if (!state || state.token !== args.token) return {clicked: false, visible: false, failed: true, loading: false, rows: []};
 if (!dialog || dialog !== state.dialog || document.URL !== state.url ||
  state.lists.some(list => !lists.includes(list))) {
  state.failed = true;
  return {clicked: false, visible: false, failed: true, loading: false, rows: state.rows};
 }
 state.lists = lists;
 const [normalize] = [(text: string) => text.replace(/\s+/g, " ").trim()] as const;
 const controls = Array.from(dialog.querySelectorAll('a, button, [role="button"], [role="link"]'))
  .filter(control => normalize(control.textContent ?? "").toLowerCase() === args.label.toLowerCase());
 const shown = controls.find(visible) as HTMLElement | undefined;
 const rows: AdsTraversalRow[] = [];
 let unreadable = false;
 for (const row of Array.from(dialog.querySelectorAll('[role="listitem"]'))) {
  if (controls.some(control => row.contains(control))) continue;
  if (!visible(row)) continue;
  const texts: string[] = [];
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
   const parent = node.parentElement;
   const text = normalize(node.textContent ?? "");
   if (!text) continue;
   if (!parent || !visible(parent)) { unreadable = true; continue; }
   if (args.label === "View all" && (text === "Remove" || text === "Removed categories")) continue;
   texts.push(text);
  }
  if (args.label === "View all" && texts.length === 0) continue;
  if (args.label === "View all" && !Array.from(row.querySelectorAll('button, [role="button"]'))
   .some(control => visible(control) && normalize(control.textContent ?? "") === "Remove")) {
   unreadable = true; continue;
  }
  const name = args.label === "View all" ? texts[0] : normalize(texts.join(" "));
  const description = args.label === "View all" ? texts[1] ?? null : null;
  if (!name || name.length > 500 || (description !== null && description.length > 2000)) {
   unreadable = true; continue;
  }
  rows.push({name, description});
 }
 const keys = rows.map(row => JSON.stringify(row));
 const retained = state.rows.every(row => keys.includes(JSON.stringify(row)));
 if (!retained || new Set(rows.map(row => row.name)).size !== rows.length) state.failed = true;
 // Keep every readable record even if a later sample loses it or shows an error.
 for (const row of rows) {
  if (!state.rows.some(previous => JSON.stringify(previous) === JSON.stringify(row))) state.rows.push(row);
 }
 const text = normalize(dialog.textContent ?? "");
 const error = Array.from(document.querySelectorAll('input[type="password"], form[action*="/login"], form[action*="/challenge"]')).some(visible) ||
  Array.from(dialog.querySelectorAll('[role="alert"]')).some(visible) ||
  /\b(?:could not be loaded|try again|temporarily unavailable|something went wrong|error loading)\b/i.test(text);
 if (error) state.failed = true;
 const loading = dialog.matches('[aria-busy="true"]') ||
  Array.from(dialog.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some(visible) ||
  /\b(?:loading|please wait)\b/i.test(text);
 // A busy dialog is transient: it blocks acceptance until idle but is not a
 // lasting defect of the baseline.
 const failed = state.failed || unreadable;
 // Snapshot before dispatch: a synchronous handler must not move the baseline.
 const snapshot = {clicked: false, visible: Boolean(shown), failed, loading, rows: rows.slice()};
 if (state.failed) snapshot.rows = state.rows.slice();
 if (args.click && shown && !state.failed) {
  shown.click();
  snapshot.clicked = true;
 }
 return snapshot;
}

let adsTraversalSequence = 0;
async function expandAdsDialog(
 page: Page, label: string, clock: AdsSettleClock,
): Promise<{ exhausted: boolean; failed: boolean; token: string; rows: AdsTraversalRow[] }> {
 const token = `meta-ads-${++adsTraversalSequence}`;
 let rows: AdsTraversalRow[] = [];
 let clickedOnce = false;
 let failed = false;
 const sample = async (click: boolean, initialize = false) => {
  const result = await page.evaluate(inspectDialogExpansion, {click, initialize, label, token});
  const validated = result.rows.filter(row => {
   const records = buildAdRecords({adTopics: [],
    advertisers: label === "See more" ? [row.name] : [],
    categories: label === "View all" ? [row] : []});
   return records.length === 1 && adsSchema.safeParse(records[0]).success;
  });
  result.failed ||= validated.length !== result.rows.length;
  result.rows = validated;
  for (const row of result.rows) {
   if (!rows.some(previous => JSON.stringify(previous) === JSON.stringify(row))) rows.push(row);
  }
  return result;
 };
 const initial = await sample(false, true);
 // Wake on real page time: rows load on the page's own timers, not on the
 // injected clock, so one in-page wait covers the first stretch.
 const awaitPageGrowth = async (rowsBefore: number, deadline: number): Promise<void> => {
  await Promise.resolve().then(() => page.waitForFunction(([name, count]: readonly [string, number]) => {
   const dialog = Array.from(document.querySelectorAll('[role="dialog"]'))
    .find(candidate => candidate.querySelector('[role="list"]'));
   if (!dialog) return false;
   const controls = Array.from(dialog.querySelectorAll('a, button, [role="button"], [role="link"]'))
    .filter(control => (control.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === name);
   return Array.from(dialog.querySelectorAll('[role="listitem"]')).filter(row => {
    if (controls.some(control => row.contains(control))) return false;
    const rect = row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
   }).length > count;
  }, [label.toLowerCase(), rowsBefore] as const, {timeout: Math.max(1, deadline - clock.now())})).catch((): undefined => undefined);
 };
 const waitForGrowth = async (before: AdsTraversalRow[], deadline: number, wake = true): Promise<Awaited<ReturnType<typeof sample>>> => {
  if (wake) await awaitPageGrowth(before.length, deadline);
  const after = await sample(false);
  const keys = after.rows.map(row => JSON.stringify(row));
  const retained = before.every(row => keys.includes(JSON.stringify(row)));
  if (!retained || (!after.failed && !after.loading && after.rows.length > before.length) || clock.now() >= deadline) return after;
  await clock.sleep(250);
  return waitForGrowth(before, deadline, false);
 };
 const walk = await walkPagesWithCeiling({
  maxPages: ADS_MAX_EXPANSIONS,
  fetchPage: async () => {
   const before = await sample(true);
   if (!before.clicked) { failed ||= before.failed; return false; }
   clickedOnce = true;
   const after = await waitForGrowth(before.rows, clock.now() + ADS_EXPANSION_WAIT_MS);
   const keys = after.rows.map(row => JSON.stringify(row));
   if (after.failed || after.loading || after.rows.length <= before.rows.length ||
    !before.rows.every(row => keys.includes(JSON.stringify(row)))) {
    failed = true; return false;
   }
   return after.visible;
  },
 }).catch(() => { failed = true; return {truncated: false}; });
 const final = await sample(false).catch(() => ({failed: true, loading: false, visible: false, rows: []}));
 failed ||= walk.truncated || final.failed || final.loading;
 return {exhausted: clickedOnce && !initial.failed && !failed && !final.visible, failed: failed || (initial.failed && !clickedOnce), token, rows};
}

/** Advertisers via Manage info → "Advertisers using your activity or
 *  information", the dialog every live Accounts Center now serves. */
async function scrapeAdvertisersFromManageInfo(
	page: Page,
	clock: AdsSettleClock,
): Promise<ReachedScrape<string>> {
	const failed = (step: AdsSurfaceStep): ReachedScrape<string> => ({
		items: [],
		reached: false,
		step,
		surface: "advertisers",
	});
	const clickedTab = await page.evaluate(() => {
		const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
			(candidate) => (candidate.textContent ?? "").includes("Manage info"),
		) as HTMLElement | undefined;
		tab?.click();
		return tab !== undefined;
	});
	if (!clickedTab) return failed("control_not_found");
	const linkReady = await waitForAdsCondition(page, () =>
		Array.from(
			document.querySelectorAll(
				'[role="tabpanel"] a, [role="tabpanel"] [role="link"], [role="tabpanel"] [role="button"]',
			),
		).some((link) =>
			(link.textContent ?? "").includes("Advertisers using your activity"),
		),
	);
	if (!linkReady) return failed("control_not_found");
	const clickedLink = await page.evaluate(() => {
		const link = Array.from(
			document.querySelectorAll(
				'[role="tabpanel"] a, [role="tabpanel"] [role="link"], [role="tabpanel"] [role="button"]',
			),
		).find((candidate) =>
			(candidate.textContent ?? "").includes("Advertisers using your activity"),
		) as HTMLElement | undefined;
		link?.click();
		return link !== undefined;
	});
	if (!clickedLink) return failed("control_not_found");
	if (!(await waitForAdsList(page))) {
		await closeDialog(page);
		return failed("destination_list_not_found");
	}
	const traversal = await expandAdsDialog(page, "See more", clock);
	const result = await scrapeDialogListItems(
		page, "No advertisers", ADS_SEE_MORE_RE, clock,
		{ rowsAreControls: true, traversalToken: traversal.token,
			...(traversal.exhausted ? { expansionExhausted: true as const } : {}) },
	).catch(() => ({items: [] as string[], reached: false, step: "destination_list_not_found" as const}));
	const final = await page.evaluate(inspectDialogExpansion, {click: false, label: "See more", token: traversal.token})
		.catch(() => ({failed: true, loading: false, rows: [] as AdsTraversalRow[]}));
	const names = new Set([...traversal.rows, ...final.rows].map(row => row.name));
	for (const name of result.items) names.add(name);
	const reached = result.reached && !traversal.failed && !final.failed && !final.loading &&
		(result.items.length === names.size || (names.size === 0 && result.reached));
	await closeDialog(page);
	return { items: [...names], reached, step: reached ? result.step : "destination_list_not_found", surface: "advertisers" };
}

const ADS_EMPTY_LIST_SETTLE_MS = 2_500;
const ADS_DIALOG_TIMEOUT_MS = 12_000;

export async function scrapeAdTopics(
	page: Page,
	clock: AdsSettleClock = realAdsSettleClock,
): Promise<ReachedScrape<string>> {
	if (!(await safeGoto(page, `${ACCOUNTS_CENTER_ORIGIN}/ads/ad_topics/`))) {
		return {
			items: [],
			reached: false,
			step: "navigation_failed",
			surface: "ad_topics",
		};
	}
	const listReady = await waitForAdsList(page);
	if (!listReady) {
		return {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "ad_topics",
		};
	}
	const result = await scrapeDialogListItems(
		page,
		"No ad topics",
		NON_TOPIC_RE,
		clock,
		{ alternateEmptyMessages: AD_TOPICS_EMPTY_MESSAGES },
	);
	return {
		items: result.items,
		reached: result.reached,
		step: result.step,
		surface: "ad_topics",
	};
}

/**
 * Categories used to reach the owner. Ported from
 * instagram-ads-playwright.js's "Manage info" tab walk. Only listitems with
 * a "Remove" affordance are real categories (the same disambiguator the
 * legacy connector used) — everything else in that panel is UI chrome.
 */
export async function scrapeTargetingCategories(
	page: Page,
	clock: AdsSettleClock = realAdsSettleClock,
): Promise<ReachedScrape<{ description: string | null; name: string }>> {
	if (!(await safeGoto(page, `${ACCOUNTS_CENTER_ORIGIN}/ads/`))) {
		return {
			items: [],
			reached: false,
			step: "navigation_failed",
			surface: "targeting_categories",
		};
	}
	const tabReady = await waitForAdsCondition(page, () =>
		Array.from(document.querySelectorAll('[role="tab"]')).some((tab) =>
			(tab.textContent ?? "").includes("Manage info"),
		),
	);
	if (!tabReady) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "targeting_categories",
		};
	}

	const clickedTab = await page.evaluate(() => {
		const tabs = document.querySelectorAll('[role="tab"]');
		for (const tab of Array.from(tabs)) {
			if ((tab.textContent ?? "").includes("Manage info")) {
				(tab as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
	if (!clickedTab) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "targeting_categories",
		};
	}
	const panelLinkReady = await waitForAdsCondition(page, () =>
		Array.from(
			document.querySelectorAll(
				'[role="tabpanel"] a, [role="tabpanel"] [role="link"]',
			),
		).some((link) =>
			(link.textContent ?? "").includes("Categories used to reach you"),
		),
	);
	if (!panelLinkReady) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "targeting_categories",
		};
	}

	const clickedCategories = await page.evaluate(() => {
		const links = document.querySelectorAll(
			'[role="tabpanel"] a, [role="tabpanel"] [role="link"]',
		);
		for (const link of Array.from(links)) {
			if ((link.textContent ?? "").includes("Categories used to reach you")) {
				(link as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
	if (!clickedCategories) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "targeting_categories",
		};
	}
	const categoryListReady = await waitForAdsList(page);
	if (!categoryListReady) {
		await closeDialog(page);
		return {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "targeting_categories",
		};
	}
	const classificationArgs = {
		emptyMessage: "No categories",
		requiredAffordance: "Remove",
	} satisfies Parameters<typeof classifyAdsDialogInPage>[0];
	const beforeExpansion = await page.evaluate(
		classifyAdsDialogInPage,
		classificationArgs,
	);
	const traversal = await expandAdsDialog(page, "View all", clock);
	const finalCategories = await waitForStableAdsDialog(page, {
		...classificationArgs, traversalToken: traversal.token,
		...(traversal.exhausted ? {expansionExhausted: true as const} : {}),
	}, clock).catch(() => null);
	const final = await page.evaluate(inspectDialogExpansion, {click: false, label: "View all", token: traversal.token})
		.catch(() => ({failed: true, loading: false, rows: [] as AdsTraversalRow[]}));
	const items = [...traversal.rows];
	for (const row of final.rows) {
		if (!items.some(previous => previous.name === row.name)) items.push(row);
	}
	const safe = !traversal.failed && !final.failed && !final.loading;
	const empty = safe && items.length === 0 && finalCategories?.kind === "verified_empty" &&
		beforeExpansion.kind !== "data" && beforeExpansion.kind !== "loading" &&
		beforeExpansion.hasPositiveSourceTotal !== true;
	const reached = empty || (safe && items.length > 0 && finalCategories?.kind === "data" &&
		finalCategories.complete && items.length === finalCategories.items.length);
	await closeDialog(page);
	return {items, reached, step: reached ? (empty ? "reached_empty" : null) : "destination_list_not_found", surface: "targeting_categories"};
}

// ─── Collect ────────────────────────────────────────────────────────────

async function reportCollectionFailure(
	ctx: BrowserCollectContext,
	stream: string,
	message: string,
): Promise<void> {
	if (!ctx.reportStreamFailure) {
		throw createConnectorFailure("stream_collection_failed", message, {
			retryable: true,
		});
	}
	await ctx.reportStreamFailure(stream, message, { retryable: true });
}

async function emitPostRecords(
	ctx: BrowserCollectContext,
	edges: readonly InstagramTimelineEdge[],
): Promise<void> {
	if (ctx.requested.has("posts")) {
		for (const edge of edges) {
			const record = postRecord(edge);
			if (record) {
				await ctx.emitRecord("posts", record as RecordData);
			}
		}
	}
	if (ctx.requested.has("post_likes")) {
		for (const edge of edges) {
			for (const like of postLikeRecords(edge)) {
				await ctx.emitRecord("post_likes", like as RecordData);
			}
		}
	}
}

async function emitFollowingRecords(
	ctx: BrowserCollectContext,
	users: readonly InstagramFollowingUser[],
): Promise<void> {
	for (const user of users) {
		const record = followingRecord(user);
		if (record) {
			await ctx.emitRecord("following", record as RecordData);
		}
	}
}

export async function collectAllStreams(
	ctx: BrowserCollectContext,
	/** Pacing delay between paginated pages. Defaults to politeDelay(800ms);
	 *  tests inject a no-op so they don't sleep through the page ceiling. */
	delay: (ms: number) => Promise<void> = politeDelay,
	postsClock: PostsClock = realPostsClock,
	adsClock: AdsSettleClock = realAdsSettleClock,
	profileClock: ProfileCaptureClock = realProfileCaptureClock,
): Promise<void> {
	const { capture, emit, emitRecord, page, progress, requested } = ctx;

	const wantsProfile = requested.has("profile");
	const wantsPosts = requested.has("posts");
	const wantsPostLikes = requested.has("post_likes");
	const wantsFollowing = requested.has("following");
	const wantsAds = requested.has("ads");

	const needsInstagramIdentity =
		wantsProfile || wantsPosts || wantsPostLikes || wantsFollowing;
	const user = needsInstagramIdentity ? await fetchWebInfoUser(page) : null;
	const identity = user ? profileRecord(user) : null;
	if (needsInstagramIdentity && !identity) {
		const unavailable = ["profile", "posts", "post_likes", "following"].filter(
			(stream) => requested.has(stream),
		);
		for (const stream of unavailable) {
			await reportCollectionFailure(
				ctx,
				stream,
				"Instagram authenticated profile data was unavailable; this stream was not proven complete.",
			);
		}
	}

	// Empty timelines need a positively read zero for this identity, even
	// when profile output was not requested. Unknown is not proof of empty.
	let observedPostCount: number | null = null;
	if ((wantsProfile || wantsPosts || wantsPostLikes) && user && identity) {
		await progress("Fetching Instagram profile counts");
		const profileUser = await fetchProfilePageUser(
			page,
			identity.username,
			capture,
			profileClock,
		);
		const profileUserMatchesIdentity = Boolean(
			profileUser?.id === identity.id &&
			typeof profileUser.username === "string" &&
			profileUser.username.toLowerCase() === identity.username.toLowerCase(),
		);
		const trustedProfileUser = profileUserMatchesIdentity ? profileUser : null;
		const counts = profileCountsFromGraphQL(
			trustedProfileUser
				? { data: { user: trustedProfileUser } }
				: null,
		);
		observedPostCount = counts.post_count;
		if (wantsProfile) {
			const readableSources = profileSourceFieldsAreReadable(user) &&
				profileSourceFieldsAreReadable(trustedProfileUser);
			const profile = profileRecord(user, counts, trustedProfileUser) ?? identity;
			const validProfile = profileSchema.safeParse(profile).success;
			if (validProfile) await emitRecord("profile", profile as RecordData);
			if (!readableSources || !validProfile || !profileEnrichmentIsComplete(trustedProfileUser)) {
				await reportCollectionFailure(
					ctx,
					"profile",
					"Instagram profile enrichment was incomplete; the emitted profile is a partial record.",
				);
			}
		}
	}

	if ((wantsPosts || wantsPostLikes) && identity) {
		await progress("Fetching Instagram posts");
		let postsResult: Awaited<ReturnType<typeof fetchAllPosts>> | null = null;
		try {
			postsResult = await fetchAllPosts(
					page,
					identity.username,
				capture,
				progress,
				delay,
				postsClock,
				identity.id,
			);
		} catch (error) {
			// Any failure of the timeline walk (a rejected page evaluation, a
			// destroyed execution context, a meta_posts_* proof failure) leaves
			// the list unproven, so it fails these streams, not the whole run.
			// Pages read and validated before the failure are still emitted.
			if (error instanceof PartialWalkFailure) {
				await emitPostRecords(ctx, error.partial);
			}
			const failedStreams = ["posts", "post_likes"].filter((stream) =>
				requested.has(stream),
			);
			for (const stream of failedStreams) {
				await reportCollectionFailure(
					ctx,
					stream,
					"Instagram posts were unavailable because the timeline did not load to completion.",
				);
			}
		}
		if (postsResult) {
			const { edges, sourceEdgeCount, truncated } = postsResult;
			await emitPostRecords(ctx, edges);
			if (truncated) {
				// No later run resumes past the cap, so the records above are a
				// prefix, not the list: report every requested stream the cap
				// affects instead of finishing them (§5.5).
				for (const stream of ["posts", "post_likes"].filter((name) =>
					requested.has(name),
				)) {
					await reportCollectionFailure(
						ctx,
						stream,
						`Instagram posts stopped at the ${POSTS_MAX_PAGES}-page limit with more pages still listed (${edges.length} posts read).`,
					);
				}
			}
			if (
				sourceEdgeCount === 0 &&
				!truncated &&
				observedPostCount !== 0
			) {
				for (const stream of ["posts", "post_likes"].filter((name) =>
					requested.has(name),
				)) {
					await reportCollectionFailure(
						ctx,
						stream,
						"Instagram returned no timeline posts without a proven same-identity profile post count of zero; the empty list was not proven.",
					);
				}
			} else if (sourceEdgeCount === 0 && !truncated) {
				if (wantsPosts) {
					await emit({ cursor: {}, stream: "posts", type: "STATE" });
				}
				if (wantsPostLikes) {
					await emit({ cursor: {}, stream: "post_likes", type: "STATE" });
				}
			}
		}
	}

	if (wantsFollowing && identity) {
		await progress("Fetching Instagram following list");
		let followingResult: Awaited<ReturnType<typeof fetchAllFollowing>>;
		let followingComplete = false;
		try {
			followingResult = await fetchAllFollowing(
				page,
				identity.id,
				capture,
				progress,
				delay,
			);
			followingComplete = !followingResult.truncated;
		} catch (error) {
			// Same rule as posts: every enumeration failure, including a rejected
			// page evaluation, must reach reportStreamFailure for following, and
			// pages read before it are still emitted.
			if (error instanceof PartialWalkFailure) {
				await emitFollowingRecords(ctx, error.partial);
			}
			await reportCollectionFailure(
				ctx,
				"following",
				"Instagram following could not be read to completion.",
			);
			followingResult = { truncated: false, users: [] };
		}
		const { truncated, users } = followingResult;
		await emitFollowingRecords(ctx, users);
		if (truncated) {
			// D6: following must be complete or fail honestly. The legacy
			// connector silently stopped at ~1000 accounts; no later run resumes
			// past the cap, so report the stream failed and keep the records.
			await reportCollectionFailure(
				ctx,
				"following",
				`Instagram following stopped at the ${FOLLOWING_MAX_PAGES}-page limit (${users.length} accounts) with more pages still listed.`,
			);
		} else if (followingComplete) {
			// A no-cursor heartbeat records the positive terminal-page proof for
			// this full enumeration, including a valid empty following list.
			await emit({ cursor: {}, stream: "following", type: "STATE" });
		}
	}

	if (wantsAds) {
		await progress("Fetching Instagram ad preferences");
		// A page-script error (e.g. a destroyed execution context) leaves one
		// surface unproven; it fails the ads stream, not the whole run.
		const scrapeSurface = async <T>(
			surface: AdsSurface,
			scrape: () => Promise<ReachedScrape<T>>,
		): Promise<ReachedScrape<T>> => {
			try {
				return await scrape();
			} catch {
				return {
					items: [],
					reached: false,
					step: "page_script_failed",
					surface,
				};
			}
		};
		const advertisers = await scrapeSurface("advertisers", () =>
			scrapeAdvertisers(page, adsClock),
		);
		const adTopics = await scrapeSurface("ad_topics", () =>
			scrapeAdTopics(page, adsClock),
		);
		const categories = await scrapeSurface("targeting_categories", () =>
			scrapeTargetingCategories(page, adsClock),
		);
		const ads = buildAdRecords({
			adTopics: adTopics.items,
			advertisers: advertisers.items,
			categories: categories.items,
		});
		const readableAds = ads.filter((ad) => adsSchema.safeParse(ad).success);
		const sourceCounts = [
			["advertiser", "advertisers", advertisers.items.length],
			["ad_topic", "ad_topics", adTopics.items.length],
			["ad_category", "targeting_categories", categories.items.length],
		] as const;
		const unreadableSurfaces = new Set<AdsSurface>(
			sourceCounts.filter(([kind, , count]) =>
				readableAds.filter((ad) => ad.kind === kind).length !== count,
			).map(([, surface]) => surface),
		);
		const reachedSurfaces = [advertisers, adTopics, categories]
			.filter((surface) => surface.reached && !unreadableSurfaces.has(surface.surface))
			.map((surface) => surface.surface);
		for (const ad of readableAds) {
			await emitRecord("ads", ad as RecordData);
		}
		await emitDetailCoverage(ctx, {
			hydratedKeys: reachedSurfaces,
			requiredKeys: ADS_REQUIRED_SURFACES,
			stateStream: "ads",
			stream: "ads",
		});
		const missingSurfaces = ADS_REQUIRED_SURFACES.filter(
			(surface) => !reachedSurfaces.includes(surface),
		);
		if (missingSurfaces.length > 0) {
			await progress("Instagram ads scan incomplete", { stream: "ads" });
			process.stderr.write(
				`[meta-ads] ${JSON.stringify({
					missing_surfaces: missingSurfaces,
					surface_steps: [advertisers, adTopics, categories]
						.filter((surface) => surface.step !== null)
						.map(({ step, surface }) => ({ surface, step })),
				})}\n`,
			);
			await reportCollectionFailure(
				ctx,
				"ads",
				`Instagram ads scan could not reach ${missingSurfaces.join(", ")}`,
			);
		}
	}
}

// ─── Entry ──────────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
	runConnector({
		browser: { profileName: "meta" },
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectAllStreams(ctx);
		},
		ensureSession: ensureMetaSession,
		name: "meta",
		async probeSession(args: ProbeSessionArgs): Promise<boolean> {
			return probeMetaSession(args);
		},
		validateRecord,
	});
}
