// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test files that create their own bwrap/unshare namespaces. test-sandbox's
// bwrap blocks nested namespaces, so these run in the `namespaces` lane
// (`test-sandbox --isolate cgroup`), one file at a time: they share the
// repository root as global state (isolation-mechanism plants sockets under it
// that scenario-verify-strict's isolation scan then refuses). Every other file
// runs in the `sandboxed` lane. src/test-runner-contract.test.ts checks that
// this list is complete. Package-relative paths.
export const NAMESPACE_TESTS = new Set([
	"bin/scenario-cli.test.ts",
	"bin/scenario-fidelity.test.ts",
	"bin/scenario-verify-strict.test.ts",
	"src/scenario/filesystem-input.test.ts",
	"src/scenario/isolation-mechanism.test.ts",
]);

// Test files no lane runs. connectors/github/index.test.ts drives the
// connector against the reference implementation's ingest pipeline
// (../../reference-implementation/server/*), which is not in this repository.
// Paths as the related-test selector reports them.
export const EXCLUDED_TESTS = new Set(["connectors/github/index.test.ts"]);
