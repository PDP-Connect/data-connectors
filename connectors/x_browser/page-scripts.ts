// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The scripts this connector runs inside the x.com page.
 *
 * Each is a complete expression in a string, not a function passed to
 * `page.evaluate`: a function is serialised with `toString()`, and the
 * desktop loader and the PageShim bundler each rewrite function bodies
 * (name helpers, minification), so a function that works on one can
 * reference a helper the page does not have on the other. A string reaches
 * the page as written. None of them uses `eval` or `new Function`
 * (CONNECTOR-GUIDELINES rule 4).
 *
 * Every script is read-only. The only actions any of them takes on the page
 * are to follow one of the app's own navigation links, to click the account
 * control that opens the narrow layout's drawer, or to scroll.
 */

/** The page global that holds the observer's buffer. */
export const OBSERVER_GLOBAL = "__pdppXObserver";
/** Bump when the buffer entry shape changes, so a stale observer is replaced. */
const OBSERVER_VERSION = 3;

export interface ObserverConfig {
	/** How much of a non-200 body is kept for an operation that is not wanted. */
	readonly errorBodyChars: number;
	/** Entries kept before new ones are dropped (and counted). */
	readonly maxBuffered: number;
	/** GraphQL operation names whose response bodies are kept in full. */
	readonly wanted: readonly string[];
}

/**
 * Install the response observer. It wraps `XMLHttpRequest.prototype.open` and
 * `send`, which is how x.com makes its GraphQL requests, and `window.fetch`
 * as a fallback, and buffers the response of every request whose path is
 * `/graphql/<queryId>/<OperationName>`. It matches on the operation name
 * only; query ids rotate and are never read. It changes no request. For every
 * response it also counts the posts the body carries, as a number only, so an
 * operation the connector does not read still spends its reading budget.
 *
 * The observer lives in the page's JavaScript realm. A full page load drops
 * it, so the connector moves between views with the app's own client-side
 * navigation (see `followLinkScript`).
 */
export function installObserverScript(config: ObserverConfig): string {
	return `(() => {
	const KEY = ${JSON.stringify(OBSERVER_GLOBAL)};
	const VERSION = ${OBSERVER_VERSION};
	const existing = window[KEY];
	if (existing && existing.version === VERSION) return { installed: false };
	const config = ${JSON.stringify(config)};
	const wanted = new Set(config.wanted);
	const state = { version: VERSION, buffer: [], seen: 0, dropped: 0 };
	const describe = (rawUrl) => {
		try {
			const url = new URL(String(rawUrl), location.href);
			const match = /\\/graphql\\/[^/]+\\/([A-Za-z0-9_]+)$/.exec(url.pathname);
			if (!match) return null;
			return {
				operation: match[1],
				variables: (url.searchParams.get("variables") || "").slice(0, 4000),
			};
		} catch (error) {
			return null;
		}
	};
	const countPosts = (node) => {
		if (Array.isArray(node)) {
			let total = 0;
			for (const item of node) total += countPosts(item);
			return total;
		}
		if (!node || typeof node !== "object") return 0;
		// A promoted post is not a post this connector reads, so it is not
		// counted, matching the parser's count.
		const countThis =
			Object.prototype.hasOwnProperty.call(node, "tweet_results") &&
			!Object.prototype.hasOwnProperty.call(node, "promotedMetadata");
		let total = countThis ? 1 : 0;
		for (const key of Object.keys(node)) total += countPosts(node[key]);
		return total;
	};
	const inspect = (text) => {
		try {
			const payload = JSON.parse(text);
			const data = payload && payload.data;
			const hasData = Boolean(
				data && typeof data === "object" && !Array.isArray(data) &&
				Object.keys(data).length > 0,
			);
			const errors = payload && Array.isArray(payload.errors) ? payload.errors : [];
			const refused = !hasData && errors.length > 0;
			const code = refused && errors[0] ? errors[0].code : null;
			// The post count is a number only: an operation the connector does
			// not read still pays for the posts its body loaded, yet no body,
			// id or text leaves the page for it.
			return {
				refused,
				errorCode: typeof code === "number" ? code : null,
				postCount: countPosts(payload),
			};
		} catch (error) {
			return { refused: false, errorCode: null, postCount: 0 };
		}
	};
	const record = (request, status, readBody) => {
		state.seen += 1;
		if (state.buffer.length >= config.maxBuffered) {
			state.dropped += 1;
			return;
		}
		const keep = wanted.has(request.operation);
		let text = "";
		try {
			text = String(readBody() || "");
		} catch (error) {
			text = "";
		}
		// An operation the run did not ask for is not buffered, but a body X
		// refused still has to reach the connector: keep its error code only.
		const signal = inspect(text);
		let body = "";
		if (keep) {
			body = text;
		} else if (status !== 200) {
			body = text.slice(0, config.errorBodyChars);
		}
		state.buffer.push({
			operation: request.operation,
			variables: request.variables,
			status: Number(status) || 0,
			wanted: keep,
			body,
			refused: signal.refused,
			errorCode: signal.errorCode,
			postCount: signal.postCount,
		});
	};
	const requests = new WeakMap();
	const xhrOpen = XMLHttpRequest.prototype.open;
	const xhrSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (method, url) {
		try {
			const request = describe(url);
			if (request) requests.set(this, request);
		} catch (error) {}
		return xhrOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function () {
		try {
			const request = requests.get(this);
			if (request) {
				const xhr = this;
				xhr.addEventListener("loadend", () => {
					try {
						record(request, xhr.status, () =>
							xhr.responseType === "" || xhr.responseType === "text"
								? xhr.responseText
								: xhr.responseType === "json"
									? JSON.stringify(xhr.response)
									: "",
						);
					} catch (error) {}
				});
			}
		} catch (error) {}
		return xhrSend.apply(this, arguments);
	};
	const nativeFetch = window.fetch;
	if (typeof nativeFetch === "function") {
		window.fetch = function (input) {
			const promise = nativeFetch.apply(this, arguments);
			try {
				const request = describe(
					typeof input === "string" ? input : (input && input.url) || input,
				);
				if (request) {
					promise.then(
						(response) => {
							try {
								response
									.clone()
									.text()
									.then(
										(text) => record(request, response.status, () => text),
										() => record(request, response.status, () => ""),
									);
							} catch (error) {}
						},
						() => record(request, 0, () => ""),
					);
				}
			} catch (error) {}
			return promise;
		};
	}
	window[KEY] = state;
	return { installed: true };
})()`;
}

