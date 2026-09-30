// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

export const RESULT_CHUNK_MAX_UNITS = 256 * 1024;

/** Disk-backed model of the mobile shell's result:begin/chunk/scope-done/done API. */
export class ResultStreamHarness {
	constructor({
		approvedScopes,
		directory,
		failAt,
		streamingSupported = true,
	}) {
		this.approvedScopes = new Set(approvedScopes);
		this.directory = directory;
		this.failAt = failAt;
		this.streamingSupported = streamingSupported;
		this.files = new Map();
		this.openScope = null;
		this.mode = null;
		this.done = false;
		this.doneValue = null;
		this.donePayload = null;
		this.lastCall = null;
		this.totalCodeUnits = 0;
		this.messageCount = 0;
		this.rejectedMessages = 0;
		this.maxChunkUnits = 0;
	}

	async setData(key, value) {
		this.messageCount++;
		if (this.done) throw new Error("result protocol is already done");
		if (key === "result") {
			if (this.mode === "stream")
				throw new Error("cannot mix result protocols");
			this.mode = "legacy";
			return { accepted: true };
		}
		if (!key.startsWith("result:")) return null;
		if (!this.streamingSupported) {
			throw new Error("result streaming is not supported by this shell build");
		}
		if (this.mode === "legacy") throw new Error("cannot mix result protocols");
		this.mode = "stream";
		this.#failIfRequested(key, value);

		switch (key) {
			case "result:begin":
				return this.#begin(value);
			case "result:chunk":
				return this.#append(value);
			case "result:scope-done":
				return this.#finishScope(value);
			case "result:done":
				return this.#finish(value);
			default:
				throw new Error(`unknown result protocol message: ${key}`);
		}
	}

	scopeFile(scope) {
		const entry = this.files.get(scope);
		if (!entry) throw new Error(`scope has no spool file: ${scope}`);
		return entry.path;
	}

	summary() {
		return {
			mode: this.mode,
			scopeCount: this.files.size,
			totalCodeUnits: this.totalCodeUnits,
			messageCount: this.messageCount,
			rejectedMessages: this.rejectedMessages,
			maxChunkUnits: this.maxChunkUnits,
			completed: this.done,
			donePayload: this.donePayload,
		};
	}

	async dispose() {
		for (const entry of this.files.values()) await entry.handle?.close();
		this.files.clear();
		await rm(this.directory, { recursive: true, force: true });
	}

	async #begin(value) {
		this.#requireFields(value, ["scope"]);
		const { scope } = value;
		if (
			typeof scope !== "string" ||
			scope.length === 0 ||
			!this.approvedScopes.has(scope) ||
			this.openScope !== null ||
			this.files.has(scope)
		) {
			throw new Error("scope is unknown, empty, or already started");
		}
		await mkdir(this.directory, { recursive: true });
		const path = join(this.directory, `scope-${this.files.size}.json`);
		const handle = await open(path, "w");
		const entry = { path, handle, nextSequence: 0, lastChunk: null };
		this.files.set(scope, entry);
		this.openScope = scope;
		return { accepted: true, nextSequence: 0 };
	}

	async #append(value) {
		this.#requireFields(value, ["scope", "sequence", "text"]);
		const { scope, sequence, text } = value;
		const entry = this.files.get(scope);
		if (entry == null || this.openScope !== scope) {
			throw new Error("chunk has no open scope");
		}
		if (
			typeof sequence !== "number" ||
			!Number.isSafeInteger(sequence) ||
			sequence < 0
		) {
			throw new Error("chunk sequence is invalid");
		}
		if (typeof text !== "string" || text.length > RESULT_CHUNK_MAX_UNITS) {
			throw new Error("chunk text is malformed or oversized");
		}
		this.maxChunkUnits = Math.max(this.maxChunkUnits, text.length);
		if (text.length > 0) {
			const first = text.charCodeAt(0);
			const last = text.charCodeAt(text.length - 1);
			if (isLowSurrogate(first) || isHighSurrogate(last)) {
				throw new Error("chunk boundary splits a surrogate pair");
			}
		}
		if (sequence === entry.nextSequence - 1) {
			if (text !== entry.lastChunk) throw new Error("changed chunk retry");
			return { accepted: true, nextSequence: entry.nextSequence };
		}
		if (sequence !== entry.nextSequence) throw new Error("chunk sequence gap");
		await entry.handle.write(text);
		entry.lastChunk = text;
		entry.nextSequence += 1;
		this.totalCodeUnits += text.length;
		this.lastCall = { sequence, text };
		return { accepted: true, nextSequence: entry.nextSequence };
	}

	async #finishScope(value) {
		this.#requireFields(value, ["scope", "chunkCount"]);
		const { scope, chunkCount } = value;
		const entry = this.files.get(scope);
		if (
			entry == null ||
			this.openScope !== scope ||
			!Number.isSafeInteger(chunkCount) ||
			chunkCount !== entry.nextSequence
		) {
			throw new Error("scope ended before all chunks arrived");
		}
		await entry.handle.sync();
		await entry.handle.close();
		entry.handle = null;
		this.openScope = null;
		return { accepted: true };
	}

	#finish(value) {
		this.#requireFields(value, ["scopeCount"]);
		const { scopeCount } = value;
		if (
			this.openScope !== null ||
			!Number.isSafeInteger(scopeCount) ||
			scopeCount <= 0 ||
			scopeCount !== this.files.size
		) {
			throw new Error("result ended before every scope completed");
		}
		this.done = true;
		this.doneValue = value;
		this.donePayload = value;
		return { accepted: true };
	}

	#requireFields(value, keys) {
		if (
			value === null ||
			typeof value !== "object" ||
			Array.isArray(value) ||
			keys.some((key) => !Object.hasOwn(value, key))
		) {
			throw new Error("malformed result protocol message");
		}
	}

	#failIfRequested(key, value) {
		if (
			this.failAt?.key === key &&
			(this.failAt.sequence === undefined ||
				this.failAt.sequence === value?.sequence)
		) {
			this.rejectedMessages++;
			throw new Error("simulated result protocol rejection");
		}
	}
}

const isHighSurrogate = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;
