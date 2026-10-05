// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `OBSERVATION`: typed failure-diagnosis facts (Collection Profile 0.2.0,
 * Section 5.10). This module is the package's projection of that section:
 *
 * - the fact vocabulary of this profile version and its zod schemas;
 * - the connector-side sink that the shared helpers write facts to
 *   (`observe`), which puts an `OBSERVATION` on standard output only when the
 *   connector declares the capability, and otherwise writes a diagnostic line;
 * - the runtime-side ingest that a parent runtime (`bin/connector-dev.ts`)
 *   uses to turn a connector's standard output into run-record facts. The
 *   transport sets provenance: everything read from standard output is
 *   `source: "connector"`, and runtime-only fact types from a connector are
 *   discarded and recorded as a protocol violation.
 *
 * Facts carry no secrets and no free text. Provider text goes into a local
 * artifact named by `evidence_ref`, never into `attrs`.
 */

import { emitToStdout } from "@pdpp/connector-protocol";
import { z } from "zod";
import { connectorDiagnostic } from "./connector-diagnostic.ts";

export const OBSERVATION_CAPABILITY = "OBSERVATION";

/**
 * Per-run limits. A connector-side sink stops emitting at `maxPerRun`; a
 * runtime discards everything past it and marks the run record truncated.
 * Evidence from a truncated record never authorizes a recovery action.
 */
export const OBSERVATION_LIMITS = Object.freeze({
	maxPerRun: 64,
	maxLineBytes: 2048,
	maxStatesSeen: 8,
	maxResolves: 16,
});

export const ELEMENT_STATES = [
	"matched",
	"absent",
	"hidden",
	"disabled",
	"ambiguous",
] as const;
export type ElementState = (typeof ELEMENT_STATES)[number];

export const PROVIDER_MESSAGE_KINDS = ["auth_failure", "other"] as const;

/** Fact types a connector may put in an `OBSERVATION`. */
export const CONNECTOR_FACT_TYPES = [
	"element_expectation",
	"wait_expired",
	"provider_message",
] as const;

/** Fact types only the runtime records. A connector that sends one commits a
 *  protocol violation; the runtime discards the fact. */
export const RUNTIME_FACT_TYPES = [
	"credential_submission",
	"rule_match",
	"connector_defect",
] as const;

export const CREDENTIAL_SUBMISSION_OUTCOMES = [
	"succeeded",
	"rejected",
	"unsettled",
] as const;
export const RULE_KINDS = ["auth"] as const;
export const CONNECTOR_DEFECT_CLASSES = [
	"protocol_violation",
	"hint_unsupported",
] as const;
export const PROTOCOL_VIOLATION_REASONS = [
	"capability_not_declared",
	"invalid_observation",
	"runtime_only_fact",
	"duplicate_id",
	"oversize",
] as const;
export type ProtocolViolationReason =
	(typeof PROTOCOL_VIOLATION_REASONS)[number];

// ─── Schemas ──────────────────────────────────────────────────────────────

/** Step, expectation and rule ids: the connector's declared descriptors. */
export const DESCRIPTOR_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A local artifact reference: printable ASCII, no spaces, never a URL. */
const EVIDENCE_REF_RE = /^(?!.*:\/\/)[!-~]{1,256}$/;

const descriptorId = z.string().regex(DESCRIPTOR_ID_RE);
const observationId = z.string().regex(OBSERVATION_ID_RE);
const evidenceRef = z.string().regex(EVIDENCE_REF_RE);
const runtimeHandle = z.string().regex(OBSERVATION_ID_RE);

const elementExpectationAttrs = z
	.strictObject({
		expectation: descriptorId,
		states_seen: z
			.array(z.enum(ELEMENT_STATES))
			.min(1)
			.max(OBSERVATION_LIMITS.maxStatesSeen),
		final: z.enum(ELEMENT_STATES),
		fallback_used: z.boolean().optional(),
	})
	.refine((attrs) => attrs.states_seen.includes(attrs.final), {
		message: "final must be one of states_seen",
	});

