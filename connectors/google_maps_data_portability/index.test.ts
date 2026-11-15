// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type {
	CollectContext,
	EmittedMessage,
	RecordData,
	StartMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	AccessTypeResult,
	ArchiveStateResult,
	InitiateArchiveInput,
	InitiateArchiveResult,
} from "./api.ts";
import { collectGoogleMapsDataPortability } from "./index.ts";

class FakeGoogleDataPortabilityClient {
	readonly calls: Array<{ input?: unknown; method: string }> = [];

	checkAccessType(): Promise<AccessTypeResult> {
		this.calls.push({ method: "checkAccessType" });
		return Promise.resolve({
			oneTimeResources: ["maps.starred_places"],
			timeBasedResources: ["myactivity.maps"],
		});
	}

	initiateArchive(input: InitiateArchiveInput): Promise<InitiateArchiveResult> {
		this.calls.push({ input, method: "initiateArchive" });
		return Promise.resolve({
			accessType: "ACCESS_TYPE_ONE_TIME",
			archiveJobId:
				input.resources[0] === "maps.starred_places"
					? "job-starred"
					: "job-activity",
		});
	}

	getArchiveState(archiveJobId: string): Promise<ArchiveStateResult> {
		this.calls.push({ input: archiveJobId, method: "getArchiveState" });
		return Promise.resolve({
			exportTime: "2026-06-11T00:00:00Z",
			name: `archiveJobs/${archiveJobId}/portabilityArchiveState`,
			startTime: "2026-06-10T00:00:00Z",
			state: "COMPLETE",
			urls: [`https://storage.example/${archiveJobId}.zip`],
		});
	}
}

