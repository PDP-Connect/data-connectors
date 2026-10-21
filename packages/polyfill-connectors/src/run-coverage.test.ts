// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { manifestPath } from "./connector-paths.ts";
import { expectedLocalCoverageStoreDescriptors } from "./local-source-inventory.ts";
import { createRunCoverage } from "./run-coverage.ts";

test("run coverage requires an explicit result for every signed store", () => {
	const coverage = createRunCoverage(
		{ sessions: ["projects", "archive"] },
		"unscoped",
	);
	coverage.report("sessions", "projects", "collected");
	assert.equal(coverage.done(), undefined);
	coverage.report("sessions", "archive", "unavailable");
	assert.deepEqual(coverage.done()?.streams[0]?.stores, [
		{ store: "projects", status: "collected" },
		{ store: "archive", status: "unavailable" },
	]);
});

test("run coverage downgrades skips and never accepts an undeclared store", () => {
	const coverage = createRunCoverage({ messages: ["chat_db"] }, "unscoped");
	coverage.report("messages", "chat_db", "collected");
	coverage.skip("messages");
	assert.deepEqual(coverage.done()?.streams[0]?.stores, [
		{ store: "chat_db", status: "partial" },
	]);
	assert.throws(() => coverage.report("messages", "other", "collected"));
});

test("a later success cannot erase an observed partial result", () => {
	const coverage = createRunCoverage({ photos: ["export_dir"] }, "unscoped");
	coverage.report("photos", "export_dir", "partial");
	coverage.report("photos", "export_dir", "collected");
	assert.deepEqual(coverage.done()?.streams[0]?.stores, [
		{ store: "export_dir", status: "partial" },
	]);
});

test("bounded coverage needs explicit enumeration enforcement", () => {
	const coverage = createRunCoverage(
		{ sessions: ["projects"] },
		"since=2026-01-01",
	);
	coverage.report("sessions", "projects", "collected");
	assert.equal(coverage.done()?.streams[0]?.scoped, false);
	coverage.scoped("sessions");
	assert.equal(coverage.done()?.streams[0]?.scoped, true);
});

test("missing, empty, duplicate or unknown inventory cannot produce proof", () => {
	assert.equal(
		createRunCoverage({ sessions: [] }, "unscoped").done(),
		undefined,
	);
	const coverage = createRunCoverage({ sessions: ["projects"] }, "unscoped");
	coverage.report("sessions", "projects", "collected");
	assert.equal(coverage.done(["other"]), undefined);
	assert.equal(coverage.done(["sessions", "sessions"]), undefined);
	assert.throws(() =>
		createRunCoverage({ sessions: ["projects", "projects"] }, "unscoped"),
	);
});

test("negative results cannot be overwritten by a later success", () => {
	for (const status of ["partial", "unavailable", "failed"] as const) {
		const coverage = createRunCoverage({ sessions: ["projects"] }, "unscoped");
		coverage.report("sessions", "projects", status);
		coverage.report("sessions", "projects", "collected");
		assert.equal(coverage.done()?.streams[0]?.stores[0]?.status, status);
	}
});

test("five signed manifests declare unique stores for every stream", () => {
	for (const connector of [
		"claude_code",
		"codex",
		"google_takeout",
		"imessage",
		"apple_photos",
	]) {
		const manifest = JSON.parse(
			readFileSync(manifestPath(connector), "utf8"),
		) as {
			streams: { name: string; coverage_stores: string[] }[];
		};
		for (const stream of manifest.streams) {
			assert.ok(
				stream.coverage_stores.length > 0,
				`${connector}/${stream.name}`,
			);
			assert.equal(
				new Set(stream.coverage_stores).size,
				stream.coverage_stores.length,
			);
			const descriptors = expectedLocalCoverageStoreDescriptors(
				connector,
			)?.filter((item) => item.stream === stream.name);
			if (descriptors) {
				assert.deepEqual(
					stream.coverage_stores,
					descriptors.map((item) => item.store),
				);
			}
		}
	}
});
