// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared pacing primitive for the pending Integration Server client.
 * Wire/authentication handling is intentionally not implemented until its
 * redacted credential schema and authentication response codes are supplied.
 */
export function createRequestPacer({
	now,
	sleep,
}: {
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
}) {
	const sent: number[] = [];
	let tail: Promise<void> = Promise.resolve();
	return {
		run<T>(operation: () => Promise<T>): Promise<T> {
			const result = tail.then(async () => {
				while (true) {
					const at = now();
					if (!Number.isFinite(at)) throw new Error("Invalid pacing clock");
					while (sent.length && sent[0]! <= at - 60_000) sent.shift();
					const recent = sent.filter((time) => time > at - 10_000);
					const shortWait = recent.length >= 5 ? recent[recent.length - 5]! + 10_000 - at : 0;
					const longWait = sent.length >= 20 ? sent[sent.length - 20]! + 60_000 - at : 0;
					const wait = Math.max(shortWait, longWait);
					if (wait > 0) {
						await sleep(wait);
						continue;
					}
					sent.push(at);
					return operation();
				}
			});
			// A failed request still consumes quota, but must not poison the queue.
			tail = result.then(() => undefined, () => undefined);
			return result;
		},
	};
}

/** Retry-After accepts delay seconds or an HTTP date; invalid/missing uses 10s. */
export function retryAfterDelay(value: string | null, now: number): number {
	if (!value || !value.trim()) return 10_000;
	const text = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		const delay = Number(text) * 1000;
		return Number.isFinite(delay) ? delay : 10_000;
	}
	const at = Date.parse(text);
	return Number.isFinite(at) ? Math.max(0, at - now) : 10_000;
}
