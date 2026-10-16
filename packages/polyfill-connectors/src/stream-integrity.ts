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
 *   3. The connector reports any other skip, whatever its `recovery_hint`
 *      or `continuation`, for example `source_unreadable`. Only the reasons
 *      listed under NOT A LOSS (below) are exempt.
 *
 * What the runtime then does to outgoing messages:
 *
 *   - `STATE` whose `stream` is the stream, or any checkpoint ancestor of it
 *     (the full chain of parents, see CHECKPOINT PARENTS):
 *     not sent after a rule-1 or rule-2 loss, nor after a rule-3 skip that
 *     carries no typed declaration (a resume-safe basis or a declared bound,
 *     both below). `recovery_hint.retryable: false` is not a declaration, and
 *     neither is a `continuation` by itself. The previous checkpoint stays, so
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
 *     site, made by the code that owns the cursor.
 *     A rule-3 skip may instead carry a DECLARED BOUND
 *     (`declaredBoundSkip(msg, bound)`, on the wire as
 *     `diagnostics.declared_bound`): the skipped part is out of collection
 *     by design (`configured_limit`, `unsupported_input`; see
 *     `DeclaredBound`). That also lets `STATE` pass.
 *     Rules 1 and 2 have no declaration path.
 *   - `RECORD{op: "delete"}` for the stream (any rule): not sent. A row that
 *     could not be read in this run must not be deleted as "unseen".
 *   - `DETAIL_GAP_RECOVERED` for a key the runtime refused in this run (or
 *     with no key, once the stream had any refusal): not sent. A refused
 *     recovery must not retire its durable gap; the gap stays pending.
 *   - `DETAIL_COVERAGE` for the stream: keys of refused records leave
 *     `hydrated_keys`, so they are unaccounted. `covered` is capped at
 *     `considered` minus the refused rows, so the report can never read
 *     complete after a loss. After a refusal, a report missing either count,
 *     or whose `considered` is below the refused rows (for example 0/0),
 *     contradicts the run and is withheld, with the typed loss notice. The
 *     protocol has no explicit unknown field: stripping counts alone would
 *     let consumers fall back to equal key-set lengths and read complete.
 *     After a rule-3 skip, a report that reads full (including the key-length
 *     fallback) is withheld too; a report that already shows a shortfall stays.
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
 * NOT A LOSS
 *
 * These SKIP_RESULT reasons do not make a stream lose rows:
 *
 *   - `scope_not_supported`: the Collection Profile's own typed declaration
 *     that a scope element is not honored for that stream or resource.
 *   - `shape_check_unmodeled_value`: a record that was kept, not skipped.
 *   - `stream_incomplete_checkpoint_withheld`: the runtime's own notice.
 *
 * Every other skip is a loss under rule 3. A typed declaration (resume-safe
 * basis or declared bound) only decides whether `STATE` may pass; deletes and
 * full-coverage claims stay blocked, because the stream was not fully read.
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
 * `required_keys` but not in `hydrated_keys` when coverage can be corrected;
 * otherwise the claim is withheld (unaccounted, not missing). In either case
 * the stored copy from an earlier run stays as it was.
 *
 * DETAIL_GAP AND CHECKPOINTS VERSUS DELETES
 *
 * A DETAIL_GAP is not a loss for checkpoints: the Collection Profile counts a
 * key backed by a durable `DETAIL_GAP` as accounted, and the runtime's gap
 * recovery retries it, so the parent checkpoint may advance. That exception
 * is for checkpoints only. The gapped row was not read in this run, so a
 * `RECORD{op: "delete"}` for a key with a pending DETAIL_GAP in that stream
 * is never sent.
 *
 * A raw `SKIP_RESULT{reason: "stream_collection_failed"}` sent through
 * `ctx.emit` ends the run failed, exactly like `reportStreamFailure()`.
 *
 * CHECKPOINT PARENTS
 *
 * `STATE.stream` names a checkpoint, which can differ from the data streams
 * it covers. The dependencies are known before the first message: the
 * manifest's `state_stream` / `parent_streams` for each stream (carried into a
 * built artifact by the generated table, `CHECKPOINT_PARENTS`) seed the
 * runtime at construction. A stream that declares neither is its own
 * checkpoint, as the Collection Profile defines. Links the run names on the
 * wire (`DETAIL_COVERAGE.state_stream`, `DETAIL_GAP.parent_stream`) are added.
 * A loss blocks the STATE of every checkpoint reachable through any chain of
 * parents; independent streams are not affected.
 *
 * TRUST BOUNDARY
 *
 * A resume-safe basis or a declared bound is a typed CLAIM by the code that
 * owns the cursor; the runtime checks only that it is one of the closed set.
 * Likewise `enumerated()` evaluates the evidence it is given, and an
 * Enumeration value can be built by hand. These rules stop honest mistakes
 * and make every claim visible on the wire and at its call site; they do not
 * stop a connector that asserts a false basis. Already-sent messages are not
 * recalled, so a periodic STATE must cover only work already stored.
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
	return withDiagnostic(msg, "resume_safe", basis);
}

