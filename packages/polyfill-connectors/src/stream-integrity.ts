// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run stream integrity: the runtime refuses a stream's completion claims
 * once any of that stream's rows was lost in the run.
 *
 * THE RULE
 *
 * A stream is *incomplete for the run* once any of these happens to it:
 *
 *   1. The runtime refuses one of its records: the output schema rejected it
 *      (`shape_check_failed`), it had no `id`, or the connector handed it over
 *      as uncovered because a mapped field was unavailable
 *      (`record_fields_unavailable`, see `field-reader.ts`).
 *   2. The connector reports the stream failed:
 *      `SKIP_RESULT{reason: "stream_collection_failed"}`.
 *   3. The connector reports any other skip for it that is not a declared
 *      bound (below), for example a retryable `source_unreadable`.
 *
 * While a stream is incomplete, the runtime changes these outgoing messages:
 *
 *   - `STATE` whose `stream` is the stream, or a checkpoint parent of it,
 *     after a loss under rule 1 or 2: not sent. The previous checkpoint
 *     stays, so the next run reads the lost rows again. Under rule 1 the
 *     connector believed the row was delivered, so its cursor may already be
 *     past it. Under rule 2 the Collection Profile's certified-failure rule
 *     already keeps a failed stream's checkpoint from being saved; the
 *     runtime enforces the same thing at the source.
 *     After a rule-3 skip alone, `STATE` IS sent. The connector reported the
 *     loss itself, so its cursor is its own resume position; connectors use
 *     exactly this to save progress up to the loss (a cursor at the day
 *     before a failed read, a pinned list position with a backfill token, a
 *     cursor that carries its own gap list). Withholding those checkpoints
 *     loses progress and can stop a budgeted walk from ever converging. A
 *     connector whose cursor passes a loss it reported is a connector defect
 *     the runtime cannot see; it is still blocked from deleting or claiming
 *     full coverage below.
 *   - `RECORD{op: "delete"}` for the incomplete stream (any rule): not sent. A row that
 *     could not be read in this run must not be deleted as "unseen".
 *   - `DETAIL_COVERAGE` for the incomplete stream: keys of refused records are
 *     removed from `hydrated_keys`, so they are unaccounted; `covered` is
 *     capped at `considered` minus the refused records (a connector that
 *     already left them out is unchanged). After a connector-reported skip, the
 *     runtime cannot count what was lost, so a report that reads full
 *     (`covered >= considered`, or `considered` with no `covered`) loses
 *     `considered` and `covered` and reads as unknown, not complete. A report
 *     that already shows a shortfall is left alone.
 *   - `STREAM_EVIDENCE` for the incomplete stream: refused records not already
 *     reported as unaccounted move from `outcomes.emitted` to
 *     `outcomes.unaccounted`.
 *
 * The first time it changes a message for a stream, the runtime sends one
 * `SKIP_RESULT{reason: "stream_incomplete_checkpoint_withheld",
 * recovery_hint: retry_by_runtime}` for that stream. Records that were
 * already accepted stay: the run is upsert-only for that stream. The run's
 * `DONE` status does not change.
 *
 * Messages sent BEFORE a stream becomes incomplete are not recalled: a
 * periodic `STATE` taken before the loss is still a true checkpoint, and a
 * `delete` already sent cannot be taken back. Connectors that emit deletes
 * for unseen rows must emit them after every row of the stream was read.
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
 *     `row_withheld: true`, and the omitted field names with reasons — never
 *     field values. The withheld row is a loss under rule 1.
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

type SkipResult = Extract<EmittedMessage, { type: "SKIP_RESULT" }>;
type StreamEvidence = Extract<EmittedMessage, { type: "STREAM_EVIDENCE" }>;
type WithheldKind = "DETAIL_COVERAGE" | "STATE" | "STREAM_EVIDENCE" | "delete";

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
	readonly refusedKeys: Set<string>;
	refused: number;
	readonly skipReasons: Set<string>;
}

export interface StreamIntegrity {
	/**
	 * Pass one outgoing connector message through the rule. Returns the
	 * messages to send instead, in order: the message itself, a changed copy,
	 * and/or the one-time withheld notice. Empty when nothing is sent.
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
	/** Incomplete data streams whose loss blocks a checkpoint for `checkpoint`. */
	/** Rule 1 or 2: the stream's own checkpoint cannot be trusted this run. */
	const blocksCheckpoint = (stream: string): boolean => {
		const loss = losses.get(stream);
		return loss !== undefined && (loss.refused > 0 || loss.failed);
	};
	const incompleteUnder = (checkpoint: string): string[] => {
		const streams = blocksCheckpoint(checkpoint) ? [checkpoint] : [];
		for (const [stream, set] of parents)
			if (set.has(checkpoint) && blocksCheckpoint(stream)) streams.push(stream);
		return streams;
	};

