// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run stream integrity: the runtime refuses a stream's completion claims
 * once any of that stream's rows was lost in the run.
 *
 * THE RULE
 *
 * A stream has *lost rows in the run* once any of these happens to it:
 *
 *   1. The runtime refuses one of its in-scope records: the output schema
 *      rejected it (`shape_check_failed`), it had no `id`, or the connector
 *      handed it over with unreadable mapped fields
 *      (`record_fields_unavailable`, see `field-reader.ts`). A row whose
 *      readable id or readable consent time puts it outside the run's
 *      resource or time-range scope is not in scope, so it is no loss.
 *   2. The connector reports the stream failed:
 *      `SKIP_RESULT{reason: "stream_collection_failed"}`.
 *   3. The connector reports any other skip that is not a declared bound
 *      (below), for example a retryable `source_unreadable`.
 *
 * What the runtime then does to outgoing messages:
 *
 *   - `STATE` whose `stream` is the stream, or a checkpoint parent of it:
 *     not sent after a rule-1 or rule-2 loss, nor after a rule-3 skip that
 *     carries no resume-safe declaration. The previous checkpoint stays, so
 *     the next run reads the lost rows again. Under rule 1 the connector
 *     believed the row was stored, so its cursor may already be past it.
 *     Under rule 2 the Collection Profile's certified-failure rule already
 *     keeps a failed stream's checkpoint from being saved.
 *     A rule-3 skip may carry a RESUME-SAFE DECLARATION
 *     (`resumeSafeSkip(msg, basis)`, on the wire as
 *     `diagnostics.resume_safe`): the connector states, with a closed-set
 *     basis, why the cursor it saves still replays what the skip lost (see
 *     `ResumeSafeBasis`). Only then does that stream's `STATE` pass. The
 *     runtime cannot verify the basis; it is a reviewed claim at the call
 *     site, made by the code that owns the cursor. Rules 1 and 2 have no
 *     declaration path.
 *   - `RECORD{op: "delete"}` for the stream (any rule): not sent. A row that
 *     could not be read in this run must not be deleted as "unseen".
 *   - `DETAIL_GAP_RECOVERED` for a key the runtime refused in this run (or
 *     with no key, once the stream had any refusal): not sent. A refused
 *     recovery must not retire its durable gap; the gap stays pending.
 *   - `DETAIL_COVERAGE` for the stream: keys of refused records leave
 *     `hydrated_keys`, so they are unaccounted. `covered` is capped at
 *     `considered` minus the refused rows, so the report can never read
 *     complete after a loss. After a rule-3 skip, a report that reads full
 *     (`covered >= considered`, or `considered` with no `covered`) loses both
 *     counts and reads as unknown; a report that already shows a shortfall
 *     stays.
 *   - `STREAM_EVIDENCE` for the stream: every refusal the connector could
 *     not see (schema, missing id) moves from `outcomes.emitted` to
 *     `outcomes.unaccounted`, with no assumption that it overlaps rows
 *     already reported unaccounted. A row the connector withheld itself
 *     through `emitRow` is acknowledged and not moved again.
 *
 * For each stream and kind of change, the runtime sends one
 * `SKIP_RESULT{reason: "stream_incomplete_checkpoint_withheld",
 * recovery_hint: retry_by_runtime}` naming what it withheld or corrected.
 * Records already stored stay: the run is upsert-only for that stream. The
 * run's `DONE` status does not change.
 *
 * Messages sent BEFORE the loss are not recalled: a periodic `STATE` taken
 * before the loss is still a true checkpoint, and a `delete` already sent
 * cannot be taken back. Connectors that emit deletes for unseen rows must
 * emit them after every row of the stream was read.
 *
 * A row in scope whose source stays malformed keeps its stream's previous
 * checkpoint run after run. That is the intended trade: the stream stops
 * advancing rather than stores a partial row or skips one for good. The
 * repair is in the connector (read the field, or declare its documented
 * absence semantics) or at the source.
 *
 * DECLARED BOUNDS (do not make a stream incomplete)
 *
 * A `SKIP_RESULT` is a declared bound, not a loss, when it is one of:
 *
 *   - `reason: "scope_not_supported"`: the Collection Profile's declaration
 *     that a scope element is not honored for that stream or resource.
 *   - a typed `continuation`: the Collection Profile's proof that one bounded
 *     page completed and the runtime owns the next page.
 *   - `recovery_hint.retryable === false` (and not `stream_collection_failed`):
 *     the connector declares on the wire that running again cannot recover
 *     the skipped part (for example, a deliberate page budget). Withholding a
 *     checkpoint would gain nothing, and the bound stays visible to the owner
 *     and to review at the call site.
 *   - `shape_check_unmodeled_value`: a record that was kept, not skipped.
 *
 * A record-level refusal (rule 1) has no declaration path: the connector
 * cannot mark a lost row as acceptable. To leave a row out on purpose, do not
 * hand it to `emitRecord`.
 *
 * PARTIAL ROWS ARE WITHHELD, NEVER EMITTED
 *
 * The Collection Profile has no normative partial-record semantics, and the
 * personal server's ingest replaces a whole record on upsert. A RECORD with
 * an unreadable field left out, or set to null, would therefore erase the
 * stored value. Until an `omitted_fields` capability is negotiated end to
 * end, the policy is:
 *
 *   - A row whose mapped fields are all read or explicitly empty is emitted
 *     normally (`explicit_empty` becomes `null`, a value the source stated).
 *   - A row with ANY unavailable mapped field is WITHHELD entirely. The
 *     runtime sends `SKIP_RESULT{reason: "record_fields_unavailable"}` whose
 *     diagnostics carry the row key, `key_enumerated: true`,
 *     `row_withheld: true`, and the omitted field names with value-free
 *     reasons (the expected type or shape) — never field values, enum
 *     members included. The withheld row is a loss under rule 1.
 *
 * "Key enumerated" and "row withheld" are separate facts. The source listed
 * the key, so a withheld row is never absent: the stream cannot delete it
 * (no `delete` passes once a row is withheld), `DETAIL_COVERAGE` keeps it in
 * `required_keys` but not in `hydrated_keys` (unaccounted, not missing), and
 * the stored copy from an earlier run stays as it was.
 *
 * DETAIL_GAP is not a loss here. The Collection Profile already counts a key
 * backed by a durable `DETAIL_GAP` as accounted, and the runtime's gap
 * recovery retries it, so the parent checkpoint may advance. A `DETAIL_GAP`
 * does tell the runtime which checkpoint parent a detail stream maps to.
 *
 * CHECKPOINT PARENTS
 *
 * `STATE.stream` names a checkpoint, which can differ from the data streams
 * it covers. The runtime learns a data stream's parent from the
 * `DETAIL_COVERAGE.state_stream` and `DETAIL_GAP.parent_stream` it sees in the
 * run; every stream is also its own checkpoint. A parent that the manifest
 * declares but the run never names on the wire before its `STATE` is not
 * known here.
 */