/** The declared basis on a SKIP_RESULT, if it is one of the closed set. */
export function resumeSafeBasisOf(msg: SkipResult): ResumeSafeBasis | null {
	const basis = diagnosticOf(msg, "resume_safe");
	return typeof basis === "string" && RESUME_SAFE_BASES.has(basis)
		? (basis as ResumeSafeBasis)
		: null;
}

function withDiagnostic(
	msg: SkipResult,
	key: "declared_bound" | "resume_safe",
	value: string,
): SkipResult {
	const diagnostics =
		typeof msg.diagnostics === "object" &&
		msg.diagnostics !== null &&
		!Array.isArray(msg.diagnostics)
			? msg.diagnostics
			: msg.diagnostics === undefined
				? {}
				: { connector: msg.diagnostics };
	return { ...msg, diagnostics: { ...diagnostics, [key]: value } };
}

function diagnosticOf(msg: SkipResult, key: string): unknown {
	const diagnostics = msg.diagnostics;
	if (typeof diagnostics !== "object" || diagnostics === null) return null;
	return Reflect.get(diagnostics, key);
}

/** Bound on keys listed in one withheld notice; the count is always exact. */
const WITHHELD_KEYS_LISTED = 50;

/**
 * SKIP_RESULT reasons that are not a loss at all: the Collection Profile's
 * typed `scope_not_supported` declaration, a kept-with-drift record report,
 * and the runtime's own withheld notice. Nothing else is exempt by reason,
 * by `recovery_hint.retryable`, or by carrying a `continuation`.
 */
const NOT_A_LOSS_REASONS: ReadonlySet<string> = new Set([
	"scope_not_supported",
	"shape_check_unmodeled_value",
	CHECKPOINT_WITHHELD_REASON,
]);

/** True when a `SKIP_RESULT` is not a loss (see `NOT_A_LOSS_REASONS`). */
export function isNotALoss(msg: SkipResult): boolean {
	return NOT_A_LOSS_REASONS.has(msg.reason);
}

/**
 * A typed declaration that a skip is a deliberate bound, not an accident:
 *
 *   - `configured_limit`: collection stops at a documented limit (a page
 *     budget, an item cap); rows past it are not collected by design and the
 *     owner sees the skip.
 *   - `unsupported_input`: the skipped input is not a source this connector
 *     reads (for example, a file in an import folder that is not an export).
 *
 * Declare it with `declaredBoundSkip` at the call site. Like a resume-safe
 * declaration it lets the stream's STATE pass; the skip still blocks deletes
 * and full-coverage claims, because the stream is not fully read.
 */
export type DeclaredBound = "configured_limit" | "unsupported_input";

const DECLARED_BOUNDS: ReadonlySet<string> = new Set<DeclaredBound>([
	"configured_limit",
	"unsupported_input",
]);

/** Declare on a SKIP_RESULT that it is a deliberate bound (see `DeclaredBound`). */
export function declaredBoundSkip(
	msg: SkipResult,
	bound: DeclaredBound,
): SkipResult {
	return withDiagnostic(msg, "declared_bound", bound);
}

/** The declared bound on a SKIP_RESULT, if it is one of the closed set. */
export function declaredBoundOf(msg: SkipResult): DeclaredBound | null {
	const bound = diagnosticOf(msg, "declared_bound");
	return typeof bound === "string" && DECLARED_BOUNDS.has(bound)
		? (bound as DeclaredBound)
		: null;
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
	DETAIL_COVERAGE: "coverage claim withheld or corrected because the stream is incomplete",
	STREAM_EVIDENCE: "stream evidence corrected to count only rows stored",
	DETAIL_GAP_RECOVERED:
		"gap recovery not recorded; the refused record's gap stays pending",
};

export interface StreamIntegrityOptions {
	/**
	 * The manifest's declared checkpoint dependencies, known before the first
	 * message: data stream → its `state_stream` / `parent_streams`. A stream
	 * that declares neither is its own checkpoint (Collection Profile
	 * "Checkpoint dependency"). Links the run names on the wire are added.
	 */
	readonly checkpointParents?: Readonly<Record<string, readonly string[]>>;
}

