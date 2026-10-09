#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP X browser connector (v0.1.0).
 *
 * The browser-session profile for X (formerly Twitter). It reads the signed-in
 * owner's own profile, posts, likes and bookmarks from the x.com web app, in
 * the owner's own browser session. `twitter_archive` stays the account-export
 * profile and is the way to get full history and direct messages; this
 * connector reads neither direct messages nor following/follower lists.
 *
 * How it collects. It does not build X's GraphQL requests: their query ids
 * rotate and each request carries a per-request signature header. Instead it
 * lets the web app make its own requests and reads the responses. A script
 * installed in the page (page-scripts.ts) wraps XMLHttpRequest and fetch and
 * buffers the bodies of the GraphQL operations named below. The connector
 * then follows the app's own navigation links and scrolls, and parses what the
 * app loaded. It matches on operation names only.
 *
 * Terms of service and legal basis. X's Terms of Service prohibit accessing
 * the service by automated means, including scraping, without X's prior
 * written consent. This connector is for the account owner only, in the
 * owner's own signed-in session, reading the owner's own personal data
 * (their profile, their posts, and the posts they chose to like or bookmark)
 * at the owner's explicit request. The owner's basis is their right of access
 * and portability over their own personal data: GDPR Articles 15 and 20 in
 * the EU and UK, CCPA/CPRA section 1798.100 and 1798.130 in California, and
 * equivalent laws elsewhere. X's own archive export (twitter_archive) serves
 * the same right; this connector is a fresher view of a subset of it. Running
 * it is still a use of the web app that X's terms do not permit, and X may
 * rate-limit, challenge or restrict an account for it. The owner decides
 * whether to run it; README.md says this in owner-facing words.
 *
 * Safety budget. Reading posts in the web app spends the owner's own daily
 * reading allowance, so a run is bounded: see the constants below. The
 * connector does one thing at a time, pauses between actions, never retries,
 * and stops the whole run on the first sign of a rate limit, an error
 * response, or a lost session. It never clicks anything but navigation links,
 * tabs and the account control that opens the narrow layout's drawer.
 *
 * Streams: profile, posts, likes, bookmarks.
 *
 * Tested surfaces (as of 2026-10-08): none end to end. The response shapes,
 * the navigation selectors, the view-to-operation mapping and pagination by
 * scripted scrolling were checked by hand on one English-language account
 * on the wide desktop layout; this code has run only against the synthetic
 * fixtures. README.md lists what was checked and what is unverified.
 *
 * Reachability and mock-mutation checks: permanently exempt. Collection is
 * browser automation behind a sign-in wall, with no unauthenticated endpoint
 * to probe and no HTTP request made by this code.
 *
 * CHANGES
 *   v0.1.0 (2026-10-08): first version.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { z } from "zod";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	connectorDiagnostic,
	DIAGNOSTIC_LINE_MAX_CHARS,
	formatConnectorDiagnostic,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	DRAWER_OPEN_SELECTORS,
	drawerProfileSelector,
	followLinkScript,
	installObserverScript,
	LAYOUT_SCRIPT,
	type LinkFallback,
	OWNER_HANDLE_SCRIPT,
	openDrawerScript,
	POLL_SCRIPT,
	PROFILE_LINK_SELECTORS,
	scrollScript,
} from "./page-scripts.ts";
import {
	type PostRecord,
	PROFILE_OPERATION,
	type ProfileRecord,
	parseProfileBody,
	parseRequestVariables,
	parseTimelineBody,
	TIMELINE_OPERATIONS,
	type TimelineOperation,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const ORIGIN = "https://x.com";
export const HOME_URL = `${ORIGIN}/home`;
export const LOGIN_URL = `${ORIGIN}/login`;
const HOME_PATH = "/home";

// ─── Safety budget ──────────────────────────────────────────────────────

/**
 * Posts X may send across every view in one run before the run stops reading.
 * Each post the web app loads counts against the owner's own daily reading
 * allowance (third parties report roughly 1,000 a day on free accounts and
 * fewer on new ones). The count includes other people's posts in reply
 * threads, which are read but not saved. It cannot include the home timeline
 * the app loads before the observer is installed, so the cap leaves room.
 */
export const MAX_POSTS_PER_RUN = 400;

/**
 * Posts read from one view before that view stops. A view stops after the
 * response that reaches its cap, so it can pass the cap by at most one
 * response. Together the caps equal MAX_POSTS_PER_RUN.
 */
export const VIEW_POST_CAPS: Readonly<Record<ViewName, number>> = {
	originals: 100,
	replies: 100,
	bookmarks: 100,
	likes: 100,
};

/**
 * The shortest and longest pause after every action on the page (following a
 * link, scrolling). Each pause is drawn at random between the two, so the
 * app makes at most one paginated request every few seconds.
 */
export const ACTION_DELAY_MIN_MS = 2000;
export const ACTION_DELAY_MAX_MS = 5000;

/** Scroll steps in one view before the walk gives up on reaching its end. */
export const MAX_SCROLL_STEPS_PER_VIEW = 60;

/**
 * Pauses spent waiting for a view's first response after following its link.
 * Waiting takes no action on the page.
 */
const NAVIGATION_WAIT_STEPS = 4;

/** Scroll steps at the bottom of a list with no new response before the walk stops. */
const MAX_IDLE_STEPS_AT_BOTTOM = 2;

/**
 * Newest ids per stream kept in STATE. A later run stops a stream at the
 * first of these it meets. More than one is kept so that deleting, unliking
 * or unbookmarking the newest post does not send the next run to its cap.
 */
const HEAD_IDS_KEPT = 50;

/** How far one scroll step moves, in window heights: between these two. */
const SCROLL_VIEWPORT_SHARE_MIN = 2;
const SCROLL_VIEWPORT_SHARE_MAX = 3;

// ─── Local bounds (no effect on X) ──────────────────────────────────────

const OWNER_HANDLE_ATTEMPTS = 5;
const OWNER_HANDLE_RETRY_MS = 1000;
const OBSERVER_MAX_BUFFERED = 200;
const OBSERVER_ERROR_BODY_CHARS = 2000;
const MAX_PAGE_READ_FAILURES = 2;

/** Paths X sends a session to when it wants sign-in or a challenge. */
const SIGN_IN_PATH_RE =
	/^\/(?:login|logout|i\/flow\/|i\/jf\/onboarding\/|account\/(?:access|login_challenge|locked|suspended))/;
const NUMERIC_ID_RE = /^\d{1,30}$/;
/** X's handle shape, the same one parsers.ts and the page script enforce. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
/** The `@`-prefixed form of HANDLE_RE's shape, to mask a mention in a label. */
const AT_HANDLE_RE = /@[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/g;
/**
 * Longest accessible name the layout diagnostic keeps. An `aria-label` can
 * carry an account name, so it is masked and then clipped.
 */
const LAYOUT_ARIA_LABEL_MAX_CHARS = 40;
/**
 * Shortest masked `aria-label` (`al`) and redacted path (`p`) a cut control
 * line keeps. `al` is shortened first, then `p`, and the line is marked
 * `cut:1`.
 */
const LAYOUT_ARIA_LABEL_MIN_CHARS = 16;
const LAYOUT_PATH_MIN_CHARS = 12;
/**
 * Longest redacted route the first `layout` line names, so that line fits the
 * budget whatever path the page reports.
 */
const LAYOUT_ROUTE_MAX_CHARS = 20;
/**
 * Most control lines one report writes. At the page script's 60-control cap
 * every control gets a line; past this the first line counts what could not be
 * named.
 */
const LAYOUT_MAX_CONTROL_LINES = 60;
/** Short event names leave the 150-character budget to the JSON tail. */
const LAYOUT_EVENT = "layout";
const LAYOUT_CONTROL_EVENT = "lc";

/**
 * Path words that are part of X's own routes, never a handle, so a layout
 * diagnostic keeps them and only masks the account-shaped segments.
 */
const STATIC_PATH_SEGMENTS = new Set([
	"about",
	"account",
	"access",
	"bookmarks",
	"communities",
	"compose",
	"explore",
	"flow",
	"followers",
	"following",
	"hashtag",
	"history",
	"home",
	"i",
	"intent",
	"jf",
	"likes",
	"lists",
	"locked",
	"login",
	"logout",
	"media",
	"messages",
	"notifications",
	"onboarding",
	"photo",
	"privacy",
	"search",
	"settings",
	"share",
	"status",
	"suspended",
	"tos",
	"user",
	"verified",
	"video",
	"with_replies",
]);

const PROFILE_STREAM = "profile";
const POSTS_STREAM = "posts";
const LIKES_STREAM = "likes";
const BOOKMARKS_STREAM = "bookmarks";
type PostStream =
	| typeof POSTS_STREAM
	| typeof LIKES_STREAM
	| typeof BOOKMARKS_STREAM;
const POST_STREAMS: readonly PostStream[] = [
	POSTS_STREAM,
	BOOKMARKS_STREAM,
	LIKES_STREAM,
];

type ViewName = "originals" | "replies" | "bookmarks" | "likes";

/** Why the whole run stops at once. */
type StopReason =
	| "collection_interrupted"
	| "run_budget_reached"
	| "sign_in_required"
	| "source_rate_limited"
	| "source_unreadable";

type FailureReason =
	| StopReason
	| "list_end_unconfirmed"
	| "records_unreadable"
	| "run_stopped_early"
	| "source_unreadable";

interface Failure {
	readonly message: string;
	readonly reason: FailureReason;
}

/** The SKIP_RESULT reason for each way a stream can fall short. */
const SKIP_REASON: Record<FailureReason, string> = {
	collection_interrupted: "collection_interrupted",
	list_end_unconfirmed: "list_end_unconfirmed",
	records_unreadable: "records_unreadable",
	run_budget_reached: "run_budget_reached",
	run_stopped_early: "run_stopped_early",
	sign_in_required: "sign_in_required",
	source_rate_limited: "source_rate_limited",
	source_unreadable: "source_unreadable",
};

/**
 * Nothing here is retried by the runtime: a retry is another read of the
 * owner's allowance, and after a rate limit it would make things worse. The
 * owner runs the connector again.
 */
const RECOVERY_ACTION: Record<FailureReason, string> = {
	collection_interrupted: "manual_action_required",
	list_end_unconfirmed: "retry_on_connector_upgrade",
	records_unreadable: "retry_on_connector_upgrade",
	run_budget_reached: "manual_action_required",
	run_stopped_early: "manual_action_required",
	sign_in_required: "manual_action_required",
	source_rate_limited: "upstream_unblock",
	source_unreadable: "retry_on_connector_upgrade",
};

interface NavigationStep {
	/** The narrow layout may hide this link in the account drawer. */
	readonly drawer?: boolean;
	readonly path: string;
	readonly selectors: readonly string[];
}

interface View {
	readonly label: string;
	readonly name: ViewName;
	readonly operation: TimelineOperation;
	readonly steps: (handle: string | null) => readonly NavigationStep[] | null;
	readonly stream: PostStream;
}

const HISTORY_PATH = "/i/history";
/**
 * The links that open the owner's profile: the wide layout's own navigation
 * first, then the narrow layout's account-drawer link, built from the handle
 * already validated against HANDLE_RE. `followLinkScript` still checks the
 * anchor's own href before clicking.
 */
function profileStepSelectors(handle: string): string[] {
	return [...PROFILE_LINK_SELECTORS, drawerProfileSelector(handle)];
}

/**
 * The History (Bookmarks) link. The primary-nav selector was seen on the wide
 * desktop layout; the bare selector also matches the drawer's own link, once
 * the drawer is open. The drawer's History link has no test id (seen at
 * 390 px on 2026-10-09).
 */
const HISTORY_STEP: NavigationStep = {
	drawer: true,
	path: HISTORY_PATH,
	selectors: [
		`nav[aria-label="Primary"] a[href="${HISTORY_PATH}"]`,
		`a[href="${HISTORY_PATH}"]`,
	],
};

/**
 * The views, in the order they are read, each with the operation the app
 * requests on opening it (seen on x.com: the profile sends UserByScreenName
 * and UserOriginalsTimeline, its Replies tab UserRepliesTimeline, History
 * Bookmarks, and History's Likes tab Likes). Each is reached by following the
 * app's own links, whose selectors were seen on the wide desktop layout.
 */
const VIEWS: readonly View[] = [
	{
		name: "originals",
		label: "posts",
		operation: "UserOriginalsTimeline",
		stream: POSTS_STREAM,
		steps: (handle) =>
			handle === null
				? null
				: [
						{
							drawer: true,
							path: `/${handle}`,
							selectors: profileStepSelectors(handle),
						},
					],
	},
	{
		name: "replies",
		label: "replies",
		operation: "UserRepliesTimeline",
		stream: POSTS_STREAM,
		steps: (handle) =>
			handle === null
				? null
				: [
						{
							drawer: true,
							path: `/${handle}`,
							selectors: profileStepSelectors(handle),
						},
						{
							path: `/${handle}/with_replies`,
							selectors: ['[role="tablist"] a[href$="/with_replies"]'],
						},
					],
	},
	{
		name: "bookmarks",
		label: "bookmarks",
		operation: "Bookmarks",
		stream: BOOKMARKS_STREAM,
		steps: () => [HISTORY_STEP],
	},
	{
		name: "likes",
		label: "likes",
		operation: "Likes",
		stream: LIKES_STREAM,
		steps: () => [
			HISTORY_STEP,
			{
				path: `${HISTORY_PATH}/likes`,
				selectors: [`[role="tablist"] a[href="${HISTORY_PATH}/likes"]`],
			},
		],
	},
];

/**
 * The part of the collect context this connector uses. Structural, so the
 * desktop runtime and the PageShim runtime both satisfy it.
 */
export interface XCollectContext {
	collectionMode?: BrowserCollectContext["collectionMode"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	page: Pick<Page, "evaluate" | "goto">;
	requested: BrowserCollectContext["requested"];
	state: Record<string, unknown>;
}

/** Overrides for tests. Production runs use the constants above. */
export interface XCollectOptions {
	actionDelayMs?: readonly [min: number, max: number];
	maxPostsPerRun?: number;
	maxScrollSteps?: number;
	ownerHandleRetryMs?: number;
	viewPostCaps?: Partial<Record<ViewName, number>>;
}

/**
 * What STATE holds for posts, likes and bookmarks: post ids only, and the
 * `since` the stored head was collected under when the run was range-limited.
 */
const cursorSchema = z.object({
	head_ids: z.array(z.string()).optional(),
	requested_since: z.string().nullable().optional(),
});
type StreamCursor = z.infer<typeof cursorSchema>;

const observedSchema = z.object({
	operation: z.string(),
	variables: z.string(),
	status: z.number(),
	wanted: z.boolean(),
	body: z.string(),
});
type Observed = z.infer<typeof observedSchema>;

const pollSchema = z.object({
	origin: z.string(),
	path: z.string(),
	userId: z.string().nullable(),
	hasCsrfCookie: z.boolean(),
	observerAlive: z.boolean(),
	entries: z.array(observedSchema),
	remaining: z.number(),
	dropped: z.number(),
	atBottom: z.boolean(),
});
type PageReading = z.infer<typeof pollSchema>;

const handleSchema = z.object({
	handle: z.string().nullable(),
	via: z.string(),
});
const navigationSchema = z.object({ via: z.string() });

const layoutControlSchema = z.object({
	tag: z.string(),
	testid: z.string().nullable(),
	ariaLabel: z.string().nullable(),
	role: z.string().nullable(),
	expanded: z.string().nullable(),
	scope: z.enum(["dialog", "page"]),
	path: z.string().nullable(),
});
const layoutSchema = z.object({
	width: z.number(),
	height: z.number(),
	path: z.string(),
	controls: z.array(layoutControlSchema),
});
export type LayoutControl = z.infer<typeof layoutControlSchema>;

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a page script in the page's main world. A throw (a navigation in
 * flight, a dead page) reads as null.
 *
 * Patchright, the desktop runtime's browser driver, runs evaluate() in an
 * isolated world by default. An isolated world shares the DOM with the page
 * but not its JavaScript objects, so an observer installed there would wrap
 * an XMLHttpRequest the web app never uses. The fourth argument opts into
 * the main world. Playwright and the PageShim page take no such argument and
 * ignore it; both already run page scripts in the main world.
 */
async function evaluateInPage(
	page: Pick<Page, "evaluate">,
	script: string,
): Promise<unknown> {
	try {
		return await (
			page as unknown as {
				evaluate(
					script: string,
					arg: undefined,
					options: undefined,
					isolatedContext: false,
				): Promise<unknown>;
			}
		).evaluate(script, undefined, undefined, false);
	} catch {
		return null;
	}
}

async function readPage(
	page: Pick<Page, "evaluate">,
): Promise<PageReading | null> {
	const parsed = pollSchema.safeParse(await evaluateInPage(page, POLL_SCRIPT));
	return parsed.success ? parsed.data : null;
}

function isSignedIn(reading: PageReading | null): reading is PageReading {
	return (
		reading !== null &&
		reading.origin === ORIGIN &&
		reading.userId !== null &&
		reading.hasCsrfCookie &&
		!SIGN_IN_PATH_RE.test(reading.path)
	);
}

/**
 * Whether the page shows a signed-in x.com session: on x.com, off the
 * sign-in and challenge paths, with the `twid` and `ct0` cookies present. It
 * reads the current page and never navigates, so it is safe to run while the
 * owner is part way through signing in, including on another origin during
 * single sign-on (where it answers false).
 */
export async function probeXSession(
	page: Pick<Page, "evaluate">,
): Promise<boolean> {
	return isSignedIn(await readPage(page));
}

/** Open x.com's home page, where a signed-out session is sent to sign-in. */
export async function openXHome(page: Pick<Page, "goto">): Promise<void> {
	await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
}

async function hasXSession(page: XCollectContext["page"]): Promise<boolean> {
	const reading = await readPage(page);
	if (reading?.origin !== ORIGIN) {
		await openXHome(page);
		return probeXSession(page);
	}
	return isSignedIn(reading);
}

export async function ensureXSession(args: EnsureSessionArgs): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await hasXSession(page)) {
		return;
	}
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	// The owner signs in. This code never fills in or reads a credential.
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to X in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => probeXSession(page),
		readinessProbe: probeXSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("x_session_dead");
	}
}

