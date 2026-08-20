#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wraps `biome check` with one checked-in, exact-path exception list for a
 * class of file biome.jsonc cannot itself exclude.
 *
 * Why this exists instead of a files.includes exclude or an overrides[]
 * entry: Biome 2.5.7 has two independent bugs that make both mechanisms
 * ineffective for this package's biome.jsonc, which extends
 * ultracite/biome/core + ultracite/biome/type-aware:
 *   1. A local config's own top-level `files.includes` REPLACES rather than
 *      merges with an extended config's `files.includes` — a negative-only
 *      local list (this package's actual shape) silently falls back to
 *      "include everything" instead of "everything except these excludes".
 *   2. overrides[] entries targeting `*.js` files specifically (but not
 *      `*.ts` files — the package's many `noAwaitInLoops`/complexity
 *      overrides on .ts paths work fine) are not honored under this same
 *      extends chain — confirmed with a minimal isolated repro (root:true,
 *      no extends: works; extends present: silently ignored, for .js only).
 *
 * TWITTER_ARCHIVE_JS_FIXTURES below are provider-exported strict-JSON
 * payloads wrapped in a `window.YTD... = [...]` assignment (real Twitter
 * archive exports use .js, not .json, for this — not a naming choice this
 * package controls). They are fixture DATA, not authored code: Biome's JS
 * formatter unquoting object keys and reflowing them changes byte shape in
 * a way that breaks archive-stream.test.ts's tokenizer, which depends on
 * the exact quoted-key JSON shape a real export has. `biome check --write`
 * must never touch them; `biome check` (read-only) always flags their
 * format as non-compliant, so this script filters exactly those four
 * diagnostics — nothing else — out of the result.
 *
 * src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts is a
 * different class of exception, same mechanism: it's a documented
 * byte-for-byte copy of pdpp's reference-implementation/runtime/
 * recovery-reason-codes.ts (see that directory's README.md), enforced by
 * .github/scripts/cross-repo-integrity/check-reference-contract-drift.mjs's
 * raw SHA-256 comparison against pdpp's canonical file at the pinned SHA.
 * pdpp formats that file with 2-space indentation, not this package's tabs
 * — reformatting it here would silently break byte-identity with the
 * upstream source on the next `biome check --write .`, which is exactly the
 * drift that motivated this exception. Keep this file out of Biome's write
 * path for as long as the stand-in exists (see its README's "Removal
 * trigger").
 *
 * Re-collapse into biome.jsonc's files.includes/overrides (removing this
 * wrapper) the moment a Biome release fixes either bug above.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIOME_BIN = join(PACKAGE_ROOT, "node_modules", ".bin", "biome");

const TWITTER_ARCHIVE_JS_FIXTURES = new Set([
	"connectors/twitter_archive/__fixtures__/archive-files/data/direct-messages.js",
	"connectors/twitter_archive/__fixtures__/archive-files/data/tweets.js",
	"connectors/twitter_archive/__fixtures__/archive-files/empty/data/tweets.js",
	"connectors/twitter_archive/__fixtures__/archive-files/legacy/data/tweet.js",
]);

const REFERENCE_CONTRACT_STAND_IN_FILES = new Set([
	"src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts",
]);

interface BiomeDiagnostic {
	severity?: string;
	category?: string;
	location?: { path?: string };
}

interface BiomeReport {
	diagnostics: BiomeDiagnostic[];
}

function main(): void {
	let stdout = "";
	try {
		stdout = execFileSync(
			BIOME_BIN,
			["check", "--max-diagnostics=10000", "--reporter=json", "."],
			{
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "inherit"],
			},
		);
	} catch (error) {
		const err = error as { stdout?: string };
		stdout = err.stdout ?? "";
	}

	const report = JSON.parse(stdout) as BiomeReport;
	const allowedFormatExceptions = report.diagnostics.filter(
		(d) =>
			d.category === "format" &&
			d.location?.path &&
			(TWITTER_ARCHIVE_JS_FIXTURES.has(d.location.path) ||
				REFERENCE_CONTRACT_STAND_IN_FILES.has(d.location.path)),
	);
	const remaining = report.diagnostics.filter(
		(d) => !allowedFormatExceptions.includes(d),
	);
	const remainingErrors = remaining.filter((d) => d.severity === "error");

	if (allowedFormatExceptions.length > 0) {
		console.log(
			`[check-biome] ${allowedFormatExceptions.length} format finding(s) in the checked-in Twitter archive .js fixture / reference-contract stand-in exception list — expected, not a failure (see this script's header comment).`,
		);
	}

	if (remainingErrors.length > 0) {
		console.error(
			`[check-biome] ${remainingErrors.length} error(s) outside the exception list:`,
		);
		for (const d of remainingErrors) {
			console.error(`  ${d.location?.path ?? "(unknown)"}: ${d.category}`);
		}
		process.exit(1);
	}

	console.log(
		"[check-biome] pass (all findings outside the exception list are warnings or none)",
	);
}

main();
