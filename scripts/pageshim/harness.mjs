// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs a pageshim bundle the way the mobile host does, in Playwright Chromium.
//
// Model: vana-com/unity-surfaces apps/mobile-shell/lib/connect/page_shim.dart.
//   - RUNNER page: executes the bundle as `new AsyncFunction('page', 'process', 'initialState', code)`
//     after the host's transform (the last top-level `(async () => {` is returned).
//   - TARGET page: the provider WebView. Its traffic is served from fixtures.
//   - `page`: the shim's method set and nothing else. Reading any other member
//     throws, so a bundle that needs more than the host offers fails here.
//     Host behaviour kept from page_shim.dart: evaluate turns a page error
//     into null; goto waits after the load starts; setData("result") crosses
//     as one JSON string; waitForSelector throws on timeout; promptUser polls
//     the check and throws when the login wait runs out.
//   - captureDownload / extractZipEntries: see exportArchive() below.
//
// This is a re-implementation from the Dart source, not a vendored copy. It
// is not a device run.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { chromium } from "playwright";
import { ResultStreamHarness } from "./result-stream-harness.mjs";

const PAGE_BRIDGE_MAX_UNITS = 256 * 1024;

function jsonPayloadUnits(value) {
	if (value === null) return 4;
	if (typeof value === "string") {
		let units = value.length + 2;
		for (let index = 0; index < value.length; index++) {
			const code = value.charCodeAt(index);
			if (code === 0x22 || code === 0x5c) units++;
			else if (code < 0x20) units += 5;
		}
		return units;
	}
	if (typeof value === "number") return String(value).length;
	if (typeof value === "boolean") return value ? 4 : 5;
	if (Array.isArray(value))
		return (
			2 +
			value.reduce((sum, item) => sum + jsonPayloadUnits(item), 0) +
			Math.max(0, value.length - 1)
		);
	if (typeof value === "object") {
		const entries = Object.entries(value);
		return (
			2 +
			entries.reduce(
				(sum, [key, item]) =>
					sum + jsonPayloadUnits(key) + 1 + jsonPayloadUnits(item),
				0,
			) +
			Math.max(0, entries.length - 1)
		);
	}
	return 0;
}

// page_shim.dart harnessJs `page` members. Nothing else is exposed.
export const SHIM_METHODS = [
	"requestedScopes",
	"evaluate",
	"goto",
	"sleep",
	"setData",
	"setProgress",
	"showBrowser",
	"goHeadless",
	"closeBrowser",
	"httpFetch",
	"url",
	"html",
	"click",
	"fill",
	"press",
	"waitForSelector",
	"captureNetwork",
	"clearNetworkCaptures",
	"getCapturedResponse",
	"hasCapturedResponse",
	"captureDownload",
	"extractZipEntries",
	"readZipEntryChunk",
	"promptUser",
];

