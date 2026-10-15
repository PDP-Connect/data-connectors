// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage metadata for the `conversation_usage` and `usage_summary` streams.
 *
 * Privacy contract: these streams carry NO message text, conversation titles,
 * memory contents, custom-instruction text, prompts, attachment or file
 * names, tool or action names, email, name or phone. Conversation and GPT ids
 * are replaced by salted one-way references.
 *
 * Text-bearing endpoints (conversation detail, memories, custom instructions,
 * shares) are read through `chatGptUsageFetchInBrowser`, which runs inside the
 * chatgpt.com page and reduces each response to numbers, booleans and
 * validated slugs BEFORE it returns. Text is downloaded by the page (as the
 * web app itself does) but is never handed to the connector process, never
 * captured as a fixture and never emitted.
 *
 * Evidence (spike, no live account run yet):
 *   Seen in this repo's code or fixtures: the endpoints /conversations/search,
 *   /conversations/batch, /conversation/{id}, /shared_conversations,
 *   /memories, /user_system_messages, /accounts/check; mapping/parent/
 *   children/current_node, author.role, author.name, recipient,
 *   content.content_type and parts, metadata.model_slug, metadata.attachments,
 *   image_asset_pointer, execution_output, tether_*, thoughts,
 *   reasoning_recap, tool names "python"/"browser"/"bio", gizmo_id,
 *   workspace_id, is_archived, is_starred, accounts/check created_time,
 *   account_residency_region and account_compute_residency.
 *   Assumed (public descriptions of the web app, unverified here):
 *   /settings/user and its boolean `settings` keys, /cdn-cgi/trace `loc=`,
 *   memory_num_tokens/memory_max_tokens, gizmo_type "snorlax" and the "g-p-"
 *   project prefix, default_model_slug, is_visually_hidden_from_conversation,
 *   voice_mode_message and audio part types, async_task_type /
 *   deep_research_version, tool names "web.*", "dalle.*", "image_gen*",
 *   "canmore.*", "research_kickoff_tool*", "file_search*", "myfiles_browser*",
 *   and create_time/gizmo_id on /conversations/search items.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { tsToIso } from "./parsers.ts";
import type {
	ChatGptAuth,
	ChatGptFetchResult,
	ChatGptUsageProjection,
	ConversationListItem,
} from "./types.ts";

export type { ChatGptUsageProjection } from "./types.ts";

// ─── In-page projection ────────────────────────────────────────────────

export interface ChatGptUsageFetchArgs {
	auth: ChatGptAuth;
	body?: unknown;
	method: string;
	path: string;
	projection: ChatGptUsageProjection;
	timeoutMs: number;
}

/**
 * Runs IN THE PAGE (passed to `page.evaluate`, serialized with
 * `Function.prototype.toString`). It must stay self-contained: no reference
 * to anything outside its own body, no `eval`/`new Function` (CSP). It
 * fetches one backend path and returns only the projection named by
 * `projection`; on a non-200 it returns `json: null`.
 */
