// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";

function gateFor(
	resources: string[] | undefined,
	messages: EmittedMessage[],
	isTombstone?: () => boolean,
) {
	return makeEmitRecord({
		requested: new Map([
			["items", { name: "items", ...(resources ? { resources } : {}) }],
		]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-05-03T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone,
		timeRangeFieldFor: () => null,
	});
}

test("emitRecord keys a record by id unless the stream passes a composite key", async () => {
	const messages: EmittedMessage[] = [];
	const gate = gateFor(undefined, messages);
	await gate.emit("items", { id: "x", group: "g" });
	await gate.emit("items", { id: "x", group: "g" }, { key: ["g", "x"] });
	assert.deepEqual(
		messages.map((m) => (m.type === "RECORD" ? m.key : null)),
		["x", ["g", "x"]],
	);
});

test("emitRecord selects a composite-key record by the JSON array a resources entry names", async () => {
	const messages: EmittedMessage[] = [];
	const gate = gateFor([JSON.stringify(["g1", "x"])], messages);
	assert.equal(
		gate.isSelected("items", { id: "x" }, { key: ["g1", "x"] }),
		true,
	);
	assert.equal(
		gate.isSelected("items", { id: "x" }, { key: ["g2", "x"] }),
		false,
	);
	assert.equal(gate.isSelected("items", { id: "x" }), false);
	await gate.emit("items", { id: "x" }, { key: ["g1", "x"] });
	await gate.emit("items", { id: "x" }, { key: ["g2", "x"] });
	assert.equal(messages.length, 1);
});

test("emitRecord writes a tombstone under the composite key", async () => {
	const messages: EmittedMessage[] = [];
	const gate = gateFor(undefined, messages, () => true);
	await gate.emit("items", { id: "x" }, { key: ["g", "x"] });
	assert.deepEqual(messages[0], {
		type: "RECORD",
		stream: "items",
		key: ["g", "x"],
		data: { id: "x" },
		emitted_at: "2026-05-03T00:00:00.000Z",
		op: "delete",
	});
});