/**
 * Read where the page is, whether the session cookies are present, and take
 * buffered responses off the observer: every small entry up to and including
 * the first one whose body was kept in full, so one call returns at most one
 * large body.
 *
 * `twid` (value `u%3D<numeric user id>`) and `ct0` are the two session
 * cookies page script can read. Their presence, on x.com and off the sign-in
 * and challenge paths, is this connector's signed-in signal.
 */
export const POLL_SCRIPT = `(() => {
	const cookies = document.cookie || "";
	const twid = /(?:^|;\\s*)twid=([^;]*)/.exec(cookies);
	let userId = null;
	if (twid) {
		let value = twid[1];
		try {
			value = decodeURIComponent(value);
		} catch (error) {}
		const match = /^"?u=(\\d{1,30})"?$/.exec(value);
		userId = match ? match[1] : null;
	}
	const observer = window[${JSON.stringify(OBSERVER_GLOBAL)}];
	const entries = [];
	if (observer) {
		while (observer.buffer.length > 0) {
			const entry = observer.buffer.shift();
			entries.push(entry);
			if (entry.wanted) break;
		}
	}
	const root = document.documentElement;
	return {
		origin: location.origin,
		path: location.pathname,
		userId,
		hasCsrfCookie: /(?:^|;\\s*)ct0=[^;]+/.test(cookies),
		observerAlive: Boolean(observer),
		entries,
		remaining: observer ? observer.buffer.length : 0,
		dropped: observer ? observer.dropped : 0,
		atBottom: window.scrollY + window.innerHeight >= root.scrollHeight - 4,
	};
})()`;

/**
 * The app's links to the signed-in owner's profile, whose href is
 * `/<handle>`. The first was seen in the wide desktop layout's navigation.
 * The second is the same link by its accessible name, for a layout that
 * renders it without the test id. The narrow layout at 390 px renders neither
 * (seen 2026-10-09); its drawer link is read by `OWNER_HANDLE_SCRIPT` instead.
 */
export const PROFILE_LINK_SELECTORS = [
	'a[data-testid="AppTabBar_Profile_Link"]',
	'a[aria-label="Profile"]',
] as const;

/**
 * The control that opens the narrow layout's account drawer, where the
 * profile and History links live once the left navigation is gone. Seen in the
 * owner's browser at a 390 px viewport on 2026-10-09: the button that carries
 * this test id opened the drawer.
 */
export const DRAWER_OPEN_SELECTORS = [
	'[data-testid="DashButton_ProfileIcon_Link"]',
] as const;

/**
 * The narrow layout's account drawer, once open. Seen at 390 px on 2026-10-09.
 * Its own links carry no test id and no accessible name, so the profile link
 * is addressed by its href alone.
 */
export const DRAWER_DIALOG_SELECTOR = '[role="dialog"]';

