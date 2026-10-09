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
	ACTION_DELAY_MAX_MS,
	ACTION_DELAY_MIN_MS,
	collectXBrowser,
	ensureXSession,
	HOME_URL,
	LOGIN_URL,
	MAX_POSTS_PER_RUN,
	probeXSession,
	redactPathShape,
	VIEW_POST_CAPS,
	type XCollectContext,
	type XCollectOptions,
} from "./index.ts";
import {
	DRAWER_DIALOG_SELECTOR,
	DRAWER_OPEN_SELECTORS,
	drawerProfileSelector,
	LAYOUT_CONTAINER_SELECTOR,
	LAYOUT_CONTROL_CAP,
} from "./page-scripts.ts";
import { validateRecord } from "./schemas.ts";

const ORIGIN = "https://x.com";
const OWNER_ID = "1900000000000000001";
const HANDLE = "sample_owner";
const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

/** A response holding only a top and a bottom cursor: the end of a list. */
function cursorsOnly(bookmarks: boolean): string {
	const instructions = [
		{
			type: "TimelineAddEntries",
			entries: ["Top", "Bottom"].map((cursorType) => ({
				entryId: `cursor-${cursorType.toLowerCase()}-0`,
				sortIndex: "0",
				content: {
					entryType: "TimelineTimelineCursor",
					cursorType,
					value: `synthetic-end-${cursorType}`,
				},
			})),
		},
	];
	return JSON.stringify(
		bookmarks
			? { data: { bookmark_timeline_v2: { timeline: { instructions } } } }
			: {
					data: {
						user: { result: { timeline: { timeline: { instructions } } } },
					},
				},
	);
}

type Pages = Record<string, Record<string, string>>;

/** A one-page `HomeTimeline` body: a timeline the connector does not read. */
function homeTimelinePage(ids: readonly string[]): string {
	const entries = ids.map((id, index) => ({
		entryId: `tweet-${id}`,
		sortIndex: String(9_000_000_000 - index),
		content: {
			entryType: "TimelineTimelineItem",
			itemContent: {
				tweet_results: {
					result: {
						__typename: "Tweet",
						rest_id: id,
						legacy: {
							id_str: id,
							created_at: "Tue Oct 06 12:00:00 +0000 2026",
						},
					},
				},
			},
		},
	}));
	return JSON.stringify({
		data: {
			home: {
				home_timeline_urt: {
					instructions: [{ type: "TimelineAddEntries", entries }],
				},
			},
		},
	});
}

/** A one-page `UserRepliesTimeline` body of the owner's own replies. */
function ownerRepliesPage(ids: readonly string[]): string {
	const entries = ids.map((id, index) => ({
		entryId: `tweet-${id}`,
		sortIndex: String(9_000_000_000 - index),
		content: {
			entryType: "TimelineTimelineItem",
			itemContent: {
				tweet_results: {
					result: {
						__typename: "Tweet",
						rest_id: id,
						core: {
							user_results: {
								result: {
									rest_id: OWNER_ID,
									core: { screen_name: HANDLE },
								},
							},
						},
						legacy: {
							id_str: id,
							created_at: "Tue Oct 06 12:00:00 +0000 2026",
							full_text: `synthetic reply ${id}`,
							user_id_str: OWNER_ID,
							conversation_id_str: id,
							in_reply_to_status_id_str: "1990000000000000001",
							in_reply_to_screen_name: "example_writer",
						},
					},
				},
			},
		},
	}));
	return JSON.stringify({
		data: {
			user: {
				result: {
					timeline: {
						timeline: {
							instructions: [{ type: "TimelineAddEntries", entries }],
						},
					},
				},
			},
		},
	});
}

/** Response bodies by operation, then by request cursor ("" is the first page). */
function fixturePages(): Pages {
	return {
		UserByScreenName: { "": fixture("user-by-screen-name.json") },
		UserOriginalsTimeline: {
			"": fixture("user-originals-timeline-page-1.json"),
			"synthetic-originals-bottom-1": cursorsOnly(false),
		},
		UserRepliesTimeline: {
			"": fixture("user-replies-timeline-page-1.json"),
			"synthetic-replies-bottom-1": cursorsOnly(false),
		},
		Likes: {
			"": fixture("likes-page-1.json"),
			"synthetic-likes-bottom-1": fixture("likes-page-2.json"),
			"synthetic-likes-bottom-2": cursorsOnly(false),
		},
		Bookmarks: {
			"": fixture("bookmarks-page-1.json"),
			"synthetic-bookmarks-bottom-1": cursorsOnly(true),
		},
	};
}

interface AppRequest {
	cursor: string;
	operation: string;
	userId: string | null;
}

interface AppOptions {
	/** The narrow layout still renders a link named Profile. */
	profileLink?: boolean;
	/** The narrow layout renders an avatar control that opens the drawer. */
	drawer?: boolean;
	/** False: the drawer control is present but clicking it opens nothing. */
	drawerOpens?: boolean;
	/** Controls the layout diagnostic sees, replacing the default nav model. */
	layoutControls?: SyntheticLayoutControl[];
	pages?: Pages;
	/** Answer a request instead of the fixture pages. */
	respond?: (
		request: AppRequest,
	) => { status: number; body: string } | undefined;
	/** False: the app ignores `popstate`, so the history fallback goes nowhere. */
	routerFollowsHistory?: boolean;
	/** False: scrolling never loads another page. */
	scrollLoads?: boolean;
	/** False: the narrow layout, with no primary navigation. */
	sidebar?: boolean;
	signedIn?: boolean;
	startUrl?: string;
}

interface FakeXhr {
	open: (method: string, url: string) => void;
	send: () => void;
}

/** A synthetic control the layout diagnostic sees. */
interface SyntheticLayoutControl {
	ariaLabel: string;
	/** True: the control sits inside an open dialog. */
	dialog?: boolean;
	expanded?: string;
	href: string;
	role?: string;
	testid?: string;
}

/** One element the layout diagnostic can read, as the page scripts see it. */
interface AppControl {
	closest: (selector: string) => unknown;
	getAttribute: (name: string) => string | null;
	tagName: string;
}

/**
 * A model of the x.com web app, enough for the connector's page scripts to
 * run against unchanged. Each page load is a fresh `vm` context, so a load
 * drops the observer exactly as a real one does. The app routes on link
 * clicks and `popstate`, requests its GraphQL operations over an
 * XMLHttpRequest class the scripts can wrap, and requests the next page when
 * the window is scrolled.
 */
class FakeWebApp {
	readonly clicks: string[] = [];
	readonly gotos: string[] = [];
	readonly historyPushes: string[] = [];
	/** Called as each request is made, before it is answered. */
	onRequest: ((request: AppRequest) => void) | null = null;
	readonly requests: AppRequest[] = [];
	scrolls = 0;
	signedIn: boolean;

	private context: vm.Context = vm.createContext({});
	private drawerOpen = false;
	private readonly options: AppOptions;
	private posts = 0;
	private timeline: {
		cursor: string;
		ended: boolean;
		operation: string;
		variables: Record<string, unknown>;
	} | null = null;
	private window: Record<string, unknown> = {};

	constructor(options: AppOptions = {}) {
		this.options = options;
		this.signedIn = options.signedIn ?? true;
		this.load(options.startUrl ?? "about:blank");
	}

	get page(): XCollectContext["page"] {
		return {
			goto: async (url: string) => {
				this.gotos.push(url);
				this.load(url);
				return null;
			},
			evaluate: async (script: unknown, ...rest: unknown[]) => {
				assert.equal(typeof script, "string", "page scripts are strings");
				// Patchright's fourth argument: the page's main world, where the
				// web app's own XMLHttpRequest lives.
				assert.deepEqual(rest, [undefined, undefined, false]);
				const value = vm.runInContext(String(script), this.context);
				// A real evaluate serialises the result.
				return value === undefined
					? undefined
					: JSON.parse(JSON.stringify(value));
			},
		} as unknown as XCollectContext["page"];
	}

	get path(): string {
		return (this.window["location"] as { pathname: string }).pathname;
	}

	/** X drops the session cookies; the page stays where it is. */
	signOut(): void {
		this.signedIn = false;
		(this.window["document"] as { cookie: string }).cookie = "guest_id=v1%3A1";
	}

	/** X sends the page to its sign-in flow. */
	sendToSignIn(): void {
		(this.window["location"] as { pathname: string }).pathname =
			"/i/flow/login";
	}

