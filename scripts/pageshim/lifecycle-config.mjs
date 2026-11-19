// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parse } from "@babel/parser";

const UNSUPPORTED = "PageShim requires one guarded runConnector(config) declaration";

/** Strip type-only wrappers (`x satisfies T`, `x as T`) that do not change the value. */
function unwrapTypeOnly(node) {
	let current = node;
	while (current && (current.type === "TSSatisfiesExpression" || current.type === "TSAsExpression"))
		current = current.expression;
	return current;
}

/** Every call whose callee is the bare identifier `runConnector`, anywhere in the module. */
function countRunConnectorCalls(root) {
	let count = 0;
	const seen = new Set();
	const visit = (value) => {
		if (!value || typeof value !== "object" || seen.has(value)) return;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value.type === "CallExpression" && value.callee?.type === "Identifier" &&
			value.callee.name === "runConnector") count++;
		for (const [key, child] of Object.entries(value))
			if (key !== "loc" && key !== "extra" && key !== "leadingComments" &&
				key !== "trailingComments" && key !== "innerComments") visit(child);
	};
	visit(root);
	return count;
}

/** The one top-level `const name = <expr>` initializer, or undefined when not exactly one. */
function topLevelConstInit(program, name) {
	const inits = [];
	let bindings = 0;
	for (const node of program.body) {
		const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
		if (declaration?.type === "VariableDeclaration") {
			for (const declarator of declaration.declarations) {
				if (declarator.id.type === "Identifier" && declarator.id.name === name) {
					bindings++;
					if (declaration.kind === "const" && declarator.init) inits.push(declarator.init);
				}
			}
		} else if (declaration && "id" in declaration && declaration.id?.name === name) {
			bindings++;
		}
	}
	return bindings === 1 && inits.length === 1 ? inits[0] : undefined;
}

/** Policy keys of an object literal, or throws when any member cannot be resolved. */
function literalPolicyKeys(object) {
	const keys = [];
	for (const member of object.properties) {
		const supported =
			(member.type === "ObjectProperty" || (member.type === "ObjectMethod" && member.kind === "method")) &&
			!member.computed &&
			(member.key.type === "Identifier" || member.key.type === "StringLiteral");
		if (!supported)
			throw new Error("PageShim requires every runConnector configuration member to be a plain named property or method");
		keys.push(member.key.type === "Identifier" ? member.key.name : member.key.value);
	}
	return keys;
}

/**
 * Retain the connector's own protocol policy without starting its Node host.
 * Capture fails closed: the guard, the single runConnector call and its
 * argument must have a shape this function fully resolves (an object literal,
 * or an identifier bound to one top-level const object literal, without
 * spreads or computed members). The policy keys written in source are exported
 * so the runtime can refuse any that resolve to undefined in the bundle.
 */
export function captureLifecycleConfig(source) {
	const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
	const guards = ast.program.body.filter((node) =>
		node.type === "IfStatement" &&
		node.test.type === "CallExpression" &&
		node.test.callee.type === "Identifier" &&
		node.test.callee.name === "isMainModule",
	);
	const guard = guards[0];
	const statement = guard?.consequent.type === "BlockStatement"
		? guard.consequent.body[0] : undefined;
	const call = statement?.type === "ExpressionStatement" ? statement.expression : undefined;
	if (guards.length !== 1 || guard?.alternate || guard?.consequent.type !== "BlockStatement" ||
		guard.consequent.body.length !== 1 ||
		call?.type !== "CallExpression" || call.callee.type !== "Identifier" ||
		call.callee.name !== "runConnector" || call.arguments.length !== 1 ||
		countRunConnectorCalls(ast.program) !== 1) {
		throw new Error(UNSUPPORTED);
	}
	const argument = call.arguments[0];
	if (argument.type === "SpreadElement")
		throw new Error("PageShim requires a single connector configuration");
	const value = unwrapTypeOnly(argument);
	let literal;
	if (value.type === "ObjectExpression") literal = value;
	else if (value.type === "Identifier") {
		const init = unwrapTypeOnly(topLevelConstInit(ast.program, value.name));
		if (init?.type === "ObjectExpression") literal = init;
	}
	if (literal === undefined)
		throw new Error("PageShim requires the runConnector argument to be an object literal or a top-level const object literal");
	const keys = literalPolicyKeys(literal);
	// Replace only the entry guard and call, preserving its config expression,
	// imports and callbacks. No connector policy is copied into the adapter.
	return source.slice(0, guard.test.start) + "true" +
		source.slice(guard.test.end, call.start) +
		"globalThis.__pageshimConnectorConfigKeys = " + JSON.stringify(keys) + ";" +
		"globalThis.__pageshimConnectorConfig = (" + source.slice(argument.start, argument.end) + ")" +
		source.slice(call.end);
}
