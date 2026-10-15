// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Incremental reader for one conversation object too large to buffer.
 *
 * The object is read as a stream of text chunks. A single tokenizer pass
 * collects, wherever they appear in the object:
 *   - the top-level identity and selection fields (`uuid`, `id`, `name`,
 *     `created_at`, `updated_at`, ...), and
 *   - one lightweight key per `chat_messages` element: its text offsets and
 *     sort time. The message text itself is not kept.
 * The caller then rereads each message by offset, in sorted order, so the
 * working set is one message plus the small key list, whatever the parent's
 * size.
 *
 * `BufferMeter` records the largest text this module held at once. Tests use
 * it to prove the bound.
 */

export class BufferMeter {
	peakUnits = 0;
	note(units: number): void {
		if (units > this.peakUnits) this.peakUnits = units;
	}
}

export interface MessageKey {
	/** Position among all `chat_messages` elements. */
	index: number;
	start: number;
	end: number;
	sortTime: number;
}

export interface ScannedConversation {
	/** Last string or boolean value of each wanted top-level field. A field
	 * whose last value is anything else is absent. */
	fields: Map<string, unknown>;
	hasDocs: boolean;
	chatMessages: "array" | "other" | "absent";
	/** Elements of `chat_messages`, objects only, in file order. */
	messageKeys: MessageKey[];
	/** Every `chat_messages` element, objects or not. */
	messageCount: number;
	/** Elements that are not JSON objects. */
	nonObjectMessages: number;
}

/** Raw characters kept of one captured string. A longer value is decoded from
 * its first characters only; every field this reader captures is bounded far
 * below this once parsed. */
export const CAPTURED_STRING_MAX_UNITS = 64 * 1024;
const KEY_MAX_UNITS = 256;

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

/** Decode a captured raw JSON string, cutting an over-long value at a safe
 * boundary (not inside an escape sequence). */