	private load(url: string): void {
		const target = new URL(url);
		const onX = target.origin === ORIGIN;
		const live = onX && this.signedIn;
		const location = {
			origin: target.origin,
			pathname:
				onX && !this.signedIn && target.pathname !== "/login"
					? "/i/flow/login"
					: target.pathname,
			get href(): string {
				return `${this.origin}${this.pathname}`;
			},
		};
		const answer = (xhr: Xhr) => this.answer(xhr);
		class Xhr {
			private readonly listeners: Array<() => void> = [];
			responseText = "";
			responseType = "";
			status = 0;
			url = "";
			addEventListener(type: string, listener: () => void): void {
				if (type === "loadend") {
					this.listeners.push(listener);
				}
			}
			finish(status: number, body: string): void {
				this.status = status;
				this.responseText = body;
				for (const listener of this.listeners) {
					listener();
				}
			}
			open(_method: string, requestUrl: string): void {
				this.url = requestUrl;
			}
			send(): void {
				answer(this);
			}
		}
		// The layout diagnostic runs both passes in one script, so the same
		// element objects must come back or its de-duplication leaks duplicates.
		const layoutControls = this.navControls();
		const window: Record<string, unknown> = {
			location,
			document: {
				cookie: live
					? `guest_id=v1%3A1; twid=u%3D${OWNER_ID}; ct0=synthetic-csrf-token`
					: "guest_id=v1%3A1",
				documentElement: {
					scrollHeight: 800,
				},
				querySelector: (selector: string) => this.link(selector),
				querySelectorAll: (selector: string) =>
					selector === LAYOUT_CONTAINER_SELECTOR
						? [{ querySelectorAll: () => layoutControls }]
						: layoutControls,
			},
			history: {
				pushState: (_state: unknown, _title: string, path: string) => {
					this.historyPushes.push(path);
					location.pathname = path;
				},
			},
			dispatchEvent: (event: { type: string }) => {
				if (
					event.type === "popstate" &&
					this.options.routerFollowsHistory !== false
				) {
					this.render();
				}
				return true;
			},
			PopStateEvent: class {
				readonly type: string;
				constructor(type: string) {
					this.type = type;
				}
			},
			XMLHttpRequest: Xhr,
			URL,
			innerHeight: 800,
			innerWidth: 390,
			scrollY: 0,
			scrollBy: () => this.scroll(),
			scrollTo: () => {
				window["scrollY"] = 0;
			},
		};
		window["window"] = window;
		this.window = window;
		this.context = vm.createContext(window);
		this.timeline = null;
		this.posts = 0;
		if (live) {
			this.render();
		}
	}

	/**
	 * The drawer's own anchors, in the order the owner's 390 px browser showed
	 * them on 2026-10-09. Its profile and History links carry no test id and
	 * no accessible name, so only their hrefs are modelled.
	 */
	private drawerPaths(): string[] {
		return [
			`/${HANDLE}`,
			`/${HANDLE}`,
			`/${HANDLE}`,
			`/${HANDLE}/following`,
			`/${HANDLE}/verified_followers`,
			`/${HANDLE}`,
			"/i/follow_people",
			"/i/premium_sign_up",
			`/${HANDLE}/lists`,
			`/${HANDLE}/communities`,
			"/i/history",
			"/settings",
			"/logout",
		];
	}

	/** The open drawer, as the handle script reads it: its anchors, in order. */
	private dialog(): unknown {
		const paths = this.drawerPaths();
		return {
			querySelectorAll: (selector: string) =>
				selector === "a[href]"
					? paths.map((path) => ({
							getAttribute: (name: string) =>
								name === "href" ? path : null,
							tagName: "A",
						}))
					: [],
		};
	}

	/** One anchor the page scripts can follow. */
	private anchor(path: string): unknown {
		return {
			tagName: "A",
			href: `${ORIGIN}${path}`,
			getAttribute: (name: string) => (name === "href" ? path : null),
			click: () => {
				this.clicks.push(path);
				// A navigation closes the drawer, as the real app does.
				this.drawerOpen = false;
				(this.window["location"] as { pathname: string }).pathname = path;
				this.render();
			},
		};
	}

	/** The links the layout offers, by the selectors the connector uses. */
	private link(selector: string): unknown {
		const sidebar = this.options.sidebar !== false;
		const drawer = this.drawerOpen;
		const onProfile = this.path.startsWith(`/${HANDLE}`);
		const onHistory = this.path.startsWith("/i/history");
		if (selector === DRAWER_OPEN_SELECTORS[0]) {
			if (!(this.options.drawer === true && !this.drawerOpen)) {
				return null;
			}
			return {
				tagName: "BUTTON",
				getAttribute: (name: string) =>
					name === "data-testid" ? "DashButton_ProfileIcon_Link" : null,
				click: () => {
					if (this.options.drawerOpens !== false) {
						this.drawerOpen = true;
					}
				},
			};
		}
		if (selector === DRAWER_DIALOG_SELECTOR) {
			return drawer ? this.dialog() : null;
		}
		// The wide layout's own navigation, with its test id and accessible
		// name. The observed drawer renders neither.
		const sidebarLinks: Record<string, string | null> = {
			'a[data-testid="AppTabBar_Profile_Link"]': sidebar ? `/${HANDLE}` : null,
			'a[aria-label="Profile"]':
				sidebar || this.options.profileLink ? `/${HANDLE}` : null,
			'nav[aria-label="Primary"] a[href="/i/history"]': sidebar
				? "/i/history"
				: null,
		};
		if (selector in sidebarLinks) {
			const path = sidebarLinks[selector];
			return path && this.signedIn ? this.anchor(path) : null;
		}
		// The drawer's profile link, addressed by the href built from the handle.
		if (selector === drawerProfileSelector(HANDLE)) {
			const hasProfile = this.drawerPaths().includes(`/${HANDLE}`);
			return drawer && hasProfile && this.signedIn
				? this.anchor(`/${HANDLE}`)
				: null;
		}
		const offered: Record<string, string | null> = {
			'a[href="/i/history"]':
				sidebar || (drawer && this.drawerPaths().includes("/i/history"))
					? "/i/history"
					: null,
			'[role="tablist"] a[href$="/with_replies"]': onProfile
				? `/${HANDLE}/with_replies`
				: null,
			'[role="tablist"] a[href="/i/history/likes"]': onHistory
				? "/i/history/likes"
				: null,
		};
		assert.ok(selector in offered, `unexpected selector: ${selector}`);
		const path = offered[selector];
		if (!(path && this.signedIn)) {
			return null;
		}
		return this.anchor(path);
	}

	/** The controls the layout diagnostic sees, inside a nav-like container. */
	private navControls(): AppControl[] {
		const injected = this.options.layoutControls;
		if (injected !== undefined) {
			return injected.map((control) => ({
				closest: (selector: string) =>
					selector === '[role="dialog"]' && control.dialog === true
						? { tagName: "DIV" }
						: null,
				getAttribute: (name: string) => {
					const attributes: Record<string, string | undefined> = {
						"aria-expanded": control.expanded,
						"aria-label": control.ariaLabel,
						"data-testid": control.testid,
						href: control.href,
						role: control.role,
					};
					return attributes[name] ?? null;
				},
				tagName: "A",
			}));
		}
		const sidebar = this.options.sidebar !== false;
		const navOpen = sidebar || this.drawerOpen;
		const control = (
			tagName: string,
			attributes: Record<string, string>,
			scope: "dialog" | "page" = "page",
		): AppControl => ({
			closest: (selector: string) =>
				selector === '[role="dialog"]' && scope === "dialog"
					? { tagName: "DIV" }
					: null,
			getAttribute: (name: string) => attributes[name] ?? null,
			tagName,
		});
		const controls = [
			control("A", { href: "/explore", "aria-label": "Explore" }),
			control("A", { href: "/notifications", "aria-label": "Notifications" }),
			control("A", { href: "/messages", "aria-label": "Messages" }),
			// A control whose href names the account and a numeric id: the
			// diagnostic must mask both.
			control("A", {
				href: `/${HANDLE}/status/${OWNER_ID}`,
				"aria-label": "Post",
			}),
			// The account control: the diagnostic must mask and clip its name.
			control("BUTTON", {
				"aria-expanded": "true",
				"aria-label": `Account menu for @${HANDLE} and the synthetic timeline`,
				"data-testid": "AvatarDrawerButton",
				role: "button",
			}),
			// A control in an open dialog: the diagnostic must call it "dialog".
			control(
				"BUTTON",
				{ "aria-label": "Close", "data-testid": "DialogClose" },
				"dialog",
			),
		];
		if (navOpen) {
			controls.push(
				control("A", { href: "/i/history", "aria-label": "History" }),
				control("A", {
					href: `/${HANDLE}`,
					"data-testid": "AppTabBar_Profile_Link",
				}),
			);
		}
		if (this.options.drawer === true && !this.drawerOpen) {
			controls.push(
				control("BUTTON", {
					"data-testid": "DashButton_ProfileIcon_Link",
					role: "button",
				}),
			);
		}
		return controls;
	}

	private render(): void {
		this.timeline = null;
		this.posts = 0;
		this.setScroll(0);
		const path = this.path;
		if (path === `/${HANDLE}`) {
			this.request("UserByScreenName", { screen_name: HANDLE });
			this.open("UserOriginalsTimeline", {
				userId: OWNER_ID,
				count: 20,
				includePromotedContent: true,
				withQuickPromoteEligibilityTweetFields: true,
				withVoice: true,
			});
		} else if (path === `/${HANDLE}/with_replies`) {
			this.open("UserRepliesTimeline", {
				userId: OWNER_ID,
				count: 20,
				includePromotedContent: true,
				withCommunity: true,
				withVoice: true,
			});
		} else if (path === "/i/history") {
			// Bookmarks carries no userId.
			this.open("Bookmarks", { count: 20, includePromotedContent: true });
		} else if (path === "/i/history/likes") {
			this.open("Likes", {
				userId: OWNER_ID,
				count: 20,
				includePromotedContent: false,
				withClientEventToken: false,
				withBirdwatchNotes: false,
				withVoice: true,
			});
		} else {
			// The app makes GraphQL requests the connector does not read.
			this.request("HomeTimeline", { count: 20 });
		}
	}

