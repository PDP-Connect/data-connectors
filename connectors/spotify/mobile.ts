// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spotifyCollect, spotifyPageCollector, type BrowserData } from "./index.ts";

type Context = Parameters<typeof spotifyCollect>[0];
type Page = Context["page"];

let probePrepared = false;

// Session credentials never leave the target page. This is the same WebCrypto
// HMAC/TOTP protocol as the Desktop page collector, without Node or Buffer.
export async function probeSpotifyMobileSession(page: Page): Promise<boolean> {
	try {
		if (!probePrepared) {
			await page.goto("https://open.spotify.com/", { waitUntil: "domcontentloaded" });
			probePrepared = true;
		}
		const probe = async () => {
			if (location.origin !== "https://open.spotify.com") return false;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 12_000);
			try {
				let serverTime: number | null = null;
				try {
					const response = await fetch("/api/server-time", { signal: controller.signal });
					const value = Number((await response.json()).serverTime);
					if (Number.isFinite(value)) serverTime = value;
				} catch {}
				const encoded = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
				const secret = new TextEncoder().encode(encoded.split("")
					.map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9)).join(""));
				const key = await crypto.subtle.importKey("raw", secret,
					{ name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
				const totp = async (ms: number) => {
					const counter = Math.floor(ms / 30_000);
					const buffer = new ArrayBuffer(8);
					const view = new DataView(buffer);
					view.setUint32(0, Math.floor(counter / 0x100000000));
					view.setUint32(4, counter & 0xffffffff);
					const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
					const offset = (bytes.at(-1) ?? 0) & 15;
					const code = (((bytes[offset]! & 127) << 24) |
						(bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) |
						bytes[offset + 3]!) % 1_000_000;
					return String(code).padStart(6, "0");
				};
				const params = new URLSearchParams({
					reason: "init", productType: "web_player", totp: await totp(Date.now()),
					totpServer: serverTime ? await totp(serverTime * 1000) : "unavailable",
					totpVer: "61",
				});
				const response = await fetch("/api/token?" + params, {
					credentials: "include", signal: controller.signal,
				});
				const data = await response.json();
				return Boolean(response.ok && data.accessToken && !data.isAnonymous);
			} catch {
				return false;
			} finally {
				clearTimeout(timer);
			}
		};
		return (await page.evaluate("(() => { const __name = (target) => target; return (" + probe.toString() + ")(); })()")) === true;
	} catch {
		return false;
	}
}

// This function is serialized into the target page along with the unchanged
// collector. Each pump services at most ONE fetch (including its response body)
// with a 12 s abort deadline. Retry sleeps and pagination never hold a bridge
// call open. All request headers/tokens remain in the target page.
function install(
	collector: typeof spotifyPageCollector,
	requested: string[],
	key: string,
): boolean {
	type Pending = {
		input: RequestInfo | URL;
		init: RequestInit | undefined;
		resolve: (response: Response) => void;
		reject: (error: unknown) => void;
	};
	const queue: Pending[] = [];
	let result: string | undefined;
	let failure: string | undefined;
	let disposed = false;
	let active: AbortController | undefined;
	const queuedFetch: typeof fetch = (input, init) =>
		new Promise<Response>((resolve, reject) => {
			if (disposed) reject(new Error("spotify_mobile_disposed"));
			else queue.push({ input, init, resolve, reject });
		});
	const job = {
		async pump() {
			if (queue.length === 0 && result === undefined && failure === undefined)
				await new Promise((resolve) => setTimeout(resolve, 25));
			const pending = queue.shift();
			if (pending) {
				active = new AbortController();
				const timer = setTimeout(() => active?.abort(), 12_000);
				try {
					const response = await fetch(pending.input, {
						...pending.init, signal: active.signal,
					});
					const body = await response.arrayBuffer();
					pending.resolve(new Response(body, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					}));
				} catch (error) {
					pending.reject(error);
				} finally {
					clearTimeout(timer);
					active = undefined;
				}
			}
			return { done: result !== undefined, length: result?.length ?? 0, error: failure };
		},
		read(offset: number) { return result?.slice(offset, offset + 16_384) ?? null; },
		dispose() {
			disposed = true;
			active?.abort();
			for (const pending of queue.splice(0))
				pending.reject(new Error("spotify_mobile_disposed"));
			result = undefined;
		},
	};
	(globalThis as unknown as Record<string, unknown>)[key] = job;
	void collector(requested, queuedFetch).then(
		(data) => { if (!disposed) result = JSON.stringify(data); },
		(error) => { failure = error instanceof Error ? error.message : String(error); },
	);
	return true;
}

export async function collectSpotifyMobileData(page: Page, streams: string[]): Promise<BrowserData> {
	const key = "__pdppSpotify_" + Date.now() + "_" + Math.random().toString(36).slice(2);
	// Lexically bind esbuild's named-function helper without modifying globals.
	const source = "(() => { const __name = (target) => target; return (" +
		install.toString() + ")((" + spotifyPageCollector.toString() + ")," +
		JSON.stringify(streams) + "," + JSON.stringify(key) + "); })()";
	if (source.length > 65_536) throw new Error("spotify_mobile_evaluate_source_too_large");
	try {
		if (await page.evaluate(source) !== true) throw new Error("spotify_mobile_install_failed");
		for (;;) {
			const state = await page.evaluate(async (name) => {
				const job = (globalThis as any)[name];
				return job ? await job.pump() : null;
			}, key) as { done: boolean; length: number; error?: string } | null;
			if (!state) throw new Error("spotify_mobile_job_lost");
			if (state.error) throw new Error(state.error);
			if (!state.done) continue;
			const chunks: string[] = [];
			for (let offset = 0; offset < state.length; offset += 16_384) {
				const chunk = await page.evaluate(({ name, offset }) =>
					(globalThis as any)[name]?.read(offset) ?? null, { name: key, offset });
				if (typeof chunk !== "string") throw new Error("spotify_mobile_result_lost");
				chunks.push(chunk);
			}
			return JSON.parse(chunks.join("")) as BrowserData;
		}
	} finally {
		await page.evaluate((name) => {
			const jobs = globalThis as any;
			jobs[name]?.dispose();
			delete jobs[name];
		}, key);
	}
}

export async function spotifyMobileCollect(context: Context): Promise<void> {
	const gaps = new Set<string>();
	const incomplete = async (stream: string, message: string) => {
		if (gaps.has(stream)) return;
		gaps.add(stream);
		const skip = {
			type: "SKIP_RESULT" as const, stream,
			message,
			recovery_hint: { action: "retry_by_runtime" as const, retryable: true },
		};
		await context.emit({ ...skip, reason: "inventory_not_proven_complete" });
	};
	await spotifyCollect({
		...context,
		emit: async (message) => {
			if (message.type === "SKIP_RESULT") {
				await incomplete(String(message.stream), String(message.message ?? message.reason));
				return;
			}
			await context.emit(message);
			if (message.type === "DETAIL_GAP" ||
				(message.type === "DETAIL_COVERAGE" &&
					typeof message.considered === "number" &&
					typeof message.covered === "number" &&
					message.covered < message.considered)) {
				await incomplete(String(message.stream),
					"Spotify inventory completeness is unproven because source rows were unavailable.");
			}
		},
	}, collectSpotifyMobileData);
}
