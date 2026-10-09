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
	type TimelineItem,
	type TimelineOperation,
	type TimelineParse,
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

/** The one message a budget stop reports, whether it stops a walk or the run. */
const BUDGET_STOP_MESSAGE =
	"This run reached the number of posts it allows itself to read from X.";

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
/**
 * The accessible names the layout diagnostic may emit verbatim: X's own fixed
 * navigation labels. Any other name is replaced by LAYOUT_ARIA_LABEL_MASK,
 * because an `aria-label` can carry a display name, a bare handle or a
 * numeric id.
 */
const LAYOUT_ARIA_LABELS = new Set([
	"Back",
	"Bookmarks",
	"Close",
	"Communities",
	"Direct Messages",
	"Explore",
	"Grok",
	"History",
	"Home",
	"Lists",
	"Messages",
	"Notifications",
	"Profile",
	"Search and explore",
	"Settings and privacy",
]);
/** What a control with any other accessible name reports instead. */
const LAYOUT_ARIA_LABEL_MASK = "*";
/**
 * Shortest accessible name (`al`) and redacted path (`p`) a cut control line
 * keeps. `al` is shortened first, then `p`, and the line is marked `cut:1`.
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

/** A route token: a literal segment, a handle slot or a numeric-id slot. */
const HANDLE_TOKEN = ":handle";
const ID_TOKEN = ":id";
type PathToken = string | typeof HANDLE_TOKEN | typeof ID_TOKEN;

/**
 * Routes whose first segment is one of X's own fixed words. The whole path
 * must match, so a handle that happens to equal a route word is still masked
 * when it sits in a handle position (for example `/photo/following`).
 */
const STATIC_ROUTE_PATTERNS: readonly (readonly PathToken[])[] = [
	["home"],
	["explore"],
	["notifications"],
	["messages"],
	["search"],
	["login"],
	["logout"],
	["about"],
	["tos"],
	["privacy"],
	["compose", "post"],
	["hashtag", HANDLE_TOKEN],
	["status", ID_TOKEN],
	["settings"],
	["settings", "profile"],
	["settings", "account"],
	["settings", "security_and_account_access"],
	["settings", "privacy_and_safety"],
	["settings", "notifications"],
	["settings", "accessibility_display_and_languages"],
	["settings", "your_tweets"],
	["settings", "content_preferences"],
	["account", "access"],
	["account", "login_challenge"],
	["account", "locked"],
	["account", "suspended"],
	["intent", HANDLE_TOKEN],
	["share", HANDLE_TOKEN],
	["i", "history"],
	["i", "history", "likes"],
	["i", "bookmarks"],
	["i", "flow", "login"],
	["i", "flow", "signup"],
	["i", "lists"],
	["i", "communities"],
	["i", "messages"],
	["i", "notifications"],
	["i", "premium_sign_up"],
	["i", "follow_people"],
	["i", "connect_people"],
	["i", "verified_followers"],
	["i", "user", ID_TOKEN],
	["i", "account", HANDLE_TOKEN],
];

/**
 * Routes whose first segment is the owner's handle, so that segment is always
 * masked whatever word it carries.
 */
const HANDLE_ROUTE_PATTERNS: readonly (readonly PathToken[])[] = [
	[HANDLE_TOKEN],
	[HANDLE_TOKEN, "with_replies"],
	[HANDLE_TOKEN, "following"],
	[HANDLE_TOKEN, "followers"],
	[HANDLE_TOKEN, "media"],
	[HANDLE_TOKEN, "photo"],
	[HANDLE_TOKEN, "likes"],
	[HANDLE_TOKEN, "lists"],
	[HANDLE_TOKEN, "communities"],
	[HANDLE_TOKEN, "verified_followers"],
	[HANDLE_TOKEN, "status", ID_TOKEN],
	[HANDLE_TOKEN, "status", ID_TOKEN, "photo", HANDLE_TOKEN],
	[HANDLE_TOKEN, "status", ID_TOKEN, "analytics"],
];

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

const TIMELINE_OPERATION_SET: ReadonlySet<string> = new Set(
	TIMELINE_OPERATIONS,
);
/** Whether an observed operation is one this connector reads as a timeline. */
function isTimelineOperation(
	operation: string,
): operation is TimelineOperation {
	return TIMELINE_OPERATION_SET.has(operation);
}

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
 * the page script already validated. `followLinkScript` still checks the
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
 * For posts the head is split by view, so a run of replies cannot evict the
 * originals checkpoint.
 */
