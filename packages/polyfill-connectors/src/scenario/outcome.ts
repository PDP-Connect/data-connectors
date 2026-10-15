// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ScenarioStreamOutcome {
	outcome: "skip_result" | "detail_gap";
	reason_code: string;
	stream: string;
}

export interface ScenarioRunOutcome {
	error_code?: string;
	status: "failed" | "succeeded";
	stream_outcomes: ScenarioStreamOutcome[];
}

/** Extracts only declared outcome codes from protocol messages. Payloads,
 * record keys, and free-form diagnostic messages are deliberately omitted. */
export function summarizeRunOutcome(
	messages: readonly unknown[],
): ScenarioRunOutcome | undefined {
	let done: Record<string, unknown> | undefined;
	const streamOutcomes: ScenarioStreamOutcome[] = [];
	for (const value of messages) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			continue;
		}
		const message = value as Record<string, unknown>;
		const type =
			message.type ??
			(message.kind === "done"
				? "DONE"
				: message.kind === "skip_result"
					? "SKIP_RESULT"
					: message.kind === "detail_gap"
						? "DETAIL_GAP"
						: undefined);
		if (type === "DONE") {
			done = message;
			continue;
		}
		if (
			(type !== "SKIP_RESULT" && type !== "DETAIL_GAP") ||
			typeof message.stream !== "string" ||
			typeof (message.reason ?? message.reason_code) !== "string"
		) {
			continue;
		}
		streamOutcomes.push({
			outcome: type === "SKIP_RESULT" ? "skip_result" : "detail_gap",
			reason_code: (message.reason ?? message.reason_code) as string,
			stream: message.stream,
		});
	}
	if (
		(done?.status !== "failed" && done?.status !== "succeeded") ||
		(done.status === "succeeded" && streamOutcomes.length === 0)
	) {
		return undefined;
	}
	const error = done.error;
	const errorCode =
		typeof done.error_code === "string"
			? done.error_code
			: error !== null && typeof error === "object" && !Array.isArray(error)
				? (error as Record<string, unknown>).code
				: undefined;
	if (streamOutcomes.length === 0 && typeof errorCode !== "string") {
		return undefined;
	}
	return {
		...(typeof errorCode === "string" ? { error_code: errorCode } : {}),
		status: done.status,
		stream_outcomes: streamOutcomes,
	};
}
