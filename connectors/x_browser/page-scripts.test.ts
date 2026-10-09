// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
	DRAWER_DIALOG_SELECTOR,
	DRAWER_OPEN_SELECTORS,
	drawerProfileSelector,
	followLinkScript,
	installObserverScript,
	LAYOUT_CONTAINER_SELECTOR,
	LAYOUT_CONTROL_CAP,
	LAYOUT_SCRIPT,
	OBSERVER_GLOBAL,
	OWNER_HANDLE_SCRIPT,
	openDrawerScript,
	POLL_SCRIPT,
	scrollScript,
} from "./page-scripts.ts";

const INSTALL = installObserverScript({
	wanted: ["Likes", "UserByScreenName"],
	maxBuffered: 4,
	errorBodyChars: 10,
});

interface FakeLink {
	clicked: number;
	href: string;
	tagName: string;
}

/** One control the layout diagnostic can see, with where it sits in the page. */
interface FakeControl {
	ariaExpanded?: string;
	ariaLabel?: string;
	href?: string;
	inArticle?: boolean;
	inDialog?: boolean;
	inPrimarySection?: boolean;
	role?: string;
	tagName?: string;
	testid?: string;
}

/** A page with just enough of a browser for the scripts to run against. */
function fakePage(
	options: {
		cookie?: string;
		/** Anchors inside the open account drawer, in the order shown. */
		drawerLinks?: Array<{ href: string }>;
		innerHeight?: number;
		innerWidth?: number;
		links?: Record<string, { href: string; tagName?: string }>;
		/** Controls inside a nav-like container. */
		navControls?: FakeControl[];
		/** Controls anywhere else in the document. */
		pageControls?: FakeControl[];
		path?: string;
	} = {},
) {
	const sent: Xhr[] = [];
	class Xhr {
		private readonly listeners: Array<() => void> = [];
		response: unknown = null;
		responseText = "";
		responseType = "";
		status = 0;
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
		open(method: string, url: string): string {
			return `opened ${method} ${url}`;
		}
		send(body?: string): string {
			sent.push(this);
			return `sent ${body ?? ""}`;
		}
	}
	const links = new Map<string, FakeLink & { click: () => void }>();
	for (const [selector, link] of Object.entries(options.links ?? {})) {
		const entry = {
			clicked: 0,
			href: link.href,
			tagName: link.tagName ?? "A",
			getAttribute: () => new URL(link.href).pathname,
			click() {
				entry.clicked += 1;
			},
		};
		links.set(selector, entry);
	}
	const pushed: string[] = [];
	const events: string[] = [];
	const scrolled: number[] = [];
	const makeControl = (control: FakeControl) => ({
		closest: (selector: string) => {
			if (selector === "article") {
				return control.inArticle ? { tagName: "ARTICLE" } : null;
			}
			if (selector === '[data-testid="primaryColumn"] section') {
				return control.inPrimarySection ? { tagName: "SECTION" } : null;
			}
			if (selector === '[role="dialog"]') {
				return control.inDialog ? { tagName: "DIV" } : null;
			}
			return null;
		},
		getAttribute: (name: string) =>
			name === "href"
				? (control.href ?? null)
				: name === "data-testid"
					? (control.testid ?? null)
					: name === "aria-label"
						? (control.ariaLabel ?? null)
						: name === "role"
							? (control.role ?? null)
							: name === "aria-expanded"
								? (control.ariaExpanded ?? null)
								: null,
		tagName: control.tagName ?? "A",
	});
	const containerControls = (options.navControls ?? []).map(makeControl);
	const documentControls = [
		...containerControls,
		...(options.pageControls ?? []).map(makeControl),
	];
	const drawerControls = (options.drawerLinks ?? []).map((link) => ({
		getAttribute: (name: string) =>
			name === "href" ? new URL(link.href).pathname : null,
		tagName: "A",
	}));
	const dialog =
		options.drawerLinks === undefined
			? null
			: { querySelectorAll: () => drawerControls };
	const location = {
		origin: "https://x.com",
		pathname: options.path ?? "/home",
		get href(): string {
			return `${this.origin}${this.pathname}`;
		},
	};
	const window: Record<string, unknown> = {
		location,
		document: {
			cookie: options.cookie ?? "",
			documentElement: { scrollHeight: 3000 },
			querySelector: (selector: string) =>
				selector === DRAWER_DIALOG_SELECTOR
					? dialog
					: (links.get(selector) ?? null),
			querySelectorAll: (selector: string) =>
				selector === LAYOUT_CONTAINER_SELECTOR
					? [{ querySelectorAll: () => containerControls }]
					: documentControls,
		},
		history: {
			pushState: (_state: unknown, _title: string, path: string) => {
				pushed.push(path);
				location.pathname = path;
			},
		},
		dispatchEvent: (event: { type: string }) => {
			events.push(event.type);
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
		innerHeight: options.innerHeight ?? 800,
		innerWidth: options.innerWidth ?? 1280,
		scrollY: 0,
		scrollBy: (_x: number, y: number) => {
			scrolled.push(y);
		},
		scrollTo: () => undefined,
	};
	window["window"] = window;
	const context = vm.createContext(window);
	const run = (script: string) =>
		JSON.parse(JSON.stringify(vm.runInContext(script, context) ?? null));
	const request = (url: string, status: number, body: string) => {
		const xhr = new Xhr();
		xhr.open("GET", url);
		xhr.send();
		xhr.finish(status, body);
	};
	return { Xhr, events, links, pushed, request, run, scrolled, sent, window };
}

const graphql = (operation: string, variables = "{}", queryId = "AbC123") =>
	`https://x.com/i/api/graphql/${queryId}/${operation}?variables=${encodeURIComponent(variables)}&features=%7B%7D`;

test("the observer buffers GraphQL responses by operation name and changes no request", () => {
	const page = fakePage({ cookie: "twid=u%3D42; ct0=abc" });
	assert.deepEqual(page.run(INSTALL), { installed: true });
	// The wrapped methods return what the originals return.
	const xhr = new page.Xhr();
	assert.equal(
		xhr.open("GET", graphql("Likes", '{"userId":"42"}')),
		`opened GET ${graphql("Likes", '{"userId":"42"}')}`,
	);
	assert.equal(xhr.send("payload"), "sent payload");
	assert.equal(page.sent.length, 1);
	xhr.finish(200, '{"data":{"likes":1}}');
	// A different query id for the same operation is the same operation.
	page.request(graphql("Likes", "{}", "ZzZ999"), 200, '{"data":{"likes":2}}');
	// Not GraphQL: ignored.
	page.request("https://x.com/i/api/1.1/account/settings.json", 200, "{}");
	page.request("https://x.com/home", 200, "<html>");

	const first = page.run(POLL_SCRIPT);
	assert.deepEqual(first.entries, [
		{
			operation: "Likes",
			variables: '{"userId":"42"}',
			status: 200,
			wanted: true,
			body: '{"data":{"likes":1}}',
		},
	]);
	// One large body per read: the second waits for the next.
	assert.equal(first.remaining, 1);
	assert.equal(page.run(POLL_SCRIPT).entries[0].body, '{"data":{"likes":2}}');
	assert.deepEqual(page.run(POLL_SCRIPT).entries, []);
});

test("operations it does not read keep no body, unless X refused them", () => {
	const page = fakePage();
	page.run(INSTALL);
	page.request(graphql("HomeTimeline"), 200, '{"data":{"home":"long body"}}');
	page.request(graphql("DataSaverMode"), 429, "Rate limit exceeded, slow down");
	page.request(graphql("Likes"), 0, "");
	const { entries } = page.run(POLL_SCRIPT);
	assert.deepEqual(
		entries.map((e: Record<string, unknown>) => [
			e["operation"],
			e["status"],
			e["wanted"],
			e["body"],
		]),
		[
			["HomeTimeline", 200, false, ""],
			// Enough of a refusal to name it, no more.
			["DataSaverMode", 429, false, "Rate limit"],
			// An abandoned request: status 0.
			["Likes", 0, true, ""],
		],
	);
});

test("installing twice wraps once, and a full buffer drops and counts", () => {
	const page = fakePage();
	assert.deepEqual(page.run(INSTALL), { installed: true });
	assert.deepEqual(page.run(INSTALL), { installed: false });
	for (let i = 0; i < 6; i += 1) {
		page.request(graphql("HomeTimeline"), 200, "{}");
	}
	const reading = page.run(POLL_SCRIPT);
	// Each response was recorded once, not once per install.
	assert.equal(reading.entries.length, 4);
	assert.equal(reading.dropped, 2);
});

test("fetch is observed too, and still resolves for the app", async () => {
	const page = fakePage();
	page.window["fetch"] = async (input: string) =>
		new Response(`body of ${input}`, { status: 200 });
	page.run(INSTALL);
	const fetchInPage = page.window["fetch"] as (
		input: string,
	) => Promise<Response>;
	const response = await fetchInPage(graphql("UserByScreenName"));
	assert.equal(await response.text(), `body of ${graphql("UserByScreenName")}`);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const { entries } = page.run(POLL_SCRIPT);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].operation, "UserByScreenName");
	assert.equal(entries[0].body, `body of ${graphql("UserByScreenName")}`);
});