	private open(operation: string, variables: Record<string, unknown>): void {
		this.timeline = { operation, variables, cursor: "", ended: false };
		this.request(operation, variables);
	}

	private setScroll(scrollY: number): void {
		this.window["scrollY"] = scrollY;
		const document = this.window["document"] as {
			documentElement: { scrollHeight: number };
		};
		document.documentElement.scrollHeight = 800 + this.posts * 320;
	}

	private scroll(): void {
		this.scrolls += 1;
		// Every step in this model reaches the bottom of what is loaded.
		this.setScroll(this.posts * 320);
		const timeline = this.timeline;
		if (
			timeline !== null &&
			!timeline.ended &&
			this.options.scrollLoads !== false
		) {
			this.request(timeline.operation, {
				...timeline.variables,
				cursor: timeline.cursor,
			});
		}
	}

	/** Make one GraphQL request the connector did not ask for. */
	request(operation: string, variables: Record<string, unknown>): void {
		const XhrClass = this.window["XMLHttpRequest"] as new () => FakeXhr;
		const xhr = new XhrClass();
		// A different query id on every request: the connector must not care.
		xhr.open(
			"GET",
			`/i/api/graphql/Qid${this.requests.length}x/${operation}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=%7B%7D`,
		);
		xhr.send();
	}

	private answer(xhr: {
		finish: (status: number, body: string) => void;
		url: string;
	}): void {
		const url = new URL(xhr.url, ORIGIN);
		const operation = url.pathname.split("/").at(-1) ?? "";
		const variables = JSON.parse(url.searchParams.get("variables") ?? "{}");
		const request: AppRequest = {
			operation,
			cursor: typeof variables.cursor === "string" ? variables.cursor : "",
			userId: typeof variables.userId === "string" ? variables.userId : null,
		};
		this.requests.push(request);
		this.onRequest?.(request);
		const pages = this.options.pages ?? fixturePages();
		const response = this.options.respond?.(request) ?? {
			status: 200,
			body: pages[operation]?.[request.cursor] ?? '{"data":{"viewer":{}}}',
		};
		const timeline = this.timeline;
		if (timeline !== null && timeline.operation === operation) {
			const entries: Array<{
				content?: { cursorType?: string; entryType?: string; value?: string };
			}> = [];
			try {
				const data = JSON.parse(response.body).data;
				const instructions =
					data.bookmark_timeline_v2?.timeline.instructions ??
					data.user.result.timeline.timeline.instructions;
				for (const instruction of instructions) {
					entries.push(...(instruction.entries ?? []));
				}
			} catch {
				timeline.ended = true;
			}
			const posts = entries.filter(
				(entry) => entry.content?.entryType !== "TimelineTimelineCursor",
			).length;
			const bottom = entries.find(
				(entry) => entry.content?.cursorType === "Bottom",
			)?.content?.value;
			this.posts += posts;
			timeline.cursor = bottom ?? "";
			if (response.status !== 200 || posts === 0 || !bottom) {
				timeline.ended = true;
			}
		}
		xhr.finish(response.status, response.body);
	}
}

const FAST: XCollectOptions = { actionDelayMs: [0, 0], ownerHandleRetryMs: 0 };
const ALL = ["profile", "posts", "likes", "bookmarks"];

const POST_IDS = [
	"1890000000000000090",
	"1990000000000000105",
	"1990000000000000104",
	"1990000000000000103",
	"1990000000000000102",
	"1990000000000000202",
	"1990000000000000204",
];
const LIKE_IDS = [
	"1990000000000000301",
	"1980000000000000302",
	"1990000000000000303",
	"1970000000000000304",
	"1960000000000000305",
];
const BOOKMARK_IDS = ["1990000000000000401", "1950000000000000402"];

