// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The single owner of Gmail collection progress and completeness.
 *
 * Every stream that is derived from All Mail UIDs keeps its own ledger entry:
 *
 *   covered(stream) = [1 .. through] ∪ [coveredFrom .. next - 1]
 *
 * `[through + 1 .. coveredFrom - 1]` is the stream's unwalked history and
 * `[next .. uidnext - 1]` is its unwalked forward work. The two lanes are
 * disjoint by construction, so no UID is processed twice for one stream in a
 * run. A stream's history is complete when `through + 1 >= coveredFrom`.
 *
 * A cursor moves only across UIDs that have an accounted outcome. A UID is
 * accounted when it was covered, is outside the requested scope, is provably
 * unrepresentable (terminal), or failed and was written to the durable retry
 * debt below. A failure is never a terminal skip: it stays retryable debt
 * until a later run covers it or the UID no longer exists.
 *
 * A stream's `scope` is the time range its covered UIDs were collected under.
 * When a run widens that range (a later `until`, an earlier `since`), the
 * newly included band is owed for every covered UID. It becomes a catch-up
 * pass: a third lane over the covered UIDs that SEARCH places in the band,
 * walked in bounded pages. A pass in progress is never reset; a band that
 * arrives while it runs is queued behind it, and merges only into a pass that
 * has not started.
 *
 * This module does no I/O. The caller fetches what the ledger names, reports
 * one outcome per (UID, stream), and writes what `commit` returns.
 */

import { parseIsoInstant } from "../../packages/polyfill-connectors/src/time-range.ts";

export const LEDGER_STREAMS = [
	"messages",
	"message_bodies",
	"attachments",
	"threads",
] as const;
export type LedgerStream = (typeof LEDGER_STREAMS)[number];

/** Upper bound on persisted retry debt. A full debt list holds the cursor. */
export const MAX_RETRY_DEBT = 200;
/** Debt entries retried per run, from the head of the queue. */
export const DEBT_RETRIES_PER_RUN = 25;
/** Queued catch-up passes per stream before they collapse into one. */
export const MAX_CATCHUP_PASSES = 4;

/** Streams whose collection is filtered by the run's time range. */
const SCOPED_STREAMS: readonly LedgerStream[] = [
	"messages",
	"message_bodies",
	"attachments",
];

/** A half-open time band `[since, until)`, as `time_range` is applied. */
export interface TimeBand {
	since?: string;
	until?: string;
}

/** Covered UIDs up to `end` still owe the band; `through` is the progress. */
export interface CatchupPass extends TimeBand {
	end: number;
	through: number;
}

export interface StreamProgress {
	through: number;
	coveredFrom: number;
	next: number;
	/** The time range covered UIDs were collected under (scoped streams). */
	scope?: TimeBand;
	/** Bands owed for already covered UIDs, oldest first. */
	catchup?: CatchupPass[];
}

export interface RetryDebt {
	uid: number;
	streams: LedgerStream[];
	attempts: number;
	failure: string;
}

export interface GmailProgressState {
	version: 1;
	uidvalidity: number;
	streams: Partial<Record<LedgerStream, StreamProgress>>;
	debt: RetryDebt[];
}

export type UidOutcome =
	| { kind: "covered" }
	| { kind: "out_of_scope" }
	| { kind: "terminal"; reason: string }
	| { kind: "failed"; failure: string }
	/** A retried debt UID that the mailbox no longer contains. */
	| { kind: "absent" };

export interface UidRange {
	start: number;
	end: number;
}

/** Per-stream counts for one run, over the UIDs the commit accounted. */
export interface StreamCoverage {
	considered: number;
	covered: number;
}

export interface LedgerCommit {
	state: GmailProgressState;
	/** The stream the legacy `messages` cursor fields describe. */
	compatStream: LedgerStream | null;
	/** Legacy cursor fields, kept for rollback and the RI band check. */
	compat: {
		uidnext: number;
		forward_uidnext: number;
		backfill: {
			uidvalidity: number;
			backfilled_through_uid: number;
			target_uid: number;
			completed_at: string | null;
		};
	};
	coverage: Partial<Record<LedgerStream, StreamCoverage>>;
	/** Streams whose history page committed and whose history still remains. */
	continuation: Partial<Record<LedgerStream, UidRange>>;
	/** Streams that walked a history page this run. */
	historyPage: Partial<Record<LedgerStream, UidRange>>;
	historyComplete: Partial<Record<LedgerStream, boolean>>;
	/** Every attachment in All Mail has been enumerated and none is in debt. */
	attachmentsInventoryComplete: boolean;
	/** UIDs whose failure could not be recorded because the debt list is full. */
	unaccounted: number[];
}

