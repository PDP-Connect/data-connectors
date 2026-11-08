// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-page capture of a site's own network exchanges.
 *
 * Some connectors must read the requests and responses a site's own app
 * sends (page-minted request bodies, continuation pages). Desktop Playwright
 * has `page.on("response")`; the Mobile host (PageShim) has no network
 * events. This module gives both one small, pull-based interface:
 *
 *   const capture = await createPageExchangeCapture(page, { name, rules });
 *   await page.goto(url);
 *   await capture.attach();          // after every navigation
 *   const drained = await capture.drain();
 *
 * The page-side script wraps `fetch` and `XMLHttpRequest` in the page's own
 * realm. It changes no request and constructs none. It keeps only the
 * exchanges that match a rule, in arrival order (the order responses
 * completed), each with its URL, method, request body, the request headers
 * the rule names, status and response text. The buffer is bounded: when it is
 * full, new exchanges are dropped and counted, never evicted, and the drain
 * reports `overflowed`.
 *
 * Install modes (the connector does not choose; `mode` reports which ran):
 *   - "init_script": the host offers `page.addInitScript(source)` (Playwright,
 *     and PageShim hosts with the `page_init_script` feature). The script then
 *     runs at the start of every later document, before the site's scripts,
 *     so first-load traffic is seen.
 *   - "evaluate": `attach()` installs the script with `page.evaluate` after the
 *     document loaded. Requests sent before that are not seen. This is also
 *     the mode when `addInitScript` is absent or rejects: a Mobile host
 *     always has the member, but some Android WebViews cannot run scripts at
 *     document start, and there the call rejects.
 *
 * The init script is one self-contained arrow-function call. It shares state
 * only through an explicit `window` property, so it behaves the same when the
 * Mobile host wraps it in a block (where a top-level `let`, `const` or
 * `class` would stay local), and its brackets, strings and comments balance,
 * which that host requires. It runs only in the main frame, and on Mobile
 * only on the row's cookieDomain host and its subdomains: a page off that
 * host is captured from `attach()` on, as in "evaluate" mode.
 * Each drain reports `earlyTrafficMissed` for the current document: true when
 * the script was installed after the document started.
 *
 * Every document gets its own page-side state with a random id. The
 * connector side numbers documents in the order it meets them
 * (`generation`), so an exchange from a replaced document can be told apart,
 * and a drain that meets an unexpected document reports `documentReplaced`.
 * Exchanges a replaced document had not handed over are lost with it.
 *
 * Scripts are complete expressions in strings (CONNECTOR-GUIDELINES rule 4):
 * the PageShim bundler can rewrite function bodies to call helpers the page
 * does not have.
 */

/** One rule. An exchange is kept when its URL, method and body match. */
export interface ExchangeRule {
	/** Tested against the absolute request URL. Must not use the g or y flag. */
	readonly url: RegExp;
	/** Upper-case method. Any method matches when absent. */
	readonly method?: string;
	/**
	 * Tested against the request body text (for example an operation name).
	 * When the body cannot be read, the exchange is kept with
	 * `ruleCertain: false` so the connector can see the gap.
	 */
	readonly body?: RegExp;
	/** Request header names to keep, lower case. No other header is read. */
	readonly requestHeaders?: readonly string[];
	/** Keep the response text. Default true. */
	readonly responseBody?: boolean;
}

export interface PageExchangeCaptureOptions {
	/** Distinguishes captures in one page. Letters, digits, `_` and `-`. */
	readonly name: string;
	readonly rules: readonly ExchangeRule[];
	/** Exchanges buffered in one document before new ones are dropped. */
	readonly maxBuffered?: number;
	/** Characters buffered in one document before new exchanges are dropped. */
	readonly maxBufferedChars?: number;
	/** Longest response text kept; a longer one is reported as too_large. */
	readonly maxResponseChars?: number;
	/** Longest request body kept; a longer one is reported as too_large. */
	readonly maxRequestChars?: number;
}