interface StreamPlan {
	/** Ids emitted for the stream in this run, across its views. */
	readonly emitted: Set<string>;
	/** Read to the cap whatever is already collected. */
	readonly fullWalk: boolean;
	readonly known: ReadonlySet<string>;
	/** In list order, newest first. */
	readonly newIds: string[];
	/** An ISO instant; posts created before it end the walk. */
	readonly since: string | null;
}

type ViewEnd =
	| "cap_reached"
	| "exhausted"
	| "older_than_range"
	| "reached_known";

/** One short code per view end, so a coverage line keeps several views. */
const VIEW_END_CODE: Readonly<Record<ViewEnd, string>> = {
	cap_reached: "cap",
	exhausted: "end",
	older_than_range: "old",
	reached_known: "known",
};

interface ViewOutcome {
	end: ViewEnd | null;
	failure: Failure | null;
	otherAuthors: number;
	pages: number;
	postResults: number;
	saved: number;
	unavailable: number;
	unreadable: number;
}

/** What the run did with the narrow layout's drawer before a layout report. */
type DrawerState = "clicked" | "no_control" | "not_tried";

interface Run {
	aborted: number;
	readonly ctx: XCollectContext;
	readonly delayRange: readonly [number, number];
	drawer: DrawerState;
	readonly maxPosts: number;
	readonly maxScrollSteps: number;
	layoutReported: boolean;
	navigations: Record<string, number>;
	ownerId: string;
	pageReadFailures: number;
	postsSeen: number;
	profile: ProfileRecord | null;
	profileFailure: Failure | null;
	stop: { readonly message: string; readonly reason: StopReason } | null;
	readonly viewCaps: Readonly<Record<ViewName, number>>;
}

