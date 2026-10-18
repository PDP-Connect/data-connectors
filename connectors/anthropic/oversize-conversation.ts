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
 * A captured string field is decoded as it streams, and its escaped length
 * (see safe-escape.ts) is bounded from below while it is read. Once that bound
 * passes the inline cap the field is known to be over the cap, its text is
 * dropped, and only the fact is kept. A field the scan keeps therefore holds at
 * most the inline cap in units, and every kept field counts in
 * `ScannedConversation.retainedUnits`.
 *
 * `BufferMeter` records the largest amount of text this module held at once:
 * the kept header fields, the field or message being read, and the joined copy
 * built to parse it. Tests use it to prove the bound.
 */

import { messageIdentity, messageOmissionTimestamp } from "./parsers.ts";
import { escapedLengthExceeds, INLINE_TEXT_MAX_UNITS } from "./safe-escape.ts";

/** A syntax failure, carrying only the identity scanned before the failure. */
export class InvalidConversationObjectError extends Error {
	readonly conversationId: string | null;

	constructor(conversationId: string | null) {
		super("invalid conversation object while scanning");
		this.name = "InvalidConversationObjectError";
		this.conversationId = conversationId;
	}
}

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
	/** Wanted fields whose last value is a string whose escaped text is over
	 * the inline cap. The value is not kept, and never cut to a prefix: a
	 * caller leaves the field absent. */
	overCap: Set<string>;
	/** Units of text held by `fields` (decoded string lengths). */
	retainedUnits: number;
	hasDocs: boolean;
	chatMessages: "array" | "other" | "absent";
	/** Elements of `chat_messages`, objects only, in file order. */
	messageKeys: MessageKey[];
	/** Every `chat_messages` element, objects or not. */
	messageCount: number;
	/** Elements that are not JSON objects. */
	nonObjectMessages: number;
	/** Bounded timestamps for omitted children; null means no usable time. */
	omittedMessageTimes: Array<number | null>;
}

const KEY_MAX_UNITS = 256;

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
/** A scalar that is not a string is a few characters; anything longer is not a
 * boolean the caller wants. */
const PRIMITIVE_MAX_UNITS = 64;
const RAW_CONTROL = /[\u007f-\u009f]/g;
const SIMPLE_ESCAPES = new Map<number, number>([
	[0x22, 0x22],
	[0x5c, 0x5c],
	[0x2f, 0x2f],
	[0x62, 0x08],
	[0x66, 0x0c],
	[0x6e, 0x0a],
	[0x72, 0x0d],
	[0x74, 0x09],
]);

/** Units the codec always escapes (the surrogate and backslash cases depend on
 * context and are left to the exact check). */
function isControlUnit(unit: number): boolean {
	return (
		(unit <= 0x1f && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) ||
		(unit >= 0x7f && unit <= 0x9f)
	);
}

function hexValue(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	return -1;
}

