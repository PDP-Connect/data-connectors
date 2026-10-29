// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only synthetic claude.ai for the anthropic_live tests. Not imported by
// index.ts, so it is not part of the connector bundle. The routes and shapes
// are synthetic: they test collection logic, not claude.ai's live API.

import assert from "node:assert/strict";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	makeEmitRecord,
	type RecordData,
	type StreamScope,
	withholdsBoundedProgress,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { CONSENT_TIME_FIELDS } from "../../packages/polyfill-connectors/src/generated/consent-time-fields.generated.ts";
import { validateRecord } from "./schemas.ts";

process.env.PDPP_ANTHROPIC_LIVE_DETAIL_DELAY_MS = "1";

export const ORG = "00000000-0000-4000-8000-0000000000f1";
export const O = `/api/organizations/${ORG}`;
export const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const at = (minute: number) =>
	`2026-01-15T09:${String(minute).padStart(2, "0")}:00.000000Z`;

export const ORGS = [
	{ uuid: uuid(900), capabilities: ["api"], billing_type: "prepaid" },
	{
		uuid: ORG,
		capabilities: ["claude_max", "chat"],
		rate_limit_tier: "default_claude_max_20x",
		billing_type: "stripe_subscription",
		raven_type: null,
		plan_display_name: null,
		created_at: "2025-03-01T12:00:00.000000Z",
	},
];
export const SUBSCRIPTION = {
	status: "active",
	billing_interval: "monthly",
	next_charge_at: "2026-02-01T12:00:00Z",
	plan_ending_at: null,
	payment_method: { type: "card", last4: "4242" },
};
export const USAGE = {
	five_hour: { utilization: 2, resets_at: at(50) },
	limits: [
		{
			kind: "session",
			group: "session",
			percent: 2,
			severity: "normal",
			resets_at: at(50),
			scope: null,
			is_active: false,
		},
		{
			kind: "weekly_scoped",
			group: "weekly",
			percent: 58,
			severity: "critical",
			resets_at: at(55),
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
			is_active: true,
		},
	],
	extra_usage: { used_credits: 12 },
};

export interface Conv {
	uuid: string;
	name: string;
	model: string | null;
	created_at: string;
	updated_at: string;
	is_starred: boolean;
	project_uuid: string | null;
	chat_messages: Record<string, unknown>[];
	/** Organization the conversation belongs to; defaults to ORG. */
	org?: string;
}

/** A conversation with a human message at 09:00 and an answer at `minute`. */
export function conv(
	n: number,
	minute: number,
	model = "claude-sonnet-4-6",
): Conv {
	return {
		uuid: uuid(n),
		name: `Conversation ${n}`,
		model,
		created_at: at(0),
		updated_at: at(minute),
		is_starred: false,
		project_uuid: null,
		chat_messages: [
			{
				uuid: uuid(n * 1000 + 1),
				text: "",
				content: [{ type: "text", text: "question" }],
				sender: "human",
				created_at: at(0),
				updated_at: at(0),
				attachments: [],
				parent_message_uuid: uuid(0),
			},
			{
				uuid: uuid(n * 1000 + 2),
				text: "",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "answer" },
				],
				sender: "assistant",
				created_at: at(minute),
				updated_at: at(minute),
				attachments: [],
				parent_message_uuid: uuid(n * 1000 + 1),
			},
		],
	};
}

/** Set both timestamps of message `index`. */
export function stampMessage(c: Conv, index: number, time: string): void {
	const message = c.chat_messages[index];
	assert.ok(message, `message ${index}`);
	message.created_at = time;
	message.updated_at = time;
}

export type Route = (
	url: URL,
) => { status: number; body?: unknown } | undefined;

export interface HarnessOptions {
	streams?: string[];
	/** Per-stream scope members (time_range, resources, fields). */
	scopes?: Record<string, Partial<StreamScope>>;
	state?: Record<string, unknown>;
	since?: string;
	route?: Route;
	orgs?: unknown;
	collectionMode?: "full_refresh" | "incremental";
	/**
	 * Route records through the shared runtime's makeEmitRecord (time range,
	 * resources, validation) and drop STATE the way the runtime does after a
	 * record was withheld at or after `until`.
	 */
	runtime?: boolean;
}