function stopRun(run: Run, reason: StopReason, message: string): void {
	run.stop ??= { reason, message };
}

/** Wait a random time inside the action delay range. */
function pause(run: Run): Promise<void> {
	const [min, max] = run.delayRange;
	return delay(min + Math.random() * Math.max(0, max - min));
}

/** Why the session behind a page reading can no longer be read, if it cannot. */
function checkSession(run: Run, reading: PageReading): void {
	if (reading.origin !== ORIGIN) {
		stopRun(
			run,
			"collection_interrupted",
			"The browser left x.com, so the run stopped.",
		);
	} else if (SIGN_IN_PATH_RE.test(reading.path)) {
		stopRun(
			run,
			"sign_in_required",
			"X sent the session to its sign-in or challenge page, so the run stopped.",
		);
	} else if (reading.userId === null || !reading.hasCsrfCookie) {
		stopRun(
			run,
			"sign_in_required",
			"X signed the session out during the run, so the run stopped.",
		);
	} else if (reading.userId !== run.ownerId) {
		stopRun(
			run,
			"sign_in_required",
			"The X session changed to a different account during the run, so the run stopped.",
		);
	} else if (!reading.observerAlive) {
		stopRun(
			run,
			"collection_interrupted",
			"The X page reloaded, which loses the responses this connector reads, so the run stopped.",
		);
	} else if (reading.dropped > 0) {
		stopRun(
			run,
			"collection_interrupted",
			"X sent more responses than this connector could hold, so the run stopped.",
		);
	}
}

