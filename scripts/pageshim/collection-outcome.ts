// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	isConnectorErrorCodeShaped,
	TerminalError,
} from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	isUnprovenEnumerationSkip,
	portableUnprovenEnumerationSkip,
} from "../../packages/polyfill-connectors/src/unproven-enumeration.ts";

type Message = { type: string; [key: string]: unknown };
export type ConnectorError = {
	errorClass: string;
	reason: string;
	disposition: string;
	scope?: string;
	phase: string;
	code?: string;
	recovery_hint?: { action: string; retryable: boolean };
	count?: number;
	samples?: string[];
};

export function inferErrorClass(
	message: string,
	fallback = "runtime_error",
): string {
	const text = message.toLowerCase();
	if (["auth", "login", "credential"].some((word) => text.includes(word)))
		return "auth_failed";
	if (text.includes("timeout") || text.includes("timed out")) return "timeout";
	if (["network", "fetch", "net::"].some((word) => text.includes(word)))
		return "network_error";
	return fallback;
}

function machineFields(
	code: unknown,
	hint: unknown,
): Pick<ConnectorError, "code" | "recovery_hint"> {
	const recovery =
		hint !== null && typeof hint === "object"
			? (hint as Record<string, unknown>)
			: undefined;
	return {
		...(typeof code === "string" && isConnectorErrorCodeShaped(code)
			? { code }
			: {}),
		...(typeof recovery?.action === "string" &&
		isConnectorErrorCodeShaped(recovery.action) &&
		typeof recovery.retryable === "boolean"
			? {
					recovery_hint: {
						action: recovery.action,
						retryable: recovery.retryable,
					},
				}
			: {}),
	};
}

export function fatalCollectionError(
	error: unknown,
	reason: string,
): ConnectorError {
	return {
		errorClass: inferErrorClass(reason),
		reason,
		disposition: "fatal",
		phase: "collect",
		...(error instanceof TerminalError
			? machineFields(
					error.code,
					typeof error.recoveryHint === "string"
						? { action: error.recoveryHint, retryable: error.retryable }
						: error.recoveryHint,
				)
			: {}),
	};
}

function hasUncoveredInventory(value: Record<string, unknown>): boolean {
	const { considered, covered } = value;
	if (
		typeof considered === "number" &&
		Number.isFinite(considered) &&
		typeof covered === "number" &&
		Number.isFinite(covered) &&
		considered >= 0 &&
		covered >= 0 &&
		covered < considered
	)
		return true;
	const hydrated = new Set(
		Array.isArray(value.hydrated_keys) ? value.hydrated_keys : [],
	);
	return (
		(Array.isArray(value.gap_keys) && value.gap_keys.length > 0) ||
		(Array.isArray(value.required_keys) &&
			value.required_keys.some((key) => !hydrated.has(key)))
	);
}

// Receipt storage has a separate budget from record chunks. Reserve room for
// the overflow receipt so even an unbounded variety of codes stays observable.
const RECEIPT_MAX_UNITS = 32 * 1024;
const RECEIPT_MAX_GROUPS = 16;
class ErrorSummaries {
	private groups: ConnectorError[] = [];
	private overflow = new Map<string, ConnectorError>();
	private groupBudget: number;
	constructor(scopes: string[]) {
		// There is at most one overflow summary per declared requested scope.
		const reserved = scopes.map((scope) =>
			this.overflowReceipt(
				scope,
				"\u0000".repeat(128),
				Number.MAX_SAFE_INTEGER,
			),
		);
		this.groupBudget = Math.max(
			0,
			RECEIPT_MAX_UNITS - JSON.stringify(reserved).length - 512,
		);
	}
	private overflowReceipt(
		scope: string,
		sample: string,
		count: number,
	): ConnectorError {
		return {
			errorClass: "partial",
			disposition: "omitted",
			phase: "collect",
			scope,
			code: "additional_collection_errors",
			count,
			samples: [sample.slice(0, 128)],
			reason:
				"Additional collection errors were summarized; requested data remains incomplete.",
		};
	}

	add(error: ConnectorError): void {
		const group = this.groups.find(
			(existing) =>
				existing.scope === error.scope &&
				existing.code === error.code &&
				existing.errorClass === error.errorClass &&
				(error.code !== undefined || existing.reason === error.reason) &&
				existing.recovery_hint?.action === error.recovery_hint?.action &&
				existing.recovery_hint?.retryable === error.recovery_hint?.retryable,
		);
		if (group) {
			group.count = (group.count ?? 1) + 1;
			if (group.reason !== error.reason && (group.samples?.length ?? 0) < 2) {
				const samples = [...(group.samples ?? []), error.reason];
				const candidate = this.groups.map((existing) =>
					existing === group ? { ...group, samples } : existing,
				);
				if (JSON.stringify(candidate).length < this.groupBudget)
					group.samples = samples;
			}
			return;
		}
		if (
			this.groups.length < RECEIPT_MAX_GROUPS &&
			JSON.stringify([...this.groups, error]).length < this.groupBudget
		) {
			this.groups.push(error);
		} else {
			const scope = error.scope ?? "";
			const overflow = this.overflow.get(scope);
			if (overflow) overflow.count = (overflow.count ?? 0) + 1;
			else
				this.overflow.set(scope, this.overflowReceipt(scope, error.reason, 1));
		}
	}

	finish(): ConnectorError[] {
		return [...this.groups, ...this.overflow.values()];
	}
}

