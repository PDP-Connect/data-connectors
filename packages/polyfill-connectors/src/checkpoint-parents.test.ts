// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	checkpointParentsOf,
	renderAggregate,
} from "../scripts/consent-time-fields-render.mjs";
import { resolveCheckpointParents } from "./connector-runtime.ts";
import { createStreamIntegrity } from "./stream-integrity.ts";

const manifest = (streams: unknown[]) => ({ streams });

// review b360011 core#1: the generator must fail closed, never drop or keep
// a broken checkpoint relationship.
test("review b360011 core#1: a malformed parent_streams is rejected, not dropped", () => {
	assert.throws(
		() =>
			renderAggregate([
				[
					"demo",
					manifest([
						{ name: "parents" },
						{ name: "details", parent_streams: "parents" },
					]),
				],
			]),
		/parent_streams/,
	);
});

test("review b360011 core#1: a state_stream naming no stream (a typo) is rejected", () => {
	assert.throws(
		() =>
			renderAggregate([
				[
					"demo",
					manifest([
						{ name: "parents" },
						{ name: "details", state_stream: "parnets" },
					]),
				],
			]),
		/parnets/,
	);
});

test("review b360011 core#1: state_stream and parent_streams together are rejected", () => {
	assert.throws(
		() =>
			renderAggregate([
				[
					"demo",
					manifest([
						{ name: "parents" },
						{ name: "other" },
						{
							name: "details",
							state_stream: "other",
							parent_streams: ["parents"],
						},
					]),
				],
			]),
		/state_stream and parent_streams/,
	);
});

test("review b360011 core#1: a connector that ships a manifest but has no parents entry fails closed", () => {
	const tables = { shipped: new Set(["demo"]), parents: {} };
	assert.throws(
		() => resolveCheckpointParents("demo", tables),
		/no checkpoint-parents entry/,
	);
	// An explicit empty entry means "no dependencies".
	assert.deepEqual(
		resolveCheckpointParents("demo", {
			shipped: new Set(["demo"]),
			parents: { demo: {} },
		}),
		{},
	);
	// Config is only for a connector with no shipped manifest.
	assert.throws(
		() =>
			resolveCheckpointParents(
				"demo",
				{ shipped: new Set(["demo"]), parents: { demo: {} } },
				{},
			),
		/shipped manifest/,
	);
	assert.deepEqual(
		resolveCheckpointParents("fixture", tables, { details: ["parents"] }),
		{ details: ["parents"] },
	);
	assert.deepEqual(resolveCheckpointParents("fixture", tables), {});
});

test("review b360011 core#1: generated parents feed the runtime: refuse(child) then STATE(parent) is withheld", () => {
	const parents = checkpointParentsOf(
		manifest([
			{ name: "parents" },
			{ name: "details", state_stream: "parents" },
		]),
	);
	const integrity = createStreamIntegrity({ checkpointParents: parents });
	integrity.refuseRecord("details", "d1", "shape_check_failed");
	const out = integrity.gate({ type: "STATE", stream: "parents", cursor: {} });
	assert.equal(
		out.some((m) => m.type === "STATE"),
		false,
	);
});