export async function chatGptUsageFetchInBrowser(
	args: ChatGptUsageFetchArgs,
): Promise<ChatGptFetchResult> {
	const { auth, body, method, path, projection, timeoutMs } = args;
	// Helpers are shorthand methods on one object on purpose: tsx/esbuild wraps
	// a named arrow or nested function in `__name(...)`, which does not exist
	// in the page. Shorthand methods and inline callbacks are left alone.
	const h = {
		SLUG: /^[a-z0-9][a-z0-9._:-]{0,63}$/,
		OPAQUE_ID: /^[A-Za-z0-9_-]{1,128}$/,
		MAX_EVENTS: 5000,
		isObj(v: unknown): v is Record<string, unknown> {
			return typeof v === "object" && v !== null && !Array.isArray(v);
		},
		// A provider enum (model slug, content type, tool family). Anything
		// that is not a short lowercase slug becomes "other", so free text
		// never passes.
		slug(v: unknown): string | null {
			if (typeof v !== "string" || v.length === 0) return null;
			const s = v.toLowerCase();
			return h.SLUG.test(s) ? s : "other";
		},
		opaqueId(v: unknown): string | null {
			return typeof v === "string" && h.OPAQUE_ID.test(v) ? v : null;
		},
		bool(v: unknown): boolean | null {
			return typeof v === "boolean" ? v : null;
		},
		count(v: unknown): number | null {
			return typeof v === "number" && Number.isFinite(v) && v >= 0
				? Math.floor(v)
				: null;
		},
		epoch(v: unknown): number | null {
			if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
			if (typeof v === "string" && v.length > 0) {
				const ms = Date.parse(v);
				return Number.isNaN(ms) ? null : ms / 1000;
			}
			return null;
		},
		nonEmpty(v: unknown): boolean {
			return typeof v === "string" && v.trim().length > 0;
		},
		bump(m: Map<string, number>, k: string): void {
			m.set(k, (m.get(k) ?? 0) + 1);
		},
		// Length only. The string itself is never copied anywhere.
		textLength(content: unknown): number {
			if (!h.isObj(content)) return 0;
			let n = typeof content.text === "string" ? content.text.length : 0;
			const parts = Array.isArray(content.parts) ? content.parts : [];
			for (const part of parts) {
				if (typeof part === "string") n += part.length;
				else if (h.isObj(part) && typeof part.text === "string")
					n += part.text.length;
			}
			return n;
		},
		partTypes(content: unknown): string[] {
			if (!h.isObj(content) || !Array.isArray(content.parts)) return [];
			const out: string[] = [];
			for (const part of content.parts) {
				const t = h.isObj(part) ? h.slug(part.content_type) : null;
				if (t) out.push(t);
			}
			return out;
		},
		toolFeature(name: string): string {
			if (name.startsWith("web") || name.startsWith("browser"))
				return "web_search";
			if (name === "python" || name.startsWith("python."))
				return "code_interpreter";
			if (name.startsWith("dalle") || name.startsWith("image_gen"))
				return "image_generation";
			if (name.startsWith("canmore")) return "canvas";
			if (name.startsWith("research_kickoff_tool")) return "deep_research";
			if (name === "bio" || name.startsWith("bio.")) return "memory_update";
			if (name.startsWith("file_search") || name.startsWith("myfiles_browser"))
				return "file_search";
			return "other_tool";
		},
		/** Features one visible message shows, each at most once. */
		messageFeatures(m: Record<string, unknown>, role: string): Set<string> {
			const author = h.isObj(m.author) ? m.author : {};
			const md = h.isObj(m.metadata) ? m.metadata : {};
			const contentType = h.isObj(m.content)
				? h.slug(m.content.content_type)
				: null;
			const parts = h.partTypes(m.content);
			const used = new Set<string>();
			if (role === "tool") {
				const name = h.slug(author.name);
				if (name) used.add(h.toolFeature(name));
				if (contentType === "execution_output") used.add("code_interpreter");
				if (parts.includes("image_asset_pointer")) used.add("image_generation");
			}
			if (contentType?.startsWith("tether_")) used.add("web_search");
			if (contentType === "thoughts" || contentType === "reasoning_recap")
				used.add("reasoning");
			if (
				md.async_task_type === "research" ||
				md.deep_research_version !== undefined
			)
				used.add("deep_research");
			if (
				md.voice_mode_message === true ||
				parts.some((p) => p.includes("audio"))
			)
				used.add("voice");
			return used;
		},
		/** The current branch, root first, following parent pointers from current_node. */
		currentBranch(
			mapping: Record<string, unknown>,
			currentNode: unknown,
		): Record<string, unknown>[] {
			const branch: Record<string, unknown>[] = [];
			const seen = new Set<string>();
			let at: unknown = currentNode;
			while (typeof at === "string" && !seen.has(at) && seen.size < 100_000) {
				seen.add(at);
				const node = mapping[at];
				if (!h.isObj(node)) break;
				if (h.isObj(node.message)) branch.push(node.message);
				at = node.parent;
			}
			return branch.reverse();
		},
		conversation(c: unknown): Record<string, unknown> | null {
			if (!h.isObj(c)) return null;
			const mapping = h.isObj(c.mapping) ? c.mapping : null;
			const counts = new Map<string, number>();
			const models = new Map<string, number>();
			const features = new Map<string, number>();
			const events: Array<[number, 0 | 1, string | null]> = [];
			const acc = {
				nodesTotal: 0,
				leaves: 0,
				userChars: 0,
				userCharsMax: 0,
				assistantChars: 0,
				attachments: 0,
				userImages: 0,
				firstAt: null as number | null,
				lastAt: null as number | null,
			};
			for (const node of mapping ? Object.values(mapping) : []) {
				if (!(h.isObj(node) && h.isObj(node.message))) continue;
				acc.nodesTotal += 1;
				if (!Array.isArray(node.children) || node.children.length === 0)
					acc.leaves += 1;
			}
			for (const m of mapping ? h.currentBranch(mapping, c.current_node) : []) {
				const author = h.isObj(m.author) ? m.author : {};
				const role = typeof author.role === "string" ? author.role : "";
				const md = h.isObj(m.metadata) ? m.metadata : {};
				if (md.is_visually_hidden_from_conversation === true) {
					h.bump(counts, "hidden");
					continue;
				}
				h.bump(
					counts,
					["user", "assistant", "tool", "system"].includes(role)
						? role
						: "other",
				);
				for (const f of h.messageFeatures(m, role)) h.bump(features, f);
				const t = h.epoch(m.create_time);
				if (t !== null) {
					acc.firstAt = acc.firstAt === null ? t : Math.min(acc.firstAt, t);
					acc.lastAt = acc.lastAt === null ? t : Math.max(acc.lastAt, t);
				}
				if (role === "user") {
					const n = h.textLength(m.content);
					acc.userChars += n;
					acc.userCharsMax = Math.max(acc.userCharsMax, n);
					if (Array.isArray(md.attachments))
						acc.attachments += md.attachments.length;
					acc.userImages += h
						.partTypes(m.content)
						.filter((p) => p === "image_asset_pointer").length;
					if (t !== null && events.length < h.MAX_EVENTS)
						events.push([t, 0, null]);
				} else if (role === "assistant") {
					acc.assistantChars += h.textLength(m.content);
					const model = h.slug(md.model_slug) ?? h.slug(md.default_model_slug);
					if (model) h.bump(models, model);
					if (t !== null && events.length < h.MAX_EVENTS)
						events.push([t, 1, model]);
				}
			}
			const workspaceId = c.workspace_id;
			return {
				v: 1,
				conversation_id: h.opaqueId(c.conversation_id) ?? h.opaqueId(c.id),
				create_time: h.epoch(c.create_time),
				update_time: h.epoch(c.update_time),
				is_archived: h.bool(c.is_archived),
				is_starred: h.bool(c.is_starred),
				gizmo_id: h.opaqueId(c.gizmo_id),
				gizmo_type: h.slug(c.gizmo_type),
				in_workspace:
					typeof workspaceId === "string"
						? workspaceId.length > 0
						: workspaceId === null
							? false
							: null,
				default_model_slug: h.slug(c.default_model_slug),
				has_mapping: mapping !== null,
				nodes_total: acc.nodesTotal,
				branch_count: acc.leaves,
				counts: Object.fromEntries(counts),
				models: Object.fromEntries(models),
				features: Object.fromEntries(features),
				user_attachments: acc.attachments,
				user_images: acc.userImages,
				user_chars_total: acc.userChars,
				user_chars_max: acc.userCharsMax,
				assistant_chars_total: acc.assistantChars,
				first_message_at: acc.firstAt,
				last_message_at: acc.lastAt,
				events,
			};
		},
		project(raw: unknown): unknown {
			const j = h.isObj(raw) ? raw : {};
			switch (projection) {
				case "conversation_usage":
					return Array.isArray(raw)
						? raw.map((c) => h.conversation(c))
						: h.conversation(raw);
				case "shared_conversation_ids": {
					const items = Array.isArray(j.items) ? j.items : [];
					return {
						items: items.map((s) => ({
							conversation_id: h.isObj(s)
								? h.opaqueId(s.conversation_id)
								: null,
						})),
						total: h.count(j.total),
					};
				}
				case "memory_stats": {
					const list = Array.isArray(j.memories)
						? j.memories
						: Array.isArray(j.items)
							? j.items
							: null;
					return {
						memory_count: list ? list.length : null,
						memory_num_tokens: h.count(j.memory_num_tokens),
						memory_max_tokens: h.count(j.memory_max_tokens),
					};
				}
				case "custom_instructions_flags":
					return {
						enabled: h.bool(j.enabled),
						about_user_set:
							h.nonEmpty(j.about_user_message) || h.nonEmpty(j.about_user),
						response_style_set:
							h.nonEmpty(j.about_model_message) || h.nonEmpty(j.response_style),
					};
				case "settings_flags": {
					const s = h.isObj(j.settings) ? j.settings : j;
					const flags = Object.entries(s)
						.filter(
							(e): e is [string, boolean] =>
								typeof e[1] === "boolean" && /^[a-z0-9_]{1,64}$/.test(e[0]),
						)
						.sort((a, b) => (a[0] < b[0] ? -1 : 1));
					return { flags: Object.fromEntries(flags.slice(0, 64)) };
				}
				default:
					return null;
			}
		},
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		if (projection === "client_context") {
			// Country of the network the page is on right now, from Cloudflare's
			// trace endpoint. Only `loc` is read; the IP on the same body is not.
			let networkCountry: string | null = null;
			try {
				const r = await fetch("https://chatgpt.com/cdn-cgi/trace", {
					credentials: "omit",
					signal: controller.signal,
				});
				if (r.ok) {
					const m = /^loc=([A-Z]{2})$/m.exec(await r.text());
					const code = m?.[1] ?? null;
					networkCountry = code && code !== "XX" && code !== "T1" ? code : null;
				}
			} catch {
				networkCountry = null;
			}
			let timezone: string | null = null;
			try {
				const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
				timezone =
					typeof tz === "string" &&
					/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)
						? tz
						: null;
			} catch {
				timezone = null;
			}
			const lang = typeof navigator === "undefined" ? null : navigator.language;
			return {
				status: 200,
				json: {
					network_country: networkCountry,
					timezone,
					browser_language:
						typeof lang === "string" &&
						/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)
							? lang
							: null,
				},
			};
		}
		const headers: Record<string, string> = {
			accept: "*/*",
			authorization: `Bearer ${auth.accessToken}`,
			"oai-language": "en-US",
			"content-type": "application/json",
		};
		if (auth.deviceId) headers["oai-device-id"] = auth.deviceId;
		const init: RequestInit = {
			method,
			credentials: "include",
			headers,
			signal: controller.signal,
		};
		if (body) init.body = JSON.stringify(body);
		const res = await fetch(`https://chatgpt.com/backend-api${path}`, init);
		const retryAfter = res.headers.get("retry-after") ?? undefined;
		let json: unknown = null;
		if (res.status === 200) {
			try {
				json = h.project(await res.json());
			} catch {
				json = null;
			}
		}
		return {
			status: res.status,
			json: json as ChatGptFetchResult["json"],
			...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}),
		};
	} catch (err) {
		if (controller.signal.aborted) {
			throw new Error(`chatgpt_backend_fetch_timeout after ${timeoutMs}ms`, {
				cause: err,
			});
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

// ─── Opaque references ─────────────────────────────────────────────────

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Dependency-free SHA-256 (same algorithm as the PageShim anthropic-export
 * shim). node:crypto is stubbed on the PageShim host, so the references must
 * not depend on it.
 */
export function sha256Hex(input: string): string {
	const msg = new TextEncoder().encode(input);
	const bitLen = msg.length * 8;
	const padded = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6) >>> 0);
	padded.set(msg);
	padded[msg.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
	view.setUint32(padded.length - 4, bitLen >>> 0);
	const H = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	]);
	const W = new Uint32Array(64);
	const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
	const w = (i: number): number => W[i] ?? 0;
	for (let off = 0; off < padded.length; off += 64) {
		for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w(i - 15), 7) ^ rotr(w(i - 15), 18) ^ (w(i - 15) >>> 3);
			const s1 = rotr(w(i - 2), 17) ^ rotr(w(i - 2), 19) ^ (w(i - 2) >>> 10);
			W[i] = (w(i - 16) + s0 + w(i - 7) + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = [
			H[0] ?? 0,
			H[1] ?? 0,
			H[2] ?? 0,
			H[3] ?? 0,
			H[4] ?? 0,
			H[5] ?? 0,
			H[6] ?? 0,
			H[7] ?? 0,
		];
		for (let i = 0; i < 64; i++) {
			const t1 =
				(h +
					(rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
					((e & f) ^ (~e & g)) +
					(SHA256_K[i] ?? 0) +
					w(i)) >>>
				0;
			const t2 =
				((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) +
					((a & b) ^ (a & c) ^ (b & c))) >>>
				0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		const add = [a, b, c, d, e, f, g, h];
		for (let i = 0; i < 8; i++) H[i] = ((H[i] ?? 0) + (add[i] ?? 0)) >>> 0;
	}
	return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/**
 * One-way reference for a provider id. Stable across runs (so it can be a
 * primary key), not reversible from the output alone. Anyone who already
 * holds the raw id (the owner, OpenAI) can recompute it: it hides ids from a
 * data recipient, not from the provider.
 */
export function usageRef(kind: "c" | "g", raw: string): string {
	return `${kind}_${sha256Hex(`pdpp.chatgpt.usage.v1\u0000${kind}\u0000${raw}`).slice(0, 32)}`;
}

// ─── Projection readers (node side; the page is not trusted) ───────────

export const USAGE_FEATURES = [
	"web_search",
	"code_interpreter",
	"image_generation",
	"canvas",
	"deep_research",
	"memory_update",
	"file_search",
	"reasoning",
	"voice",
	"other_tool",
] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

const ROLE_KEYS = [
	"user",
	"assistant",
	"tool",
	"system",
	"other",
	"hidden",
] as const;

const SLUG = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface ConversationUsageProjection {
	conversation_id: string | null;
	create_time: number | null;
	update_time: number | null;
	is_archived: boolean | null;
	is_starred: boolean | null;
	gizmo_id: string | null;
	gizmo_type: string | null;
	in_workspace: boolean | null;
	default_model_slug: string | null;
	has_mapping: boolean;
	nodes_total: number;
	branch_count: number;
	counts: Record<(typeof ROLE_KEYS)[number], number>;
	models: Array<{ slug: string; assistant_messages: number }>;
	features: Record<UsageFeature, number>;
	user_attachments: number;
	user_images: number;
	user_chars_total: number;
	user_chars_max: number;
	assistant_chars_total: number;
	first_message_at: number | null;
	last_message_at: number | null;
	/** [epoch seconds, 0 = user | 1 = assistant, model slug | null]. Not emitted. */
	events: Array<[number, 0 | 1, string | null]>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const nat = (v: unknown): number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const epochOrNull = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
const boolOrNull = (v: unknown): boolean | null =>
	typeof v === "boolean" ? v : null;
const slugOrNull = (v: unknown): string | null =>
	typeof v === "string" && SLUG.test(v) ? v : null;
const idOrNull = (v: unknown): string | null =>
	typeof v === "string" && OPAQUE_ID.test(v) ? v : null;

/** Re-validate one in-page projection. Anything off-shape becomes null/0. */
export function readConversationUsageProjection(
	raw: unknown,
): ConversationUsageProjection | null {
	if (!isObj(raw) || raw.v !== 1) return null;
	const counts = isObj(raw.counts) ? raw.counts : {};
	const features = isObj(raw.features) ? raw.features : {};
	const models = isObj(raw.models) ? raw.models : {};
	const events: Array<[number, 0 | 1, string | null]> = [];
	for (const e of Array.isArray(raw.events) ? raw.events : []) {
		if (!Array.isArray(e)) continue;
		const t = epochOrNull(e[0]);
		const role = e[1] === 0 || e[1] === 1 ? e[1] : null;
		if (t === null || role === null) continue;
		events.push([t, role, slugOrNull(e[2])]);
	}
	return {
		conversation_id: idOrNull(raw.conversation_id),
		create_time: epochOrNull(raw.create_time),
		update_time: epochOrNull(raw.update_time),
		is_archived: boolOrNull(raw.is_archived),
		is_starred: boolOrNull(raw.is_starred),
		gizmo_id: idOrNull(raw.gizmo_id),
		gizmo_type: slugOrNull(raw.gizmo_type),
		in_workspace: boolOrNull(raw.in_workspace),
		default_model_slug: slugOrNull(raw.default_model_slug),
		has_mapping: raw.has_mapping === true,
		nodes_total: nat(raw.nodes_total),
		branch_count: nat(raw.branch_count),
		counts: Object.fromEntries(
			ROLE_KEYS.map((k) => [k, nat(counts[k])]),
		) as ConversationUsageProjection["counts"],
		models: Object.entries(models)
			.filter(([k]) => SLUG.test(k))
			.map(([slug, n]) => ({ slug, assistant_messages: nat(n) }))
			.filter((m) => m.assistant_messages > 0)
			.sort(byCountThenSlug),
		features: Object.fromEntries(
			USAGE_FEATURES.map((k) => [k, nat(features[k])]),
		) as Record<UsageFeature, number>,
		user_attachments: nat(raw.user_attachments),
		user_images: nat(raw.user_images),
		user_chars_total: nat(raw.user_chars_total),
		user_chars_max: nat(raw.user_chars_max),
		assistant_chars_total: nat(raw.assistant_chars_total),
		first_message_at: epochOrNull(raw.first_message_at),
		last_message_at: epochOrNull(raw.last_message_at),
		events,
	};
}

function byCountThenSlug(
	a: { slug: string; assistant_messages: number },
	b: { slug: string; assistant_messages: number },
): number {
	return (
		b.assistant_messages - a.assistant_messages ||
		(a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
	);
}

// ─── conversation_usage record ─────────────────────────────────────────

export type DetailStatus = "fetched" | "not_fetched" | "unavailable" | "failed";

export type GizmoKind = "none" | "custom_gpt" | "project" | "other";

/**
 * Projects are gizmos of type "snorlax"; their ids start "g-p-". Custom GPT
 * ids start "g-". Both rules are read from public descriptions of the web
 * app, not from a captured response in this repo.
 */
export function gizmoKind(
	gizmoId: string | null,
	gizmoType: string | null,
): GizmoKind {
	if (!gizmoId) return "none";
	if (gizmoType === "snorlax" || gizmoId.startsWith("g-p-")) return "project";
	if (gizmoType === "gpt" || gizmoId.startsWith("g-")) return "custom_gpt";
	return "other";
}

export interface ConversationUsageInput {
	listItem: ConversationListItem;
	projection: ConversationUsageProjection | null;
	detailStatus: DetailStatus;
	/** Raw conversation ids that have a share link; null when shares were not read. */
	sharedIds: ReadonlySet<string> | null;
}

/** Build one `conversation_usage` record. Never reads `title` or any text. */
export function buildConversationUsageRecord({
	listItem,
	projection: p,
	detailStatus,
	sharedIds,
}: ConversationUsageInput): RecordData {
	const listGizmo = idOrNull(listItem.gizmo_id);
	const gizmoId = p?.gizmo_id ?? listGizmo;
	const gizmoType =
		p?.gizmo_type ??
		(typeof listItem.gizmo_type === "string"
			? slugOrNull(listItem.gizmo_type)
			: null);
	const kind = gizmoKind(gizmoId, gizmoType);
	const listWorkspace = listItem.workspace_id;
	const counts = p?.counts ?? null;
	return {
		id: usageRef("c", listItem.id),
		create_time: tsToIso(p?.create_time ?? listItem.create_time),
		update_time: tsToIso(p?.update_time ?? listItem.update_time),
		is_archived: p?.is_archived ?? boolOrNull(listItem.is_archived),
		is_starred: p?.is_starred ?? boolOrNull(listItem.is_starred),
		is_shared: sharedIds ? sharedIds.has(listItem.id) : null,
		in_workspace:
			p?.in_workspace ??
			(typeof listWorkspace === "string"
				? listWorkspace.length > 0
				: listWorkspace === null
					? false
					: null),
		gizmo_kind: kind,
		gizmo_ref: gizmoId && kind !== "none" ? usageRef("g", gizmoId) : null,
		detail_status: detailStatus,
		default_model_slug: p?.default_model_slug ?? null,
		message_counts: counts ? { ...counts } : null,
		turn_count: counts ? counts.user : null,
		branch_count: p ? p.branch_count : null,
		nodes_total: p ? p.nodes_total : null,
		models: p ? p.models.map((m) => ({ ...m })) : null,
		features: p ? { ...p.features } : null,
		user_attachments: p ? p.user_attachments : null,
		user_images: p ? p.user_images : null,
		user_chars_total: p ? p.user_chars_total : null,
		user_chars_max: p ? p.user_chars_max : null,
		assistant_chars_total: p ? p.assistant_chars_total : null,
		first_message_at: p ? tsToIso(p.first_message_at) : null,
		last_message_at: p ? tsToIso(p.last_message_at) : null,
	};
}

// ─── usage_summary record ──────────────────────────────────────────────

export interface UsageSettingsInput {
	memory_count: number | null;
	memory_num_tokens: number | null;
	memory_max_tokens: number | null;
	custom_instructions_enabled: boolean | null;
	custom_instructions_about_user_set: boolean | null;
	custom_instructions_response_style_set: boolean | null;
	setting_flags: Record<string, boolean> | null;
}

export interface UsageClientContext {
	timezone: string | null;
	browser_language: string | null;
	network_country: string | null;
}

export interface UsageAccountInput {
	created_at: string | null;
	data_residency_region: string | null;
	compute_residency_region: string | null;
}

export interface UsageSummaryInput {
	conversations: ReadonlyArray<{
		record: RecordData;
		projection: ConversationUsageProjection | null;
	}>;
	settings: UsageSettingsInput;
	client: UsageClientContext;
	account: UsageAccountInput;
}

interface LocalParts {
	day: string;
	month: string;
	hour: number;
	weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function makeLocalizer(timezone: string): (epochSec: number) => LocalParts {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		weekday: "short",
		hourCycle: "h23",
	});
	return (epochSec) => {
		const parts: Record<string, string> = {};
		for (const p of fmt.formatToParts(new Date(epochSec * 1000))) {
			parts[p.type] = p.value;
		}
		const month = `${parts.year}-${parts.month}`;
		return {
			day: `${month}-${parts.day}`,
			month,
			hour: Number(parts.hour) % 24,
			weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "")),
		};
	};
}

function resolveTimezone(tz: string | null): string {
	if (!tz) return "UTC";
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz;
	} catch {
		return "UTC";
	}
}

