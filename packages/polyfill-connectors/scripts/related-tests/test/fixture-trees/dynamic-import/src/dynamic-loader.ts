// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

function moduleSpecifier(base: string, name: string): string {
	return `${base}/${name}`;
}

export async function loadModule(base: string, name: string): Promise<unknown> {
	return await import(moduleSpecifier(base, name));
}
