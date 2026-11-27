// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Bound pending task factories and resolved results, not the inventory itself. */
export const CHATGPT_DETAIL_QUEUE_WINDOW = 64;

/**
 * The detail drain discards runAll's result array. Submit only one bounded
 * window at a time so neither the queue nor Promise.all owns a whole history.
 * Rejection (including cancellation) stops before any later window is created.
 * Shared AdaptiveLane.runAll keeps its result-returning contract for other users.
 */
export async function drainDetailWindows<T>(
	items: readonly T[],
	runWindow: (window: T[]) => Promise<unknown>,
): Promise<void> {
	for (
		let start = 0;
		start < items.length;
		start += CHATGPT_DETAIL_QUEUE_WINDOW
	) {
		await runWindow(items.slice(start, start + CHATGPT_DETAIL_QUEUE_WINDOW));
	}
}
