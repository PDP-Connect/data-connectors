// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomInt } from "node:crypto";

/** A record id's bytes, written as 24 hex characters (hashId in parsers.ts). */
const KEY_BYTES = 12;
/** A slot: its stream's tag, 0 while the slot is empty, then the id's bytes. */
const SLOT_BYTES = 1 + KEY_BYTES;
/** The home slot weighs an id as six 16-bit words. */
const KEY_WORDS = KEY_BYTES / 2;
/** The largest prime below 2^26, so a weighted sum stays an exact integer. */
const PRIME = 67_108_859;

/**
 * Record ids remembered for duplicate suppression, per stream, up to a
 * budget the streams in one table share. The ids are held off the
 * JavaScript heap in one buffer of fixed slots, allocated once: held as
 * strings in sets, the heap grows by far more than the ids, enough to near
 * the streaming memory bound.
 *
 * Open addressing with linear probing over twice as many slots as the
 * budget, so the table is at most half full and probe runs stay short. The
 * home slot hashes the id with weights drawn at random per table: ids are
 * published hashes, so with fixed weights an export could be written whose
 * ids crowd one run of slots, and every lookup would walk that run.
 */
export class IdentityTable {
	readonly #budget: number;
	readonly #key = Buffer.alloc(KEY_BYTES);
	readonly #slotCount: number;
	readonly #slots: Buffer;
	readonly #weights: readonly number[];
	#size = 0;

	/** `weights`, one per word of an id, are random unless given, as a test gives them to choose slots. */
	constructor(budget: number, weights?: readonly number[]) {
		this.#budget = budget;
		this.#slotCount = 2 * budget;
		this.#slots = Buffer.alloc(this.#slotCount * SLOT_BYTES);
		this.#weights =
			weights ?? Array.from({ length: KEY_WORDS }, () => randomInt(PRIME));
	}

	/** Whether the stream tagged `tag`, 1 to 255, has remembered `id`. */
	has(tag: number, id: string): boolean {
		return this.#slots[this.#probe(tag, id)] !== 0;
	}

	/** Remember `id` for the stream tagged `tag`; false, with nothing remembered, once the budget is spent. */
	add(tag: number, id: string): boolean {
		const at = this.#probe(tag, id);
		if (this.#slots[at] !== 0) {
			return true;
		}
		if (this.#size >= this.#budget) {
			return false;
		}
		this.#slots[at] = tag;
		this.#key.copy(this.#slots, at + 1);
		this.#size += 1;
		return true;
	}

	/** The offset of the slot holding `id` for `tag`, or of the empty slot where it would go. */
	#probe(tag: number, id: string): number {
		const key = this.#key;
		if (id.length !== 2 * KEY_BYTES || key.write(id, "hex") !== KEY_BYTES) {
			throw new RangeError(`not a record id: ${id}`);
		}
		const sum = this.#weights.reduce(
			(total, weight, word) => total + weight * key.readUInt16LE(2 * word),
			0,
		);
		// Never full, so the walk ends at an empty slot if not at the id.
		let slot = (sum % PRIME) % this.#slotCount;
		for (;;) {
			const at = slot * SLOT_BYTES;
			const held = this.#slots[at];
			if (
				held === 0 ||
				(held === tag &&
					this.#slots.compare(key, 0, KEY_BYTES, at + 1, at + SLOT_BYTES) === 0)
			) {
				return at;
			}
			slot = slot + 1 === this.#slotCount ? 0 : slot + 1;
		}
	}
}