type StreamEvidence = {
	stream: string;
	checkpoint?: { cursor: unknown };
	checkpointBlocked: boolean;
	skipped: boolean;
	uncovered: boolean;
	detailGap: boolean;
	hasReceipt: boolean;
};
export type FinalStreamOutcome = {
	stream: string;
	scope: string;
	partial: boolean;
	checkpoint: { cursor: unknown } | undefined;
	emptyFromCheckpoint: boolean;
	confirmedEmptyInventory: boolean;
};

/** Owns coverage and candidate checkpoints for a run. Serializers only consume
 * the finalized outcome; receipt summarization cannot make coverage complete. */
export class CollectionOutcome {
	private prefix: string;
	readonly counts: Record<string, number> = {};
	private streams = new Map<string, StreamEvidence>();
	private receipts: ErrorSummaries;
	constructor(prefix: string, requested: Iterable<string>) {
		this.prefix = prefix;
		for (const stream of requested)
			this.streams.set(stream, {
				stream,
				checkpointBlocked: false,
				skipped: false,
				uncovered: false,
				detailGap: false,
				hasReceipt: false,
			});
		this.receipts = new ErrorSummaries(
			[...this.streams.keys()].map((stream) => `${prefix}${stream}`),
		);
	}
	private stream(name: string): StreamEvidence {
		const evidence = this.streams.get(name);
		if (!evidence) throw new Error(`unrequested collection stream: ${name}`);
		return evidence;
	}
	record(stream: string): void {
		this.stream(stream);
		this.counts[stream] = (this.counts[stream] ?? 0) + 1;
	}
	checkpoint(stream: string, cursor: unknown): void {
		this.stream(stream).checkpoint = { cursor };
	}
	skip(message: Message): void {
		const skip: Message = isUnprovenEnumerationSkip(message)
			? portableUnprovenEnumerationSkip(message)
			: message;
		const stream = this.stream(String(skip.stream));
		stream.skipped = true;
		stream.hasReceipt = true;
		const hint = skip.recovery_hint as
			| { action?: unknown; retryable?: unknown }
			| undefined;
		const deferred =
			String(skip.reason).endsWith("_deferred") &&
			hint?.action === "retry_by_runtime" &&
			hint.retryable === true;
		const diagnostics = skip.diagnostics;
		const uncovered =
			hasUncoveredInventory(skip) ||
			(diagnostics !== null &&
				typeof diagnostics === "object" &&
				hasUncoveredInventory(diagnostics as Record<string, unknown>));
		stream.uncovered ||= uncovered;
		stream.checkpointBlocked ||= !deferred || uncovered;
		const reason = String(skip.message ?? message.reason).slice(0, 4096);
		this.receipts.add({
			errorClass:
				deferred ||
				uncovered ||
				skip.reason === "stream_collection_failed" ||
				/(^|_)(partial|bounded|incomplete|truncated|deferred|unconfirmed)(_|$)/.test(
					String(skip.reason),
				) ||
				/(^|_)(budget_reached|limit_reached|stopped_early)$/.test(
					String(skip.reason),
				)
					? "partial"
					: inferErrorClass(reason),
			reason,
			scope: `${this.prefix}${stream.stream}`,
			phase: "collect",
			disposition: this.counts[stream.stream] ? "degraded" : "omitted",
			// The normalized wire reason owns the public code. The shared translation
			// preserves the collector's original cause in diagnostics.original_reason.
			...machineFields(skip.reason, hint),
		});
	}
	coverage(message: Message): void {
		if (hasUncoveredInventory(message)) {
			const stream = this.stream(String(message.stream));
			stream.uncovered = true;
			stream.checkpointBlocked = true;
		}
	}
	detailGap(stream: string): void {
		const evidence = this.stream(stream);
		evidence.detailGap = true;
		evidence.checkpointBlocked = true;
	}
	finalize(
		boundedStreams: ReadonlySet<string>,
		withheldAtOrAfterUntil: ReadonlySet<string> = new Set(),
	): {
		streams: FinalStreamOutcome[];
		errors: ConnectorError[];
		partial: boolean;
	} {
		const streams = [...this.streams.values()].map((stream) => {
			const partial = stream.skipped || stream.uncovered || stream.detailGap;
			if (partial && !stream.hasReceipt)
				this.receipts.add({
					errorClass: "partial",
					reason: stream.detailGap
						? "PageShim collected a bounded ChatGPT prefix with conversation details pending. PageShim does not persist STATE or DETAIL_GAP recovery state, so another PageShim run starts a new bounded walk instead of resuming this omitted tail."
						: "Detail coverage leaves requested inventory uncollected.",
					disposition: this.counts[stream.stream] ? "degraded" : "omitted",
					scope: `${this.prefix}${stream.stream}`,
					phase: "collect",
				});
			const checkpoint =
				stream.checkpointBlocked || withheldAtOrAfterUntil.has(stream.stream)
					? undefined
					: stream.checkpoint;
			return {
				stream: stream.stream,
				scope: `${this.prefix}${stream.stream}`,
				partial,
				checkpoint,
				emptyFromCheckpoint: checkpoint !== undefined,
				confirmedEmptyInventory:
					checkpoint !== undefined &&
					!partial &&
					!boundedStreams.has(stream.stream),
			};
		});
		const errors = this.receipts.finish().map((error) => ({
			...error,
			disposition:
				error.scope && this.counts[error.scope.slice(this.prefix.length)]
					? "degraded"
					: "omitted",
		}));
		return {
			streams,
			errors,
			partial: streams.some((stream) => stream.partial),
		};
	}
}