export interface LegacyCursors {
	forwardUidnext?: number | undefined;
	messagesBackfillThrough?: number | undefined;
	attachmentsBackfillThrough?: number | undefined;
}

export interface LedgerOpenInput {
	/** The persisted `messages.progress` value, if any. */
	persisted: unknown;
	/** Pre-ledger cursors, read only when `persisted` is absent or invalid. */
	legacy: LegacyCursors;
	/** True when there is no prior epoch or UIDVALIDITY changed. */
	fullResync: boolean;
	uidvalidity: number;
	uidnext: number;
	requested: ReadonlySet<LedgerStream>;
	windowUids: number;
	/** Each requested stream's own time range (`StreamRequest.time_range`). */
	timeRanges?: Partial<Record<LedgerStream, TimeBand | undefined>>;
}

const integer = (v: unknown, min = 0): v is number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= min;

const isLedgerStream = (v: unknown): v is LedgerStream =>
	(LEDGER_STREAMS as readonly unknown[]).includes(v);

/**
 * Exact order of two ISO instants, with the same sub-millisecond precision
 * the record filter uses (`isOutsideTimeRange`). `Date.parse` alone would
 * drop digits past milliseconds and treat a widened bound as unchanged.
 */
function compareInstants(a: string, b: string): number {
	const x = parseIsoInstant(a);
	const y = parseIsoInstant(b);
	if (!(x && y)) throw new Error("gmail_progress_invalid_instant");
	if (x.second !== y.second) return x.second - y.second;
	const length = Math.max(x.fraction.length, y.fraction.length);
	const fx = x.fraction.padEnd(length, "0");
	const fy = y.fraction.padEnd(length, "0");
	return fx < fy ? -1 : fx > fy ? 1 : 0;
}

/**
 * The lower bound that keeps every UID some range may want: the earliest
 * `since`, or none when any range has no lower bound.
 */
export function loosestSince(
	ranges: readonly (TimeBand | undefined)[],
): string | undefined {
	let out: string | undefined;
	for (const r of ranges) {
		if (r?.since === undefined) return undefined;
		if (out === undefined || compareInstants(r.since, out) < 0) out = r.since;
	}
	return out;
}

function validBand(v: unknown): v is TimeBand {
	if (typeof v !== "object" || v === null) return false;
	const b = v as Record<string, unknown>;
	return (
		(b.since === undefined || parseIsoInstant(b.since) !== null) &&
		(b.until === undefined || parseIsoInstant(b.until) !== null)
	);
}

function validStream(v: unknown, uidnext: number): v is StreamProgress {
	if (typeof v !== "object" || v === null) return false;
	const s = v as Record<string, unknown>;
	return (
		integer(s.through) &&
		integer(s.coveredFrom, 1) &&
		integer(s.next, 1) &&
		s.coveredFrom <= s.next &&
		s.next <= uidnext &&
		s.through < s.next &&
		(s.scope === undefined || validBand(s.scope)) &&
		(s.catchup === undefined ||
			(Array.isArray(s.catchup) &&
				s.catchup.length <= MAX_CATCHUP_PASSES &&
				s.catchup.every(
					(c) =>
						validBand(c) &&
						integer((c as CatchupPass).through) &&
						integer((c as CatchupPass).end, 1) &&
						(c as CatchupPass).through < (c as CatchupPass).end &&
						(c as CatchupPass).end < uidnext,
				)))
	);
}

function validDebt(v: unknown, uidnext: number): v is RetryDebt {
	if (typeof v !== "object" || v === null) return false;
	const d = v as Record<string, unknown>;
	return (
		integer(d.uid, 1) &&
		d.uid < uidnext &&
		integer(d.attempts, 1) &&
		typeof d.failure === "string" &&
		Array.isArray(d.streams) &&
		d.streams.length > 0 &&
		d.streams.every(isLedgerStream)
	);
}