function harness(
	app: FakeWebApp,
	names: string[] = ALL,
	extra: {
		collectionMode?: "full_refresh" | "incremental";
		state?: Record<string, unknown>;
		timeRanges?: Record<string, { since?: string; until?: string }>;
	} = {},
) {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const ctx: XCollectContext = {
		collectionMode: extra.collectionMode,
		page: app.page,
		state: extra.state ?? {},
		requested: new Map(
			names.map((name) => [
				name,
				{
					name,
					...(extra.timeRanges?.[name]
						? { time_range: extra.timeRanges[name] }
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
	const ids = (stream: string) =>
		records.filter((r) => r.stream === stream).map((r) => r.data["id"]);
	const skips = () =>
		Object.fromEntries(
			messages
				.filter((m) => m.type === "SKIP_RESULT")
				.map((m) => [m.stream, (m as { reason?: string }).reason]),
		);
	const states = (): Record<string, unknown> =>
		Object.fromEntries(
			messages
				.filter((m) => m.type === "STATE")
				.map((m) => [m.stream, (m as { cursor?: unknown }).cursor]),
		);
	const lastProgress = () => {
		const last = messages.at(-1);
		return last?.type === "PROGRESS" ? last.message : undefined;
	};
	return { ctx, ids, lastProgress, messages, records, skips, states };
}

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

const requestLog = (app: FakeWebApp) =>
	app.requests.map(({ operation, cursor }) =>
		cursor ? `${operation}@${cursor}` : operation,
	);

/**
 * A page whose evaluate runs `onScript` after any page script, so a test can
 * make one action (a drawer click) produce a response or a lost session that
 * the connector must check before it takes the next action.
 */
function hookedPage(
	app: FakeWebApp,
	onScript: (script: string) => void,
): XCollectContext["page"] {
	const base = app.page;
	const evaluate = base.evaluate as (...args: unknown[]) => Promise<unknown>;
	return {
		goto: base.goto,
		evaluate: (async (...args: unknown[]) => {
			const value = await evaluate(...args);
			onScript(String(args[0]));
			return value;
		}) as XCollectContext["page"]["evaluate"],
	};
}

/** The one layout report's first line and every control it named, in order. */
function layoutReport(lines: string[]): {
	controls: Array<Record<string, unknown>>;
	layout: Record<string, unknown>;
	lines: string[];
} {
	const reportLines = lines.filter((line) =>
		/^\[x_browser-diagnostic\] (?:layout|lc) /.test(line),
	);
	const firstLines = reportLines.filter((line) =>
		line.startsWith("[x_browser-diagnostic] layout "),
	);
	assert.equal(firstLines.length, 1, "exactly one layout report per run");
	const first = firstLines[0] ?? "";
	const controls = reportLines
		.filter((line) => line.startsWith("[x_browser-diagnostic] lc "))
		.map(
			(line) =>
				JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
		);
	return {
		controls,
		layout: JSON.parse(first.slice(first.indexOf("{"))),
		lines: reportLines,
	};
}

test("a first run reads the profile, posts, bookmarks and likes the app loads", async () => {
	const app = new FakeWebApp();
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));

	assert.deepEqual(app.gotos, [HOME_URL]);
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(h.ids("posts"), POST_IDS);
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
	assert.deepEqual(h.skips(), {});

	// Only the owner's own posts are saved from the threads the app loaded.
	const posts = h.records.filter((r) => r.stream === "posts");
	assert.ok(posts.every((r) => r.data["author_id"] === OWNER_ID));
	assert.deepEqual(
		posts.map((r) => r.data["kind"]),
		["post", "post", "post", "quote", "post", "reply", "reply"],
	);
	// A liked post carries who wrote it and what it says.
	const like = h.records.find((r) => r.stream === "likes")?.data;
	assert.equal(like?.["author_handle"], "example_writer");
	assert.equal(like?.["author_name"], "Example Writer");
	assert.equal(like?.["text"], "Synthetic liked post one.");

	// It followed the app's own links, in order, and nothing else.
	assert.deepEqual(app.clicks, [
		`/${HANDLE}`,
		`/${HANDLE}/with_replies`,
		"/i/history",
		"/i/history/likes",
	]);
	assert.deepEqual(app.historyPushes, []);
	// Every request is the app's own. The home timeline loaded before the
	// observer existed; each list was read to a page of cursors only.
	assert.deepEqual(requestLog(app), [
		"HomeTimeline",
		"UserByScreenName",
		"UserOriginalsTimeline",
		"UserOriginalsTimeline@synthetic-originals-bottom-1",
		"UserRepliesTimeline",
		"UserRepliesTimeline@synthetic-replies-bottom-1",
		"Bookmarks",
		"Bookmarks@synthetic-bookmarks-bottom-1",
		"Likes",
		"Likes@synthetic-likes-bottom-1",
		"Likes@synthetic-likes-bottom-2",
	]);
	assert.equal(app.scrolls, 5);

	// STATE holds ids only, split by view for posts: the newest of each list.
	assert.deepEqual(h.states(), {
		posts: {
			head_ids: [
				"1990000000000000105",
				"1990000000000000104",
				"1990000000000000103",
				"1990000000000000102",
				"1890000000000000090",
			],
			reply_head_ids: ["1990000000000000204", "1990000000000000202"],
			requested_since: null,
		},
		bookmarks: { head_ids: BOOKMARK_IDS, requested_since: null },
		likes: { head_ids: LIKE_IDS, requested_since: null },
	});
	assertUserFacingProgress(h.messages);
	assert.equal(h.lastProgress(), "Finished reading X: 14 saved");

	const coverage = lines
		.filter((line) => line.startsWith("[x_browser-diagnostic] coverage "))
		.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
	assert.deepEqual(
		coverage.map((c) => [c.s, c.st, c.e]),
		[
			["profile", "complete", undefined],
			["posts", "complete", "end,end"],
			["bookmarks", "complete", "end"],
			["likes", "complete", "end"],
		],
	);
	// The counters ride a second short line so every line fits the phone host.
	const counts = lines
		.filter((line) =>
			line.startsWith("[x_browser-diagnostic] coverage_counts "),
		)
		.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
	assert.equal(counts.length, coverage.length - 1);
	assert.equal(
		counts.reduce((sum, c) => sum + Number(c.k), 0),
		14,
	);
	const countKeys = ["p", "n", "k", "o", "u", "x"];
	assert.ok(
		counts.every((c) =>
			countKeys.every((key) => typeof c[key] === "number"),
		),
	);
	// 6 + 5 on the profile, 2 bookmarks, 5 likes: what the run cost.
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"ps":18/);
	// Every diagnostic the run writes fits the phone host's line budget.
	for (const line of lines) {
		assert.ok(
			line.length <= DIAGNOSTIC_LINE_MAX_CHARS,
			`${line.length} chars: ${line}`,
		);
	}
	// Diagnostics carry counts, never ids, handles or text.
	assert.ok(
		!lines.some((line) => /sample_owner|19\d{17}|Synthetic/.test(line)),
	);
});

test("a page already on the home timeline is not loaded again", async () => {
	const app = new FakeWebApp({ startUrl: HOME_URL });
	const h = harness(app, ["bookmarks"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(app.gotos, []);
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	// Only bookmarks was asked for, so the profile was never opened.
	assert.deepEqual(app.clicks, ["/i/history"]);
});

test("a later run stops each list at the first post already collected", async () => {
	const first = new FakeWebApp();
	const h1 = harness(first);
	await collectXBrowser(h1.ctx, FAST);

	const app = new FakeWebApp();
	const h = harness(app, ALL, { state: h1.states() });
	await collectXBrowser(h.ctx, FAST);
	// The profile is current state, read again; nothing else is new.
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(h.ids("posts"), []);
	assert.deepEqual(h.ids("bookmarks"), []);
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(h.skips(), {});
	// One response per list, the one the app loads on opening it. No scroll.
	assert.deepEqual(requestLog(app), [
		"HomeTimeline",
		"UserByScreenName",
		"UserOriginalsTimeline",
		"UserRepliesTimeline",
		"Bookmarks",
		"Likes",
	]);
	assert.equal(app.scrolls, 0);
	assert.deepEqual(h.states(), h1.states());
});

test("a later run saves only what is newer, past a known pinned post", async () => {
	const first = new FakeWebApp();
	const h1 = harness(first);
	await collectXBrowser(h1.ctx, FAST);

	// One new like at the top of the list.
	const pages = fixturePages();
	const likes = JSON.parse(pages["Likes"]?.[""] ?? "");
	const entries =
		likes.data.user.result.timeline.timeline.instructions[0].entries;
	const added = structuredClone(entries[0]);
	added.entryId = "tweet-1990000000000000999";
	added.sortIndex = "2000000000000000999";
	added.content.itemContent.tweet_results.result.rest_id =
		"1990000000000000999";
	added.content.itemContent.tweet_results.result.legacy.id_str =
		"1990000000000000999";
	entries.unshift(added);
	(pages["Likes"] as Record<string, string>)[""] = JSON.stringify(likes);
	// One new post below the pinned post, which is already collected.
	const originals = JSON.parse(pages["UserOriginalsTimeline"]?.[""] ?? "");
	const postEntries =
		originals.data.user.result.timeline.timeline.instructions[2].entries;
	const newPost = structuredClone(postEntries[0]);
	newPost.entryId = "tweet-1990000000000000888";
	newPost.content.itemContent.tweet_results.result.rest_id =
		"1990000000000000888";
	newPost.content.itemContent.tweet_results.result.legacy.id_str =
		"1990000000000000888";
	postEntries.unshift(newPost);
	(pages["UserOriginalsTimeline"] as Record<string, string>)[""] =
		JSON.stringify(originals);

	const app = new FakeWebApp({ pages });
	const h = harness(app, ALL, { state: h1.states() });
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("posts"), ["1990000000000000888"]);
	assert.deepEqual(h.ids("likes"), ["1990000000000000999"]);
	assert.deepEqual(h.ids("bookmarks"), []);
	assert.equal(app.scrolls, 0);
	const states = h.states() as Record<string, { head_ids: string[] }>;
	assert.equal(states["likes"]?.head_ids[0], "1990000000000000999");
	assert.deepEqual(states["likes"]?.head_ids.slice(1), LIKE_IDS);
	assert.equal(states["posts"]?.head_ids[0], "1990000000000000888");
});

test("a new reply after a known post in the same module is still read", async () => {
	const pages = fixturePages();
	const replies = JSON.parse(pages["UserRepliesTimeline"]?.[""] ?? "");
	const entries =
		replies.data.user.result.timeline.timeline.instructions[0].entries;
	const module = entries.find(
		(entry: { content?: { entryType?: string } }) =>
			entry.content?.entryType === "TimelineTimelineModule",
	);
	assert.ok(module);
	// The module's first post is the owner's too, already collected; the
	// reply under it is new.
	const parent = module.content.items[0].item.itemContent.tweet_results.result;
	parent.legacy.user_id_str = OWNER_ID;
	parent.core.user_results.result.rest_id = OWNER_ID;
	parent.core.user_results.result.core.screen_name = HANDLE;
	(pages["UserRepliesTimeline"] as Record<string, string>)[""] =
		JSON.stringify(replies);

	const app = new FakeWebApp({ pages });
	const h = harness(app, ["posts"], {
		state: { posts: { head_ids: ["1990000000000000201"], requested_since: null } },
	});
	await collectXBrowser(h.ctx, FAST);
	assert.ok(h.ids("posts").includes("1990000000000000202"));
});

test("a range walk skips an out-of-range module parent and keeps its newer reply", async () => {
	const pages = fixturePages();
	const replies = JSON.parse(pages["UserRepliesTimeline"]?.[""] ?? "");
	const entries =
		replies.data.user.result.timeline.timeline.instructions[0].entries;
	const module = entries.find(
		(entry: { content?: { entryType?: string } }) =>
			entry.content?.entryType === "TimelineTimelineModule",
	);
	assert.ok(module);
	// Both module posts are the owner's: an old parent and a newer reply.
	const parent = module.content.items[0].item.itemContent.tweet_results.result;
	const reply = module.content.items[1].item.itemContent.tweet_results.result;
	parent.legacy.user_id_str = OWNER_ID;
	parent.core.user_results.result.rest_id = OWNER_ID;
	parent.core.user_results.result.core.screen_name = HANDLE;
	parent.legacy.created_at = "Mon Sep 28 12:00:00 +0000 2026";
	reply.legacy.user_id_str = OWNER_ID;
	reply.core.user_results.result.rest_id = OWNER_ID;
	reply.core.user_results.result.core.screen_name = HANDLE;
	reply.legacy.created_at = "Fri Oct 02 12:00:00 +0000 2026";
	(pages["UserRepliesTimeline"] as Record<string, string>)[""] =
		JSON.stringify(replies);

	const app = new FakeWebApp({ pages });
	const h = harness(app, ["posts"], {
		timeRanges: { posts: { since: "2026-10-01T00:00:00Z" } },
	});
	await collectXBrowser(h.ctx, FAST);
	// The newer reply is in range even though the module's older parent is not.
	assert.ok(h.ids("posts").includes("1990000000000000202"));
	assert.ok(!h.ids("posts").includes("1990000000000000201"));
	// The walk finished rather than stopping at the old parent.
	assert.deepEqual(h.skips(), {});
	assert.ok(h.states()["posts"]);
});

test("a run of replies does not evict the originals checkpoint", async () => {
	const pages = fixturePages();
	const replyIds = Array.from(
		{ length: 51 },
		(_, index) => `2000000000000000${String(100 + index).padStart(3, "0")}`,
	);
	(pages["UserRepliesTimeline"] as Record<string, string>)[""] =
		ownerRepliesPage(replyIds);

	const first = new FakeWebApp({ pages });
	const h1 = harness(first, ["posts"]);
	await collectXBrowser(h1.ctx, FAST);
	const cursor = h1.states()["posts"] as {
		head_ids: string[];
		reply_head_ids: string[];
	};
	// The originals checkpoint survives even though the replies filled theirs.
	assert.deepEqual(cursor.head_ids, [
		"1990000000000000105",
		"1990000000000000104",
		"1990000000000000103",
		"1990000000000000102",
		"1890000000000000090",
	]);
	assert.equal(cursor.reply_head_ids.length, 50);

	// An unchanged second run re-collects no originals. One reply falls off the
	// 50-id reply head by design; the originals head holds all five.
	const second = new FakeWebApp({ pages });
	const h2 = harness(second, ["posts"], { state: h1.states() });
	await collectXBrowser(h2.ctx, FAST);
	const originals = [
		"1990000000000000105",
		"1990000000000000104",
		"1990000000000000103",
		"1990000000000000102",
		"1890000000000000090",
	];
	assert.deepEqual(
		h2
			.ids("posts")
			.filter(
				(id): id is string => typeof id === "string" && originals.includes(id),
			),
		[],
	);
});

test("a full refresh reads to the end whatever is already collected", async () => {
	const first = new FakeWebApp();
	const h1 = harness(first);
	await collectXBrowser(h1.ctx, FAST);
	const app = new FakeWebApp();
	const h = harness(app, ALL, {
		state: h1.states(),
		collectionMode: "full_refresh",
	});
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("posts"), POST_IDS);
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
});

test("HTTP 429 stops the whole run at once and keeps what was read", async () => {
	const app = new FakeWebApp({
		respond: ({ operation, cursor }) =>
			operation === "UserRepliesTimeline" && cursor === ""
				? { status: 429, body: fixture("error-body.json") }
				: undefined,
	});
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	// The profile and the posts tab were read before X refused.
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(h.ids("posts"), POST_IDS.slice(0, 5));
	assert.deepEqual(h.ids("bookmarks"), []);
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(h.skips(), {
		posts: "source_rate_limited",
		bookmarks: "run_stopped_early",
		likes: "run_stopped_early",
	});
	// Nothing was done on the page after the refusal: no retry, no scroll,
	// no further view.
	assert.equal(requestLog(app).at(-1), "UserRepliesTimeline");
	assert.deepEqual(app.clicks, [`/${HANDLE}`, `/${HANDLE}/with_replies`]);
	assert.equal(app.scrolls, 1);
	// No stream that fell short moves its cursor.
	assert.deepEqual(h.states(), {});
	const skip = h.messages.find(
		(m) => m.type === "SKIP_RESULT" && m.stream === "posts",
	) as { message?: string; recovery_hint?: { retryable?: boolean } };
	assert.match(skip.message ?? "", /HTTP 429/);
	assert.equal(skip.recovery_hint?.retryable, false);
	assertUserFacingProgress(h.messages);
	assert.equal(h.lastProgress(), "Stopped reading X early: 5 saved");
});

test("a rate limit part way down a list keeps the pages before it", async () => {
	const app = new FakeWebApp({
		respond: ({ operation, cursor }) =>
			operation === "Likes" && cursor === "synthetic-likes-bottom-1"
				? { status: 429, body: "Rate limit exceeded" }
				: undefined,
	});
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("likes"), LIKE_IDS.slice(0, 3));
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.skips(), { likes: "source_rate_limited" });
	// Streams read in full before the stop keep their cursors; likes does not.
	assert.deepEqual(Object.keys(h.states()).sort(), ["bookmarks", "posts"]);
	assert.equal(requestLog(app).at(-1), "Likes@synthetic-likes-bottom-1");
});

test("any other non-200 GraphQL response stops the run, even for an operation it does not read", async () => {
	const blocked = new FakeWebApp({
		respond: ({ operation }) =>
			operation === "UserByScreenName"
				? { status: 503, body: "Service Unavailable" }
				: undefined,
	});
	const h = harness(blocked);
	await collectXBrowser(h.ctx, FAST);
	assert.equal(h.skips()["profile"], "collection_interrupted");
	assert.equal(h.skips()["likes"], "run_stopped_early");
	assert.deepEqual(blocked.clicks, [`/${HANDLE}`]);
});

test("an error body without data stops the run", async () => {
	const app = new FakeWebApp({
		respond: ({ operation }) =>
			operation === "Bookmarks"
				? { status: 200, body: fixture("error-body.json") }
				: undefined,
	});
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("posts"), POST_IDS);
	assert.deepEqual(h.skips(), {
		bookmarks: "collection_interrupted",
		likes: "run_stopped_early",
	});
	assert.deepEqual(app.clicks.at(-1), "/i/history");
	assert.equal(requestLog(app).at(-1), "Bookmarks");
});

