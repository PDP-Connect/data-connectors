// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export declare function partitionTests(
	files: readonly string[],
	vitestFiles?: ReadonlySet<string>,
): { nodeTests: string[]; vitestTests: string[] };
export declare function testCommands(
	files: readonly string[],
	concurrency: string,
	vitestFiles?: ReadonlySet<string>,
): { command: string; args: string[]; env?: NodeJS.ProcessEnv }[];
export declare function runTestCommands(
	commands: readonly {
		command: string;
		args: readonly string[];
		env?: NodeJS.ProcessEnv;
	}[],
	env?: NodeJS.ProcessEnv,
): Promise<boolean>;
