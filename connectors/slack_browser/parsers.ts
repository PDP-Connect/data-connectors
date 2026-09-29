// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure adapters from Slack Web API objects to the Slack source's records.
// Kept free of Playwright and Node I/O so parsers.test.ts can drive them
// with fixture JSON alone.
//
// The archive profile stores each Slack object as a JSON blob and reads it
// back through ../slack/parsers.ts; this profile hands the same builders the
// same JSON, so both profiles produce the same record for the same object.

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildChannelRecord,
	buildFileRecord,
	buildMessageAttachmentRecords,
	buildMessageRecord,
	buildReactionRecords,
	buildUserRecord,
	buildWorkspaceRecord,
	epochToIso,
	parseMessageRow,
} from "../slack/parsers.ts";
import type { MessageRow, WorkspaceRow } from "../slack/types.ts";
import type {
	AuthTestAnswer,
	ConversationKind,
	SlackConversationObject,
	SlackMessageObject,
	SlackReminderObject,
	SlackStarObject,
	SlackUserGroupObject,
	SlackUserObject,
	TeamInfoAnswer,
} from "./types.ts";

/** Slack "seconds.micros" → seconds, or 0 when absent or unparseable. */
export function slackTsSeconds(ts: string | undefined): number {
	const seconds = Number.parseFloat(ts ?? "");
	return Number.isFinite(seconds) ? seconds : 0;
}

/** A message that starts a thread, or is not in one: its own ts is the thread's. */
export function isThreadParent(message: SlackMessageObject): boolean {
	return message.thread_ts === undefined || message.thread_ts === message.ts;
}

/** Whether a thread parent received a reply at or after `sinceSeconds`. */
export function threadActiveSince(
	message: SlackMessageObject,
	sinceSeconds: number,
): boolean {
	return (
		(message.reply_count ?? 0) > 0 &&
		slackTsSeconds(message.latest_reply) >= sinceSeconds
	);
}

export function conversationKind(
	conversation: SlackConversationObject,
): ConversationKind {
	if (conversation.is_im) {
		return "im";
	}
	if (conversation.is_mpim) {
		return "mpim";
	}
	if (conversation.is_private) {
		return "private";
	}
	return "public";
}

/**
 * The workspace record, from `auth.test` (who the session is) and
 * `team.info` (what the workspace is). Null when Slack named no team id,
 * since the record's key would be meaningless.
 */
export function buildWorkspace(
	auth: AuthTestAnswer,
	teamInfo: TeamInfoAnswer | null,
	emittedAt: string,
): RecordData | null {
	const team = teamInfo?.team;
	const teamId = auth.team_id ?? team?.id;
	if (teamId === undefined) {
		return null;
	}
	const row: WorkspaceRow = {
		DATA: JSON.stringify({
			...team,
			team_id: teamId,
			user_id: auth.user_id,
			user: auth.user,
			bot_id: auth.bot_id,
		}),
		ENTERPRISE_ID: auth.enterprise_id ?? team?.enterprise_id ?? null,
		ID: 0,
		TEAM: auth.team ?? team?.name ?? null,
		TEAM_ID: teamId,
		URL: auth.url ?? null,
		USER_ID: auth.user_id ?? null,
		USERNAME: auth.user ?? null,
	};
	return buildWorkspaceRecord(row, emittedAt);
}

export function buildChannel(
	conversation: SlackConversationObject,
): RecordData {
	return buildChannelRecord({
		data: JSON.stringify(conversation),
		id: conversation.id,
		name: conversation.name ?? null,
	});
}

export function buildUser(user: SlackUserObject): RecordData {
	return buildUserRecord({
		data: JSON.stringify(user),
		id: user.id,
		username: user.name ?? null,
	});
}

/** Everything one message yields: its own record and the detail rows hung off it. */
export interface MessageFamily {
	attachments: RecordData[];
	files: RecordData[];
	message: RecordData;
	reactions: RecordData[];
}

export function buildMessageFamily(
	channelId: string,
	message: SlackMessageObject,
	emittedAt: string,
): MessageFamily {
	const files = message.files ?? [];
	const row: MessageRow = {
		CHANNEL_ID: channelId,
		DATA: JSON.stringify(message),
		IS_PARENT:
			isThreadParent(message) && (message.reply_count ?? 0) > 0 ? 1 : 0,
		NUM_FILES: message.files === undefined ? null : files.length,
		THREAD_TS: message.thread_ts ?? null,
		TS: message.ts,
		TXT: message.text ?? null,
	};
	const parsed = parseMessageRow(row, emittedAt);
	return {
		message: buildMessageRecord(parsed),
		attachments: buildMessageAttachmentRecords(parsed),
		reactions: buildReactionRecords(parsed),
		files: files.flatMap((file) =>
			file.id === undefined
				? []
				: [
						buildFileRecord({
							data: JSON.stringify(file),
							filename: file.name ?? null,
							id: file.id,
							mode: file.mode ?? null,
							url: file.url_private ?? null,
						}),
					],
		),
	};
}

export function buildUserGroup(group: SlackUserGroupObject): RecordData {
	return {
		id: group.id,
		team_id: group.team_id ?? null,
		handle: group.handle ?? null,
		name: group.name ?? null,
		description: group.description ?? null,
		is_external: group.is_external ?? null,
		is_subteam: group.is_subteam ?? null,
		member_ids: group.users ?? null,
		channel_ids: group.prefs?.channels ?? null,
		created: group.date_create ?? null,
		created_at: epochToIso(group.date_create),
		updated: group.date_update ?? null,
		deleted:
			typeof group.date_delete === "number" ? group.date_delete > 0 : null,
	};
}

export function buildReminder(reminder: SlackReminderObject): RecordData {
	return {
		id: reminder.id,
		creator_id: reminder.creator ?? null,
		user_id: reminder.user ?? null,
		text: reminder.text ?? null,
		recurring: reminder.recurring ?? null,
		time: reminder.time ?? null,
		scheduled_at: epochToIso(reminder.time),
		complete_ts: reminder.complete_ts ?? null,
		completed_at: reminder.complete_ts
			? epochToIso(reminder.complete_ts)
			: null,
	};
}

/**
 * `stars.list` items carry no id of their own, so the key is composed from
 * the starred entity's identifiers, the same way the archive profile does it.
 */
export function buildStar(item: SlackStarObject): RecordData {
	const itemType = item.type ?? null;
	const channelId = item.channel ?? null;
	const messageTs = item.message?.ts ?? null;
	const fileId = item.file?.id ?? null;
	const idParts = [
		itemType ?? "star",
		channelId ?? "",
		messageTs ?? "",
		fileId ?? "",
	].filter((part) => part !== "");
	return {
		id: idParts.join(":"),
		item_type: itemType,
		target_id: fileId ?? messageTs ?? channelId,
		channel_id: channelId,
		message_ts: messageTs,
		file_id: fileId,
		user_id: item.message?.user ?? null,
		starred_at: epochToIso(item.date_create),
	};
}