const cursorSchema = z.object({
	head_ids: z.array(z.string()).optional(),
	reply_head_ids: z.array(z.string()).optional(),
	requested_since: z.string().nullable().optional(),
});
type StreamCursor = z.infer<typeof cursorSchema>;

const observedSchema = z.object({
	operation: z.string(),
	variables: z.string(),
	status: z.number(),
	wanted: z.boolean(),
	body: z.string(),
	refused: z.boolean(),
	errorCode: z.number().nullable(),
	postCount: z.number(),
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
	/** Ids saved in this run, by view, newest first in each view's order. */
	readonly newIds: Map<ViewName, string[]>;
	/** The stored head ids by view, so one view cannot evict another's. */
	readonly stored: ReadonlyMap<ViewName, readonly string[]>;
	/** An ISO instant; posts created before it end the walk. */
	readonly since: string | null;
}

/** The ids this run saved for one view, created on first use. */
function viewIds(plan: StreamPlan, view: ViewName): string[] {
	const existing = plan.newIds.get(view);
	if (existing !== undefined) {
		return existing;
	}
	const created: string[] = [];
	plan.newIds.set(view, created);
	return created;
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
	/** Wanted responses drained but not yet read by the current view. */
	readonly pending: Observed[];
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

/**
 * Stop the run on an HTTP-200 refusal: `errors` with no `data`. The observer
 * keeps only the error code for an operation the run did not ask for, so the
 * signal is checked whether or not the operation was wanted.
 */
function checkRefusal(run: Run, entry: Observed): boolean {
	if (!entry.refused) {
		return true;
	}
	stopRun(
		run,
		"collection_interrupted",
		`X answered ${entry.operation} with an error and no data${entry.errorCode === null ? "" : ` (code ${entry.errorCode})`}, so the run stopped.`,
	);
	return false;
}

interface Drained {
	readonly atBottom: boolean;
}

/**
 * Take everything the observer has buffered and check the session. Reading
 * the buffer is local to the page: it sends nothing to X. Every response's
 * post count is applied to the run's budget as it is drained, wanted or not,
 * so a run stops as soon as the posts X sent reach the cap. Wanted responses
 * accumulate in `run.pending` until the current view reads them.
 */
async function drain(run: Run): Promise<Drained> {
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
			const answered = checkStatus(run, entry) && checkRefusal(run, entry);
			if (!answered) {
				continue;
			}
			// Every post X sent spends the owner's allowance, whichever view
			// the run is reading and whether or not this view reads it.
			run.postsSeen += entry.postCount;
			if (entry.wanted) {
				run.pending.push(entry);
			}
		}
		checkSession(run, reading);
		if (run.stop !== null) {
			break;
		}
		if (run.postsSeen >= run.maxPosts) {
			stopRun(run, "run_budget_reached", BUDGET_STOP_MESSAGE);
			break;
		}
		if (reading.remaining === 0) {
			break;
		}
	}
	return { atBottom };
}

/** Whether a page action changed the page, so the run waits before reading back. */
type ActionEffect = "changed" | "unchanged";

/**
 * Settle after one action on the page: wait out the action delay when the
 * action changed the page, then drain and check everything X answered. Every
 * page action ends here, so no action can follow another without a refusal, a
 * lost session or a spent budget being seen first.
 */
async function settleAction(run: Run, effect: ActionEffect): Promise<void> {
	if (effect === "changed") {
		await pause(run);
	}
	await drain(run);
}

/**
 * Whether an action script's own report means the page changed. A link click,
 * a history fallback, a drawer click and a scroll act on the page; being
 * already there, finding no link and finding no control do not.
 */
function actionEffect(result: unknown): ActionEffect {
	const parsed = navigationSchema.safeParse(result);
	const via = parsed.success ? parsed.data.via : "";
	return via === "link" ||
		via === "history" ||
		via === "drawer" ||
		via === "scroll"
		? "changed"
		: "unchanged";
}

