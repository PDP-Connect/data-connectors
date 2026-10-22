// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Restart-level oracles for Gmail collection progress. Each test drives
// `runAllMailPasses` over a range-respecting in-memory mailbox, carries the
// emitted STATE into the next run exactly as the runtime would, and asserts
// what an owner would see: which records exist, and whether the walk ends.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { runAllMailPasses } from "./index.ts";
import type { EmittedMessage, StreamRequest } from "./types.ts";

const NOW = "2026-10-21T00:00:00.000Z";
const ALL_MAIL = { path: "[Gmail]/All Mail" } as ListResponse;

function message(uid: number, threadId = "99"): FetchMessageObject {
	return {
		seq: uid,
		uid,
		emailId: uid.toString(16),
		threadId,
		flags: new Set(["\\Seen"]),
		labels: new Set([`label-${uid}`]),
		internalDate: new Date(NOW),
		size: 20,
		headers: Buffer.from(""),
		envelope: {
			subject: "Conversation",
			from: [{ address: `person-${uid}@example.com` }],
		},
		bodyStructure: { type: "text/plain", part: "1", encoding: "7bit" },
	};
}

function attachmentMessage(uid: number): FetchMessageObject {
	return {
		...message(uid),
		bodyStructure: {
			type: "multipart/mixed",
			childNodes: [
				{ type: "text/plain", part: "1", encoding: "7bit" },
				{
					type: "application/pdf",
					part: "2",
					disposition: "attachment",
					dispositionParameters: { filename: `f-${uid}.pdf` },
					size: 20,
				},
			],
		},
	};
}