const EMPTY_LOSS: StreamLoss = {
	causes: new Map(),
	failed: false,
	refusedKeys: new Set(),
	refused: 0,
	skipReasons: new Set(),
	unacknowledged: 0,
	undeclaredSkips: new Set(),
};

export function createStreamIntegrity(
	options: StreamIntegrityOptions = {},
): StreamIntegrity {
	const losses = new Map<string, StreamLoss>();
	const parents = new Map<string, Set<string>>();
	const notified = new Set<string>();
	/** Keys with a pending DETAIL_GAP this run, per stream: never deleted. */
	const gapKeys = new Map<string, Set<string>>();
	for (const [stream, declared] of Object.entries(
		options.checkpointParents ?? {},
	))
		for (const parent of declared)
			if (parent !== stream) {
				const set = parents.get(stream) ?? new Set<string>();
				set.add(parent);
				parents.set(stream, set);
			}

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
	/** True when `ancestor` is reachable from `stream` through parent links. */
	const dependsOn = (stream: string, ancestor: string): boolean => {
		const seen = new Set<string>();
		const pending = [stream];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			for (const parent of parents.get(next) ?? []) {
				if (parent === ancestor) return true;
				if (!seen.has(parent)) {
					seen.add(parent);
					pending.push(parent);
				}
			}
		}
		return false;
	};
	/**
	 * Streams whose loss blocks a checkpoint for `checkpoint`: itself, and
	 * every stream that depends on it through any chain of parents.
	 */
	const incompleteUnder = (checkpoint: string): string[] => {
		const streams = blocksCheckpoint(checkpoint) ? [checkpoint] : [];
		for (const stream of losses.keys())
			if (
				stream !== checkpoint &&
				blocksCheckpoint(stream) &&
				dependsOn(stream, checkpoint)
			)
				streams.push(stream);
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
			// Read-only: reporting a withheld message must not itself record a
			// loss (a gapped-key delete leaves the stream otherwise intact).
			const loss = losses.get(name) ?? EMPTY_LOSS;
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
	 * Correct a coverage report, return null when unchanged, or false to
	 * withhold a claim whose denominator is unknown or contradicts the loss.
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
	): DetailCoverageMessage | null | false => {
		const { considered, covered, ...rest } = msg;
		const hydrated_keys = msg.hydrated_keys.filter(
			(key) => !loss.refusedKeys.has(String(key)),
		);
		const keysChanged = hydrated_keys.length !== msg.hydrated_keys.length;
		// After a reported skip the runtime cannot count what was lost, so a
		// report that reads full (or could read full from the collected count)
		// is withheld. A report that already shows a shortfall stays. Include
		// the documented key-length fallback when neither count was supplied.
		const readsFull =
			covered === undefined
				? considered !== undefined || hydrated_keys.length >= msg.required_keys.length
				: considered === undefined || covered >= considered;
		if (loss.skipReasons.size > 0 && readsFull) return false;
		// After a refusal, a report missing either count, or whose denominator
		// cannot hold the refused rows, contradicts the run: it becomes
		// unknown, so withhold the entire claim. Removing counts alone would
		// leave a key-length completion claim. Counts are never inferred.
		if (
			loss.refused > 0 &&
			(covered === undefined ||
				considered === undefined ||
				considered < loss.refused)
		) return false;
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
				if (!isNotALoss(msg)) {
					const loss = lossFor(msg.stream);
					loss.skipReasons.add(msg.reason);
					if (msg.reason === "stream_collection_failed") loss.failed = true;
					else if (
						resumeSafeBasisOf(msg) === null &&
						declaredBoundOf(msg) === null
					)
						loss.undeclaredSkips.add(msg.reason);
				}
				return [msg];
			}
			case "DETAIL_GAP": {
				linkParent(msg.stream, msg.parent_stream);
				const keys = gapKeys.get(msg.stream) ?? new Set<string>();
				keys.add(String(msg.record_key));
				gapKeys.set(msg.stream, keys);
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
					...(rewritten === false ? [] : [rewritten]),
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
				if (msg.op !== "delete") return [msg];
				// A durable DETAIL_GAP lets the parent checkpoint advance, but the
				// gapped row was not read: it must not be deleted as unseen.
				const gapped = gapKeys.get(msg.stream)?.has(String(msg.key)) ?? false;
				if (!(gapped || isIncomplete(msg.stream))) return [msg];
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