test("an HTTP 200 refusal for a timeline the view did not ask for stops the run", async () => {
	const app = new FakeWebApp({
		respond: ({ operation }) =>
			operation === "HomeTimeline"
				? {
						status: 200,
						body: '{"errors":[{"code":88,"message":"Synthetic: rate limit exceeded."}]}',
					}
				: undefined,
	});
	// The app loads its home timeline again while opening the profile.
	app.onRequest = ({ operation }) => {
		if (operation === "UserByScreenName") {
			app.request("HomeTimeline", { count: 20 });
		}
	};
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("posts"), []);
	assert.deepEqual(h.skips(), {
		profile: "collection_interrupted",
		posts: "collection_interrupted",
		bookmarks: "run_stopped_early",
		likes: "run_stopped_early",
	});
});

test("a refusal while opening a view stops the run before the next link", async () => {
	const app = new FakeWebApp({
		respond: ({ operation, cursor }) =>
			operation === "Bookmarks" && cursor === ""
				? { status: 429, body: fixture("error-body.json") }
				: undefined,
	});
	const h = harness(app, ["likes"]);
	await collectXBrowser(h.ctx, FAST);
	// History's Bookmarks was refused, so the Likes tab was never opened.
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(h.skips(), { likes: "source_rate_limited" });
	assert.deepEqual(app.clicks, ["/i/history"]);
	assert.ok(!requestLog(app).includes("Likes"));
});

test("a refusal the drawer click triggered stops the run before the profile link", async () => {
	const app = new FakeWebApp({
		drawer: true,
		respond: ({ operation }) =>
			operation === "HomeTimeline"
				? { status: 429, body: "Rate limit exceeded" }
				: undefined,
		sidebar: false,
	});
	const h = harness(app);
	h.ctx.page = hookedPage(app, (script) => {
		if (script.includes("DashButton_ProfileIcon_Link")) {
			app.request("HomeTimeline", { count: 20 });
		}
	});
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	// The drawer click loaded a refused timeline; the profile link was never
	// followed and no view was opened.
	assert.deepEqual(app.clicks, []);
	assert.ok(!requestLog(app).includes("UserByScreenName"));
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"stop":"source_rate_limited"/);
});

test("a sign-out during the drawer click stops the run before the route fallback", async () => {
	const app = new FakeWebApp({ drawer: true, sidebar: false });
	const h = harness(app);
	h.ctx.page = hookedPage(app, (script) => {
		if (script.includes("DashButton_ProfileIcon_Link")) {
			app.signOut();
		}
	});
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	// No link was followed and the route fallback was never reached.
	assert.deepEqual(app.clicks, []);
	assert.deepEqual(app.historyPushes, []);
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"stop":"sign_in_required"/);
});

test("losing the twid cookie mid-run stops the run as sign-in required", async () => {
	const app = new FakeWebApp();
	app.onRequest = ({ operation }) => {
		if (operation === "Bookmarks") {
			app.signOut();
		}
	};
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	// The bookmarks page the app had already loaded is kept.
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.skips(), {
		bookmarks: "sign_in_required",
		likes: "run_stopped_early",
	});
	assert.deepEqual(Object.keys(h.states()), ["posts"]);
	assert.equal(requestLog(app).at(-1), "Bookmarks");
});

test("a redirect to the sign-in flow mid-run stops the run as sign-in required", async () => {
	const app = new FakeWebApp();
	app.onRequest = ({ operation, cursor }) => {
		if (operation === "Likes" && cursor !== "") {
			app.sendToSignIn();
		}
	};
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.skips(), { likes: "sign_in_required" });
	assert.equal(requestLog(app).at(-1), "Likes@synthetic-likes-bottom-1");
});

test("a signed-out session reads nothing and says sign-in is needed", async () => {
	const app = new FakeWebApp({ signedIn: false });
	const h = harness(app);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.records, []);
	assert.deepEqual(h.skips(), {
		profile: "sign_in_required",
		posts: "sign_in_required",
		bookmarks: "sign_in_required",
		likes: "sign_in_required",
	});
	assert.deepEqual(app.gotos, [HOME_URL]);
	assert.deepEqual(app.clicks, []);
	assert.deepEqual(app.requests, []);
});

test("another account's timeline in the buffer is never read as the owner's", async () => {
	const app = new FakeWebApp();
	// The app answers the owner's Likes request as usual, but claims the
	// request was for someone else's timeline.
	const h = harness(app, ["likes"]);
	const original = app.page;
	const evaluateOriginal = original.evaluate as (
		...args: unknown[]
	) => Promise<unknown>;
	const rewritten: XCollectContext["page"] = {
		goto: original.goto,
		evaluate: (async (...args: unknown[]) => {
			const value = (await evaluateOriginal(...args)) as {
				entries?: Array<{ operation: string; variables: string }>;
			} | null;
			for (const entry of value?.entries ?? []) {
				if (entry.operation === "Likes") {
					entry.variables = '{"userId":"1900000000000000002"}';
				}
			}
			return value;
		}) as XCollectContext["page"]["evaluate"],
	};
	h.ctx.page = rewritten;
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(h.skips(), { likes: "source_unreadable" });
});

