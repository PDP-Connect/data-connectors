// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Usage metadata for the `account_profile` and `usage_summary` streams.
 * Both are account-level aggregates; nothing per conversation is emitted.
 *
 * Privacy contract: these streams carry NO message text, conversation titles
 * or snippets, memory contents, custom-instruction text, task titles or
 * prompts, attachment or file names, tool or action names, email, name,
 * phone, picture, region name, organisation names or provider ids.
 * Provider ids are used inside the run only (to merge lists, pick the
 * sample and count distinct GPTs and projects) and are never emitted.
 *
 * Every read is made through `chatGptUsageFetchInBrowser`, which runs inside
 * the chatgpt.com page and reduces each response to numbers, booleans,
 * validated codes and slugs BEFORE it returns. Text is downloaded by the page
 * (as the web app itself does) but is never handed to the connector process,
 * never captured as a fixture and never emitted. The node side re-validates
 * every projected value; the page is not trusted.
 *
 * Evidence:
 *   Probed live on 2026-10-15 (shapes only, see
 *   __fixtures__/usage-account-endpoints-canary.json): /me, /accounts/check,
 *   /settings/beta_features, /user_system_messages, /memories,
 *   /gizmos/snorlax/sidebar, /tasks, and /conversations?offset&limit&order
 *   (limit max 100; `total` unreliable; item keys incl. pinned_time,
 *   conversation_template_id, gizmo_id, is_temporary_chat,
 *   is_do_not_remember, is_automation_conversation,
 *   latest_assistant_turn_created_at; on the owner's account
 *   latest_assistant_turn_created_at, is_starred and the conversation-level
 *   default_model_slug were null everywhere, so they are not emitted).
 *   /conversations omits project conversations; they are listed from
 *   /gizmos/{id}/conversations?cursor= (status and cursor paging verified
 *   live; the item shape is assumed to mirror /conversations and is read
 *   defensively). /conversations/search was dropped: its items carry a
 *   message-text snippet.
 *   Seen in this repo's code or fixtures: /conversations/batch,
 *   /conversation/{id}, /shared_conversations, mapping/parent/children/
 *   current_node, author.role, author.name, recipient, content.content_type
 *   and parts, metadata.model_slug, metadata.attachments,
 *   image_asset_pointer, execution_output, tether_*, thoughts,
 *   reasoning_recap, tool names "python"/"browser"/"bio".
 *   Assumed (unverified): `?cursor=` paging on /gizmos/snorlax/sidebar and
 *   /tasks, `files` per sidebar item, `&is_archived=true` listing only
 *   archived conversations, /cdn-cgi/trace `loc=`, gizmo_type "snorlax" and
 *   the "g-p-" project prefix, is_visually_hidden_from_conversation,
 *   voice_mode_message and audio part types, async_task_type /
 *   deep_research_version, tool names "web.*", "dalle.*", "image_gen*",
 *   "canmore.*", "research_kickoff_tool*", "file_search*", "myfiles_browser*".
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	ChatGptAuth,
	ChatGptFetchResult,
	ChatGptUsageProjection,
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
		lowerSlug(v: unknown): string | null {
			return typeof v === "string" ? h.slug(v.toLowerCase()) : null;
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
		/** One /conversations list item: timestamps, flags and ids. No title, snippet or URLs. */
		listItem(c: unknown): Record<string, unknown> | null {
			if (!h.isObj(c)) return null;
			const workspaceId = c.workspace_id;
			return {
				id: h.opaqueId(c.id),
				create_time: h.epoch(c.create_time),
				update_time: h.epoch(c.update_time),
				latest_assistant_turn_at: h.epoch(c.latest_assistant_turn_created_at),
				is_pinned:
					c.pinned_time === undefined
						? null
						: c.pinned_time !== null && c.pinned_time !== false,
				gizmo_id: h.opaqueId(c.gizmo_id),
				template_id: h.opaqueId(c.conversation_template_id),
				is_archived: h.bool(c.is_archived),
				is_temporary_chat: h.bool(c.is_temporary_chat),
				is_do_not_remember: h.bool(c.is_do_not_remember),
				is_automation: h.bool(c.is_automation_conversation),
				in_workspace:
					typeof workspaceId === "string"
						? workspaceId.length > 0
						: workspaceId === null
							? false
							: null,
			};
		},
		/** The session's account entry of an accounts/check body: `default`, then ordering, then any. */
		accountEntry(j: Record<string, unknown>): Record<string, unknown> | null {
			const accounts = h.isObj(j.accounts) ? j.accounts : null;
			if (!accounts) return null;
			if (accounts.default !== undefined) {
				const d = accounts.default;
				return h.isObj(d) && h.isObj(d.account) ? d : null;
			}
			const ordering = Array.isArray(j.account_ordering)
				? j.account_ordering.filter((k): k is string => typeof k === "string")
				: [];
			for (const key of [...ordering, ...Object.keys(accounts)]) {
				const entry = accounts[key];
				if (h.isObj(entry) && h.isObj(entry.account)) return entry;
			}
			return null;
		},
		/** Cursor for the next page, only when it is a plain opaque token. */
		cursor(v: unknown): string | null {
			if (typeof v === "number" && Number.isInteger(v) && v >= 0)
				return String(v);
			return typeof v === "string" && /^[A-Za-z0-9_\-=+/.:]{1,512}$/.test(v)
				? v
				: null;
		},
		project(raw: unknown): unknown {
			const j = h.isObj(raw) ? raw : {};
			switch (projection) {
				case "conversation_detail":
					return Array.isArray(raw)
						? raw.map((c) => h.conversation(c))
						: h.conversation(raw);
				case "conversation_list": {
					const items = Array.isArray(j.items) ? j.items : null;
					return {
						items: items ? items.map((c) => h.listItem(c)) : null,
						raw_count: items ? items.length : null,
						total: h.count(j.total),
						// Project listings page by cursor; the main list ignores these.
						cursor: h.cursor(j.cursor),
						// An explicit has_more wins; otherwise a cursor means more.
						has_more:
							typeof j.has_more === "boolean"
								? j.has_more
								: j.cursor !== null && j.cursor !== undefined,
					};
				}
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
						name_set: h.nonEmpty(j.name_user_message),
						role_set: h.nonEmpty(j.role_user_message),
						traits_set: h.nonEmpty(j.traits_model_message),
						other_set: h.nonEmpty(j.other_user_message),
						personality_set: h.nonEmpty(j.personality_type_selection),
						traits_enabled: h.bool(j.traits_enabled),
						disabled_tools_count: Array.isArray(j.disabled_tools)
							? j.disabled_tools.length
							: null,
					};
				case "me_profile": {
					const orgs =
						h.isObj(j.orgs) && Array.isArray(j.orgs.data) ? j.orgs.data : null;
					const country = j.country;
					const region = j.region_code;
					return {
						created: h.epoch(j.created),
						mfa_enabled: h.bool(j.mfa_flag_enabled),
						email_domain_type: h.slug(j.email_domain_type),
						country:
							typeof country === "string" && /^[A-Z]{2}$/.test(country)
								? country
								: null,
						region_code:
							typeof region === "string" && /^[A-Z0-9]{1,3}$/.test(region)
								? region
								: null,
						org_count: orgs ? orgs.length : null,
						has_non_personal_org: orgs
							? orgs.some((o) => h.isObj(o) && o.personal === false)
							: null,
					};
				}
				case "account_check_facts": {
					const entry = h.accountEntry(j);
					if (!entry) return { found: false };
					const a = h.isObj(entry.account) ? entry.account : {};
					const e = h.isObj(entry.entitlement) ? entry.entitlement : {};
					const last = h.isObj(entry.last_active_subscription)
						? entry.last_active_subscription
						: {};
					const currency = e.billing_currency;
					return {
						found: true,
						created_time: h.epoch(a.created_time),
						workspace_type: h.slug(a.workspace_type),
						is_deactivated: h.bool(a.is_deactivated),
						is_trial: h.bool(a.is_trial),
						trial_state: h.slug(a.trial_state),
						has_previously_paid_subscription: h.bool(
							a.has_previously_paid_subscription,
						),
						last_expired_subscription_was_gratis: h.bool(
							a.is_most_recent_expired_subscription_gratis,
						),
						data_residency_region: h.lowerSlug(a.account_residency_region),
						compute_residency_region: h.lowerSlug(a.account_compute_residency),
						feature_flag_count: Array.isArray(entry.features)
							? entry.features.length
							: null,
						is_gratis: h.bool(e.is_active_subscription_gratis),
						billing_currency:
							typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
								? currency
								: null,
						is_delinquent: h.bool(e.is_delinquent),
						in_grace_period:
							"grace_period_end_timestamp" in e
								? e.grace_period_end_timestamp !== null
								: null,
						purchase_origin_platform: h.slug(last.purchase_origin_platform),
					};
				}
				case "beta_features": {
					const s = h.isObj(j.settings) ? j.settings : j;
					const flags = Object.entries(s).filter(
						(e) => typeof e[1] === "boolean",
					);
					return {
						flag_count: flags.length,
						enabled: flags
							.filter((e) => e[1] === true && /^[a-z0-9_]{1,64}$/.test(e[0]))
							.map((e) => e[0])
							.sort()
							.slice(0, 256),
					};
				}
				case "project_sidebar": {
					const items = Array.isArray(j.items) ? j.items : null;
					let files = 0;
					const ids: string[] = [];
					for (const item of items ?? []) {
						if (!h.isObj(item)) continue;
						const g = h.isObj(item.gizmo) ? item.gizmo : {};
						const inner = h.isObj(g.gizmo) ? g.gizmo : {};
						const id = h.opaqueId(inner.id) ?? h.opaqueId(g.id);
						if (id) ids.push(id);
						const list = Array.isArray(item.files)
							? item.files
							: Array.isArray(g.files)
								? g.files
								: [];
						files += list.length;
					}
					return {
						item_count: items ? items.length : null,
						file_count: items ? files : null,
						project_ids: ids,
						cursor: h.cursor(j.cursor),
						// An explicit has_more wins; otherwise a cursor means more.
						has_more:
							typeof j.has_more === "boolean"
								? j.has_more
								: j.cursor !== null && j.cursor !== undefined,
					};
				}
				case "task_stats": {
					const tasks = Array.isArray(j.tasks)
						? j.tasks
						: Array.isArray(j.items)
							? j.items
							: null;
					const byStatus = new Map<string, number>();
					for (const t of tasks ?? []) {
						h.bump(
							byStatus,
							(h.isObj(t) ? h.slug(t.status) : null) ?? "unknown",
						);
					}
					return {
						task_count: tasks ? tasks.length : null,
						by_status: Object.fromEntries(byStatus),
						cursor: h.cursor(j.cursor),
						// An explicit has_more wins; otherwise a cursor means more.
						has_more:
							typeof j.has_more === "boolean"
								? j.has_more
								: j.cursor !== null && j.cursor !== undefined,
					};
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

// ─── Fixture capture ───────────────────────────────────────────────────

const CAPTURE_SAFE_QUERY_KEYS = new Set([
	"offset",
	"limit",
	"order",
	"is_archived",
	"include_memory_entries",
]);

/**
 * Label and path under which a projected usage read may be captured as a
 * fixture: provider ids in the path become `{conversation_id}` /
 * `{gizmo_id}`, and query values other than paging/flags (cursors) become
 * `{redacted}`. Raw ids must not reach fixture file names, labels or
 * metadata.
 */
export function usageCaptureRoute(path: string): string {
	const q = path.indexOf("?");
	const base = q === -1 ? path : path.slice(0, q);
	const query = q === -1 ? "" : path.slice(q + 1);
	const route = base
		.replace(/^\/conversation\/[^/]+$/, "/conversation/{conversation_id}")
		.replace(
			/^\/gizmos\/(?!snorlax\/)[^/]+\/conversations$/,
			"/gizmos/{gizmo_id}/conversations",
		);
	if (!query) return route;
	const params = query.split("&").map((kv) => {
		const key = kv.split("=")[0] ?? "";
		return CAPTURE_SAFE_QUERY_KEYS.has(key) ? kv : `${key}={redacted}`;
	});
	return `${route}?${params.join("&")}`;
}

const CAPTURE_ID_KEYS: Record<string, string> = {
	id: "{conversation_id}",
	conversation_id: "{conversation_id}",
	gizmo_id: "{gizmo_id}",
	template_id: "{gizmo_id}",
	project_ids: "{gizmo_id}",
	cursor: "{redacted}",
};

/**
 * Copy of a projected usage body safe to capture as a fixture: every value
 * under an id-bearing key (conversation, gizmo and template ids, project id
 * lists) and every cursor becomes a placeholder. Counts, flags and
 * timestamps are kept, so the fixture still shows the shape.
 */
export function usageCaptureBody(body: unknown): unknown {
	if (Array.isArray(body)) return body.map((v) => usageCaptureBody(v));
	if (typeof body !== "object" || body === null) return body;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		const placeholder = CAPTURE_ID_KEYS[k];
		if (placeholder !== undefined && v !== null && v !== undefined) {
			out[k] = Array.isArray(v) ? v.map(() => placeholder) : placeholder;
		} else {
			out[k] = usageCaptureBody(v);
		}
	}
	return out;
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

// ─── Conversation list (node side) ─────────────────────────────────────

/** One `/conversations` list item after the in-page projection. No title or text. */
export interface UsageListItem {
	id: string;
	create_time: number | null;
	update_time: number | null;
	latest_assistant_turn_at: number | null;
	is_pinned: boolean | null;
	gizmo_id: string | null;
	template_id: string | null;
	is_archived: boolean | null;
	is_temporary_chat: boolean | null;
	is_do_not_remember: boolean | null;
	is_automation: boolean | null;
	in_workspace: boolean | null;
}

export interface ConversationListPage {
	items: UsageListItem[];
	/** Items the provider returned on this page, before validation. Drives the stop rule. */
	raw_count: number;
}

/** Re-validate one projected list page. Null when the page has no item array. */
export function readConversationListPage(
	raw: unknown,
): ConversationListPage | null {
	if (!isObj(raw) || !Array.isArray(raw.items)) return null;
	const items: UsageListItem[] = [];
	for (const c of raw.items) {
		if (!isObj(c)) continue;
		const id = idOrNull(c.id);
		if (!id) continue;
		items.push({
			id,
			create_time: epochOrNull(c.create_time),
			update_time: epochOrNull(c.update_time),
			latest_assistant_turn_at: epochOrNull(c.latest_assistant_turn_at),
			is_pinned: boolOrNull(c.is_pinned),
			gizmo_id: idOrNull(c.gizmo_id),
			template_id: idOrNull(c.template_id),
			is_archived: boolOrNull(c.is_archived),
			is_temporary_chat: boolOrNull(c.is_temporary_chat),
			is_do_not_remember: boolOrNull(c.is_do_not_remember),
			is_automation: boolOrNull(c.is_automation),
			in_workspace: boolOrNull(c.in_workspace),
		});
	}
	const rawCount =
		typeof raw.raw_count === "number" && Number.isInteger(raw.raw_count)
			? Math.max(raw.raw_count, raw.items.length)
			: raw.items.length;
	return { items, raw_count: rawCount };
}

const maxOrNull = (a: number | null, b: number | null): number | null =>
	a === null ? b : b === null ? a : Math.max(a, b);
const minOrNull = (a: number | null, b: number | null): number | null =>
	a === null ? b : b === null ? a : Math.min(a, b);
const orFlag = (a: boolean | null, b: boolean | null): boolean | null =>
	a === true || b === true ? true : a === false || b === false ? false : null;

/**
 * Merge two list entries for the same conversation (main, archived and
 * project listings overlap). Timestamps take the freshest view (latest
 * update, earliest create), flags are OR-ed, and a gizmo or template id from
 * either copy is kept, so the order the listings arrive in does not matter.
 */
export function mergeListItems(
	a: UsageListItem,
	b: UsageListItem,
): UsageListItem {
	return {
		id: a.id,
		create_time: minOrNull(a.create_time, b.create_time),
		update_time: maxOrNull(a.update_time, b.update_time),
		latest_assistant_turn_at: maxOrNull(
			a.latest_assistant_turn_at,
			b.latest_assistant_turn_at,
		),
		is_pinned: orFlag(a.is_pinned, b.is_pinned),
		gizmo_id: a.gizmo_id ?? b.gizmo_id,
		template_id: a.template_id ?? b.template_id,
		is_archived: orFlag(a.is_archived, b.is_archived),
		is_temporary_chat: orFlag(a.is_temporary_chat, b.is_temporary_chat),
		is_do_not_remember: orFlag(a.is_do_not_remember, b.is_do_not_remember),
		is_automation: orFlag(a.is_automation, b.is_automation),
		in_workspace: orFlag(a.in_workspace, b.in_workspace),
	};
}

/** Latest known activity on a conversation from list fields. */
export function lastActivityOf(c: UsageListItem): number | null {
	const ts = [c.update_time, c.latest_assistant_turn_at, c.create_time].filter(
		(t): t is number => t !== null,
	);
	return ts.length > 0 ? Math.max(...ts) : null;
}

// ─── Conversation classification ──────────────────────────────────────

export type DetailStatus = "fetched" | "not_fetched" | "unavailable" | "failed";

export type GizmoKind = "none" | "custom_gpt" | "project" | "other";

/**
 * Projects are gizmos whose ids start "g-p-" (verified live); custom GPT ids
 * start "g-". gizmo_type "snorlax" also marks a project.
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

// ─── usage_summary record ──────────────────────────────────────────────

export interface UsageClientContext {
	timezone: string | null;
	browser_language: string | null;
	network_country: string | null;
}

/** Whether this run read a detail sample. */
export type DetailMode = "sample" | "none";

export interface UsageSummaryConversation {
	list: UsageListItem;
	/** Detail projection when this conversation was read this run. */
	projection: ConversationUsageProjection | null;
	/** Outcome of this run's detail read; not_fetched when not targeted. */
	detailStatus: DetailStatus;
	/** One of this run's N most recently updated conversations. */
	inSample: boolean;
}

/**
 * Project conversations are missing from `/conversations`; they are listed
 * per project from `/gizmos/{id}/conversations`. A failed project does not
 * fail the summary; it is counted here.
 */
export interface ProjectListingCoverage {
	/** Outcome of the sidebar read that names the projects. */
	sidebar: "ok" | "not_available" | "failed" | "partial";
	projects: number;
	pages: number;
	failed: number;
	/** The run-wide project or page budget left projects or pages unread. */
	truncated: boolean;
	/** Conversations found only through a project listing. */
	conversations_added: number;
}

export interface UsageSummaryInput {
	conversations: readonly UsageSummaryConversation[];
	/** Raw ids of conversations with a share link; null when shares were not read. */
	sharedIds: ReadonlySet<string> | null;
	client: UsageClientContext;
	coverage: {
		archived_listing: "read" | "not_available";
		list_pages: number;
		detail_mode: DetailMode;
		project_listing: ProjectListingCoverage;
		/**
		 * False when the project listing was incomplete (sidebar failed or
		 * partial, a project failed, or the budget truncated it). The summary is
		 * still built from what was listed, but it may miss conversations and
		 * the sample may miss the newest ones, so `detail_sample.complete` is
		 * false too.
		 */
		listing_complete: boolean;
	};
	/** False when a provider deferral stopped the sample before every target was tried. */
	sampleComplete: boolean;
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

function longestStreak(days: ReadonlySet<string>): number {
	const sorted = [...days].sort();
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

function mean(total: number, n: number): number | null {
	return n > 0 ? Math.round((total / n) * 10) / 10 : null;
}

function ratio(part: number, whole: number): number | null {
	return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
}

function emptyFeatures(): Record<UsageFeature, number> {
	return Object.fromEntries(USAGE_FEATURES.map((k) => [k, 0])) as Record<
		UsageFeature,
		number
	>;
}

const isoOrNull = (t: number | null): string | null =>
	t === null ? null : new Date(t * 1000).toISOString();

/**
 * Aggregate the run into the singleton usage_summary record.
 *
 * Exact (every listed conversation, list fields only): totals, flags, custom
 * GPT and project share, month buckets, active days, streak, hour/day
 * histograms, first/last activity. Activity is read from conversation
 * timestamps (start, last update, last assistant turn), not from messages:
 * a day counts as active when a conversation started or was last touched on
 * it, so days in the middle of a long conversation are not counted and an
 * update with no new message (rename, archive) is.
 *
 * Sample-based (`detail_sample`): message counts, model mix and feature use
 * from the conversations read in detail this run.
 *
 * All bucketing is in the page's IANA timezone, or UTC when it is unknown.
 */
export function buildUsageSummaryRecord(input: UsageSummaryInput): RecordData {
	const timezone = resolveTimezone(input.client.timezone);
	const local = makeLocalizer(timezone);
	const months = new Map<
		string,
		{ created: number; lastActive: number; days: Set<string> }
	>();
	const bucket = (m: string) => {
		let b = months.get(m);
		if (!b) {
			b = { created: 0, lastActive: 0, days: new Set() };
			months.set(m, b);
		}
		return b;
	};
	const hours = new Array<number>(24).fill(0);
	const weekdays = new Array<number>(7).fill(0);
	const days = new Set<string>();
	const gizmos = { custom_gpt: new Set<string>(), project: new Set<string>() };
	let first: number | null = null;
	let last: number | null = null;
	let sharedKnown = true;
	const totals = {
		conversations: 0,
		archived: 0,
		pinned: 0,
		shared: 0,
		in_workspace: 0,
		custom_gpt_conversations: 0,
		project_conversations: 0,
		temporary_conversations: 0,
		automation_conversations: 0,
		do_not_remember_conversations: 0,
	};
	const coverage = {
		detail_fetched: 0,
		detail_unavailable: 0,
		detail_failed: 0,
		detail_not_read: 0,
	};
	for (const { list: c, detailStatus: status } of input.conversations) {
		totals.conversations += 1;
		if (status === "fetched") coverage.detail_fetched += 1;
		else if (status === "unavailable") coverage.detail_unavailable += 1;
		else if (status === "failed") coverage.detail_failed += 1;
		else coverage.detail_not_read += 1;
		if (c.is_archived === true) totals.archived += 1;
		if (c.is_pinned === true) totals.pinned += 1;
		if (c.in_workspace === true) totals.in_workspace += 1;
		if (c.is_temporary_chat === true) totals.temporary_conversations += 1;
		if (c.is_automation === true) totals.automation_conversations += 1;
		if (c.is_do_not_remember === true)
			totals.do_not_remember_conversations += 1;
		if (input.sharedIds === null) sharedKnown = false;
		else if (input.sharedIds.has(c.id)) totals.shared += 1;
		// Raw gizmo ids are only counted here; none is emitted.
		const gizmoId = c.gizmo_id ?? c.template_id;
		const kind = gizmoKind(gizmoId, null);
		if (kind === "custom_gpt") {
			totals.custom_gpt_conversations += 1;
			if (gizmoId) gizmos.custom_gpt.add(gizmoId);
		} else if (kind === "project") {
			totals.project_conversations += 1;
			if (gizmoId) gizmos.project.add(gizmoId);
		}
		if (c.create_time !== null) {
			const lp = local(c.create_time);
			bucket(lp.month).created += 1;
			hours[lp.hour] = (hours[lp.hour] ?? 0) + 1;
			weekdays[lp.weekday] = (weekdays[lp.weekday] ?? 0) + 1;
			first = first === null ? c.create_time : Math.min(first, c.create_time);
		}
		const lastAt = lastActivityOf(c);
		if (lastAt !== null) {
			bucket(local(lastAt).month).lastActive += 1;
			last = last === null ? lastAt : Math.max(last, lastAt);
			if (first === null || lastAt < first) first = lastAt;
		}
		for (const t of [
			c.create_time,
			c.update_time,
			c.latest_assistant_turn_at,
		]) {
			if (t === null) continue;
			const lp = local(t);
			days.add(lp.day);
			bucket(lp.month).days.add(lp.day);
		}
	}
	const n = totals.conversations;
	return {
		id: "usage_summary",
		timezone,
		timezone_source:
			input.client.timezone === timezone ? "browser" : "default_utc",
		activity_basis: "conversation_timestamps",
		coverage: {
			conversations_listed: n,
			archived_listing: input.coverage.archived_listing,
			list_pages: input.coverage.list_pages,
			detail_mode: input.coverage.detail_mode,
			listing_complete: input.coverage.listing_complete,
			project_listing: { ...input.coverage.project_listing },
			...coverage,
		},
		first_activity_at: isoOrNull(first),
		last_activity_at: isoOrNull(last),
		history_span_days:
			first !== null && last !== null
				? Math.max(0, Math.floor((last - first) / 86_400))
				: null,
		active_days: days.size,
		longest_streak_days: longestStreak(days),
		totals: {
			...totals,
			shared: sharedKnown ? totals.shared : null,
			custom_gpts_used: gizmos.custom_gpt.size,
			projects_used: gizmos.project.size,
		},
		custom_gpt_share: ratio(totals.custom_gpt_conversations, n),
		project_share: ratio(totals.project_conversations, n),
		months: [...months.entries()]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([month, b]) => ({
				month,
				conversations_created: b.created,
				conversations_last_active: b.lastActive,
				active_days: b.days.size,
			})),
		hour_of_day: hours,
		day_of_week: weekdays,
		detail_sample: buildDetailSample(input),
		locale: { browser_language: input.client.browser_language },
	};
}

/**
 * Message-level facts from the sampled conversations only. Null when the run
 * targeted no sample (list-only or an explicit selection without sampling).
 */
function buildDetailSample(input: UsageSummaryInput): RecordData | null {
	const sample = input.conversations.filter((c) => c.inSample);
	if (sample.length === 0) return null;
	const read = sample.filter(
		(
			c,
		): c is UsageSummaryConversation & {
			projection: ConversationUsageProjection;
		} => c.projection !== null,
	);
	const models = new Map<string, number>();
	const features = emptyFeatures();
	const perConversation: number[] = [];
	const userPerConversation: number[] = [];
	const t = {
		user_messages: 0,
		assistant_messages: 0,
		tool_messages: 0,
		user_attachments: 0,
		user_images: 0,
		user_chars_total: 0,
		regenerated_or_edited_conversations: 0,
	};
	for (const { projection: p } of read) {
		t.user_messages += p.counts.user;
		t.assistant_messages += p.counts.assistant;
		t.tool_messages += p.counts.tool;
		t.user_attachments += p.user_attachments;
		t.user_images += p.user_images;
		t.user_chars_total += p.user_chars_total;
		if (p.branch_count > 1) t.regenerated_or_edited_conversations += 1;
		perConversation.push(p.counts.user + p.counts.assistant);
		userPerConversation.push(p.counts.user);
		for (const m of p.models) {
			models.set(m.slug, (models.get(m.slug) ?? 0) + m.assistant_messages);
		}
		for (const f of USAGE_FEATURES) if (p.features[f] > 0) features[f] += 1;
	}
	const windowTimes = sample
		.map((c) => lastActivityOf(c.list))
		.filter((x): x is number => x !== null);
	return {
		basis: "most_recently_updated",
		n_conversations: sample.length,
		n_read: read.length,
		complete: input.sampleComplete && input.coverage.listing_complete,
		window_start: isoOrNull(
			windowTimes.length > 0 ? Math.min(...windowTimes) : null,
		),
		window_end: isoOrNull(
			windowTimes.length > 0 ? Math.max(...windowTimes) : null,
		),
		...t,
		messages_per_conversation: {
			mean: mean(
				perConversation.reduce((a, b) => a + b, 0),
				perConversation.length,
			),
			median: median(perConversation),
		},
		user_messages_per_conversation: {
			mean: mean(t.user_messages, userPerConversation.length),
			median: median(userPerConversation),
		},
		user_chars_mean_per_message:
			t.user_messages > 0
				? Math.round(t.user_chars_total / t.user_messages)
				: null,
		models: [...models.entries()]
			.map(([slug, assistant_messages]) => ({ slug, assistant_messages }))
			.sort(byCountThenSlug),
		feature_conversations: features,
	};
}

// ─── account_profile record ────────────────────────────────────────────

export type ProfileSourceStatus = "ok" | "not_available" | "failed" | "partial";

export const ACCOUNT_PROFILE_SOURCES = [
	"me",
	"accounts_check",
	"beta_features",
	"custom_instructions",
	"memories",
	"projects",
	"tasks",
	"network",
] as const;
export type AccountProfileSource = (typeof ACCOUNT_PROFILE_SOURCES)[number];

export interface AccountProfileInput {
	/** In-page projections; null when that endpoint gave nothing usable. */
	me: Record<string, unknown> | null;
	account: Record<string, unknown> | null;
	betaFeatures: Record<string, unknown> | null;
	instructions: Record<string, unknown> | null;
	memory: Record<string, unknown> | null;
	projects: { count: number; files: number } | null;
	tasks: { count: number; by_status: Record<string, number> } | null;
	client: UsageClientContext;
	sources: Record<AccountProfileSource, ProfileSourceStatus>;
	/** Collection time, epoch ms. Only `tenure_months` depends on it. */
	nowMs: number;
}

const COUNTRY = /^[A-Z]{2}$/;
const REGION_CODE = /^[A-Z0-9]{1,3}$/;
const CURRENCY = /^[A-Z]{3}$/;
const FLAG_KEY = /^[a-z0-9_]{1,64}$/;

const matchOrNull = (v: unknown, re: RegExp): string | null =>
	typeof v === "string" && re.test(v) ? v : null;
const countOrNull = (v: unknown): number | null =>
	typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

function wholeMonthsBetween(fromSec: number, toMs: number): number {
	const a = new Date(fromSec * 1000);
	const b = new Date(toMs);
	let m =
		(b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
		(b.getUTCMonth() - a.getUTCMonth());
	if (b.getUTCDate() < a.getUTCDate()) m -= 1;
	return Math.max(0, m);
}

/**
 * Build the singleton account_profile record from the in-page projections of
 * /me, /accounts/check, /settings/beta_features, /user_system_messages,
 * /memories, /gizmos/snorlax/sidebar, /tasks and /cdn-cgi/trace. Every value
 * is re-validated here; a source that failed leaves its fields null and says
 * so in `source_status`.
 *
 * Plan type, renewal/expiry/cancellation dates, billing period, scheduled
 * plan change and active-subscription state are NOT repeated here: the
 * account_plan stream carries them from the same accounts/check body.
 */
export function buildAccountProfileRecord(
	input: AccountProfileInput,
): RecordData {
	const me = input.me ?? {};
	const acct = input.account?.found === true ? input.account : {};
	const ci = input.instructions ?? {};
	const mem = input.memory ?? {};
	const beta = input.betaFeatures;
	const userCreated = epochOrNull(me.created);
	const accountCreated = epochOrNull(acct.created_time);
	const meCountry = matchOrNull(me.country, COUNTRY);
	const networkCountry = matchOrNull(input.client.network_country, COUNTRY);
	const enabled = Array.isArray(beta?.enabled)
		? [
				...new Set(
					beta.enabled.filter(
						(k): k is string => typeof k === "string" && FLAG_KEY.test(k),
					),
				),
			]
				.sort()
				.slice(0, 256)
		: null;
	return {
		id: "account_profile",
		// Two different moments: /me.created is when the user signed up;
		// accounts/check created_time is when the current (e.g. paid) account
		// was created. account_plan.account_created_at carries the latter.
		user_created_at: isoOrNull(userCreated),
		chatgpt_account_created_at: isoOrNull(accountCreated),
		tenure_months:
			userCreated === null
				? null
				: wholeMonthsBetween(userCreated, input.nowMs),
		country: meCountry ?? networkCountry,
		// SUB-NATIONAL (e.g. a state or province code). Together with other
		// fields it raises re-identification risk; whether to coarsen or drop
		// it is a legal decision, not made here.
		region_code: matchOrNull(me.region_code, REGION_CODE),
		geography_source: meCountry
			? "account_profile"
			: networkCountry
				? "network"
				: null,
		network_country: networkCountry,
		billing_currency: matchOrNull(acct.billing_currency, CURRENCY),
		mfa_enabled: boolOrNull(me.mfa_enabled),
		email_domain_type: slugOrNull(me.email_domain_type),
		org_count: countOrNull(me.org_count),
		has_non_personal_org: boolOrNull(me.has_non_personal_org),
		workspace_type: slugOrNull(acct.workspace_type),
		is_deactivated: boolOrNull(acct.is_deactivated),
		data_residency_region: slugOrNull(acct.data_residency_region),
		compute_residency_region: slugOrNull(acct.compute_residency_region),
		is_gratis: boolOrNull(acct.is_gratis),
		is_trial: boolOrNull(acct.is_trial),
		trial_state: slugOrNull(acct.trial_state),
		has_previously_paid_subscription: boolOrNull(
			acct.has_previously_paid_subscription,
		),
		last_expired_subscription_was_gratis: boolOrNull(
			acct.last_expired_subscription_was_gratis,
		),
		purchase_origin_platform: slugOrNull(acct.purchase_origin_platform),
		is_delinquent: boolOrNull(acct.is_delinquent),
		in_grace_period: boolOrNull(acct.in_grace_period),
		account_feature_flag_count: countOrNull(acct.feature_flag_count),
		enabled_beta_features: enabled,
		beta_feature_flag_count: countOrNull(beta?.flag_count),
		custom_instructions_enabled: boolOrNull(ci.enabled),
		custom_instructions_about_user_set: boolOrNull(ci.about_user_set),
		custom_instructions_response_style_set: boolOrNull(ci.response_style_set),
		custom_instructions_name_set: boolOrNull(ci.name_set),
		custom_instructions_role_set: boolOrNull(ci.role_set),
		custom_instructions_traits_set: boolOrNull(ci.traits_set),
		custom_instructions_other_set: boolOrNull(ci.other_set),
		personality_set: boolOrNull(ci.personality_set),
		traits_enabled: boolOrNull(ci.traits_enabled),
		disabled_tools_count: countOrNull(ci.disabled_tools_count),
		memory_count: countOrNull(mem.memory_count),
		memory_tokens_used: countOrNull(mem.memory_num_tokens),
		memory_tokens_max: countOrNull(mem.memory_max_tokens),
		project_count: input.projects?.count ?? null,
		project_file_count: input.projects?.files ?? null,
		scheduled_task_count: input.tasks?.count ?? null,
		scheduled_tasks_by_status: input.tasks
			? Object.fromEntries(
					Object.entries(input.tasks.by_status)
						.filter(([k, v]) => SLUG.test(k) && countOrNull(v) !== null)
						.sort(([a], [b]) => (a < b ? -1 : 1))
						.slice(0, 32),
				)
			: null,
		source_status: { ...input.sources },
	};
}

// ─── Small readers for the side endpoints ──────────────────────────────

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
			typeof country === "string" && COUNTRY.test(country) ? country : null,
	};
}
