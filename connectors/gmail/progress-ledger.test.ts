// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEBT_RETRIES_PER_RUN,
	GmailProgressLedger,
	type GmailProgressState,
	type LedgerStream,
	MAX_RETRY_DEBT,
	persistedProgressProblem,
} from "./progress-ledger.ts";

const NOW = "2026-10-21T00:00:00.000Z";

function open(args: {
	persisted?: unknown;
	uidnext: number;
	streams: LedgerStream[];
	fullResync?: boolean;
	window?: number;
	legacy?: ConstructorParameters<typeof GmailProgressLedger>[0]["legacy"];
	uidvalidity?: number;
}) {
	return new GmailProgressLedger({
		persisted: args.persisted,
		legacy: args.legacy ?? {},
		fullResync: args.fullResync ?? args.persisted === undefined,
		uidvalidity: args.uidvalidity ?? 123,
		uidnext: args.uidnext,
		requested: new Set(args.streams),
		windowUids: args.window ?? 500,
	});
}

/** Account every expected UID in a range as covered, as a clean run would. */
function coverAll(ledger: GmailProgressLedger, uids: number[]) {
	for (const uid of uids) {
		const streams = ledger.expect(uid);
		if (streams.length > 0) ledger.record(uid, streams, { kind: "covered" });
	}
}

const range = (a: number, b: number) =>
	Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

test("ledger: a first run walks one bounded history page and no forward lane", () => {
	const ledger = open({ uidnext: 1201, streams: ["messages"] });
	assert.deepEqual(ledger.historical, { start: 1, end: 500 });
	assert.equal(ledger.forward, null);
	coverAll(ledger, [100, 400]);
	const c = ledger.commit(NOW);
	assert.deepEqual(c.state.streams.messages, {
		through: 500,
		coveredFrom: 1201,
		next: 1201,
	});
	assert.deepEqual(c.historyPage.messages, { start: 1, end: 500 });
	assert.deepEqual(c.continuation.messages, { start: 1, end: 500 });
	assert.equal(c.historyComplete.messages, false);
	assert.equal(
		c.compat.backfill.completed_at,
		null,
		"a partial page is not complete",
	);
});

test("ledger: history and forward lanes are disjoint as mail arrives during the walk", () => {
	const first = open({ uidnext: 1201, streams: ["messages"] }).commit(NOW);
	const ledger = open({
		persisted: first.state,
		uidnext: 1301,
		streams: ["messages"],
	});
	assert.deepEqual(ledger.historical, { start: 501, end: 1000 });
	assert.deepEqual(ledger.forward, { start: 1201, end: 1300 });
	assert.deepEqual(ledger.streamsFor(1250), ["messages"]);
	assert.deepEqual(
		ledger.streamsFor(1100),
		[],
		"between page and forward lane",
	);
	const c = ledger.commit(NOW);
	assert.deepEqual(c.state.streams.messages, {
		through: 1000,
		coveredFrom: 1201,
		next: 1301,
	});
	const last = open({
		persisted: c.state,
		uidnext: 1301,
		streams: ["messages"],
	});
	assert.deepEqual(
		last.historical,
		{ start: 1001, end: 1200 },
		"history stops below the forward lane",
	);
	const done = last.commit(NOW);
	assert.deepEqual(done.state.streams.messages, {
		through: 1300,
		coveredFrom: 1301,
		next: 1301,
	});
	assert.equal(done.historyComplete.messages, true);
	assert.equal(done.continuation.messages, undefined);
});

test("ledger: a completed history is never reopened by new mail", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 1200, coveredFrom: 1201, next: 1201 } },
		debt: [],
	};
	const ledger = open({ persisted, uidnext: 1301, streams: ["messages"] });
	assert.equal(ledger.historical, null);
	assert.deepEqual(ledger.forward, { start: 1201, end: 1300 });
});

test("ledger: an uncommitted run replays the same page (STATE is the only durability)", () => {
	const persisted = open({ uidnext: 1201, streams: ["messages"] }).commit(
		NOW,
	).state;
	const a = open({ persisted, uidnext: 1201, streams: ["messages"] });
	const b = open({ persisted, uidnext: 1201, streams: ["messages"] });
	assert.deepEqual(a.historical, b.historical);
});