import type {
	DetailCoverageMessage,
	EmittedMessage,
} from "@pdpp/connector-protocol/connector-runtime-protocol";

export const CHECKPOINT_WITHHELD_REASON =
	"stream_incomplete_checkpoint_withheld";
export const FIELDS_UNAVAILABLE_REASON = "record_fields_unavailable";

/** Why the runtime refused a record. */
export type RecordRefusalCause =
	| "fields_unavailable"
	| "missing_id"
	| "shape_check_failed";

/**
 * Why a cursor saved after a reported skip still replays the lost rows. A
 * connector declares one on the SKIP_RESULT with `resumeSafeSkip` only after
 * checking it against its own cursor code; the reviewer checks the same.
 *
 *   - `cursor_at_or_before_loss`: the cursor saved in this run resumes at or
 *     before the earliest row this skip lost (including a cursor left at the
 *     previous checkpoint).
 *   - `cursor_records_loss`: the cursor itself carries the lost rows (a gap
 *     or retry list) and the next run reads them again.
 *   - `cursor_excludes_loss`: the cursor is a set of items already stored
 *     (fingerprints, ids) and the lost items are not in it, so the next run
 *     processes them again.
 *   - `read_ignores_cursor_for_loss`: the next run's read selects the lost
 *     rows whatever the cursor says (for example, rows without the cursor
 *     field are re-queried every run).
 */
export type ResumeSafeBasis =
	| "cursor_at_or_before_loss"
	| "cursor_excludes_loss"
	| "cursor_records_loss"
	| "read_ignores_cursor_for_loss";

const RESUME_SAFE_BASES: ReadonlySet<string> = new Set<ResumeSafeBasis>([
	"cursor_at_or_before_loss",
	"cursor_excludes_loss",
	"cursor_records_loss",
	"read_ignores_cursor_for_loss",
]);