test("narrow layout: a link named Profile gives the handle, and the history fallback opens History", async () => {
	const app = new FakeWebApp({ sidebar: false, profileLink: true });
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(h.ids("posts"), POST_IDS);
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
	assert.deepEqual(h.skips(), {});
	// The tabs are in the page body on any layout; the sidebar links are not.
	assert.deepEqual(app.historyPushes, ["/i/history"]);
	assert.deepEqual(app.clicks, [
		`/${HANDLE}`,
		`/${HANDLE}/with_replies`,
		"/i/history/likes",
	]);
	assert.ok(
		lines.some((line) => line.includes('"via":"profile_label"')),
		"the handle came from the link named Profile",
	);
});

test("phone layout: the avatar drawer gives the handle, and later views reopen it", async () => {
	const app = new FakeWebApp({ sidebar: false, drawer: true });
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(h.ids("posts"), POST_IDS);
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
	assert.deepEqual(h.skips(), {});
	// Every view was opened by the app's own link, never by a built URL.
	assert.deepEqual(app.historyPushes, []);
	assert.deepEqual(app.clicks, [
		`/${HANDLE}`,
		`/${HANDLE}/with_replies`,
		"/i/history",
		"/i/history/likes",
	]);
	// The handle came from the drawer's own following link, not from a
	// labelled anchor; the drawer's links have neither test id nor name.
	assert.ok(
		lines.some((line) => line.includes('"via":"drawer_following"')),
		"the handle came from the drawer's following link",
	);
	// The drawer was opened for the handle and again for History, never a
	// third time: the profile step followed the link already in the drawer.
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"nav":"[^"]*drawer:2/);
	assert.doesNotMatch(run ?? "", /already_open/);
	assert.ok(!lines.some((line) => /sample_owner|19\d{17}/.test(line)));
});

test("no profile link and no drawer control: the run stops and reports the layout once", async () => {
	const app = new FakeWebApp({ sidebar: false });
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(h.records, []);
	assert.deepEqual(h.skips(), {
		profile: "source_unreadable",
		posts: "source_unreadable",
		bookmarks: "source_unreadable",
		likes: "source_unreadable",
	});
	const skip = h.messages.find((m) => m.type === "SKIP_RESULT") as {
		message?: string;
	};
	assert.match(skip.message ?? "", /did not show a link to your profile/);
	assert.deepEqual(app.clicks, []);
	assert.deepEqual(app.historyPushes, []);
	assert.deepEqual(h.states(), {});

	// One report names the viewport, the route and the controls across a
	// `layout` line and its `lc` lines, with the account handle and the
	// numeric id replaced by placeholders.
	const report = layoutReport(lines);
	const { layout, controls } = report;
	assert.equal(typeof layout.width, "number");
	assert.equal(typeof layout.height, "number");
	// The route is the run's own location, handle-free.
	assert.equal(layout.path, "/home");
	// The run offered the drawer control, but this layout has none.
	assert.equal(layout.drawer, "no_control");
	assert.equal(layout.controls, controls.length);
	assert.equal(layout.parts, controls.length);
	assert.ok(controls.length <= LAYOUT_CONTROL_CAP);
	// Every line, the first included, fits the mobile host's budget.
	for (const line of report.lines) {
		assert.ok(
			line.length <= DIAGNOSTIC_LINE_MAX_CHARS,
			`line is ${line.length} chars`,
		);
	}
	const text = report.lines.join("\n");
	assert.doesNotMatch(text, /sample_owner|1900000000000000001/);
	assert.match(text, /:handle/);
	assert.match(text, /:id/);

	// Dialog controls come first: the open drawer is what the run needs.
	const dialog = controls.find((control) => control["id"] === "DialogClose");
	assert.equal(dialog?.["s"], "d");
	assert.equal(controls[0]?.["id"], "DialogClose");
	// The running index and total are on every control line.
	assert.deepEqual(
		controls.map((control) => control["i"]),
		controls.map((_control, index) => index + 1),
	);
	assert.ok(controls.every((control) => control["n"] === controls.length));

	// The accessible name that holds the handle is masked, then clipped to fit.
	const account = controls.find(
		(control) => control["id"] === "AvatarDrawerButton",
	);
	assert.ok(account);
	assert.equal(account["x"], "true");
	// A page control carries no `s`.
	assert.ok(!("s" in account));
	const ariaLabel = String(account["al"]);
	assert.ok(ariaLabel.length <= 40);
	assert.doesNotMatch(ariaLabel, /sample_owner/);

	// A control with a null field leaves that field out entirely.
	const explore = controls.find((control) => control["al"] === "Explore");
	assert.ok(explore);
	assert.ok(!("id" in explore));
	assert.ok(!("r" in explore));
});

test("a navigation failure names the view, not the owner's handle", async () => {
	const app = new FakeWebApp();
	const h = harness(app);
	const base = app.page;
	const evaluate = base.evaluate as (...args: unknown[]) => Promise<unknown>;
	// No link and no route fallback ever moves: the view cannot be opened.
	const page: XCollectContext["page"] = {
		goto: base.goto,
		evaluate: (async (...args: unknown[]) => {
			if (String(args[0]).includes("PopStateEvent")) {
				return { via: "none" };
			}
			return evaluate(...args);
		}) as XCollectContext["page"]["evaluate"],
	};
	h.ctx.page = page;
	await collectXBrowser(h.ctx, FAST);
	const skip = h.messages.find(
		(message) => message.type === "SKIP_RESULT" && message.stream === "posts",
	) as { message?: string };
	assert.ok(skip);
	assert.doesNotMatch(skip.message ?? "", /sample_owner/);
	assert.match(skip.message ?? "", /your posts/);
});

test("a drawer click that opens nothing is recorded in the layout line", async () => {
	const app = new FakeWebApp({
		drawer: true,
		drawerOpens: false,
		sidebar: false,
	});
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(h.records, []);
	assert.deepEqual(h.skips(), {
		profile: "source_unreadable",
		posts: "source_unreadable",
		bookmarks: "source_unreadable",
		likes: "source_unreadable",
	});
	const line = lines.find((entry) =>
		entry.startsWith("[x_browser-diagnostic] layout "),
	);
	assert.ok(line);
	const layout = JSON.parse((line ?? "").slice((line ?? "").indexOf("{")));
	assert.equal(layout.drawer, "clicked");
	// The run did click the app's own drawer control, once.
	const run = lines.find((entry) =>
		entry.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"nav":"[^"]*drawer:1/);
});

/** 60 synthetic controls: a 40-char label and a path of handle-shaped parts. */
function syntheticControls(segments: number): SyntheticLayoutControl[] {
	return Array.from({ length: LAYOUT_CONTROL_CAP }, (_, index) => ({
		ariaLabel: `control ${index}`.padEnd(40, "x"),
		href: `${ORIGIN}/${Array.from(
			{ length: segments },
			(_, part) => `handle${index}_${part}`,
		).join("/")}`,
	}));
}

test("60 controls become one line each, in order, and every line fits", async () => {
	const app = new FakeWebApp({
		layoutControls: syntheticControls(6),
		sidebar: false,
	});
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	const report = layoutReport(lines);
	assert.equal(report.layout.controls, LAYOUT_CONTROL_CAP);
	assert.equal(report.controls.length, LAYOUT_CONTROL_CAP);
	assert.equal(report.layout.parts, LAYOUT_CONTROL_CAP);
	assert.ok(!("omitted" in report.layout));
	// One line per control, in the order the page offered them.
	assert.deepEqual(
		report.controls.map((control) => control["i"]),
		Array.from({ length: LAYOUT_CONTROL_CAP }, (_, index) => index + 1),
	);
	assert.deepEqual(
		report.controls.map((control) => control["n"]),
		Array.from({ length: LAYOUT_CONTROL_CAP }, () => LAYOUT_CONTROL_CAP),
	);
	// Any name outside the fixed navigation labels is masked to "*", and the
	// 6-segment path still fits, so no line is cut.
	const expectedPath = `/${Array.from({ length: 6 }, () => ":handle").join("/")}`;
	assert.deepEqual(
		report.controls.map((control) => control["al"]),
		Array.from({ length: LAYOUT_CONTROL_CAP }, () => "*"),
	);
	for (const control of report.controls) {
		assert.ok(!("cut" in control));
		assert.equal(control["p"], expectedPath);
	}
	// Every line, the first included, fits the mobile host's budget.
	for (const line of report.lines) {
		assert.ok(
			line.length <= DIAGNOSTIC_LINE_MAX_CHARS,
			`line is ${line.length} chars`,
		);
		assert.ok(!line.endsWith("…"), "no line is truncated");
	}
	// A control's null fields are left out of the flat form.
	for (const control of report.controls) {
		assert.ok(!("id" in control));
		assert.ok(!("r" in control));
		assert.ok(!("x" in control));
		assert.ok(!("s" in control));
	}
});