// Runs inside the RUNNER page. Builds the shim `page`, runs the bundle.
async function hostMain({
	source,
	scopes,
	initialState,
	supportsStateArgument,
	methods,
	loginWaitMs,
	env,
	timerScale,
	clockNowMs,
}) {
	window.__pageshimEnv = env || {};
	if (Number.isFinite(clockNowMs)) Date.now = () => clockNowMs;
	if (timerScale !== 1) {
		const nativeSetTimeout = window.setTimeout.bind(window);
		window.setTimeout = (callback, delay, ...args) =>
			nativeSetTimeout(
				callback,
				Math.max(0, Number(delay) * timerScale),
				...args,
			);
	}
	const call = async (m, a) => {
		const r = await window.__pageApi(m, a || []);
		if (r && typeof r === "object" && typeof r.__shimError === "string")
			throw new Error(r.__shimError);
		return r;
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const captured = new Set();
	const impl = {
		requestedScopes: () => scopes,
		evaluate: (code) => call("evaluate", [String(code)]),
		goto: (url) => call("goto", [url]),
		sleep,
		setData: (k, v) =>
			call("setData", [k, k === "result" ? JSON.stringify(v) : v]),
		setProgress: (p) => call("setProgress", [p]),
		showBrowser: (url) => call("showBrowser", [url || null]),
		goHeadless: () => call("goHeadless", []),
		closeBrowser: () => call("closeBrowser", []),
		httpFetch: (url, opts) => call("httpFetch", [url, opts || null]),
		url: () => call("url", []),
		html: () => call("evaluate", ["document.documentElement.outerHTML"]),
		click: (s) => call("click", [String(s)]),
		fill: (s, v) => call("fill", [String(s), String(v)]),
		press: (s, k) => call("press", [String(s), String(k)]),
		waitForSelector: async (selector, options) => {
			const timeout = options?.timeout ?? 30000;
			const state = options?.state || "visible";
			const started = Date.now();
			for (;;) {
				if (await call("selectorState", [String(selector), state])) return;
				if (Date.now() - started >= timeout)
					throw new Error(
						`waitForSelector timed out after ${timeout}ms: ${selector}`,
					);
				await sleep(200);
			}
		},
		captureNetwork: (c) => call("captureNetwork", [c || {}]),
		clearNetworkCaptures: async () => {
			captured.clear();
			return call("clearNetworkCaptures", []);
		},
		getCapturedResponse: (k) => call("getCapturedResponse", [String(k)]),
		hasCapturedResponse: (k) => captured.has(String(k)),
		captureDownload: (u, o) => call("captureDownload", [String(u), o || null]),
		extractZipEntries: async (h, o) => {
			const r = await call("extractZipEntries", [
				h == null ? null : String(h),
				o || null,
			]);
			if (r?.ok !== true)
				return r || { ok: false, error: "extractZipEntries returned nothing" };
			return { ok: true, handle: r.handle, names: r.names, entries: r.entries };
		},
		readZipEntryChunk: (h, name, offset, length) =>
			call("readZipEntryChunk", [
				h == null ? null : String(h),
				String(name),
				offset,
				length,
			]),
		promptUser: async (msg, check, interval) => {
			await call("setData", ["status", msg]);
			await call("promptUser", []);
			const started = Date.now();
			while (Date.now() - started < loginWaitMs) {
				let ok = false;
				try {
					ok = await check();
				} catch {}
				if (ok) {
					await call("phase", ["login-detected"]);
					return true;
				}
				await sleep(interval || 2000);
			}
			await call("phase", ["login-timed-out"]);
			throw new Error("login wait timed out");
		},
	};
	if (Object.keys(impl).join() !== methods.join())
		throw new Error("harness shim drifted from SHIM_METHODS");
	const page = new Proxy(impl, {
		get(t, k) {
			if (typeof k === "symbol" || k === "then") return undefined;
			if (!Object.hasOwn(t, k))
				throw new Error(`page.${k} is not part of the PageShim API`);
			return t[k];
		},
	});

	const re = /(?:^|\n)\(async\s*\(\)\s*=>\s*\{/g;
	const matches = [...source.matchAll(re)];
	if (matches.length === 0)
		return { ok: false, error: "no IIFE found in connector source" };
	const last = matches.at(-1);
	const lead = last[0].charAt(0) === "\n" ? "\n" : "";
	const code = `${source.slice(0, last.index)}${lead}return (async () => {${source.slice(last.index + last[0].length)}`;
	try {
		const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
		const runArgs = [
			page,
			Object.freeze({ env: Object.freeze({ ...(env || {}) }) }),
		];
		if (supportsStateArgument) runArgs.push(initialState);
		const parameters = supportsStateArgument
			? ["page", "process", "initialState"]
			: ["page", "process"];
		await new AsyncFunction(...parameters, code)(...runArgs);
		const testMetrics = window.__pageshimTestMetrics;
		return testMetrics ? { ok: true, testMetrics } : { ok: true };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/** The .json entries of a ZIP, as page_shim.dart's readZipJsonEntries
 * returns them: every central-directory name, and the selected entries as
 * one JSON text. `include` is a list of substrings. Stored and deflate only;
 * an entry that does not parse is skipped; one that does not inflate fails
 * the archive. */
function readZipJsonEntries(bytes, include) {
	let eocd = -1;
	for (
		let i = bytes.length - 22;
		i >= Math.max(0, bytes.length - 22 - 0xffff);
		i--
	)
		if (bytes.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return { ok: false, error: "not a zip (no EOCD)" };
	const count = bytes.readUInt16LE(eocd + 10);
	let off = bytes.readUInt32LE(eocd + 16);
	const names = [];
	const entries = [];
	const entryTexts = new Map();
	let rawBytes = 0;
	let selectedRawBytes = 0;
	for (let n = 0; n < count; n++) {
		if (bytes.readUInt32LE(off) !== 0x02014b50) break;
		const method = bytes.readUInt16LE(off + 10);
		const compSize = bytes.readUInt32LE(off + 20);
		const rawSize = bytes.readUInt32LE(off + 24);
		const nameLen = bytes.readUInt16LE(off + 28);
		const extraLen = bytes.readUInt16LE(off + 30);
		const commentLen = bytes.readUInt16LE(off + 32);
		const local = bytes.readUInt32LE(off + 42);
		const name = bytes.toString("utf8", off + 46, off + 46 + nameLen);
		off += 46 + nameLen + extraLen + commentLen;
		names.push(name);
		if (!name.endsWith("/")) rawBytes += rawSize;
		if (name.endsWith("/") || !name.endsWith(".json")) continue;
		if (include && !include.some((needle) => name.includes(needle))) continue;
		if (method !== 0 && method !== 8) continue;
		selectedRawBytes += rawSize;
		const start =
			local +
			30 +
			bytes.readUInt16LE(local + 26) +
			bytes.readUInt16LE(local + 28);
		const raw = bytes.subarray(start, start + compSize);
		let text;
		try {
			text = (method === 0 ? raw : inflateRawSync(raw)).toString("utf8");
		} catch {
			// Dart fails the whole archive when an entry does not inflate.
			return { ok: false, error: "noinflate" };
		}
		try {
			JSON.parse(text);
			entries.push({ name, size: text.length });
			entryTexts.set(name, text);
		} catch {}
	}
	return {
		ok: true,
		handle: "run",
		names,
		entries,
		entryTexts,
		stats: {
			entries: names.length,
			rawBytes,
			selected: entries.length,
			selectedRawBytes,
		},
	};
}

/**
 * captureDownload + extractZipEntries, modelled on page_shim.dart
 * (_captureDownload, _mintSignedUrl, _fetchArchive, _extractZipEntries):
 *   - the URL must be /export/{org}/download/{nonce}, else a terminal error;
 *   - the signed URL is minted ONCE per run by a credentialed POST to
 *     /api/organizations/{org}/export_signed_url/{nonce} in the provider
 *     document; 401/403 and a "consumed" body are terminal; any other
 *     refusal is "not ready";
 *   - the archive is fetched outside the page (fixtures.resolve, no cookies);
 *     5xx or a 2xx that is not a ZIP is "not ready"; other non-2xx is terminal;
 *   - "not ready" returns {ok:false, ready:false}; a terminal outcome makes the
 *     call throw, and the host sets data.error.
 */
function exportArchive({ fixtures, evaluateInPage, data, log }) {
	let signedUrl = null;
	let minted = false;
	let stash = null;
	let extracted = null;
	const notReady = (why) => {
		log.push(`[capture] not ready: ${why}`);
		return { ok: false, ready: false, error: "export not ready" };
	};
	const terminal = (outcome) => {
		const message = `The Claude export could not be downloaded (${outcome}).`;
		log.push(`[capture] fail: ${outcome}`);
		data.error = message;
		return { __shimError: message };
	};
	return {
		get stats() {
			return extracted?.stats ?? null;
		},
		async captureDownload(url) {
			const m = /\/export\/([^/]+)\/download\/([^/?#]+)/.exec(url);
			if (!m) return terminal("badurl");
			if (!signedUrl) {
				if (minted) return terminal("consumed");
				const mint = await evaluateInPage(`(async () => {
					const r = await fetch("/api/organizations/" + ${JSON.stringify(encodeURIComponent(m[1]))} +
						"/export_signed_url/" + ${JSON.stringify(encodeURIComponent(m[2]))},
						{ method: "POST", credentials: "include",
						  headers: { "content-type": "application/json" }, body: "{}" });
					const body = await r.text();
					let j = null; try { j = JSON.parse(body); } catch {}
					return { status: r.status, ok: r.ok, body: body.slice(0, 4096),
					  url: j && (j.signed_url || j.signedUrl || j.url) };
				})()`);
				if (!mint) return notReady("bridge");
				if (mint.status === 401 || mint.status === 403) return terminal("auth");
				if (!mint.ok)
					return mint.body.toLowerCase().includes("consumed")
						? terminal("consumed")
						: notReady(`mint ${mint.status}`);
				minted = true;
				if (typeof mint.url !== "string" || !mint.url) return notReady("nourl");
				signedUrl = mint.url;
			}
			const res = fixtures.resolve(signedUrl);
			if (res.status >= 500) return notReady(`storage ${res.status}`);
			if (res.status < 200 || res.status >= 300) return terminal("httpfail");
			const bytes = Buffer.from(res.body);
			// Dart classifyArchive: empty is not ready; a "PK" prefix is a ZIP.
			if (bytes.length < 2 || bytes[0] !== 0x50 || bytes[1] !== 0x4b)
				return notReady("not a zip yet");
			stash = bytes;
			return {
				ok: true,
				ready: true,
				path: null,
				name: "claude-export.zip",
				size: bytes.length,
			};
		},
		extractZipEntries(options) {
			if (!stash)
				return { ok: false, error: "no captured download in this run" };
			const bytes = stash;
			stash = null;
			extracted = readZipJsonEntries(
				bytes,
				Array.isArray(options?.include) ? options.include.map(String) : null,
			);
			if (extracted.ok) {
				return {
					ok: true,
					handle: extracted.handle,
					names: extracted.names,
					entries: extracted.entries,
				};
			}
			return extracted;
		},
		readZipEntryChunk(handle, entryName, offset, length) {
			if (handle !== "run")
				return { ok: false, error: "zip entry is not available" };
			if (
				!Number.isInteger(offset) ||
				offset < 0 ||
				!Number.isInteger(length) ||
				length < 1 ||
				length > 120 * 1024
			)
				return {
					ok: false,
					error:
						"readZipEntryChunk requires a non-negative offset and length <= 122880",
				};
			const text = extracted?.entryTexts.get(entryName);
			if (text == null)
				return { ok: false, error: "zip entry is not available" };
			if (offset > text.length)
				return { ok: false, error: "readZipEntryChunk offset is invalid" };
			let end = Math.min(offset + length, text.length);
			if (end < text.length) {
				const next = text.charCodeAt(end);
				if (next >= 0xdc00 && next <= 0xdfff) end--;
			}
			return { ok: true, text: text.slice(offset, end) };
		},
	};
}

/**
 * @param {object} o
 * @param {string} o.bundle path to the built bundle
 * @param {{ hosts: RegExp, resolve: (url: string) => {status:number, contentType:string, body:string|Buffer}, setLoggedIn: (v: boolean) => void, loginUrl: string, homeUrl: string }} o.fixtures
 * @param {string[]} o.scopes
 * @param {Record<string, unknown>} [o.initialState] state committed by an earlier run
 * @param {boolean} [o.supportsStateArgument] model an older shell with a two-argument runner
 * @param {number} [o.timerScale] scale browser timers for bounded synthetic fixtures
 * @param {number} [o.stateAckDelayMs] delay STATE bridge acknowledgements
 * @param {boolean} [o.failResultWrite] fail the first successful result write
 * @param {number} [o.loginAfterMs] start signed out; the simulated user signs in after this delay (Infinity: never)
 * @param {number} [o.loginWaitMs] how long promptUser waits for the login check
 */
export async function runHarness({
	bundle,
	fixtures,
	scopes,
	initialState = {},
	supportsStateArgument = true,
	loginAfterMs = 0,
	gotoDelayMs = 2000,
	loginWaitMs = 120_000,
	env = {},
	resultStreaming = false,
	resultSpoolDirectory = join(
		process.cwd(),
		".scratch",
		`pageshim-result-${randomUUID()}`,
	),
	resultStreamFailure,
	timerScale = 1,
	stateAckDelayMs = 0,
	failResultWrite = false,
	resultStreamNeverAck = false,
	readBridgeLatencyMs = 0,
	clockNowMs,
}) {
	const source = readFileSync(bundle, "utf8");
	const log = [];
	const calls = {};
	const pageNavigations = [];
	const data = {};
	const states = { ...initialState };
	const stagedStates = {};
	const stateMessages = [];
	let failedResultWrite = false;
	let eventOrder = 0;
	let stateAckOrder = 0;
	let resultDoneAttemptOrder = 0;
	let resultWriteOrder = 0;
	let maxBridgePayloadUnits = 0;
	let bridgeCallCount = 0;
	let result = null;
	const streamHost = new ResultStreamHarness({
		approvedScopes: scopes,
		directory: resultSpoolDirectory,
		failAt: resultStreamFailure,
		streamingSupported: resultStreaming,
	});

	const browser = await chromium.launch({
		headless: true,
		args: ["--enable-precise-memory-info"],
	});
	try {
		const context = await browser.newContext();
		await context.route(fixtures.hosts, (route) => {
			const request = route.request();
			const f = fixtures.resolve(request.url(), {
				method: request.method(),
				postData: request.postData(),
			});
			return route.fulfill({
				...f,
				headers: { "access-control-allow-origin": "*" },
			});
		});
		const target = await context.newPage();
		await target.goto(fixtures.loginUrl);

		const evaluateInPage = async (code) => {
			const attempt = (body) =>
				target.evaluate(async (b) => {
					const AsyncFunction = Object.getPrototypeOf(
						async () => {},
					).constructor;
					try {
						return { ok: true, value: await new AsyncFunction(b)() };
					} catch (e) {
						return { ok: false, error: String(e?.message ?? e) };
					}
				}, body);
			try {
				const trimmed = code.trim();
				const r1 = await attempt(`return await (${trimmed});`);
				if (r1.ok) return r1.value ?? null;
				const r2 = await attempt(trimmed);
				if (r2.ok) return r2.value ?? null;
				log.push(`evaluate failed: ${r2.error}`);
			} catch (e) {
				log.push(`evaluate threw: ${e}`);
			}
			return null;
		};

		const archive = exportArchive({ fixtures, evaluateInPage, data, log });
		const dispatch = async (method, a) => {
			calls[method] = (calls[method] || 0) + 1;
			switch (method) {
				case "evaluate":
					return evaluateInPage(String(a[0] ?? ""));
				case "goto":
					pageNavigations.push(String(a[0]));
					if (a[0]) {
						await target
							.goto(a[0], { waitUntil: "commit" })
							.catch((e) => log.push(`goto error ${e.message}`));
						await new Promise((r) => setTimeout(r, gotoDelayMs));
					}
					return null;
				case "setData":
					if (String(a[0]).startsWith("result:")) {
						if (resultStreamNeverAck) return new Promise(() => {});
						if (a[0] === "result:done")
							resultDoneAttemptOrder = ++eventOrder;
						const ack = await streamHost.setData(a[0], a[1]);
						if (a[0] === "result:done") resultWriteOrder = resultDoneAttemptOrder;
						return ack;
					}
					if (a[0] === "result") {
						await streamHost.setData("result", a[1]);
						resultWriteOrder = ++eventOrder;
						const nextResult = a[1] == null ? null : JSON.parse(a[1]);
						if (
							failResultWrite &&
							!failedResultWrite &&
							Array.isArray(nextResult?.errors) &&
							!nextResult.errors.length
						) {
							failedResultWrite = true;
							return { __shimError: "synthetic result write failed" };
						}
						result = nextResult;
					} else if (a[0] === "STATE") {
						if (!scopes.includes(a[1]?.stream))
							return { __shimError: "invalid PDPP STATE message" };
						if (stateAckDelayMs > 0)
							await new Promise((resolve) =>
								setTimeout(resolve, stateAckDelayMs),
							);
						const message = JSON.parse(JSON.stringify(a[1]));
						stateAckOrder = ++eventOrder;
						stateMessages.push(message);
						stagedStates[message.stream] = message.cursor;
					} else data[a[0]] = a[1];
					return null;
				case "setProgress":
				case "phase":
				case "promptUser":
				case "log":
				case "goHeadless":
				case "closeBrowser":
					return null;
				case "showBrowser":
					return { headed: true };
				case "url":
					return target.url();
				case "captureDownload":
					return archive.captureDownload(String(a[0] ?? ""));
				case "extractZipEntries":
					return archive.extractZipEntries(a[1]);
				case "readZipEntryChunk":
					if (readBridgeLatencyMs > 0)
						await new Promise((resolve) =>
							setTimeout(resolve, readBridgeLatencyMs),
						);
					return archive.readZipEntryChunk(a[0], a[1], a[2], a[3]);
				case "httpFetch": {
					const r = await target.evaluate(
						async ({ url, opts }) => {
							try {
								const res = await fetch(url, {
									method: opts?.method || "GET",
									credentials: "include",
									headers: opts?.headers,
									body: opts?.body ? String(opts.body) : undefined,
								});
								const h = {};
								res.headers.forEach((v, k) => {
									h[k.toLowerCase()] = v;
								});
								return {
									status: res.status,
									text: await res.text(),
									headers: h,
									error: null,
								};
							} catch (e) {
								return {
									status: 0,
									text: "",
									headers: {},
									error: String(e?.message ?? e),
								};
							}
						},
						{ url: String(a[0]), opts: a[1] },
					);
					let json = null;
					try {
						json = JSON.parse(r.text);
					} catch {}
					return { ok: r.status >= 200 && r.status < 300, json, ...r };
				}
				default:
					// click/fill/press/selectorState/captureNetwork etc. exist
					// on the host but no eligible connector uses them yet. Fail loudly
					// rather than fake a result.
					return {
						__shimError: `harness: page.${method} is not implemented; add it before enabling a connector that needs it`,
					};
			}
		};


		const runner = await context.newPage();
		await runner.route("https://runner.local/", (r) =>
			r.fulfill({
				contentType: "text/html",
				body: "<!doctype html><body></body>",
			}),
		);
		await runner.exposeBinding("__pageApi", async (_src, method, args) => {
			const requestUnits = jsonPayloadUnits([method, args]);
			maxBridgePayloadUnits = Math.max(maxBridgePayloadUnits, requestUnits);
			bridgeCallCount++;
			if (requestUnits > PAGE_BRIDGE_MAX_UNITS)
				return {
					__shimError:
						"Bridge request argument exceeds 256 Ki UTF-16 code units",
				};
			const result = await dispatch(method, args);
			const replyUnits = jsonPayloadUnits(result);
			maxBridgePayloadUnits = Math.max(maxBridgePayloadUnits, replyUnits);
			if (replyUnits > PAGE_BRIDGE_MAX_UNITS)
				return { __shimError: "Bridge reply exceeds 256 Ki UTF-16 code units" };
			return result;
		});
		runner.on("console", (m) => {
			const message = m.text();
			const limit = message.includes("[chatgpt-timing]") ? 4096 : 300;
			log.push(`[bundle] ${message.slice(0, limit)}`);
		});
		runner.on("pageerror", (e) => log.push(`runner pageerror: ${e.message}`));
		await runner.goto("https://runner.local/");
		const performanceSession = await context.newCDPSession(runner);
		await performanceSession.send("Performance.enable");
		let sampling = true;
		let maxHeapBytes = 0;
		const sampleHeap = async () => {
			const { metrics } = await performanceSession.send(
				"Performance.getMetrics",
			);
			const heap = metrics.find((metric) => metric.name === "JSHeapUsedSize");
			if (heap) maxHeapBytes = Math.max(maxHeapBytes, heap.value);
		};
		const sampler = (async () => {
			while (sampling) {
				await sampleHeap();
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			await sampleHeap();
		})();

		if (loginAfterMs === Number.POSITIVE_INFINITY) {
			fixtures.setLoggedIn(false); // the user never signs in
		} else if (loginAfterMs > 0) {
			fixtures.setLoggedIn(false);
			setTimeout(() => {
				log.push("[user] signs in");
				fixtures.setLoggedIn(true);
				target.goto(fixtures.homeUrl, { waitUntil: "commit" }).catch(() => {});
			}, loginAfterMs);
		} else {
			fixtures.setLoggedIn(true);
		}

		const started = Date.now();
		const ret = await runner.evaluate(hostMain, {
			source,
			scopes,
			initialState,
			supportsStateArgument,
			methods: SHIM_METHODS,
			loginWaitMs,
			env,
			timerScale,
			clockNowMs,
		});
		sampling = false;
		await sampler;
		if (
			ret?.ok &&
			data.error === undefined &&
			(result || streamHost.doneValue)
		) {
			for (const [scope, cursor] of Object.entries(stagedStates)) {
				if (result && !Object.hasOwn(result, scope)) continue;
				const errors = result?.errors ?? streamHost.doneValue?.errors ?? [];
				if (errors.some((error) => error.scope === scope)) continue;
				states[scope] = cursor;
			}
		}
		const stubLine = log.find((l) => l.includes("[pageshim] stubHits="));
		return {
			ret,
			elapsedMs: Date.now() - started,
			maxHeapBytes,
			calls,
			pageNavigations,
			bridgeCallCount,
			maxBridgePayloadUnits,
			data,
			stateAckOrder,
			resultDoneAttemptOrder,
			resultWriteOrder,
			states,
			stateMessages,
			result,
			streamResult: streamHost.mode === "stream" ? streamHost.summary() : null,
			streamDone: streamHost.doneValue ?? null,
			streamScopeFiles:
				streamHost.mode === "stream"
					? Object.fromEntries(
							[...streamHost.files].map(([scope, entry]) => [
								scope,
								entry.path,
							]),
						)
					: {},
			archiveStats: archive.stats,
			stubHits: stubLine ? JSON.parse(stubLine.split("stubHits=")[1]) : null,
			log,
		};
	} finally {
		for (const entry of streamHost.files.values()) await entry.handle?.close();
		await browser.close();
	}
}
