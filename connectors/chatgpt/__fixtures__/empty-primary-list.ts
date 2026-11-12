// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ChatGptApi } from "../types.ts";

/** Healthy primary source with no rows, for tests that isolate search behavior.
 * Union/failure tests supply both sources directly instead of using this control. */
export function withEmptyPrimaryList(api: ChatGptApi): ChatGptApi {
	return {
		...api,
		fetch: (path, options) =>
			path.startsWith("/conversations?")
				? Promise.resolve({ status: 200, json: { items: [], total: 0 } })
				: api.fetch(path, options),
	};
}
