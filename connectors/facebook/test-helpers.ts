// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Fixture loading shared by this connector's tests. The fixtures are copies of the factory's live-shape samples. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRecord } from "./parsers.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function loadFixture(name: string): JsonRecord {
	return JSON.parse(
		readFileSync(join(here, "__fixtures__", `${name}.json`), "utf8"),
	) as JsonRecord;
}

export const TIMELINE =
	"post-www-graphql-profile-comet-timeline-feed-refetch-query";
export const FRIENDS =
	"post-www-graphql-profile-comet-app-collection-self-friends-list-renderer-pagination-query";
export const ACTIVITY =
	"post-www-graphql-comet-activity-log-stories-list-pagination-query";

/** The timeline fixture's own author; tests treat that person as the viewer. */
export const TIMELINE_VIEWER = "100476";