/** Why a body is missing. */
export type BodyGap =
	| "too_large"
	| "unreadable"
	| "stream"
	| "form_file_omitted"
	| "document"
	| "unsupported"
	| "not_kept"
	| "network_error"
	| "opaque";

export interface CapturedExchange {
	/** Capture-wide, increasing in arrival order across documents. */
	readonly seq: number;
	/** The document the exchange came from, numbered from 1 in the order met. */
	readonly generation: number;
	/** Index of the rule that matched. */
	readonly rule: number;
	/** False when the rule tests the body and the body could not be read. */
	readonly ruleCertain: boolean;
	readonly transport: "fetch" | "xhr";
	readonly url: string;
	readonly method: string;
	/**
	 * The request body as text: strings as sent, URLSearchParams and the
	 * string fields of FormData as `a=b&c=d`, Blob and binary bodies decoded
	 * as UTF-8. Null when there is no body or it could not be read.
	 */
	readonly requestBody: string | null;
	/** Why `requestBody` is null or partial; null when nothing is missing. */
	readonly requestBodyGap: BodyGap | null;
	readonly requestHeaders: Readonly<Record<string, string>>;
	/** HTTP status; 0 when the request failed or was aborted. */
	readonly status: number;
	/** The response text, or null (see `responseGap`). */
	readonly responseText: string | null;
	readonly responseGap: BodyGap | null;
}

export interface ExchangeDrain {
	readonly exchanges: readonly CapturedExchange[];
	/** The current document's generation; 0 when it has no capture. */
	readonly generation: number;
	/** The current document's URL. */
	readonly documentUrl: string;
	/** The current document's capture was installed after it started. */
	readonly earlyTrafficMissed: boolean;
	/** A document dropped exchanges because its buffer was full. Sticky. */
	readonly overflowed: boolean;
	/**
	 * The current document is not the one last attached or drained. The
	 * exchanges the earlier document had not handed over are lost.
	 */
	readonly documentReplaced: boolean;
}

export interface AttachResult {
	readonly generation: number;
	readonly earlyTrafficMissed: boolean;
}

export interface PageExchangeCapture {
	readonly mode: "init_script" | "evaluate";
	/**
	 * Make sure the current document is captured. Call after each
	 * navigation. Returns null when the page refused the script (for example
	 * while it is still loading); call again.
	 */
	attach(): Promise<AttachResult | null>;
	/** Take every buffered exchange of the current document, in arrival order. */
	drain(): Promise<ExchangeDrain>;
}