test("ledger: a stream first requested later walks its own history from UID 1", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 1200, coveredFrom: 1201, next: 1201 } },
		debt: [],
	};
	const ledger = open({
		persisted,
		uidnext: 1201,
		streams: ["messages", "attachments"],
	});
	assert.deepEqual(ledger.historical, { start: 1, end: 500 });
	assert.deepEqual(ledger.historicalStreams, ["attachments"]);
	assert.deepEqual(ledger.streamsFor(10), ["attachments"]);
	const c = ledger.commit(NOW);
	assert.equal(c.attachmentsInventoryComplete, false);
	assert.equal(c.historyComplete.messages, true);
});

test("ledger: a stream further ahead joins the page where its own history resumes", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: {
			messages: { through: 300, coveredFrom: 1201, next: 1201 },
			attachments: { through: 100, coveredFrom: 1201, next: 1201 },
		},
		debt: [],
	};
	const ledger = open({
		persisted,
		uidnext: 1201,
		streams: ["messages", "attachments"],
	});
	assert.deepEqual(ledger.historical, { start: 101, end: 600 });
	assert.deepEqual(ledger.streamsFor(200), ["attachments"]);
	assert.deepEqual(ledger.streamsFor(400), ["messages", "attachments"]);
	const c = ledger.commit(NOW);
	assert.equal(c.state.streams.messages?.through, 600);
	assert.equal(c.state.streams.attachments?.through, 600);
	assert.deepEqual(c.historyPage.messages, { start: 301, end: 600 });
});

test("ledger: a failure becomes debt, the cursor passes it, and a later run settles it", () => {
	const ledger = open({
		uidnext: 301,
		streams: ["messages", "message_bodies"],
	});
	ledger.expect(100);
	ledger.record(100, ["messages"], { kind: "covered" });
	ledger.record(100, ["message_bodies"], {
		kind: "failed",
		failure: "transient_transport",
	});
	const c = ledger.commit(NOW);
	assert.equal(c.state.streams.message_bodies?.through, 300);
	assert.deepEqual(c.state.debt, [
		{
			uid: 100,
			streams: ["message_bodies"],
			attempts: 1,
			failure: "transient_transport",
		},
	]);
	assert.equal(c.historyComplete.message_bodies, true, "history walked");
	const retry = open({
		persisted: c.state,
		uidnext: 301,
		streams: ["messages", "message_bodies"],
	});
	assert.deepEqual(retry.debtUids, [100]);
	assert.deepEqual(
		retry.streamsFor(100),
		["message_bodies"],
		"only the failed stream retries",
	);
	retry.expect(100);
	retry.record(100, ["message_bodies"], { kind: "covered" });
	assert.deepEqual(retry.commit(NOW).state.debt, []);
});

test("ledger: a debt retry that fails again rejoins the tail with one more attempt", () => {
	const debt = range(1, DEBT_RETRIES_PER_RUN + 2).map((uid) => ({
		uid,
		streams: ["messages" as const],
		attempts: 1,
		failure: "x",
	}));
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 100, coveredFrom: 101, next: 101 } },
		debt,
	};
	const ledger = open({ persisted, uidnext: 101, streams: ["messages"] });
	assert.equal(ledger.debtUids.length, DEBT_RETRIES_PER_RUN);
	for (const uid of ledger.debtUids) {
		ledger.expect(uid);
		ledger.record(uid, ["messages"], { kind: "failed", failure: "y" });
	}
	const next = ledger.commit(NOW).state.debt;
	assert.deepEqual(
		next.slice(0, 2).map((d) => d.uid),
		[DEBT_RETRIES_PER_RUN + 1, DEBT_RETRIES_PER_RUN + 2],
		"untried entries move to the head",
	);
	assert.equal(next.at(-1)?.attempts, 2);
	assert.equal(next.at(-1)?.failure, "y");
});