test("the poll reads the session from the twid and ct0 cookies", () => {
	const read = (cookie: string, path = "/home") =>
		fakePage({ cookie, path }).run(POLL_SCRIPT);
	const signedIn = read("guest_id=v1; twid=u%3D1900000000000000001; ct0=abc");
	assert.equal(signedIn.userId, "1900000000000000001");
	assert.equal(signedIn.hasCsrfCookie, true);
	assert.equal(signedIn.origin, "https://x.com");
	assert.equal(signedIn.path, "/home");
	assert.equal(signedIn.observerAlive, false);
	// Some builds quote the value.
	assert.equal(read('twid="u=77"; ct0=abc').userId, "77");
	assert.equal(read("ct0=abc").userId, null);
	assert.equal(read("twid=u%3D; ct0=abc").userId, null);
	assert.equal(read("nottwid=u%3D5; ct0=abc").userId, null);
	assert.equal(read("twid=u%3D5").hasCsrfCookie, false);
	assert.equal(read("twid=u%3D5; ct0=").hasCsrfCookie, false);
});

test("the poll reports the bottom of the page and whether the observer is alive", () => {
	const page = fakePage();
	assert.equal(page.run(POLL_SCRIPT).atBottom, false);
	page.window["scrollY"] = 2200;
	assert.equal(page.run(POLL_SCRIPT).atBottom, true);
	page.run(INSTALL);
	assert.equal(page.run(POLL_SCRIPT).observerAlive, true);
	assert.ok(OBSERVER_GLOBAL in page.window);
});