/** A message received at `iso`. */
function dated(uid: number, iso: string): FetchMessageObject {
	return { ...message(uid), internalDate: new Date(iso) };
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

/** Days since epoch for an IMAP "DD-Mon-YYYY" string or a Date. */
function imapDay(v: unknown): number {
	if (v instanceof Date) return dayOf(v);
	const [d, mon, y] = String(v).split("-");
	return Math.floor(
		Date.UTC(Number(y), MONTHS.indexOf(String(mon)), Number(d)) / 86_400_000,
	);
}

function dayOf(date: unknown): number {
	return Math.floor(new Date(date as string).getTime() / 86_400_000);
}

function requested(names: string[]): Map<string, StreamRequest> {
	return new Map(names.map((name) => [name, { name }]));
}

/** Pre-ledger STATE as main wrote it: history complete through 1200. */
function legacyState(through = 1200, forward = 1201) {
	return {
		messages: {
			all_mail: {
				uidvalidity: 123,
				uidnext: through + 1,
				forward_uidnext: forward,
				exists: 1200,
			},
			backfill: {
				uidvalidity: 123,
				backfilled_through_uid: through,
				target_uid: forward - 1,
				completed_at: through === forward - 1 ? NOW : null,
			},
		},
	};
}

function mailbox(rows: FetchMessageObject[], uidNext: number, exists = 1200) {
	const ranges: string[] = [];
	const bodyReads = new Map<number, number>();
	const box = {
		path: ALL_MAIL.path,
		delimiter: "/",
		exists,
		flags: new Set<string>(),
		uidNext,
		uidValidity: 123n,
	};
	const control = {
		failBodyReadAfter: Number.POSITIVE_INFINITY,
		expungeOnFetch: null as number | null,
		searches: [] as Record<string, unknown>[],
		/** A UID that SEARCH still reports but FETCH no longer returns. */
		phantomSearchUid: null as number | null,
		bodyText: "saved snippet",
		/** How fetchOne answers: the part, the part as NIL, or no message. */
		bodyReply: "part" as "part" | "nil-part" | "no-message",
	};
	const inRange = (range: string, uid: number) =>
		range.split(",").some((part) => {
			const [a, b] = part.split(":");
			if (b === undefined) return Number(a) === uid;
			const hi = b === "*" ? box.uidNext - 1 : Number(b);
			return uid >= Number(a) && uid <= hi;
		});
	const client = {
		mailbox: box,
		usable: true,
		close() {},
		download() {
			return Promise.resolve({
				meta: { contentType: "application/pdf" },
				content: (async function* () {
					yield Buffer.from("pdf-bytes");
				})(),
			});
		},
		async search(query: {
			threadId?: string;
			or?: { threadId: string }[];
			since?: unknown;
			before?: unknown;
		}) {
			control.searches.push(query);
			// IMAP SINCE/BEFORE are day-granular; the fixture models that.
			const day = (v: unknown) => imapDay(v);
			const uids = rows
				.filter(
					(row) =>
						(query.threadId === undefined || row.threadId === query.threadId) &&
						(query.or === undefined ||
							query.or.some((clause) => clause.threadId === row.threadId)) &&
						(query.since === undefined ||
							dayOf(row.internalDate) >= day(query.since)) &&
						(query.before === undefined ||
							dayOf(row.internalDate) < day(query.before)),
				)
				.map((row) => row.uid);
			if (control.phantomSearchUid !== null && query.since === undefined) {
				uids.push(control.phantomSearchUid);
			}
			return uids;
		},
		async fetchOne(uid: string | number) {
			const n = Number(uid);
			const reads = (bodyReads.get(n) ?? 0) + 1;
			bodyReads.set(n, reads);
			if (reads > control.failBodyReadAfter) {
				throw new Error("temporary body transport failure");
			}
			const row = rows.find((r) => r.uid === n);
			if (!row || control.bodyReply === "no-message") return false;
			return {
				...row,
				bodyParts:
					control.bodyReply === "nil-part"
						? new Map([["1", null]])
						: new Map([["1", Buffer.from(control.bodyText)]]),
			};
		},
		async *fetch(range: string) {
			ranges.push(range);
			if (control.expungeOnFetch !== null) {
				const gone = control.expungeOnFetch;
				control.expungeOnFetch = null;
				const i = rows.findIndex((r) => r.uid === gone);
				if (i >= 0) rows.splice(i, 1);
			}
			for (const row of [...rows].sort((a, b) => a.uid - b.uid)) {
				if (inRange(range, row.uid)) yield row;
			}
		},
	} as unknown as Parameters<typeof runAllMailPasses>[0];
	return { client, box, rows, ranges, bodyReads, control };
}

interface RunResult {
	protocol: EmittedMessage[];
	records: { stream: string; data: Record<string, unknown> }[];
	state: Record<string, unknown>;
}

async function run(
	m: ReturnType<typeof mailbox>,
	state: Record<string, unknown>,
	streams: string[] | Map<string, StreamRequest>,
	extra: Partial<Parameters<typeof runAllMailPasses>[3]> = {},
): Promise<RunResult> {
	const protocol: EmittedMessage[] = [];
	const records: { stream: string; data: Record<string, unknown> }[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((data: string) => {
		try {
			protocol.push(JSON.parse(data) as EmittedMessage);
		} catch {
			/* not protocol */
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		await runAllMailPasses(m.client, ALL_MAIL, state, {
			emittedAt: NOW,
			requested: streams instanceof Map ? streams : requested(streams),
			async emitRecord(stream, data) {
				records.push({ stream, data });
				return true;
			},
			...extra,
		});
	} finally {
		process.stdout.write = original;
	}
	const next = { ...state };
	for (const event of protocol) {
		if (event.type === "STATE") next[event.stream] = event.cursor;
	}
	return { protocol, records, state: next };
}

function last<T>(xs: readonly T[]): T {
	const x = xs.at(-1);
	assert.ok(x !== undefined);
	return x;
}

const ofStream = (r: RunResult, stream: string) =>
	r.records.filter((x) => x.stream === stream);
const coverageOf = (r: RunResult, stream: string) =>
	r.protocol.find((e) => e.type === "DETAIL_COVERAGE" && e.stream === stream);
const skips = (r: RunResult, reason: string) =>
	r.protocol.filter((e) => e.type === "SKIP_RESULT" && e.reason === reason);

async function runUntilStable(
	m: ReturnType<typeof mailbox>,
	state: Record<string, unknown>,
	streams: string[],
	maxRuns = 10,
): Promise<RunResult[]> {
	const out: RunResult[] = [];
	let current = state;
	for (let i = 0; i < maxRuns; i += 1) {
		const r = await run(m, current, streams);
		out.push(r);
		current = r.state;
		const progress = (
			current.messages as {
				progress?: {
					streams: Record<string, { through: number; coveredFrom: number }>;
				};
			}
		)?.progress;
		const done =
			progress &&
			Object.values(progress.streams).every(
				(s) => s.through + 1 >= s.coveredFrom,
			);
		if (done) break;
	}
	return out;
}

test("F1: a thread row holds every member across bounded pages, a restart, and a later reply", async () => {
	const m = mailbox([message(100), message(700)], 1201);
	const runs = await runUntilStable(m, {}, ["threads"]);
	const rows = runs.flatMap((r) => ofStream(r, "threads"));
	assert.ok(rows.length > 0, "a thread row is emitted");
	for (const row of rows) {
		assert.equal(
			row.data.message_count,
			2,
			"no page-local fragment is emitted",
		);
	}
	assert.deepEqual(rows.at(-1)?.data.labels, ["label-100", "label-700"]);
	m.rows.push(message(1250));
	m.box.uidNext = 1301;
	const reply = await run(m, last(runs).state, ["threads"]);
	assert.equal(ofStream(reply, "threads").at(-1)?.data.message_count, 3);
});

test("F2: a new UID is processed once when history is complete and its snippet survives", async () => {
	const m = mailbox([message(1250)], 1301);
	m.control.failBodyReadAfter = 1;
	const r = await run(m, legacyState(), ["messages"]);
	assert.equal(m.bodyReads.get(1250), 1, "disjoint lanes read the body once");
	assert.deepEqual(
		ofStream(r, "messages").map((x) => x.data.snippet),
		["saved snippet"],
	);
	const replay = await run(m, r.state, ["messages"]);
	assert.equal(ofStream(replay, "messages").length, 0);
});

test("F3: a transient body upload failure becomes retry debt, not a terminal skip", async () => {
	const m = mailbox([message(100), message(200)], 301);
	m.control.bodyText = "binary\u0000body";
	let failUpload = true;
	const uploadBodyBlob = async () => {
		if (failUpload) throw new Error("upload transport 503");
		return {
			blob_id: "blob",
			sha256: "0".repeat(64),
			size_bytes: 4,
			mime_type: "text/plain",
		};
	};
	const first = await run(m, {}, ["messages", "message_bodies"], {
		uploadBodyBlob,
	});
	assert.equal(skips(first, "historical_message_unaccounted").length, 0);
	assert.ok(first.state.messages, "the run still commits");
	failUpload = false;
	const second = await run(m, first.state, ["messages", "message_bodies"], {
		uploadBodyBlob,
	});
	assert.deepEqual(
		ofStream(second, "messages").map((x) => x.data.id),
		["64", "c8"],
		"both UIDs recover on the next run",
	);
	const third = await run(m, second.state, ["messages", "message_bodies"], {
		uploadBodyBlob,
	});
	assert.equal(ofStream(third, "messages").length, 0, "debt settles once");
});

test("F4: messages-only completion cannot certify a first attachment inventory", async () => {
	const m = mailbox([attachmentMessage(1000)], 1201);
	const r = await run(m, legacyState(), ["messages", "attachments"]);
	assert.equal(coverageOf(r, "attachments"), undefined);
});

test("F5: same-epoch deletion and regrowth keep collecting and persist current EXISTS", async () => {
	const m = mailbox([], 1201);
	let state: Record<string, unknown> = legacyState();
	for (const exists of [1200, 1199, 1200]) {
		m.box.exists = exists;
		const r = await run(m, state, ["messages"]);
		state = r.state;
		assert.equal(
			(state.messages as { all_mail: { exists: number } }).all_mail.exists,
			exists,
		);
	}
});

const progressOf = (r: RunResult) =>
	(
		r.state.messages as {
			progress: {
				streams: Record<
					string,
					{ through: number; coveredFrom: number; next: number }
				>;
				debt: { uid: number; streams: string[] }[];
			};
		}
	).progress;

test("guard: a schema-rejected message is terminal and visible, and the walk moves on", async () => {
	const m = mailbox([message(100), message(200)], 301);
	const r = await run(m, {}, ["messages"], {
		async emitRecord(stream, data) {
			return !(stream === "messages" && data.id === "64");
		},
	});
	assert.equal(progressOf(r).streams.messages?.through, 300);
	assert.deepEqual(
		progressOf(r).debt,
		[],
		"a deterministic rejection is not retry debt",
	);
	const replay = await run(m, r.state, ["messages"]);
	assert.equal(
		ofStream(replay, "messages").length,
		0,
		"no retry of a terminal UID",
	);
});

test("guard: a persistent body-fetch failure becomes debt and does not hold the lane", async () => {
	const m = mailbox([message(100), message(200)], 301);
	m.control.failBodyReadAfter = 0;
	const r = await run(m, {}, ["messages", "message_bodies"]);
	assert.equal(progressOf(r).streams.messages?.through, 300);
	assert.equal(progressOf(r).streams.message_bodies?.through, 300);
	assert.deepEqual(
		progressOf(r).debt.map((d) => [d.uid, d.streams]),
		[
			[100, ["messages", "message_bodies"]],
			[200, ["messages", "message_bodies"]],
		],
	);
	assert.deepEqual(
		ofStream(r, "messages"),
		[],
		"no row is written with a lost snippet",
	);
});

test("guard: messages outside time_range are accounted, so the run commits and advances", async () => {
	const m = mailbox([message(100), message(200)], 301);
	const scope = new Map<string, StreamRequest>([
		[
			"messages",
			{ name: "messages", time_range: { until: "2020-01-01T00:00:00.000Z" } },
		],
	]);
	const r = await run(m, {}, scope);
	assert.equal(ofStream(r, "messages").length, 0);
	assert.equal(progressOf(r).streams.messages?.through, 300);
	const cov = coverageOf(r, "messages");
	assert.ok(cov?.type === "DETAIL_COVERAGE");
	assert.equal(cov.considered, 0, "out-of-scope UIDs are not considered");
});

test("guard: the attachment inventory claim arrives once a multi-page walk completes", async () => {
	const m = mailbox([attachmentMessage(100), attachmentMessage(1000)], 1201);
	const runs = await runUntilStable(m, {}, ["attachments"]);
	assert.ok(runs.length >= 3, "the walk takes more than one page");
	for (const r of runs.slice(0, -1)) {
		assert.equal(coverageOf(r, "attachments"), undefined, "no claim mid-walk");
	}
	const claim = coverageOf(last(runs), "attachments");
	assert.ok(
		claim?.type === "DETAIL_COVERAGE",
		"the completing run makes the claim",
	);
	const next = await run(m, last(runs).state, ["attachments"]);
	assert.ok(coverageOf(next, "attachments"), "later runs keep the claim");
	// Hydration has no blob endpoint here, so each part ends as a retry gap
	// (a failed hydration writes no record). The walk reached UID 1000.
	assert.ok(
		runs.some((r) =>
			r.protocol.some(
				(e) =>
					e.type === "DETAIL_GAP" &&
					e.stream === "attachments" &&
					e.record_key === "3e8:2",
			),
		),
		"the attachment past the first page was enumerated",
	);
});

test("guard: dropping a stream after a completed walk keeps the forward lane, no replay", async () => {
	const m = mailbox([attachmentMessage(100)], 201);
	const runs = await runUntilStable(m, {}, ["messages", "attachments"]);
	m.rows.push(message(250));
	m.box.uidNext = 301;
	m.ranges.length = 0;
	const r = await run(m, last(runs).state, ["messages"]);
	assert.deepEqual(m.ranges, ["201:300"], "only the forward lane is fetched");
	assert.deepEqual(
		ofStream(r, "messages").map((x) => x.data.id),
		["fa"],
	);
	assert.equal(
		progressOf(r).streams.attachments?.next,
		201,
		"the dropped stream is kept as is",
	);
});

test("guard: a thread member expunged between SEARCH and FETCH does not fail the run", async () => {
	const m = mailbox([message(100), message(150)], 201);
	m.control.phantomSearchUid = 175;
	const r = await run(m, {}, ["threads"]);
	assert.equal(ofStream(r, "threads").at(-1)?.data.message_count, 2);
	assert.equal(progressOf(r).streams.threads?.through, 200);
});

test("guard: pre-ledger state keeps message and body history; threads rebuild from UID 1", async () => {
	const m = mailbox([message(100), message(1250)], 1301);
	m.ranges.length = 0;
	const r = await run(m, legacyState(), [
		"messages",
		"message_bodies",
		"threads",
	]);
	const p = progressOf(r);
	assert.equal(p.streams.messages?.through, 1300);
	assert.equal(p.streams.message_bodies?.through, 1300);
	assert.equal(
		p.streams.threads?.through,
		500,
		"threads walk their own history",
	);
	assert.deepEqual(
		ofStream(r, "messages").map((x) => x.data.id),
		["4e2"],
		"only new mail is collected for messages",
	);
});

test("guard: retry debt for an expunged UID settles instead of retrying forever", async () => {
	const m = mailbox([message(100), message(200)], 301);
	m.control.bodyText = "binary\u0000body";
	const failing = async () => {
		throw new Error("upload transport 503");
	};
	const first = await run(m, {}, ["message_bodies"], {
		uploadBodyBlob: failing,
	});
	assert.equal(progressOf(first).debt.length, 2);
	m.rows.splice(0, 1);
	const second = await run(m, first.state, ["message_bodies"], {
		uploadBodyBlob: failing,
	});
	assert.deepEqual(
		progressOf(second).debt.map((d) => d.uid),
		[200],
		"the expunged UID leaves the debt list",
	);
});

test("guard: a resource-excluded body is out of scope, not a rejected-body gap", async () => {
	const m = mailbox([message(100)], 201);
	const scope = new Map<string, StreamRequest>([
		["message_bodies", { name: "message_bodies", resources: ["ffff"] }],
	]);
	const r = await run(m, {}, scope);
	assert.equal(
		r.protocol.some((e) => e.type === "DETAIL_GAP"),
		false,
		JSON.stringify(r.protocol.filter((e) => e.type === "DETAIL_GAP")),
	);
	assert.equal(progressOf(r).streams.message_bodies?.through, 200);
});

test("guard: every commit keeps the RI band contiguous (backfill.target_uid + 1 >= forward_uidnext)", async () => {
	const m = mailbox(
		[message(100), attachmentMessage(700), message(1250)],
		1301,
	);
	let state: Record<string, unknown> = legacyState(400, 1201);
	for (const streams of [
		["messages"],
		["messages", "attachments"],
		["attachments"],
		["threads"],
	]) {
		const r = await run(m, state, streams);
		state = r.state;
		const c = state.messages as {
			all_mail: { uidvalidity: number; forward_uidnext: number };
			backfill: { uidvalidity: number; target_uid: number };
		};
		assert.equal(c.backfill.uidvalidity, c.all_mail.uidvalidity);
		assert.ok(
			c.backfill.target_uid + 1 >= c.all_mail.forward_uidnext,
			JSON.stringify(c),
		);
	}
});

// ─── Scope widening: a moved time_range bound is caught up, never skipped ──

const JAN = "2026-01-15T00:00:00.000Z";
const MAR = "2026-03-15T00:00:00.000Z";
const MAY = "2026-05-15T00:00:00.000Z";
const JUL = "2026-07-15T00:00:00.000Z";

function until(iso: string | undefined, streams = ["messages"]) {
	return new Map<string, StreamRequest>(
		streams.map((name) => [
			name,
			{ name, ...(iso ? { time_range: { until: iso } } : {}) },
		]),
	);
}

const collectedIds = (runs: RunResult[]) =>
	runs.flatMap((r) => ofStream(r, "messages").map((x) => String(x.data.id)));

async function withWindow<T>(uids: number, fn: () => Promise<T>): Promise<T> {
	const prior = process.env.PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS;
	process.env.PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS = String(uids);
	try {
		return await fn();
	} finally {
		if (prior === undefined)
			delete process.env.PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS;
		else process.env.PDPP_GMAIL_MESSAGES_BACKFILL_WINDOW_UIDS = prior;
	}
}

test("scope: a later until collects the mail the earlier bound excluded, after the walk is complete", async () => {
	const m = mailbox([dated(10, JAN), dated(20, MAR), dated(30, MAY)], 101);
	const first = await run(m, {}, until("2026-02-01T00:00:00.000Z"));
	assert.deepEqual(collectedIds([first]), ["a"]);
	assert.equal(
		progressOf(first).streams.messages?.through,
		100,
		"history complete under the old bound",
	);
	const widened = await runUntilCaughtUp(
		m,
		first.state,
		until("2026-04-01T00:00:00.000Z"),
	);
	assert.deepEqual(
		collectedIds(widened),
		["14"],
		"March mail is collected; May is still out of scope",
	);
});

test("scope: until moving again mid catch-up keeps the pass and skips nothing", async () => {
	await withWindow(2, async () => {
		// Six messages in [Feb, Jun) and two in [Jun, Aug), all walked under
		// until=Feb. UID 11 is below where the first pass will stop, so a pass
		// that absorbed the second band would skip it.
		const rows = [
			dated(10, JAN),
			dated(11, JUL),
			...[12, 13, 14, 15, 16, 17].map((uid) => dated(uid, MAR)),
			dated(18, JUL),
		];
		const m = mailbox(rows, 19);
		let state =
			(await runUntilCaughtUp(m, {}, until("2026-02-01T00:00:00.000Z"))).at(-1)
				?.state ?? {};
		// One catch-up page under until=Jun collects two of the six.
		const page = await run(m, state, until("2026-06-01T00:00:00.000Z"));
		assert.deepEqual(collectedIds([page]), ["c", "d"]);
		state = page.state;
		const pass = progressOf(page).streams.messages as unknown as {
			catchup?: { through: number }[];
		};
		assert.equal(
			pass.catchup?.[0]?.through,
			13,
			"the pass records how far it got",
		);
		// The bound moves on before the pass finishes.
		const rest = await runUntilCaughtUp(
			m,
			state,
			until("2026-08-01T00:00:00.000Z"),
		);
		const ids = collectedIds(rest);
		assert.deepEqual(
			[...ids].sort(),
			["e", "f", "10", "11", "b", "12"].sort(),
			"the rest of the first band and all of the new band arrive, nothing twice",
		);
		assert.equal(
			ids.includes("c"),
			false,
			"the preserved pass does not restart",
		);
	});
});

test("scope: a rolling until that moves every run still converges", async () => {
	await withWindow(2, async () => {
		const rows = [10, 11, 12, 13, 14, 15].map((uid, i) =>
			dated(uid, new Date(Date.UTC(2026, 0, 10 + i * 10)).toISOString()),
		);
		const m = mailbox(rows, 16);
		// The walk completes before any of this mail is in scope.
		let state =
			(await runUntilCaughtUp(m, {}, until("2026-01-01T00:00:00.000Z"))).at(-1)
				?.state ?? {};
		const seen: string[] = [];
		for (let i = 0; i < 12; i += 1) {
			const bound = new Date(Date.UTC(2026, 0, 12 + i * 10)).toISOString();
			const r = await run(m, state, until(bound));
			seen.push(...collectedIds([r]));
			state = r.state;
		}
		assert.deepEqual([...new Set(seen)].sort(), ["a", "b", "c", "d", "e", "f"]);
		assert.equal(seen.length, 6, "each message is collected once");
	});
});

test("scope: an earlier since collects the older band once", async () => {
	const m = mailbox([dated(10, JAN), dated(20, MAR), dated(30, MAY)], 101);
	const since = (iso: string) =>
		new Map<string, StreamRequest>([
			["messages", { name: "messages", time_range: { since: iso } }],
		]);
	const first = await run(m, {}, since("2026-04-01T00:00:00.000Z"));
	assert.deepEqual(collectedIds([first]), ["1e"]);
	const widened = await runUntilCaughtUp(
		m,
		first.state,
		since("2026-02-01T00:00:00.000Z"),
	);
	assert.deepEqual(collectedIds(widened), ["14"]);
});

async function runUntilCaughtUp(
	m: ReturnType<typeof mailbox>,
	state: Record<string, unknown>,
	scope: Map<string, StreamRequest>,
	maxRuns = 12,
): Promise<RunResult[]> {
	const out: RunResult[] = [];
	let current = state;
	for (let i = 0; i < maxRuns; i += 1) {
		const r = await run(m, current, scope);
		out.push(r);
		current = r.state;
		const s = progressOf(r).streams.messages as unknown as {
			through: number;
			coveredFrom: number;
			catchup?: unknown[];
		};
		if (s.through + 1 >= s.coveredFrom && !(s.catchup && s.catchup.length > 0))
			break;
	}
	return out;
}

test("debt: retries reach every owed UID, not only the first batch, while all keep failing", async () => {
	// 60 owed UIDs, more than two retry batches (25 per run). Every upload
	// keeps failing, so a queue that re-tried its head would starve the tail.
	const uids = Array.from({ length: 60 }, (_, i) => 100 + i);
	const m = mailbox(
		uids.map((uid) => message(uid)),
		201,
	);
	m.control.bodyText = "binary\u0000body";
	const attempts = new Map<string, number>();
	const uploadBodyBlob = async (args: { recordKey: string }) => {
		attempts.set(args.recordKey, (attempts.get(args.recordKey) ?? 0) + 1);
		throw new Error("upload transport 503");
	};
	let state = (await run(m, {}, ["message_bodies"], { uploadBodyBlob })).state;
	assert.equal(progressOf({ state } as RunResult).debt.length, 60);
	for (let i = 0; i < 3; i += 1) {
		state = (await run(m, state, ["message_bodies"], { uploadBodyBlob })).state;
	}
	const retried = uids.filter(
		(uid) => (attempts.get(uid.toString(16)) ?? 0) >= 2,
	);
	assert.equal(
		retried.length,
		60,
		"every owed UID was retried within three runs",
	);
});

test("scope+debt: an expunged retry UID during an active catch-up does not fail the run", async () => {
	const rows = [dated(10, JAN), dated(20, MAR), dated(30, MAR)];
	const m = mailbox(rows, 101);
	m.control.bodyText = "binary\u0000body";
	const failing = async () => {
		throw new Error("upload transport 503");
	};
	const scope = (iso: string) =>
		new Map<string, StreamRequest>(
			["messages", "message_bodies"].map((name) => [
				name,
				{ name, time_range: { until: iso } },
			]),
		);
	// UID 10 fails its body upload and becomes debt under until=Feb.
	const first = await run(m, {}, scope("2026-02-01T00:00:00.000Z"), {
		uploadBodyBlob: failing,
	});
	assert.deepEqual(
		progressOf(first).debt.map((d) => d.uid),
		[10],
	);
	m.rows.splice(0, 1); // UID 10 is expunged
	const widened = await run(m, first.state, scope("2026-06-01T00:00:00.000Z"), {
		uploadBodyBlob: async () => ({
			blob_id: "b",
			sha256: "0".repeat(64),
			size_bytes: 1,
			mime_type: "text/plain",
		}),
	});
	assert.deepEqual(progressOf(widened).debt, [], "the expunged UID settles");
	assert.deepEqual(
		collectedIds([widened]).sort(),
		["14", "1e"],
		"the catch-up still runs",
	);
});

test("scope+debt: a retry owed under the old range is collected, not settled as out of scope", async () => {
	// Jan 31 is inside until=Feb 1 and inside SEARCH's padded catch-up band.
	const m = mailbox(
		[dated(10, "2026-01-31T12:00:00.000Z"), dated(20, MAR)],
		101,
	);
	m.control.bodyText = "binary\u0000body";
	let fail = true;
	const upload = async () => {
		if (fail) throw new Error("upload transport 503");
		return {
			blob_id: "b",
			sha256: "0".repeat(64),
			size_bytes: 1,
			mime_type: "text/plain",
		};
	};
	const scope = (iso: string) =>
		new Map<string, StreamRequest>(
			["messages", "message_bodies"].map((name) => [
				name,
				{ name, time_range: { until: iso } },
			]),
		);
	const first = await run(m, {}, scope("2026-02-01T00:00:00.000Z"), {
		uploadBodyBlob: upload,
	});
	assert.deepEqual(
		progressOf(first).debt.map((d) => d.uid),
		[10],
	);
	fail = false;
	const widened = await run(m, first.state, scope("2026-06-01T00:00:00.000Z"), {
		uploadBodyBlob: upload,
	});
	assert.ok(
		collectedIds([widened]).includes("a"),
		"the owed January message is collected",
	);
	assert.deepEqual(progressOf(widened).debt, []);
});

test("debt: body debt survives when messages join and retry the same UIDs in a later batch", async () => {
	// 25 UIDs, exactly one retry batch. Uploads keep failing throughout.
	const uids = Array.from({ length: 25 }, (_, i) => 100 + i);
	const m = mailbox(
		uids.map((uid) => message(uid)),
		201,
	);
	m.control.bodyText = "binary\u0000body";
	let failUpload = true;
	const uploadBodyBlob = async () => {
		if (failUpload) throw new Error("upload transport 503");
		return {
			blob_id: "b",
			sha256: "0".repeat(64),
			size_bytes: 1,
			mime_type: "text/plain",
		};
	};
	const bodies = await run(m, {}, ["message_bodies"], { uploadBodyBlob });
	assert.equal(progressOf(bodies).debt.length, 25);
	// messages join; the body upload still fails before the messages emit.
	const joined = await run(m, bodies.state, ["messages", "message_bodies"], {
		uploadBodyBlob,
	});
	const third = await run(m, joined.state, ["messages", "message_bodies"], {
		uploadBodyBlob,
	});
	const owed = progressOf(third).debt;
	assert.equal(
		new Set(owed.map((d) => d.uid)).size,
		owed.length,
		"one debt entry per UID",
	);
	assert.deepEqual(
		uids.filter(
			(uid) =>
				!owed.some(
					(d) => d.uid === uid && d.streams.includes("message_bodies"),
				),
		),
		[],
		"every body is still owed while uploads fail",
	);
	failUpload = false;
	let state = third.state;
	const collected: string[] = [];
	for (let i = 0; i < 3; i += 1) {
		const r = await run(m, state, ["messages", "message_bodies"], {
			uploadBodyBlob,
		});
		collected.push(
			...ofStream(r, "message_bodies").map((x) => String(x.data.id)),
		);
		state = r.state;
	}
	assert.equal(
		new Set(collected).size,
		25,
		"every body is collected once uploads recover",
	);
	assert.deepEqual(progressOf({ state } as RunResult).debt, []);
});

test("scope: each stream applies its own time range, before any body I/O", async () => {
	const m = mailbox([dated(10, MAR)], 101);
	const bodiesOnly = new Map<string, StreamRequest>([
		[
			"message_bodies",
			{
				name: "message_bodies",
				time_range: { until: "2026-02-01T00:00:00.000Z" },
			},
		],
	]);
	const r = await run(m, {}, bodiesOnly);
	assert.equal(
		ofStream(r, "message_bodies").length,
		0,
		"an out-of-range body is not collected",
	);
	assert.equal(m.bodyReads.get(10) ?? 0, 0, "and its body is not even read");
	const siblings = new Map<string, StreamRequest>([
		[
			"messages",
			{ name: "messages", time_range: { until: "2026-02-01T00:00:00.000Z" } },
		],
		[
			"message_bodies",
			{
				name: "message_bodies",
				time_range: { until: "2026-06-01T00:00:00.000Z" },
			},
		],
	]);
	const s = await run(mailbox([dated(10, MAR)], 101), {}, siblings);
	assert.equal(
		ofStream(s, "messages").length,
		0,
		"messages applies its own bound",
	);
	assert.equal(ofStream(s, "message_bodies").length, 1, "bodies apply theirs");
});

test("scope: widening until by less than a millisecond still catches up the boundary message", async () => {
	const edge = "2026-01-01T00:00:00.000Z";
	const m = mailbox([dated(10, edge)], 101);
	const first = await run(m, {}, until(edge));
	assert.deepEqual(
		collectedIds([first]),
		[],
		"[since, until) excludes the boundary instant",
	);
	const widened = await runUntilCaughtUp(
		m,
		first.state,
		until("2026-01-01T00:00:00.0001Z"),
	);
	assert.deepEqual(collectedIds(widened), ["a"]);
});

test("scope: the flag/label delta pass never reads or emits a message outside the stream's range", async () => {
	const m = mailbox([dated(10, JAN), dated(20, MAR)], 101);
	const scope = until("2026-02-01T00:00:00.000Z");
	(m.box as { highestModseq?: bigint }).highestModseq = 50n;
	const first = await run(m, {}, scope);
	assert.deepEqual(collectedIds([first]), ["a"]);
	// Both messages change flags; the next run's delta pass sees both.
	(m.box as { highestModseq?: bigint }).highestModseq = 60n;
	m.bodyReads.clear();
	const delta = await run(m, first.state, scope);
	assert.deepEqual(
		collectedIds([delta]),
		["a"],
		"only the in-range change is re-emitted",
	);
	assert.equal(
		m.bodyReads.get(20) ?? 0,
		0,
		"the out-of-range message's body is never read",
	);
});

test("scope: an excluded envelope-less delta change does not spend the hold-back budget", async () => {
	const { envelope: _drop, ...noEnvelope } = dated(20, MAR);
	const m = mailbox([dated(10, JAN), noEnvelope as FetchMessageObject], 101);
	const scope = until("2026-02-01T00:00:00.000Z");
	(m.box as { highestModseq?: bigint }).highestModseq = 50n;
	let state = (await run(m, {}, scope)).state;
	for (const modseq of [60n, 70n]) {
		(m.box as { highestModseq?: bigint }).highestModseq = modseq;
		const r = await run(m, state, scope);
		state = r.state;
		const allMail = (
			state.messages as {
				all_mail: { highest_modseq: unknown; delta_holdback_runs: number };
			}
		).all_mail;
		assert.equal(
			String(allMail.highest_modseq),
			String(modseq),
			"the cursor advances past an excluded change",
		);
		assert.equal(
			allMail.delta_holdback_runs,
			0,
			"an excluded change is not a failure",
		);
	}
	assert.equal(m.bodyReads.get(20) ?? 0, 0);
});

test("attachments: the inventory claim is withheld while an accepted too_large key has no outcome", async () => {
	const prior = process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
	process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = "10";
	try {
		const m = mailbox([attachmentMessage(10)], 101);
		const runs = await runUntilStable(m, {}, ["attachments"]);
		const again = await run(m, last(runs).state, ["attachments"]);
		for (const r of [...runs, again]) {
			const cov = coverageOf(r, "attachments") as
				| {
						required_keys: string[];
						hydrated_keys: string[];
						gap_keys?: string[];
				  }
				| undefined;
			if (!cov) continue;
			const credited = new Set([...cov.hydrated_keys, ...(cov.gap_keys ?? [])]);
			assert.deepEqual(
				cov.required_keys.filter((k) => !credited.has(k)),
				[],
				"a claim never carries a key the host cannot credit",
			);
		}
	} finally {
		if (prior === undefined) delete process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
		else process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = prior;
	}
});

test("scope: a catch-up revisit never overwrites a stored snippet when the body read fails", async () => {
	const m = mailbox([dated(10, "2026-01-05T00:00:00.000Z")], 101);
	const first = await run(m, {}, until("2026-01-10T00:00:00.000Z"));
	assert.deepEqual(
		ofStream(first, "messages").map((x) => x.data.snippet),
		["saved snippet"],
	);
	const narrowed = await run(m, first.state, until("2026-01-01T00:00:00.000Z"));
	// Widening back owes [Jan 1, Jan 10) again, over a UID already stored.
	m.control.failBodyReadAfter = 0;
	const revisit = await run(
		m,
		narrowed.state,
		until("2026-01-10T00:00:00.000Z"),
	);
	assert.equal(
		ofStream(revisit, "messages").some((x) => x.data.snippet === null),
		false,
		"no row is written with a lost snippet",
	);
	m.control.failBodyReadAfter = Number.POSITIVE_INFINITY;
	const recovered = await runUntilCaughtUp(
		m,
		revisit.state,
		until("2026-01-10T00:00:00.000Z"),
	);
	assert.deepEqual(
		recovered.flatMap((r) =>
			ofStream(r, "messages").map((x) => x.data.snippet),
		),
		["saved snippet"],
		"the revisit completes once the body read works",
	);
});

test("attachments: an unresolved too_large part stays owed across runs, so no later run claims the inventory", async () => {
	const prior = process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
	process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = "10";
	try {
		const m = mailbox([attachmentMessage(10)], 101);
		let state: Record<string, unknown> = {};
		const claims: unknown[] = [];
		for (let i = 0; i < 4; i += 1) {
			const r = await run(m, state, ["attachments"]);
			state = r.state;
			const cov = coverageOf(r, "attachments");
			if (cov) claims.push(cov);
		}
		assert.deepEqual(
			claims,
			[],
			"a quiet later run must not claim 0/0 over the owed part",
		);
		assert.ok(
			progressOf({ state } as RunResult).debt.some(
				(d) => d.uid === 10 && d.streams.includes("attachments"),
			),
			"the part is durable debt",
		);
		// Raising the cap lets the next retry resolve it.
		delete process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
		const retried = await run(m, state, ["attachments"]);
		// No blob endpoint here, so the retry under the new cap fails
		// hydration: it leaves a retry gap, and the UID is no longer owed.
		assert.ok(
			retried.protocol.some(
				(e) =>
					e.type === "DETAIL_GAP" &&
					e.stream === "attachments" &&
					e.record_key === "a:2",
			),
			"the owed part is retried under the new cap",
		);
		assert.equal(
			progressOf(retried).debt.some((d) => d.uid === 10),
			false,
		);
	} finally {
		if (prior === undefined) delete process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
		else process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = prior;
	}
});

test("replay: a failed run keeps its records but not its STATE; the replay never overwrites a saved snippet", async () => {
	const m = mailbox([message(10), message(20)], 101);
	// Run A collects UID 10, then UID 20 breaks the connection: the run fails,
	// its records are durable, its STATE is discarded.
	let breakAt20 = true;
	const failing = await run(m, {}, ["messages"], {
		async emitRecord(_stream, data) {
			if (breakAt20 && data.id === "14") {
				(m.client as { usable: boolean }).usable = false;
				throw new Error("connection lost");
			}
			return true;
		},
	}).catch(() => null);
	assert.equal(failing, null, "run A fails");
	breakAt20 = false;
	(m.client as { usable: boolean }).usable = true;
	// Run B replays the same page from the old STATE; UID 10's body read fails.
	m.control.failBodyReadAfter = 0;
	const replay = await run(m, {}, ["messages"]);
	assert.equal(
		ofStream(replay, "messages").some(
			(x) => x.data.id === "a" && x.data.snippet === null,
		),
		false,
		"the replay does not overwrite UID 10's saved snippet with null",
	);
	assert.ok(
		progressOf(replay).debt.some((d) => d.uid === 10),
		"UID 10 stays owed",
	);
	m.control.failBodyReadAfter = Number.POSITIVE_INFINITY;
	const recovered = await run(m, replay.state, ["messages"]);
	assert.deepEqual(
		ofStream(recovered, "messages")
			.filter((x) => x.data.id === "a")
			.map((x) => x.data.snippet),
		["saved snippet"],
	);
});

test("attachments: a message whose parts cannot be enumerated blocks the inventory claim across restarts", async () => {
	const { emailId: _id, ...noId } = attachmentMessage(10);
	const m = mailbox([noId as FetchMessageObject], 101);
	let state: Record<string, unknown> = {};
	for (let i = 0; i < 3; i += 1) {
		const r = await run(m, state, ["messages", "attachments"]);
		state = r.state;
		assert.equal(
			coverageOf(r, "attachments"),
			undefined,
			`run ${i}: no claim over an unenumerable part`,
		);
	}
	// Control: an ID-less message with no attachment parts does not block it.
	const { emailId: _id2, ...plain } = message(10);
	const c = mailbox([plain as FetchMessageObject], 101);
	const runs = await runUntilStable(c, {}, ["messages", "attachments"]);
	assert.ok(
		coverageOf(last(runs), "attachments"),
		"a message without parts leaves nothing unenumerated",
	);
});

test("attachments: a missing BODYSTRUCTURE is not an empty part list; the UID stays owed until it is read", async () => {
	const full = attachmentMessage(10);
	const { bodyStructure: _structure, ...noStructure } = full;
	const rows = [noStructure as FetchMessageObject];
	const m = mailbox(rows, 101);
	const first = await run(m, {}, ["messages", "attachments"]);
	assert.equal(
		coverageOf(first, "attachments"),
		undefined,
		"no claim without enumeration",
	);
	assert.ok(
		progressOf(first).debt.some(
			(d) => d.uid === 10 && d.streams.includes("attachments"),
		),
		"the UID is owed for attachments",
	);
	// The structure is returned on the next run: the retry enumerates the part.
	rows[0] = full;
	const second = await run(m, first.state, ["messages", "attachments"]);
	assert.ok(
		second.protocol.some(
			(e) =>
				e.type === "DETAIL_GAP" &&
				e.stream === "attachments" &&
				e.record_key === "a:2",
		),
		"the part is enumerated on the retry",
	);
	// Control: an ID-less message with no BODYSTRUCTURE cannot be enumerated
	// either, and never will be, so it is a durable shortfall.
	const { emailId: _id, bodyStructure: _s2, ...bare } = full;
	const c = mailbox([bare as FetchMessageObject], 101);
	let state: Record<string, unknown> = {};
	for (let i = 0; i < 2; i += 1) {
		const r = await run(c, state, ["messages", "attachments"]);
		state = r.state;
		assert.equal(coverageOf(r, "attachments"), undefined);
	}
});

for (const variant of [
	"missing BODYSTRUCTURE",
	"BODY[1] NIL",
	"no message",
] as const) {
	test(`scope: an unavailable body (${variant}) on a catch-up revisit writes nothing and stays owed`, async () => {
		const full = dated(10, MAY);
		const rows = [full];
		const m = mailbox(rows, 101);
		const scope = (iso: string | undefined) =>
			new Map<string, StreamRequest>(
				["messages", "message_bodies"].map((name) => [
					name,
					{ name, ...(iso ? { time_range: { until: iso } } : {}) },
				]),
			);
		const first = await run(m, {}, scope(undefined));
		assert.deepEqual(
			ofStream(first, "messages").map((x) => x.data.snippet),
			["saved snippet"],
		);
		const narrowed = await run(
			m,
			first.state,
			scope("2026-02-01T00:00:00.000Z"),
		);
		if (variant === "missing BODYSTRUCTURE") {
			const { bodyStructure: _s, ...bare } = full;
			rows[0] = bare as FetchMessageObject;
		} else if (variant === "BODY[1] NIL") {
			m.control.bodyReply = "nil-part";
		} else {
			m.control.bodyReply = "no-message";
		}
		const revisit = await run(m, narrowed.state, scope(undefined));
		assert.deepEqual(
			ofStream(revisit, "messages"),
			[],
			"no messages row replaces the stored one",
		);
		assert.deepEqual(
			ofStream(revisit, "message_bodies"),
			[],
			"no body row replaces the stored one",
		);
		assert.ok(
			progressOf(revisit).debt.some((d) => d.uid === 10),
			"the UID stays owed",
		);
		// The provider answers normally again: the owed UID is repaired.
		rows[0] = full;
		m.control.bodyReply = "part";
		const repaired = await run(m, revisit.state, scope(undefined));
		assert.deepEqual(
			ofStream(repaired, "messages").map((x) => x.data.snippet),
			["saved snippet"],
		);
	});
}

test("scope: the delta pass never rewrites a stored row when the change arrives without BODYSTRUCTURE", async () => {
	const full = dated(10, MAR);
	const rows = [full];
	const m = mailbox(rows, 101);
	(m.box as { highestModseq?: bigint }).highestModseq = 50n;
	const first = await run(m, {}, ["messages"]);
	assert.deepEqual(
		ofStream(first, "messages").map((x) => x.data.snippet),
		["saved snippet"],
	);
	const { bodyStructure: _s, ...bare } = full;
	rows[0] = bare as FetchMessageObject;
	(m.box as { highestModseq?: bigint }).highestModseq = 60n;
	const delta = await run(m, first.state, ["messages"]);
	assert.deepEqual(
		ofStream(delta, "messages"),
		[],
		"no row with an unknown snippet",
	);
	assert.deepEqual(
		progressOf(delta).debt.map((d) => [d.uid, d.streams]),
		[[10, ["messages"]]],
		"the change is owed to a later run",
	);
	rows[0] = full;
	const repaired = await run(m, delta.state, ["messages"]);
	// This fixture's delta FETCH ignores CHANGEDSINCE, so the delta pass
	// writes the same row as the debt retry.
	assert.deepEqual(
		[...new Set(ofStream(repaired, "messages").map((x) => x.data.snippet))],
		["saved snippet"],
	);
	assert.deepEqual(progressOf(repaired).debt, []);
});

// Provider evidence: a FETCH item the server did not return is an
// unavailable read. No lane writes a record from a stand-in for it, and the
// UID stays owed until the server returns the item.

test("evidence: a catch-up FETCH without ENVELOPE keeps the stored row and owes the UID", async () => {
	const full = dated(10, MAY);
	full.envelope = {
		subject: "Stored subject",
		from: [{ address: "stored@example.com" }],
		messageId: "<stored@example.com>",
	};
	const rows = [full];
	const m = mailbox(rows, 101, 1);
	const first = await run(m, {}, ["messages"]);
	assert.equal(ofStream(first, "messages")[0]?.data.subject, "Stored subject");
	const narrowed = await run(
		m,
		first.state,
		new Map([["messages", { name: "messages", time_range: { until: JAN } }]]),
	);
	const { envelope: _e, ...bare } = full;
	rows[0] = bare as FetchMessageObject;
	const widened = await run(m, narrowed.state, ["messages"]);
	assert.deepEqual(ofStream(widened, "messages"), [], "no blanked row");
	assert.deepEqual(
		progressOf(widened).debt.map((d) => [d.uid, d.streams]),
		[[10, ["messages"]]],
	);
	rows[0] = full;
	const repaired = await run(m, widened.state, ["messages"]);
	assert.deepEqual(
		ofStream(repaired, "messages").map((x) => x.data.subject),
		["Stored subject"],
	);
});

test("evidence: a catch-up FETCH without INTERNALDATE owes the UID instead of judging its scope", async () => {
	const full = dated(10, MAY);
	const rows = [full];
	const m = mailbox(rows, 101, 1);
	const narrow = new Map([
		["messages", { name: "messages", time_range: { until: MAR } }],
	]);
	const first = await run(m, {}, narrow);
	assert.equal(ofStream(first, "messages").length, 0);
	const widened = new Map([
		["messages", { name: "messages", time_range: { until: JUL } }],
	]);
	const { internalDate: _d, ...bare } = full;
	rows[0] = bare as FetchMessageObject;
	// SEARCH still places the UID in the widened band; FETCH omits the date.
	m.client.search = async () => [10];
	const second = await run(m, first.state, widened);
	assert.deepEqual(ofStream(second, "messages"), []);
	assert.deepEqual(
		progressOf(second).debt.map((d) => [d.uid, d.streams]),
		[[10, ["messages"]]],
		"unknown time does not settle the UID",
	);
	rows[0] = full;
	const third = await run(m, second.state, widened);
	assert.equal(ofStream(third, "messages").length, 1);
});

for (const missing of ["bodyStructure", "envelope", "threadId"] as const) {
	test(`evidence: a thread member FETCH without ${missing} keeps the stored thread row and owes the thread`, async () => {
		const full = attachmentMessage(10);
		full.envelope = {
			subject: "Original thread",
			from: [{ address: "original@example.com" }],
		};
		const m = mailbox([full], 101, 1);
		const first = await run(m, {}, ["threads"]);
		assert.equal(ofStream(first, "threads")[0]?.data.has_attachments, true);
		const reply = message(110);
		reply.envelope = { from: [{ address: "reply@example.com" }] };
		m.rows.push(reply);
		m.box.uidNext = 201;
		m.box.exists = 2;
		const { [missing]: _gone, ...bare } = full;
		m.rows[0] = bare as FetchMessageObject;
		// SEARCH still names the member while its FETCH omits the item.
		const search = m.client.search;
		if (missing === "threadId") m.client.search = async () => [10, 110];
		const second = await run(m, first.state, ["threads"]);
		assert.deepEqual(ofStream(second, "threads"), [], "no partial thread row");
		assert.deepEqual(
			progressOf(second).debt.map((d) => [d.uid, d.streams]),
			[[110, ["threads"]]],
		);
		m.rows[0] = full;
		m.client.search = search;
		const third = await run(m, second.state, ["threads"]);
		assert.deepEqual(
			ofStream(third, "threads").map((x) => [
				x.data.message_count,
				x.data.has_attachments,
				x.data.subject,
			]),
			[[2, true, "Original thread"]],
		);
	});
}

test("evidence: a delta change that never arrives whole stays owed past the hold-back limit", async () => {
	const full = message(10);
	const rows: FetchMessageObject[] = [full];
	const m = mailbox(rows, 101, 1);
	(m.box as { highestModseq?: bigint }).highestModseq = 50n;
	const walk = m.client.fetch;
	// The message changed at MODSEQ 60 and does not change again.
	m.client.fetch = (range, query, options) => {
		const since = options?.changedSince;
		if (since === undefined) return walk(range, query, options);
		return (async function* () {
			const [changed] = rows;
			if (changed && BigInt(since) < 60n) yield changed;
		})();
	};
	const first = await run(m, {}, ["messages"]);
	assert.equal(ofStream(first, "messages").length, 1);
	const { bodyStructure: _s, ...bare } = full;
	rows[0] = { ...bare, labels: new Set(["changed"]) } as FetchMessageObject;
	(m.box as { highestModseq?: bigint }).highestModseq = 60n;
	let state = first.state;
	for (let i = 0; i < 4; i += 1) {
		const r = await run(m, state, ["messages"]);
		assert.deepEqual(ofStream(r, "messages"), [], `miss ${i}: no partial row`);
		assert.deepEqual(
			progressOf(r).debt.map((d) => [d.uid, d.streams]),
			[[10, ["messages"]]],
			`miss ${i}: the change is owed`,
		);
		state = r.state;
	}
	rows[0] = { ...full, labels: new Set(["changed"]) };
	const repaired = await run(m, state, ["messages"]);
	assert.deepEqual(
		ofStream(repaired, "messages").map((x) => x.data.labels),
		[["changed"]],
	);
});

test("evidence: a delta change the full debt list cannot take holds MODSEQ until the row is repaired", async () => {
	const full = message(10);
	const rows: FetchMessageObject[] = [full];
	const m = mailbox(rows, 2001, 1);
	(m.box as { highestModseq?: bigint }).highestModseq = 50n;
	const walk = m.client.fetch;
	// The message changed at MODSEQ 60 and does not change again.
	m.client.fetch = (range, query, options) => {
		const since = options?.changedSince;
		if (since === undefined) return walk(range, query, options);
		return (async function* () {
			const [changed] = rows;
			if (changed && BigInt(since) < 60n) yield changed;
		})();
	};
	const initial = legacyState(2000, 2001);
	(initial.messages.all_mail as { highest_modseq?: number }).highest_modseq =
		40;
	const first = await run(m, initial, ["messages"]);
	assert.deepEqual(
		ofStream(first, "messages").map((x) => x.data.labels),
		[["label-10"]],
	);
	// Another stream's retries fill the debt list; it is not requested now.
	const progress = (
		first.state.messages as {
			progress: { streams: Record<string, unknown>; debt: unknown[] };
		}
	).progress;
	progress.streams.attachments = {
		through: 2000,
		coveredFrom: 2001,
		next: 2001,
		scope: {},
	};
	progress.debt = Array.from({ length: 200 }, (_, i) => ({
		uid: 1001 + i,
		streams: ["attachments"],
		attempts: 1,
		failure: "bodystructure_unavailable",
	}));
	const { bodyStructure: _s, ...bare } = full;
	rows[0] = { ...bare, labels: new Set(["changed"]) } as FetchMessageObject;
	(m.box as { highestModseq?: bigint }).highestModseq = 60n;
	let state = first.state;
	for (let i = 0; i < 4; i += 1) {
		const r = await run(m, state, ["messages"]);
		state = r.state;
		assert.equal(
			String(
				(state.messages as { all_mail: { highest_modseq: unknown } }).all_mail
					.highest_modseq,
			),
			"50",
			`miss ${i}: an unowned change holds the cursor`,
		);
	}
	rows[0] = { ...full, labels: new Set(["changed"]) };
	const repaired = await run(m, state, ["messages"]);
	assert.deepEqual(
		ofStream(repaired, "messages").map((x) => x.data.labels),
		[["changed"]],
	);
});

for (const item of ["flags", "labels", "size", "headers"] as const) {
	test(`evidence: a catch-up FETCH without ${item} keeps the stored row and owes the UID`, async () => {
		const full = {
			...dated(10, MAY),
			flags: new Set(["\\Seen", "\\Flagged"]),
		};
		const rows: FetchMessageObject[] = [full];
		const m = mailbox(rows, 101, 1);
		const first = await run(m, {}, ["messages"]);
		assert.equal(ofStream(first, "messages").length, 1);
		const narrowed = await run(
			m,
			first.state,
			new Map([["messages", { name: "messages", time_range: { until: JAN } }]]),
		);
		const { [item]: _gone, ...bare } = full;
		rows[0] = bare as FetchMessageObject;
		const widened = await run(m, narrowed.state, ["messages"]);
		assert.deepEqual(ofStream(widened, "messages"), [], "no stand-in values");
		assert.deepEqual(
			progressOf(widened).debt.map((d) => [d.uid, d.streams]),
			[[10, ["messages"]]],
		);
		rows[0] = full;
		const repaired = await run(m, widened.state, ["messages"]);
		assert.deepEqual(
			ofStream(repaired, "messages").map((x) => [
				x.data.is_seen,
				x.data.is_flagged,
				x.data.labels,
				x.data.size_bytes,
			]),
			[[true, true, ["label-10"], 20]],
		);
	});
}

test("evidence: undated messages that the requested resources exclude do not stall the walk", async () => {
	const excluded = Array.from({ length: 201 }, (_, i) => {
		const { internalDate: _d, ...bare } = message(i + 1);
		return bare as FetchMessageObject;
	});
	const wanted = message(900);
	const m = mailbox([...excluded, wanted], 1001, 202);
	const scope = new Map([
		["messages", { name: "messages", resources: [String(wanted.emailId)] }],
	]);
	let state: Record<string, unknown> = {};
	const written: unknown[] = [];
	for (let i = 0; i < 3; i += 1) {
		const r = await run(m, state, scope);
		state = r.state;
		written.push(...ofStream(r, "messages").map((x) => x.data.id));
		assert.deepEqual(progressOf(r).debt, [], `run ${i}: nothing is owed`);
	}
	assert.deepEqual(written, [wanted.emailId]);
});

test("evidence: empty flags, labels and header fields are known values", async () => {
	const row = {
		...message(10),
		flags: new Set<string>(),
		labels: new Set<string>(),
		headers: Buffer.from(""),
	};
	const m = mailbox([row], 101, 1);
	const r = await run(m, {}, ["messages"]);
	assert.deepEqual(
		ofStream(r, "messages").map((x) => [
			x.data.is_seen,
			x.data.labels,
			x.data.references,
		]),
		[[false, [], []]],
	);
	assert.deepEqual(progressOf(r).debt, []);
});