/** Stop the run on any observed response X did not answer with HTTP 200. */
function checkStatus(run: Run, entry: Observed): boolean {
	if (entry.status === 200) {
		return true;
	}
	if (entry.status === 0) {
		// The app abandoned the request (it does when the view changes).
		run.aborted += 1;
		return false;
	}
	if (entry.status === 429) {
		stopRun(
			run,
			"source_rate_limited",
			`X answered ${entry.operation} with HTTP 429 (rate limit), so the run stopped at once.`,
		);
	} else if (entry.status === 401) {
		stopRun(
			run,
			"sign_in_required",
			`X answered ${entry.operation} with HTTP 401, so the run stopped.`,
		);
	} else {
		stopRun(
			run,
			"collection_interrupted",
			`X answered ${entry.operation} with HTTP ${entry.status}, so the run stopped at once.`,
		);
	}
	return false;
}

interface Drained {
	readonly atBottom: boolean;
	readonly responses: readonly Observed[];
}

/**
 * Take everything the observer has buffered and check the session. Reading
 * the buffer is local to the page: it sends nothing to X.
 */
async function drain(run: Run): Promise<Drained> {
	const responses: Observed[] = [];
	let atBottom = false;
	while (run.stop === null) {
		const reading = await readPage(run.ctx.page);
		if (reading === null) {
			run.pageReadFailures += 1;
			if (run.pageReadFailures >= MAX_PAGE_READ_FAILURES) {
				stopRun(
					run,
					"collection_interrupted",
					"The X page stopped answering, so the run stopped.",
				);
			}
			break;
		}
		run.pageReadFailures = 0;
		atBottom = reading.atBottom;
		for (const entry of reading.entries) {
			if (run.stop !== null) {
				break;
			}
			if (checkStatus(run, entry) && entry.wanted) {
				responses.push(entry);
			}
		}
		checkSession(run, reading);
		if (reading.remaining === 0) {
			break;
		}
	}
	return { atBottom, responses };
}

/** Keep the owner's own `UserByScreenName` response; ignore anyone else's. */
function takeProfile(run: Run, entry: Observed): void {
	if (run.profile !== null) {
		return;
	}
	const parsed = parseProfileBody(entry.body);
	if (!parsed.ok) {
		if (parsed.failure === "error_body") {
			stopRun(run, "collection_interrupted", parsed.message);
		} else {
			run.profileFailure = {
				reason: "source_unreadable",
				message: parsed.message,
			};
		}
		return;
	}
	if (parsed.profile.id === run.ownerId) {
		run.profile = parsed.profile;
		run.profileFailure = null;
	}
}

function postData(post: PostRecord): Record<string, unknown> {
	return {
		...post,
		hashtags: [...post.hashtags],
		mention_handles: [...post.mention_handles],
		urls: [...post.urls],
		media: post.media.map((item) => ({ ...item })),
	};
}

/** Read one timeline response into the view's stream. */
async function takeTimelinePage(
	run: Run,
	view: View,
	plan: StreamPlan,
	outcome: ViewOutcome,
	seen: Set<string>,
	entry: Observed,
): Promise<void> {
	const variables = parseRequestVariables(entry.variables);
	// The three user timelines carry `userId`. Bookmarks carries none: it is
	// the session owner's by construction, so there is nothing to compare.
	if (variables.userId !== null && variables.userId !== run.ownerId) {
		// Someone else's timeline (a profile preview); never the owner's data.
		return;
	}
	const parsed = parseTimelineBody(view.operation, entry.body);
	if (!parsed.ok) {
		if (parsed.failure === "error_body") {
			stopRun(run, "collection_interrupted", parsed.message);
		} else {
			outcome.failure = {
				reason: "source_unreadable",
				message: parsed.message,
			};
		}
		return;
	}
	outcome.pages += 1;
	outcome.postResults += parsed.postResults;
	outcome.unavailable += parsed.unavailable;
	outcome.unreadable += parsed.unreadable;
	run.postsSeen += parsed.postResults;
	let fresh = 0;
	for (const { pinned, post } of parsed.items) {
		if (!seen.has(post.id)) {
			seen.add(post.id);
			fresh += 1;
		}
		if (view.stream === POSTS_STREAM && post.author_id !== run.ownerId) {
			// The other side of a reply thread. Read by the app, never saved.
			outcome.otherAuthors += 1;
			continue;
		}
		// The pinned post sits above the timeline whatever its age, so it
		// says nothing about where the already-collected posts begin.
		if (!(pinned || plan.fullWalk) && plan.known.has(post.id)) {
			outcome.end = "reached_known";
			break;
		}
		if (!pinned && plan.since !== null && post.created_at < plan.since) {
			outcome.end = "older_than_range";
			break;
		}
		const pinnedAndCollected =
			pinned && !plan.fullWalk && plan.known.has(post.id);
		if (plan.emitted.has(post.id) || pinnedAndCollected) {
			continue;
		}
		plan.emitted.add(post.id);
		plan.newIds.push(post.id);
		await run.ctx.emitRecord(view.stream, postData(post));
		outcome.saved += 1;
	}
	await run.ctx.emit({
		type: "PROGRESS",
		stream: view.stream,
		count: plan.emitted.size,
		message: `Reading your X ${view.label}: ${plan.emitted.size} saved so far`,
	});
	if (outcome.end !== null) {
		return;
	}
	if (parsed.postResults === 0 || fresh === 0 || parsed.bottomCursor === null) {
		// A page of cursors only, or of posts already seen: the list has ended.
		outcome.end = "exhausted";
	} else if (
		outcome.postResults >= run.viewCaps[view.name] ||
		run.postsSeen >= run.maxPosts
	) {
		outcome.end = "cap_reached";
	}
}

