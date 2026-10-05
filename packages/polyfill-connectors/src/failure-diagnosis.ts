// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Failure diagnosis for one run: the cause, the facts behind it, and how the
 * connector's recovery hint may be presented (Collection Profile 0.2.0,
 * Sections 5.10 and 5.11).
 *
 * A pure function of the run summary that `bin/connector-dev.ts` writes, so
 * diagnosis is testable without a browser or a network. `bin/diagnose.ts`
 * prints it; `connector-dev` prints it after a failed run.
 *
 * The rules this module applies, and what it leaves out in this version:
 *
 * - The cause is `unknown` unless an in-scope fact meets a category's
 *   predicate. Elapsed time (`wait_expired`) supports nothing.
 * - Scope: runtime records linked to the terminal event by a runtime handle,
 *   plus the connector facts that `DONE.error.basis` cites. Step boundaries
 *   and two-tier eligibility are not in this version, so nothing else is in
 *   scope. Every fact stays visible either way.
 * - A cause whose basis is only connector facts is worded as the
 *   connector's report. Only runtime records can satisfy a hint predicate.
 * - A recovery hint is presented as an instruction only when its predicate
 *   holds. Otherwise it is shown as the connector's suggestion, together
 *   with the connector's own error text, which is never hidden.
 * - Nothing here retries, prompts, or sends anything anywhere.
 */

import { z } from "zod";
import {
	type DiagnosticDescriptors,
	describeFact,
	OBSERVATION_CAPABILITY,
	type RunRecord,
	type RunRecordFact,
	type RuntimeRunRecordFact,
	runRecordSchema,
} from "./observation.ts";
import type { RunSummaryDone } from "./run-summary.ts";

export const DIAGNOSIS_CLASSIFIER = "fd-classifier@0.2.0";

/** Portable recovery actions (Collection Profile Section 5.5). */
export const PORTABLE_RECOVERY_ACTIONS = [
	"retry_by_runtime",
	"retry_on_connector_upgrade",
	"refresh_credentials",
	"manual_action_required",
	"update_selector",
	"upstream_unblock",
	"not_retriable",
	"unknown",
] as const;
type PortableRecoveryAction = (typeof PORTABLE_RECOVERY_ACTIONS)[number];

/** The categories this version derives, in tie-break order. */
export type CauseCategory =
	| "auth_rejected"
	| "expectation_mismatch"
	| "unknown";
type KnownCategory = Exclude<CauseCategory, "unknown">;
const CATEGORY_ORDER: readonly KnownCategory[] = [
	"auth_rejected",
	"expectation_mismatch",
];

export type Attribution = "connector" | "none" | "runtime";

export interface CauseFinding {
	/** `runtime` when any basis fact is a runtime record; otherwise the cause
	 *  is the connector's account and unlocks nothing. */
	attribution: Exclude<Attribution, "none">;
	/** The cause's basis: ids of the in-scope facts that meet the category's
	 *  predicate. Not `DONE.error.basis`, which is the connector's claim. */
	basis: string[];
	category: KnownCategory;
	step?: string;
}

export type TerminalEvent =
	| { fact: string; kind: "credential_submission" }
	| { kind: "failed_done" }
	| { code: number | null; kind: "process_exit"; signal: string | null };

export type HintVerdict = "connector_suggestion" | "instruction" | "invalid";

export interface HintPresentation {
	action: string;
	/** The connector's `retryable` claim, if it made one. */
	retryable?: boolean;
	verdict: HintVerdict;
	why: string;
}

export interface DiagnosedFact {
	fact: RunRecordFact;
	/** In the failure's diagnosis scope. */
	in_scope: boolean;
	retired: boolean;
}

export interface Diagnosis {
	cause?: {
		attribution: Attribution;
		basis: string[];
		category: CauseCategory;
		step?: string;
	};
	classifier: typeof DIAGNOSIS_CLASSIFIER;
	connector: string;
	/** The connector's own error text, verbatim. Never suppressed. */
	connector_error?: { code?: string; message: string; retryable: boolean };
	contributing: CauseFinding[];
	facts: DiagnosedFact[];
	/** Records the gate itself made. They never satisfy a predicate. */
	gate_records: RuntimeRunRecordFact[];
	hint?: HintPresentation;
	/** Local artifact references the facts point to. Never uploaded. */
	local_evidence: string[];
	outcome: RunSummaryDone["status"];
	/** False for a summary written before run records existed. */
	run_record_present: boolean;
	terminal_event?: TerminalEvent;
	truncated: boolean;
}

export interface DiagnosisInput {
	connector: string;
	done: RunSummaryDone;
	run_record?: RunRecord | undefined;
}

