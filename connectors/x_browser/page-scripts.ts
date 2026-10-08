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
 * Every script is read-only. The only action any of them takes on the page
 * is to follow one of the app's own navigation links or to scroll.
 */

/** The page global that holds the observer's buffer. */
export const OBSERVER_GLOBAL = "__pdppXObserver";
/** Bump when the buffer entry shape changes, so a stale observer is replaced. */
const OBSERVER_VERSION = 1;

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
 * only; query ids rotate and are never read. It changes no request.
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
	const record = (request, status, readBody) => {
		state.seen += 1;
		if (state.buffer.length >= config.maxBuffered) {
			state.dropped += 1;
			return;
		}
		const keep = wanted.has(request.operation);
		let body = "";
		if (keep || status !== 200) {
			try {
				body = String(readBody() || "");
			} catch (error) {
				body = "";
			}
			if (!keep) body = body.slice(0, config.errorBodyChars);
		}
		state.buffer.push({
			operation: request.operation,
			variables: request.variables,
			status: Number(status) || 0,
			wanted: keep,
			body,
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
 * renders it without the test id; whether a narrow layout does was not
 * checked.
 */
export const PROFILE_LINK_SELECTORS = [
	'a[data-testid="AppTabBar_Profile_Link"]',
	'a[aria-label="Profile"]',
] as const;

/**
 * The signed-in owner's handle, from the href of the app's own profile link.
 * There is no other source: the `twid` cookie gives the owner's numeric id
 * but not the handle, and `window.__INITIAL_STATE__` is undefined on a
 * signed-in page. When no link is present the handle is null and the caller
 * stops; it is never guessed.
 */
export const OWNER_HANDLE_SCRIPT = `(() => {
	const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
	for (const selector of ${JSON.stringify(PROFILE_LINK_SELECTORS)}) {
		const link = document.querySelector(selector);
		const href = link ? String(link.getAttribute("href") || "") : "";
		const handle = href.replace(/^\\//, "").replace(/\\/$/, "");
		if (HANDLE.test(handle)) return { handle, via: selector.includes("testid") ? "profile_link" : "profile_label" };
	}
	return { handle: null, via: "none" };
})()`;

/**
 * Move to another view of the app without a page load, so the observer
 * survives. Clicks the first of `selectors` that matches an `<a>` whose own
 * href is `path`; nothing else is ever clicked.
 *
 * UNVERIFIED fallback: when no link matches (the selectors are from the wide
 * desktop layout, and a narrow one may not render them), it pushes
 * `path` onto the history and dispatches `popstate`, which a client-side
 * router listens for. Whether x.com's router follows it was not checked.
 */
export function followLinkScript(
	selectors: readonly string[],
	path: string,
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
	return true;
})()`;
}
