// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parse } from "@babel/parser";

/** Retain the connector's own protocol policy without starting its Node host. */
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
	if (guards.length !== 1 || guard?.consequent.type !== "BlockStatement" || guard.consequent.body.length !== 1 ||
		call?.type !== "CallExpression" || call.callee.type !== "Identifier" ||
		call.callee.name !== "runConnector" || call.arguments.length !== 1) {
		throw new Error("PageShim requires one guarded runConnector(config) declaration");
	}
	const argument = call.arguments[0];
	if (argument.type === "SpreadElement")
		throw new Error("PageShim requires a single connector configuration");
	// Replace only the entry guard and call, preserving its config expression,
	// imports and callbacks. No connector policy is copied into the adapter.
	return source.slice(0, guard.test.start) + "true" +
		source.slice(guard.test.end, call.start) +
		"globalThis.__pageshimConnectorConfig = (" + source.slice(argument.start, argument.end) + ")" +
		source.slice(call.end);
}