/** The drawer's link to the validated handle's profile. */
export function drawerProfileSelector(handle: string): string {
	return `${DRAWER_DIALOG_SELECTOR} a[href="/${handle}"]`;
}

/**
 * Click the app's account control that opens the narrow layout's drawer. It
 * clicks only an element the selectors match and that is a link, a button or a
 * control role button declares; it changes no request.
 *
 * When `wantedPath` is given and a drawer is already open with a link to that
 * path, it clicks nothing and reports "already_open": the control toggles, so
 * clicking it again would shut the drawer before the link was followed. `via`
 * is "drawer" when a control was clicked, "already_open" when an open drawer
 * already held the link, and "none" when no control is present.
 */
export function openDrawerScript(
	selectors: readonly string[],
	wantedPath: string | null = null,
): string {
	return `(() => {
	const wanted = ${JSON.stringify(wantedPath)};
	if (wanted !== null) {
		const dialog = document.querySelector(${JSON.stringify(DRAWER_DIALOG_SELECTOR)});
		const links = dialog && dialog.querySelectorAll ? dialog.querySelectorAll("a[href]") : [];
		for (const link of links) {
			let path = "";
			try {
				path = new URL(String(link.getAttribute("href") || ""), location.href).pathname;
			} catch (error) {}
			if (path === wanted) return { via: "already_open" };
		}
	}
	for (const selector of ${JSON.stringify(selectors)}) {
		let control = null;
		try {
			control = document.querySelector(selector);
		} catch (error) {}
		if (!control || typeof control.click !== "function") continue;
		const tag = String(control.tagName || "");
		const role = control.getAttribute ? String(control.getAttribute("role") || "") : "";
		if (tag !== "A" && tag !== "BUTTON" && role !== "button") continue;
		control.click();
		return { via: "drawer" };
	}
	return { via: "none" };
})()`;
}

/**
 * The signed-in owner's handle, from the href of the app's own profile link.
 * The wide layout's link is read first. When it is absent, the handle comes
 * from the open account drawer without reading any text: an anchor whose own
 * href path is `/<handle>/following`, with an anchor to `/<handle>` beside it
 * in the same dialog. There is no other source: the `twid` cookie gives the
 * owner's numeric id but not the handle, and `window.__INITIAL_STATE__` is
 * undefined on a signed-in page. When no link is present the handle is null
 * and the caller stops; it is never guessed.
 */
export const OWNER_HANDLE_SCRIPT = `(() => {
	const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
	for (const selector of ${JSON.stringify(PROFILE_LINK_SELECTORS)}) {
		const link = document.querySelector(selector);
		const href = link ? String(link.getAttribute("href") || "") : "";
		const handle = href.replace(/^\\//, "").replace(/\\/$/, "");
		if (HANDLE.test(handle)) return { handle, via: selector.includes("testid") ? "profile_link" : "profile_label" };
	}
	const pathOf = (element) => {
		const href = element ? String(element.getAttribute("href") || "") : "";
		try {
			return new URL(href, location.href).pathname;
		} catch (error) {
			return "";
		}
	};
	const dialog = document.querySelector(${JSON.stringify(DRAWER_DIALOG_SELECTOR)});
	const links = dialog && dialog.querySelectorAll ? dialog.querySelectorAll("a[href]") : [];
	for (const link of links) {
		const match = /^\\/([A-Za-z0-9_]{1,15})\\/following$/.exec(pathOf(link));
		if (!match) continue;
		const own = "/" + match[1];
		for (const other of links) {
			if (pathOf(other) === own) return { handle: match[1], via: "drawer_following" };
		}
	}
	return { handle: null, via: "none" };
})()`;

/** Whether `followLinkScript` may push the path when no link matches. */
export type LinkFallback = "route" | "none";

/**
 * Move to another view of the app without a page load, so the observer
 * survives. Clicks the first of `selectors` that matches an `<a>` whose own
 * href is `path`; nothing else is ever clicked.
 *
 * With `fallback` "route" (the default) it pushes `path` onto the history and
 * dispatches `popstate` when no link matches, which a client-side router may
 * listen for; whether x.com's router follows it was not checked. With "none"
 * it reports `{ via: "none" }` instead, so the caller can try opening the
 * narrow layout's drawer before falling back.
 */
export function followLinkScript(
	selectors: readonly string[],
	path: string,
	fallback: LinkFallback = "route",
): string {
	return `(() => {
	const path = ${JSON.stringify(path)};
	if (location.pathname === path) return { via: "already_there" };
	// The links sit above the list; a walk leaves the window far below them.
	window.scrollTo(0, 0);
	for (const selector of ${JSON.stringify(selectors)}) {
		let link = null;
		try {
			link = document.querySelector(selector);
		} catch (error) {}
		if (!link || link.tagName !== "A") continue;
		let target = null;
		try {
			target = new URL(link.href, location.href);
		} catch (error) {}
		if (!target || target.origin !== location.origin || target.pathname !== path) continue;
		link.click();
		return { via: "link" };
	}
	if (${JSON.stringify(fallback)} === "none") return { via: "none" };
	try {
		history.pushState({}, "", path);
		window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
		return { via: "history" };
	} catch (error) {
		return { via: "none" };
	}
})()`;
}