/** The members of a run summary (`pdpp.run-summary/1`) diagnosis reads. */
const diagnosisInputSchema = z.object({
	connector: z.string().min(1),
	done: z.object({
		status: z.enum(["succeeded", "failed", "no_done"]),
		error: z
			.object({
				message: z.string(),
				retryable: z.boolean(),
				code: z.string().optional(),
				recovery_hint: z
					.union([
						z.string(),
						z.object({
							action: z.string(),
							retryable: z.boolean().optional(),
						}),
					])
					.optional(),
				basis: z.array(z.string()).optional(),
			})
			.optional(),
	}),
	run_record: runRecordSchema.optional(),
});

/** Validate a parsed run-summary file. Throws with the first issue. */
export function parseDiagnosisInput(summary: unknown): DiagnosisInput {
	const parsed = diagnosisInputSchema.safeParse(summary);
	if (!parsed.success) {
		const [issue] = parsed.error.issues;
		throw new Error(
			`not a run summary diagnosis can read: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`,
		);
	}
	const { connector, done, run_record: runRecord } = parsed.data;
	const { error } = done;
	return {
		connector,
		done: {
			status: done.status,
			...(error
				? {
						error: {
							message: error.message,
							retryable: error.retryable,
							...(error.code === undefined ? {} : { code: error.code }),
							...(error.recovery_hint === undefined
								? {}
								: {
										recovery_hint:
											typeof error.recovery_hint === "string"
												? error.recovery_hint
												: {
														action: error.recovery_hint.action,
														...(error.recovery_hint.retryable === undefined
															? {}
															: { retryable: error.recovery_hint.retryable }),
													},
									}),
							...(error.basis === undefined ? {} : { basis: error.basis }),
						},
					}
				: {}),
		},
		run_record: runRecord,
	};
}

const keyOf = (fact: RunRecordFact): string => `${fact.source}:${fact.id}`;

// ─── Descriptors ──────────────────────────────────────────────────────────

function stepDeclared(
	step: string | undefined,
	descriptors: DiagnosticDescriptors | undefined,
): boolean {
	return (
		step === undefined ||
		(descriptors?.steps?.some((declared) => declared.id === step) ?? false)
	);
}

function authRuleDeclared(
	rule: string | undefined,
	descriptors: DiagnosticDescriptors | undefined,
): boolean {
	return (
		rule !== undefined &&
		(descriptors?.rules?.some(
			(declared) => declared.id === rule && declared.kind === "auth",
		) ??
			false)
	);
}

/** The category a fact supports (Section 5.10 table), or `undefined`. A
 *  fact naming an undeclared step, expectation or rule supports nothing. */
function categorySupportedBy(
	fact: RunRecordFact,
	descriptors: DiagnosticDescriptors | undefined,
): KnownCategory | undefined {
	if (!stepDeclared(fact.step, descriptors)) {
		return;
	}
	switch (fact.fact) {
		case "credential_submission":
			return fact.attrs.outcome === "rejected" &&
				authRuleDeclared(fact.attrs.rule, descriptors)
				? "auth_rejected"
				: undefined;
		case "rule_match":
			return authRuleDeclared(fact.attrs.rule, descriptors)
				? "auth_rejected"
				: undefined;
		case "provider_message":
			return fact.attrs.kind === "auth_failure" &&
				(fact.attrs.rule === undefined ||
					authRuleDeclared(fact.attrs.rule, descriptors))
				? "auth_rejected"
				: undefined;
		case "element_expectation":
			return fact.attrs.final !== "matched" &&
				(descriptors?.expectations?.some(
					(declared) =>
						declared.id === fact.attrs.expectation &&
						declared.step === fact.step,
				) ??
					false)
				? "expectation_mismatch"
				: undefined;
		default:
			return;
	}
}

// ─── Retirement and scope ─────────────────────────────────────────────────

/**
 * Retired facts (Section 5.10): a connector fact named in a later connector
 * fact's `resolves`; a rejected or unsettled credential submission followed
 * by a succeeded one on the same account, with the rule matches on its
 * handle. A connector message never retires a runtime record.
 */