/** Why a persisted ledger was not used; `null` when it was valid. */
export function persistedProgressProblem(
	persisted: unknown,
	uidvalidity: number,
	uidnext: number,
): string | null {
	if (typeof persisted !== "object" || persisted === null) return "not_object";
	const p = persisted as Record<string, unknown>;
	if (p.version !== 1) return "unknown_version";
	if (p.uidvalidity !== uidvalidity) return "uidvalidity_mismatch";
	if (typeof p.streams !== "object" || p.streams === null) return "streams";
	for (const [name, value] of Object.entries(p.streams)) {
		if (!(isLedgerStream(name) && validStream(value, uidnext))) {
			return `stream:${name}`;
		}
	}
	if (
		!Array.isArray(p.debt) ||
		p.debt.length > MAX_RETRY_DEBT ||
		!p.debt.every((d) => validDebt(d, uidnext))
	) {
		return "debt";
	}
	return null;
}

function legacyStream(
	stream: LedgerStream,
	legacy: LegacyCursors,
	uidnext: number,
): StreamProgress {
	const next = Math.min(
		integer(legacy.forwardUidnext, 1) ? legacy.forwardUidnext : uidnext,
		uidnext,
	);
	// Before the ledger, one shared messages cursor stood for every stream,
	// and the forward pass re-walked inside the historical ceiling. So the
	// history still owns everything below the forward watermark.
	// - threads: pre-ledger rows were page-local fragments, so threads re-walk
	//   from UID 1 to rebuild each row from its complete membership.
	// - attachments: only the attachments cursor is attachment evidence. The
	//   messages walk may have run while attachments were not selected.
	let through = 0;
	if (stream === "attachments") {
		through = legacy.attachmentsBackfillThrough ?? 0;
	} else if (stream !== "threads") {
		through = legacy.messagesBackfillThrough ?? 0;
	}
	through = integer(through) ? Math.min(through, next - 1) : 0;
	return normalize({ through, coveredFrom: next, next });
}

/** Merge entries for the same UID, keeping the first one's queue position. */
function canonicalDebt(debt: readonly RetryDebt[]): RetryDebt[] {
	const byUid = new Map<number, RetryDebt>();
	for (const d of debt) {
		const known = byUid.get(d.uid);
		if (known) {
			known.streams = LEDGER_STREAMS.filter(
				(s) => known.streams.includes(s) || d.streams.includes(s),
			);
			known.attempts = Math.max(known.attempts, d.attempts);
		} else {
			byUid.set(d.uid, { ...d, streams: [...d.streams] });
		}
	}
	return [...byUid.values()];
}

/** Every requested stream has an entry once the ledger is open. */
function progressIn(
	streams: Partial<Record<LedgerStream, StreamProgress>>,
	stream: LedgerStream,
): StreamProgress {
	const s = streams[stream];
	if (!s) throw new Error(`gmail_progress_missing_stream:${stream}`);
	return s;
}

/** A complete history is stored as `through = next - 1, coveredFrom = next`. */
function normalize(s: StreamProgress): StreamProgress {
	const out =
		s.through + 1 >= s.coveredFrom
			? { ...s, through: s.next - 1, coveredFrom: s.next }
			: { ...s };
	if (out.catchup?.length === 0) delete out.catchup;
	return out;
}

function band(since: string | undefined, until: string | undefined): TimeBand {
	return {
		...(since !== undefined ? { since } : {}),
		...(until !== undefined ? { until } : {}),
	};
}

/** The bands `now` includes that `prior` excluded. */
function widenedBands(prior: TimeBand, now: TimeBand): TimeBand[] {
	const out: TimeBand[] = [];
	if (
		prior.until !== undefined &&
		(now.until === undefined || compareInstants(now.until, prior.until) > 0)
	) {
		out.push(band(prior.until, now.until));
	}
	if (
		prior.since !== undefined &&
		(now.since === undefined || compareInstants(now.since, prior.since) < 0)
	) {
		out.push(band(now.since, prior.since));
	}
	return out;
}

/** `a ∩ b`, or null when the intersection is empty. */
function intersect(a: TimeBand, b: TimeBand): TimeBand | null {
	const sinces = [a.since, b.since].filter((x): x is string => x !== undefined);
	const untils = [a.until, b.until].filter((x): x is string => x !== undefined);
	const since = sinces.sort((x, y) => compareInstants(y, x))[0];
	const until = untils.sort((x, y) => compareInstants(x, y))[0];
	if (
		since !== undefined &&
		until !== undefined &&
		compareInstants(since, until) >= 0
	) {
		return null;
	}
	return band(since, until);
}