function longestStreak(days: readonly string[]): number {
	const sorted = [...new Set(days)].sort();
	let best = 0;
	let run = 0;
	let prev: number | null = null;
	for (const d of sorted) {
		const t = Date.parse(`${d}T00:00:00Z`);
		run = prev !== null && t - prev === 86_400_000 ? run + 1 : 1;
		best = Math.max(best, run);
		prev = t;
	}
	return best;
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1
		? (s[mid] ?? 0)
		: Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

function emptyFeatures(): Record<UsageFeature, number> {
	return Object.fromEntries(USAGE_FEATURES.map((k) => [k, 0])) as Record<
		UsageFeature,
		number
	>;
}

interface MonthBucket {
	conversations_created: number;
	user_messages: number;
	assistant_messages: number;
	days: Set<string>;
	models: Map<string, number>;
	features: Record<UsageFeature, number>;
}

/**
 * Aggregate the run's conversation_usage inputs into the singleton
 * usage_summary record. All bucketing (month, day, hour, weekday) is in the
 * page's IANA timezone, or UTC when it is unknown.
 *
 * Activity days are days with a user message; a conversation whose detail
 * was not read contributes its create day instead.
 */
export function buildUsageSummaryRecord(input: UsageSummaryInput): RecordData {
	const timezone = resolveTimezone(input.client.timezone);
	const local = makeLocalizer(timezone);
	const months = new Map<string, MonthBucket>();
	const bucket = (m: string): MonthBucket => {
		let b = months.get(m);
		if (!b) {
			b = {
				conversations_created: 0,
				user_messages: 0,
				assistant_messages: 0,
				days: new Set(),
				models: new Map(),
				features: emptyFeatures(),
			};
			months.set(m, b);
		}
		return b;
	};
	const hours = new Array<number>(24).fill(0);
	const weekdays = new Array<number>(7).fill(0);
	const days: string[] = [];
	const modelTotals = new Map<string, number>();
	const featureConversations = emptyFeatures();
	const userCharsPerMessageMax: number[] = [];
	const gizmos = { custom_gpt: new Set<string>(), project: new Set<string>() };
	let first: number | null = null;
	let last: number | null = null;
	const seeTime = (t: number | null): void => {
		if (t === null) return;
		first = first === null ? t : Math.min(first, t);
		last = last === null ? t : Math.max(last, t);
	};
	const totals = {
		conversations: 0,
		archived: 0,
		starred: 0,
		shared: 0 as number | null,
		in_workspace: 0,
		custom_gpt_conversations: 0,
		project_conversations: 0,
		user_messages: 0,
		assistant_messages: 0,
		tool_messages: 0,
		user_attachments: 0,
		user_images: 0,
		user_chars_total: 0,
		regenerated_or_edited_conversations: 0,
	};
	const coverage = {
		conversations_listed: 0,
		detail_fetched: 0,
		detail_unavailable: 0,
		detail_failed: 0,
		detail_not_fetched: 0,
	};
	let sharedKnown = true;
	for (const { record: r, projection: p } of input.conversations) {
		totals.conversations += 1;
		coverage.conversations_listed += 1;
		const status = r.detail_status as DetailStatus;
		if (status === "fetched") coverage.detail_fetched += 1;
		else if (status === "unavailable") coverage.detail_unavailable += 1;
		else if (status === "failed") coverage.detail_failed += 1;
		else coverage.detail_not_fetched += 1;
		if (r.is_archived === true) totals.archived += 1;
		if (r.is_starred === true) totals.starred += 1;
		if (r.is_shared === null) sharedKnown = false;
		else if (r.is_shared === true) totals.shared = (totals.shared ?? 0) + 1;
		if (r.in_workspace === true) totals.in_workspace += 1;
		const gref = typeof r.gizmo_ref === "string" ? r.gizmo_ref : null;
		if (r.gizmo_kind === "custom_gpt") {
			totals.custom_gpt_conversations += 1;
			if (gref) gizmos.custom_gpt.add(gref);
		} else if (r.gizmo_kind === "project") {
			totals.project_conversations += 1;
			if (gref) gizmos.project.add(gref);
		}
		const created =
			typeof r.create_time === "string"
				? Date.parse(r.create_time) / 1000
				: null;
		const updated =
			typeof r.update_time === "string"
				? Date.parse(r.update_time) / 1000
				: null;
		seeTime(created);
		seeTime(updated);
		const createdParts = created === null ? null : local(created);
		if (createdParts) bucket(createdParts.month).conversations_created += 1;
		if (!p) {
			if (createdParts) {
				days.push(createdParts.day);
				bucket(createdParts.month).days.add(createdParts.day);
			}
			continue;
		}
		totals.user_messages += p.counts.user;
		totals.assistant_messages += p.counts.assistant;
		totals.tool_messages += p.counts.tool;
		totals.user_attachments += p.user_attachments;
		totals.user_images += p.user_images;
		totals.user_chars_total += p.user_chars_total;
		if (p.counts.user > 0) userCharsPerMessageMax.push(p.user_chars_max);
		if (p.branch_count > 1) totals.regenerated_or_edited_conversations += 1;
		for (const f of USAGE_FEATURES) {
			if (p.features[f] > 0) {
				featureConversations[f] += 1;
				if (createdParts) bucket(createdParts.month).features[f] += 1;
			}
		}
		for (const [t, role, model] of p.events) {
			seeTime(t);
			const lp = local(t);
			const b = bucket(lp.month);
			if (role === 0) {
				b.user_messages += 1;
				b.days.add(lp.day);
				days.push(lp.day);
				hours[lp.hour] = (hours[lp.hour] ?? 0) + 1;
				weekdays[lp.weekday] = (weekdays[lp.weekday] ?? 0) + 1;
			} else {
				b.assistant_messages += 1;
				if (model) {
					b.models.set(model, (b.models.get(model) ?? 0) + 1);
					modelTotals.set(model, (modelTotals.get(model) ?? 0) + 1);
				}
			}
		}
	}
	const toModelList = (m: Map<string, number>) =>
		[...m.entries()]
			.map(([slug, n]) => ({ slug, assistant_messages: n }))
			.sort(byCountThenSlug);
	const userMessages = totals.user_messages;
	const iso = (t: number | null): string | null =>
		t === null ? null : new Date(t * 1000).toISOString();
	return {
		id: "usage_summary",
		timezone,
		timezone_source:
			input.client.timezone === timezone ? "browser" : "default_utc",
		coverage: {
			...coverage,
			detail_complete:
				coverage.detail_fetched + coverage.detail_unavailable ===
				coverage.conversations_listed,
		},
		first_activity_at: iso(first),
		last_activity_at: iso(last),
		active_days: new Set(days).size,
		longest_streak_days: longestStreak(days),
		totals: {
			...totals,
			shared: sharedKnown ? totals.shared : null,
			custom_gpts_used: gizmos.custom_gpt.size,
			projects_used: gizmos.project.size,
		},
		user_message_chars: {
			total: totals.user_chars_total,
			mean_per_message:
				userMessages > 0
					? Math.round(totals.user_chars_total / userMessages)
					: null,
			median_of_conversation_max: median(userCharsPerMessageMax),
		},
		models: toModelList(modelTotals),
		feature_conversations: featureConversations,
		months: [...months.entries()]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([month, b]) => ({
				month,
				conversations_created: b.conversations_created,
				user_messages: b.user_messages,
				assistant_messages: b.assistant_messages,
				active_days: b.days.size,
				models: toModelList(b.models),
				feature_conversations: { ...b.features },
			})),
		hour_of_day: hours,
		day_of_week: weekdays,
		account: {
			created_month:
				typeof input.account.created_at === "string"
					? input.account.created_at.slice(0, 7)
					: null,
			data_residency_region: input.account.data_residency_region,
			compute_residency_region: input.account.compute_residency_region,
		},
		settings: { ...input.settings },
		locale: {
			browser_language: input.client.browser_language,
			network_country: input.client.network_country,
		},
	};
}