function retiredKeys(facts: readonly RunRecordFact[]): Set<string> {
	const retired = new Set<string>();
	facts.forEach((fact, index) => {
		const earlier = facts.slice(0, index);
		if (fact.source === "connector") {
			for (const id of fact.resolves ?? []) {
				if (earlier.some((e) => e.source === "connector" && e.id === id)) {
					retired.add(`connector:${id}`);
				}
			}
			return;
		}
		if (
			fact.fact !== "credential_submission" ||
			fact.attrs.outcome !== "succeeded"
		) {
			return;
		}
		const { account } = fact.attrs;
		for (const prior of earlier) {
			if (
				prior.source === "runtime" &&
				prior.fact === "credential_submission" &&
				prior.attrs.account === account &&
				prior.attrs.outcome !== "succeeded"
			) {
				retired.add(keyOf(prior));
				const { attempt } = prior.attrs;
				for (const match of facts) {
					if (match.fact === "rule_match" && match.attrs.handle === attempt) {
						retired.add(keyOf(match));
					}
				}
			}
		}
	});
	return retired;
}

/** Terminal event (Section 5.11 order): an unretired failed or unsettled
 *  credential submission, else the failed `DONE`, else the process exit. */
function terminalEventOf(
	live: readonly RunRecordFact[],
	input: DiagnosisInput,
): TerminalEvent | undefined {
	const submission = live.findLast(
		(fact) =>
			fact.source === "runtime" &&
			fact.fact === "credential_submission" &&
			fact.attrs.outcome !== "succeeded",
	);
	if (submission) {
		return { fact: submission.id, kind: "credential_submission" };
	}
	if (input.done.status === "failed") {
		return { kind: "failed_done" };
	}
	if (input.done.status === "no_done") {
		const exit = input.run_record?.process_exit;
		return {
			code: exit?.code ?? null,
			kind: "process_exit",
			signal: exit?.signal ?? null,
		};
	}
	return;
}

/** Runtime records linked to the terminal event through a runtime handle:
 *  the submission itself and rule matches on its attempt handle. */
function actionEligibleFacts(
	live: readonly RunRecordFact[],
	terminal: TerminalEvent | undefined,
): RunRecordFact[] {
	if (terminal?.kind !== "credential_submission") {
		return [];
	}
	const submission = live.find(
		(fact) => fact.source === "runtime" && fact.id === terminal.fact,
	);
	if (submission?.fact !== "credential_submission") {
		return [];
	}
	const { attempt } = submission.attrs;
	return [
		submission,
		...live.filter(
			(fact) =>
				fact.source === "runtime" &&
				fact.fact === "rule_match" &&
				fact.attrs.handle === attempt,
		),
	];
}

// ─── Cause ────────────────────────────────────────────────────────────────

function findings(
	inScope: readonly RunRecordFact[],
	descriptors: DiagnosticDescriptors | undefined,
): CauseFinding[] {
	const supported = inScope.flatMap((fact) => {
		const category = categorySupportedBy(fact, descriptors);
		return category ? [{ category, fact }] : [];
	});
	// Runtime records outrank connector claims; then category order; then
	// record order (stable sort keeps it).
	supported.sort(
		(a, b) =>
			Number(a.fact.source === "connector") -
				Number(b.fact.source === "connector") ||
			CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
	);
	const byCategory = new Map<KnownCategory, RunRecordFact[]>();
	for (const { category, fact } of supported) {
		byCategory.set(category, [...(byCategory.get(category) ?? []), fact]);
	}
	return [...byCategory].map(([category, facts]) => {
		const step = facts.find((fact) => fact.step)?.step;
		return {
			attribution: facts.some((fact) => fact.source === "runtime")
				? "runtime"
				: "connector",
			basis: facts.map((fact) => fact.id),
			category,
			...(step ? { step } : {}),
		};
	});
}

// ─── Hint gate ────────────────────────────────────────────────────────────

/** What each instruction needs and why this version cannot record it. */
const UNRECORDABLE_EVIDENCE: Readonly<
	Record<
		Exclude<
			PortableRecoveryAction,
			"not_retriable" | "refresh_credentials" | "unknown"
		>,
		string
	>
> = {
	manual_action_required:
		"a runtime rule_match for a challenge or account state, or interaction_unavailable",
	retry_by_runtime:
		"a runtime record of a provider outage, rate limit, interruption or session expiry",
	retry_on_connector_upgrade:
		"a newer catalog version that declares a fix for this failure",
	update_selector:
		"a runtime re-evaluation of the expectation in the runtime-owned browser",
	upstream_unblock:
		"a runtime rule_match for an explicit provider block under a declared rule",
};

function isPortableAction(action: string): action is PortableRecoveryAction {
	return PORTABLE_RECOVERY_ACTIONS.some((known) => known === action);
}

function rawHint(
	done: RunSummaryDone,
): { action: string; retryable?: boolean } | undefined {
	const hint = done.error?.recovery_hint;
	if (hint === undefined) {
		return;
	}
	return typeof hint === "string" ? { action: hint } : hint;
}

