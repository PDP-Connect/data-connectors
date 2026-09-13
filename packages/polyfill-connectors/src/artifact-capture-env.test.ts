// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The parent/child working-directory boundary for the artifact-capture env.
 *
 * The env var names promise ABSOLUTE paths, and the child resolves them in its
 * own working directory, which need not match the parent's. So a relative path
 * that the host forwards unchanged names a different file in the child — the
 * outbox and spool the connector opens would not be the ones the runner reads.
 * These tests pin the normalization that keeps that promise.
 */

import assert from "node:assert/strict";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import {
	ARTIFACT_OUTBOX_PATH_ENV,
	ARTIFACT_SPOOL_ROOT_ENV,
	buildArtifactCaptureEnv,
} from "./artifact-capture-env.ts";

test("a relative outbox path is resolved against the host cwd", () => {
	const env = buildArtifactCaptureEnv({
		outboxPath: ".pdpp-data/queue.sqlite",
		sourceInstanceId: "instance-1",
	});
	const outbox = env[ARTIFACT_OUTBOX_PATH_ENV];
	assert.ok(
		outbox && isAbsolute(outbox),
		"the child receives an absolute outbox path",
	);
	assert.equal(outbox, resolve(".pdpp-data/queue.sqlite"));
});

test("the default spool follows the RESOLVED outbox, not the relative one", () => {
	const env = buildArtifactCaptureEnv({
		outboxPath: ".pdpp-data/queue.sqlite",
		sourceInstanceId: "instance-1",
	});
	const spool = env[ARTIFACT_SPOOL_ROOT_ENV];
	assert.ok(spool && isAbsolute(spool), "the spool root is absolute");
	// Deriving from the raw relative path would yield ".pdpp-data/blob-spool",
	// which the child would open beside ITS cwd.
	assert.equal(spool, join(resolve(".pdpp-data"), "blob-spool"));
});

test("a custom RELATIVE spool root is normalized too", () => {
	const env = buildArtifactCaptureEnv({
		outboxPath: "/srv/pdpp/queue.sqlite",
		sourceInstanceId: "instance-1",
		spoolRoot: "spool/blobs",
	});
	const spool = env[ARTIFACT_SPOOL_ROOT_ENV];
	assert.ok(
		spool && isAbsolute(spool),
		"an explicitly supplied relative spool root is also resolved",
	);
	assert.equal(spool, resolve("spool/blobs"));
});

test("already-absolute paths are forwarded unchanged", () => {
	const env = buildArtifactCaptureEnv({
		outboxPath: "/srv/pdpp/queue.sqlite",
		sourceInstanceId: "instance-1",
		spoolRoot: "/srv/pdpp/spool",
	});
	assert.equal(env[ARTIFACT_OUTBOX_PATH_ENV], "/srv/pdpp/queue.sqlite");
	assert.equal(env[ARTIFACT_SPOOL_ROOT_ENV], "/srv/pdpp/spool");
});