type SkipResult = Extract<EmittedMessage, { type: "SKIP_RESULT" }>;
type StreamEvidence = Extract<EmittedMessage, { type: "STREAM_EVIDENCE" }>;
type WithheldKind =
	| "DETAIL_COVERAGE"
	| "DETAIL_GAP_RECOVERED"
	| "STATE"
	| "STREAM_EVIDENCE"
	| "delete";

/**
 * Declare on a SKIP_RESULT that the stream's cursor still replays what the
 * skip lost (see `ResumeSafeBasis`). The declaration rides on the wire as
 * `diagnostics.resume_safe`. Without it, a reported skip blocks the
 * stream's STATE for the run.
 */
export function resumeSafeSkip(
	msg: SkipResult,
	basis: ResumeSafeBasis,
): SkipResult {
	const diagnostics =
		typeof msg.diagnostics === "object" &&
		msg.diagnostics !== null &&
		!Array.isArray(msg.diagnostics)
			? msg.diagnostics
			: msg.diagnostics === undefined
				? {}
				: { connector: msg.diagnostics };
	return { ...msg, diagnostics: { ...diagnostics, resume_safe: basis } };
}

/** The declared basis on a SKIP_RESULT, if it is one of the closed set. */
export function resumeSafeBasisOf(msg: SkipResult): ResumeSafeBasis | null {
	const diagnostics = msg.diagnostics;
	if (typeof diagnostics !== "object" || diagnostics === null) return null;
	const basis: unknown = Reflect.get(diagnostics, "resume_safe");
	return typeof basis === "string" && RESUME_SAFE_BASES.has(basis)
		? (basis as ResumeSafeBasis)
		: null;
}

/** Bound on keys listed in one withheld notice; the count is always exact. */
const WITHHELD_KEYS_LISTED = 50;

const DECLARED_BOUND_REASONS: ReadonlySet<string> = new Set([
	"scope_not_supported",
	"shape_check_unmodeled_value",
	CHECKPOINT_WITHHELD_REASON,
]);

/** True when a `SKIP_RESULT` declares a bound rather than reporting a loss. */
export function isDeclaredBound(msg: SkipResult): boolean {
	if (msg.reason === "stream_collection_failed") return false;
	if (DECLARED_BOUND_REASONS.has(msg.reason)) return true;
	if (msg.continuation !== undefined) return true;
	const hint = msg.recovery_hint;
	return typeof hint === "object" && hint.retryable === false;
}

interface StreamLoss {
	readonly causes: Map<RecordRefusalCause, number>;
	/** A `stream_collection_failed` was reported (rule 2). */
	failed: boolean;
	/** Distinct refused keys, in refusal order. */
	readonly refusedKeys: Set<string>;
	/** Refusals of any kind. */
	refused: number;
	/** Reported skips (rule 3), declared resume-safe or not. */
	readonly skipReasons: Set<string>;
	/** Refusals the connector could not have known about (schema, missing id). */
	unacknowledged: number;
	/** Rule-3 skips without a resume-safe declaration. */
	readonly undeclaredSkips: Set<string>;
}

export interface StreamIntegrity {
	/**
	 * Pass one outgoing connector message through the rule. Returns the
	 * messages to send instead, in order: a one-time notice per stream and
	 * withheld kind, then the message itself or a changed copy. Empty when
	 * nothing is sent.
	 */
	gate(msg: EmittedMessage): EmittedMessage[];
	/** True once the stream lost a row or reported a non-declared skip. */
	isIncomplete(stream: string): boolean;
	/** Record a runtime refusal of one record. `key` is null when the record had no id. */
	refuseRecord(
		stream: string,
		key: string | null,
		cause: RecordRefusalCause,
	): void;
	/** Streams for which at least one message was withheld or changed. */
	withheldStreams(): readonly string[];
}

const NOTICE_TEXT: Record<WithheldKind, string> = {
	STATE:
		"checkpoint not saved; the next run reads this stream again from the previous checkpoint",
	delete:
		"deletes not applied; rows not read in this run are not treated as gone",
	DETAIL_COVERAGE: "coverage report corrected to count only rows stored",
	STREAM_EVIDENCE: "stream evidence corrected to count only rows stored",
	DETAIL_GAP_RECOVERED:
		"gap recovery not recorded; the refused record's gap stays pending",
};