/**
 * Queue `owed` for covered UIDs up to `end`. A pass that has started is never
 * changed, so its progress cannot be reset or skipped; a contiguous band may
 * extend only a pass that has not started.
 */
function enqueueCatchup(
	s: StreamProgress,
	owed: TimeBand,
	end: number,
	scope: TimeBand,
): void {
	if (end < 1) return;
	const passes = s.catchup ?? [];
	const last = passes.at(-1);
	if (
		last &&
		last.through === 0 &&
		last.until !== undefined &&
		owed.since === last.until
	) {
		if (owed.until === undefined) delete last.until;
		else last.until = owed.until;
		last.end = Math.max(last.end, end);
	} else if (
		last &&
		last.through === 0 &&
		last.since !== undefined &&
		owed.until === last.since
	) {
		if (owed.since === undefined) delete last.since;
		else last.since = owed.since;
		last.end = Math.max(last.end, end);
	} else {
		passes.push({ ...owed, end, through: 0 });
	}
	// Too many disjoint bands: compact the passes that have not started into
	// one re-check of every covered UID under the current scope. Redundant
	// work, never a skipped band, and a started head keeps its progress.
	if (passes.length > MAX_CATCHUP_PASSES) {
		const head = passes[0] && passes[0].through > 0 ? passes[0] : undefined;
		const rest = head ? passes.slice(1) : passes;
		s.catchup = [
			...(head ? [head] : []),
			{ ...scope, end: Math.max(...rest.map((p) => p.end)), through: 0 },
		];
	} else {
		s.catchup = passes;
	}
}

interface CatchupPlan {
	key: string;
	band: TimeBand;
	planned: number[];
	exhausted: boolean;
}

interface Expected {
	streams: Set<LedgerStream>;
	outcomes: Map<LedgerStream, UidOutcome>;
}

export class GmailProgressLedger {
	readonly uidvalidity: number;
	readonly uidnext: number;
	/** Diagnostic: why the persisted ledger was replaced, if it was. */
	readonly resetReason: string | null;
	private readonly requested: ReadonlySet<LedgerStream>;
	private readonly streams: Partial<Record<LedgerStream, StreamProgress>>;
	private readonly debt: RetryDebt[];
	private history: UidRange | null;
	private readonly forwardRange: UidRange | null;
	private readonly retried: RetryDebt[];
	private readonly expected = new Map<number, Expected>();
	private readonly timeRanges: Partial<Record<LedgerStream, TimeBand>>;
	private readonly windowUids: number;
	private readonly catchupPlans = new Map<LedgerStream, CatchupPlan>();

