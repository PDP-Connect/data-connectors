// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Claude Code connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point.

import type { LocalJsonlPhysicalCursorV1 } from "../../packages/polyfill-connectors/src/local-jsonl-cursor.ts";

export interface JsonlObject {
	agentId?: string | null;
	aiTitle?: string | null;
	attachment?: {
		hookName?: string | null;
		toolUseID?: string | null;
		content?: unknown;
		toolUseResult?: unknown;
	};
	cwd?: string;
	entrypoint?: string;
	gitBranch?: string;
	imagePasteIds?: unknown;
	isSidechain?: boolean | null;
	message?: unknown;
	parentUuid?: string | null;
	sessionId?: string;
	timestamp?: string;
	type?: string;
	userType?: string;
	uuid?: string;
	version?: string;
}

export interface ContentPart {
	id?: string;
	input?: unknown;
	is_error?: boolean;
	name?: string;
	text?: string;
	tool_use_id?: string;
	type?: string;
	content?: unknown;
}

export interface SessionAccumulator {
	cwd: string | null;
	entrypoint: string | null;
	git_branch: string | null;
	id: string;
	/** 'session' for a top-level <sessionId>.jsonl file, 'subagent' for a file
	 *  under <parentSessionId>/subagents/**. Mirrors legacy listTranscripts'
	 *  kind derivation (connectors/anthropic/claude-code-local.js). */
	kind: "session" | "subagent";
	last_event_at: string | null;
	message_count: number;
	/** Enclosing session id for a subagent record; null for a top-level session.
	 *  Mirrors legacy listTranscripts' parentSessionId. */
	parent_session_id: string | null;
	project_path: string;
	started_at: string | null;
	title: string | null;
	user_type: string | null;
	version: string | null;
}

/** Parser continuation at a physical JSONL cursor boundary. */
export interface JsonlObservations {
	cwd: string | null;
	entrypoint: string | null;
	firstTimestamp: string | null;
	gitBranch: string | null;
	lastTimestamp: string | null;
	messageCount: number;
	sessionId: string | null;
	/** File-basename-derived subagent session id (e.g. "agent-abc") when this
	 *  file is a <parentSessionId>/subagents/**\/*.jsonl transcript; null for a
	 *  top-level <sessionId>.jsonl file. Distinct from `agentId`/`agent_id`,
	 *  which is a per-message field read from the JSONL content and does not
	 *  equal the file basename (verified: real files carry agentId as the
	 *  basename's hex suffix without the "agent-" prefix). */
	subagentSessionId: string | null;
	title: string | null;
	userType: string | null;
	version: string | null;
}

export interface ClaudeJsonlGap {
	path: string;
	line_number: number;
	byte_offset: number;
	reason:
		| "malformed_jsonl_line"
		| "non_object_jsonl_record"
		| "truncated_jsonl_tail";
}

export interface ClaudeChildFileCursorV1 extends LocalJsonlPhysicalCursorV1 {
	jsonl_gaps?: ClaudeJsonlGap[];
	current_session_id: string | null;
}

export interface ClaudeSessionFileCursorV1 extends LocalJsonlPhysicalCursorV1 {
	session_ids?: string[];
	jsonl_gaps?: ClaudeJsonlGap[];
	observation: JsonlObservations;
}

export interface ClaudeSourceGap {
	path: string;
	reason: "source_read_error";
	error_code: string;
}

export interface ClaudeMessagesCursorV1 {
	source_gaps?: Record<string, ClaudeSourceGap>;
	fetched_at: string;
	file_cursors: Record<string, ClaudeChildFileCursorV1>;
	file_mtimes: Record<string, number>;
	local_jsonl_cursor_version: 1;
}

export interface ClaudeSessionsCursorV1 {
	source_gaps?: Record<string, ClaudeSourceGap>;
	session_rebuild_required?: boolean;
	fetched_at: string;
	file_cursors: Record<string, ClaudeSessionFileCursorV1>;
	file_mtimes: Record<string, number>;
	local_jsonl_cursor_version: 1;
	session_aggregates: Record<string, SessionAccumulator>;
}

export interface ClaudeCodeState {
	file_mtimes?: Record<string, number>;
	memory_notes?: { file_mtimes?: Record<string, number> };
	messages?: Partial<ClaudeMessagesCursorV1>;
	sessions?: Partial<ClaudeSessionsCursorV1>;
	skills?: { file_mtimes?: Record<string, number> };
	slash_commands?: { file_mtimes?: Record<string, number> };
	usage?: { file_mtimes?: Record<string, number> };
	// Inventory streams (backup_inventory, cache_inventory, config_inventory,
	// file_history) persist a per-stream fingerprint cursor so an unchanged
	// store does not re-version on every run when only mtime/size ticks.
	[stream: string]:
		| { fingerprints?: Record<string, string>; fetched_at?: string }
		| unknown;
}

export interface ParsedFrontmatter {
	body: string;
	frontmatter: Record<string, string>;
}
