// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The code this connector runs inside the discord.com page.
 *
 * Every export is a JavaScript expression in a string. Both hosts evaluate a
 * string unchanged, where a serialized function would carry the `__name`
 * calls tsx adds and the helpers a bundler may add, and neither exists in the
 * page.
 *
 * Token rule. The Discord client authorizes its own API requests with headers
 * it holds in memory. The reader below watches for the next request the
 * client itself sends, keeps a copy of that request's headers in a closure in
 * the page, and reuses them for this connector's GET requests. The header
 * values never leave that closure: no expression here returns them, and a
 * response body that repeats one is redacted before it is returned.
 */

export const DISCORD_ORIGIN = "https://discord.com";

/** `Symbol.for` key of the page's reader object. A symbol key is not enumerable. */
const SESSION_KEY = "pdpp.discord_browser.session";

/**
 * The only paths the reader will request, relative to `/api/v<n>`. The reader
 * refuses anything else in the page, so no caller can reach a direct-message,
 * settings or write endpoint through it. Each is a GET.
 */
const ALLOWED_PATHS = [
	"^/users/@me$",
	"^/users/@me/guilds$",
	"^/users/@me/connections$",
	"^/guilds/[0-9]{1,20}/messages/search\\?author_id=[0-9]{1,20}&sort_by=timestamp&sort_order=desc&offset=[0-9]{1,5}$",
];

/**
 * Headers that belong to one client request, not to the session, so a copy
 * must not be replayed on another request.
 */
const PER_REQUEST_HEADERS = [
	"content-length",
	"content-type",
	"x-audit-log-reason",
	"x-captcha-key",
	"x-captcha-rqtoken",
	"x-captcha-session-id",
	"x-context-properties",
];

/** JSON keys dropped from every response before it leaves the page. */
const SECRET_JSON_KEYS = ["access_token", "refresh_token", "token"];

/** Shortest header value treated as a credential when redacting a body. */
const SECRET_MIN_CHARS = 16;

/**
 * Signed-in markers. The first was observed on an English desktop layout on
 * 2026-10-08; the second is the server list, which carries no translated
 * label and is not verified.
 */
const SIGNED_IN_MARKERS =
	'section[aria-label="User area"], [data-list-id="guildsnav"]';

/**
 * In-app links that leave the Friends page without opening a conversation.
 * Clicking /shop was observed on 2026-10-08 to make the client send several
 * requests within 4 s. The message-requests link is left out on purpose.
 */
const AWAY_LINKS = [
	'a[href="/shop"]',
	'a[href="/store"]',
	'a[href="/quest-home"]',
];
const AWAY_PATH = "/shop";
const HOME_LINKS = ['a[href="/channels/@me"]'];
const HOME_PATH = "/channels/@me";