test("the owner handle comes only from the app's own links", () => {
	const linked = fakePage({
		links: {
			'a[data-testid="AppTabBar_Profile_Link"]': {
				href: "https://x.com/sample_owner",
			},
		},
	});
	assert.deepEqual(linked.run(OWNER_HANDLE_SCRIPT), {
		handle: "sample_owner",
		via: "profile_link",
	});
	const labelled = fakePage({
		links: {
			'a[aria-label="Profile"]': { href: "https://x.com/sample_owner" },
		},
	});
	assert.deepEqual(labelled.run(OWNER_HANDLE_SCRIPT), {
		handle: "sample_owner",
		via: "profile_label",
	});
	// A link that is not to a handle is not a handle.
	const settings = fakePage({
		links: {
			'a[aria-label="Profile"]': { href: "https://x.com/settings/profile" },
		},
	});
	assert.equal(settings.run(OWNER_HANDLE_SCRIPT).handle, null);
	// The narrow layout's drawer has no test id or name: the handle comes from
	// the following link, with a profile link to the same handle beside it.
	const drawer = fakePage({
		drawerLinks: [
			{ href: "https://x.com/sample_owner" },
			{ href: "https://x.com/sample_owner/following" },
			{ href: "https://x.com/i/history" },
		],
	});
	assert.deepEqual(drawer.run(OWNER_HANDLE_SCRIPT), {
		handle: "sample_owner",
		via: "drawer_following",
	});
	// A following link is not enough on its own: the same dialog must also
	// link to the handle it names.
	const orphan = fakePage({
		drawerLinks: [{ href: "https://x.com/x/following" }],
	});
	assert.deepEqual(orphan.run(OWNER_HANDLE_SCRIPT), {
		handle: null,
		via: "none",
	});
	// No link: no handle. Page state is not consulted (x.com has none).
	const bare = fakePage({ cookie: "twid=u%3D7; ct0=abc" });
	bare.window["__INITIAL_STATE__"] = {
		session: { user_id: "7" },
		entities: { users: { entities: { "7": { screen_name: "sample_owner" } } } },
	};
	assert.deepEqual(bare.run(OWNER_HANDLE_SCRIPT), {
		handle: null,
		via: "none",
	});
});