test("ledger: a full debt list holds the cursor at the first unrecordable failure", () => {
	const debt = range(1, MAX_RETRY_DEBT).map((uid) => ({
		uid: uid + 1000,
		streams: ["attachments" as const],
		attempts: 1,
		failure: "x",
	}));
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 0, coveredFrom: 2001, next: 2001 } },
		debt,
	};
	const ledger = open({ persisted, uidnext: 2001, streams: ["messages"] });
	ledger.expect(10);
	ledger.record(10, ["messages"], { kind: "covered" });
	ledger.expect(20);
	ledger.record(20, ["messages"], { kind: "failed", failure: "z" });
	ledger.expect(30);
	ledger.record(30, ["messages"], { kind: "covered" });
	const c = ledger.commit(NOW);
	assert.equal(c.state.streams.messages?.through, 19);
	assert.deepEqual(c.unaccounted, [20]);
	assert.equal(c.state.debt.length, MAX_RETRY_DEBT);
});

test("ledger: an absent debt UID settles", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 100, coveredFrom: 101, next: 101 } },
		debt: [{ uid: 50, streams: ["messages"], attempts: 3, failure: "x" }],
	};
	const ledger = open({ persisted, uidnext: 101, streams: ["messages"] });
	ledger.recordAbsentDebt(new Set());
	assert.deepEqual(ledger.commit(NOW).state.debt, []);
});

test("ledger: debt for a stream not requested this run is kept untouched", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: {
			messages: { through: 100, coveredFrom: 101, next: 101 },
			attachments: { through: 100, coveredFrom: 101, next: 101 },
		},
		debt: [{ uid: 50, streams: ["attachments"], attempts: 1, failure: "x" }],
	};
	const ledger = open({ persisted, uidnext: 101, streams: ["messages"] });
	assert.deepEqual(ledger.debtUids, []);
	assert.deepEqual(ledger.commit(NOW).state.debt, persisted.debt);
});

test("ledger: out_of_scope and terminal outcomes advance the cursor; only covered counts as covered", () => {
	const ledger = open({ uidnext: 11, streams: ["messages"] });
	ledger.expect(1);
	ledger.record(1, ["messages"], { kind: "out_of_scope" });
	ledger.expect(2);
	ledger.record(2, ["messages"], {
		kind: "terminal",
		reason: "missing_message_id",
	});
	ledger.expect(3);
	ledger.record(3, ["messages"], { kind: "covered" });
	const c = ledger.commit(NOW);
	assert.equal(c.state.streams.messages?.through, 10);
	assert.deepEqual(c.coverage.messages, { considered: 2, covered: 1 });
	assert.deepEqual(c.state.debt, []);
});

test("ledger: an expected UID with no reported outcome holds the cursor before it", () => {
	const ledger = open({ uidnext: 11, streams: ["messages"] });
	ledger.expect(3);
	ledger.record(3, ["messages"], { kind: "covered" });
	ledger.expect(6);
	const c = ledger.commit(NOW);
	assert.equal(c.state.streams.messages?.through, 5);
	assert.deepEqual(c.unaccounted, [6]);
});

test("ledger: limitHistorical shortens the page; it cannot follow consumption", () => {
	const ledger = open({ uidnext: 1201, streams: ["attachments"] });
	ledger.limitHistorical(120);
	assert.deepEqual(ledger.historical, { start: 1, end: 120 });
	ledger.expect(10);
	ledger.record(10, ["attachments"], { kind: "covered" });
	assert.throws(() => ledger.limitHistorical(100), /already_consumed/);
	assert.equal(ledger.commit(NOW).state.streams.attachments?.through, 120);
});

test("ledger: UIDVALIDITY change resets every stream and drops debt", () => {
	const persisted: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { messages: { through: 1200, coveredFrom: 1201, next: 1201 } },
		debt: [{ uid: 5, streams: ["messages"], attempts: 1, failure: "x" }],
	};
	const ledger = open({
		persisted,
		uidnext: 301,
		uidvalidity: 789,
		fullResync: true,
		streams: ["messages"],
	});
	assert.equal(ledger.resetReason, "full_resync");
	assert.deepEqual(ledger.historical, { start: 1, end: 300 });
	assert.deepEqual(ledger.commit(NOW).state.debt, []);
});

