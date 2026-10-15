// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { afterEach, inject } from "vitest";

const ownerName =
	"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
const mode = inject("mode");
const activeMutantId = inject("activeMutant");
const receiptPath = process.env.PILOT_NATIVE_OWNER_RECEIPT;

function fullName(task) {
	const names = [task.name];
	for (let suite = task.suite; suite; suite = suite.suite)
		names.unshift(suite.name);
	return names.join(" ").trim();
}

if (mode === "mutant" && activeMutantId && receiptPath) {
	afterEach(({ task }) => {
		if (
			task.file?.filepath?.endsWith("/incremental-frontier.vitest.ts") &&
			fullName(task) === ownerName
		) {
			const result = task.result;
			appendFileSync(
				receiptPath,
				`${JSON.stringify({
					activeMutantId,
					file: "connectors/groupme/incremental-frontier.vitest.ts",
					name: ownerName,
					state: result?.state ?? "missing",
					errors: (result?.errors ?? []).map(
						({ message, actual, expected, stack }) => ({
							message,
							actual,
							expected,
							stack,
						}),
					),
				})}\n`,
			);
		}
	});
}