function makeContext({
	state = {},
	streams = [{ name: "archive_jobs" }],
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	const start: StartMessage = {
		type: "START",
		scope: { streams },
		state,
	};
	return {
		messages,
		records,
		ctx: {
			assist: () => Promise.resolve("asst_test"),
			capture: null,
			completeAssistance: () => Promise.resolve(),
			credentials: {},
			detailGaps: [],
			emit: (msg) => {
				messages.push(msg);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				records.push({ data, stream });
				return Promise.resolve();
			},
			emittedAt: "2026-06-11T00:00:00.000Z",
			progress: (message, extra = {}) => {
				messages.push({ type: "PROGRESS", message, ...extra });
				return Promise.resolve();
			},
			requested: new Map(streams.map((stream) => [stream.name, stream])),
			requestDetailGapPage: () => Promise.resolve([]),
			scope: start.scope,
			sendInteraction: () =>
				Promise.resolve({
					request_id: "int_test",
					status: "cancelled",
					type: "INTERACTION_RESPONSE",
				}),
			state,
		},
	};
}

test("Google Maps Data Portability connector initiates archive jobs for authorized resource groups", async () => {
	const fakeClient = new FakeGoogleDataPortabilityClient();
	const { ctx, messages, records } = makeContext({
		streams: [
			{
				name: "archive_jobs",
				resources: ["maps.starred_places", "myactivity.maps"],
				time_range: {
					since: "2026-06-01T00:00:00Z",
					until: "2026-06-11T00:00:00Z",
				},
			},
		],
	});

	await collectGoogleMapsDataPortability(ctx, {
		clientFactory: () => fakeClient,
		env: {
			GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
			GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS:
				"maps.starred_places,myactivity.maps",
		},
	});

	assert.deepEqual(
		fakeClient.calls.map((call) => call.method),
		["checkAccessType", "initiateArchive", "initiateArchive"],
	);
	const [, firstInitiate] = fakeClient.calls;
	assert.ok(firstInitiate);
	assert.deepEqual(firstInitiate.input, {
		endTime: "2026-06-11T00:00:00Z",
		resources: ["maps.starred_places"],
		startTime: "2026-06-01T00:00:00Z",
	});
	assert.equal(records.length, 2);
	const [firstRecord] = records;
	assert.ok(firstRecord);
	assert.equal(firstRecord.stream, "archive_jobs");
	assert.deepEqual(firstRecord.data, {
		access_type: "ACCESS_TYPE_ONE_TIME",
		archive_job_id: "job-starred",
		download_url_count: 0,
		export_time: null,
		id: "maps.starred_places:job-starred",
		resource_group: "maps.starred_places",
		source: "google_data_portability_api",
		start_time: null,
		state: "IN_PROGRESS",
	});
	const coverage = messages.find((msg) => msg.type === "DETAIL_COVERAGE");
	assert.ok(coverage);
	assert.deepEqual(coverage.required_keys, [
		"maps.starred_places",
		"myactivity.maps",
	]);
	assert.deepEqual(coverage.hydrated_keys, [
		"maps.starred_places",
		"myactivity.maps",
	]);
	assert.deepEqual(coverage.optional_skip_keys ?? [], []);
	const state = messages.find((msg) => msg.type === "STATE");
	assert.ok(state);
	assert.equal(state.stream, "archive_jobs");
	const cursor = state.cursor as {
		google_maps_data_portability?: { archive_jobs?: Record<string, unknown> };
	};
	assert.ok(
		cursor.google_maps_data_portability?.archive_jobs?.["maps.starred_places"],
	);
});

test("Google Maps Data Portability connector resumes an in-progress archive instead of initiating a duplicate", async () => {
	const fakeClient = new FakeGoogleDataPortabilityClient();
	const { ctx, records } = makeContext({
		state: {
			google_maps_data_portability: {
				archive_jobs: {
					"maps.starred_places": {
						archive_job_id: "job-existing",
						state: "IN_PROGRESS",
					},
				},
			},
		},
		streams: [{ name: "archive_jobs", resources: ["maps.starred_places"] }],
	});

	await collectGoogleMapsDataPortability(ctx, {
		clientFactory: () => fakeClient,
		env: {
			GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
			GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: "maps.starred_places",
		},
	});

	assert.deepEqual(
		fakeClient.calls.map((call) => call.method),
		["checkAccessType", "getArchiveState"],
	);
	const [firstRecord] = records;
	assert.ok(firstRecord);
	assert.equal(firstRecord.data.archive_job_id, "job-existing");
});

test("Google Maps Data Portability leaves unauthorized resource groups unaccounted", async () => {
	const fakeClient = new FakeGoogleDataPortabilityClient();
	const { ctx, messages, records } = makeContext({
		streams: [
			{
				name: "archive_jobs",
				resources: ["maps.starred_places", "maps.photos_videos"],
			},
		],
	});

	await collectGoogleMapsDataPortability(ctx, {
		clientFactory: () => fakeClient,
		env: {
			GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
			GOOGLE_DATAPORTABILITY_AUTHORIZED_RESOURCE_GROUPS: "maps.starred_places",
		},
	});

	assert.equal(records.length, 1);
	const coverage = messages.find((msg) => msg.type === "DETAIL_COVERAGE");
	assert.ok(coverage);
	assert.deepEqual(coverage.required_keys, [
		"maps.starred_places",
		"maps.photos_videos",
	]);
	assert.deepEqual(coverage.hydrated_keys, ["maps.starred_places"]);
	assert.deepEqual(coverage.optional_skip_keys ?? [], []);
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
});

test("Google Maps Data Portability reports zero authorized groups without accepting their absence", async () => {
	const fakeClient = new FakeGoogleDataPortabilityClient();
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "archive_jobs", resources: ["maps.photos_videos"] }],
	});

	await assert.rejects(
		collectGoogleMapsDataPortability(ctx, {
			clientFactory: () => fakeClient,
			env: {
				GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "ya29.access",
			},
		}),
		/google_dataportability_no_authorized_resource_groups/,
	);

	assert.equal(records.length, 0);
	const coverage = messages.find((msg) => msg.type === "DETAIL_COVERAGE");
	assert.ok(coverage);
	assert.deepEqual(coverage.required_keys, ["maps.photos_videos"]);
	assert.deepEqual(coverage.hydrated_keys, []);
	assert.deepEqual(coverage.optional_skip_keys ?? [], []);
	assert.equal(coverage.considered, 1);
	assert.equal(coverage.covered, 0);
});

