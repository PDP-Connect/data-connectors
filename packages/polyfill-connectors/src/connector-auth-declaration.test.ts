// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector whose manifest declares a sign-in pair must also declare an
 * `auth` block on `runConnector`.
 *
 * ## Why this is a test and not a code review note
 *
 * The two declarations look independent but are halves of one contract. The
 * manifest's `credential_capture` block is what lets the OWNER store a
 * credential; the connector's `auth` block is what makes the RUNTIME resolve
 * that credential for this connection and, when it is missing, raise a
 * `credentials` INTERACTION naming exactly which field it needs.
 *
 * With only the manifest half, the runtime resolves `{}`. It never prompts and
 * never says a credential was expected. The connector then falls through to its
 * generic "hand the page to the owner" branch, whose copy describes the PAGE
 * ("sign-in form did not render") rather than the CREDENTIAL — so the owner is
 * told the site broke when the truth is that no stored credential ever reached
 * the run. Nothing fails loudly; the run just bails to manual sign-in within
 * seconds, forever.
 *
 * Four connectors (`amazon`, `chase`, `heb`, `chatgpt`) shipped in exactly that
 * state. Each was individually plausible, which is why a per-connector review
 * did not catch it — the omission is only visible when you compare the two
 * declarations. This test does that comparison for every connector, so the
 * fifth one cannot repeat it.
 *
 * See `src/auto-login/login-credentials.ts` for the credential-naming contract
 * and `scripts/check-no-direct-credential-env.ts` for the sibling gate that
 * bans reaching the same value ambiently through `process.env`.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	connectorsDir as CONNECTORS_DIR,
	manifestPath as MANIFEST_DIR,
} from "./connector-paths.ts";
import { GENERATED_STATIC_SECRET_REGISTRY } from "./generated/static-secret-registry.generated.ts";

/**
 * `GENERATED_STATIC_SECRET_REGISTRY` is keyed by each manifest's own
 * `connector_key` (kebab-case, matching `connector_id` and the OCI
 * repository name — see `scripts/generate-static-secret-registry.ts`).
 * That is not always the same string as the on-disk directory/filename,
 * which stays snake_case (e.g. `apple_contacts` directory, `apple-contacts`
 * connector_key). Resolve the real registry key from the manifest rather
 * than assuming directory name === registry key.
 */
function registryKeyForDirectory(directoryName: string): string {
	const manifestPath = MANIFEST_DIR(directoryName);
	if (!existsSync(manifestPath)) {
		return directoryName;
	}
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			connector_key?: unknown;
		};
		return typeof manifest.connector_key === "string" &&
			manifest.connector_key.trim()
			? manifest.connector_key.trim()
			: directoryName;
	} catch {
		return directoryName;
	}
}

/** Reverse of {@link registryKeyForDirectory}: map every shipped manifest's
 *  `connector_key` back to its on-disk directory name, so a registry entry
 *  keyed by connector_key (e.g. `icloud-notes`) resolves to the real
 *  `connectors/<directory>/index.ts` path (e.g. `connectors/icloud_notes/`)
 *  instead of a directory that happens to share the key's spelling. */
function buildDirectoryByRegistryKey(): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const directoryName of readdirSync(CONNECTORS_DIR)) {
		out.set(registryKeyForDirectory(directoryName), directoryName);
	}
	return out;
}

/**
 * Credential kinds that represent an interactive USERNAME+PASSWORD sign-in.
 * Token/app-password kinds are excluded: they have no sign-in form to drive, so
 * the runtime's `credentials` interaction is not the repair path for them.
 */
const SIGN_IN_PAIR_KIND = "username_password";

/** The `auth: { kind: "env", required: [...] }` names a connector declares. */
function declaredAuthEnvNames(source: string): readonly string[] | null {
	const block =
		/\bauth\s*:\s*\{\s*kind\s*:\s*"env"\s*,\s*required\s*:\s*\[([^\]]*)\]/u.exec(
			source,
		);
	if (!block) {
		return null;
	}
	return [...(block[1] ?? "").matchAll(/"([A-Z][A-Z0-9_]*)"/gu)].map(
		(m) => m[1] ?? "",
	);
}

/**
 * Only the entry-point `runConnector` call matters. A connector that never
 * calls it (a library-shaped directory) is out of scope.
 */