export function harness(convs: Conv[], options: HarnessOptions = {}) {
	const calls: string[] = [];
	const emitted: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const failures: Array<{ stream: string; retryable: boolean | undefined }> =
		[];
	let heldStates = 0;
	const orgs = options.orgs ?? ORGS;
	const respond = (path: string): { status: number; body?: unknown } => {
		const url = new URL(path, "https://claude.ai");
		const routed = options.route?.(url);
		if (routed) return routed;
		if (url.pathname === "/api/organizations") {
			return { status: 200, body: orgs };
		}
		const orgMatch = /^\/api\/organizations\/([^/]+)(\/.*)?$/.exec(
			url.pathname,
		);
		const orgId = orgMatch?.[1];
		const rest = orgMatch?.[2] ?? "";
		const inOrg = convs.filter((c) => (c.org ?? ORG) === orgId);
		if (rest === "/subscription_details") {
			return { status: 200, body: SUBSCRIPTION };
		}
		if (rest === "/usage") return { status: 200, body: USAGE };
		if (rest === "/chat_conversations") {
			const limit = Number(url.searchParams.get("limit"));
			const offset = Number(url.searchParams.get("offset"));
			// Newest change first; ties in reverse id order, so a tie never
			// happens to list in the connector's own processing order.
			const sorted = [...inOrg].sort(
				(a, b) =>
					b.updated_at.localeCompare(a.updated_at) ||
					b.uuid.localeCompare(a.uuid),
			);
			return {
				status: 200,
				body: sorted
					.slice(offset, offset + limit)
					.map(({ chat_messages: _messages, org: _org, ...item }) => item),
			};
		}
		const detail = inOrg.find((c) => rest === `/chat_conversations/${c.uuid}`);
		if (detail && url.searchParams.get("tree") === "True") {
			const { org: _org, ...body } = detail;
			return { status: 200, body };
		}
		return { status: 404 };
	};
	const fakeFetch = (async (input: string) => {
		calls.push(input);
		const { status, body } = respond(input);
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => {
				if (body === undefined) throw new Error("no body");
				return structuredClone(body);
			},
		};
	}) as unknown as typeof fetch;
	const page = {
		url: () => "https://claude.ai/new",
		goto: async () => null,
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const savedFetch = globalThis.fetch;
			const savedLocation = Object.getOwnPropertyDescriptor(
				globalThis,
				"location",
			);
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "https://claude.ai" },
			});
			globalThis.fetch = fakeFetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = savedFetch;
				if (savedLocation) {
					Object.defineProperty(globalThis, "location", savedLocation);
				} else {
					Reflect.deleteProperty(globalThis, "location");
				}
			}
		},
	};
	const streams = options.streams ?? [
		"conversations",
		"messages",
		"account_plan",
		"usage_limits",
	];
	const requested = new Map<string, StreamScope>(
		streams.map((name) => [
			name,
			{
				name,
				...(options.since ? { time_range: { since: options.since } } : {}),
				...options.scopes?.[name],
			},
		]),
	);
	const push = async (message: EmittedMessage) => {
		emitted.push(message);
	};
	const testEmitRecord = async (stream: string, data: RecordData) => {
		const result = validateRecord(stream, data);
		assert.equal(result.ok, true, `${stream} ${JSON.stringify(result)}`);
		records.push({ stream, data });
	};
	let emit = push;
	let emitRecord = testEmitRecord;
	if (options.runtime) {
		const runtime = makeEmitRecord({
			requested,
			emit: async (message) => {
				if (message.type === "RECORD") {
					records.push({ stream: message.stream, data: message.data });
				}
				emitted.push(message);
			},
			emittedAt: "2026-10-13T00:00:00.000Z",
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: (stream) =>
				CONSENT_TIME_FIELDS.anthropic_live?.[stream] ?? null,
		});
		emitRecord = runtime.emit;
		emit = async (message) => {
			if (withholdsBoundedProgress(message, runtime.withheldAtOrAfterUntil)) {
				heldStates += 1;
				return;
			}
			emitted.push(message);
		};
	}
	const ctx = {
		collectionMode: options.collectionMode ?? "incremental",
		emit: (message: EmittedMessage) => emit(message),
		emitRecord: (stream: string, data: RecordData) => emitRecord(stream, data),
		page,
		progress: async () => undefined,
		reportStreamFailure: async (
			stream: string,
			_message: string,
			opts?: { retryable?: boolean },
		) => {
			failures.push({ stream, retryable: opts?.retryable });
		},
		requested,
		state: options.state ?? {},
	} as unknown as BrowserCollectContext;
	const of = (stream: string) =>
		records.filter((r) => r.stream === stream).map((r) => r.data);
	const ids = (stream: string) => of(stream).map((r) => String(r.id));
	const states = (stream: string) =>
		emitted
			.filter((m) => m.type === "STATE" && m.stream === stream)
			.map((m) => (m as { cursor: Record<string, unknown> }).cursor);
	const skips = () =>
		emitted
			.filter((m) => m.type === "SKIP_RESULT")
			.map((m) => m as unknown as { stream: string; reason: string });
	const detailReads = () =>
		calls
			.filter((c) => c.includes("tree=True"))
			.map((c) => c.split("/chat_conversations/")[1]?.split("?")[0] ?? "");
	/**
	 * The state a runtime would carry into the next run if it committed every
	 * STATE this run emitted (the least forgiving choice: a real runtime
	 * withholds the state of a failed stream).
	 */
	const nextState = () => {
		const next: Record<string, unknown> = { ...(options.state ?? {}) };
		for (const message of emitted) {
			if (message.type === "STATE") next[message.stream] = message.cursor;
		}
		return next;
	};
	return {
		calls,
		ctx,
		detailReads,
		emitted,
		failures,
		heldStates: () => heldStates,
		ids,
		nextState,
		of,
		skips,
		states,
	};
}
