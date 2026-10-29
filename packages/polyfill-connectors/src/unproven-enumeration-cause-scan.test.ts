// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Guard: a connector's unproven-enumeration cause means only that the source
 * answered without proving the end of its list (Collection Profile 5.5). The
 * runtime turns it into a certified stream failure, so an auth, session,
 * navigation, transport or rate-limit failure must not be reported with it.
 * Those go to the connector's own session error or to `reportStreamFailure`.
 *
 * This scan reads every connector's production source and fails when a
 * SKIP_RESULT object literal with a cause reason also carries a string that
 * names one of those failures (for example a `source_reason`). It sees only
 * literals in the same object; computed values are covered by each
 * connector's own tests.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import { connectorsDir as CONNECTORS_DIR } from "./connector-paths.ts";
import { connectorProductionFiles } from "./reason-emission-scan.ts";
import { UNPROVEN_ENUMERATION_CAUSES } from "./unproven-enumeration.ts";

/** Tokens that name a failed read, not an unproven end of a list. */
const READ_FAILURE_TOKEN =
	/auth_failed|session_(?:required|dead|missing|repair_required)|signed_out|rate_limited|navigation_failed|readiness_timeout|http_error|page_unresponsive/u;

type Node = { type: string; loc?: { start: { line: number } } } & Record<
	string,
	unknown
>;

function isNode(value: unknown): value is Node {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function children(node: Node): Node[] {
	const result: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (isNode(item)) result.push(item);
		}
	}
	return result;
}

function stringProperty(object: Node, name: string): string | undefined {
	const properties = (object.properties as Node[] | undefined) ?? [];
	for (const property of properties) {
		if (property.type !== "ObjectProperty") continue;
		const key = property.key as Node;
		const keyName =
			key.type === "Identifier" ? key.name : (key as { value?: unknown }).value;
		const value = property.value as Node;
		if (keyName === name && value.type === "StringLiteral")
			return value.value as string;
	}
	return undefined;
}

function literalStrings(node: Node): string[] {
	if (node.type === "StringLiteral") return [node.value as string];
	if (node.type === "TemplateElement")
		return [(node.value as { cooked?: string }).cooked ?? ""];
	return children(node).flatMap(literalStrings);
}

/** SKIP_RESULT object literals with a cause reason, and any read-failure text. */
function scanSource(
	source: string,
	file: string,
): { sites: string[]; violations: string[] } {
	const ast: unknown = parse(source, {
		sourceType: "module",
		plugins: ["typescript"],
	});
	if (!isNode(ast)) throw new Error(`could not parse ${file}`);
	const sites: string[] = [];
	const violations: string[] = [];
	const visit = (node: Node): void => {
		if (
			node.type === "ObjectExpression" &&
			stringProperty(node, "type") === "SKIP_RESULT"
		) {
			const reason = stringProperty(node, "reason");
			if (reason !== undefined && UNPROVEN_ENUMERATION_CAUSES.has(reason)) {
				const where = `${file}:${node.loc?.start.line ?? 0}`;
				sites.push(where);
				const failures = literalStrings(node).filter((text) =>
					READ_FAILURE_TOKEN.test(text),
				);
				if (failures.length > 0)
					violations.push(`${where} (${failures.join(", ")})`);
			}
		}
		for (const child of children(node)) visit(child);
	};
	visit(ast);
	return { sites, violations };
}

test("no connector reports a failed read with an unproven-enumeration cause", () => {
	const sites: string[] = [];
	const violations: string[] = [];
	for (const connector of readdirSync(CONNECTORS_DIR)) {
		for (const file of connectorProductionFiles(
			join(CONNECTORS_DIR, connector),
		)) {
			const result = scanSource(
				readFileSync(file, "utf8"),
				file.slice(CONNECTORS_DIR.length),
			);
			sites.push(...result.sites);
			violations.push(...result.violations);
		}
	}
	assert.ok(
		sites.length >= 8,
		`the scan found the known cause sites (found ${sites.length})`,
	);
	assert.deepEqual(violations, []);
});

test("the scan flags a cause skip that names a failed read", () => {
	const flagged = scanSource(
		`await emit({ type: "SKIP_RESULT", stream: "notes", reason: "inventory_not_proven_complete",
			message: "query failed", diagnostics: { source_reason: "icloud_auth_failed" } });`,
		"synthetic.ts",
	);
	assert.deepEqual(flagged.violations, ["synthetic.ts:1 (icloud_auth_failed)"]);
	const clean = scanSource(
		`await emit({ type: "SKIP_RESULT", stream: "notes", reason: "inventory_not_proven_complete",
			message: "pagination repeated", diagnostics: { source_reason: "icloud_no_progress" } });
		await emit({ type: "SKIP_RESULT", stream: "x", reason: "session_repair_required",
			message: "sign in", recovery_hint: { action: "refresh_credentials", retryable: false } });`,
		"synthetic.ts",
	);
	assert.deepEqual(clean.violations, []);
	assert.equal(clean.sites.length, 1);
});