function isRunnableConnector(source: string): boolean {
	return /\brunConnector\s*\(/u.test(source);
}

test("every username/password connector declares an auth block naming its credential fields", () => {
	const missingDeclaration: string[] = [];
	const mismatched: string[] = [];
	const directoryByRegistryKey = buildDirectoryByRegistryKey();

	for (const [connectorKey, descriptor] of Object.entries(
		GENERATED_STATIC_SECRET_REGISTRY,
	)) {
		if (descriptor.credentialKind !== SIGN_IN_PAIR_KIND) {
			continue;
		}
		// An either/or bundle (jellyfin: username+password OR an api key) cannot be
		// expressed as a flat `required` list — declaring one would demand a
		// password from an api-key-only connection. Those connectors resolve from
		// `ctx.credentials` directly and fail with a named error, so they are not
		// exposed to the silent-`{}` defect this test guards.
		if ((descriptor.optionalSecretBundleFields?.length ?? 0) > 0) {
			continue;
		}
		const directoryName =
			directoryByRegistryKey.get(connectorKey) ?? connectorKey;
		const connectorPath = join(CONNECTORS_DIR, directoryName, "index.ts");
		if (!existsSync(connectorPath)) {
			continue;
		}
		const source = readFileSync(connectorPath, "utf8");
		if (!isRunnableConnector(source)) {
			continue;
		}

		const declared = declaredAuthEnvNames(source);
		if (declared === null) {
			missingDeclaration.push(connectorKey);
			continue;
		}

		// The declared names must be the ones the static-secret injection layer
		// actually provides. A declaration naming a variable nothing injects would
		// prompt the owner for a field that can never be satisfied — a different
		// silent failure with the same shape.
		const injected = new Set(
			Object.values(descriptor.secretFieldEnvVars ?? {}).flat(),
		);
		const unknown = declared.filter((name) => !injected.has(name));
		if (unknown.length > 0) {
			mismatched.push(
				`${connectorKey}: declares ${unknown.join(", ")} which nothing injects`,
			);
		}
	}

	assert.deepEqual(
		missingDeclaration,
		[],
		"these connectors capture a username/password but declare no `auth` block, so the runtime resolves {} " +
			"and can never prompt the owner for the missing credential",
	);
	assert.deepEqual(
		mismatched,
		[],
		"declared auth env names must match the static-secret injection mapping",
	);
});

test("the four connectors that shipped without an auth block now declare the right one", () => {
	// Pinned by name because these are the regressions this change fixed. The
	// general test above would catch a re-omission, but naming them keeps the
	// specific defect legible to whoever reads this next.
	const expected: Readonly<Record<string, readonly string[]>> = {
		amazon: ["AMAZON_USERNAME", "AMAZON_PASSWORD"],
		chase: ["CHASE_USERNAME", "CHASE_PASSWORD"],
		chatgpt: ["CHATGPT_USERNAME", "CHATGPT_PASSWORD"],
		heb: ["HEB_USERNAME", "HEB_PASSWORD"],
	};

	for (const [connectorKey, names] of Object.entries(expected)) {
		const source = readFileSync(
			join(CONNECTORS_DIR, connectorKey, "index.ts"),
			"utf8",
		);
		assert.deepEqual(
			declaredAuthEnvNames(source),
			names,
			`${connectorKey} must declare auth: { kind: "env", required: ${JSON.stringify(names)} }`,
		);
	}
});

test("no shipped connector directory is missing from the audit", () => {
	// Guards the audit itself: if a username/password connector existed on disk
	// with no registry row, the loop above would skip it silently and the gate
	// would pass while the defect shipped.
	const unregistered: string[] = [];
	for (const name of readdirSync(CONNECTORS_DIR).sort()) {
		const connectorPath = join(CONNECTORS_DIR, name, "index.ts");
		if (!existsSync(connectorPath)) {
			continue;
		}
		const source = readFileSync(connectorPath, "utf8");
		if (!isRunnableConnector(source)) {
			continue;
		}
		// A connector that declares a username/password auth block but has no
		// registry row means the manifest and the connector disagree.
		const declared = declaredAuthEnvNames(source);
		if (declared === null) {
			continue;
		}
		const descriptor =
			GENERATED_STATIC_SECRET_REGISTRY[registryKeyForDirectory(name)];
		if (!descriptor && declared.some((n) => n.endsWith("_PASSWORD"))) {
			unregistered.push(name);
		}
	}
	assert.deepEqual(
		unregistered,
		[],
		"a connector declaring a password auth block must have a manifest credential_capture row",
	);
});