const waitExpiredAttrs = z.strictObject({
	awaited: descriptorId,
	budget_ms: z.number().int().min(0).max(86_400_000),
});

const providerMessageAttrs = z.strictObject({
	kind: z.enum(PROVIDER_MESSAGE_KINDS),
	rule: descriptorId.optional(),
});

const messageBase = {
	type: z.literal("OBSERVATION"),
	id: observationId,
	evidence_ref: evidenceRef.optional(),
	resolves: z
		.array(observationId)
		.min(1)
		.max(OBSERVATION_LIMITS.maxResolves)
		.optional(),
};

/** One connector `OBSERVATION` message as it appears on standard output. */
export const observationMessageSchema = z.discriminatedUnion("fact", [
	z.strictObject({
		...messageBase,
		fact: z.literal("element_expectation"),
		step: descriptorId,
		attrs: elementExpectationAttrs,
	}),
	z.strictObject({
		...messageBase,
		fact: z.literal("wait_expired"),
		step: descriptorId,
		attrs: waitExpiredAttrs,
	}),
	z.strictObject({
		...messageBase,
		fact: z.literal("provider_message"),
		step: descriptorId.optional(),
		attrs: providerMessageAttrs,
	}),
]);
export type ObservationMessage = z.infer<typeof observationMessageSchema>;

const credentialSubmissionAttrs = z.strictObject({
	attempt: runtimeHandle,
	account: runtimeHandle,
	outcome: z.enum(CREDENTIAL_SUBMISSION_OUTCOMES),
	rule: descriptorId.optional(),
});
const ruleMatchAttrs = z.strictObject({
	rule: descriptorId,
	kind: z.enum(RULE_KINDS),
	handle: runtimeHandle,
});
const connectorDefectAttrs = z.strictObject({
	class: z.enum(CONNECTOR_DEFECT_CLASSES),
	reason: z.enum(PROTOCOL_VIOLATION_REASONS).optional(),
	count: z.number().int().min(1).optional(),
});

const runtimeRecordBase = {
	source: z.literal("runtime"),
	id: observationId,
	step: descriptorId.optional(),
};

/** A fact as the run record keeps it: provenance set by the transport. */
export const runRecordFactSchema = z.union([
	z.discriminatedUnion("fact", [
		z.strictObject({
			...runtimeRecordBase,
			fact: z.literal("credential_submission"),
			attrs: credentialSubmissionAttrs,
		}),
		z.strictObject({
			...runtimeRecordBase,
			fact: z.literal("rule_match"),
			attrs: ruleMatchAttrs,
		}),
		z.strictObject({
			...runtimeRecordBase,
			fact: z.literal("connector_defect"),
			attrs: connectorDefectAttrs,
		}),
	]),
	z.discriminatedUnion("fact", [
		z.strictObject({
			source: z.literal("connector"),
			id: observationId,
			fact: z.literal("element_expectation"),
			step: descriptorId,
			attrs: elementExpectationAttrs,
			evidence_ref: evidenceRef.optional(),
			resolves: messageBase.resolves,
		}),
		z.strictObject({
			source: z.literal("connector"),
			id: observationId,
			fact: z.literal("wait_expired"),
			step: descriptorId,
			attrs: waitExpiredAttrs,
			evidence_ref: evidenceRef.optional(),
			resolves: messageBase.resolves,
		}),
		z.strictObject({
			source: z.literal("connector"),
			id: observationId,
			fact: z.literal("provider_message"),
			step: descriptorId.optional(),
			attrs: providerMessageAttrs,
			evidence_ref: evidenceRef.optional(),
			resolves: messageBase.resolves,
		}),
	]),
]);
export type RunRecordFact = z.infer<typeof runRecordFactSchema>;
export type ConnectorRunRecordFact = Extract<
	RunRecordFact,
	{ source: "connector" }
>;
export type RuntimeRunRecordFact = Extract<
	RunRecordFact,
	{ source: "runtime" }