const PAGE_HELPERS = String.raw`
	const ORIGIN = ${JSON.stringify(DISCORD_ORIGIN)};
	const KEY = Symbol.for(${JSON.stringify(SESSION_KEY)});
	const signedInMarker = () =>
		document.querySelector(${JSON.stringify(SIGNED_IN_MARKERS)}) !== null;
	const install = () => {
		if (globalThis[KEY]) return globalThis[KEY];
		const API_PATH = /^\/api\/(v\d{1,2})\//;
		const PER_REQUEST = new Set(${JSON.stringify(PER_REQUEST_HEADERS)});
		const SECRET_KEYS = new Set(${JSON.stringify(SECRET_JSON_KEYS)});
		const SECRET_MIN = ${SECRET_MIN_CHARS};
		const ALLOWED = ${JSON.stringify(ALLOWED_PATHS)}.map((source) => new RegExp(source));
		const nativeFetch = globalThis.fetch;
		const proto = XMLHttpRequest.prototype;
		const nativeOpen = proto.open;
		const nativeSetRequestHeader = proto.setRequestHeader;
		const nativeSend = proto.send;
		const pending = new WeakMap();
		let captured = null;
		const versionOf = (url) => {
			try {
				const target = new URL(String(url), location.href);
				if (target.origin !== ORIGIN) return null;
				const match = API_PATH.exec(target.pathname);
				return match ? match[1] : null;
			} catch {
				return null;
			}
		};
		// Put the page's own functions back as soon as one request was seen.
		const restore = () => {
			if (proto.open === open) proto.open = nativeOpen;
			if (proto.setRequestHeader === setRequestHeader)
				proto.setRequestHeader = nativeSetRequestHeader;
			if (proto.send === send) proto.send = nativeSend;
			if (globalThis.fetch === fetchHook) globalThis.fetch = nativeFetch;
		};
		const offer = (version, pairs, transport) => {
			if (captured || !version) return;
			const headers = [];
			let authorized = false;
			for (const [name, value] of pairs) {
				const lower = String(name).toLowerCase();
				if (lower === "authorization" && value) authorized = true;
				if (!PER_REQUEST.has(lower)) headers.push([lower, String(value)]);
			}
			// A request without Authorization is not a signed-in client request.
			if (!authorized) return;
			captured = { version, transport, headers };
			restore();
		};
		function open(_method, url) {
			try {
				pending.set(this, { version: versionOf(url), headers: [] });
			} catch {}
			return nativeOpen.apply(this, arguments);
		}
		function setRequestHeader(name, value) {
			try {
				const request = pending.get(this);
				if (request) request.headers.push([name, value]);
			} catch {}
			return nativeSetRequestHeader.apply(this, arguments);
		}
		function send() {
			try {
				const request = pending.get(this);
				if (request) offer(request.version, request.headers, "xhr");
			} catch {}
			return nativeSend.apply(this, arguments);
		}
		function fetchHook(input, init) {
			try {
				const request =
					typeof Request === "function" && input instanceof Request ? input : null;
				const version = versionOf(request ? request.url : input);
				if (version) {
					const headers = new Headers(request ? request.headers : undefined);
					if (init && init.headers)
						new Headers(init.headers).forEach((value, name) => headers.set(name, value));
					offer(version, [...headers.entries()], "fetch");
				}
			} catch {}
			return nativeFetch.apply(this, arguments);
		}
		// Retry-After only: the page cannot read Discord's X-RateLimit headers.
		const retryAfter = (response) => {
			const raw = response.headers.get("retry-after");
			const value = raw === null ? Number.NaN : Number(raw);
			return Number.isFinite(value) ? value : null;
		};
		// Redact the decoded value. A credential can be JSON-escaped in the raw
		// body, so a substring check on the undecoded text would miss it.
		const redact = (value) => {
			if (typeof value === "string") {
				for (const [, secret] of captured.headers)
					if (secret.length >= SECRET_MIN && value.includes(secret))
						value = value.split(secret).join("[redacted]");
				return value;
			}
			if (Array.isArray(value)) return value.map(redact);
			if (value && typeof value === "object") {
				const clean = {};
				for (const [key, child] of Object.entries(value)) {
					if (SECRET_KEYS.has(key)) continue;
					clean[redact(key)] = redact(child);
				}
				return clean;
			}
			return value;
		};
		const get = async (path, timeoutMs) => {
			if (location.origin !== ORIGIN) return { kind: "wrong_origin" };
			if (!captured) return { kind: "no_headers" };
			if (typeof path !== "string" || !ALLOWED.some((rule) => rule.test(path)))
				return { kind: "refused" };
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await nativeFetch.call(
					globalThis,
					"/api/" + captured.version + path,
					{
						method: "GET",
						credentials: "include",
						headers: captured.headers,
						signal: controller.signal,
					},
				);
				const text = await response.text();
				let json = null;
				try {
					json = redact(JSON.parse(text));
				} catch {}
				return {
					kind: "response",
					status: response.status,
					json,
					retryAfterSeconds: retryAfter(response),
				};
			} catch {
				return { kind: "network_error", timedOut: controller.signal.aborted };
			} finally {
				clearTimeout(timer);
			}
		};
		const session = Object.freeze({
			status: () => ({
				captured: captured !== null,
				version: captured ? captured.version : null,
				transport: captured ? captured.transport : null,
			}),
			get,
		});
		Object.defineProperty(globalThis, KEY, {
			value: session,
			enumerable: false,
			configurable: true,
		});
		proto.open = open;
		proto.setRequestHeader = setRequestHeader;
		proto.send = send;
		globalThis.fetch = fetchHook;
		return session;
	};
`;

