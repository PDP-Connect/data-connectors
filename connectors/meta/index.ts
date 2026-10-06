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
 *   profile      `/accounts/web_info/` — an HTML document with the owner's
 *                profile embedded in a `<script type="application/json"
 *                data-sjs>` PolarisViewer tuple. Does NOT carry
 *                follower_count/following_count/media_count (confirmed
 *                absent) — see `types.ts`'s `InstagramWebInfoUser` doc.
 *                Those three counts are filled separately from a passively
 *                observed profile-page GraphQL response
 *                (`fetchProfileCounts`/`profileCountsFromGraphQL`), null when
 *                that response isn't observed within the timeout.
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
 *     partial ads run; a live retest is still needed to confirm whether
 *     layout drift contributes.
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
 *     (`fetchProfileCounts`), the same query the legacy connector captured
 *     for these fields; null when the response isn't observed within the
 *     timeout, never guessed.
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
import type { Page } from "playwright";
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
	profileRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	InstagramFollowingPage,
	InstagramFollowingUser,
	InstagramProfilePageEnvelope,
	InstagramTimelineConnection,
	InstagramTimelineEdge,
	InstagramWebInfoUser,
} from "./types.ts";

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const ACCOUNTS_CENTER_ORIGIN = "https://accountscenter.instagram.com";
const SESSION_COOKIE_RE = /sessionid|ds_user_id/;
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

export async function probeMetaSession({
	context,
}: ProbeSessionArgs): Promise<boolean> {
	return hasSessionCookie(context);
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
	await page
		.goto(`${INSTAGRAM_ORIGIN}/accounts/login/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);

	await manualBrowserLogin({
		assist,
		completeAssistance,
		isProbeSuccessful: (live) => live,
		message:
			"Log in to Instagram. The connector will continue automatically once the session is live.",
		page,
		probe: () => hasSessionCookie(context),
		readinessProbe: () => hasSessionCookie(context),
		readinessProbeOnHandoffPage: true,
		reason: "login",
		sendInteraction,
		timeoutSeconds: 1800,
	});

	const live = await hasSessionCookie(context);
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
	try {
		await page.goto(`${INSTAGRAM_ORIGIN}/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
		return true;
	} catch {
		return false;
	}
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
}

// ─── Profile counts (profile-page GraphQL) ────────────────────────────────

function isProfilePageGraphQLResponse(response: {
	request: () => { method: () => string };
	url: () => string;
}): boolean {
	return (
		response.url().includes("/graphql/") &&
		response.request().method() === "POST"
	);
}

/**
 * `follower_count`/`following_count`/`media_count` are not on `web_info`
 * (see {@link fetchWebInfoUser}) but the profile page's own render issues a
 * `PolarisProfilePageContentQuery`/`ProfilePageQuery`/`UserByUsernameQuery`
 * GraphQL request carrying them (legacy
 * `connectors/meta/instagram-playwright.js:614-619` captured this same
 * request by URL/body pattern). Passively observed the same way
 * {@link fetchAllPosts} observes the posts timeline query: navigate to the
 * profile page and race a `waitForResponse` against the navigation. Returns
 * all-null counts (via {@link profileCountsFromGraphQL}) rather than
 * guessing when the request is not observed within the timeout — a
 * best-effort enrichment, not a required source.
 */
