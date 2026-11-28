// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { applyRequestedTimeRanges } from "./requested-time-range.ts";
import type { ShimPage } from "./runtime.ts";

/** Read optional scope metadata from the host before collection. */
export function readRequestedScopeEntries(page: ShimPage): unknown {
	let read: ShimPage["requestedScopeEntries"];
	try {
		read = page.requestedScopeEntries;
	} catch {
		// Older host proxies throw when an optional member is absent.
		return undefined;
	}
	// A present reader's failure must end the run before collection starts.
	return read?.call(page);
}

/** Apply host ranges by name; never silently broaden unsupported selection. */
export function applyRequestedScopeEntries(
	requested: Map<string, StreamScope>,
	rawEntries: unknown,
	platform: string,
	options: { acceptFullDate?: boolean } = { acceptFullDate: true },
): void {
	applyRequestedTimeRanges(requested, rawEntries, platform, options);
	if (rawEntries === undefined) return;
	for (const raw of rawEntries as Array<string | StreamScope>) {
		if (typeof raw === "string") continue;
		if (raw.resources !== undefined || raw.fields !== undefined) {
			throw new Error("scope_not_supported: PageShim resource/field selection for " + raw.name);
		}
	}
}