/** The page methods this module calls. */
export interface ExchangeCapturePage {
	evaluate(script: string): Promise<unknown>;
	addInitScript?: unknown;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_KEY_PREFIX = "__pdppExchangeCapture_";
/** Bump when the page-side state shape changes. */
const VERSION = 1;
const DEFAULTS = {
	maxBuffered: 64,
	maxBufferedChars: 32_000_000,
	maxResponseChars: 8_000_000,
	maxRequestChars: 256_000,
} as const;
/** Characters one drain call returns before it stops (one entry always goes). */
const DRAIN_BUDGET_CHARS = 1_000_000;

interface PageRule {
	url: { source: string; flags: string };
	method: string | null;
	body: { source: string; flags: string } | null;
	requestHeaders: string[];
	responseBody: boolean;
}

function pageRegExp(
	pattern: RegExp,
	what: string,
): { source: string; flags: string } {
	if (!(pattern instanceof RegExp))
		throw new TypeError(`${what} must be a RegExp`);
	if (/[gy]/.test(pattern.flags))
		throw new TypeError(`${what} must not use the g or y flag`);
	return { source: pattern.source, flags: pattern.flags };
}

function pageRules(rules: readonly ExchangeRule[]): PageRule[] {
	if (rules.length === 0)
		throw new TypeError("page exchange capture needs at least one rule");
	return rules.map((rule, index) => ({
		url: pageRegExp(rule.url, `rule ${index} url`),
		method: rule.method ? rule.method.toUpperCase() : null,
		body: rule.body ? pageRegExp(rule.body, `rule ${index} body`) : null,
		requestHeaders: (rule.requestHeaders ?? []).map((header) =>
			header.toLowerCase(),
		),
		responseBody: rule.responseBody !== false,
	}));
}

function pageKey(name: string): string {
	if (!NAME.test(name))
		throw new TypeError(
			"page exchange capture name must match [A-Za-z0-9_-]{1,64}",
		);
	return PAGE_KEY_PREFIX + name;
}

/**
 * The page-side install script. `via` records how it was installed:
 * "init" (at document start) or "evaluate" (after load). Installing twice in
 * one document returns the state already there.
 */
export function exchangeCaptureInstallScript(
	options: PageExchangeCaptureOptions,
	via: "init" | "evaluate",
): string {
	const config = {
		key: pageKey(options.name),
		version: VERSION,
		via,
		rules: pageRules(options.rules),
		maxBuffered: options.maxBuffered ?? DEFAULTS.maxBuffered,
		maxBufferedChars: options.maxBufferedChars ?? DEFAULTS.maxBufferedChars,
		maxResponseChars: options.maxResponseChars ?? DEFAULTS.maxResponseChars,
		maxRequestChars: options.maxRequestChars ?? DEFAULTS.maxRequestChars,
	};
	return `(() => {
 const config = ${JSON.stringify(config)};
 // The main frame only: an init script also runs in child frames on some hosts.
 try { if (window !== window.top) return null; } catch (error) { return null; }
 const existing = window[config.key];
 if (existing && existing.version === config.version) return { id: existing.id, via: existing.via, installed: false };
 const rules = config.rules.map((rule) => ({
  url: new RegExp(rule.url.source, rule.url.flags),
  method: rule.method,
  body: rule.body ? new RegExp(rule.body.source, rule.body.flags) : null,
  headers: rule.requestHeaders,
  keepResponse: rule.responseBody,
 }));
 const state = {
  version: config.version,
  id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10),
  via: config.via,
  seq: 0, buffer: [], bufferedChars: 0, dropped: 0,
 };
 try {
  Object.defineProperty(window, config.key, { value: state, configurable: true, enumerable: false, writable: true });
 } catch (error) {
  window[config.key] = state;
 }
 const absolute = (raw) => {
  try { return new URL(String(raw), location.href).href; } catch (error) { return null; }
 };
 const candidatesFor = (method, url) => {
  const found = [];
  if (url === null) return found;
  for (let index = 0; index < rules.length; index += 1) {
   const rule = rules[index];
   if (rule.method !== null && rule.method !== method) continue;
   if (rule.url.test(url)) found.push(index);
  }
  return found;
 };
 const bounded = (text, max) => text.length > max ? { text: null, gap: "too_large" } : { text, gap: null };
 const decode = (bytes) => new TextDecoder().decode(bytes);
 // Resolves to { text, gap }; never rejects.
 const readRequestBody = (body) => {
  try {
   if (body === undefined || body === null) return Promise.resolve({ text: null, gap: null });
   if (typeof body === "string") return Promise.resolve(bounded(body, config.maxRequestChars));
   if (typeof URLSearchParams === "function" && body instanceof URLSearchParams)
    return Promise.resolve(bounded(body.toString(), config.maxRequestChars));
   if (typeof FormData === "function" && body instanceof FormData) {
    const params = new URLSearchParams();
    let omitted = false;
    for (const [key, value] of body.entries()) {
     if (typeof value === "string") params.append(key, value);
     else omitted = true;
    }
    const read = bounded(params.toString(), config.maxRequestChars);
    return Promise.resolve(read.text !== null && omitted ? { text: read.text, gap: "form_file_omitted" } : read);
   }
   if (typeof Blob === "function" && body instanceof Blob) {
    if (body.size > config.maxRequestChars * 4) return Promise.resolve({ text: null, gap: "too_large" });
    return body.text().then((text) => bounded(text, config.maxRequestChars), () => ({ text: null, gap: "unreadable" }));
   }
   if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return Promise.resolve(bounded(decode(body), config.maxRequestChars));
   if (typeof ReadableStream === "function" && body instanceof ReadableStream)
    return Promise.resolve({ text: null, gap: "stream" });
   if (typeof Document === "function" && body instanceof Document)
    return Promise.resolve({ text: null, gap: "document" });
   return Promise.resolve({ text: null, gap: "unsupported" });
  } catch (error) {
   return Promise.resolve({ text: null, gap: "unreadable" });
  }
 };
 const wantedHeaders = (candidates) => {
  const names = new Set();
  for (const index of candidates) for (const name of rules[index].headers) names.add(name);
  return names;
 };
 const keepsResponse = (candidates) => candidates.some((index) => rules[index].keepResponse);
 // The first rule that matches for certain wins; a rule whose body test
 // could not run matches only when no rule matches for certain.
 const choose = (candidates, bodyText) => {
  let uncertain = -1;
  for (const index of candidates) {
   const rule = rules[index];
   if (rule.body === null) return { rule: index, certain: true };
   if (bodyText === null) { if (uncertain < 0) uncertain = index; continue; }
   if (rule.body.test(bodyText)) return { rule: index, certain: true };
  }
  return uncertain >= 0 ? { rule: uncertain, certain: false } : null;
 };
 const record = (request, bodyRead, response) => {
  try {
   const chosen = choose(request.candidates, bodyRead.text);
   if (!chosen) return;
   const keep = rules[chosen.rule].keepResponse;
   const responseText = keep ? response.text : null;
   const responseGap = keep ? response.gap : "not_kept";
   const headers = {};
   for (const name of rules[chosen.rule].headers)
    if (Object.prototype.hasOwnProperty.call(request.headers, name)) headers[name] = request.headers[name];
   state.seq += 1;
   const size = request.url.length + (bodyRead.text ? bodyRead.text.length : 0) + (responseText ? responseText.length : 0) + 256;
   if (state.buffer.length >= config.maxBuffered || state.bufferedChars + size > config.maxBufferedChars) {
    state.dropped += 1;
    return;
   }
   state.bufferedChars += size;
   state.buffer.push({ size, entry: {
    seq: state.seq, rule: chosen.rule, ruleCertain: chosen.certain, transport: request.transport,
    url: request.url, method: request.method,
    requestBody: bodyRead.text, requestBodyGap: bodyRead.gap, requestHeaders: headers,
    status: response.status, responseText, responseGap,
   } });
  } catch (error) {}
 };
 const addHeaders = (into, names, source) => {
  try {
   if (!source || names.size === 0) return;
   const put = (name, value) => {
    const lower = String(name).toLowerCase();
    if (names.has(lower)) into[lower] = String(value);
   };
   if (typeof Headers === "function" && source instanceof Headers) source.forEach((value, name) => put(name, value));
   else if (Array.isArray(source)) { for (const pair of source) if (pair && pair.length === 2) put(pair[0], pair[1]); }
   else if (typeof source === "object") for (const name of Object.keys(source)) put(name, source[name]);
  } catch (error) {}
 };

 // XMLHttpRequest: open records the method and URL, setRequestHeader the
 // named headers, send the body; the response is read at loadend.
 const xhrRequests = new WeakMap();
 const proto = XMLHttpRequest.prototype;
 const xhrOpen = proto.open;
 const xhrSend = proto.send;
 const xhrSetHeader = proto.setRequestHeader;
 proto.open = function (method, url) {
  try {
   const upper = String(method || "GET").toUpperCase();
   const href = absolute(url);
   const candidates = candidatesFor(upper, href);
   if (candidates.length > 0)
    xhrRequests.set(this, { transport: "xhr", method: upper, url: href, candidates, headers: {}, names: wantedHeaders(candidates) });
   else xhrRequests.delete(this);
  } catch (error) {}
  return xhrOpen.apply(this, arguments);
 };
 proto.setRequestHeader = function (name, value) {
  try {
   const request = xhrRequests.get(this);
   if (request) addHeaders(request.headers, request.names, [[name, value]]);
  } catch (error) {}
  return xhrSetHeader.apply(this, arguments);
 };
 proto.send = function (body) {
  try {
   const request = xhrRequests.get(this);
   if (request) {
    const xhr = this;
    const bodyRead = readRequestBody(body);
    xhr.addEventListener("loadend", () => {
     let response;
     try {
      const status = Number(xhr.status) || 0;
      if (status === 0) response = Promise.resolve({ status, text: null, gap: "network_error" });
      else if (!keepsResponse(request.candidates)) response = Promise.resolve({ status, text: null, gap: "not_kept" });
      else if (xhr.responseType === "" || xhr.responseType === "text")
       response = Promise.resolve({ status, ...bounded(String(xhr.responseText), config.maxResponseChars) });
      else if (xhr.responseType === "json")
       response = Promise.resolve(xhr.response === null ? { status, text: null, gap: "unreadable" }
        : { status, ...bounded(JSON.stringify(xhr.response), config.maxResponseChars) });
      else if (xhr.responseType === "arraybuffer")
       response = Promise.resolve(xhr.response ? { status, ...bounded(decode(xhr.response), config.maxResponseChars) }
        : { status, text: null, gap: "unreadable" });
      else if (xhr.responseType === "blob" && xhr.response)
       response = xhr.response.text().then((text) => ({ status, ...bounded(text, config.maxResponseChars) }),
        () => ({ status, text: null, gap: "unreadable" }));
      else if (xhr.responseType === "document") response = Promise.resolve({ status, text: null, gap: "document" });
      else response = Promise.resolve({ status, text: null, gap: "unreadable" });
     } catch (error) {
      response = Promise.resolve({ status: 0, text: null, gap: "unreadable" });
     }
     Promise.all([bodyRead, response]).then(([read, result]) => record(request, read, result), () => {});
    });
   }
  } catch (error) {}
  return xhrSend.apply(this, arguments);
 };

 // fetch: the request is read before the native call; the response is
 // cloned in a handler registered before fetch returns, so it runs before
 // the app's own handler can consume the body.
 const nativeFetch = window.fetch;
 if (typeof nativeFetch === "function") {
  window.fetch = function (input, init) {
   let request = null;
   let bodyRead = null;
   try {
    const isRequest = typeof Request === "function" && input instanceof Request;
    const rawUrl = isRequest ? input.url : (input && typeof input === "object" && "href" in input ? input.href : input);
    const method = String((init && init.method) || (isRequest ? input.method : "GET")).toUpperCase();
    const href = absolute(rawUrl);
    const candidates = candidatesFor(method, href);
    if (candidates.length > 0) {
     const names = wantedHeaders(candidates);
     const headers = {};
     if (isRequest) addHeaders(headers, names, input.headers);
     if (init && init.headers) addHeaders(headers, names, init.headers);
     request = { transport: "fetch", method, url: href, candidates, headers };
     if (init && init.body !== undefined && init.body !== null) bodyRead = readRequestBody(init.body);
     else if (isRequest && method !== "GET" && method !== "HEAD")
      bodyRead = input.clone().text().then((text) => bounded(text, config.maxRequestChars), () => ({ text: null, gap: "unreadable" }));
     else bodyRead = Promise.resolve({ text: null, gap: null });
    }
   } catch (error) {
    request = null;
   }
   const promise = nativeFetch.apply(this, arguments);
   if (request) {
    try {
     const keep = keepsResponse(request.candidates);
     const response = promise.then((res) => {
      const status = Number(res.status) || 0;
      if (res.type === "opaque" || res.type === "opaqueredirect") return { status, text: null, gap: "opaque" };
      if (!keep) return { status, text: null, gap: "not_kept" };
      try {
       return res.clone().text().then((text) => ({ status, ...bounded(text, config.maxResponseChars) }),
        () => ({ status, text: null, gap: "unreadable" }));
      } catch (error) {
       return { status, text: null, gap: "unreadable" };
      }
     }, () => ({ status: 0, text: null, gap: "network_error" }));
     Promise.all([bodyRead, response]).then(([read, result]) => record(request, read, result), () => {});
    } catch (error) {}
   }
   return promise;
  };
 }
 return { id: state.id, via: state.via, installed: true };
})()`;
}

/** Take buffered exchanges, up to a character budget; at least one goes. */
export function exchangeCaptureDrainScript(name: string): string {
	return `(() => {
 const state = window[${JSON.stringify(pageKey(name))}];
 if (!state || state.version !== ${VERSION}) return { id: null, via: null, url: location.href, entries: [], remaining: 0, dropped: 0 };
 const entries = [];
 let size = 0;
 while (state.buffer.length > 0) {
  const next = state.buffer[0];
  if (entries.length > 0 && size + next.size > ${DRAIN_BUDGET_CHARS}) break;
  state.buffer.shift();
  state.bufferedChars -= next.size;
  size += next.size;
  entries.push(next.entry);
 }
 return { id: state.id, via: state.via, url: location.href, entries, remaining: state.buffer.length, dropped: state.dropped };
})()`;
}

interface PageEntry {
	seq: number;
	rule: number;
	ruleCertain: boolean;
	transport: "fetch" | "xhr";
	url: string;
	method: string;
	requestBody: string | null;
	requestBodyGap: BodyGap | null;
	requestHeaders: Record<string, string>;
	status: number;
	responseText: string | null;
	responseGap: BodyGap | null;
}

export interface PageDrain {
	id: string | null;
	via: "init" | "evaluate" | null;
	url: string;
	entries: PageEntry[];
	remaining: number;
	dropped: number;
}

const GAPS: ReadonlySet<string> = new Set<BodyGap>([
	"too_large",
	"unreadable",
	"stream",
	"form_file_omitted",
	"document",
	"unsupported",
	"not_kept",
	"network_error",
	"opaque",
]);
const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isGap = (value: unknown): value is BodyGap | null =>
	value === null || (typeof value === "string" && GAPS.has(value));
const isTextOrNull = (value: unknown): value is string | null =>
	value === null || typeof value === "string";

function parseEntry(raw: unknown, rules: number): PageEntry | null {
	if (!isRecord(raw)) return null;
	const {
		seq,
		rule,
		ruleCertain,
		transport,
		url,
		method,
		requestBody,
		requestBodyGap,
		requestHeaders,
		status,
		responseText,
		responseGap,
	} = raw;
	if (
		!isCount(seq) ||
		seq === 0 ||
		!isCount(rule) ||
		rule >= rules ||
		typeof ruleCertain !== "boolean" ||
		(transport !== "fetch" && transport !== "xhr") ||
		typeof url !== "string" ||
		typeof method !== "string" ||
		!isTextOrNull(requestBody) ||
		!isGap(requestBodyGap) ||
		!isRecord(requestHeaders) ||
		!isCount(status) ||
		!isTextOrNull(responseText) ||
		!isGap(responseGap)
	)
		return null;
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(requestHeaders)) {
		if (typeof value !== "string") return null;
		headers[name] = value;
	}
	return {
		seq,
		rule,
		ruleCertain,
		transport,
		url,
		method,
		requestBody,
		requestBodyGap,
		requestHeaders: headers,
		status,
		responseText,
		responseGap,
	};
}