test("only a link whose own address is the wanted path is ever clicked", () => {
	const selector = 'nav[aria-label="Primary"] a[href="/i/history"]';
	const page = fakePage({
		links: { [selector]: { href: "https://x.com/i/history" } },
	});
	assert.deepEqual(page.run(followLinkScript([selector], "/i/history")), {
		via: "link",
	});
	assert.equal(page.links.get(selector)?.clicked, 1);
	assert.deepEqual(page.pushed, []);

	// A matching element that is a button, or a link to somewhere else, or to
	// another origin, is left alone; the history fallback is used instead.
	for (const link of [
		{ href: "https://x.com/i/history", tagName: "BUTTON" },
		{ href: "https://x.com/compose/post" },
		{ href: "https://example.invalid/i/history" },
	]) {
		const other = fakePage({ links: { [selector]: link } });
		assert.deepEqual(other.run(followLinkScript([selector], "/i/history")), {
			via: "history",
		});
		assert.equal(other.links.get(selector)?.clicked, 0);
		assert.deepEqual(other.pushed, ["/i/history"]);
		assert.deepEqual(other.events, ["popstate"]);
	}
});

test("a view the page is already on is not opened again", () => {
	const page = fakePage({ path: "/i/history" });
	assert.deepEqual(page.run(followLinkScript(["a"], "/i/history")), {
		via: "already_there",
	});
	assert.deepEqual(page.pushed, []);
});

test("the route fallback is skipped when the caller asks it to be", () => {
	const page = fakePage();
	assert.deepEqual(page.run(followLinkScript(["a"], "/i/history", "none")), {
		via: "none",
	});
	assert.deepEqual(page.pushed, []);
	// A matching link is still followed, without the route fallback.
	const linked = fakePage({
		links: {
			'a[href="/i/history"]': { href: "https://x.com/i/history" },
		},
	});
	assert.deepEqual(linked.run(followLinkScript(['a[href="/i/history"]'], "/i/history", "none")), {
		via: "link",
	});
	assert.deepEqual(linked.pushed, []);
});

test("the drawer's own profile link is followed", () => {
	const selector = drawerProfileSelector("sample_owner");
	const page = fakePage({
		links: { [selector]: { href: "https://x.com/sample_owner" } },
	});
	assert.deepEqual(
		page.run(followLinkScript([selector], "/sample_owner", "none")),
		{ via: "link" },
	);
	assert.equal(page.links.get(selector)?.clicked, 1);
	assert.deepEqual(page.pushed, []);
});

test("the drawer control is clicked only when it is a link or button", () => {
	const button = fakePage({
		links: {
			[DRAWER_OPEN_SELECTORS[0]]: {
				href: "https://x.com/home",
				tagName: "BUTTON",
			},
		},
	});
	assert.deepEqual(button.run(openDrawerScript(DRAWER_OPEN_SELECTORS)), {
		via: "drawer",
	});
	assert.equal(button.links.get(DRAWER_OPEN_SELECTORS[0])?.clicked, 1);

	// A matching element that is neither a link nor a button is left alone.
	const container = fakePage({
		links: {
			[DRAWER_OPEN_SELECTORS[0]]: {
				href: "https://x.com/home",
				tagName: "DIV",
			},
		},
	});
	assert.deepEqual(container.run(openDrawerScript(DRAWER_OPEN_SELECTORS)), {
		via: "none",
	});
	assert.equal(container.links.get(DRAWER_OPEN_SELECTORS[0])?.clicked, 0);

	// No control: nothing is clicked.
	assert.deepEqual(fakePage().run(openDrawerScript(DRAWER_OPEN_SELECTORS)), {
		via: "none",
	});
});

test("an open drawer already holding the wanted link is not toggled shut", () => {
	const control = {
		href: "https://x.com/home",
		tagName: "BUTTON",
	};
	const page = fakePage({
		drawerLinks: [
			{ href: "https://x.com/sample_owner" },
			{ href: "https://x.com/sample_owner/following" },
			{ href: "https://x.com/i/history" },
		],
		links: { [DRAWER_OPEN_SELECTORS[0]]: control },
	});
	assert.deepEqual(
		page.run(openDrawerScript(DRAWER_OPEN_SELECTORS, "/i/history")),
		{ via: "already_open" },
	);
	assert.equal(page.links.get(DRAWER_OPEN_SELECTORS[0])?.clicked, 0);
	// A wanted link the drawer does not hold still clicks the control.
	assert.deepEqual(
		page.run(openDrawerScript(DRAWER_OPEN_SELECTORS, "/i/bookmarks")),
		{ via: "drawer" },
	);
	assert.equal(page.links.get(DRAWER_OPEN_SELECTORS[0])?.clicked, 1);
});

