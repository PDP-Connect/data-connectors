// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { applyRequestedTimeRanges } from "./requested-time-range.ts";

/** Apply host ranges by name; never silently broaden unsupported selection. */
export function applyRequestedScopeEntries(
	requested: Map<string, StreamScope>,
	rawEntries: unknown,
	platform: string,
): void {
	applyRequestedTimeRanges(requested, rawEntries, platform, { acceptFullDate: true });
	if (rawEntries === undefined) return;
	for (const raw of rawEntries as Array<string | StreamScope>) {
		if (typeof raw === "string") continue;
		if (raw.resources !== undefined || raw.fields !== undefined) {
			throw new Error("scope_not_supported: PageShim resource/field selection for " + raw.name);
		}
	}
}