function gateHint(
	action: string,
	actionEligible: readonly RunRecordFact[],
	truncated: boolean,
	descriptors: DiagnosticDescriptors | undefined,
): { verdict: HintVerdict; why: string } {
	if (!isPortableAction(action)) {
		return {
			verdict: "invalid",
			why: "not a portable recovery hint (Collection Profile Section 5.5); ignored",
		};
	}
	if (action === "not_retriable" || action === "unknown") {
		return { verdict: "instruction", why: "this hint needs no evidence" };
	}
	if (truncated) {
		return {
			verdict: "connector_suggestion",
			why: "the run record is truncated, and truncated evidence cannot authorize an instruction",
		};
	}
	if (action === "refresh_credentials") {
		const rejected = actionEligible.some(
			(fact) =>
				fact.source === "runtime" &&
				fact.fact === "credential_submission" &&
				fact.attrs.outcome === "rejected" &&
				authRuleDeclared(fact.attrs.rule, descriptors),
		);
		return rejected
			? {
					verdict: "instruction",
					why: "the runtime recorded the provider rejecting its credential submission under a declared auth rule",
				}
			: {
					verdict: "connector_suggestion",
					why: "an instruction needs a runtime credential_submission rejected under a declared auth rule, linked to this failure; there is none",
				};
	}
	return {
		verdict: "connector_suggestion",
		why: `an instruction needs ${UNRECORDABLE_EVIDENCE[action]}, which this profile version does not record`,
	};
}

// ─── Entry point ──────────────────────────────────────────────────────────

function declaresObservation(record: RunRecord | undefined): boolean {
	return (
		record?.protocol_capabilities.includes(OBSERVATION_CAPABILITY) ?? false
	);
}

function hintPresentation(
	input: DiagnosisInput,
	actionEligible: readonly RunRecordFact[],
): { gateRecords: RuntimeRunRecordFact[]; hint?: HintPresentation } {
	const hint = rawHint(input.done);
	if (!hint) {
		return { gateRecords: [] };
	}
	const record = input.run_record;
	const { verdict, why } = gateHint(
		hint.action,
		actionEligible,
		record?.truncated ?? false,
		record?.diagnostic_descriptors,
	);
	// A connector that declares OBSERVATION could have cited evidence; one
	// that does not is never recorded as defective for lacking it.
	const gateRecords: RuntimeRunRecordFact[] =
		verdict === "connector_suggestion" && declaresObservation(record)
			? [
					{
						source: "runtime",
						id: "g1",
						fact: "connector_defect",
						attrs: { class: "hint_unsupported" },
					},
				]
			: [];
	return {
		gateRecords,
		hint: {
			action: hint.action,
			...(hint.retryable === undefined ? {} : { retryable: hint.retryable }),
			verdict,
			why,
		},
	};
}

export function diagnoseRun(input: DiagnosisInput): Diagnosis {
	const record = input.run_record;
	const facts = record?.facts ?? [];
	const descriptors = record?.diagnostic_descriptors;
	const retired = retiredKeys(facts);
	const live = facts.filter((fact) => !retired.has(keyOf(fact)));
	const terminal = terminalEventOf(live, input);
	const actionEligible = actionEligibleFacts(live, terminal);
	// DONE.error.basis (the connector's claim), not the cause's basis.
	const citedByDoneError = new Set(input.done.error?.basis ?? []);
	const inScope =
		terminal === undefined
			? []
			: [
					...actionEligible,
					...live.filter(
						(fact) =>
							fact.source === "connector" && citedByDoneError.has(fact.id),
					),
				];
	const inScopeKeys = new Set(inScope.map(keyOf));
	const [primary, ...contributing] = findings(inScope, descriptors);
	const { gateRecords, hint } = hintPresentation(input, actionEligible);
	const error = input.done.error;

	return {
		classifier: DIAGNOSIS_CLASSIFIER,
		connector: input.connector,
		outcome: input.done.status,
		run_record_present: record !== undefined,
		...(terminal ? { terminal_event: terminal } : {}),
		...(terminal
			? {
					cause: primary
						? {
								attribution: primary.attribution,
								basis: primary.basis,
								category: primary.category,
								...(primary.step ? { step: primary.step } : {}),
							}
						: { attribution: "none", basis: [], category: "unknown" },
				}
			: {}),
		contributing,
		facts: facts.map((fact) => ({
			fact,
			in_scope: inScopeKeys.has(keyOf(fact)),
			retired: retired.has(keyOf(fact)),
		})),
		gate_records: gateRecords,
		...(hint ? { hint } : {}),
		...(error
			? {
					connector_error: {
						message: error.message,
						retryable: error.retryable,
						...(error.code ? { code: error.code } : {}),
					},
				}
			: {}),
		local_evidence: facts.flatMap((fact) =>
			fact.source === "connector" && fact.evidence_ref
				? [fact.evidence_ref]
				: [],
		),
		truncated: record?.truncated ?? false,
	};
}

