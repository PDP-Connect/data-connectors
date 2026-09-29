// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildChannel,
	buildMessageFamily,
	buildReminder,
	buildStar,
	buildUser,
	buildUserGroup,
	buildWorkspace,
	conversationKind,
	isThreadParent,
	slackTsSeconds,
	threadActiveSince,
} from "./parsers.ts";
import {
	authTestSchema,
	conversationsListSchema,
	historySchema,
	remindersListSchema,
	starsListSchema,
	teamInfoSchema,
	userGroupsListSchema,
	usersListSchema,
	validateRecord,
} from "./schemas.ts";
import { FIXTURE_NOW, fixture } from "./test-support.ts";

const EMITTED_AT = FIXTURE_NOW.toISOString();

function valid(stream: string, data: Record<string, unknown>) {
	const checked = validateRecord(stream, data);
	assert.equal(checked.ok, true, JSON.stringify(checked));
}

const history = (name: string) =>
	historySchema.parse(fixture(name)).messages ?? [];

test("a message with reactions, a link preview and a file yields the whole family", () => {
	const [message] = history("conversations.history-C0123456789-p1");
	assert.ok(message);
	const family = buildMessageFamily("C0123456789", message, EMITTED_AT);
	valid("messages", family.message);
	assert.deepEqual(family.message, {
		id: "C0123456789:1790450000.000200",
		channel_id: "C0123456789",
		user_id: "U0123456789",
		bot_id: null,
		team_id: "T0123456789",
		client_msg_id: "6b1a9d6e-0000-4000-8000-000000000001",
		ts: "1790450000.000200",
		sent_at: "2026-09-26T19:13:20.000Z",
		thread_ts: null,
		parent_user_id: null,
		is_thread_parent: false,
		reply_count: null,
		reply_user_ids: null,
		latest_reply: null,
		subtype: null,
		is_tombstone: false,
		text: "Reminder: the relayer ran out of VANA again, see <#C0987654321|eng-alerts>",
		edited_ts: null,
		edited_by: null,
		has_files: true,
		file_count: 1,
		has_attachments: true,
		attachment_count: 1,
		has_blocks: true,
		reaction_count: 3,
		is_pinned: false,
		pinned_to: null,
		metadata_event_type: null,
	});
	assert.deepEqual(
		family.reactions.map((r) => r.id),
		[
			"C0123456789:1790450000.000200:eyes:U0555555555",
			"C0123456789:1790450000.000200:eyes:U0987654321",
			"C0123456789:1790450000.000200:+1:U0555555555",
		],
	);
	for (const reaction of family.reactions) {
		valid("reactions", reaction);
	}
	assert.equal(family.attachments.length, 1);
	valid("message_attachments", family.attachments[0] ?? {});
	assert.equal(
		family.attachments[0]?.id,
		"C0123456789:1790450000.000200:att:0",
	);
	assert.equal(
		family.attachments[0]?.title_link,
		"https://docs.vana.org/personal-server",
	);
	assert.equal(family.files.length, 1);
	valid("files", family.files[0] ?? {});
	assert.equal(family.files[0]?.id, "F0987654321");
	assert.equal(family.files[0]?.name, "incident.png");
	assert.equal(family.files[0]?.created_at, "2026-09-26T19:13:20.000Z");
	assert.equal(family.files[0]?.mode, "hosted");
});

test("a thread parent carries its reply summary; a bot post carries its bot id and subtype", () => {
	const [, parent] = history("conversations.history-C0123456789-p1");
	assert.ok(parent);
	const parentRecord = buildMessageFamily(
		"C0123456789",
		parent,
		EMITTED_AT,
	).message;
	valid("messages", parentRecord);
	assert.equal(parentRecord.is_thread_parent, true);
	assert.equal(parentRecord.reply_count, 2);
	assert.deepEqual(parentRecord.reply_user_ids, ["U0123456789", "U0555555555"]);
	assert.equal(parentRecord.latest_reply, "1790500000.000500");
	assert.equal(parentRecord.thread_ts, "1790400000.000100");

	const [bot] = history("conversations.history-C0987654321-p1");
	assert.ok(bot);
	const botRecord = buildMessageFamily("C0987654321", bot, EMITTED_AT).message;
	valid("messages", botRecord);
	assert.equal(botRecord.user_id, null);
	assert.equal(botRecord.bot_id, "B0123456789");
	assert.equal(botRecord.subtype, "bot_message");
	assert.equal(botRecord.metadata_event_type, "deploy_finished");
	assert.equal(botRecord.text, "");
});

test("a reply is not a thread parent; an edited message keeps who edited it", () => {
	const [, reply] = history(
		"conversations.replies-C0123456789-1790400000.000100",
	);
	assert.ok(reply);
	assert.equal(isThreadParent(reply), false);
	const record = buildMessageFamily("C0123456789", reply, EMITTED_AT).message;
	assert.equal(record.is_thread_parent, false);
	assert.equal(record.parent_user_id, "U0555555555");

	const [edited] = history("conversations.history-C0123456789-p2");
	assert.ok(edited);
	const editedRecord = buildMessageFamily(
		"C0123456789",
		edited,
		EMITTED_AT,
	).message;
	assert.equal(editedRecord.edited_by, "U0555555555");
	assert.equal(editedRecord.edited_ts, "1790300100.000000");
});