export async function scanConversation(
	chunks: AsyncIterable<string>,
	startOffset: number,
	wanted: ReadonlySet<string>,
	meter: BufferMeter,
	inlineCap: number = INLINE_TEXT_MAX_UNITS,
): Promise<ScannedConversation> {
	const result: ScannedConversation = {
		fields: new Map(),
		overCap: new Set(),
		retainedUnits: 0,
		hasDocs: false,
		chatMessages: "absent",
		messageKeys: [],
		messageCount: 0,
		nonObjectMessages: 0,
		omittedMessageTimes: [],
	};
	const invalid = (): never => {
		const uuid = result.fields.get("uuid");
		const id = result.fields.get("id");
		throw new InvalidConversationObjectError(
			typeof uuid === "string" && uuid.length > 0
				? uuid
				: typeof id === "string" && id.length > 0
					? id
					: null,
		);
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
	let inMessages = false;
	// The string field being decoded: kept text, a lower bound on its escaped
	// length, and the escape state of the JSON string.
	let strParts: string[] = [];
	let strUnits = 0;
	let strLower = 0;
	let strOver = false;
	let strEscape = false;
	let strHexLeft = 0;
	let strHex = 0;
	let strRun = -1;
	// A captured scalar that is not a string.
	let primitiveToken = "";

	// Current `chat_messages` element.
	let elementActive = false;
	let elementKind: number = Kind.Primitive;
	let elementStart = 0;
	let elementParts: string[] = [];
	let elementUnits = 0;

	const note = (extraElementUnits = 0) =>
		meter.note(
			result.retainedUnits + strUnits + elementUnits + extraElementUnits,
		);

	const endElement = (endOffset: number) => {
		// The parts and the joined copy are alive together.
		note(elementUnits);
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
			result.omittedMessageTimes.push(null);
			return;
		}
		if (messageIdentity(item) === null)
			result.omittedMessageTimes.push(messageOmissionTimestamp(item));
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

	const dropField = (name: string) => {
		const kept = result.fields.get(name);
		if (typeof kept === "string") result.retainedUnits -= kept.length;
		result.fields.delete(name);
		result.overCap.delete(name);
	};

	const resetString = () => {
		strParts = [];
		strUnits = 0;
		strLower = 0;
		strOver = false;
		strEscape = false;
		strHexLeft = 0;
		strHex = 0;
		strRun = -1;
	};

	/** Add decoded text to the string field, unless it is already known to be
	 * over the inline cap. */
	const addDecoded = (text: string, controls: number) => {
		if (strOver) return;
		strUnits += text.length;
		strLower += text.length + 5 * controls;
		if (strLower > inlineCap) {
			// Over the cap for certain: keep the fact, not the text.
			strOver = true;
			strParts = [];
			strUnits = 0;
			return;
		}
		strParts.push(text);
	};

	const finishValue = () => {
		if (capture && key !== null) {
			dropField(key);
			if (kind === Kind.String) {
				if (strOver) {
					result.overCap.add(key);
				} else {
					// Both copies are alive while joining.
					note(strUnits);
					const decoded = strParts.join("");
					strParts = [];
					if (escapedLengthExceeds(decoded, inlineCap).exceeds) {
						result.overCap.add(key);
					} else {
						result.fields.set(key, decoded);
						result.retainedUnits += decoded.length;
					}
				}
			} else {
				let value: unknown;
				try {
					value =
						primitiveToken.length > PRIMITIVE_MAX_UNITS
							? undefined
							: JSON.parse(primitiveToken);
				} catch {
					value = undefined;
				}
				if (typeof value === "boolean") result.fields.set(key, value);
			}
		}
		resetString();
		primitiveToken = "";
		capture = false;
		inMessages = false;
		phase = Phase.AfterValue;
	};

	let offset = startOffset;
	for await (const chunk of chunks) {
		// Text kept from this chunk for the active string field or element.
		strRun =
			capture && kind === Kind.String && !strEscape && strHexLeft === 0
				? 0
				: -1;
		let elemStart = elementActive ? 0 : -1;
		let tokenStart = capture && kind === Kind.Primitive ? 0 : -1;
		const flushRun = (end: number) => {
			if (strRun < 0 || strOver) {
				strRun = -1;
				return;
			}
			const part = chunk.slice(strRun, end);
			strRun = -1;
			if (part.length === 0) return;
			addDecoded(part, part.match(RAW_CONTROL)?.length ?? 0);
		};
		const flushToken = (end: number) => {
			if (tokenStart < 0) return;
			if (primitiveToken.length <= PRIMITIVE_MAX_UNITS)
				primitiveToken += chunk.slice(tokenStart, end);
			tokenStart = -1;
		};
		/** One decoded character of a string field's escape sequence. */
		const addUnit = (unit: number) =>
			addDecoded(String.fromCharCode(unit), isControlUnit(unit) ? 1 : 0);
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
					resetString();
					primitiveToken = "";
					if (key === "chat_messages") {
						// Last key wins for EVERY occurrence: whatever an earlier
						// value left is gone before this one is looked at.
						result.messageKeys = [];
						result.messageCount = 0;
						result.nonObjectMessages = 0;
						result.omittedMessageTimes = [];
						result.chatMessages = code === 0x5b ? "array" : "other";
					}
					if (code === 0x22) {
						kind = Kind.String;
						inString = true;
						escaped = false;
						if (capture) strRun = i + 1;
					} else if (code === 0x7b || code === 0x5b) {
						kind = Kind.Container;
						inString = false;
						escaped = false;
						depth = 1;
						inMessages = key === "chat_messages" && code === 0x5b;
						// Only a scalar is captured; a container value leaves the
						// field absent.
						if (capture) {
							capture = false;
							if (key !== null) dropField(key);
						}
					} else {
						kind = Kind.Primitive;
						if (capture) tokenStart = i;
					}
					phase = Phase.Value;
					break;
				}
				case Phase.Value: {
					if (kind === Kind.String) {
						if (!capture) {
							if (escaped) escaped = false;
							else if (code === 0x5c) escaped = true;
							else if (code === 0x22) finishValue();
							break;
						}
						if (strHexLeft > 0) {
							const digit = hexValue(code);
							if (digit < 0) invalid();
							strHex = strHex * 16 + digit;
							strHexLeft -= 1;
							if (strHexLeft === 0) {
								addUnit(strHex);
								strRun = i + 1;
							}
						} else if (strEscape) {
							strEscape = false;
							if (code === 0x75) {
								strHexLeft = 4;
								strHex = 0;
							} else {
								addUnit(SIMPLE_ESCAPES.get(code) ?? invalid());
								strRun = i + 1;
							}
						} else if (code === 0x5c) {
							flushRun(i);
							strEscape = true;
						} else if (code === 0x22) {
							flushRun(i);
							finishValue();
						}
						break;
					}
					if (kind === Kind.Primitive) {
						if (WHITESPACE.has(code) || code === 0x2c || code === 0x7d) {
							flushToken(i);
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
		flushRun(chunk.length);
		flushToken(chunk.length);
		flushElement(chunk.length);
		note();
		offset += chunk.length;
	}
	if (phase !== Phase.Done) invalid();
	return result;
}