function decodeCapturedString(raw: string, truncated: boolean): unknown {
	let body = raw;
	if (truncated) {
		let cut = body.length;
		for (let i = 1; i < body.length; ) {
			if (body[i] === "\\") {
				const width = body[i + 1] === "u" ? 6 : 2;
				if (i + width > body.length) {
					cut = i;
					break;
				}
				i += width;
			} else i += 1;
		}
		body = `${body.slice(0, cut)}"`;
	}
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

export async function scanConversation(
	chunks: AsyncIterable<string>,
	startOffset: number,
	wanted: ReadonlySet<string>,
	meter: BufferMeter,
): Promise<ScannedConversation> {
	const result: ScannedConversation = {
		fields: new Map(),
		hasDocs: false,
		chatMessages: "absent",
		messageKeys: [],
		messageCount: 0,
		nonObjectMessages: 0,
	};
	const invalid = () => {
		throw new Error("invalid conversation object while scanning");
	};

	// Top-level object phases.
	const Phase = {
		Open: 0,
		KeyStart: 1,
		Key: 2,
		Colon: 3,
		ValueStart: 4,
		Value: 5,
		AfterValue: 6,
		Done: 7,
	} as const;
	let phase: number = Phase.Open;
	let keyRaw = "";
	let keyLong = false;
	let keyEscaped = false;
	let key: string | null = null;

	// Current top-level value.
	const Kind = { String: 0, Primitive: 1, Container: 2 } as const;
	let kind: number = Kind.String;
	let inString = false;
	let escaped = false;
	let depth = 0;
	let capture = false;
	let captureParts: string[] = [];
	let captureUnits = 0;
	let captureTruncated = false;
	let inMessages = false;

	// Current `chat_messages` element.
	let elementActive = false;
	let elementKind: number = Kind.Primitive;
	let elementStart = 0;
	let elementParts: string[] = [];
	let elementUnits = 0;

	const note = () => meter.note(captureUnits + elementUnits);

	const endElement = (endOffset: number) => {
		const text = elementParts.join("");
		elementParts = [];
		elementUnits = 0;
		elementActive = false;
		const index = result.messageCount++;
		let item: unknown;
		try {
			item = JSON.parse(text);
		} catch {
			invalid();
		}
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			result.nonObjectMessages += 1;
			return;
		}
		const createdAt = (item as Record<string, unknown>).created_at;
		result.messageKeys.push({
			index,
			start: elementStart,
			end: endOffset,
			sortTime:
				typeof createdAt === "string" && createdAt.length > 0
					? Date.parse(createdAt) || 0
					: 0,
		});
	};

	const finishValue = () => {
		if (capture && key !== null) {
			const raw = captureParts.join("");
			captureParts = [];
			let value: unknown;
			if (kind === Kind.String) {
				value = decodeCapturedString(raw, captureTruncated);
			} else {
				try {
					value = JSON.parse(raw);
				} catch {
					value = undefined;
				}
			}
			if (typeof value === "string" || typeof value === "boolean")
				result.fields.set(key, value);
			else result.fields.delete(key);
		}
		capture = false;
		captureUnits = 0;
		captureTruncated = false;
		inMessages = false;
		phase = Phase.AfterValue;
	};

	let offset = startOffset;
	for await (const chunk of chunks) {
		// Text kept from this chunk for the active capture or element.
		let capStart = capture ? 0 : -1;
		let elemStart = elementActive ? 0 : -1;
		const flushCapture = (end: number) => {
			if (capStart < 0) return;
			const room = CAPTURED_STRING_MAX_UNITS - captureUnits;
			const part = chunk.slice(capStart, end);
			if (part.length > room) captureTruncated = true;
			const kept = part.slice(0, Math.max(room, 0));
			if (kept) {
				captureParts.push(kept);
				captureUnits += kept.length;
			}
			capStart = -1;
		};
		const flushElement = (end: number) => {
			if (elemStart < 0) return;
			const part = chunk.slice(elemStart, end);
			elementParts.push(part);
			elementUnits += part.length;
			elemStart = -1;
		};

		for (let i = 0; i < chunk.length; i += 1) {
			const code = chunk.charCodeAt(i);
			switch (phase) {
				case Phase.Open:
					if (WHITESPACE.has(code)) break;
					if (code !== 0x7b) invalid();
					phase = Phase.KeyStart;
					break;
				case Phase.KeyStart:
					if (WHITESPACE.has(code)) break;
					if (code === 0x7d) {
						phase = Phase.Done;
						break;
					}
					if (code !== 0x22) invalid();
					keyRaw = "";
					keyLong = false;
					keyEscaped = false;
					phase = Phase.Key;
					break;
				case Phase.Key:
					if (!keyEscaped && code === 0x22) {
						if (keyLong) key = null;
						else {
							try {
								key = JSON.parse(`"${keyRaw}"`) as string;
							} catch {
								key = null;
							}
						}
						phase = Phase.Colon;
						break;
					}
					keyEscaped = !keyEscaped && code === 0x5c;
					if (keyRaw.length < KEY_MAX_UNITS) keyRaw += chunk[i];
					else keyLong = true;
					break;
				case Phase.Colon:
					if (WHITESPACE.has(code)) break;
					if (code !== 0x3a) invalid();
					phase = Phase.ValueStart;
					break;
				case Phase.ValueStart: {
					if (WHITESPACE.has(code)) break;
					if (key === "docs") result.hasDocs = true;
					capture = key !== null && wanted.has(key);
					inMessages = false;
					if (code === 0x22) {
						kind = Kind.String;
						inString = true;
						escaped = false;
					} else if (code === 0x7b || code === 0x5b) {
						kind = Kind.Container;
						inString = false;
						escaped = false;
						depth = 1;
						if (key === "chat_messages") {
							if (code === 0x5b) {
								inMessages = true;
								// A repeated key replaces the earlier array.
								result.chatMessages = "array";
								result.messageKeys = [];
								result.messageCount = 0;
								result.nonObjectMessages = 0;
							} else result.chatMessages = "other";
						}
						// Only a scalar is captured; a container value leaves the
						// field absent.
						if (capture) {
							capture = false;
							if (key !== null) result.fields.delete(key);
						}
					} else {
						kind = Kind.Primitive;
					}
					if (capture) capStart = i;
					phase = Phase.Value;
					break;
				}
				case Phase.Value: {
					if (kind === Kind.String) {
						if (escaped) escaped = false;
						else if (code === 0x5c) escaped = true;
						else if (code === 0x22) {
							flushCapture(i + 1);
							finishValue();
						}
						break;
					}
					if (kind === Kind.Primitive) {
						if (WHITESPACE.has(code) || code === 0x2c || code === 0x7d) {
							flushCapture(i);
							finishValue();
							// The delimiter belongs to the object level.
							i -= 1;
						}
						break;
					}
					// Container value.
					if (inMessages && !inString && depth === 1 && !elementActive) {
						if (WHITESPACE.has(code) || code === 0x2c) break;
						if (code !== 0x5d) {
							elementActive = true;
							elementStart = offset + i;
							elemStart = i;
							elementKind =
								code === 0x22
									? Kind.String
									: code === 0x7b || code === 0x5b
										? Kind.Container
										: Kind.Primitive;
						}
					}
					if (
						inMessages &&
						elementActive &&
						elementKind === Kind.Primitive &&
						depth === 1 &&
						(WHITESPACE.has(code) || code === 0x2c || code === 0x5d)
					) {
						flushElement(i);
						endElement(offset + i);
					}
					if (inString) {
						if (escaped) escaped = false;
						else if (code === 0x5c) escaped = true;
						else if (code === 0x22) {
							inString = false;
							if (inMessages && elementActive && elementKind === Kind.String) {
								flushElement(i + 1);
								endElement(offset + i + 1);
							}
						}
					} else if (code === 0x22) {
						inString = true;
					} else if (code === 0x7b || code === 0x5b) {
						depth += 1;
					} else if (code === 0x7d || code === 0x5d) {
						depth -= 1;
						if (inMessages && elementActive && depth === 1) {
							flushElement(i + 1);
							endElement(offset + i + 1);
						}
						if (depth === 0) finishValue();
					}
					break;
				}
				case Phase.AfterValue:
					if (WHITESPACE.has(code)) break;
					if (code === 0x2c) phase = Phase.KeyStart;
					else if (code === 0x7d) phase = Phase.Done;
					else invalid();
					break;
				case Phase.Done:
					if (!WHITESPACE.has(code)) invalid();
					break;
			}
		}
		flushCapture(chunk.length);
		flushElement(chunk.length);
		note();
		offset += chunk.length;
	}
	if (phase !== Phase.Done) invalid();
	return result;
}