test("the layout script reports the viewport, the route and each control's identity", () => {
	const page = fakePage({
		innerHeight: 844,
		innerWidth: 390,
		navControls: [
			{
				ariaLabel: "Profile",
				href: "https://x.com/sample_owner?token=secret#frag",
				tagName: "A",
				testid: "AppTabBar_Profile_Link",
			},
			{
				ariaExpanded: "false",
				href: "https://x.com/i/history/likes",
				role: "tab",
				tagName: "A",
			},
			{ role: "button", tagName: "BUTTON", testid: "DashButton" },
		],
		pageControls: [
			{
				ariaExpanded: "true",
				ariaLabel: "Account",
				inDialog: true,
				tagName: "BUTTON",
				testid: "Avatar",
			},
		],
		path: "/i/history",
	});
	const reading = page.run(LAYOUT_SCRIPT);
	assert.equal(reading.width, 390);
	assert.equal(reading.height, 844);
	assert.equal(reading.path, "/i/history");
	assert.deepEqual(reading.controls, [
		{
			tag: "a",
			testid: "AppTabBar_Profile_Link",
			ariaLabel: "Profile",
			role: null,
			expanded: null,
			scope: "page",
			// No query and no fragment ever leave the page.
			path: "/sample_owner",
		},
		{
			tag: "a",
			testid: null,
			ariaLabel: null,
			role: "tab",
			expanded: "false",
			scope: "page",
			path: "/i/history/likes",
		},
		{
			tag: "button",
			testid: "DashButton",
			ariaLabel: null,
			role: "button",
			expanded: null,
			scope: "page",
			path: null,
		},
		// A control outside any container with a test id comes after them.
		{
			tag: "button",
			testid: "Avatar",
			ariaLabel: "Account",
			role: null,
			expanded: "true",
			scope: "dialog",
			path: null,
		},
	]);
});

test("a labelled control outside any container is reported; article controls are not", () => {
	const page = fakePage({
		navControls: [{ ariaLabel: "Explore", href: "/explore", tagName: "A" }],
		pageControls: [
			{ ariaLabel: "Account", tagName: "BUTTON", testid: "Avatar" },
			// A timeline post's reply control: inside an article, so skipped.
			{
				ariaLabel: "Reply",
				href: "/sample_owner/status/1",
				inArticle: true,
				testid: "Reply",
			},
			// A control in the primary column's own section: also skipped.
			{
				ariaLabel: "More",
				inPrimarySection: true,
				tagName: "BUTTON",
				testid: "PostActions",
			},
			// An unlabelled control outside a container is not worth the cap.
			{ href: "/unlabelled", tagName: "A" },
		],
	});
	const reading = page.run(LAYOUT_SCRIPT);
	assert.deepEqual(
		reading.controls.map((control: { testid: string | null }) => control.testid),
		[null, "Avatar"],
	);
});

test("the layout script stops at the control cap", () => {
	const page = fakePage({
		navControls: Array.from(
			{ length: LAYOUT_CONTROL_CAP + 5 },
			(_, index) => ({ href: `https://x.com/i/history/${index}`, tagName: "A" }),
		),
	});
	assert.equal(page.run(LAYOUT_SCRIPT).controls.length, LAYOUT_CONTROL_CAP);
});

test("scrolling moves the window by a share of its height and nothing else", () => {
	const page = fakePage();
	assert.equal(page.run(scrollScript(2.5)), true);
	assert.deepEqual(page.scrolled, [2000]);
	assert.equal(page.sent.length, 0);
});

test("no page script uses eval or builds a function from text", () => {
	for (const script of [
		INSTALL,
		POLL_SCRIPT,
		OWNER_HANDLE_SCRIPT,
		LAYOUT_SCRIPT,
		followLinkScript(["a"], "/x"),
		openDrawerScript(DRAWER_OPEN_SELECTORS),
		scrollScript(2),
	]) {
		assert.doesNotMatch(
			script,
			/\beval\s*\(|new Function|setTimeout\s*\(\s*["'`]/,
		);
	}
});