/** Accept a drain result only in the exact shape the drain script returns. */
export function parseExchangeDrain(
	value: unknown,
	rules: number,
): PageDrain | null {
	if (!isRecord(value)) return null;
	const { id, via, url, entries, remaining, dropped } = value;
	if (
		!isTextOrNull(id) ||
		(via !== null && via !== "init" && via !== "evaluate") ||
		(id === null) !== (via === null) ||
		typeof url !== "string" ||
		!Array.isArray(entries) ||
		!isCount(remaining) ||
		!isCount(dropped)
	)
		return null;
	const parsed: PageEntry[] = [];
	let lastSeq = 0;
	for (const raw of entries) {
		const entry = parseEntry(raw, rules);
		if (!entry || entry.seq <= lastSeq) return null;
		lastSeq = entry.seq;
		parsed.push(entry);
	}
	return { id, via, url, entries: parsed, remaining, dropped };
}

/**
 * Whether the host offers `page.addInitScript`. Reading an absent member of a
 * strict host page can throw; that counts as absent.
 */
export function pageOffersInitScript(page: ExchangeCapturePage): boolean {
	try {
		return typeof page.addInitScript === "function";
	} catch {
		return false;
	}
}

/**
 * Create a capture for `page`. With an init-script host this registers the
 * script for every later document; call `attach()` after each navigation in
 * either mode.
 */