export function createStreamIntegrity(): StreamIntegrity {
	const losses = new Map<string, StreamLoss>();
	const parents = new Map<string, Set<string>>();
	const notified = new Set<string>();

	const lossFor = (stream: string): StreamLoss => {
		let loss = losses.get(stream);
		if (!loss) {
			loss = {
				causes: new Map(),
				failed: false,
				refusedKeys: new Set(),
				refused: 0,
				skipReasons: new Set(),
				unacknowledged: 0,
				undeclaredSkips: new Set(),
			};
			losses.set(stream, loss);
		}
		return loss;
	};
	const isIncomplete = (stream: string): boolean => losses.has(stream);
	const linkParent = (stream: string, parent: string | undefined): void => {
		if (!parent || parent === stream) return;
		let set = parents.get(stream);
		if (!set) {
			set = new Set();
			parents.set(stream, set);
		}
		set.add(parent);
	};
	/** Rules 1–3 that make the stream's own checkpoint untrustworthy this run. */
	const blocksCheckpoint = (stream: string): boolean => {
		const loss = losses.get(stream);
		return (
			loss !== undefined &&
			(loss.refused > 0 || loss.failed || loss.undeclaredSkips.size > 0)
		);
	};
	/** Data streams whose loss blocks a checkpoint for `checkpoint`. */
	const incompleteUnder = (checkpoint: string): string[] => {
		const streams = blocksCheckpoint(checkpoint) ? [checkpoint] : [];
		for (const [stream, set] of parents)
			if (set.has(checkpoint) && blocksCheckpoint(stream)) streams.push(stream);
		return streams;
	};

	const firstKeys = (keys: ReadonlySet<string>): string[] => {
		const listed: string[] = [];
		for (const key of keys) {
			if (listed.length >= WITHHELD_KEYS_LISTED) break;
			listed.push(key);
		}
		return listed;
	};

	/** One notice per stream and withheld kind, worded for that kind. */
	const notice = (
		stream: string,
		incomplete: readonly string[],
		withheld: WithheldKind,
	): EmittedMessage[] => {
		const noticeKey = `${withheld}\u0000${stream}`;
		if (notified.has(noticeKey)) return [];
		notified.add(noticeKey);
		const detail = incomplete.map((name) => {
			const loss = lossFor(name);
			return {
				stream: name,
				refused_records: loss.refused,
				refusal_causes: Object.fromEntries(loss.causes),
				skip_reasons: [...loss.skipReasons],
				undeclared_skip_reasons: [...loss.undeclaredSkips],
				// Enumerated keys whose rows were withheld: present at the
				// source, not stored this run, never to be treated as deleted.
				withheld_keys: firstKeys(loss.refusedKeys),
			};
		});
		const refused = detail.reduce((sum, d) => sum + d.refused_records, 0);
		const lost =
			refused > 0
				? `${String(refused)} ${refused === 1 ? "record" : "records"} could not be stored`
				: "part of the stream was skipped";
		return [
			{
				type: "SKIP_RESULT",
				stream,
				reason: CHECKPOINT_WITHHELD_REASON,
				message: `${stream}: ${lost} in this run, so the ${NOTICE_TEXT[withheld]}. Records already stored were kept.`,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				diagnostics: { withheld, streams: detail },
			},
		];
	};

	/**
	 * Correct a coverage report, or return null when it needs no change.
	 *
	 * What a coverage report must never do after a loss is read complete.
	 * `covered` is capped at `considered` minus the refused rows, so a run
	 * with any refusal always reads partial. The cap is exact for a connector
	 * that already left refused rows out of `covered` (many validate rows
	 * themselves before counting them). When the connector also reports a
	 * separate shortfall, the count can stay above the true number of rows
	 * stored, but the report still reads partial. Itemized outcome claims are
	 * stricter: see `rewriteEvidence`.
	 */
	const rewriteCoverage = (
		msg: DetailCoverageMessage,
		loss: StreamLoss,
	): DetailCoverageMessage | null => {
		const { considered, covered, ...rest } = msg;
		const hydrated_keys = msg.hydrated_keys.filter(
			(key) => !loss.refusedKeys.has(String(key)),
		);
		const keysChanged = hydrated_keys.length !== msg.hydrated_keys.length;
		// After a reported skip the runtime cannot count what was lost, so a
		// report that reads full (or could read full from the collected count)
		// becomes unknown. A report that already shows a shortfall stays.
		const readsFull =
			covered === undefined
				? considered !== undefined
				: considered === undefined || covered >= considered;
		if (loss.skipReasons.size > 0 && readsFull)
			return { ...rest, hydrated_keys };
		const corrected =
			covered === undefined
				? undefined
				: considered === undefined
					? Math.max(0, covered - loss.refused)
					: Math.min(covered, Math.max(0, considered - loss.refused));
		if (!keysChanged && corrected === covered) return null;
		return {
			...rest,
			hydrated_keys,
			...(considered === undefined ? {} : { considered }),
			...(corrected === undefined ? {} : { covered: corrected }),
		};
	};

	/**
	 * Itemized outcomes claim each row's fate, so every refusal the connector
	 * could not see (schema, missing id) moves from `emitted` to
	 * `unaccounted`, without assuming it overlaps rows the connector already
	 * reported unaccounted. A row the connector withheld itself through
	 * `emitRow` is acknowledged and not moved again. A connector that
	 * validates rows itself and leaves them out of `emitted` under-reports
	 * `emitted`, which is the safe direction.
	 */
	const rewriteEvidence = (
		msg: StreamEvidence,
		loss: StreamLoss,
	): StreamEvidence | null => {
		const moved = Math.min(loss.unacknowledged, msg.outcomes.emitted);
		if (moved === 0) return null;
		return {
			...msg,
			outcomes: {
				...msg.outcomes,
				emitted: msg.outcomes.emitted - moved,
				unaccounted: msg.outcomes.unaccounted + moved,
			},
		};
	};

	const gate = (msg: EmittedMessage): EmittedMessage[] => {
		switch (msg.type) {
			case "SKIP_RESULT": {
				if (!isDeclaredBound(msg)) {
					const loss = lossFor(msg.stream);
					loss.skipReasons.add(msg.reason);
					if (msg.reason === "stream_collection_failed") loss.failed = true;
					else if (resumeSafeBasisOf(msg) === null)
						loss.undeclaredSkips.add(msg.reason);
				}
				return [msg];
			}
			case "DETAIL_GAP": {
				linkParent(msg.stream, msg.parent_stream);
				return [msg];
			}
			case "DETAIL_GAP_RECOVERED": {
				// A receipt retires a durable gap. It must not retire one whose
				// recovered record the runtime refused in this run.
				const loss = losses.get(msg.stream);
				if (!loss || loss.refused === 0) return [msg];
				const refusedHere =
					msg.record_key === undefined
						? true
						: loss.refusedKeys.has(String(msg.record_key));
				return refusedHere
					? notice(msg.stream, [msg.stream], "DETAIL_GAP_RECOVERED")
					: [msg];
			}
			case "DETAIL_COVERAGE": {
				linkParent(msg.stream, msg.state_stream);
				const loss = losses.get(msg.stream);
				if (!loss) return [msg];
				const rewritten = rewriteCoverage(msg, loss);
				if (rewritten === null) return [msg];
				return [
					...notice(msg.stream, [msg.stream], "DETAIL_COVERAGE"),
					rewritten,
				];
			}
			case "STREAM_EVIDENCE": {
				const loss = losses.get(msg.stream);
				const rewritten = loss ? rewriteEvidence(msg, loss) : null;
				if (rewritten === null) return [msg];
				return [
					...notice(msg.stream, [msg.stream], "STREAM_EVIDENCE"),
					rewritten,
				];
			}
			case "STATE": {
				const incomplete = incompleteUnder(msg.stream);
				return incomplete.length === 0
					? [msg]
					: notice(msg.stream, incomplete, "STATE");
			}
			case "RECORD": {
				if (msg.op !== "delete" || !isIncomplete(msg.stream)) return [msg];
				return notice(msg.stream, [msg.stream], "delete");
			}
			default:
				return [msg];
		}
	};

	return {
		gate,
		isIncomplete,
		refuseRecord(stream, key, cause) {
			const loss = lossFor(stream);
			loss.refused += 1;
			if (cause !== "fields_unavailable") loss.unacknowledged += 1;
			loss.causes.set(cause, (loss.causes.get(cause) ?? 0) + 1);
			if (key !== null) loss.refusedKeys.add(key);
		},
		withheldStreams: () => {
			const streams = new Set<string>();
			for (const key of notified) streams.add(key.split("\u0000")[1] ?? "");
			return [...streams];
		},
	};
}