/**
 * A path with every handle-shaped or numeric segment masked, so a layout
 * diagnostic can name a control without naming the account it points at. The
 * static route words X uses are kept. It mirrors the handle and numeric-id
 * shapes parsers.ts already reads.
 */
export function redactPathShape(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => {
			if (segment === "") {
				return segment;
			}
			if (NUMERIC_ID_RE.test(segment)) {
				return ":id";
			}
			if (HANDLE_RE.test(segment) && !STATIC_PATH_SEGMENTS.has(segment)) {
				return ":handle";
			}
			return segment;
		})
		.join("/");
}

/**
 * The accessible name a layout diagnostic may name: any `@handle` becomes
 * ":handle" and the rest is clipped, so a name in a label cannot leave the
 * page whole.
 */
function clipAriaLabel(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	const masked = value.replace(AT_HANDLE_RE, ":handle");
	return masked.slice(0, LAYOUT_ARIA_LABEL_MAX_CHARS);
}

/**
 * One control line's fields, flat so the host reads them without a second JSON
 * parse. The keys are short because the whole line must fit the mobile host's
 * budget:
 *   i   1-based position in the emitted order
 *   n   total controls the page offered
 *   s   "d" when the control is inside an open dialog, omitted for the page
 *   t   tag name
 *   id  data-testid
 *   al  masked and clipped aria-label
 *   r   role
 *   x   aria-expanded
 *   p   handle-free, id-free path shape
 *   cut 1 when `al` or `p` was shortened to fit
 * Null or absent fields are left out entirely.
 */
type LayoutControlFields = Record<string, string | number>;

/** A control's full line before any fitting, with null fields left out. */
function baseControlFields(
	control: LayoutControl,
	index: number,
	total: number,
): LayoutControlFields {
	const fields: LayoutControlFields = { i: index, n: total, t: control.tag };
	if (control.scope === "dialog") {
		fields["s"] = "d";
	}
	if (control.testid !== null) {
		fields["id"] = control.testid;
	}
	const ariaLabel = clipAriaLabel(control.ariaLabel);
	if (ariaLabel !== null) {
		fields["al"] = ariaLabel;
	}
	if (control.role !== null) {
		fields["r"] = control.role;
	}
	if (control.expanded !== null) {
		fields["x"] = control.expanded;
	}
	if (control.path !== null) {
		fields["p"] = redactPathShape(control.path);
	}
	return fields;
}

/** One control line exactly as the formatter would write it. */
function formatControlLine(fields: LayoutControlFields): string {
	return formatConnectorDiagnostic(
		"x_browser",
		LAYOUT_CONTROL_EVENT,
		fields,
	);
}

/** Whether a control line fits the budget as the host measures it. */
function controlLineFits(fields: LayoutControlFields): boolean {
	return formatControlLine(fields).length <= DIAGNOSTIC_LINE_MAX_CHARS;
}

/**
 * Shorten a control line to the budget: the masked `aria-label` first, then
 * the path, each to its named minimum. A shortened line carries `cut:1`. `id`
 * is never dropped.
 */
function fitControlFields(fields: LayoutControlFields): LayoutControlFields {
	if (controlLineFits(fields)) {
		return fields;
	}
	const fitted: LayoutControlFields = { ...fields, cut: 1 };
	const ariaLabel = fitted["al"];
	if (typeof ariaLabel === "string") {
		fitted["al"] = ariaLabel.slice(0, LAYOUT_ARIA_LABEL_MIN_CHARS);
	}
	if (controlLineFits(fitted)) {
		return fitted;
	}
	const path = fitted["p"];
	if (typeof path === "string") {
		fitted["p"] = path.slice(0, LAYOUT_PATH_MIN_CHARS);
	}
	return fitted;
}

/**
 * One line per control, dialog controls first so a line cap never hides the
 * open drawer, then the page controls in the order the page offered them. A
 * control whose minimal line still does not fit is left out and counted rather
 * than emitted over budget; its `id` is never dropped from a line that is
 * written.
 */
function layoutControlLines(controls: readonly LayoutControl[]): {
	lines: LayoutControlFields[];
	omitted: number;
} {
	const total = controls.length;
	const ordered = [
		...controls.filter((control) => control.scope === "dialog"),
		...controls.filter((control) => control.scope !== "dialog"),
	].slice(0, LAYOUT_MAX_CONTROL_LINES);
	const lines: LayoutControlFields[] = [];
	for (const [position, control] of ordered.entries()) {
		const fields = fitControlFields(
			baseControlFields(control, position + 1, total),
		);
		if (controlLineFits(fields)) {
			lines.push(fields);
		}
	}
	return { lines, omitted: total - lines.length };
}

/** Redact a route and clip it to the first line's budget. */
function layoutRoute(pathname: string): string {
	return redactPathShape(pathname).slice(0, LAYOUT_ROUTE_MAX_CHARS);
}

/**
 * Name the current layout once per run, when a link the connector needs is
 * missing. One `layout` line carries the viewport, the redacted route, what
 * the run tried with the drawer, the total control count and the number of
 * control lines; then one `lc` line per control names it in the flat, short-key
 * shape baseControlFields documents (tag, test id, masked accessible name,
 * role, expanded state, dialog/page scope and handle/id-free path shape: no
 * text, no handle, no id, no token). Dialog controls come first, and every line
 * is measured against the mobile host's 150-character budget. A page the
 * connector cannot read reports nothing.
 */