>;

/** The manifest's `diagnostic_descriptors` member (Section 3.8). */
export const diagnosticDescriptorsSchema = z.strictObject({
	steps: z
		.array(z.strictObject({ id: descriptorId }))
		.max(64)
		.optional(),
	expectations: z
		.array(z.strictObject({ id: descriptorId, step: descriptorId }))
		.max(256)
		.optional(),
	rules: z
		.array(
			z.strictObject({
				id: descriptorId,
				kind: z.enum(RULE_KINDS),
				step: descriptorId.optional(),
			}),
		)
		.max(64)
		.optional(),
});
export type DiagnosticDescriptors = z.infer<typeof diagnosticDescriptorsSchema>;

/**
 * What a runtime keeps about one run for diagnosis: the connector's declared
 * capabilities and descriptors at run time, every fact with its provenance,
 * whether the record was truncated, and how the process ended. Written by
 * `bin/connector-dev.ts` into the run summary and read by `bin/diagnose.ts`.
 */
export const runRecordSchema = z.strictObject({
	protocol_capabilities: z.array(z.string().max(64)).max(16),
	diagnostic_descriptors: diagnosticDescriptorsSchema.optional(),
	facts: z
		.array(runRecordFactSchema)
		// Connector facts are capped at maxPerRun; the rest is kept for the
		// runtime's own records, which a connector flood must not crowd out.
		.max(OBSERVATION_LIMITS.maxPerRun * 2),
	truncated: z.boolean(),
	process_exit: z
		.strictObject({
			code: z.number().int().nullable(),
			signal: z.string().max(32).nullable(),
		})
		.optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

// ─── Connector side ───────────────────────────────────────────────────────

type MessageWithoutWireFields<M> = M extends unknown
	? Omit<M, "id" | "type">
	: never;

/** A fact a connector reports. The sink assigns the id. */
export type ConnectorFact = MessageWithoutWireFields<ObservationMessage>;

/**
 * Receives one connector fact. Returns the `OBSERVATION` id when the fact
 * went out on the wire, so a later failure can cite it as `basis`; returns
 * `undefined` when it did not.
 */
export type ObservationSink = (fact: ConnectorFact) => string | undefined;

/** Fallback when the connector does not declare `OBSERVATION`: one
 *  diagnostic line, never a protocol message (Section 4). */
export const diagnosticObservationSink: ObservationSink = (fact) => {
	const fields: Record<string, boolean | number | string | undefined> = {
		fact: fact.fact,
		step: fact.step,
		evidence_ref: fact.evidence_ref,
	};
	for (const [key, value] of Object.entries(fact.attrs)) {
		fields[key] = Array.isArray(value) ? value.join(",") : value;
	}
	connectorDiagnostic("runtime", "observation", fields);
	return;
};

let activeSink: ObservationSink = diagnosticObservationSink;

/** Install the run's sink (the runtime does this), or restore the default. */
export function setObservationSink(next: ObservationSink | undefined): void {
	activeSink = next ?? diagnosticObservationSink;
}

/** Report one fact. Never throws: a diagnostic must not fail a run. */
export function observe(fact: ConnectorFact): string | undefined {
	try {
		return activeSink(fact);
	} catch {
		return;
	}
}

/**
 * The sink for a connector that declares `OBSERVATION`: assigns run-unique
 * ids, validates, and writes each fact as one `OBSERVATION` line. Stops at
 * the per-run limit and says so once on standard error.
 */
export function createWireObservationSink(
	write: (message: ObservationMessage) => void = (message): void => {
		emitToStdout(message).catch((): undefined => undefined);
	},
): ObservationSink {
	let emitted = 0;
	let limitReported = false;
	return (fact) => {
		if (emitted >= OBSERVATION_LIMITS.maxPerRun) {
			if (!limitReported) {
				limitReported = true;
				connectorDiagnostic("runtime", "observation_limit_reached", {
					limit: OBSERVATION_LIMITS.maxPerRun,
				});
			}
			return;
		}
		const parsed = observationMessageSchema.safeParse({
			type: "OBSERVATION",
			id: `o${emitted + 1}`,
			...fact,
		});
		if (!parsed.success) {
			connectorDiagnostic("runtime", "observation_invalid", {
				fact: fact.fact,
			});
			return;
		}
		emitted += 1;
		write(parsed.data);
		return parsed.data.id;
	};
}

const OBSERVATION_BASIS = Symbol.for("pdpp.observation.basis");
const MAX_CAUSE_DEPTH = 8;

/**
 * Attach the ids of the facts that explain this failure. The runtime copies
 * them to `DONE.error.basis` for a connector that declares `OBSERVATION`.
 */
export function withObservationBasis<E extends Error>(
	error: E,
	ids: readonly (string | undefined)[],
): E {
	const basis = ids.filter((id): id is string => typeof id === "string");
	if (basis.length > 0) {
		Object.defineProperty(error, OBSERVATION_BASIS, {
			value: basis,
			enumerable: false,
		});
	}
	return error;
}

/** Collect basis ids from an error and its `cause` chain, in order. */
export function observationBasisOf(error: unknown): string[] {
	const ids: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
		if (!(current instanceof Error)) {
			break;
		}
		const own: unknown = Reflect.get(current, OBSERVATION_BASIS);
		if (Array.isArray(own)) {
			for (const id of own) {
				if (typeof id === "string" && !ids.includes(id)) {
					ids.push(id);
				}
			}
		}
		current = current.cause;
	}
	return ids;
}

// ─── Runtime side ─────────────────────────────────────────────────────────

export interface ObservationIngestSnapshot {
	facts: RunRecordFact[];
	truncated: boolean;
}

/** What happened to one `OBSERVATION` line. */
export type ObservationIngestOutcome =
	| { accepted: ConnectorRunRecordFact }
	| { discarded: ProtocolViolationReason | "truncated" };

export interface ObservationIngest {
	/** One parsed standard-output object whose `type` is `OBSERVATION`. */
	accept: (raw: unknown, lineBytes: number) => ObservationIngestOutcome;
	snapshot: () => ObservationIngestSnapshot;
}

function isRuntimeOnlyFact(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) {
		return false;
	}
	const fact: unknown = Reflect.get(raw, "fact");
	return RUNTIME_FACT_TYPES.some((type) => type === fact);
}

