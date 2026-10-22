// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The code this connector runs inside the www.tiktok.com page.
 *
 * Every export is a JavaScript expression in a string, evaluated unchanged in
 * the page's main world (a serialized function would carry helpers tsx or a
 * bundler adds, which do not exist in the page).
 *
 * Signing rule. TikTok's web API wants a set of client parameters on every
 * call (aid, app_name, device_id, ...) and, on most paths, request signatures
 * (msToken, X-Bogus, X-Gnarly) that TikTok's own page scripts add to the URL
 * as the request leaves the page: in every recorded call they sit at the end
 * of the query, after the app's own parameters, and paths the page scripts do
 * not sign (/passport/account/info/v2/) carry none. So the reader:
 *
 *   1. copies the client parameters from a request the web app itself already
 *      made (the page's resource-timing entries), keeping an allowlist of
 *      plain client fields and dropping every signature and token;
 *   2. sends its own GET through the page's own `fetch` (or, if that comes
 *      back unsigned and empty, the page's own XMLHttpRequest), so TikTok's
 *      page scripts sign it exactly as they sign the app's requests.
 *
 * The copied parameters stay in a closure in the page. No expression returns
 * them, a signature, msToken or a cookie: a response reports only whether the
 * request left the page signed (a boolean).
 */

export const TIKTOK_ORIGIN = "https://www.tiktok.com";

/** `Symbol.for` key of the page's reader object. A symbol key is not enumerable. */
const SESSION_KEY = "pdpp.tiktok.reader";

/**
 * The only paths the reader will request, each a GET that reads. Everything
 * else (follow, like, post, comment, settings writes) is refused in the page.
 */
export const ALLOWED_PATHS = [
	"/passport/account/info/v2/",
	"/api/user/settings/",
	"/api/post/item_list/",
	"/api/favorite/item_list/",
	"/api/user/collect/item_list/",
	"/api/user/collection_list/",
	"/api/user/list/",
] as const;
export type AllowedPath = (typeof ALLOWED_PATHS)[number];

/** Query keys the connector itself may set; anything else is refused. */
const CALLER_KEYS = [
	"secUid",
	"cursor",
	"count",
	"coverFormat",
	"minCursor",
	"maxCursor",
	"scene",
	"needPinnedItemIds",
	"post_item_list_request_type",
	"enable_v2",
	"publicOnly",
	"appId",
];

/**
 * Plain client parameters copied from the web app's own request. Signatures
 * and tokens (msToken, X-Bogus, X-Gnarly, X-Dynosaur) are deliberately absent:
 * the page's scripts add fresh ones to each request.
 */
const CLIENT_KEYS = [
	"WebIdLastTime",
	"aid",
	"app_language",
	"app_name",
	"browser_language",
	"browser_name",
	"browser_online",
	"browser_platform",
	"browser_version",
	"channel",
	"cookie_enabled",
	"data_collection_enabled",
	"device_id",
	"device_platform",
	"focus_state",
	"history_len",
	"is_fullscreen",
	"is_page_visible",
	"language",
	"odinId",
	"os",
	"priority_region",
	"referer",
	"region",
	"root_referer",
	"screen_height",
	"screen_width",
	"tz_name",
	"user_is_login",
	"verifyFp",
	"webcast_language",
];

const PAGE_HELPERS = String.raw`
	const ORIGIN = ${JSON.stringify(TIKTOK_ORIGIN)};
	const KEY = Symbol.for(${JSON.stringify(SESSION_KEY)});
	const install = () => {
		if (globalThis[KEY]) return globalThis[KEY];
		const ALLOWED = new Set(${JSON.stringify(ALLOWED_PATHS)});
		const CALLER = new Set(${JSON.stringify(CALLER_KEYS)});
		const CLIENT = ${JSON.stringify(CLIENT_KEYS)};
		const VALUE = /^[A-Za-z0-9_.\-]{0,240}$/;
		const SIGNED = /[?&](X-Bogus|X-Gnarly)=/;
		let client = null;
		let preferred = "fetch";
		let confirmed = false;
		// The newest request the web app itself made to its JSON API that
		// carried the client parameters. Only the allowlisted keys are kept.
		const readClient = () => {
			if (client) return true;
			let entries = [];
			try {
				entries = performance.getEntriesByType("resource");
			} catch {
				return false;
			}
			for (let i = entries.length - 1; i >= 0; i -= 1) {
				let url;
				try {
					url = new URL(entries[i].name);
				} catch {
					continue;
				}
				if (url.origin !== ORIGIN || !url.pathname.startsWith("/api/")) continue;
				const params = url.searchParams;
				if (!params.get("aid") || !params.get("device_id") || !params.get("app_name")) continue;
				const kept = [];
				for (const key of CLIENT) {
					const value = params.get(key);
					if (value !== null) kept.push([key, value]);
				}
				client = kept;
				return true;
			}
			return false;
		};
		const send = async (transport, url, timeoutMs) => {
			if (transport === "xhr") {
				return await new Promise((resolve) => {
					try {
						const xhr = new XMLHttpRequest();
						xhr.open("GET", url, true);
						xhr.withCredentials = true;
						xhr.timeout = timeoutMs;
						xhr.onload = () =>
							resolve({
								status: xhr.status,
								type: xhr.getResponseHeader("content-type") || "",
								retryAfter: xhr.getResponseHeader("retry-after"),
								text: typeof xhr.responseText === "string" ? xhr.responseText : "",
								signed: SIGNED.test(xhr.responseURL || ""),
							});
						xhr.onerror = () => resolve(null);
						xhr.ontimeout = () => resolve(null);
						xhr.send();
					} catch {
						resolve(null);
					}
				});
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await globalThis.fetch(url, {
					method: "GET",
					credentials: "include",
					signal: controller.signal,
				});
				const text = await response.text();
				return {
					status: response.status,
					type: response.headers.get("content-type") || "",
					retryAfter: response.headers.get("retry-after"),
					text,
					signed: SIGNED.test(response.url || ""),
				};
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
			}
		};
		const get = async (path, params, timeoutMs) => {
			if (location.origin !== ORIGIN) return { kind: "wrong_origin" };
			if (typeof path !== "string" || !ALLOWED.has(path)) return { kind: "refused" };
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(params || {})) {
				if (!CALLER.has(key) || typeof value !== "string" || !VALUE.test(value))
					return { kind: "refused" };
			}
			if (!readClient()) return { kind: "no_client" };
			for (const [key, value] of client) query.set(key, value);
			for (const [key, value] of Object.entries(params || {})) query.set(key, value);
			const url = path + "?" + query.toString();
			const order = confirmed
				? [preferred]
				: [preferred, preferred === "fetch" ? "xhr" : "fetch"];
			let last = null;
			for (const transport of order) {
				const raw = await send(transport, url, timeoutMs);
				if (!raw) {
					last = { kind: "network_error", transport };
					continue;
				}
				let json = null;
				try {
					json = JSON.parse(raw.text);
				} catch {}
				const empty = raw.text.trim() === "";
				last = {
					kind: "response",
					status: raw.status,
					html: /html/i.test(raw.type),
					empty,
					json,
					signed: raw.signed,
					transport,
					retryAfterSeconds:
						raw.retryAfter !== null && Number.isFinite(Number(raw.retryAfter))
							? Number(raw.retryAfter)
							: null,
				};
				// TikTok answers an unsigned request with 200 and an empty body:
				// try the other transport once before giving up.
				if (raw.status === 200 && empty && !raw.signed && !confirmed) continue;
				if (json !== null && typeof json === "object") {
					preferred = transport;
					confirmed = true;
				}
				return last;
			}
			return last;
		};
		const session = Object.freeze({
			status: () => ({ client: readClient(), transport: confirmed ? preferred : null }),
			get,
		});
		Object.defineProperty(globalThis, KEY, {
			value: session,
			enumerable: false,
			configurable: true,
		});
		return session;
	};
`;

/**
 * Install the reader (once per document) and report whether it holds the web
 * app's client parameters yet. Returns `{ client, transport }`, or
 * `{ wrongPage: true }` off www.tiktok.com; never a parameter value.
 */
export const WATCH_EXPRESSION = `(() => {
	${PAGE_HELPERS}
	if (location.origin !== ORIGIN) return { wrongPage: true };
	return install().status();
})()`;

/** What `apiGetExpression` resolves to. It carries no parameter, token or signature. */
export type PageApiResult =
	| { kind: "no_client" }
	| { kind: "no_session" }
	| { kind: "refused" }
	| { kind: "wrong_origin" }
	| { kind: "network_error"; transport: string }
	| {
			kind: "response";
			status: number;
			html: boolean;
			empty: boolean;
			json: unknown;
			signed: boolean;
			transport: string;
			retryAfterSeconds: number | null;
	  };

/** GET one allowed path from the page, signed by the page's own scripts. */
export function apiGetExpression(
	path: AllowedPath,
	params: Readonly<Record<string, string>>,
	timeoutMs: number,
): string {
	return `(async () => {
	${PAGE_HELPERS}
	if (location.origin !== ORIGIN) return { kind: "wrong_origin" };
	const session = install();
	if (!session) return { kind: "no_session" };
	return session.get(${JSON.stringify(path)}, ${JSON.stringify(params)}, ${JSON.stringify(timeoutMs)});
})()`;
}