	constructor(input: LedgerOpenInput) {
		if (!integer(input.uidvalidity, 1) || !integer(input.uidnext, 1)) {
			throw new Error("gmail_progress_invalid_mailbox");
		}
		if (!integer(input.windowUids, 1)) {
			throw new Error("gmail_progress_invalid_window");
		}
		this.uidvalidity = input.uidvalidity;
		this.uidnext = input.uidnext;
		this.requested = input.requested;
		this.windowUids = input.windowUids;
		const ranges: Partial<Record<LedgerStream, TimeBand>> = {};
		for (const stream of LEDGER_STREAMS) {
			const r = input.timeRanges?.[stream];
			if (r && !validBand(r)) {
				throw new Error("gmail_progress_invalid_time_range");
			}
			ranges[stream] = band(r?.since, r?.until);
		}
		this.timeRanges = ranges;

		let streams: Partial<Record<LedgerStream, StreamProgress>> = {};
		let debt: RetryDebt[] = [];
		let resetReason: string | null = null;
		let useLegacy = false;
		if (input.fullResync) {
			resetReason = input.persisted === undefined ? null : "full_resync";
		} else if (input.persisted === undefined) {
			useLegacy = true;
		} else {
			resetReason = persistedProgressProblem(
				input.persisted,
				input.uidvalidity,
				input.uidnext,
			);
			if (resetReason === null) {
				const p = structuredClone(input.persisted) as GmailProgressState;
				streams = p.streams;
				debt = canonicalDebt(p.debt);
			} else {
				useLegacy = true;
			}
		}
		for (const stream of LEDGER_STREAMS) {
			const known = streams[stream];
			if (known) {
				streams[stream] = normalize(known);
			} else if (useLegacy) {
				// Migrate every stream at once, requested or not: the legacy
				// cursors are read only on this first ledger run.
				streams[stream] = legacyStream(stream, input.legacy, input.uidnext);
			} else if (this.requested.has(stream)) {
				// A stream first requested now walks its own history from UID 1.
				streams[stream] = normalize({
					through: 0,
					coveredFrom: input.uidnext,
					next: input.uidnext,
				});
			}
		}
		// A widened time range owes its new band for every covered UID. A
		// stream with no recorded scope (new, reset or migrated) was walked
		// under this run's range.
		for (const stream of SCOPED_STREAMS) {
			const s = streams[stream];
			if (!(s && this.requested.has(stream))) continue;
			if (s.scope) {
				for (const owed of widenedBands(s.scope, this.rangeOf(stream))) {
					enqueueCatchup(s, owed, s.next - 1, this.rangeOf(stream));
				}
			}
			s.scope = { ...this.rangeOf(stream) };
		}
		this.streams = streams;
		this.debt = debt;
		this.resetReason = resetReason;

		// One historical page per run, starting at the least-advanced stream.
		// Streams further ahead join the page where their own history resumes.
		const behind = this.requestedStreams().filter((s) => !this.complete(s));
		if (behind.length > 0) {
			const start =
				Math.min(...behind.map((s) => this.progressOf(s).through)) + 1;
			const end = Math.min(
				start + input.windowUids - 1,
				Math.max(...behind.map((s) => this.progressOf(s).coveredFrom - 1)),
			);
			this.history = { start, end };
		} else {
			this.history = null;
		}
		const forwardStart = Math.min(
			this.uidnext,
			...this.requestedStreams().map((s) => this.progressOf(s).next),
		);
		this.forwardRange =
			forwardStart < input.uidnext
				? { start: forwardStart, end: input.uidnext - 1 }
				: null;
		// The debt list is a queue: retry its head; failures rejoin at the tail.
		this.retried = this.debt
			.filter((d) => d.streams.some((s) => this.requested.has(s)))
			.slice(0, DEBT_RETRIES_PER_RUN);
	}

	/** `messages` when requested, else the first requested ledger stream. */
	private compatStreamName(): LedgerStream | null {
		return this.requestedStreams()[0] ?? null;
	}

	/** Where the walk stands before this run, for the inventory disclosure. */
	get position(): {
		through: number;
		forwardNext: number;
		complete: boolean;
	} {
		const name = this.compatStreamName();
		const s = name ? this.streams[name] : undefined;
		return {
			through: s?.through ?? this.uidnext - 1,
			forwardNext: s?.next ?? this.uidnext,
			complete: !s || s.through + 1 >= s.coveredFrom,
		};
	}

	/** `stream`'s own requested time range; threads apply none. */
	private rangeOf(stream: LedgerStream): TimeBand {
		return stream === "threads" ? {} : (this.timeRanges[stream] ?? {});
	}

	private progressOf(stream: LedgerStream): StreamProgress {
		return progressIn(this.streams, stream);
	}

	private requestedStreams(): LedgerStream[] {
		return LEDGER_STREAMS.filter((s) => this.requested.has(s));
	}

	private complete(stream: LedgerStream): boolean {
		const s = this.streams[stream];
		return !!s && s.through + 1 >= s.coveredFrom;
	}

	/** Which lane of `stream` owns `uid` this run, if any. */
	private laneOf(
		stream: LedgerStream,
		uid: number,
	): "history" | "forward" | "catchup" | null {
		const s = this.streams[stream];
		if (!(s && this.requested.has(stream))) return null;
		if (this.catchupPlans.get(stream)?.planned.includes(uid)) return "catchup";
		if (
			this.history &&
			uid >= this.history.start &&
			uid <= this.history.end &&
			uid > s.through &&
			uid < s.coveredFrom
		) {
			return "history";
		}
		return uid >= s.next && uid < this.uidnext ? "forward" : null;
	}

	get historical(): UidRange | null {
		return this.history ? { ...this.history } : null;
	}

	get forward(): UidRange | null {
		return this.forwardRange ? { ...this.forwardRange } : null;
	}