/**
 * Runtime-side handling of a connector's `OBSERVATION` lines. Provenance
 * comes from the transport: every accepted fact is `source: "connector"`.
 * Violations are discarded and aggregated into one `connector_defect` record
 * per reason, so a flood cannot crowd out the runtime's own records.
 */
export function createObservationIngest(options: {
	declared: boolean;
}): ObservationIngest {
	const facts: ConnectorRunRecordFact[] = [];
	const seenIds = new Set<string>();
	const violations = new Map<ProtocolViolationReason, number>();
	let truncated = false;

	const violate = (reason: ProtocolViolationReason): void => {
		violations.set(reason, (violations.get(reason) ?? 0) + 1);
	};

	const classify = (
		raw: unknown,
		lineBytes: number,
	): ProtocolViolationReason | ObservationMessage => {
		if (!options.declared) {
			return "capability_not_declared";
		}
		if (lineBytes > OBSERVATION_LIMITS.maxLineBytes) {
			return "oversize";
		}
		if (isRuntimeOnlyFact(raw)) {
			return "runtime_only_fact";
		}
		const parsed = observationMessageSchema.safeParse(raw);
		if (!parsed.success) {
			return "invalid_observation";
		}
		if (seenIds.has(parsed.data.id)) {
			return "duplicate_id";
		}
		return parsed.data;
	};

	return {
		accept(raw, lineBytes): ObservationIngestOutcome {
			if (facts.length >= OBSERVATION_LIMITS.maxPerRun) {
				truncated = true;
				return { discarded: "truncated" };
			}
			const result = classify(raw, lineBytes);
			if (typeof result === "string") {
				violate(result);
				return { discarded: result };
			}
			seenIds.add(result.id);
			const { type: _type, ...rest } = result;
			const fact: ConnectorRunRecordFact = { source: "connector", ...rest };
			facts.push(fact);
			return { accepted: fact };
		},
		snapshot(): ObservationIngestSnapshot {
			const defects: RuntimeRunRecordFact[] = [...violations].map(
				([reason, count], index) => ({
					source: "runtime",
					id: `r${index + 1}`,
					fact: "connector_defect",
					attrs: { class: "protocol_violation", reason, count },
				}),
			);
			return { facts: [...facts, ...defects], truncated };
		},
	};
}