export async function fetchProfileCounts(
	page: Page,
	username: string,
	capture: CaptureSession | null,
): Promise<ReturnType<typeof profileCountsFromGraphQL>> {
	const responsePromise = page
		.waitForResponse(isProfilePageGraphQLResponse, { timeout: 15_000 })
		.catch(() => null);
	await page
		.goto(`${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);
	const response = await responsePromise;
	if (!response) {
		return profileCountsFromGraphQL(null);
	}
	let envelope: InstagramProfilePageEnvelope | null = null;
	try {
		envelope = (await response.json()) as InstagramProfilePageEnvelope;
	} catch {
		envelope = null;
	}
	capture?.captureHttp("profile-counts", envelope, {
		status: response.status(),
	});
	return profileCountsFromGraphQL(envelope);
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
function isPostsTimelineResponse(
	response: {
		request: () => {
			frame?: () => { page?: () => Page };
			headers: () => Record<string, string>;
			method: () => string;
			postData: () => string | null;
		};
		url: () => string;
	},
	page: Page,
): boolean {
	const request = response.request();
	let responsePage: Page | undefined;
	try {
		responsePage = request.frame?.().page?.();
	} catch {
		return false;
	}
	const operation = request.postData() ?? "";
	return (
		(responsePage === undefined || responsePage === page) &&
		response.url().includes("/graphql/") &&
		request.method() === "POST" &&
		/(?:PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery)/.test(
			operation,
		)
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
	const matchingResponses: unknown[] = [];
	let lastConsumedIndex = -1;
	let initialPageIndex = -1;
	let legacyInitialCapture: Promise<unknown | null> | null = null;
	const legacyCaptureController = new AbortController();
	const pageEvents = page as Page & {
		off?: (event: "response", listener: (response: unknown) => void) => void;
		on?: (event: "response", listener: (response: unknown) => void) => void;
	};
	const onResponse = (response: unknown): void => {
		if (
			isPostsTimelineResponse(
				response as Parameters<typeof isPostsTimelineResponse>[0],
				page,
			)
		) {
			matchingResponses.push(response);
		}
	};
	const observesResponses = typeof pageEvents.on === "function";
	pageEvents.on?.("response", onResponse);

	let walk: Awaited<ReturnType<typeof walkPagesWithCeiling>>;
	try {
		walk = await walkPagesWithCeiling({
			fetchPage: async (pageNumber) => {
				if (pageNumber === 1) {
					// Responses captured before navigation belong to an earlier visit.
					lastConsumedIndex = matchingResponses.length - 1;
				}
				// The client can fetch a page on its own (for example during the
				// polite delay). Consume pages in arrival order so none is skipped.
				const queued = (): PostsTimelineResponse | undefined =>
					observesResponses
						? (matchingResponses[lastConsumedIndex + 1] as
								| PostsTimelineResponse
								| undefined)
						: undefined;
				let response = pageNumber === 1 ? undefined : queued();
				if (response === undefined) {
					const responsePromise = page
						.waitForResponse(
							(candidate) => isPostsTimelineResponse(candidate, page),
							{ timeout: 15_000 },
						)
						.catch(() => null);
					if (pageNumber === 1) {
						try {
							await page.goto(
								`${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`,
								{
									timeout: 30_000,
									waitUntil: "domcontentloaded",
								},
							);
							legacyInitialCapture = waitForLegacyPostsCapture(
								matchingResponses,
								postsClock,
								legacyCaptureController.signal,
							);
						} catch {
							throw new Error(
								"meta_posts_navigation_failed: profile timeline did not load",
							);
						}
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
					const awaited = await responsePromise;
					if (!awaited) {
						return false;
					}
					response = queued() ?? awaited;
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
		pageEvents.off?.("response", onResponse);
		throw sawValidResponse && edges.length > 0
			? new PartialWalkFailure(error, edges)
			: error;
	}
	if (!initialPageWasTerminal) {
		legacyCaptureController.abort();
	}

	if (!sawValidResponse) {
		pageEvents.off?.("response", onResponse);
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
			pageEvents.off?.("response", onResponse);
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
				pageEvents.off?.("response", onResponse);
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
	pageEvents.off?.("response", onResponse);
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
				json.users.some(
					(user) =>
						!user ||
						typeof user !== "object" ||
						!user.username ||
						!(user.id ?? user.pk),
				) ||
				(json.next_max_id != null && typeof json.next_max_id !== "string") ||
				(json.has_more === true && !json.next_max_id)
			) {
				throw new Error(
					"meta_following_page_unavailable: following response did not prove a successful page",
				);
			}
			const pageUsers = json.users;
			users.push(...pageUsers);
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

const NON_TOPIC_RE = /^(?:special topic|see less)$/i;

type AdsDialogClassification =
	| { complete: boolean; items: string[]; kind: "data" }
	| { kind: "loading" }
	| { kind: "verified_empty" }
	| { kind: "unavailable" };

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
	emptyMessage: string;
	requiredAffordance?: string;
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
	const text = visibleText(dialog);
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
		return { kind: "loading" };
	}
	if (
		Array.from(dialog.querySelectorAll('[role="alert"]')).some(visible) ||
		/\b(?:could not be loaded|try again|temporarily unavailable|something went wrong|error loading)\b/i.test(
			text,
		)
	) {
		return { kind: "unavailable" };
	}
	const [readPositiveInteger] = [
		(raw: string | null): number | null => {
			const trimmed = raw?.trim();
			if (!trimmed || !/^\d+$/.test(trimmed)) return null;
			const value = Number(trimmed);
			return Number.isSafeInteger(value) ? value : null;
		},
	] as const;
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
	if (lists.length === 0) return { kind: "unavailable" };
	for (const currentList of lists) {
		const listItems: string[] = [];
		const visibleRows = Array.from(
			currentList.querySelectorAll('[role="listitem"]'),
		).filter(visible);
		for (const row of visibleRows) {
			if (hasHiddenRealText(row)) return { kind: "loading" };
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
					(control) =>
						visible(control) &&
						visibleText(control).includes(requiredAffordance),
				);
				if (!hasAffordance) {
					if (hasControl) sawUnknownList = true;
					continue;
				}
			}
			const itemText =
				uiOnlyPattern && hasControl ? visibleText(row, true) : fullText;
			if (!itemText || (uiOnlyPattern?.test(itemText) ?? false)) {
				if (hasControl && !isKnownUiText(fullText) && !isKnownUiText(itemText))
					sawUnknownList = true;
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
			return { kind: "loading" };
		}
		if (listItems.length === 0) {
			if (lists.length > 1) sawUnknownList = true;
			continue;
		}
		const listTotal =
			readPositiveInteger(currentList.getAttribute("aria-setsize")) ??
			readPositiveInteger(currentList.getAttribute("aria-rowcount"));
		const rowTotals = Array.from(
			currentList.querySelectorAll('[role="listitem"]'),
		)
			.filter(visible)
			.map((row) => readPositiveInteger(row.getAttribute("aria-setsize")))
			.filter((value): value is number => value !== null);
		const rowPositions = Array.from(
			currentList.querySelectorAll('[role="listitem"]'),
		)
			.filter(visible)
			.map((row) => readPositiveInteger(row.getAttribute("aria-posinset")))
			.filter((value): value is number => value !== null);
		const rowTotal =
			rowTotals.length > 0 && rowTotals.every((value) => value === rowTotals[0])
				? (rowTotals[0] ?? null)
				: null;
		const sourceTotal = listTotal ?? rowTotal;
		const positionsProveComplete =
			rowPositions.length === 0
				? true
				: rowPositions.length === listItems.length &&
					rowPositions
						.slice()
						.sort((a, b) => a - b)
						.every((position, index) => position === index + 1);
		allListsComplete &&=
			sourceTotal !== null &&
			sourceTotal === listItems.length &&
			positionsProveComplete;
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
	if (hasHiddenRowEvidence) return { kind: "loading" };
	if (sawUnknownList) return { kind: "unavailable" };

	const expected = normalize(args.emptyMessage).toLowerCase();
	const hasExactVisibleMessage =
		visibleText(dialog).toLowerCase() === expected ||
		Array.from(dialog.querySelectorAll("*")).some(
			(element) =>
				visible(element) && visibleText(element).toLowerCase() === expected,
		);
	return hasExactVisibleMessage
		? { kind: "verified_empty" }
		: { kind: "unavailable" };
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
): Promise<{ items: string[]; reached: boolean; step: AdsSurfaceStep | null }> {
	const result = await waitForStableAdsDialog(
		page,
		{
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
	while (clock.now() < deadline) {
		const classification = await page.evaluate(classifyAdsDialogInPage, args);
		sawData ||= classification.kind === "data";
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
				return classification.kind === "verified_empty" && sawData
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
	try {
		await page.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
	} catch {
		return {
			items: [],
			reached: false,
			step: "navigation_failed",
			surface: "advertisers",
		};
	}
	const buttonReady = await waitForAdsCondition(page, () =>
		Boolean(
			document.querySelector(
				'[role="button"][aria-label*="advertiser" i], button[aria-label*="advertiser" i]',
			),
		),
	);
	if (!buttonReady) {
		return {
			items: [],
			reached: false,
			step: "control_not_found",
			surface: "advertisers",
		};
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

const ADS_EMPTY_LIST_SETTLE_MS = 2_500;
const ADS_DIALOG_TIMEOUT_MS = 12_000;

export async function scrapeAdTopics(
	page: Page,
	clock: AdsSettleClock = realAdsSettleClock,
): Promise<ReachedScrape<string>> {
	try {
		await page.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/ad_topics/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
	} catch {
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
	try {
		await page.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
	} catch {
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
	const initialCategories = await waitForStableAdsDialog(
		page,
		classificationArgs,
		clock,
	);
	if (initialCategories?.kind === "verified_empty") {
		await closeDialog(page);
		return {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "targeting_categories",
		};
	}
	if (initialCategories?.kind !== "data") {
		await closeDialog(page);
		return {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "targeting_categories",
		};
	}

	const clickedViewAll = await page.evaluate(() => {
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
		const dialog = Array.from(
			document.querySelectorAll('[role="dialog"]'),
		).find(
			(candidate) =>
				visible(candidate) && candidate.querySelector('[role="list"]') !== null,
		);
		const btns = dialog?.querySelectorAll('button, [role="button"]') ?? [];
		for (const btn of Array.from(btns)) {
			if (visible(btn) && (btn.textContent ?? "").trim() === "View all") {
				(btn as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
	const viewAllExpanded =
		!clickedViewAll ||
		(await waitForAdsCondition(page, () => {
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
			const dialog = Array.from(
				document.querySelectorAll('[role="dialog"]'),
			).find(
				(candidate) =>
					visible(candidate) &&
					candidate.querySelector('[role="list"]') !== null,
			);
			const btns = dialog?.querySelectorAll('button, [role="button"]') ?? [];
			return !Array.from(btns).some(
				(btn) => visible(btn) && (btn.textContent ?? "").trim() === "View all",
			);
		}));
	const finalCategories = clickedViewAll
		? await waitForStableAdsDialog(page, classificationArgs, clock)
		: initialCategories;
	// Rows were already seen, so an empty message after expansion contradicts
	// them and cannot prove the list complete.
	if (!viewAllExpanded || finalCategories?.kind !== "data") {
		await closeDialog(page);
		return {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "targeting_categories",
		};
	}

	const categories = await page.evaluate(() => {
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
		const dialog = Array.from(
			document.querySelectorAll('[role="dialog"]'),
		).find(
			(candidate) =>
				visible(candidate) && candidate.querySelector('[role="list"]') !== null,
		);
		const lists = Array.from(
			dialog?.querySelectorAll('[role="list"]') ?? [],
		).filter(visible);
		if (lists.length === 0) {
			return { items: [], reached: false };
		}
		const items = lists.flatMap((list) =>
			Array.from(list.querySelectorAll('[role="listitem"]')).filter(visible),
		);
		const seen = new Set<string>();
		const out: Array<{ description: string | null; name: string }> = [];
		for (const item of items) {
			const removeBtn = item.querySelector('button, [role="button"]');
			if (
				!removeBtn ||
				!visible(removeBtn) ||
				!(removeBtn.textContent ?? "").includes("Remove")
			) {
				continue;
			}
			const texts: string[] = [];
			const walker = document.createTreeWalker(
				item,
				NodeFilter.SHOW_TEXT,
				null,
			);
			let node = walker.nextNode();
			while (node) {
				const parent = node.parentElement;
				const t =
					parent && visible(parent) ? (node.textContent ?? "").trim() : "";
				if (t && t !== "Remove" && t !== "Removed categories") {
					texts.push(t);
				}
				node = walker.nextNode();
			}
			const name = texts[0];
			if (!name || seen.has(name)) {
				continue;
			}
			seen.add(name);
			out.push({ description: texts[1] ?? null, name });
		}
		return { items: out, reached: true };
	});
	await closeDialog(page);
	return {
		items: categories.items,
		reached:
			categories.reached &&
			viewAllExpanded &&
			categories.items.length > 0 &&
			categories.items.length === finalCategories.items.length &&
			finalCategories.complete,
		step:
			categories.reached &&
			viewAllExpanded &&
			categories.items.length > 0 &&
			categories.items.length === finalCategories.items.length &&
			finalCategories.complete
				? null
				: "destination_list_not_found",
		surface: "targeting_categories",
	};
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
): Promise<void> {
	const { capture, emit, emitRecord, page, progress, requested } = ctx;

	const wantsProfile = requested.has("profile");
	const wantsPosts = requested.has("posts");
	const wantsPostLikes = requested.has("post_likes");
	const wantsFollowing = requested.has("following");
	const wantsAds = requested.has("ads");

	await progress("Fetching Instagram profile");
	const user = await fetchWebInfoUser(page);
	if (!user) {
		throw new Error(
			"meta_profile_unavailable: Instagram web_info returned no logged-in user",
		);
	}
	const identity = profileRecord(user);
	if (!identity) {
		throw new Error("meta_profile_unavailable: profile missing id/username");
	}
	const userId = identity.id;

	let profile = identity;
	if (wantsProfile) {
		await progress("Fetching Instagram profile counts");
		const counts = await fetchProfileCounts(page, identity.username, capture);
		profile = profileRecord(user, counts) ?? identity;
		await emitRecord("profile", profile as RecordData);
	}

	if (wantsPosts || wantsPostLikes) {
		await progress("Fetching Instagram posts");
		let postsResult: Awaited<ReturnType<typeof fetchAllPosts>> | null = null;
		try {
			postsResult = await fetchAllPosts(
				page,
				profile.username,
				capture,
				progress,
				delay,
				postsClock,
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
			if (sourceEdgeCount === 0 && !truncated) {
				if (wantsPosts) {
					await emit({ cursor: {}, stream: "posts", type: "STATE" });
				}
				if (wantsPostLikes) {
					await emit({ cursor: {}, stream: "post_likes", type: "STATE" });
				}
			}
		}
	}

	if (wantsFollowing) {
		await progress("Fetching Instagram following list");
		let followingResult: Awaited<ReturnType<typeof fetchAllFollowing>>;
		try {
			followingResult = await fetchAllFollowing(
				page,
				userId,
				capture,
				progress,
				delay,
			);
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
		const reachedSurfaces = [advertisers, adTopics, categories]
			.filter((surface) => surface.reached)
			.map((surface) => surface.surface);
		const ads = buildAdRecords({
			adTopics: adTopics.items,
			advertisers: advertisers.items,
			categories: categories.items,
		});
		for (const ad of ads) {
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