/**
 * True when the page shows a signed-in Discord app. It only reads the page:
 * no navigation, no request, no hook. Safe to repeat while the owner signs in.
 */
export const PROBE_EXPRESSION = `(() => {
	${PAGE_HELPERS}
	if (location.origin !== ORIGIN) return false;
	if (!location.pathname.startsWith("/channels/")) return false;
	const session = globalThis[KEY];
	return Boolean(session && session.status().captured) || signedInMarker();
})()`;

/**
 * "signed_in", "signed_out" or "loading" for the page's current view. The app
 * decides between the two after it loads; "loading" is the time before that.
 */
export const VIEW_EXPRESSION = `(() => {
	${PAGE_HELPERS}
	if (location.origin !== ORIGIN) return "signed_out";
	if (/^\\/(login|register)(\\/|$)/.test(location.pathname)) return "signed_out";
	if (location.pathname.startsWith("/channels/") && signedInMarker())
		return "signed_in";
	return "loading";
})()`;

/**
 * Start watching the client's own requests (once per document) and report
 * whether a header set is held. Returns `{ captured, version, transport }`, or
 * `{ wrongPage: true }` off the app (the sign-in page is never watched); never
 * a header.
 */
export const WATCH_EXPRESSION = `(() => {
	${PAGE_HELPERS}
	if (location.origin !== ORIGIN) return { wrongPage: true };
	if (!location.pathname.startsWith("/channels/") && !globalThis[KEY])
		return { wrongPage: true };
	return install().status();
})()`;

/**
 * One harmless in-app navigation, so an idle client sends a request. "away"
 * opens a page that is not a conversation; "home" returns to Friends. It
 * never opens a direct message or a channel: the client would read messages
 * there and may mark them read. Returns "clicked", "routed" or "wrong_origin".
 */
export function nudgeExpression(step: "away" | "home"): string {
	const links = step === "away" ? AWAY_LINKS : HOME_LINKS;
	const path = step === "away" ? AWAY_PATH : HOME_PATH;
	return `(() => {
	if (location.origin !== ${JSON.stringify(DISCORD_ORIGIN)}) return "wrong_origin";
	for (const selector of ${JSON.stringify(links)}) {
		const link = document.querySelector(selector);
		if (link) {
			link.click();
			return "clicked";
		}
	}
	history.pushState(null, "", ${JSON.stringify(path)});
	dispatchEvent(new PopStateEvent("popstate", { state: null }));
	return "routed";
})()`;
}

/** What `apiGetExpression` resolves to. It carries no request header. */
export type PageApiResult =
	| { kind: "no_headers" }
	| { kind: "no_session" }
	| { kind: "refused" }
	| { kind: "wrong_origin" }
	| { kind: "network_error"; timedOut: boolean }
	| {
			kind: "response";
			status: number;
			json: unknown;
			retryAfterSeconds: number | null;
	  };

/** GET one allowed API path from the page with the client's own headers. */
export function apiGetExpression(path: string, timeoutMs: number): string {
	return `(async () => {
	const session = globalThis[Symbol.for(${JSON.stringify(SESSION_KEY)})];
	if (!session) return { kind: "no_session" };
	return session.get(${JSON.stringify(path)}, ${JSON.stringify(timeoutMs)});
})()`;
}