/** True for a parsed standard-output object whose `type` is `OBSERVATION`. */
export function isObservationLine(raw: unknown): boolean {
	return (
		typeof raw === "object" &&
		raw !== null &&
		Reflect.get(raw, "type") === "OBSERVATION"
	);
}

export interface ManifestDiagnosticDeclarations {
	readonly declaresObservation: boolean;
	readonly descriptors: DiagnosticDescriptors | undefined;
	/** Set when the manifest has a `diagnostic_descriptors` member that does
	 *  not validate; the run then proceeds with no declared descriptors. */
	readonly invalidDescriptors: boolean;
	readonly protocolCapabilities: string[];
}

/** Read the manifest members diagnosis depends on. Invalid descriptors are
 *  dropped, so an undeclared id can never support a cause. */
export function manifestDiagnosticDeclarations(
	manifest: unknown,
): ManifestDiagnosticDeclarations {
	const rawCapabilities: unknown =
		typeof manifest === "object" && manifest !== null
			? Reflect.get(manifest, "protocol_capabilities")
			: undefined;
	const protocolCapabilities = Array.isArray(rawCapabilities)
		? rawCapabilities.filter(
				(value): value is string => typeof value === "string",
			)
		: [];
	const rawDescriptors: unknown =
		typeof manifest === "object" && manifest !== null
			? Reflect.get(manifest, "diagnostic_descriptors")
			: undefined;
	const parsed =
		rawDescriptors === undefined
			? undefined
			: diagnosticDescriptorsSchema.safeParse(rawDescriptors);
	return {
		declaresObservation: protocolCapabilities.includes(OBSERVATION_CAPABILITY),
		descriptors: parsed?.success ? parsed.data : undefined,
		invalidDescriptors: parsed !== undefined && !parsed.success,
		protocolCapabilities,
	};
}

/** One-line rendering of a fact for live output and diagnosis listings. */
export function describeFact(fact: RunRecordFact): string {
	const step = fact.step ? ` at step ${fact.step}` : "";
	switch (fact.fact) {
		case "element_expectation":
			return `element_expectation${step}: "${fact.attrs.expectation}" was ${fact.attrs.final} at the deadline (states seen: ${fact.attrs.states_seen.join(", ")})`;
		case "wait_expired":
			return `wait_expired${step}: waited ${fact.attrs.budget_ms} ms for "${fact.attrs.awaited}"`;
		case "provider_message":
			return `provider_message${step}: kind ${fact.attrs.kind}${fact.attrs.rule ? ` (rule ${fact.attrs.rule})` : ""}`;
		case "credential_submission":
			return `credential_submission${step}: attempt ${fact.attrs.attempt} ${fact.attrs.outcome}${fact.attrs.rule ? ` under rule ${fact.attrs.rule}` : ""}`;
		case "rule_match":
			return `rule_match${step}: ${fact.attrs.kind} rule ${fact.attrs.rule} matched on ${fact.attrs.handle}`;
		case "connector_defect": {
			const count = fact.attrs.count ? `, ${fact.attrs.count}x` : "";
			const reason = fact.attrs.reason ? ` (${fact.attrs.reason}${count})` : "";
			return `connector_defect: ${fact.attrs.class}${reason}`;
		}
		default:
			return "unrecognized fact";
	}
}
