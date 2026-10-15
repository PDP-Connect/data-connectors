// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which consent-time-field module a built connector artifact bundles.
 *
 * The runtime imports one generated table of every connector's consent fields.
 * Bundled as is, each artifact would carry (and its input hash would cover)
 * every other connector's fields, so one connector's edit would republish all
 * of them. A build instead resolves that exact import to the connector's own
 * slice, `consent-time-fields/<connector directory>.generated.ts`. The slice
 * also names the connector it is bound to, so a runtime `name` that disagrees
 * cannot pass as an unshipped test fixture.
 *
 * The Core builder, the PageShim builder and the artifact input hash all use
 * this file, so what a build bundles and what the hash covers cannot differ.
 * The hash lists this file as an artifact input: changing the resolution rule
 * changes every artifact it applies to.
 *
 * Unbundled use (tests, scenario runs) never goes through a build and keeps
 * the aggregate.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

export const CONSENT_RESOLUTION_MODULE = "scripts/consent-slice-resolution.mjs";
export const CONSENT_AGGREGATE =
	"packages/polyfill-connectors/src/generated/consent-time-fields.generated.ts";
const CONSENT_SLICE_ROOT =
	"packages/polyfill-connectors/src/generated/consent-time-fields";

const DIRECTORY_NAME = /^[a-z0-9][a-z0-9_]*$/;

/** Repo-relative path of the slice for a connector directory name. */
export function consentSlicePath(connectorDirectory) {
	if (!DIRECTORY_NAME.test(connectorDirectory)) {
		throw new Error(
			`cannot resolve a consent-time-field slice for connector directory ${JSON.stringify(connectorDirectory)}`,
		);
	}
	return posix.join(CONSENT_SLICE_ROOT, `${connectorDirectory}.generated.ts`);
}

/**
 * The problem with the slice at `path`, or null when it is current.
 * `expected` is what the generator renders from the manifest today.
 */
export function consentSliceProblem(path, actual, expected) {
	const regenerate =
		"regenerate with `node --experimental-strip-types scripts/generate-consent-time-fields.ts` in packages/polyfill-connectors";
	if (actual === null) {
		return `consent-time-field slice ${path} is missing; ${regenerate}`;
	}
	if (Buffer.from(actual).toString("utf8") !== expected) {
		return `consent-time-field slice ${path} is stale (it differs from what its manifest generates); ${regenerate}`;
	}
	return null;
}

/**
 * esbuild plugin: the exact consent aggregate import resolves to the
 * connector's own slice. `expectedSlice` is the generator's current output for
 * that connector. A missing or stale slice fails the build.
 */
export function consentSlicePlugin({ repoRoot, connectorDirectory, expectedSlice }) {
	const slice = consentSlicePath(connectorDirectory);
	const aggregate = resolve(repoRoot, CONSENT_AGGREGATE);
	return {
		name: "consent-time-field-slice",
		setup(build) {
			build.onResolve({ filter: /consent-time-fields\.generated(\.ts)?$/ }, (args) => {
				if (resolve(args.resolveDir, args.path) !== aggregate) return undefined;
				const file = resolve(repoRoot, slice);
				const problem = consentSliceProblem(
					slice,
					existsSync(file) ? readFileSync(file) : null,
					expectedSlice,
				);
				if (problem) return { errors: [{ text: problem }] };
				return { path: file };
			});
		},
	};
}