test("thread activity is judged by the latest reply, not the parent's own time", () => {
	const [active, quiet, plain] = history(
		"conversations.history-C0123456789-threads",
	);
	assert.ok(active && quiet && plain);
	assert.equal(threadActiveSince(active, 1_789_948_800), true);
	assert.equal(threadActiveSince(quiet, 1_789_948_800), false);
	assert.equal(threadActiveSince(plain, 0), false);
	assert.equal(slackTsSeconds("1790450000.000200"), 1_790_450_000.0002);
	assert.equal(slackTsSeconds(undefined), 0);
	assert.equal(slackTsSeconds("nope"), 0);
});

test("the workspace record comes from auth.test and team.info, and needs a team id", () => {
	const auth = authTestSchema.parse(fixture("auth.test"));
	const info = teamInfoSchema.parse(fixture("team.info"));
	const record = buildWorkspace(auth, info, EMITTED_AT);
	assert.ok(record);
	valid("workspace", record);
	assert.deepEqual(record, {
		id: "T0123456789",
		name: "Acme",
		domain: "acme",
		email_domain: "acme.example",
		enterprise_id: null,
		enterprise_name: null,
		url: "https://acme.slack.com/",
		icon_url: "https://avatars.slack-edge.com/acme_230.png",
		authenticated_user_id: "U0123456789",
		authenticated_username: "owner",
		authenticated_bot_id: null,
		fetched_at: EMITTED_AT,
	});
	const bare = buildWorkspace(
		authTestSchema.parse({ ok: true }),
		null,
		EMITTED_AT,
	);
	assert.equal(bare, null);
	const authOnly = buildWorkspace(auth, null, EMITTED_AT);
	assert.equal(authOnly?.domain, null);
	assert.equal(authOnly?.name, "Acme");
});

test("channels and users keep every field the archive profile reads", () => {
	const conversations =
		conversationsListSchema.parse(fixture("users.conversations")).channels ??
		[];
	const [general, alerts, dm, locked] = conversations;
	assert.ok(general && alerts && dm && locked);
	assert.deepEqual(conversations.map(conversationKind), [
		"public",
		"public",
		"im",
		"private",
		"public",
	]);
	const record = buildChannel(general);
	valid("channels", record);
	assert.equal(record.name, "general");
	assert.equal(record.topic, "Company-wide announcements");
	assert.equal(record.created_at, "2023-11-14T22:13:20.000Z");
	assert.equal(record.has_canvas, false);
	assert.equal(record.canvas_file_id, "F0123456789");
	assert.equal(record.is_member, true);
	const dmRecord = buildChannel(dm);
	valid("channels", dmRecord);
	assert.equal(dmRecord.name, null);
	assert.equal(dmRecord.is_im, true);
	assert.equal(dmRecord.user, "U0555555555");

	const members = usersListSchema.parse(fixture("users.list")).members ?? [];
	const [owner, bot] = members;
	assert.ok(owner && bot);
	const ownerRecord = buildUser(owner);
	valid("users", ownerRecord);
	assert.equal(ownerRecord.name, "owner");
	assert.equal(ownerRecord.display_name, "owner");
	assert.equal(ownerRecord.email, "owner@acme.example");
	assert.equal(ownerRecord.tz_offset, -25_200);
	assert.equal(ownerRecord.is_admin, true);
	assert.equal(ownerRecord.has_2fa, true);
	const botRecord = buildUser(bot);
	valid("users", botRecord);
	assert.equal(botRecord.is_bot, true);
});

test("user groups, reminders and stars build the archive profile's records", () => {
	const [group] =
		userGroupsListSchema.parse(fixture("usergroups.list")).usergroups ?? [];
	assert.ok(group);
	const groupRecord = buildUserGroup(group);
	valid("user_groups", groupRecord);
	assert.equal(groupRecord.handle, "engineering");
	assert.deepEqual(groupRecord.member_ids, ["U0123456789", "U0555555555"]);
	assert.deepEqual(groupRecord.channel_ids, ["C0987654321"]);
	assert.equal(groupRecord.deleted, false);
	assert.equal(groupRecord.created_at, "2023-11-14T22:13:20.000Z");

	const [reminder] =
		remindersListSchema.parse(fixture("reminders.list")).reminders ?? [];
	assert.ok(reminder);
	const reminderRecord = buildReminder(reminder);
	valid("reminders", reminderRecord);
	assert.equal(reminderRecord.text, "Rotate the API key");
	assert.equal(reminderRecord.scheduled_at, "2026-09-29T00:00:00.000Z");
	assert.equal(reminderRecord.completed_at, null);

	const [messageStar, channelStar] =
		starsListSchema.parse(fixture("stars.list")).items ?? [];
	assert.ok(messageStar && channelStar);
	const starRecord = buildStar(messageStar);
	valid("stars", starRecord);
	assert.equal(starRecord.id, "message:C0123456789:1790400000.000100");
	assert.equal(starRecord.target_id, "1790400000.000100");
	assert.equal(starRecord.user_id, "U0555555555");
	assert.equal(starRecord.starred_at, "2026-09-26T10:53:20.000Z");
	const channelStarRecord = buildStar(channelStar);
	valid("stars", channelStarRecord);
	assert.equal(channelStarRecord.id, "channel:C0987654321");
	assert.equal(channelStarRecord.target_id, "C0987654321");
});
