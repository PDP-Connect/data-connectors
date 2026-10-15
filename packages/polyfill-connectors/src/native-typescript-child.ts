// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
	spawn,
} from "node:child_process";

export function nativeTypeScriptEntrypointArgs(entrypoint: string): string[] {
	return [entrypoint];
}

/** Run a TypeScript entrypoint with Node's type stripping. Using tsx adds
 * Node-only helper references to callbacks that browser APIs serialize. */
export function spawnNativeTypeScriptEntrypoint(
	entrypoint: string,
	options: SpawnOptions,
): ChildProcessWithoutNullStreams {
	return spawn(
		process.execPath,
		nativeTypeScriptEntrypointArgs(entrypoint),
		options,
	) as ChildProcessWithoutNullStreams;
}