// ─── Wording (tooling, not normative) ─────────────────────────────────────

const CATEGORY_WORDING: Readonly<Record<KnownCategory, string>> = {
	auth_rejected: "the provider rejected the sign-in",
	expectation_mismatch:
		"the page did not match what the connector expected (this alone does not show that the provider changed)",
};

function describeFinding(finding: CauseFinding): string {
	const wording = CATEGORY_WORDING[finding.category];
	return finding.attribution === "runtime"
		? `The runtime recorded that ${wording}.`
		: `The connector reports that ${wording}. The runtime did not verify this.`;
}

function describeTerminal(terminal: TerminalEvent): string {
	switch (terminal.kind) {
		case "credential_submission":
			return `runtime credential submission ${terminal.fact}`;
		case "failed_done":
			return "failed DONE";
		default:
			return `process exit without DONE (code ${String(terminal.code)}, signal ${String(terminal.signal)})`;
	}
}

function renderCause(diagnosis: Diagnosis): string[] {
	const { cause } = diagnosis;
	if (!cause) {
		return [];
	}
	const lines = [
		`  primary cause: ${cause.category}${cause.step ? ` at step ${cause.step}` : ""}`,
	];
	if (cause.category === "unknown" || cause.attribution === "none") {
		lines.push("    The recorded evidence does not establish a cause.");
	} else {
		lines.push(
			`    ${describeFinding({ attribution: cause.attribution, basis: cause.basis, category: cause.category })}`,
			`    cause basis: ${cause.basis.join(", ")}`,
		);
	}
	lines.push(
		diagnosis.contributing.length === 0
			? "  contributing: none"
			: `  contributing: ${diagnosis.contributing.map((c) => `${c.category} (${c.attribution}; cause basis ${c.basis.join(", ")})`).join("; ")}`,
	);
	return lines;
}

function renderFacts(diagnosis: Diagnosis): string[] {
	if (diagnosis.facts.length === 0) {
		return [
			diagnosis.run_record_present
				? "  facts: none recorded"
				: "  facts: none (this summary predates run records)",
		];
	}
	return [
		`  facts${diagnosis.truncated ? " (record truncated)" : ""}:`,
		...diagnosis.facts.map(({ fact, in_scope, retired }) => {
			const marks = [
				fact.source,
				...(in_scope ? ["in scope"] : []),
				...(retired ? ["retired"] : []),
			].join(", ");
			return `    ${fact.id} [${marks}] ${describeFact(fact)}`;
		}),
	];
}

function renderHint(hint: HintPresentation | undefined): string[] {
	if (!hint) {
		return ["  connector's recovery hint (none)"];
	}
	const claim =
		hint.retryable === undefined
			? ""
			: ` (the connector claims retryable=${String(hint.retryable)})`;
	const shown: Record<HintVerdict, string> = {
		connector_suggestion:
			"shown as the connector's suggestion, not as an instruction",
		instruction: "may be presented as an instruction",
		invalid: "rejected",
	};
	return [
		`  connector's recovery hint (${hint.action})${claim}: ${shown[hint.verdict]}`,
		`    why: ${hint.why}`,
	];
}

/** Owner- and developer-facing lines. Wording is tooling, not normative. */
export function renderDiagnosis(diagnosis: Diagnosis): string[] {
	const lines = [
		`DIAGNOSIS ${diagnosis.connector} (${diagnosis.classifier})`,
		`  outcome: ${diagnosis.outcome}${diagnosis.terminal_event ? ` (terminal event: ${describeTerminal(diagnosis.terminal_event)})` : ""}`,
		...renderCause(diagnosis),
		...renderFacts(diagnosis),
		...renderHint(diagnosis.hint),
	];
	if (diagnosis.gate_records.length > 0) {
		lines.push(
			`  gate records: ${diagnosis.gate_records.map(describeFact).join("; ")}`,
		);
	}
	const error = diagnosis.connector_error;
	lines.push(
		error
			? `  connector's own error text${error.code ? ` (code ${error.code})` : ""}: ${error.message}`
			: "  connector's own error text: none (the connector sent no failed DONE)",
	);
	if (diagnosis.local_evidence.length > 0) {
		lines.push(
			`  local evidence (stays on this device): ${diagnosis.local_evidence.join(", ")}`,
		);
	}
	return lines;
}
