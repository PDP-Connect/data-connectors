// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the production Strava browser collector and protocol record adapter
// against the same synthetic responses as the PageShim harness.

const { collectStravaBrowser } = await import(
	"../../../connectors/strava_browser/index.ts"
);
const { validateRecord } = await import(
	"../../../connectors/strava_browser/schemas.ts"
);
const { makeEmitRecord } = await import(
	"../../../packages/polyfill-connectors/src/connector-runtime.ts"
);
const { makeRecordingEmit } = await import(
	"../../../packages/polyfill-connectors/src/test-harness.ts"
);

export async function desktopScopePayload(resolveFixture) {
	const harness = makeRecordingEmit();
	const scope = { name: "activities" };
	const requested = new Map([[scope.name, scope]]);
	const selector = makeEmitRecord({
		requested,
		emit: harness.emit,
		emittedAt: "2026-01-01T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => ({ field: "start_date_local", format: "date" }),
	});

	let currentUrl = new URL("https://www.strava.com/dashboard");
	const originalFetch = globalThis.fetch;
	const locationDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"location",
	);
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		get: () => currentUrl,
	});
	globalThis.fetch = async (input) => {
		const url = new URL(String(input), currentUrl);
		const fixture = resolveFixture(url.href);
		return new Response(fixture.body, {
			status: fixture.status,
			headers: { "content-type": fixture.contentType },
		});
	};

	const page = {
		goto: async (url) => {
			currentUrl = new URL(url);
			return null;
		},
		evaluate: async (fn, arg) => fn(arg),
	};
	try {
		await collectStravaBrowser(
			{
				page,
				requested,
				state: {},
				emit: harness.emit,
				emitRecord: selector.emit,
			},
			{ pageDelayMs: 0, activityDelayMs: 0, rateLimitDelayMs: 0 },
		);
	} finally {
		globalThis.fetch = originalFetch;
		if (locationDescriptor) {
			Object.defineProperty(globalThis, "location", locationDescriptor);
		} else {
			delete globalThis.location;
		}
	}

	const activities = harness.events
		.filter((event) => event.kind === "message")
		.filter((event) => event.message.type === "RECORD")
		.map((event) => event.message.data);
	return { activities };
}
