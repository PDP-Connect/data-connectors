// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	ConnectorHttpGovernor,
	ConnectorHttpResult,
} from "./connector-http-governor.ts";

/**
 * Run a fetch returning text through the governor. Read each attempt's body
 * once, retaining the status and Retry-After even if the body cannot be read.
 */
export function requestText(
	governor: Pick<ConnectorHttpGovernor, "request">,
	send: () => Promise<Response>,
): Promise<ConnectorHttpResult<string>> {
	return governor.request(
		async (): Promise<ConnectorHttpResult<string>> => {
			const response = await send();
			const retryAfter = response.headers.get("retry-after");
			return {
				status: response.status,
				value: await response.text().catch((): string => ""),
				...(retryAfter === null
					? {}
					: { headers: { "retry-after": retryAfter } }),
			};
		},
		(response) => response,
	);
}
