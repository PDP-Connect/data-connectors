#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Meta (Instagram) Connector (v0.3.3)
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
 *                (manifests/meta.json) and emits no STATE: every run walks
 *                the full timeline (no server-provided early-stop cursor is
 *                confirmed) — a second run's re-emit of unchanged posts is
 *                an idempotent id-keyed upsert, not incremental savings yet.
 *   post_likes   child stream of posts (D3): (post, liker) pairs from each
 *                post's `facepile_top_likers` sample. Instagram's web
 *                surface has no full-likers listing endpoint reachable from
 *                a logged-in session — this is a bounded top-likers sample,
 *                not full coverage. See "Known limitations" below.
 *   following    `/api/v1/friendships/{userId}/following/` — paginated,
 *                walked to completion (or SKIP_RESULT reason=
 *                following_pages_deferred_page_budget if the safety ceiling
 *                is hit; see D6, "legacy capped at ~1000, modern must be
 *                complete or report honest coverage"). Confirmed live:
 *                walked to `has_next_page: false` with no SKIP_RESULT, 19/19
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
 *     (`[role="dialog"] [role="list"] [role="listitem"]`), ported verbatim
 *     from both legacy connectors. Confirmed flaky live: one run captured
 *     only 1 record (targeting categories; the advertisers button wasn't
 *     found), a second run on the same session captured 2 (targeting
 *     categories + 1 advertiser). Whether this is UI drift (Accounts
 *     Center's "Manage info" tab layout looked materially different from
 *     the legacy connector's screenshots) or a click-timing race is not yet
 *     isolated — needs a dedicated live investigation, not assumed to be
 *     either.
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
 *   v0.3.0 (2026-09-22) — real collector replacing the
 *     `instagram_graphql_wiring_pending` scaffold; merges both legacy
 *     connectors' streams into profile/posts/post_likes/following/ads per D6.
 *   v0.1.0 — scaffold: session probe only, unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualAction } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	emitDetailCoverage,
	type EnsureSessionArgs,
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

interface ReachedScrape<T> {
	items: T[];
	reached: boolean;
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
	context,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	if (await hasSessionCookie(context)) {
		return;
	}
	await manualLoginHandoff({ context, page, sendInteraction });
}

async function manualLoginHandoff({
	context,
	page,
	sendInteraction,
}: Pick<
	EnsureSessionArgs,
	"context" | "page" | "sendInteraction"
>): Promise<void> {
	await page
		.goto(`${INSTAGRAM_ORIGIN}/accounts/login/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);

	await manualAction(
		{
			message: "Log in to Instagram, then click Done.",
			page,
			reason: "login",
		},
		sendInteraction,
	);

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
	data?: {
		xdt_api__v1__feed__user_timeline_graphql_connection?: InstagramTimelineConnection | null;
	} | null;
}

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
function isPostsTimelineResponse(response: {
	request: () => { method: () => string };
	url: () => string;
}): boolean {
	return (
		response.url().includes("/graphql/") &&
		response.request().method() === "POST"
	);
}

async function readTimelineConnection(response: {
	json: () => Promise<unknown>;
}): Promise<InstagramTimelineConnection | null> {
	try {
		const body = (await response.json()) as TimelineEnvelope;
		return (
			body?.data?.xdt_api__v1__feed__user_timeline_graphql_connection ?? null
		);
	} catch {
		return null;
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
): Promise<{ edges: InstagramTimelineEdge[]; truncated: boolean }> {
	const edges: InstagramTimelineEdge[] = [];
	const seenIds = new Set<string>();
	let sawAnyResponse = false;

	const walk = await walkPagesWithCeiling({
		fetchPage: async (pageNumber) => {
			const responsePromise = page
				.waitForResponse(isPostsTimelineResponse, { timeout: 15_000 })
				.catch(() => null);
			if (pageNumber === 1) {
				await page.goto(
					`${INSTAGRAM_ORIGIN}/${encodeURIComponent(username)}/`,
					{
						timeout: 30_000,
						waitUntil: "domcontentloaded",
					},
				);
			} else {
				await page.evaluate(() =>
					window.scrollTo(0, document.body.scrollHeight),
				);
			}
			const response = await responsePromise;
			if (!response) {
				return false;
			}
			sawAnyResponse = true;
			const connection = await readTimelineConnection(response);
			capture?.captureHttp(
				`posts-page-${String(pageNumber - 1).padStart(3, "0")}`,
				connection,
				{ status: response.status() },
			);
			const pageEdges = (connection?.edges ?? []).filter((edge) => {
				const id =
					edge.node.id ?? edge.node.pk ?? edge.node.media_id ?? edge.node.code;
				if (!id || seenIds.has(id)) {
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
			if (!pageInfo?.has_next_page || pageEdges.length === 0) {
				return false;
			}
			await delay(1500);
			return true;
		},
		maxPages: POSTS_MAX_PAGES,
	});

	if (!sawAnyResponse) {
		throw new Error(
			"meta_posts_response_not_observed: profile page never triggered the posts timeline request",
		);
	}

	return { edges, truncated: walk.truncated };
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
			const pageUsers = json?.users ?? [];
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
	});

	return { truncated: walk.truncated, users: dedupeFollowingByUsername(users) };
}

// ─── Ads (Accounts Center DOM scrape) ──────────────────────────────────────

/**
 * Scrape all `[role="listitem"]` text within the first open ARIA dialog on
 * the page. Shared by advertisers and ad-topics collection — both legacy
 * connectors used this identical selector chain.
 */
async function scrapeDialogListItems(
	page: Page,
): Promise<{ items: string[]; reached: boolean }> {
	return await page.evaluate(() => {
		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) {
			return { items: [], reached: false };
		}
		const list = dialog.querySelector('[role="list"]');
		if (!list) {
			return { items: [], reached: false };
		}
		const items = list.querySelectorAll('[role="listitem"]');
		return {
			items: Array.from(items)
				.map((el) => (el.textContent ?? "").trim())
				.filter((t) => t.length > 0),
			reached: true,
		};
	});
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
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<ReachedScrape<string>> {
	await page
		.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);
	await delay(2000);

	const clicked = await page.evaluate(() => {
		const btn = document.querySelector(
			'[role="button"][aria-label*="advertiser" i]',
		) as HTMLElement | null;
		if (btn) {
			btn.click();
			return true;
		}
		return false;
	});
	if (!clicked) {
		return { items: [], reached: false, surface: "advertisers" };
	}
	await delay(2000);
	const result = await scrapeDialogListItems(page);
	await closeDialog(page);
	return { ...result, surface: "advertisers" };
}

const NON_TOPIC_RE = /special topic|see less/i;

export async function scrapeAdTopics(
	page: Page,
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<ReachedScrape<string>> {
	await page
		.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/ad_topics/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);
	await delay(3000);
	const result = await scrapeDialogListItems(page);
	return {
		items: result.items.filter((t) => !NON_TOPIC_RE.test(t)),
		reached: result.reached,
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
	delay: (ms: number) => Promise<void> = politeDelay,
): Promise<ReachedScrape<{ description: string | null; name: string }>> {
	await page
		.goto(`${ACCOUNTS_CENTER_ORIGIN}/ads/`, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);
	await delay(2000);

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
		return { items: [], reached: false, surface: "targeting_categories" };
	}
	await delay(1000);

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
		return { items: [], reached: false, surface: "targeting_categories" };
	}
	await delay(1500);

	const clickedViewAll = await page.evaluate(() => {
		const btns = document.querySelectorAll('button, [role="button"]');
		for (const btn of Array.from(btns)) {
			if ((btn.textContent ?? "").trim() === "View all") {
				(btn as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
	await delay(500);
	const viewAllExpanded =
		!clickedViewAll ||
		(await page.evaluate(() => {
			const btns = document.querySelectorAll('button, [role="button"]');
			return !Array.from(btns).some(
				(btn) => (btn.textContent ?? "").trim() === "View all",
			);
		}));

	const categories = await page.evaluate(() => {
		const dialog = document.querySelector('[role="dialog"]');
		const list = dialog?.querySelector('[role="list"]');
		if (!list) {
			return { items: [], reached: false };
		}
		const items = list.querySelectorAll('[role="listitem"]');
		const seen = new Set<string>();
		const out: Array<{ description: string | null; name: string }> = [];
		for (const item of Array.from(items)) {
			const removeBtn = item.querySelector('button, [role="button"]');
			if (!removeBtn || !(removeBtn.textContent ?? "").includes("Remove")) {
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
				const t = (node.textContent ?? "").trim();
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
		reached: categories.reached && viewAllExpanded,
		surface: "targeting_categories",
	};
}

// ─── Collect ────────────────────────────────────────────────────────────

export async function collectAllStreams(
	ctx: BrowserCollectContext,
	/** Pacing delay between paginated pages. Defaults to politeDelay(800ms);
	 *  tests inject a no-op so they don't sleep through the page ceiling. */
	delay: (ms: number) => Promise<void> = politeDelay,
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
		const { edges, truncated } = await fetchAllPosts(
			page,
			profile.username,
			capture,
			progress,
			delay,
		);

		if (wantsPosts) {
			for (const edge of edges) {
				const record = postRecord(edge);
				if (record) {
					await emitRecord("posts", record as RecordData);
				}
			}
		}
		if (wantsPostLikes) {
			for (const edge of edges) {
				for (const like of postLikeRecords(edge)) {
					await emitRecord("post_likes", like as RecordData);
				}
			}
		}
		if (truncated) {
			await emit({
				diagnostics: { page_limit: POSTS_MAX_PAGES, total_seen: edges.length },
				message: `Instagram posts stopped at the ${POSTS_MAX_PAGES}-page limit with more pages still listed`,
				reason: "posts_pages_deferred_page_budget",
				stream: wantsPosts ? "posts" : "post_likes",
				type: "SKIP_RESULT",
			});
		}
		// `posts` declares incremental: false / coverage_strategy:
		// full_inventory (manifests/meta.json) and emits no STATE: every run
		// walks the full timeline (scroll-triggered pagination has no
		// server-provided early-stop cursor this connector has confirmed
		// live — see the header's posts-endpoint note). A `taken_at`
		// high-water mark could support a stop-at-seen boundary IF Instagram's
		// timeline connection is confirmed newest-first, but no code or
		// fixture here confirms that ordering — a live-account run is needed
		// first. `postRecord`'s id-keyed emit already makes a second run's
		// re-emit of unchanged posts an idempotent upsert, not a duplicate —
		// see the connector cutover report's second-run evidence.
	}

	if (wantsFollowing) {
		await progress("Fetching Instagram following list");
		const { truncated, users } = await fetchAllFollowing(
			page,
			userId,
			capture,
			progress,
			delay,
		);
		for (const user_ of users) {
			const record = followingRecord(user_);
			if (record) {
				await emitRecord("following", record as RecordData);
			}
		}
		if (truncated) {
			// D6: following must be complete or report honest coverage — the
			// legacy connector silently stopped at ~1000 accounts with no signal.
			await emit({
				diagnostics: {
					page_limit: FOLLOWING_MAX_PAGES,
					total_seen: users.length,
				},
				message: `Instagram following stopped at the ${FOLLOWING_MAX_PAGES}-page limit (${users.length} accounts) with more pages still listed`,
				reason: "following_pages_deferred_page_budget",
				stream: "following",
				type: "SKIP_RESULT",
			});
		}
	}

	if (wantsAds) {
		await progress("Fetching Instagram ad preferences");
		const advertisers = await scrapeAdvertisers(page, delay);
		const adTopics = await scrapeAdTopics(page, delay);
		const categories = await scrapeTargetingCategories(page, delay);
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
			considered: ads.length,
			covered: ads.length,
			hydratedKeys: reachedSurfaces,
			requiredKeys: ADS_REQUIRED_SURFACES,
			stateStream: "ads",
			stream: "ads",
		});
		const missingSurfaces = ADS_REQUIRED_SURFACES.filter(
			(surface) => !reachedSurfaces.includes(surface),
		);
		if (missingSurfaces.length > 0) {
			await emit({
				diagnostics: { missing_surfaces: missingSurfaces },
				message: `Instagram ads scan could not reach ${missingSurfaces.join(", ")}`,
				reason: "ads_surfaces_unavailable",
				stream: "ads",
				type: "SKIP_RESULT",
			});
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