test("a very long path is shortened after the label, and the line marked cut", async () => {
	const app = new FakeWebApp({
		layoutControls: syntheticControls(60),
		sidebar: false,
	});
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	const report = layoutReport(lines);
	assert.equal(report.controls.length, LAYOUT_CONTROL_CAP);
	for (const control of report.controls) {
		assert.equal(control["cut"], 1);
		assert.equal(String(control["al"]).length, 1);
		assert.equal(String(control["p"]).length, 12);
	}
	for (const line of report.lines) {
		assert.ok(line.length <= DIAGNOSTIC_LINE_MAX_CHARS);
	}
});

test("a control whose minimal line cannot fit is counted as omitted", async () => {
	const controls = syntheticControls(6);
	const huge = controls.at(30);
	assert.ok(huge);
	huge.testid = "T".repeat(200);
	const app = new FakeWebApp({ layoutControls: controls, sidebar: false });
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	const report = layoutReport(lines);
	assert.equal(report.layout.controls, LAYOUT_CONTROL_CAP);
	assert.equal(report.layout.omitted, 1);
	assert.equal(report.controls.length, LAYOUT_CONTROL_CAP - 1);
	// The omitted control leaves a gap in the running index.
	assert.ok(!report.controls.some((control) => control["i"] === 31));
	for (const line of report.lines) {
		assert.ok(
			line.length <= DIAGNOSTIC_LINE_MAX_CHARS,
			`line is ${line.length} chars`,
		);
	}
});

test("control lines mask an accessible name that is not a fixed navigation label", async () => {
	const app = new FakeWebApp({
		layoutControls: [
			{
				ariaLabel: `Account menu for @${HANDLE} and more words here`,
				href: `${ORIGIN}/${HANDLE}`,
			},
		],
		sidebar: false,
	});
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	const report = layoutReport(lines);
	const control = report.controls[0];
	assert.ok(control);
	// The name held a handle, so the field carries only the marker.
	assert.equal(control["al"], "*");
	assert.equal(control["p"], "/:handle");
	assert.ok(!("id" in control));
	assert.ok(!("r" in control));
	assert.ok(!("x" in control));
	assert.ok(!("s" in control));
	assert.ok(!("cut" in control));
});

test("an accessible name is emitted only when it is a fixed navigation label", async () => {
	const app = new FakeWebApp({
		layoutControls: [
			{
				ariaLabel: "Switch to Jane Doe 1900000000000000001",
				href: `${ORIGIN}/${HANDLE}`,
			},
			{ ariaLabel: "Home", href: `${ORIGIN}/home` },
		],
		sidebar: false,
	});
	const h = harness(app);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	const report = layoutReport(lines);
	assert.deepEqual(
		report.controls.map((control) => control["al"]),
		["*", "Home"],
	);
	const text = report.lines.join("\n");
	assert.doesNotMatch(text, /Jane Doe|1900000000000000001/);
});

test("redactPathShape masks handles, ids and encoded identities but keeps X's route words", () => {
	assert.equal(
		redactPathShape(`/${HANDLE}/with_replies`),
		"/:handle/with_replies",
	);
	assert.equal(redactPathShape("/i/history/likes"), "/i/history/likes");
	assert.equal(redactPathShape("/status/1900000000000000001"), "/status/:id");
	assert.equal(
		redactPathShape(`/${HANDLE}/status/1900000000000000001`),
		"/:handle/status/:id",
	);
	// A percent-encoded handle or id is decoded before it is classified, and
	// a dynamic segment outside the fixed route words is never emitted raw.
	assert.equal(redactPathShape("/%6Aane_doe"), "/:handle");
	assert.equal(redactPathShape("/%6Aane_doe/status/%31%39%30"), "/:handle/status/:id");
	assert.equal(
		redactPathShape("/hashtag/PrivateProjectLaunch2026"),
		"/hashtag/:handle",
	);
	// A malformed escape is still never emitted raw.
	assert.equal(redactPathShape("/%E0%A4%A"), "/:handle");
	assert.equal(redactPathShape("/%2F"), "/:handle");
});

test("redactPathShape treats a route word as a handle unless the whole path is a route", () => {
	// A handle that equals a route word is masked whenever the whole path is
	// not one of X's own routes.
	assert.equal(redactPathShape("/home/with_replies"), "/:handle/with_replies");
	assert.equal(redactPathShape("/home/following"), "/:handle/following");
	assert.equal(redactPathShape("/i"), "/:handle");
	assert.equal(redactPathShape("/i/with_replies"), "/:handle/with_replies");
	assert.equal(redactPathShape("/photo/following"), "/:handle/following");
	assert.equal(redactPathShape("/settings/photo"), "/:handle/photo");
	assert.equal(
		redactPathShape("/following/status/1900000000000000001"),
		"/:handle/status/:id",
	);
	// An encoded route or handle is decoded before the path is matched.
	assert.equal(redactPathShape("/%68ome/with_replies"), "/:handle/with_replies");
	assert.equal(redactPathShape("/%69"), "/:handle");
	assert.equal(redactPathShape("/%69/history/likes"), "/i/history/likes");
	// Trailing slashes and the empty path.
	assert.equal(redactPathShape("/home/"), "/home");
	assert.equal(redactPathShape(`/${HANDLE}/`), "/:handle");
	assert.equal(redactPathShape(""), "");
	assert.equal(redactPathShape("/"), "/");
	// The fixed routes themselves still survive whole.
	assert.equal(redactPathShape("/compose/post"), "/compose/post");
	assert.equal(redactPathShape("/explore"), "/explore");
});