test("checkpoint survives a later resource failure and resumes the first archive", async () => {
	const streams = [
		{
			name: "archive_jobs",
			resources: ["maps.starred_places", "myactivity.maps"],
		},
	];
	const first = makeContext({ streams });
	const fakeClient = new FakeGoogleDataPortabilityClient();
	const initiate = fakeClient.initiateArchive.bind(fakeClient);
	fakeClient.initiateArchive = (input) => {
		if (input.resources[0] === "myactivity.maps") {
			return Promise.reject(
				Object.assign(new Error("synthetic 503"), { status: 503 }),
			);
		}
		return initiate(input);
	};
	const env = {
		GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "synthetic-regression-only",
	};
	await assert.rejects(
		collectGoogleMapsDataPortability(first.ctx, {
			clientFactory: () => fakeClient,
			env,
		}),
		/synthetic 503/,
	);
	const checkpoint = first.messages.find((message) => message.type === "STATE");
	assert.ok(checkpoint && checkpoint.type === "STATE");
	const saved = checkpoint.cursor as {
		google_maps_data_portability: {
			archive_jobs: Record<string, { archive_job_id: string }>;
		};
	};
	assert.equal(
		saved.google_maps_data_portability.archive_jobs["maps.starred_places"]
			?.archive_job_id,
		"job-starred",
	);
	assert.equal(
		saved.google_maps_data_portability.archive_jobs["myactivity.maps"],
		undefined,
	);
	assert.equal(first.records.length, 1);

	const resumed = makeContext({ streams, state: structuredClone(saved) });
	const nextClient = new FakeGoogleDataPortabilityClient();
	await collectGoogleMapsDataPortability(resumed.ctx, {
		clientFactory: () => nextClient,
		env,
	});
	assert.deepEqual(
		nextClient.calls
			.filter((call) => call.method === "getArchiveState")
			.map((call) => call.input),
		["job-starred"],
	);
	assert.deepEqual(
		nextClient.calls
			.filter((call) => call.method === "initiateArchive")
			.map((call) => call.input),
		[{ resources: ["myactivity.maps"] }],
	);
	const states = resumed.messages.filter((message) => message.type === "STATE");
	assert.ok(states.length >= 2);
	const last = states.at(-1);
	assert.ok(last && last.type === "STATE");
	const final = last.cursor as typeof saved;
	assert.equal(
		final.google_maps_data_portability.archive_jobs["maps.starred_places"]
			?.archive_job_id,
		"job-starred",
	);
	assert.equal(
		final.google_maps_data_portability.archive_jobs["myactivity.maps"]
			?.archive_job_id,
		"job-activity",
	);
	// Earlier emitted snapshots must not be mutated by later resource progress.
	const firstResumed = states[0];
	assert.ok(firstResumed && firstResumed.type === "STATE");
	const earlier = firstResumed.cursor as typeof saved;
	assert.equal(
		earlier.google_maps_data_portability.archive_jobs["myactivity.maps"],
		undefined,
	);
});

test("replacement archive does not inherit the previous archive timestamps", async () => {
	const { ctx, records, messages } = makeContext({
		streams: [{ name: "archive_jobs", resources: ["maps.starred_places"] }],
		state: {
			google_maps_data_portability: {
				archive_jobs: {
					"maps.starred_places": {
						archive_job_id: "job-old",
						state: "COMPLETE",
						start_time: "2026-01-01T00:00:00Z",
						export_time: "2026-01-02T00:00:00Z",
					},
				},
			},
		},
	});
	const fakeClient = new FakeGoogleDataPortabilityClient();
	await collectGoogleMapsDataPortability(ctx, {
		clientFactory: () => fakeClient,
		env: { GOOGLE_DATAPORTABILITY_ACCESS_TOKEN: "synthetic-regression-only" },
	});
	assert.equal(records.length, 1);
	const record = records[0]?.data;
	assert.ok(record);
	assert.equal(record.archive_job_id, "job-starred");
	assert.equal(record.state, "IN_PROGRESS");
	assert.equal(record.start_time, null);
	assert.equal(record.export_time, null);
	const state = messages.find((message) => message.type === "STATE");
	assert.ok(state && state.type === "STATE");
	const cursor = state.cursor as {
		google_maps_data_portability: {
			archive_jobs: Record<string, Record<string, unknown>>;
		};
	};
	const job =
		cursor.google_maps_data_portability.archive_jobs["maps.starred_places"];
	assert.ok(job);
	assert.equal(job.archive_job_id, "job-starred");
	assert.equal(job.start_time, null);
	assert.equal(job.export_time, null);
	assert.deepEqual(
		fakeClient.calls.map((call) => call.method),
		["checkAccessType", "initiateArchive"],
	);
});
