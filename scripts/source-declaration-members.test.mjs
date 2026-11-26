// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildSourceDeclaration, serializeSourceDeclaration } from "../packages/connector-installer-core/source-declaration.mjs";
import { sourceDeclarationMembers } from "./source-declaration-members.mjs";

const sourceId = "https://registry.pdpp.dev/sources/alpha";
const member = (connector_key, stream) => ({
	connector_key,
	source: { id: sourceId, display: { name: "Alpha" } },
	streams: [{ name: stream, semantics: "append_only", schema: { type: "object" }, primary_key: ["id"] }],
});

test("excluding a scaffold leaves its shared source declaration unchanged", () => {
	const alpha = member("alpha", "alpha_records");
	const beta = member("beta", "beta_records");
	const loom = member("loom", "loom_records");
	const inventory = [
		{ manifest: "alpha", connectorKey: "alpha", exclusionReason: null },
		{ manifest: "beta", connectorKey: "beta", exclusionReason: null },
		{ manifest: "loom", connectorKey: "loom", exclusionReason: "collects no owner data yet" },
	];

	const members = sourceDeclarationMembers(alpha, inventory, (name) => ({ beta, loom })[name]);
	assert.deepEqual(members.map(({ connector_key }) => connector_key), ["alpha", "beta"]);
	assert.equal(
		serializeSourceDeclaration(buildSourceDeclaration(members)).toString(),
		serializeSourceDeclaration(buildSourceDeclaration([alpha, beta])).toString(),
	);
});