export async function createPageExchangeCapture(
	page: ExchangeCapturePage,
	options: PageExchangeCaptureOptions,
): Promise<PageExchangeCapture> {
	const ruleCount = pageRules(options.rules).length;
	const lateScript = exchangeCaptureInstallScript(options, "evaluate");
	const drainScript = exchangeCaptureDrainScript(options.name);
	let mode: PageExchangeCapture["mode"] = "evaluate";
	if (pageOffersInitScript(page)) {
		try {
			const addInitScript = page.addInitScript as (
				source: string,
			) => Promise<unknown>;
			await addInitScript.call(
				page,
				exchangeCaptureInstallScript(options, "init"),
			);
			mode = "init_script";
		} catch {
			mode = "evaluate";
		}
	}
	const generations = new Map<string, number>();
	let current: string | null = null;
	let seq = 0;
	let overflowed = false;
	const generationOf = (id: string): number => {
		let generation = generations.get(id);
		if (generation === undefined) {
			generation = generations.size + 1;
			generations.set(id, generation);
		}
		return generation;
	};
	return {
		mode,
		attach: async () => {
			let installed: unknown;
			try {
				installed = await page.evaluate(lateScript);
			} catch {
				return null;
			}
			if (
				!isRecord(installed) ||
				typeof installed.id !== "string" ||
				(installed.via !== "init" && installed.via !== "evaluate")
			)
				return null;
			current = installed.id;
			return {
				generation: generationOf(installed.id),
				earlyTrafficMissed: installed.via === "evaluate",
			};
		},
		drain: async () => {
			const exchanges: CapturedExchange[] = [];
			let drained: PageDrain | null = null;
			let documentReplaced = false;
			// Bounded: a buffer holds at most maxBuffered entries and every call
			// takes at least one, so this ends unless the page keeps adding.
			const maxCalls = (options.maxBuffered ?? DEFAULTS.maxBuffered) + 2;
			for (let call = 0; call < maxCalls; call += 1) {
				drained = parseExchangeDrain(
					await page.evaluate(drainScript),
					ruleCount,
				);
				if (!drained)
					throw new Error(
						"page_exchange_capture_unreadable: the capture's drain had an unexpected shape",
					);
				if (drained.id !== current) documentReplaced ||= current !== null;
				if (drained.id === null) break;
				current = drained.id;
				const generation = generationOf(drained.id);
				if (drained.dropped > 0) overflowed = true;
				for (const entry of drained.entries) {
					seq += 1;
					exchanges.push({ ...entry, seq, generation });
				}
				if (drained.remaining === 0) break;
			}
			const id = drained?.id ?? null;
			return {
				exchanges,
				generation: id === null ? 0 : generationOf(id),
				documentUrl: drained?.url ?? "",
				earlyTrafficMissed: drained?.via !== "init",
				overflowed,
				documentReplaced,
			};
		},
	};
}

/** The response text parsed as JSON, or undefined when absent or not JSON. */
export function exchangeJson(
	exchange: Pick<CapturedExchange, "responseText">,
): unknown {
	if (exchange.responseText === null) return undefined;
	try {
		return JSON.parse(exchange.responseText) as unknown;
	} catch {
		return undefined;
	}
}
