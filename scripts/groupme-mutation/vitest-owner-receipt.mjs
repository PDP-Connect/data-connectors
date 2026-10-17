// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Vitest setup file, inert outside Stryker. During a mutant run it records the canary
// owner's result tagged with the mutant Stryker activated, so the runner can join it to
// the same invocation's report.
import { appendFileSync } from "node:fs";
import { afterEach, inject } from "vitest";
import { canary } from "./canary.mjs";

const receiptPath = process.env.GROUPME_MUTATION_RECEIPT;

function fullName(task) {
	const names = [task.name];
	for (let suite = task.suite; suite; suite = suite.suite)
		names.unshift(suite.name);
	return names.join(" ").trim();
}

if (inject("mode") === "mutant" && receiptPath) {
	const activeMutantId = inject("activeMutant");
	afterEach(({ task }) => {
		if (
			task.file?.filepath?.endsWith("/" + canary.owner.file) &&
			fullName(task) === canary.owner.name
		) {
			appendFileSync(
				receiptPath,
				`${JSON.stringify({
					activeMutantId,
					file: canary.owner.file,
					name: canary.owner.name,
					state: task.result?.state ?? "missing",
					errors: (task.result?.errors ?? []).map((error) => ({
						message: error.message,
						actual: String(error.actual),
						expected: String(error.expected),
						stack: error.stack,
					})),
				})}\n`,
			);
		}
	});
}
