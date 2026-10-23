// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	declaredScopeFields,
	renderLegacyScopes,
} from "./generate-legacy-scopes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mapping = JSON.parse(
	readFileSync(join(root, "legacy-shapes.json"), "utf8"),
);
const document = (id) =>
	JSON.parse(
		readFileSync(
			join(root, mapping.scopes.find((scope) => scope.id === id).schemaPath),
			"utf8",
		),
	);
const fields = (id) =>
	new Map(
		declaredScopeFields(document(id)).map((field) => [field.path, field.types]),
	);

function sandbox(t) {
	const directory = mkdtempSync(join(tmpdir(), "legacy-scopes-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const path of [
		"legacy-shapes.json",
		"scripts/generate-legacy-scopes.mjs",
		...mapping.scopes.map((scope) => scope.schemaPath),
	]) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		cpSync(join(root, path), join(directory, path));
	}
	return directory;
}

function generate(directory, ...args) {
	return spawnSync(
		process.execPath,
		[join(directory, "scripts/generate-legacy-scopes.mjs"), ...args],
		{
			cwd: directory,
			encoding: "utf8",
			timeout: 10_000,
		},
	);
}

test("CLI check rejects a tampered scope document and regeneration repairs it", (t) => {
	const directory = sandbox(t);
	const target = join(directory, "SCOPES.md");
	const generated = generate(directory);
	assert.equal(generated.status, 0, generated.stderr);
	const expected = readFileSync(target, "utf8");
	assert.equal(generate(directory, "--check").status, 0);
	const tampered = expected.replace(
		"orders[].items[].name",
		"orders[].items[].invented",
	);
	assert.notEqual(tampered, expected);
	writeFileSync(target, tampered);
	const stale = generate(directory, "--check");
	assert.equal(stale.status, 1, stale.stderr);
	assert.match(stale.stderr, /SCOPES\.md is stale/);
	assert.equal(
		readFileSync(target, "utf8"),
		tampered,
		"check must not rewrite drift",
	);
	assert.equal(generate(directory).status, 0);
	assert.equal(readFileSync(target, "utf8"), expected);
	assert.equal(generate(directory, "--check").status, 0);
});

test("actual Amazon payload fields include nested order-item arrays, not document metadata", () => {
	assert.equal(
		document("amazon.orders").schema.properties.orders.items.properties.items
			.items.properties.name.type,
		"string",
	);
	assert.deepEqual(fields("amazon.orders").get("orders[].items[].name"), [
		"string",
	]);
	assert.deepEqual(fields("amazon.orders").get("orders[]"), ["object"]);
	assert.equal(fields("amazon.orders").has("schema"), false);
	assert.equal(fields("amazon.orders").has("version"), false);
});

test("actual Claude Code refs expand profile and nested steps from document-root definitions", () => {
	const schema = document("claude_code.trajectories");
	assert.equal(schema.schema.properties.profile.$ref, "#/$defs/profile");
	assert.equal(
		schema.schema.properties.sessions.items.properties.steps.items.$ref,
		"#/$defs/step",
	);
	const actual = fields("claude_code.trajectories");
	assert.deepEqual(actual.get("profile.displayName"), ["null", "string"]);
	assert.deepEqual(actual.get("sessions[].steps[].callId"), ["null", "string"]);
	assert.deepEqual(actual.get("sessions[].steps[].input"), ["unspecified"]);
	assert.equal(actual.has("$defs.step.callId"), false);
	for (const id of [
		"claude_code.prompts",
		"claude_code.sessions",
		"claude_code.usage",
	]) {
		assert.deepEqual(fields(id).get("profile.displayName"), ["null", "string"]);
	}
});

test("actual nutrition maps expose dynamic-key fields and union-specific descendants", () => {
	assert.deepEqual(
		document("wholefoods.nutrition").schema.properties.items
			.additionalProperties.properties.calories.type,
		["number", "null"],
	);
	assert.deepEqual(fields("wholefoods.nutrition").get("items.*.calories"), [
		"null",
		"number",
	]);
	assert.deepEqual(fields("wholefoods.nutrition").get("items.*.protein_g"), [
		"null",
		"number",
	]);
	assert.equal(fields("wholefoods.nutrition").has("items.calories"), false);
	const nutrition = fields("heb.nutrition");
	assert.deepEqual(nutrition.get("items.*.category"), [
		"array",
		"null",
		"string",
	]);
	assert.deepEqual(nutrition.get("items.*.category[]"), ["string"]);
	assert.deepEqual(nutrition.get("items.*.images"), [
		"null",
		"object",
		"string",
	]);
	assert.deepEqual(nutrition.get("items.*.images.thumbnail"), ["string"]);
	assert.deepEqual(fields("claude_code.usage").get("hourCounts.*"), ["number"]);
});

test("actual Steam root arrays retain element paths", () => {
	assert.equal(document("steam.friends").schema.type, "array");
	assert.deepEqual(fields("steam.friends").get("[].steamId"), ["string"]);
	assert.equal(fields("steam.friends").has("steamId"), false);
});

test("all 54 scopes have relative schema links and stable field ordering", (t) => {
	const directory = sandbox(t);
	const expected = renderLegacyScopes(directory);
	const links = [...expected.matchAll(/\[schema\]\(([^)]+)\)/g)].map(
		(match) => match[1],
	);
	assert.deepEqual(
		links.sort(),
		mapping.scopes.map((scope) => scope.schemaPath).sort(),
	);
	assert.equal((expected.match(/^## /gm) ?? []).length, 54);
	assert.equal(
		new Set(
			[...expected.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]),
		).size,
		54,
	);
	for (const match of expected.matchAll(/<a id="([^"]+)"><\/a>/g)) {
		assert.equal(
			match[1],
			match[1].toLowerCase(),
			"GitHub lowercases custom anchors",
		);
	}
	assert.doesNotMatch(expected, /https?:\/\/|artifacts\/|fixtures\//);
	writeFileSync(
		join(directory, "legacy-shapes.json"),
		JSON.stringify({ ...mapping, scopes: [...mapping.scopes].reverse() }),
	);
	const path = mapping.scopes.find(
		(scope) => scope.id === "amazon.orders",
	).schemaPath;
	const schema = document("amazon.orders");
	schema.schema.properties = Object.fromEntries(
		Object.entries(schema.schema.properties).reverse(),
	);
	writeFileSync(join(directory, path), JSON.stringify(schema));
	assert.equal(renderLegacyScopes(directory), expected);
});