async function reportLayout(run: Run): Promise<void> {
	if (run.layoutReported) {
		return;
	}
	run.layoutReported = true;
	const parsed = layoutSchema.safeParse(
		await evaluateInPage(run.ctx.page, LAYOUT_SCRIPT),
	);
	if (!parsed.success) {
		return;
	}
	const controls = parsed.data.controls;
	const { lines, omitted } = layoutControlLines(controls);
	connectorDiagnostic("x_browser", LAYOUT_EVENT, {
		width: parsed.data.width,
		height: parsed.data.height,
		path: layoutRoute(parsed.data.path),
		drawer: run.drawer,
		controls: controls.length,
		parts: lines.length,
		...(omitted > 0 ? { omitted } : {}),
	});
	for (const fields of lines) {
		connectorDiagnostic("x_browser", LAYOUT_CONTROL_EVENT, fields);
	}
}

/**
 * Open the app's own account-drawer control for `step`, or for the handle
 * lookup when no step is given; false when it is not there. A drawer already
 * open with the wanted link is left alone, so a second click cannot toggle it
 * shut before the link is followed.
 */
async function openDrawer(run: Run, step?: NavigationStep): Promise<boolean> {
	const parsed = navigationSchema.safeParse(
		await evaluateInPage(
			run.ctx.page,
			openDrawerScript(DRAWER_OPEN_SELECTORS, step?.path ?? null),
		),
	);
	const via = parsed.success ? parsed.data.via : "none";
	run.navigations[via] = (run.navigations[via] ?? 0) + 1;
	if (via === "none") {
		// A click that already happened still describes the run better than a
		// later miss does, so only an untouched drawer becomes "no_control".
		if (run.drawer !== "clicked") {
			run.drawer = "no_control";
		}
		return false;
	}
	if (via === "drawer") {
		await pause(run);
	}
	run.drawer = "clicked";
	return true;
}

/** Follow one step with the given fallback and count how it was reached. */
async function followStep(
	run: Run,
	step: NavigationStep,
	fallback: LinkFallback,
): Promise<string> {
	const parsed = navigationSchema.safeParse(
		await evaluateInPage(
			run.ctx.page,
			followLinkScript(step.selectors, step.path, fallback),
		),
	);
	const via = parsed.success ? parsed.data.via : "none";
	run.navigations[via] = (run.navigations[via] ?? 0) + 1;
	return via;
}

/**
 * Follow the app's links to a view. A link the narrow layout hides in the
 * account drawer is retried after opening the drawer; a link still missing is
 * reported before the history fallback. Each action is followed by a pause.
 */
async function openView(
	run: Run,
	steps: readonly NavigationStep[],
): Promise<Failure | null> {
	for (const step of steps) {
		let via = await followStep(run, step, "none");
		if (via === "none" && step.drawer) {
			await openDrawer(run, step);
			via = await followStep(run, step, "none");
		}
		if (via === "none") {
			await reportLayout(run);
			via = await followStep(run, step, "route");
		}
		if (via === "none") {
			return {
				reason: "source_unreadable",
				message: `X did not offer a way to open ${step.path} in this layout.`,
			};
		}
		if (via !== "already_there") {
			await pause(run);
		}
	}
	return null;
}

function emptyOutcome(): ViewOutcome {
	return {
		end: null,
		failure: null,
		otherAuthors: 0,
		pages: 0,
		postResults: 0,
		saved: 0,
		unavailable: 0,
		unreadable: 0,
	};
}

/**
 * Open one view and read it. With a plan, scroll its timeline until it
 * reaches posts already collected, the end of the list, or its cap. Without
 * one (only the profile was asked for), wait for the owner's profile response
 * and leave the timeline alone.
 */
async function readView(
	run: Run,
	view: View,
	handle: string | null,
	plan: StreamPlan | null,
): Promise<ViewOutcome> {
	const outcome = emptyOutcome();
	const steps = view.steps(handle);
	if (steps === null) {
		await reportLayout(run);
		outcome.failure = {
			reason: "source_unreadable",
			message:
				"X did not show a link to your profile in this layout, so your profile and posts could not be opened.",
		};
		return outcome;
	}
	outcome.failure = await openView(run, steps);
	if (outcome.failure !== null) {
		return outcome;
	}
	const seen = new Set<string>();
	let waited = 0;
	let idleAtBottom = 0;
	for (let step = 0; ; step += 1) {
		const drained = await drain(run);
		const pagesBefore = outcome.pages;
		for (const entry of drained.responses) {
			if (entry.operation === PROFILE_OPERATION) {
				takeProfile(run, entry);
			} else if (
				plan !== null &&
				entry.operation === view.operation &&
				outcome.end === null &&
				outcome.failure === null
			) {
				await takeTimelinePage(run, view, plan, outcome, seen, entry);
			}
		}
		const done =
			plan === null
				? run.profile !== null || run.profileFailure !== null
				: outcome.end !== null || outcome.failure !== null;
		if (run.stop !== null || done) {
			break;
		}
		if (outcome.pages === 0) {
			// Still waiting for the view's first response. Take no action.
			waited += 1;
			if (waited > NAVIGATION_WAIT_STEPS) {
				outcome.failure = {
					reason: "source_unreadable",
					message: `X did not load your ${plan === null ? "profile" : view.label} after the connector opened that page.`,
				};
				break;
			}
			await pause(run);
			continue;
		}
		idleAtBottom =
			outcome.pages === pagesBefore && drained.atBottom ? idleAtBottom + 1 : 0;
		if (idleAtBottom > MAX_IDLE_STEPS_AT_BOTTOM || step >= run.maxScrollSteps) {
			outcome.failure = {
				reason: "list_end_unconfirmed",
				message: `X stopped loading more ${view.label} before the list ended, so older ${view.label} may be missing.`,
			};
			break;
		}
		const share =
			SCROLL_VIEWPORT_SHARE_MIN +
			Math.random() * (SCROLL_VIEWPORT_SHARE_MAX - SCROLL_VIEWPORT_SHARE_MIN);
		await evaluateInPage(run.ctx.page, scrollScript(share));
		await pause(run);
	}
	return outcome;
}

function storedIds(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(id): id is string => typeof id === "string" && NUMERIC_ID_RE.test(id),
			)
		: [];
}