	const notice = (
		stream: string,
		incomplete: readonly string[],
		withheld: WithheldKind,
	): EmittedMessage[] => {
		if (notified.has(stream)) return [];
		notified.add(stream);
		const detail = incomplete.map((name) => {
			const loss = lossFor(name);
			return {
				stream: name,
				refused_records: loss.refused,
				refusal_causes: Object.fromEntries(loss.causes),
				skip_reasons: [...loss.skipReasons],
				// Enumerated keys whose rows were withheld: present at the
				// source, not stored this run, never to be treated as deleted.
				withheld_keys: [...loss.refusedKeys].slice(0, WITHHELD_KEYS_LISTED),
			};
		});
		const refused = detail.reduce((sum, d) => sum + d.refused_records, 0);
		const lost =
			refused > 0
				? `${String(refused)} ${refused === 1 ? "record" : "records"} could not be read`
				: "part of the stream was skipped";
		return [
			{
				type: "SKIP_RESULT",
				stream,
				reason: CHECKPOINT_WITHHELD_REASON,
				message: `Completion for ${stream} not saved: ${lost} in this run. Records already read were kept; the next run reads this stream again from the previous checkpoint.`,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				diagnostics: { withheld, streams: detail },
			},
		];
	};

	const rewriteCoverage = (
		msg: DetailCoverageMessage,
		loss: StreamLoss,
	): DetailCoverageMessage => {
		const { considered, covered, ...rest } = msg;
		const hydrated_keys = msg.hydrated_keys.filter(
			(key) => !loss.refusedKeys.has(String(key)),
		);
		// After a connector-reported skip the runtime cannot count what was
		// lost, so a report that reads full (or could read full from the
		// collected count) becomes unknown. A report that already shows a
		// shortfall is honest and stays.
		const readsFull =
			covered === undefined
				? considered !== undefined
				: considered === undefined || covered >= considered;
		if (loss.skipReasons.size > 0 && readsFull)
			return { ...rest, hydrated_keys };
		// `considered` counts the refused rows. A connector that already left
		// them out of `covered` is unchanged; one that counted them drops by
		// exactly the refused number.
		const ceiling =
			considered === undefined
				? undefined
				: Math.max(0, considered - loss.refused);
		const corrected =
			covered === undefined
				? undefined
				: ceiling === undefined
					? Math.max(0, covered - loss.refused)
					: Math.min(covered, ceiling);
		return {
			...rest,
			hydrated_keys,
			...(considered === undefined ? {} : { considered }),
			...(corrected === undefined ? {} : { covered: corrected }),
		};
	};

	const rewriteEvidence = (
		msg: StreamEvidence,
		loss: StreamLoss,
	): StreamEvidence => {
		// Refused rows the connector already reported as unaccounted stay put.
		const moved = Math.max(
			0,
			Math.min(loss.refused - msg.outcomes.unaccounted, msg.outcomes.emitted),
		);
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
				}
				return [msg];
			}
			case "DETAIL_GAP": {
				linkParent(msg.stream, msg.parent_stream);
				return [msg];
			}
			case "DETAIL_COVERAGE": {
				linkParent(msg.stream, msg.state_stream);
				const loss = losses.get(msg.stream);
				if (!loss) return [msg];
				const rewritten = rewriteCoverage(msg, loss);
				if (JSON.stringify(rewritten) === JSON.stringify(msg)) return [msg];
				return [
					...notice(msg.stream, [msg.stream], "DETAIL_COVERAGE"),
					rewritten,
				];
			}
			case "STREAM_EVIDENCE": {
				const loss = losses.get(msg.stream);
				if (!loss || loss.refused === 0) return [msg];
				return [
					...notice(msg.stream, [msg.stream], "STREAM_EVIDENCE"),
					rewriteEvidence(msg, loss),
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
			loss.causes.set(cause, (loss.causes.get(cause) ?? 0) + 1);
			if (key !== null) loss.refusedKeys.add(key);
		},
		withheldStreams: () => [...notified],
	};
}
