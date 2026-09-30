// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, relative, sep } from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const installRoot = process.cwd();

registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		if (!resolved.url.startsWith("file:")) return resolved;

		const resolvedPath = fileURLToPath(resolved.url);
		const pathFromRoot = relative(installRoot, resolvedPath);
		if (
			pathFromRoot === ".." ||
			pathFromRoot.startsWith(`..${sep}`) ||
			isAbsolute(pathFromRoot)
		) {
			const error = new Error(
				`Cannot find module '${specifier}' outside the installed artifact`,
			);
			error.code = "ERR_MODULE_NOT_FOUND";
			throw error;
		}
		return resolved;
	},
});