function instant(value: string | undefined): string | null {
	if (value === undefined) {
		return null;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * How one stream is read in this run, or null when it is not read: it was not
 * requested, or it was requested with a time range it cannot apply. posts
 * applies a range to `created_at`; likes and bookmarks have no time field to
 * apply one to (X does not say when a post was liked or bookmarked), and the
 * runtime reports that as scope_not_supported.
 */
function planStream(
	ctx: XCollectContext,
	stream: PostStream,
): StreamPlan | null {
	const request = ctx.requested.get(stream);
	if (request === undefined) {
		return null;
	}
	const range = request.time_range;
	const since = instant(range?.since);
	if (range !== undefined) {
		const boundsAreInstants =
			(range.since === undefined || since !== null) &&
			(range.until === undefined || instant(range.until) !== null);
		if (stream !== POSTS_STREAM || !boundsAreInstants) {
			return null;
		}
	}
	const stored = cursorSchema.safeParse(ctx.state[stream]);
	const cursor: StreamCursor = stored.success ? stored.data : {};
	const known = new Set(storedIds(cursor.head_ids));
	const storedSince =
		typeof cursor.requested_since === "string" ? cursor.requested_since : null;
	// The stored head was collected under a later `since` than this run's, so
	// posts older than it were never read.
	const rangeExpanded =
		storedSince !== null && (since === null || since < storedSince);
	return {
		emitted: new Set(),
		fullWalk:
			ctx.collectionMode === "full_refresh" ||
			known.size === 0 ||
			rangeExpanded,
		known,
		newIds: [],
		since,
	};
}

/** Order numeric id strings newest first (X ids grow with time). */
function byIdDescending(a: string, b: string): number {
	if (a.length !== b.length) {
		return b.length - a.length;
	}
	if (a === b) {
		return 0;
	}
	return a < b ? 1 : -1;
}

function nextCursor(stream: PostStream, plan: StreamPlan): StreamCursor {
	const merged = [...new Set([...plan.newIds, ...plan.known])];
	// Likes and bookmarks are in the order they were made, which their ids do
	// not follow; the run's own order (new first, then the stored head) is kept.
	if (stream === POSTS_STREAM) {
		merged.sort(byIdDescending);
	}
	return {
		head_ids: merged.slice(0, HEAD_IDS_KEPT),
		requested_since: plan.since,
	};
}

async function emitSkip(
	ctx: XCollectContext,
	stream: string,
	failure: Failure,
	diagnostics: Record<string, number>,
): Promise<void> {
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason: SKIP_REASON[failure.reason],
		recovery_hint: {
			action: RECOVERY_ACTION[failure.reason],
			retryable: false,
		},
		message: failure.message,
		diagnostics,
	});
}

function runStoppedEarly(run: Run, what: string): Failure | null {
	if (run.stop?.reason === "source_unreadable") {
		// The layout stopped the run before any view; that is every stream's reason.
		return run.stop;
	}
	return run.stop === null
		? null
		: {
				reason: "run_stopped_early",
				message: `The run stopped before your ${what} could be read. Nothing is wrong with them; run the connector again later.`,
			};
}

function sumOutcomes(outcomes: readonly ViewOutcome[]): Record<string, number> {
	const total = (pick: (outcome: ViewOutcome) => number) =>
		outcomes.reduce((sum, outcome) => sum + pick(outcome), 0);
	return {
		pages_read: total((outcome) => outcome.pages),
		post_results: total((outcome) => outcome.postResults),
		saved: total((outcome) => outcome.saved),
		other_authors: total((outcome) => outcome.otherAuthors),
		unavailable: total((outcome) => outcome.unavailable),
		unreadable: total((outcome) => outcome.unreadable),
	};
}

/** How each view ended, as codes, for the bounded coverage line. */
function viewEndCodes(outcomes: readonly ViewOutcome[]): string {
	return outcomes
		.map((outcome) =>
			outcome.end === null ? "open" : VIEW_END_CODE[outcome.end],
		)
		.join(",");
}

/** Report one post stream: a SKIP_RESULT when it fell short, else its STATE. */
async function finishStream(
	run: Run,
	stream: PostStream,
	plan: StreamPlan,
	outcomes: readonly ViewOutcome[],
	expectedViews: number,
): Promise<number> {
	const counts = sumOutcomes(outcomes);
	const viewFailure =
		outcomes.find((outcome) => outcome.failure !== null)?.failure ?? null;
	const unfinished =
		outcomes.length < expectedViews ||
		outcomes.some((outcome) => outcome.end === null);
	let failure: Failure | null = viewFailure;
	if (failure === null && unfinished) {
		// The stop reason belongs to the stream that was being read when the
		// run stopped; a stream not yet opened only reports that it was not read.
		failure =
			outcomes.length > 0 && run.stop !== null
				? run.stop
				: runStoppedEarly(run, stream);
	}
	if (failure === null && counts.unreadable) {
		failure = {
			reason: "records_unreadable",
			message: `${counts.unreadable} of your ${stream} had no usable id, author or date and ${counts.unreadable === 1 ? "was" : "were"} skipped.`,
		};
	}
	// Short keys and a second line keep every field inside the phone host's
	// budget; the README's diagnostics table names them.
	const ends = viewEndCodes(outcomes);
	connectorDiagnostic("x_browser", "coverage", {
		s: stream,
		st: failure === null ? "complete" : "partial",
		r: failure?.reason,
		e: ends,
		w: plan.fullWalk,
	});
	connectorDiagnostic("x_browser", "coverage_counts", {
		s: stream,
		p: counts["pages_read"],
		n: counts["post_results"],
		k: counts["saved"],
		o: counts["other_authors"],
		u: counts["unavailable"],
		x: counts["unreadable"],
	});
	if (failure !== null) {
		await emitSkip(run.ctx, stream, failure, counts);
	}
	// A stream that fell short keeps its old cursor, so the next run reads
	// from the top again instead of stopping above what this run missed.
	if (viewFailure === null && !unfinished) {
		await run.ctx.emit({
			type: "STATE",
			stream,
			cursor: nextCursor(stream, plan),
		});
	}
	return counts.saved ?? 0;
}

async function finishProfile(run: Run, attempted: boolean): Promise<number> {
	const failure: Failure | null =
		run.profile !== null
			? null
			: (run.profileFailure ??
				(attempted ? run.stop : null) ??
				runStoppedEarly(run, "profile") ?? {
					reason: "source_unreadable",
					message:
						"X did not send your profile details after the connector opened your profile.",
				});
	connectorDiagnostic("x_browser", "coverage", {
		s: PROFILE_STREAM,
		st: failure === null ? "complete" : "partial",
		r: failure?.reason,
	});
	if (run.profile === null || failure !== null) {
		if (failure !== null) {
			await emitSkip(run.ctx, PROFILE_STREAM, failure, {});
		}
		return 0;
	}
	await run.ctx.emitRecord(PROFILE_STREAM, { ...run.profile });
	return 1;
}

/** Read the owner's handle from the app's own profile link, with retries. */
async function readOwnerHandle(
	run: Run,
	retryMs: number,
): Promise<string | null> {
	for (let attempt = 0; attempt < OWNER_HANDLE_ATTEMPTS; attempt += 1) {
		if (attempt > 0) {
			// The app renders its navigation after the page loads.
			await delay(retryMs);
		}
		const parsed = handleSchema.safeParse(
			await evaluateInPage(run.ctx.page, OWNER_HANDLE_SCRIPT),
		);
		if (parsed.success && parsed.data.handle !== null) {
			connectorDiagnostic("x_browser", "owner_handle", {
				via: parsed.data.via,
			});
			return parsed.data.handle;
		}
	}
	return null;
}

