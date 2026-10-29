// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Caller-level oracles for Gmail attachments under the progress ledger. Each
// test drives `runAllMailPasses` over a range-respecting in-memory mailbox,
// hydrates through the production hydrator and blob uploader (against a
// stubbed blob endpoint), carries the emitted STATE into the next run as the
// runtime would, and asserts only what leaves the connector: FETCH ranges,
// records, gap messages, coverage claims, and `state.messages.progress`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { resourceSet } from "@pdpp/connector-protocol";
import type { FetchMessageObject, ListResponse } from "imapflow";
import { ImapFlow } from "imapflow";
import type { DetailGapStartEntry } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type EmitRecordFn,
	makeEmitRecord,
	runAllMailPasses,
} from "./index.ts";
import type { EmittedMessage, StreamRequest } from "./types.ts";

const NOW = "2026-10-21T00:00:00.000Z";
const ALL_MAIL = { path: "[Gmail]/All Mail" } as ListResponse;

/** A message whose parts are PDF attachments `<emailId>:1`, `<emailId>:2`, ... */
function attachmentMessage(
	uid: number,
	emailId: string,
	sizes: readonly number[] = [16],
): FetchMessageObject {
	return {
		seq: uid,
		uid,
		emailId,
		threadId: (0xf000 + uid).toString(16),
		flags: new Set(["\\Seen"]),
		labels: new Set(["\\Inbox"]),
		internalDate: new Date(NOW),
		size: 1024,
		headers: Buffer.from(""),
		envelope: {
			subject: "With attachments",
			from: [{ address: `sender-${uid}@example.com` }],
		},
		bodyStructure: {
			type: "multipart/mixed",
			childNodes: sizes.map((size, i) => ({
				type: "application/pdf",
				disposition: "attachment",
				dispositionParameters: { filename: `attachment-${i + 1}.pdf` },
				encoding: "base64",
				size,
			})),
		},
	};
}

function servedGap(args: {
	gapId: string;
	messageId: string;
	partIndex: number;
	leaseId?: string;
}): DetailGapStartEntry {
	const attachmentId = `${args.messageId}:${args.partIndex}`;
	return {
		gap_id: args.gapId,
		...(args.leaseId ? { lease_id: args.leaseId } : {}),
		reference_only: true,
		status: "pending",
		stream: "attachments",
		record_key: attachmentId,
		detail_locator: {
			kind: "gmail.attachment_detail",
			attachment_id: attachmentId,
			message_id: args.messageId,
			part_index: String(args.partIndex),
		},
	};
}

function requested(names: string[]): Map<string, StreamRequest> {
	return new Map(names.map((name) => [name, { name }]));
}

type Lane = { through: number; coveredFrom: number; next: number };

/** STATE as a prior ledger run wrote it, in the same UID epoch. */
function ledgerState(streams: Record<string, Lane>, uidnext: number) {
	return {
		messages: {
			all_mail: { uidvalidity: 123, uidnext, forward_uidnext: uidnext },
			progress: { version: 1, uidvalidity: 123, streams, debt: [] },
		},
	};
}

function mailbox(rows: FetchMessageObject[], uidNext: number) {
	const ranges: string[] = [];
	const lookups: string[] = [];
	const downloads: string[] = [];
	const box = {
		path: ALL_MAIL.path,
		delimiter: "/",
		exists: rows.length,
		flags: new Set<string>(),
		uidNext,
		uidValidity: 123n,
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
		async download(uid: string, part: string) {
			downloads.push(`${uid}:${part}`);
			return {
				meta: { contentType: "application/pdf" },
				content: (async function* () {
					yield Buffer.from("pdf-bytes");
				})(),
			};
		},
		async search(query: { emailId?: string }) {
			if (query.emailId === undefined) return rows.map((r) => r.uid);
			lookups.push(query.emailId);
			return rows.filter((r) => r.emailId === query.emailId).map((r) => r.uid);
		},
		async fetchOne(uid: string | number) {
			const row = rows.find((r) => r.uid === Number(uid));
			return row
				? { ...row, bodyParts: new Map([["1", Buffer.from("hi")]]) }
				: false;
		},
		async *fetch(range: string) {
			ranges.push(range);
			for (const row of [...rows].sort((a, b) => a.uid - b.uid)) {
				if (inRange(range, row.uid)) yield row;
			}
		},
	} as unknown as Parameters<typeof runAllMailPasses>[0];
	return { client, box, rows, ranges, lookups, downloads };
}

