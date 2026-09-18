// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Supplemental observations only. This reporter issues no accounting evidence.
import { relative, resolve } from "node:path";

export default async function* diagnostics(source) {
	const root = resolve(process.env.TEST_DIAGNOSTICS_ROOT ?? process.cwd());
	const names = new Map();
	for await (const event of source) {
		const data = event.data ?? {};
		if (event.type === "test:summary") {
			yield `${JSON.stringify({ event: "summary", file: data.file ? relative(root, data.file) : null, counts: data.counts ?? null })}\n`;
			continue;
		}
		if (!["test:start", "test:pass", "test:fail"].includes(event.type))
			continue;
		const file =
			typeof data.file === "string"
				? relative(root, resolve(data.file)).replaceAll("\\", "/")
				: null;
		const nesting = data.nesting ?? 0;
		const scope = names.get(file) ?? [];
		scope[nesting] = data.name;
		scope.length = nesting + 1;
		names.set(file, scope);
		if (event.type === "test:start") continue;
		yield `${JSON.stringify({ event: event.type, file, name: data.name ?? null, full_name: scope.filter(Boolean).join(" > "), nesting, type: data.details?.type ?? null, skip: data.skip ?? false, todo: data.todo ?? false, failure_type: data.details?.error?.failureType ?? null, line: data.line ?? null, column: data.column ?? null })}\n`;
	}
}