	/** Debt UIDs to re-fetch this run, ascending. */
	get debtUids(): number[] {
		return this.retried.map((d) => d.uid).sort((a, b) => a - b);
	}

	/**
	 * The bands to SEARCH this run, one per distinct active catch-up pass,
	 * already narrowed to the run's time range.
	 */
	get catchupSearches(): { key: string; band: TimeBand }[] {
		const out = new Map<string, TimeBand>();
		for (const stream of this.requestedStreams()) {
			const active = this.progressOf(stream).catchup?.[0];
			const owed = active ? intersect(active, this.rangeOf(stream)) : null;
			if (owed) out.set(JSON.stringify(owed), owed);
		}
		return [...out].map(([key, b]) => ({ key, band: b }));
	}

	/**
	 * Plan one bounded catch-up page from the UIDs SEARCH placed in the band:
	 * only covered UIDs past the pass's progress, at most one window.
	 */
	planCatchup(key: string, searched: readonly number[]): void {
		// The run's plan is final before any outcome is recorded: a UID's owed
		// streams are fixed when it is first expected.
		if (this.expected.size > 0) {
			throw new Error("gmail_progress_plan_after_outcomes");
		}
		const uids = [...new Set(searched)].sort((a, b) => a - b);
		for (const stream of this.requestedStreams()) {
			const s = this.progressOf(stream);
			const active = s.catchup?.[0];
			const owed = active ? intersect(active, this.rangeOf(stream)) : null;
			if (!(active && owed && JSON.stringify(owed) === key)) continue;
			const candidates = uids.filter(
				(uid) =>
					uid > active.through &&
					uid <= active.end &&
					(uid <= s.through || (uid >= s.coveredFrom && uid < s.next)),
			);
			this.catchupPlans.set(stream, {
				key,
				band: owed,
				planned: candidates.slice(0, this.windowUids),
				exhausted: candidates.length <= this.windowUids,
			});
		}
	}

	/** UIDs planned for catch-up this run, ascending. */
	get catchupUids(): number[] {
		const all = new Set<number>();
		for (const plan of this.catchupPlans.values()) {
			for (const uid of plan.planned) all.add(uid);
		}
		return [...all].sort((a, b) => a - b);
	}

	/**
	 * Whether `stream` sees `uid` for the first time this run. History and
	 * forward lanes are disjoint and never revisit a UID; catch-up and debt
	 * retries can reach a UID whose rows are already stored.
	 */
	isFirstSight(uid: number, stream: LedgerStream): boolean {
		const owed = this.retried.some(
			(d) => d.uid === uid && d.streams.includes(stream),
		);
		const lane = this.laneOf(stream, uid);
		return !owed && (lane === "history" || lane === "forward");
	}

	/**
	 * The time range `stream` must apply to `uid`: its band on catch-up. A UID
	 * the stream also owes as retry debt applies the full run range, so the
	 * retry is never settled as out of the narrower band.
	 */
	timeRangeFor(uid: number, stream: LedgerStream): TimeBand {
		const owed = this.retried.some(
			(d) => d.uid === uid && d.streams.includes(stream),
		);
		return !owed && this.laneOf(stream, uid) === "catchup"
			? (this.catchupPlans.get(stream)?.band ?? this.rangeOf(stream))
			: this.rangeOf(stream);
	}

	/** Streams that walk part of the historical page. */
	get historicalStreams(): LedgerStream[] {
		const page = this.history;
		if (!page) return [];
		return this.requestedStreams().filter((stream) => {
			const s = this.progressOf(stream);
			return s.through < page.end && s.through + 1 < s.coveredFrom;
		});
	}

	/** Shorten the historical page, for example to a byte budget. */
	limitHistorical(endUid: number): void {
		if (!this.history || this.expected.size > 0) {
			throw new Error("gmail_progress_page_already_consumed");
		}
		if (!integer(endUid, this.history.start) || endUid > this.history.end) {
			throw new Error("gmail_progress_invalid_page_end");
		}
		this.history = { start: this.history.start, end: endUid };
	}

	/**
	 * Which requested streams must process `uid` this run. Debt retries cover
	 * only the streams that failed; lanes cover only their own unwalked UIDs.
	 */
	streamsFor(uid: number): LedgerStream[] {
		const debt = this.retried.find((d) => d.uid === uid);
		return this.requestedStreams().filter(
			(s) => debt?.streams.includes(s) || this.laneOf(s, uid) !== null,
		);
	}

