// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// This documents declarations in the frozen schema dialect, not every value a
// JSON Schema validator might accept. Definitions live beside the schema wrapper.
export function declaredScopeFields(document) {
	const fields = new Map();
	function visit(node, path, activeRefs = []) {
		assert.ok(node && typeof node === "object" && !Array.isArray(node));
		for (const keyword of [
			"anyOf",
			"allOf",
			"patternProperties",
			"prefixItems",
		]) {
			assert.ok(
				!(keyword in node),
				`Unsupported frozen schema keyword: ${keyword}`,
			);
		}
		if (node.$ref) {
			assert.match(node.$ref, /^#\/\$defs\/[^/]+$/);
			assert.ok(
				!activeRefs.includes(node.$ref),
				`Cyclic frozen schema reference: ${node.$ref}`,
			);
			const definition = document.$defs?.[node.$ref.slice("#/$defs/".length)];
			assert.ok(definition, `Missing frozen schema definition: ${node.$ref}`);
			visit(definition, path, [...activeRefs, node.$ref]);
		}
		if (path && (node.type || (!node.$ref && !node.oneOf))) {
			const types = fields.get(path) ?? new Set();
			for (const type of [node.type ?? "unspecified"].flat()) types.add(type);
			fields.set(path, types);
		}
		for (const name of Object.keys(node.properties ?? {}).sort()) {
			visit(node.properties[name], path ? `${path}.${name}` : name, activeRefs);
		}
		if (node.items) visit(node.items, `${path}[]`, activeRefs);
		if (
			node.additionalProperties &&
			typeof node.additionalProperties === "object"
		) {
			visit(node.additionalProperties, path ? `${path}.*` : "*", activeRefs);
		}
		for (const alternative of node.oneOf ?? [])
			visit(alternative, path, activeRefs);
	}
	visit(document.schema, "");
	return [...fields.keys()]
		.sort()
		.map((path) => ({ path, types: [...fields.get(path)].sort() }));
}

export function renderLegacyScopes(directory = root) {
	const mapping = JSON.parse(
		readFileSync(join(directory, "legacy-shapes.json"), "utf8"),
	);
	const scopes = [...mapping.scopes]
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((scope) => {
			const document = JSON.parse(
				readFileSync(join(directory, scope.schemaPath), "utf8"),
			);
			return {
				...scope,
				anchor: scope.id.replaceAll(".", "-").toLowerCase(),
				fields: declaredScopeFields(document),
			};
		});
	const lines = [
		"# Frozen scope shapes",
		"",
		"Generated from [legacy-shapes.json](legacy-shapes.json) and its schema files. Do not edit; run `npm run legacy-shapes:generate`.",
		"",
		"Paths start at each document's payload (`schema`), not its metadata. `[]` marks an array element, including at the payload root; `.*` marks a dynamic object key with a declared value schema. Local `$defs` references are expanded at their use sites.",
		"",
		"Types list declared alternatives. Paths can be optional or belong to only one alternative. `unspecified` means no type is declared. Other properties may be allowed; these tables list declarations, not every possible field. The linked schemas define requiredness and validation.",
		"",
		"| Scope ID | Schema | Declared paths |",
		"| --- | --- | ---: |",
		...scopes.map(
			(scope) =>
				`| [${scope.id}](#${scope.anchor}) | [schema](${scope.schemaPath}) | ${scope.fields.length} |`,
		),
		"",
	];
	for (const scope of scopes) {
		lines.push(
			`<a id="${scope.anchor}"></a>`,
			`## ${scope.id}`,
			"",
			"<details>",
			`<summary>${scope.fields.length} declared paths</summary>`,
			"",
			"| Path | Declared type |",
			"| --- | --- |",
			...scope.fields.map(
				(field) =>
					`| \`${field.path}\` | ${field.types.map((type) => `\`${type}\``).join(" / ")} |`,
			),
			"",
			"</details>",
			"",
		);
	}
	return lines.join("\n");
}

export function checkLegacyScopes(directory = root) {
	if (
		readFileSync(join(directory, "SCOPES.md"), "utf8") !==
		renderLegacyScopes(directory)
	) {
		throw new Error("SCOPES.md is stale; run npm run legacy-shapes:generate");
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (process.argv.includes("--check")) checkLegacyScopes();
	else writeFileSync(join(root, "SCOPES.md"), renderLegacyScopes());
}