test("lists that need no handle are still read when there is no profile link", async () => {
	const app = new FakeWebApp({ sidebar: false });
	const h = harness(app, ["bookmarks", "likes"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("bookmarks"), BOOKMARK_IDS);
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
	assert.deepEqual(h.skips(), {});
});

test("a view the app never loads is reported, not read as empty", async () => {
	const app = new FakeWebApp({
		sidebar: false,
		routerFollowsHistory: false,
	});
	const h = harness(app, ["bookmarks"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.records, []);
	assert.deepEqual(h.skips(), { bookmarks: "source_unreadable" });
	assert.deepEqual(h.states(), {});
});

test("a list that stops loading before its end is partial and keeps its old cursor", async () => {
	const app = new FakeWebApp({ scrollLoads: false });
	const h = harness(app, ["likes"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("likes"), LIKE_IDS.slice(0, 3));
	assert.deepEqual(h.skips(), { likes: "list_end_unconfirmed" });
	assert.deepEqual(h.states(), {});
	// It tried a bounded number of scroll steps, then stopped.
	assert.equal(app.scrolls, 3);
});

test("a view stops at its cap and the stream is complete to that bound", async () => {
	const app = new FakeWebApp();
	const h = harness(app, ["likes"]);
	await collectXBrowser(h.ctx, { ...FAST, viewPostCaps: { likes: 3 } });
	assert.deepEqual(h.ids("likes"), LIKE_IDS.slice(0, 3));
	assert.deepEqual(h.skips(), {});
	assert.deepEqual(h.states(), {
		likes: { head_ids: LIKE_IDS.slice(0, 3), requested_since: null },
	});
	assert.equal(app.scrolls, 0);
	assert.deepEqual(requestLog(app).slice(-2), ["Bookmarks", "Likes"]);
});

test("the run's own post budget stops it before the next view", async () => {
	const app = new FakeWebApp();
	const h = harness(app);
	// The posts tab sends 6 posts; a budget of 6 is spent there.
	await collectXBrowser(h.ctx, { ...FAST, maxPostsPerRun: 6 });
	assert.deepEqual(h.ids("posts"), POST_IDS.slice(0, 5));
	assert.deepEqual(h.skips(), {
		posts: "run_budget_reached",
		bookmarks: "run_stopped_early",
		likes: "run_stopped_early",
	});
	assert.deepEqual(app.clicks, [`/${HANDLE}`]);
	assert.equal(app.scrolls, 0);
});

test("every timeline the app loaded counts against the run's budget", async () => {
	const app = new FakeWebApp();
	const h = harness(app, ["likes"]);
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(h.ids("likes"), LIKE_IDS);
	// History loaded 2 bookmarks on the way to the 5 likes; both count.
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"ps":7/);
});

test("the run's budget stops the walk before the next action, not after the view", async () => {
	const app = new FakeWebApp();
	const h = harness(app, ["likes"]);
	// History loads two bookmarks on the way to Likes; a budget of 2 is spent
	// there, so the Likes tab is never opened.
	await collectXBrowser(h.ctx, { ...FAST, maxPostsPerRun: 2 });
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(app.clicks, ["/i/history"]);
	assert.ok(!requestLog(app).includes("Likes"));
	assert.deepEqual(h.skips(), { likes: "run_budget_reached" });
});

test("a home timeline the app loads on the way counts against the run's budget", async () => {
	const pages = fixturePages();
	pages["HomeTimeline"] = { "": homeTimelinePage(["1", "2", "3"]) };
	const app = new FakeWebApp({ pages });
	app.onRequest = ({ operation }) => {
		if (operation === "Bookmarks") {
			app.request("HomeTimeline", { count: 20 });
		}
	};
	const h = harness(app, ["likes"]);
	// History's 2 bookmarks plus the 3 home posts spend a budget of 3, so the
	// Likes tab is never opened.
	await collectXBrowser(h.ctx, { ...FAST, maxPostsPerRun: 3 });
	assert.deepEqual(app.clicks, ["/i/history"]);
	assert.ok(!requestLog(app).includes("Likes"));
	assert.deepEqual(h.skips(), { likes: "run_budget_reached" });
});

test("unreadable posts are skipped and reported; the rest is saved", async () => {
	const pages = fixturePages();
	const likes = JSON.parse(pages["Likes"]?.[""] ?? "");
	likes.data.user.result.timeline.timeline.instructions[0].entries[0].content.itemContent.tweet_results.result.legacy.created_at =
		"not a date";
	(pages["Likes"] as Record<string, string>)[""] = JSON.stringify(likes);
	const app = new FakeWebApp({ pages });
	const h = harness(app, ["likes"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("likes"), LIKE_IDS.slice(1));
	assert.deepEqual(h.skips(), { likes: "records_unreadable" });
	// The walk itself finished, so its cursor moves.
	assert.deepEqual(Object.keys(h.states()), ["likes"]);
});

test("a posts time range stops the walk at the first older post; likes and bookmarks are not read under a range", async () => {
	const app = new FakeWebApp();
	const range = { since: "2026-10-03T00:00:00Z" };
	const h = harness(app, ALL, {
		timeRanges: {
			posts: range,
			likes: range,
			bookmarks: range,
			profile: range,
		},
	});
	await collectXBrowser(h.ctx, FAST);
	// The pinned post is older than the range but does not end the walk; the
	// runtime's own range filter withholds it. 102 is the first older post.
	assert.deepEqual(h.ids("posts"), [
		"1890000000000000090",
		"1990000000000000105",
		"1990000000000000104",
		"1990000000000000103",
		"1990000000000000202",
	]);
	assert.deepEqual(h.ids("likes"), []);
	assert.deepEqual(h.ids("bookmarks"), []);
	assert.deepEqual(h.ids("profile"), []);
	assert.deepEqual(app.clicks, [`/${HANDLE}`, `/${HANDLE}/with_replies`]);
	assert.equal(app.scrolls, 0);
	assert.equal(
		(h.states()["posts"] as { requested_since?: string }).requested_since,
		"2026-10-03T00:00:00.000Z",
	);

	// A later run with no range reads past the stored head: older posts were
	// never collected under the range.
	const wider = new FakeWebApp();
	const h2 = harness(wider, ["posts"], { state: h.states() });
	await collectXBrowser(h2.ctx, FAST);
	assert.deepEqual(h2.ids("posts"), POST_IDS);
});

test("only the profile: the profile page is opened and nothing is scrolled", async () => {
	const app = new FakeWebApp();
	const h = harness(app, ["profile"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.ids("profile"), [OWNER_ID]);
	assert.deepEqual(app.clicks, [`/${HANDLE}`]);
	assert.equal(app.scrolls, 0);
	assert.deepEqual(h.states(), {});
});

test("a profile response for a different account is not saved", async () => {
	const pages = fixturePages();
	const other = JSON.parse(pages["UserByScreenName"]?.[""] ?? "");
	other.data.user.result.rest_id = "1900000000000000002";
	(pages["UserByScreenName"] as Record<string, string>)[""] =
		JSON.stringify(other);
	const app = new FakeWebApp({ pages });
	const h = harness(app, ["profile"]);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(h.records, []);
	assert.deepEqual(h.skips(), { profile: "source_unreadable" });
});

test("no requested stream: the page is never touched", async () => {
	const app = new FakeWebApp();
	const h = harness(app, []);
	await collectXBrowser(h.ctx, FAST);
	assert.deepEqual(app.gotos, []);
	assert.deepEqual(h.messages, []);
});

test("the sign-in probe reads cookies and path, and never navigates", async () => {
	const signedIn = new FakeWebApp({ startUrl: HOME_URL });
	assert.equal(await probeXSession(signedIn.page), true);
	// Cookies present, but X is showing its sign-in flow or a challenge.
	signedIn.sendToSignIn();
	assert.equal(await probeXSession(signedIn.page), false);
	const signedOut = new FakeWebApp({ startUrl: HOME_URL, signedIn: false });
	assert.equal(signedOut.path, "/i/flow/login");
	assert.equal(await probeXSession(signedOut.page), false);
	// Part way through single sign-on, on another origin.
	const elsewhere = new FakeWebApp({
		startUrl: "https://accounts.example.invalid/",
	});
	assert.equal(await probeXSession(elsewhere.page), false);
	for (const app of [signedIn, signedOut, elsewhere]) {
		assert.deepEqual(app.gotos, []);
	}
	// A page that cannot be read is not a session.
	const dead = {
		evaluate: async () => {
			throw new Error("Execution context was destroyed");
		},
	} as unknown as XCollectContext["page"];
	assert.equal(await probeXSession(dead), false);
});

test("a live session needs no sign-in", async () => {
	const app = new FakeWebApp();
	await ensureXSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: app.page,
			assist: async () => {
				throw new Error("unexpected assistance");
			},
		}),
	);
	// It opened x.com to look, and did not go to the sign-in page.
	assert.deepEqual(app.gotos, [HOME_URL]);
});

test("without a session, the owner signs in on the login page; no credential is handled", async () => {
	const app = new FakeWebApp({ signedIn: false });
	const statuses: string[] = [];
	await ensureXSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: app.page,
			assist: async () => {
				// The owner signs in; X then shows the home timeline.
				app.signedIn = true;
				await app.page.goto(HOME_URL);
				return "assist-1";
			},
			completeAssistance: async (_id: string, status: string) => {
				statuses.push(status);
			},
		}),
	);
	assert.deepEqual(app.gotos, [HOME_URL, LOGIN_URL, HOME_URL]);
	assert.deepEqual(statuses, ["resolved"]);
});

test("the manifest states the safety posture the code keeps to", () => {
	const policy = manifest.capabilities.refresh_policy;
	assert.equal(policy.recommended_mode, "manual");
	assert.equal(policy.background_safe, false);
	assert.ok(policy.minimum_interval_seconds >= 86_400);
	assert.equal(policy.bot_detection_sensitivity, "high");
	assert.equal(manifest.capabilities.public_listing.tier, "development");
	assert.deepEqual(manifest.capabilities.human_interaction, ["manual_action"]);
	assert.equal(manifest.mobile.pageshim.login_url, LOGIN_URL);
	// No direct messages, no follower or following lists.
	assert.deepEqual(
		manifest.streams.map((stream: { name: string }) => stream.name),
		ALL,
	);
	// The budget the rationale and the README describe.
	assert.equal(MAX_POSTS_PER_RUN, 400);
	assert.equal(
		Object.values(VIEW_POST_CAPS).reduce((sum, cap) => sum + cap, 0),
		MAX_POSTS_PER_RUN,
	);
	assert.deepEqual([ACTION_DELAY_MIN_MS, ACTION_DELAY_MAX_MS], [2000, 5000]);
	assert.match(policy.rationale, /400 posts/);
	assert.match(policy.rationale, /2 to 5 seconds/);
});

test("every reason the connector can report has owner-facing copy", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	const block = /const SKIP_REASON[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? "";
	const reasons = [...block.matchAll(/: "([a-z_]+)"/g)].map((m) => m[1]);
	assert.ok(reasons.length >= 8);
	assert.deepEqual(
		Object.keys(manifest.reason_display_messages).sort(),
		[...reasons].sort(),
	);
});

test("an HTTP 200 refusal the drawer click triggered also stops the run", async () => {
	const app = new FakeWebApp({
		drawer: true,
		respond: ({ operation }) =>
			operation === "HomeTimeline"
				? { status: 200, body: '{"errors":[{"code":88}]}' }
				: undefined,
		sidebar: false,
	});
	const h = harness(app);
	h.ctx.page = hookedPage(app, (script) => {
		if (script.includes("DashButton_ProfileIcon_Link")) {
			app.request("HomeTimeline", { count: 20 });
		}
	});
	const lines = await captureDiagnostics(() => collectXBrowser(h.ctx, FAST));
	assert.deepEqual(app.clicks, []);
	const run = lines.find((line) =>
		line.startsWith("[x_browser-diagnostic] run "),
	);
	assert.match(run ?? "", /"stop":"collection_interrupted"/);
});

test("the run's budget stops the walk before the tab's first scroll", async () => {
	const app = new FakeWebApp();
	const h = harness(app, ["likes"]);
	await collectXBrowser(h.ctx, { ...FAST, maxPostsPerRun: 5 });
	// History's 2 bookmarks plus the likes tab's first 3 posts spend the cap.
	assert.deepEqual(h.ids("likes"), LIKE_IDS.slice(0, 3));
	assert.equal(app.scrolls, 0);
	assert.ok(!requestLog(app).includes("Likes@synthetic-likes-bottom-1"));
});