	/**
	 * Declare that `uid` was fetched and must be accounted. Call once per
	 * fetched UID before reporting its outcomes. Returns the streams it owes.
	 */
	expect(uid: number): LedgerStream[] {
		const streams = this.streamsFor(uid);
		if (!this.expected.has(uid) && streams.length > 0) {
			this.expected.set(uid, {
				streams: new Set(streams),
				outcomes: new Map(),
			});
		}
		return streams;
	}

	/** Report one outcome for `uid` on each of `streams`. */
	record(
		uid: number,
		streams: readonly LedgerStream[],
		outcome: UidOutcome,
	): void {
		const entry = this.expected.get(uid);
		if (!entry) throw new Error("gmail_progress_unexpected_uid");
		for (const s of streams) {
			if (!entry.streams.has(s)) {
				throw new Error("gmail_progress_unexpected_stream");
			}
			entry.outcomes.set(s, outcome);
		}
	}

	/**
	 * Mark retried debt UIDs that the fetch did not return. Gmail UIDs are
	 * never reused within an epoch, so a missing UID was expunged.
	 */
	recordAbsentDebt(returned: ReadonlySet<number>): void {
		for (const d of this.retried) {
			if (returned.has(d.uid)) continue;
			const streams = this.expect(d.uid);
			this.record(d.uid, streams, { kind: "absent" });
		}
	}

