import assert from "node:assert/strict";
import test from "node:test";
import { flattenContributionDays } from "./parsers.ts";

test("only an explicit contribution calendar can prove an empty window", () => {
	assert.throws(
		() => flattenContributionDays(null),
		/github_contribution_calendar_unavailable/,
	);
	assert.throws(
		() => flattenContributionDays(undefined),
		/github_contribution_calendar_unavailable/,
	);
	assert.throws(
		() =>
			flattenContributionDays(
				{} as Parameters<typeof flattenContributionDays>[0],
			),
		/github_contribution_calendar_unavailable/,
	);
	assert.deepEqual(
		flattenContributionDays({ contributionCalendar: { weeks: [] } }),
		[],
	);
});
