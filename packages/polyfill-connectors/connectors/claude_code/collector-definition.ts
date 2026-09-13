// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Claude Code connector's local-collector definition.
 *
 * The connector's own declaration of how it participates in local collection:
 * its stable id, the runtime bindings it needs, and the default stream set an
 * unscoped `run` should request. The generic `@pdpp/local-collector` runtime
 * consumes these definitions instead of hardcoding a per-connector table.
 *
 * Pure data only. This module MUST NOT import connector runtime code, Node
 * built-ins, or anything browser-bound (see the codex definition for why).
 *
 * Spec: openspec/changes/publish-pdpp-local-collector/design.md §3.
 */

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

/**
 * Default stream set for an unscoped `claude_code` local-collector run.
 *
 * Mirrors the full manifest-declared safe surface so an unscoped `run`
 * exercises everything the connector can account for — including
 * `coverage_diagnostics`, which is what promotes a drained local collector off
 * `coverage_unknown`. The inventory streams emit metadata only (path hash,
 * size, mtime); excluded stores never read payload.
 */
export const CLAUDE_CODE_DEFAULT_STREAMS = [
	"sessions",
	"messages",
	"attachments",
	"memory_notes",
	"skills",
	"slash_commands",
	"file_history",
	"cache_inventory",
	"coverage_diagnostics",
	"backup_inventory",
	"config_inventory",
] as const;

/**
 * Retention artifact classes this connector's own session format can produce,
 * over and above the connector-agnostic base every connector shares
 * (`RETENTION_BASE_ARTIFACT_CLASSES` in `src/retention-schemas.ts`).
 *
 * These name Claude Code transcript payload shapes, so this connector is the
 * only thing that knows them and the only place they are written. The
 * retention taxonomy is assembled from these declarations rather than restated
 * in a shared enum, the same way `streams` above is the single source of truth
 * for an unscoped run's scope.
 *
 * Each entry must stay prefixed with this connector's id, which
 * `src/retention-schemas.test.ts` pins: the prefix is what keeps two
 * connectors from colliding on a bare class name and silently sharing an
 * owner's omission rule.
 */
export const CLAUDE_CODE_RETENTION_ARTIFACT_CLASSES = [
	"claude.tool_result",
	"claude.tool_use.input",
	"claude.thinking",
	// The `tool-results/*.txt` sidecars are a Claude Code on-disk structure
	// (`connectors/claude_code/index.ts:475`), not a shared one, so this class
	// moves here under this connector's prefix.
	"claude.tool_result_sidecars",
] as const;

/**
 * Streams an owner-declared `since` can be proven against — exactly those the
 * `claude_code` manifest gives a `consent_time_field`
 * (`sessions.started_at`, `messages.timestamp`, `attachments.timestamp`).
 *
 * Streams without a consent time field remain whole-store under a time bound;
 * the runner keeps them in the requested inventory and marks them unscoped.
 */
export const CLAUDE_CODE_TIME_SCOPABLE_STREAMS = [
	"sessions",
	"messages",
	"attachments",
] as const;

export const CLAUDE_CODE_SOURCE_ROOT_SCOPABLE_STREAMS =
	CLAUDE_CODE_TIME_SCOPABLE_STREAMS;

export const claudeCodeCollectorDefinition: LocalCollectorDefinition = {
	connector_id: "claude_code",
	entry: "claude_code",
	bindings: { filesystem: { required: true } },
	// Declared explicitly (not omitted): this definition targets the
	// connector-protocol 0.0.2 capability-declaration contract, which
	// requires an explicit array even when empty. This connector emits no
	// STREAM_EVIDENCE and needs no protocol capability today.
	protocol_capabilities: [],
	streams: CLAUDE_CODE_DEFAULT_STREAMS,
	enforces_source_roots: true,
	source_root_scopable_streams: CLAUDE_CODE_SOURCE_ROOT_SCOPABLE_STREAMS,
	time_scopable_streams: CLAUDE_CODE_TIME_SCOPABLE_STREAMS,
};