// ─── Small readers for the side endpoints ──────────────────────────────

export function readSettingsFlags(
	raw: unknown,
): Record<string, boolean> | null {
	if (!isObj(raw) || !isObj(raw.flags)) return null;
	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(raw.flags).slice(0, 64)) {
		if (typeof v === "boolean" && /^[a-z0-9_]{1,64}$/.test(k)) out[k] = v;
	}
	return out;
}

export function readClientContext(raw: unknown): UsageClientContext {
	const j = isObj(raw) ? raw : {};
	const tz = j.timezone;
	const lang = j.browser_language;
	const country = j.network_country;
	return {
		timezone:
			typeof tz === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)
				? tz
				: null,
		browser_language:
			typeof lang === "string" &&
			/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)
				? lang
				: null,
		network_country:
			typeof country === "string" && /^[A-Z]{2}$/.test(country)
				? country
				: null,
	};
}

/** Residency/creation facts from the accounts/check body. No ids, no profile. */
export function readAccountUsageFacts(raw: unknown): UsageAccountInput {
	const empty: UsageAccountInput = {
		created_at: null,
		data_residency_region: null,
		compute_residency_region: null,
	};
	if (!isObj(raw) || !isObj(raw.accounts)) return empty;
	const accounts = raw.accounts;
	const ordering = Array.isArray(raw.account_ordering)
		? raw.account_ordering.filter((k): k is string => typeof k === "string")
		: [];
	const key = ["default", ...ordering, ...Object.keys(accounts)].find(
		(k) =>
			isObj(accounts[k]) &&
			isObj((accounts[k] as Record<string, unknown>).account),
	);
	if (!key) return empty;
	const account = (accounts[key] as Record<string, unknown>).account as Record<
		string,
		unknown
	>;
	return {
		created_at: tsToIso(account.created_time),
		data_residency_region: slugOrNull(
			typeof account.account_residency_region === "string"
				? account.account_residency_region.toLowerCase()
				: null,
		),
		compute_residency_region: slugOrNull(
			typeof account.account_compute_residency === "string"
				? account.account_compute_residency.toLowerCase()
				: null,
		),
	};
}