interface RunOptions {
	detailGaps?: DetailGapStartEntry[];
	recoveryOnly?: boolean;
	/** Wrap the production emitter, for example to reject one record. */
	wrapEmitRecord?: (real: EmitRecordFn) => EmitRecordFn;
	/** Make a protocol write fail, as a lost gap write would. */
	failWrite?: (line: string) => boolean;
}

interface RunResult {
	protocol: EmittedMessage[];
	state: Record<string, unknown>;
}

/** Blob endpoint stand-in: hashes the uploaded bytes and echoes them back. */
const blobEndpoint = (async (_url: unknown, init?: RequestInit) => {
	const bytes = Buffer.from(
		await new Response(init?.body as BodyInit).arrayBuffer(),
	);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return new Response(
		JSON.stringify({
			object: "blob",
			blob_id: `blob-${sha256.slice(0, 12)}`,
			mime_type: "application/pdf",
			sha256,
			size_bytes: bytes.byteLength,
		}),
		{ status: 201, headers: { "content-type": "application/json" } },
	);
}) as typeof fetch;

async function run(
	m: ReturnType<typeof mailbox>,
	state: Record<string, unknown>,
	streams: Map<string, StreamRequest>,
	opts: RunOptions = {},
): Promise<RunResult> {
	const protocol: EmittedMessage[] = [];
	const originalWrite = process.stdout.write;
	const originalFetch = globalThis.fetch;
	const originalEnv = {
		PDPP_RS_URL: process.env.PDPP_RS_URL,
		PDPP_OWNER_TOKEN: process.env.PDPP_OWNER_TOKEN,
	};
	process.stdout.write = ((data: string) => {
		if (opts.failWrite?.(data)) throw new Error("gap persistence unavailable");
		try {
			protocol.push(JSON.parse(data) as EmittedMessage);
		} catch {
			/* not protocol */
		}
		return true;
	}) as typeof process.stdout.write;
	globalThis.fetch = blobEndpoint;
	process.env.PDPP_RS_URL = "http://rs.test";
	process.env.PDPP_OWNER_TOKEN = "test-owner-token";
	try {
		const filters = new Map<string, Set<string> | null>();
		for (const [name, scope] of streams) filters.set(name, resourceSet(scope));
		// The production emitter: resource filter, schema validation, and the
		// SKIP_RESULT on rejection, all written through the connector's stdout.
		const real = makeEmitRecord(filters, NOW, () => {});
		await runAllMailPasses(m.client, ALL_MAIL, state, {
			emittedAt: NOW,
			requested: streams,
			emitRecord: opts.wrapEmitRecord ? opts.wrapEmitRecord(real) : real,
			...(opts.detailGaps ? { detailGaps: opts.detailGaps } : {}),
			...(opts.recoveryOnly ? { recoveryOnly: true } : {}),
		});
	} finally {
		process.stdout.write = originalWrite;
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	const next = { ...state };
	for (const event of protocol) {
		if (event.type === "STATE") next[event.stream] = event.cursor;
	}
	return { protocol, state: next };
}

type Loose = Record<string, unknown>;
const events = (r: RunResult, type: string) =>
	r.protocol.filter((e) => e.type === type) as unknown as Loose[];
const recordKeys = (r: RunResult, stream: string) =>
	events(r, "RECORD")
		.filter((e) => e.stream === stream)
		.map((e) => e.key);
const attachmentCoverage = (r: RunResult) =>
	events(r, "DETAIL_COVERAGE").find((e) => e.stream === "attachments");
const recoveredGapIds = (r: RunResult) =>
	events(r, "DETAIL_GAP_RECOVERED").map((e) => e.gap_id);
const progressOf = (r: RunResult) =>
	(
		r.state.messages as {
			progress: {
				streams: Record<string, Lane>;
				debt: { uid: number; streams: string[]; attempts: number }[];
			};
		}
	).progress;

test("a served gap that never resolves cannot starve the attachment-only history", async () => {
	const rows = () => [
		attachmentMessage(300, "aa300"),
		attachmentMessage(450, "aa450"),
	];
	let state: Record<string, unknown> = ledgerState(
		{ attachments: { through: 250, coveredFrom: 500, next: 600 } },
		600,
	);
	// The served gap names a message that no longer exists: every run looks it
	// up, misses, and re-defers it.
	const gap = servedGap({
		gapId: "gap-miss",
		leaseId: "lease-miss",
		messageId: "dead01",
		partIndex: 1,
	});
	for (let i = 0; i < 4; i += 1) {
		const r = await run(
			mailbox(rows(), 600),
			state,
			requested(["attachments"]),
			{
				detailGaps: [gap],
			},
		);
		state = r.state;
	}
	const lane = (
		state.messages as { progress: { streams: Record<string, Lane> } }
	).progress.streams.attachments;
	assert.equal(
		(lane?.through ?? 0) + 1 >= (lane?.coveredFrom ?? 0),
		true,
		"the history completes",
	);
});

test("served attachment gaps share the run with an attachment-only history page, and served recovery still runs", async () => {
	const rows = () => [
		attachmentMessage(300, "aa300"),
		attachmentMessage(321, "fedcba01"),
	];
	const prior = ledgerState(
		{ attachments: { through: 250, coveredFrom: 500, next: 600 } },
		600,
	);
	const gap = servedGap({
		gapId: "gap-served-old",
		leaseId: "lease-old",
		messageId: "fedcba01",
		partIndex: 1,
	});

	const m = mailbox(rows(), 600);
	const r = await run(m, prior, requested(["attachments"]), {
		detailGaps: [gap],
	});
	// A served gap no longer vetoes the history page: the page runs on a
	// shared byte budget, so the history cannot starve behind recovery.
	assert.deepEqual(m.ranges, ["251:499"], "the history page still runs");
	assert.ok(
		(progressOf(r).streams.attachments?.through ?? 0) > 250,
		"the attachments history advances",
	);
	// The walk hydrates the served part and recovers its gap, so served
	// recovery does not download it a second time.
	assert.deepEqual(
		[...m.downloads].sort(),
		["300:1", "321:1"],
		"each part once",
	);
	assert.deepEqual(recoveredGapIds(r), ["gap-served-old"]);

	// Control: the same state with no served gaps walks the page.
	const control = mailbox(rows(), 600);
	const walked = await run(control, prior, requested(["attachments"]));
	assert.deepEqual(control.ranges, ["251:499"]);
	assert.deepEqual(recordKeys(walked, "attachments"), [
		"aa300:1",
		"fedcba01:1",
	]);
	assert.ok((progressOf(walked).streams.attachments?.through ?? 0) >= 499);

	// A page shared with another stream is not attachment-only: it still walks.
	const shared = mailbox(rows(), 600);
	const both = await run(
		shared,
		ledgerState(
			{
				messages: { through: 250, coveredFrom: 500, next: 600 },
				attachments: { through: 250, coveredFrom: 500, next: 600 },
			},
			600,
		),
		requested(["messages", "attachments"]),
		{ detailGaps: [gap] },
	);
	assert.deepEqual(shared.ranges, ["251:499"]);
	assert.deepEqual(recoveredGapIds(both), ["gap-served-old"]);
	assert.ok((progressOf(both).streams.attachments?.through ?? 0) >= 499);
});

test("recoveryOnly=true recovers served gaps and runs no walk", async () => {
	const rows = () => [
		attachmentMessage(300, "aa300"),
		attachmentMessage(321, "fedcba01"),
		attachmentMessage(650, "aa650"),
	];
	// History is owed (251..499) and so is forward work (600..699).
	const prior = ledgerState(
		{ attachments: { through: 250, coveredFrom: 500, next: 600 } },
		600,
	);
	const gap = servedGap({
		gapId: "gap-served-only",
		leaseId: "lease-only",
		messageId: "fedcba01",
		partIndex: 1,
	});

	const m = mailbox(rows(), 700);
	const r = await run(m, prior, requested(["attachments"]), {
		detailGaps: [gap],
		recoveryOnly: true,
	});
	assert.deepEqual(m.ranges, [], "no historical or forward FETCH");
	assert.deepEqual(m.lookups, ["fedcba01"]);
	assert.deepEqual(recordKeys(r, "attachments"), ["fedcba01:1"]);
	assert.deepEqual(recoveredGapIds(r), ["gap-served-only"]);
	assert.deepEqual(events(r, "STATE"), [], "no STATE of any stream");
	assert.equal(attachmentCoverage(r), undefined, "no inventory claim");
	assert.ok(
		events(r, "PROGRESS").some((e) => e.stream === "attachments"),
		"recovery progress is still reported",
	);

	// Control: without recoveryOnly the same run walks the history page and
	// the forward lane.
	const control = mailbox(rows(), 700);
	const walked = await run(control, prior, requested(["attachments"]), {
		detailGaps: [gap],
	});
	assert.deepEqual(control.ranges, ["251:499", "600:699"]);
	assert.ok(events(walked, "STATE").some((e) => e.stream === "messages"));
});

for (const lane of ["historical", "served", "recovery-only"] as const) {
	for (const rejectSelected of [false, true]) {
		test(`attachment resources stay scoped: ${lane}, schema rejected=${rejectSelected}`, async () => {
			const m = mailbox([attachmentMessage(321, "abc123", [16, 16])], 401);
			const scope = new Map<string, StreamRequest>([
				["attachments", { name: "attachments", resources: ["abc123:1"] }],
			]);
			const served = lane !== "historical";
			const r = await run(
				m,
				served
					? ledgerState(
							{ attachments: { through: 400, coveredFrom: 401, next: 401 } },
							401,
						)
					: {},
				scope,
				{
					...(served
						? {
								detailGaps: [1, 2].map((partIndex) =>
									servedGap({
										gapId: `caller-gap-${partIndex}`,
										leaseId: `caller-lease-${partIndex}`,
										messageId: "abc123",
										partIndex,
									}),
								),
							}
						: {}),
					recoveryOnly: lane === "recovery-only",
					wrapEmitRecord: (real) => (stream, data, keyField) =>
						real(
							stream,
							rejectSelected && stream === "attachments"
								? { ...data, size_bytes: -1 }
								: data,
							keyField,
						),
				},
			);
			assert.deepEqual(
				m.downloads,
				["321:1"],
				"the excluded sibling is never hydrated",
			);
			assert.deepEqual(
				recordKeys(r, "attachments"),
				rejectSelected ? [] : ["abc123:1"],
			);
			assert.deepEqual(
				recoveredGapIds(r),
				served && !rejectSelected ? ["caller-gap-1"] : [],
				"a rejected record never recovers its gap",
			);
			assert.equal(
				events(r, "DETAIL_GAP").some((e) => e.record_key === "abc123:2"),
				false,
				"the excluded sibling is not deferred",
			);
			const rejected = events(r, "SKIP_RESULT").filter(
				(e) => e.reason === "schema_validation_failed",
			);
			assert.equal(rejected.length, rejectSelected ? 1 : 0);
			if (rejectSelected) {
				assert.match(String(rejected[0]?.message), /abc123:1/);
			}
			if (served) {
				assert.deepEqual(m.ranges, [], "served lanes fetch no UID range");
				assert.deepEqual(
					events(r, "DETAIL_GAP_ATTEMPTED").map((e) => ({
						gap_id: e.gap_id,
						lease_id: e.lease_id,
					})),
					[
						{ gap_id: "caller-gap-1", lease_id: "caller-lease-1" },
						{ gap_id: "caller-gap-2", lease_id: "caller-lease-2" },
					],
				);
			} else {
				assert.deepEqual(m.ranges, ["1:400"]);
			}
			const claim = attachmentCoverage(r);
			if (lane === "recovery-only") {
				assert.equal(claim, undefined, "a retry list is not an inventory");
			} else {
				assert.ok(claim, "the run makes the inventory claim");
				assert.deepEqual(claim.required_keys, ["abc123:1"]);
				assert.deepEqual(
					claim.hydrated_keys,
					rejectSelected ? [] : ["abc123:1"],
					"only an accepted record is credited hydrated",
				);
			}
		});
	}
}

const REJECTION_LOCATOR = '"attachment_record_rejected"';

for (const rejection of ["false", "schema", "throw"] as const) {
	for (const locator of ["gap", "debt"] as const) {
		test(`a rejected attachment is retried until accepted: ${rejection}, via ${locator}`, async () => {
			const m = mailbox(
				[attachmentMessage(321, "abc123"), attachmentMessage(701, "def456")],
				1201,
			);
			const streams = requested(["messages", "attachments"]);
			const once = (
				state: Record<string, unknown>,
				reject: boolean,
				gaps?: DetailGapStartEntry[],
			) =>
				run(m, state, streams, {
					...(gaps ? { detailGaps: gaps } : {}),
					// The debt case models a lost gap write: no retry locator lands.
					...(locator === "debt"
						? { failWrite: (line) => line.includes(REJECTION_LOCATOR) }
						: {}),
					wrapEmitRecord: (real) => async (stream, data, keyField) => {
						const target = reject && data.id === "abc123:1";
						if (target && rejection === "throw") {
							throw new Error("local rejection");
						}
						if (target && rejection === "false") return false;
						const record = target ? { ...data, size_bytes: -1 } : data;
						return (await real(stream, record, keyField)) !== false;
					},
				});
			// The host serves back the pending gap the connector wrote.
			const hostServes = (r: RunResult, lease: string) => {
				const written = events(r, "DETAIL_GAP").find(
					(e) => e.record_key === "abc123:1",
				);
				assert.ok(written, "a retry locator was written");
				assert.equal(written.retryable, true);
				assert.equal(written.status, "pending");
				return [
					{
						gap_id: (written.gap_id as string | undefined) ?? "host-gap-1",
						lease_id: lease,
						reference_only: true,
						status: "pending",
						stream: "attachments",
						record_key: "abc123:1",
						detail_locator: written.detail_locator,
					} as DetailGapStartEntry,
				];
			};

			// Run 1 (rejects): the page 1..500 still commits past UID 321.
			const r1 = await once({}, true);
			let p = progressOf(r1);
			assert.equal(
				p.streams.messages?.through,
				500,
				"messages progress advances",
			);
			assert.equal(
				p.streams.attachments?.through,
				500,
				"attachments cursor passes the UID",
			);
			assert.deepEqual(recordKeys(r1, "attachments"), []);
			assert.equal(attachmentCoverage(r1), undefined, "no claim mid-walk");
			assert.equal(
				events(r1, "SKIP_RESULT").some(
					(e) => e.reason === "schema_validation_failed",
				),
				rejection === "schema",
			);
			let gaps: DetailGapStartEntry[] | undefined;
			if (locator === "gap") {
				assert.deepEqual(p.debt, [], "a written locator is not ledger debt");
				const gapAt = r1.protocol.findIndex(
					(e) => e.type === "DETAIL_GAP" && e.record_key === "abc123:1",
				);
				const stateAt = r1.protocol.findIndex(
					(e) => e.type === "STATE" && e.stream === "messages",
				);
				assert.ok(
					gapAt >= 0 && gapAt < stateAt,
					"the locator lands before STATE",
				);
				gaps = hostServes(r1, "lease-2");
			} else {
				assert.deepEqual(
					p.debt.map((d) => ({
						uid: d.uid,
						streams: d.streams,
						attempts: d.attempts,
					})),
					[{ uid: 321, streams: ["attachments"], attempts: 1 }],
				);
				assert.equal(
					events(r1, "DETAIL_GAP").some((e) => e.record_key === "abc123:1"),
					false,
				);
			}

			// Run 2 (still rejects): the walk moves on and collects later mail.
			const r2 = await once(r1.state, true, gaps);
			p = progressOf(r2);
			assert.equal(p.streams.messages?.through, 1000);
			assert.equal(p.streams.attachments?.through, 1000);
			assert.deepEqual(recordKeys(r2, "attachments"), ["def456:1"]);
			assert.deepEqual(
				recordKeys(r2, "messages"),
				["def456"],
				"321's message is not re-emitted",
			);
			assert.deepEqual(recoveredGapIds(r2), []);
			if (locator === "gap") {
				const redeferred = events(r2, "DETAIL_GAP").filter(
					(e) => e.record_key === "abc123:1",
				);
				assert.equal(
					redeferred.length,
					1,
					"the served gap is re-deferred, not duplicated",
				);
				assert.equal(redeferred[0]?.gap_id, gaps?.[0]?.gap_id);
				assert.equal(redeferred[0]?.lease_id, "lease-2");
				assert.deepEqual(redeferred[0]?.last_error, {
					class: "attachment_record_rejected",
				});
				gaps = hostServes(r2, "lease-3");
			} else {
				assert.deepEqual(
					p.debt.map((d) => ({ uid: d.uid, attempts: d.attempts })),
					[{ uid: 321, attempts: 2 }],
					"the UID was retried and stays owed",
				);
			}

			// Run 3 (still rejects): history completes; owed debt withholds the claim.
			const r3 = await once(r2.state, true, gaps);
			p = progressOf(r3);
			const lane3 = p.streams.attachments;
			assert.ok(
				lane3 && lane3.through + 1 >= lane3.coveredFrom,
				"history completes",
			);
			if (locator === "gap") {
				const claim = attachmentCoverage(r3);
				assert.ok(claim, "a gap-backed key does not withhold the claim");
				assert.deepEqual(claim.hydrated_keys, []);
				assert.deepEqual(claim.gap_keys, ["abc123:1"]);
				gaps = hostServes(r3, "lease-4");
			} else {
				assert.equal(
					attachmentCoverage(r3),
					undefined,
					"debt withholds the claim",
				);
				assert.deepEqual(
					p.debt.map((d) => d.uid),
					[321],
				);
			}

			// Run 4 (accepts): the attachment is collected and the obligation settles.
			const r4 = await once(r3.state, false, gaps);
			p = progressOf(r4);
			assert.deepEqual(recordKeys(r4, "attachments"), ["abc123:1"]);
			assert.deepEqual(
				recordKeys(r4, "messages"),
				[],
				"only the owed stream is retried",
			);
			assert.deepEqual(p.debt, []);
			assert.deepEqual(
				recoveredGapIds(r4),
				locator === "gap" ? [gaps?.[0]?.gap_id] : [],
			);
			const claim = attachmentCoverage(r4);
			assert.ok(claim, "the inventory claim arrives once nothing is owed");
			assert.deepEqual(claim.hydrated_keys, ["abc123:1"]);

			// Run 5: nothing is owed, so nothing is retried.
			const r5 = await once(r4.state, false);
			assert.deepEqual(recordKeys(r5, "attachments"), []);
			assert.deepEqual(progressOf(r5).debt, []);
		});
	}
}

test("a retried attachment UID never overwrites a hydrated sibling with a failed record", async () => {
	const savedCap = process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
	process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = "20";
	try {
		// Part 1 (16 bytes) hydrates; part 2 (30 bytes) is over the cap, so the
		// UID stays owed and is retried with both parts.
		const m = mailbox([attachmentMessage(10, "a", [16, 30])], 101);
		const first = await run(m, {}, requested(["attachments"]));
		const a1 = events(first, "RECORD").find((e) => e.key === "a:1") as
			| { data: { hydration_status: string; blob_ref: unknown } }
			| undefined;
		assert.equal(a1?.data.hydration_status, "hydrated");
		assert.deepEqual(
			progressOf(first).debt.map((d) => d.uid),
			[10],
		);
		// The retry's download of part 1 fails transiently.
		(m.client as unknown as { download: () => Promise<never> }).download =
			async () => {
				throw new Error("temporary download error");
			};
		const second = await run(m, first.state, requested(["attachments"]));
		const overwritten = events(second, "RECORD").find(
			(e) =>
				e.key === "a:1" &&
				(e.data as { hydration_status?: string }).hydration_status !==
					"hydrated",
		);
		assert.equal(
			overwritten,
			undefined,
			"the stored hydrated part is not replaced",
		);
		assert.ok(
			events(second, "DETAIL_GAP").some((e) => e.record_key === "a:1"),
			"the failed reattempt leaves a retry locator instead",
		);
	} finally {
		if (savedCap === undefined)
			delete process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
		else process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = savedCap;
	}
});

test("the attachments inventory claim waits for forward work the ledger could not account", async () => {
	const row = attachmentMessage(201, "c9");
	(row.envelope as { date?: unknown }).date = "malformed provider date";
	const m = mailbox([row], 202);
	const state = ledgerState(
		{
			attachments: { through: 200, coveredFrom: 201, next: 201 },
			message_bodies: { through: 200, coveredFrom: 201, next: 201 },
		},
		201,
	);
	(state.messages as { progress: { debt: unknown[] } }).progress.debt =
		Array.from({ length: 200 }, (_, i) => ({
			uid: i + 1,
			streams: ["message_bodies"],
			attempts: 1,
			failure: "unreadable",
		}));
	const r = await run(m, state, requested(["attachments"]));
	assert.equal(progressOf(r).streams.attachments?.next, 201, "UID 201 is held");
	assert.equal(
		attachmentCoverage(r),
		undefined,
		"no claim while forward work is held",
	);
});

test("served recovery never overwrites a stored hydrated part with a failed record", async () => {
	const m = mailbox([attachmentMessage(10, "a", [16])], 101);
	const landed: Loose[] = [];
	// Run 1 hydrates a:1 (the record lands), then fails before its STATE.
	await assert.rejects(() =>
		run(m, {}, requested(["attachments"]), {
			wrapEmitRecord: (real) => async (stream, data, keyField) => {
				const accepted = (await real(stream, data, keyField)) === true;
				if (accepted && stream === "attachments") landed.push(data);
				return accepted;
			},
			failWrite: (line) =>
				line.includes('"type":"STATE"') && line.includes('"stream":"messages"'),
		}),
	);
	assert.equal(
		landed.find((e) => e.id === "a:1")?.hydration_status,
		"hydrated",
	);
	(m.client as unknown as { download: () => Promise<never> }).download =
		async () => {
			throw new Error("temporary download error");
		};
	// Run 2 replays the page; the download fails, so only a gap is written.
	const replay = await run(m, {}, requested(["attachments"]));
	assert.equal(recordKeys(replay, "attachments").length, 0);
	const gap = events(replay, "DETAIL_GAP").find((e) => e.record_key === "a:1");
	assert.ok(gap);
	// Run 3 is served that gap and the download fails again.
	const served = servedGap({
		gapId: String(gap.gap_id ?? "host-gap-1"),
		messageId: "a",
		partIndex: 1,
		leaseId: "lease-1",
	});
	const retry = await run(m, replay.state, requested(["attachments"]), {
		detailGaps: [served],
	});
	assert.equal(
		events(retry, "RECORD").some((e) => e.key === "a:1"),
		false,
		"a failed served attempt writes no record over the stored part",
	);
	assert.ok(
		events(retry, "DETAIL_GAP").some((e) => e.gap_id === served.gap_id),
		"the served gap is re-deferred under its lease instead",
	);
});

test("a lowered size cap never overwrites a stored hydrated part with too_large", async () => {
	const savedCap = process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
	try {
		process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = "20";
		const m = mailbox([attachmentMessage(10, "a", [16, 30])], 101);
		const first = await run(m, {}, requested(["attachments"]));
		assert.equal(
			(events(first, "RECORD").find((e) => e.key === "a:1")?.data as Loose)
				?.hydration_status,
			"hydrated",
		);
		process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = "10";
		const retry = await run(m, first.state, requested(["attachments"]));
		assert.equal(
			events(retry, "RECORD").some(
				(e) =>
					e.key === "a:1" && (e.data as Loose).hydration_status !== "hydrated",
			),
			false,
			"an over-cap reattempt writes no record over the stored part",
		);
	} finally {
		if (savedCap === undefined)
			delete process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES;
		else process.env.PDPP_GMAIL_MAX_ATTACHMENT_BYTES = savedCap;
	}
});

test("hydration: a NIL part chunk after the first fails the transfer and keeps the stored attachment", async () => {
	const CHUNK = 64 * 1024; // imapflow's default download chunk
	const row = attachmentMessage(10, "a", [CHUNK + 10]);
	const node = row.bodyStructure?.childNodes?.[0];
	assert.ok(node);
	node.encoding = "binary";
	row.internalDate = new Date("2026-05-15T00:00:00.000Z");
	const bytes = Buffer.concat([Buffer.alloc(CHUNK, 65), Buffer.alloc(10, 66)]);
	const m = mailbox([row], 101);
	let nilAfterFirstChunk = false;
	// Production `download` is `ImapFlow.prototype.download`: it reads the
	// part through the client's own `fetchOne`, one partial FETCH per chunk.
	Object.assign(m.client, {
		_openDownloads: 0,
		autoidle() {},
		log: { warn() {}, error() {} },
		download: ImapFlow.prototype.download,
		async fetchOne(
			_uid: string,
			query: { bodyStructure?: boolean; bodyParts?: unknown[] },
		) {
			if (query.bodyStructure && !query.bodyParts) return row;
			const request = query.bodyParts?.find(
				(p): p is { key: string; start: number; maxLength: number } =>
					typeof p === "object",
			);
			assert.ok(request);
			const chunk =
				nilAfterFirstChunk && request.start > 0
					? null
					: bytes.subarray(request.start, request.start + request.maxLength);
			return {
				uid: 10,
				size: 70_000,
				bodyParts: new Map([
					[request.key, chunk],
					[
						`${request.key}.mime`,
						Buffer.from(
							"Content-Type: application/pdf\r\nContent-Transfer-Encoding: binary\r\n\r\n",
						),
					],
				]),
			};
		},
	});
	const sizes = (r: RunResult) =>
		events(r, "RECORD")
			.filter((e) => e.stream === "attachments")
			.map((e) => (e.data as Loose).size_bytes);
	const streams = requested(["attachments"]);
	const first = await run(m, {}, streams);
	assert.deepEqual(sizes(first), [CHUNK + 10]);
	// Narrow, then widen again: the catch-up re-reads the stored attachment.
	const narrowed = await run(
		m,
		first.state,
		new Map([
			[
				"attachments",
				{
					name: "attachments",
					time_range: { until: "2026-02-01T00:00:00.000Z" },
				},
			],
		]),
	);
	nilAfterFirstChunk = true;
	const truncated = await run(m, narrowed.state, streams);
	assert.deepEqual(
		sizes(truncated),
		[],
		"no short file replaces the stored one",
	);
	// A failed part is held by its retry gap; the runtime serves it back.
	const gaps = events(truncated, "DETAIL_GAP");
	assert.deepEqual(
		gaps.map((g) => g.record_key),
		["a:1"],
	);
	nilAfterFirstChunk = false;
	const served = gaps[0] as unknown as DetailGapStartEntry;
	const repaired = await run(m, truncated.state, streams, {
		detailGaps: [{ ...served, status: "pending" }],
	});
	assert.deepEqual(sizes(repaired), [CHUNK + 10]);
	assert.deepEqual(recoveredGapIds(repaired), [served.gap_id]);
});

test("served recovery defers a gap whose message FETCH comes back without INTERNALDATE", async () => {
	const { internalDate: _d, ...bare } = attachmentMessage(10, "a", [16]);
	const m = mailbox([bare as FetchMessageObject], 101);
	const served = servedGap({
		gapId: "gap-undated",
		messageId: "a",
		partIndex: 1,
		leaseId: "lease-undated",
	});
	const r = await run(m, {}, requested(["attachments"]), {
		detailGaps: [served],
		recoveryOnly: true,
	});
	assert.deepEqual(
		recordKeys(r, "attachments"),
		[],
		"no record with an invented date",
	);
	assert.deepEqual(
		m.downloads,
		[],
		"nothing is downloaded for an unplaced part",
	);
	assert.deepEqual(
		events(r, "DETAIL_GAP")
			.filter((e) => e.gap_id === served.gap_id)
			.map((e) => (e.last_error as Loose | undefined)?.class),
		["internaldate_unavailable"],
		"the served gap stays deferred under its lease",
	);
	assert.deepEqual(recoveredGapIds(r), []);
});

test("hydration: a NIL part MIME header fails the transfer instead of storing undecoded base64", async () => {
	const raw = Buffer.from("%PDF-original bytes");
	const encoded = Buffer.from(raw.toString("base64"));
	const row = attachmentMessage(10, "a", [encoded.length]);
	row.internalDate = new Date("2026-05-15T00:00:00.000Z");
	const m = mailbox([row], 101);
	let mimeAbsent = false;
	// imapflow picks the transfer decoder from the part's MIME header, read
	// in the same FETCH as the first chunk.
	Object.assign(m.client, {
		_openDownloads: 0,
		autoidle() {},
		log: { warn() {}, error() {} },
		download: ImapFlow.prototype.download,
		async fetchOne(
			_uid: string,
			query: { bodyStructure?: boolean; bodyParts?: unknown[] },
		) {
			if (query.bodyStructure && !query.bodyParts) return row;
			const request = query.bodyParts?.find(
				(p): p is { key: string; start: number; maxLength: number } =>
					typeof p === "object",
			);
			assert.ok(request);
			return {
				uid: 10,
				size: 1024,
				bodyParts: new Map([
					[
						request.key,
						encoded.subarray(request.start, request.start + request.maxLength),
					],
					[
						`${request.key}.mime`,
						mimeAbsent
							? null
							: Buffer.from(
									"Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n",
								),
					],
				]),
			};
		},
	});
	const hashes = (r: RunResult) =>
		events(r, "RECORD")
			.filter((e) => e.stream === "attachments")
			.map((e) => (e.data as Loose).content_sha256);
	const rawSha = createHash("sha256").update(raw).digest("hex");
	const streams = requested(["attachments"]);
	const first = await run(m, {}, streams);
	assert.deepEqual(hashes(first), [rawSha]);
	// Narrow, then widen again: the catch-up re-reads the stored attachment.
	const narrowed = await run(
		m,
		first.state,
		new Map([
			[
				"attachments",
				{
					name: "attachments",
					time_range: { until: "2026-02-01T00:00:00.000Z" },
				},
			],
		]),
	);
	mimeAbsent = true;
	const undecoded = await run(m, narrowed.state, streams);
	assert.deepEqual(hashes(undecoded), [], "no base64 text replaces the PDF");
	const gaps = events(undecoded, "DETAIL_GAP");
	assert.deepEqual(
		gaps.map((g) => g.record_key),
		["a:1"],
	);
	mimeAbsent = false;
	const served = gaps[0] as unknown as DetailGapStartEntry;
	const repaired = await run(m, undecoded.state, streams, {
		detailGaps: [{ ...served, status: "pending" }],
	});
	assert.deepEqual(hashes(repaired), [rawSha]);
	assert.equal(
		(m.client as unknown as { _openDownloads: number })._openDownloads,
		0,
	);
});
