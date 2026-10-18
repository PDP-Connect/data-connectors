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
/**
 * `new URL(<specifier>, import.meta.url)` where the specifier climbs out of the
 * module's directory. Any of the three string quotes, any spacing between the
 * tokens, and a leading `./` are the same read, so all of them are refused. A
 * template literal with an interpolation still starts with the literal `../`,
 * which is enough to know it climbs out.
 */
const MODULE_RELATIVE_ESCAPE =
	/new\s+URL\s*\(\s*(["'`])((?:\.\/)*\.\.\/(?:(?!\1)[^\\]|\\.)*)\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\b/;

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

	const escapingAsset = source.match(MODULE_RELATIVE_ESCAPE);
	if (escapingAsset) {
		throw new Error(
			`${connectorKey} reads '${escapingAsset[2]}' relative to its module, which escapes the install root once the ` +
				"entrypoint is flattened to code/collection-profile.mjs. The bundler must rewrite that specifier first (design §1.3).",
		);
	}
}