/**
 * The owner's handle, or null when the layout does not show it. When no
 * profile link is present, the narrow layout is given one drawer click and
 * the link is looked for again; a layout with no drawer control still
 * reports null and the caller stops.
 */
async function findOwnerHandle(
	run: Run,
	retryMs: number,
): Promise<string | null> {
	const direct = await readOwnerHandle(run, retryMs);
	if (direct !== null) {
		return direct;
	}
	if (!(await openDrawer(run))) {
		return null;
	}
	return readOwnerHandle(run, retryMs);
}

/** Report every requested stream as needing sign-in. */
async function reportSignedOut(
	ctx: XCollectContext,
	streams: readonly string[],
): Promise<void> {
	for (const stream of streams) {
		await emitSkip(
			ctx,
			stream,
			{
				reason: "sign_in_required",
				message: "X needs you to sign in before this can be read.",
			},
			{},
		);
	}
}

export async function collectXBrowser(
	ctx: XCollectContext,
	options: XCollectOptions = {},
): Promise<void> {
	const profileRequested =
		ctx.requested.has(PROFILE_STREAM) &&
		ctx.requested.get(PROFILE_STREAM)?.time_range === undefined;
	const plans = new Map<PostStream, StreamPlan>();
	for (const stream of POST_STREAMS) {
		const plan = planStream(ctx, stream);
		if (plan !== null) {
			plans.set(stream, plan);
		}
	}
	if (!profileRequested && plans.size === 0) {
		return;
	}
	const requestedStreams = [
		...(profileRequested ? [PROFILE_STREAM] : []),
		...plans.keys(),
	];

	// A page already on the home timeline is not loaded again: every load of
	// it reads posts from the owner's allowance.
	let reading = await readPage(ctx.page);
	if (!(reading?.origin === ORIGIN && reading.path === HOME_PATH)) {
		await openXHome(ctx.page);
		reading = await readPage(ctx.page);
	}
	if (!isSignedIn(reading) || reading.userId === null) {
		await reportSignedOut(ctx, requestedStreams);
		return;
	}

	const run: Run = {
		aborted: 0,
		ctx,
		delayRange: options.actionDelayMs ?? [
			ACTION_DELAY_MIN_MS,
			ACTION_DELAY_MAX_MS,
		],
		drawer: "not_tried",
		maxPosts: options.maxPostsPerRun ?? MAX_POSTS_PER_RUN,
		maxScrollSteps: options.maxScrollSteps ?? MAX_SCROLL_STEPS_PER_VIEW,
		layoutReported: false,
		navigations: {},
		ownerId: reading.userId,
		pageReadFailures: 0,
		postsSeen: 0,
		profile: null,
		profileFailure: null,
		stop: null,
		viewCaps: { ...VIEW_POST_CAPS, ...options.viewPostCaps },
	};
	const installed = await evaluateInPage(
		ctx.page,
		installObserverScript({
			wanted: [PROFILE_OPERATION, ...TIMELINE_OPERATIONS],
			maxBuffered: OBSERVER_MAX_BUFFERED,
			errorBodyChars: OBSERVER_ERROR_BODY_CHARS,
		}),
	);
	if (installed === null) {
		stopRun(
			run,
			"collection_interrupted",
			"The connector could not start reading the X page.",
		);
	}

	const needsProfileView = profileRequested || plans.has(POSTS_STREAM);
	const handle =
		needsProfileView && run.stop === null
			? await findOwnerHandle(
					run,
					options.ownerHandleRetryMs ?? OWNER_HANDLE_RETRY_MS,
				)
			: null;
	if (needsProfileView && handle === null) {
		// The handle is only ever read from the app's own profile link. Without
		// one this layout is not the one the connector knows; name the controls
		// it does offer, then stop and open nothing.
		await reportLayout(run);
		stopRun(
			run,
			"source_unreadable",
			"X did not show a link to your profile in this layout, so the connector stopped without opening anything.",
		);
	}

	const outcomes = new Map<PostStream, ViewOutcome[]>();
	let profileAttempted = false;
	for (const view of VIEWS) {
		const plan = plans.get(view.stream) ?? null;
		const profileOnly =
			plan === null && view.name === "originals" && profileRequested;
		if (plan === null && !profileOnly) {
			continue;
		}
		if (run.stop !== null || run.postsSeen >= run.maxPosts) {
			break;
		}
		await ctx.emit({
			type: "PROGRESS",
			stream: profileOnly ? PROFILE_STREAM : view.stream,
			message: profileOnly
				? "Opening your X profile"
				: `Reading your X ${view.label}`,
		});
		if (view.name === "originals") {
			profileAttempted = true;
		}
		const outcome = await readView(run, view, handle, plan);
		if (view.name === "originals" && run.profile === null) {
			run.profileFailure ??= outcome.failure;
		}
		if (plan !== null) {
			outcomes.set(view.stream, [
				...(outcomes.get(view.stream) ?? []),
				outcome,
			]);
		}
	}
	if (run.stop === null && run.postsSeen >= run.maxPosts) {
		// The run's allowance is spent; streams not yet read wait for the next run.
		stopRun(
			run,
			"run_budget_reached",
			"This run reached the number of posts it allows itself to read from X.",
		);
	}

	const saved: Record<string, number> = {};
	if (profileRequested) {
		saved[PROFILE_STREAM] = await finishProfile(run, profileAttempted);
	}
	for (const [stream, plan] of plans) {
		saved[stream] = await finishStream(
			run,
			stream,
			plan,
			outcomes.get(stream) ?? [],
			VIEWS.filter((view) => view.stream === stream).length,
		);
	}
	connectorDiagnostic("x_browser", "run", {
		ps: run.postsSeen,
		stop: run.stop?.reason,
		ab: run.aborted,
		nav: Object.entries(run.navigations)
			.map(([via, count]) => `${via}:${count}`)
			.join(","),
	});
	const savedPosts = POST_STREAMS.reduce(
		(sum, stream) => sum + (saved[stream] ?? 0),
		0,
	);
	await ctx.emit({
		type: "PROGRESS",
		count: savedPosts,
		message:
			run.stop === null
				? `Finished reading X: ${savedPosts} saved`
				: `Stopped reading X early: ${savedPosts} saved`,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "x_browser",
		validateRecord,
		browser: { profileName: "x_browser" },
		ensureSession: ensureXSession,
		probeSession: ({ page }) => hasXSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectXBrowser(ctx),
	});
}