	commit(now: string): LedgerCommit {
		const streams = structuredClone(this.streams);
		const coverage: Partial<Record<LedgerStream, StreamCoverage>> = {};
		const historyPage: Partial<Record<LedgerStream, UidRange>> = {};
		const continuation: Partial<Record<LedgerStream, UidRange>> = {};
		const historyComplete: Partial<Record<LedgerStream, boolean>> = {};
		const unaccounted = new Set<number>();
		const outcome = (uid: number, s: LedgerStream) =>
			this.expected.get(uid)?.outcomes.get(s);

		// One debt entry per UID; its streams are that UID's owed streams. The
		// queue keeps its order: untouched entries, then new failures, then
		// retried entries that did not settle (they rejoin at the tail).
		const retriedUids = new Set(this.retried.map((d) => d.uid));
		const queue = new Map<number, RetryDebt>();
		for (const d of this.debt) {
			if (!retriedUids.has(d.uid)) queue.set(d.uid, structuredClone(d));
		}
		const tail = new Map<number, RetryDebt>();
		for (const d of this.retried) {
			let failure = d.failure;
			let attempted = false;
			const still = d.streams.filter((s) => {
				const o = outcome(d.uid, s);
				if (!this.requested.has(s) || o === undefined) return true;
				attempted = true;
				if (o.kind !== "failed") return false;
				failure = o.failure;
				return true;
			});
			if (still.length > 0) {
				tail.set(d.uid, {
					uid: d.uid,
					streams: still,
					attempts: d.attempts + (attempted ? 1 : 0),
					failure,
				});
			}
		}
		const fresh = new Map<number, RetryDebt>();
		const addDebt = (uid: number, stream: LedgerStream, failure: string) => {
			const known = queue.get(uid) ?? tail.get(uid) ?? fresh.get(uid);
			if (known) {
				known.streams = LEDGER_STREAMS.filter(
					(s) => s === stream || known.streams.includes(s),
				);
				return true;
			}
			if (queue.size + tail.size + fresh.size >= MAX_RETRY_DEBT) return false;
			fresh.set(uid, { uid, streams: [stream], attempts: 1, failure });
			return true;
		};

		const fetched = [...this.expected.keys()].sort((a, b) => a - b);
		for (const stream of this.requestedStreams()) {
			const s = progressIn(streams, stream);
			const counts = { considered: 0, covered: 0 };
			// Walk each lane in UID order; a stream's cursor stops at the first
			// UID it cannot account.
			let historyEnd = this.history ? this.history.end : s.through;
			let forwardEnd = this.uidnext - 1;
			for (const uid of fetched) {
				const lane = this.laneOf(stream, uid);
				if (lane === null || lane === "catchup") continue;
				if (uid > (lane === "history" ? historyEnd : forwardEnd)) continue;
				const o = outcome(uid, stream);
				const accounted =
					o !== undefined &&
					(o.kind !== "failed" || addDebt(uid, stream, o.failure));
				if (!accounted) {
					unaccounted.add(uid);
					if (lane === "history") historyEnd = uid - 1;
					else forwardEnd = uid - 1;
					continue;
				}
				if (o.kind !== "out_of_scope") counts.considered += 1;
				if (o.kind === "covered") counts.covered += 1;
			}
			// Debt retries count toward this run's evidence for the stream.
			for (const d of this.retried) {
				const o = d.streams.includes(stream)
					? outcome(d.uid, stream)
					: undefined;
				if (!o || o.kind === "out_of_scope" || o.kind === "absent") continue;
				counts.considered += 1;
				if (o.kind === "covered") counts.covered += 1;
			}
			if (this.history && this.historicalStreams.includes(stream)) {
				const end = Math.min(historyEnd, s.coveredFrom - 1);
				if (end > s.through) {
					historyPage[stream] = { start: s.through + 1, end };
					s.through = end;
				}
			}
			if (forwardEnd >= s.next) s.next = forwardEnd + 1;
			this.commitCatchup(stream, s, outcome, addDebt, unaccounted, counts);
			const normalized = normalize(s);
			streams[stream] = normalized;
			const done =
				normalized.through + 1 >= normalized.coveredFrom &&
				!normalized.catchup?.length;
			historyComplete[stream] = done;
			if (historyPage[stream] && !done) {
				continuation[stream] = historyPage[stream];
			}
			coverage[stream] = counts;
		}
		const debt = [...queue.values(), ...fresh.values(), ...tail.values()];

		const state: GmailProgressState = {
			version: 1,
			uidvalidity: this.uidvalidity,
			streams,
			debt,
		};
		const compatName = this.compatStreamName();
		const compatStream = compatName ? streams[compatName] : undefined;
		const forwardNext = compatStream?.next ?? this.uidnext;
		const compatDone =
			!compatStream || compatStream.through + 1 >= compatStream.coveredFrom;
		return {
			state,
			compatStream: compatName,
			compat: {
				uidnext: compatDone ? forwardNext : compatStream.through + 1,
				forward_uidnext: forwardNext,
				backfill: {
					uidvalidity: this.uidvalidity,
					backfilled_through_uid: compatStream?.through ?? forwardNext - 1,
					// The historical walk owns everything below the forward resume
					// point; the forward lane already covered [coveredFrom, next).
					target_uid: forwardNext - 1,
					completed_at: compatDone ? now : null,
				},
			},
			coverage,
			continuation,
			historyPage,
			historyComplete,
			attachmentsInventoryComplete:
				this.requested.has("attachments") &&
				historyComplete.attachments === true &&
				!debt.some((d) => d.streams.includes("attachments")),
			unaccounted: [...unaccounted].sort((a, b) => a - b),
		};
	}

	/** Advance `stream`'s active catch-up pass over its accounted prefix. */
	private commitCatchup(
		stream: LedgerStream,
		s: StreamProgress,
		outcome: (uid: number, s: LedgerStream) => UidOutcome | undefined,
		addDebt: (uid: number, stream: LedgerStream, failure: string) => boolean,
		unaccounted: Set<number>,
		counts: StreamCoverage,
	): void {
		const passes = s.catchup;
		const active = passes?.[0];
		if (!(passes && active)) return;
		if (!intersect(active, this.rangeOf(stream))) {
			// Nothing of this band is in the current scope: no UID can owe it.
			passes.shift();
			return;
		}
		const plan = this.catchupPlans.get(stream);
		if (!plan) return;
		let through = active.through;
		let held = false;
		for (const uid of plan.planned) {
			const o = outcome(uid, stream);
			// A planned UID that FETCH did not return was expunged.
			if (this.expected.has(uid)) {
				const accounted =
					o !== undefined &&
					(o.kind !== "failed" || addDebt(uid, stream, o.failure));
				if (!accounted) {
					unaccounted.add(uid);
					held = true;
					break;
				}
				if (o.kind !== "out_of_scope") counts.considered += 1;
				if (o.kind === "covered") counts.covered += 1;
			}
			through = uid;
		}
		if (!held && plan.exhausted) passes.shift();
		else active.through = through;
	}
}