/**
 * The only function that runs an action script on the page. It drains and
 * checks everything X answered before the action, so a refusal, a lost
 * session or a spent budget already buffered during a read stops the run
 * before any click or scroll; then it settles: pause when the page changed
 * and drain and check again. Every other evaluate call is a pure read that
 * acts on nothing.
 */
async function runAction(run: Run, script: string): Promise<string> {
	await drain(run);
	if (run.stop !== null) {
		return "none";
	}
	const result = await evaluateInPage(run.ctx.page, script);
	const parsed = navigationSchema.safeParse(result);
	await settleAction(run, actionEffect(result));
	return parsed.success ? parsed.data.via : "none";
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

/** Group contiguous conversation-module items; every other item stands alone. */
function groupModules(items: readonly TimelineItem[]): TimelineItem[][] {
	const groups: TimelineItem[][] = [];
	for (const item of items) {
		const last = groups.at(-1);
		if (item.module !== null && last?.[0]?.module === item.module) {
			last.push(item);
		} else {
			groups.push([item]);
		}
	}
	return groups;
}

/** Whether an item is the owner's own, in a stream that filters by author. */
function isOwnerItem(view: View, run: Run, item: TimelineItem): boolean {
	return view.stream !== POSTS_STREAM || item.post.author_id === run.ownerId;
}

/** Whether an item stands alone or shares a conversation module. */
type ItemScope = "entry" | "module";

/**
 * Read one item into the view's stream, or say why the walk stops there. A
 * known post ends the walk, except inside a conversation module: there the
 * module's newest owner post sets the boundary and every member is read first.
 */
async function takeItem(
	run: Run,
	view: View,
	plan: StreamPlan,
	outcome: ViewOutcome,
	item: TimelineItem,
	scope: ItemScope,
): Promise<ViewEnd | null> {
	const { pinned, post } = item;
	if (!isOwnerItem(view, run, item)) {
		// The other side of a reply thread. Read by the app, never saved.
		outcome.otherAuthors += 1;
		return null;
	}
	// The pinned post sits above the timeline whatever its age, so it says
	// nothing about where the already-collected posts begin.
	if (!(pinned || plan.fullWalk) && plan.known.has(post.id)) {
		return scope === "module" ? null : "reached_known";
	}
	if (!pinned && plan.since !== null && post.created_at < plan.since) {
		// Inside a module an out-of-range member is skipped rather than ending
		// the walk: the module's newest owner post sets the range boundary.
		return scope === "module" ? null : "older_than_range";
	}
	const pinnedAndCollected =
		pinned && !plan.fullWalk && plan.known.has(post.id);
	if (plan.emitted.has(post.id) || pinnedAndCollected) {
		return null;
	}
	plan.emitted.add(post.id);
	viewIds(plan, view.name).push(post.id);
	await run.ctx.emitRecord(view.stream, postData(post));
	outcome.saved += 1;
	return null;
}

/** Read one timeline response into the view's stream. */
async function takeTimelinePage(
	run: Run,
	view: View,
	plan: StreamPlan,
	outcome: ViewOutcome,
	seen: Set<string>,
	entry: Observed,
	parsed: TimelineParse,
): Promise<void> {
	const variables = parseRequestVariables(entry.variables);
	// The three user timelines carry `userId`. Bookmarks carries none: it is
	// the session owner's by construction, so there is nothing to compare.
	if (variables.userId !== null && variables.userId !== run.ownerId) {
		// Someone else's timeline (a profile preview); never the owner's data.
		return;
	}
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
	let fresh = 0;
	for (const item of parsed.items) {
		if (!seen.has(item.post.id)) {
			seen.add(item.post.id);
			fresh += 1;
		}
	}
	for (const group of groupModules(parsed.items)) {
		const module = group[0]?.module;
		const scope: ItemScope =
			module === undefined || module === null ? "entry" : "module";
		if (scope === "module") {
			// The boundary is the module's newest owner post, so a new reply
			// after an already-collected post is still read, and an old parent
			// out of range does not end the walk before a newer in-range child.
			const newestOwner = group
				.filter((item) => isOwnerItem(view, run, item))
				.at(-1);
			if (newestOwner !== undefined) {
				if (
					!(newestOwner.pinned || plan.fullWalk) &&
					plan.known.has(newestOwner.post.id)
				) {
					outcome.end = "reached_known";
					break;
				}
				if (
					!newestOwner.pinned &&
					plan.since !== null &&
					newestOwner.post.created_at < plan.since
				) {
					outcome.end = "older_than_range";
					break;
				}
			}
		}
		let ended: ViewEnd | null = null;
		for (const item of group) {
			ended = await takeItem(run, view, plan, outcome, item, scope);
			if (ended !== null) {
				break;
			}
		}
		if (ended !== null) {
			outcome.end = ended;
			break;
		}
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
	} else if (outcome.postResults >= run.viewCaps[view.name]) {
		// The view's own cap is the stream's stated bound. A run stopped on the
		// shared budget instead leaves the view open, so its cursor does not
		// move past what the budget stopped it from reading.
		outcome.end = "cap_reached";
	}
}

/** Decode one path segment; a malformed escape gives null. */
function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/** Whether every decoded segment of a path matches one route pattern. */
function matchesPattern(
	pattern: readonly PathToken[],
	segments: readonly string[],
): boolean {
	if (pattern.length !== segments.length) {
		return false;
	}
	return pattern.every((token, index) => {
		if (token === HANDLE_TOKEN || token === ID_TOKEN) {
			return true;
		}
		const decoded = decodeSegment(segments[index] ?? "");
		return decoded !== null && decoded === token;
	});
}

/** A matched pattern with its literals kept and its slots masked. */
function renderPattern(pattern: readonly PathToken[]): string {
	const parts = pattern.map((token) =>
		token === HANDLE_TOKEN ? ":handle" : token === ID_TOKEN ? ":id" : token,
	);
	return `/${parts.join("/")}`;
}

/** Every segment masked, a numeric one as an id and any other as a handle. */
function genericPathShape(segments: readonly string[]): string {
	const parts = segments.map((segment) => {
		const decoded = decodeSegment(segment);
		return decoded !== null && NUMERIC_ID_RE.test(decoded) ? ":id" : ":handle";
	});
	return `/${parts.join("/")}`;
}

/**
 * A path with every segment replaced by a placeholder unless the whole path
 * matches one of X's own positional route patterns. A first segment is a
 * handle unless the whole path matches a static-first route, so a handle that
 * equals a route word (`/photo/following`) is still masked. Segments are
 * decoded before matching, a trailing slash is dropped, and an unmatched path
 * becomes a generic placeholder shape so nothing raw can slip through.
 */
export function redactPathShape(pathname: string): string {
	if (pathname === "" || pathname === "/") {
		return pathname;
	}
	const segments = pathname.split("/");
	if (segments[0] === "") {
		segments.shift();
	}
	while (segments.length > 0 && segments[segments.length - 1] === "") {
		segments.pop();
	}
	for (const pattern of [...STATIC_ROUTE_PATTERNS, ...HANDLE_ROUTE_PATTERNS]) {
		if (matchesPattern(pattern, segments)) {
			return renderPattern(pattern);
		}
	}
	return genericPathShape(segments);
}

/**
 * The accessible name a layout diagnostic may emit: one of X's fixed
 * navigation labels verbatim, or LAYOUT_ARIA_LABEL_MASK for any other name.
 * The actual name is never written, because an `aria-label` can carry a
 * display name, a bare handle or a numeric id.
 */
function layoutAriaLabel(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	return LAYOUT_ARIA_LABELS.has(value) ? value : LAYOUT_ARIA_LABEL_MASK;
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
 *   al  fixed navigation label, or "*" for any other accessible name
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
	const ariaLabel = layoutAriaLabel(control.ariaLabel);
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
	return formatConnectorDiagnostic("x_browser", LAYOUT_CONTROL_EVENT, fields);
}

/** Whether a control line fits the budget as the host measures it. */
function controlLineFits(fields: LayoutControlFields): boolean {
	return formatControlLine(fields).length <= DIAGNOSTIC_LINE_MAX_CHARS;
}

/**
 * Shorten a control line to the budget: the accessible name first, then the
 * path, each to its named minimum. A shortened line carries `cut:1`. `id` is
 * never dropped.
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
 * shape baseControlFields documents (tag, test id, fixed navigation label,
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
	const via = await runAction(
		run,
		openDrawerScript(DRAWER_OPEN_SELECTORS, step?.path ?? null),
	);
	run.navigations[via] = (run.navigations[via] ?? 0) + 1;
	if (via === "none") {
		// A click that already happened still describes the run better than a
		// later miss does, so only an untouched drawer becomes "no_control".
		if (run.drawer !== "clicked") {
			run.drawer = "no_control";
		}
		return false;
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
	const via = await runAction(
		run,
		followLinkScript(step.selectors, step.path, fallback),
	);
	run.navigations[via] = (run.navigations[via] ?? 0) + 1;
	return via;
}

/**
 * Follow the app's links to a view. A link the narrow layout hides in the
 * account drawer is retried after opening the drawer; a link still missing is
 * reported before the history fallback. Each action settles before the next
 * one is taken, so a refusal or a lost session stops the run in between.
 */
async function openView(
	run: Run,
	view: View,
	steps: readonly NavigationStep[],
): Promise<Failure | null> {
	for (const step of steps) {
		let via = await followStep(run, step, "none");
		if (run.stop !== null) {
			return null;
		}
		if (via === "none" && step.drawer) {
			await openDrawer(run, step);
			if (run.stop !== null) {
				return null;
			}
			via = await followStep(run, step, "none");
			if (run.stop !== null) {
				return null;
			}
		}
		if (via === "none") {
			await reportLayout(run);
			via = await followStep(run, step, "route");
			if (run.stop !== null) {
				return null;
			}
		}
		if (via === "none") {
			return {
				reason: "source_unreadable",
				message: `X did not offer a way to open your ${view.label} in this layout.`,
			};
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
	outcome.failure = await openView(run, view, steps);
	if (outcome.failure !== null) {
		return outcome;
	}
	const seen = new Set<string>();
	let waited = 0;
	let idleAtBottom = 0;
	for (let step = 0; ; step += 1) {
		const drained = await drain(run);
		const pagesBefore = outcome.pages;
		const entries = run.pending.splice(0);
		for (const entry of entries) {
			if (entry.operation === PROFILE_OPERATION) {
				takeProfile(run, entry);
				continue;
			}
			if (!isTimelineOperation(entry.operation)) {
				continue;
			}
			const parsed = parseTimelineBody(entry.operation, entry.body);
			if (
				plan !== null &&
				entry.operation === view.operation &&
				outcome.end === null &&
				outcome.failure === null
			) {
				await takeTimelinePage(run, view, plan, outcome, seen, entry, parsed);
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
		await runAction(run, scrollScript(share));
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
	const storedByView = new Map<ViewName, readonly string[]>();
	if (stream === POSTS_STREAM) {
		// A cursor written before the split kept every post in `head_ids`;
		// treating it as the originals head still stops both views.
		storedByView.set("originals", storedIds(cursor.head_ids));
		storedByView.set("replies", storedIds(cursor.reply_head_ids));
	} else {
		storedByView.set(stream, storedIds(cursor.head_ids));
	}
	const known = new Set([...storedByView.values()].flat());
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
		newIds: new Map(),
		stored: storedByView,
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

/** The kept head for one view: this run's new ids first, then the stored ids. */
function headIds(plan: StreamPlan, view: ViewName): string[] {
	const merged = [
		...new Set([
			...(plan.newIds.get(view) ?? []),
			...(plan.stored.get(view) ?? []),
		]),
	];
	// Likes and bookmarks are in the order they were made, which their ids do
	// not follow; the run's own order (new first, then the stored head) is kept.
	if (view === "originals" || view === "replies") {
		merged.sort(byIdDescending);
	}
	return merged.slice(0, HEAD_IDS_KEPT);
}

function nextCursor(stream: PostStream, plan: StreamPlan): StreamCursor {
	if (stream === POSTS_STREAM) {
		return {
			head_ids: headIds(plan, "originals"),
			reply_head_ids: headIds(plan, "replies"),
			requested_since: plan.since,
		};
	}
	return {
		head_ids: headIds(plan, stream),
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
	// A stream that fell short in any way keeps its old cursor, so the next
	// run reads from the top again instead of stopping above what this run
	// missed.
	if (failure === null) {
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
		pending: [],
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
		stopRun(run, "run_budget_reached", BUDGET_STOP_MESSAGE);
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
