// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { TestEvent } from "node:test/reporters";

export default async function* mockMutationReporter(
	events: AsyncIterable<TestEvent>,
) {
	const passedTests: string[] = [];
	const failedAssertions: string[] = [];
	let problem: string | undefined;
	let importError: string | undefined;
	for await (const event of events) {
		if (event.type === "test:stderr") {
			importError ??= event.data.message.match(
				/\b(?:ERR_)?MODULE_NOT_FOUND\b/,
			)?.[0];
			continue;
		}
		if (event.type === "test:summary" && event.data.file === undefined) {
			yield JSON.stringify({
				success: event.data.success,
				passedTests,
				failedAssertions,
				problem,
			});
			continue;
		}
		if (event.type !== "test:pass" && event.type !== "test:fail") {
			continue;
		}
		const { data } = event;
		if (data.skip || data.todo) {
			continue;
		}
		const suite = "classname" in data ? data.classname : undefined;
		const label =
			typeof suite === "string" ? `${suite} > ${data.name}` : data.name;
		// A scratch copy changes the entry filename, but imported files keep theirs.
		const caseKey =
			data.entryFile && data.file && data.line && data.column
				? JSON.stringify([
						data.file === data.entryFile ? "" : data.file,
						data.line,
						data.column,
						label,
					])
				: undefined;
		if (event.type === "test:pass") {
			if (caseKey && data.details.type === "test") {
				passedTests.push(caseKey);
			}
			continue;
		}

		const { error } = event.data.details;
		const failureType = "failureType" in error ? error.failureType : undefined;
		// A parent only summarizes its failed children, which each have an event.
		if (failureType === "subtestsFailed") {
			continue;
		}
		const cause = error.cause;
		const code =
			cause instanceof Error && "code" in cause ? cause.code : undefined;
		if (
			caseKey &&
			failureType === "testCodeFailure" &&
			cause instanceof Error &&
			cause.name === "AssertionError" &&
			code === "ERR_ASSERTION"
		) {
			failedAssertions.push(caseKey);
		} else if (data.entryFile) {
			const detail = error.message.split("\n", 1)[0]?.slice(0, 160);
			problem ??= `${label}: ${detail || "test failed without an assertion"}`;
		} else {
			problem ??=
				importError ?? "test file failed before reporting test results";
		}
	}
}