test("ledger: invalid persisted state falls back to the legacy cursors and says why", () => {
	assert.equal(
		persistedProgressProblem({ version: 9 }, 123, 100),
		"unknown_version",
	);
	const ledger = open({
		persisted: {
			version: 1,
			uidvalidity: 123,
			streams: { messages: { through: -1 } },
			debt: [],
		},
		fullResync: false,
		uidnext: 1301,
		streams: ["messages"],
		legacy: { forwardUidnext: 1201, messagesBackfillThrough: 1200 },
	});
	assert.equal(ledger.resetReason, "stream:messages");
	assert.equal(ledger.historical, null);
	assert.deepEqual(ledger.forward, { start: 1201, end: 1300 });
});

test("ledger: legacy migration trusts only per-stream evidence", () => {
	const ledger = open({
		persisted: undefined,
		fullResync: false,
		uidnext: 1301,
		streams: ["messages", "message_bodies", "attachments", "threads"],
		legacy: {
			forwardUidnext: 1201,
			messagesBackfillThrough: 900,
			attachmentsBackfillThrough: 300,
		},
	});
	// The page starts at the least-advanced stream (threads, at 0), so this
	// run walks 1..500 for threads and 301..500 for attachments only.
	assert.deepEqual(ledger.historical, { start: 1, end: 500 });
	const c = ledger.commit(NOW).state.streams;
	assert.equal(c.messages?.through, 900);
	assert.equal(
		c.message_bodies?.through,
		900,
		"bodies rode the messages cursor before",
	);
	assert.equal(
		c.attachments?.through,
		500,
		"attachments keep their own cursor",
	);
	assert.equal(c.threads?.through, 500, "thread rows are rebuilt from UID 1");
	assert.equal(c.messages?.coveredFrom, 1201);
	assert.equal(c.messages?.next, 1301);
});

test("ledger: compat cursor keeps the RI band contiguous on every shape", () => {
	for (const persisted of [
		undefined,
		{
			version: 1,
			uidvalidity: 123,
			streams: { messages: { through: 10, coveredFrom: 600, next: 900 } },
			debt: [],
		},
	]) {
		const c = open({ persisted, uidnext: 1301, streams: ["messages"] }).commit(
			NOW,
		);
		assert.ok(c.compat.backfill.target_uid + 1 >= c.compat.forward_uidnext);
		assert.equal(c.compatStream, "messages");
	}
});

test("ledger: attachments inventory is complete only after its own walk with no attachment debt", () => {
	const walked: GmailProgressState = {
		version: 1,
		uidvalidity: 123,
		streams: { attachments: { through: 1000, coveredFrom: 1201, next: 1201 } },
		debt: [],
	};
	const last = open({
		persisted: walked,
		uidnext: 1201,
		streams: ["attachments"],
	});
	const c = last.commit(NOW);
	assert.equal(c.attachmentsInventoryComplete, true);
	const owed = open({
		persisted: {
			...walked,
			debt: [{ uid: 5, streams: ["attachments"], attempts: 1, failure: "x" }],
		},
		uidnext: 1201,
		streams: ["attachments"],
	});
	owed.recordAbsentDebt(new Set([5]));
	assert.equal(owed.commit(NOW).attachmentsInventoryComplete, false);
});

test("ledger: legacy migration seeds streams that are not requested yet", () => {
	const first = open({
		persisted: undefined,
		fullResync: false,
		uidnext: 1301,
		streams: ["attachments"],
		legacy: { forwardUidnext: 1201, messagesBackfillThrough: 1200 },
	}).commit(NOW);
	assert.deepEqual(first.state.streams.messages, {
		through: 1200,
		coveredFrom: 1201,
		next: 1201,
	});
	const later = open({
		persisted: first.state,
		uidnext: 1301,
		streams: ["messages"],
	});
	assert.equal(later.historical, null, "messages history is not re-walked");
	assert.deepEqual(
		later.forward,
		{ start: 1201, end: 1300 },
		"it catches up from its own next",
	);
});
