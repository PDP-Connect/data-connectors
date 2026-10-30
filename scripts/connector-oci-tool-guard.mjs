// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Refuse to build a connector whose code needs something its artifact does
 * not carry.
 *
 * This is a separate module on purpose. The builder's own bytes are an input
 * to every artifact's content hash (SHARED_ARTIFACT_INPUTS in
 * connector-artifact-inputs.mjs), so editing the builder forces a version bump
 * on every publishable connector. This check only decides whether to build; it
 * changes no artifact byte, so changing its policy should not republish the
 * fleet. Keep it out of that input list.
 *
 * Policy:
 * - A binary named by an environment variable ending in _BIN is accepted only
 *   when the manifest declares it under runtime_requirements.external_tools
 *   with detect.executable_env_override equal to that variable and non-empty
 *   name, license, purpose and install_hint. The host runs the detect recipe
 *   before a run and reports a missing tool as not ready.
 * - A tool marked provisioning "bundled" is refused: no tool layer exists.
 * - A module-relative asset that climbs out of the install root is refused:
 *   it does not exist once the entrypoint is flattened into the artifact.
 *
 * Declarations live under runtime_requirements.external_tools. The first
 * version of this check read a top-level profile.external_tools, which no
 * manifest has, so its bundled-tool refusal never fired.
 */
// Entry-point guard only: do not evaluate unknown operands or scan imports.
const MODULE_RELATIVE_URL =
	/new\s+URL\s*\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|[^,;]+?)\s*,\s*import\s*\.\s*meta\s*\.\s*url\b/g;

function assertSafeModuleRelativeAssets(connectorKey, source) {
	for (const match of source.matchAll(MODULE_RELATIVE_URL)) {
		const expression = match[1].trim();
		const quote = expression[0];
		const literal = ['"', "'", '`'].includes(quote) && expression.at(-1) === quote;
		const value = literal ? expression.slice(1, -1) : expression;
		if (!literal || value.includes(quote) || value.includes('\\') || (quote === '`' && value.includes('${'))) {
			throw new Error(`${connectorKey} reads '${value}' relative to its module; unanalyzable asset may escape the install root.`);
		}
		const root = new URL('file:///installed/code/');
		const resolved = new URL(value, new URL('collection-profile.mjs', root));
		// URL resolution normalizes literal and percent-encoded dot segments.
		if (resolved.protocol !== root.protocol || resolved.host !== root.host ||
			!resolved.pathname.startsWith(root.pathname)) {
			throw new Error(`${connectorKey} reads '${value}' relative to its module, which escapes the install root once the entrypoint is flattened.`);
		}
	}
}

export function assertNoUnbundledNativeDependency(connectorKey, profile, connectorDirectory) {
	const externalTools = profile.runtime_requirements?.external_tools ?? [];
	const declaresBundledTools = externalTools.some(
		(tool) => tool.provisioning === "bundled",
	);
	if (declaresBundledTools) {
		throw new Error(
			`${connectorKey} declares a bundled external tool, but the per-platform tool layer is not implemented.`,
		);
	}

	const source = readFileSync(join(connectorDirectory, "index.ts"), "utf8");

	const binaryTokens = new Set(
		[...source.matchAll(/\b([A-Z][A-Z0-9_]*_BIN)\b/g)].map((match) => match[1]),
	);
	for (const token of binaryTokens) {
		const declared = externalTools.some(
			(tool) => tool.detect?.executable_env_override === token &&
				["name", "license", "purpose", "install_hint"].every(
					(field) => typeof tool[field] === "string" && tool[field].trim().length > 0,
				),
		);
		if (!declared) {
			throw new Error(
				`${connectorKey} resolves $${token}; declare runtime_requirements.external_tools[] with ` +
					`detect.executable_env_override equal to "${token}" and non-empty strings name, license, purpose and install_hint.`,
			);
		}
	}

	assertSafeModuleRelativeAssets(connectorKey, source);
}
