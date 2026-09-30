// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// ChatGPT's serialized detail lane uses AsyncLocalStorage to attach pressure
// reports to the active attempt. PageShim replay runs with concurrency one, so
// a stack-restored async context is sufficient for this harness path.
export class AsyncLocalStorage {
	value;

	getStore() {
		return this.value;
	}

	run(value, callback) {
		const previous = this.value;
		this.value = value;
		let result;
		try {
			result = callback();
		} catch (error) {
			this.value = previous;
			throw error;
		}
		return Promise.resolve(result).finally(() => {
			this.value = previous;
		});
	}
}