/**
 * Scroll the window down by a share of its height. Seen on x.com: a
 * `window.scrollBy` from page script that brings the window near the bottom
 * of the list makes the app request the next page (the same operation with
 * a `cursor` variable), also while the tab is hidden. A step inside what is
 * already rendered makes no request, so the caller keeps stepping.
 */
export function scrollScript(viewportShare: number): string {
	return `(() => {
	window.scrollBy(0, Math.max(200, Math.round(window.innerHeight * ${Number(viewportShare)})));
	return { via: "scroll" };
})()`;
}

/**
 * The containers whose controls describe the navigation a layout offers: the
 * left navigation, the header, the tab strips and the narrow layout's bottom
 * bar. Matched by element, not by X-specific test id, so a layout that moves
 * its controls reports them.
 */
export const LAYOUT_CONTAINER_SELECTOR = [
	"nav",
	"header",
	'[role="navigation"]',
	'[role="tablist"]',
	"footer",
	'[data-testid="BottomBar"]',
].join(", ");

/** A control the layout can offer: a link, a button or a control role button. */
const LAYOUT_CONTROL_SELECTOR = 'a, button, [role="button"]';

/**
 * Regions whose controls are not navigation and would spend the cap: a
 * timeline post's many buttons and handle links, and the primary column's own
 * sections. Matched with `closest`, so no nesting is assumed.
 */
const LAYOUT_EXCLUDE_SELECTORS = [
	"article",
	'[data-testid="primaryColumn"] section',
] as const;

/** Most controls one layout diagnostic names, to stay one short line. */
export const LAYOUT_CONTROL_CAP = 60;

/**
 * The current layout's viewport, its route and its controls. It takes the
 * controls inside a container above first, then any link, button or role
 * button anywhere in the document that carries a test id or an accessible
 * name, since a narrow layout may put its avatar control outside nav or
 * header. A control inside an `article` or a primary-column section is
 * skipped, and the cap bounds the rest.
 *
 * For each control it reads the attributes that identify it; from each href
 * it keeps only the pathname, so no query, fragment or origin leaves the page.
 * It reads no text content. The caller masks `@handle` in an accessible name
 * and replaces handle-shaped and numeric path segments before the line is
 * written.
 */
export const LAYOUT_SCRIPT = `(() => {
	const controls = [];
	const seen = new Set();
	const controlSelector = ${JSON.stringify(LAYOUT_CONTROL_SELECTOR)};
	const excluded = (element) => {
		for (const selector of ${JSON.stringify(LAYOUT_EXCLUDE_SELECTORS)}) {
			try {
				if (element.closest(selector)) return true;
			} catch (error) {}
		}
		return false;
	};
	const labelled = (element) =>
		Boolean(element.getAttribute("data-testid") || element.getAttribute("aria-label"));
	const describe = (element) => {
		const href = element.getAttribute("href");
		let path = null;
		if (String(element.tagName || "").toUpperCase() === "A" && href) {
			try {
				path = new URL(href, location.href).pathname;
			} catch (error) {}
		}
		return {
			tag: String(element.tagName || "").toLowerCase(),
			testid: element.getAttribute("data-testid") || null,
			ariaLabel: element.getAttribute("aria-label") || null,
			role: element.getAttribute("role") || null,
			expanded: element.getAttribute("aria-expanded") || null,
			scope: element.closest('[role="dialog"]') ? "dialog" : "page",
			path,
		};
	};
	const take = (element) => {
		if (seen.has(element) || excluded(element)) return;
		seen.add(element);
		controls.push(describe(element));
	};
	for (const container of document.querySelectorAll(${JSON.stringify(LAYOUT_CONTAINER_SELECTOR)})) {
		for (const element of container.querySelectorAll(controlSelector)) {
			if (controls.length >= ${LAYOUT_CONTROL_CAP}) break;
			take(element);
		}
		if (controls.length >= ${LAYOUT_CONTROL_CAP}) break;
	}
	for (const element of document.querySelectorAll(controlSelector)) {
		if (controls.length >= ${LAYOUT_CONTROL_CAP}) break;
		if (labelled(element)) take(element);
	}
	return { width: window.innerWidth, height: window.innerHeight, path: location.pathname, controls };
})()`;
