// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the Slack browser profile. The Web API answer types are inferred
// from the Zod schemas in schemas.ts, so the type and the runtime check can
// never disagree.

import type { z } from "zod";
import type {
	authTestSchema,
	conversationObjectSchema,
	messageObjectSchema,
	messagesCursorSchema,
	reminderObjectSchema,
	signedInTeamSchema,
	starObjectSchema,
	teamInfoSchema,
	userGroupObjectSchema,
	userObjectSchema,
} from "./schemas.ts";

export type SignedInTeam = z.infer<typeof signedInTeamSchema>;
export type AuthTestAnswer = z.infer<typeof authTestSchema>;
export type TeamInfoAnswer = z.infer<typeof teamInfoSchema>;
export type SlackUserObject = z.infer<typeof userObjectSchema>;
export type SlackConversationObject = z.infer<typeof conversationObjectSchema>;
export type SlackMessageObject = z.infer<typeof messageObjectSchema>;
export type SlackUserGroupObject = z.infer<typeof userGroupObjectSchema>;
export type SlackReminderObject = z.infer<typeof reminderObjectSchema>;
export type SlackStarObject = z.infer<typeof starObjectSchema>;
export type MessagesCursor = z.infer<typeof messagesCursorSchema>;

/** The conversation kinds Slack's `users.conversations` can be asked for. */
export type ConversationKind = "im" | "mpim" | "private" | "public";

/** Owner tuning, read from SLACK_* environment variables. */
export interface SlackBrowserOptions {
	/** Channel ids or names to collect; empty means every conversation. */
	channelAllowlist: string[];
	/** Which conversation kinds to collect. */
	channelTypes: ConversationKind[];
	/** How far back a conversation's history is read; 0 means everything. */
	lookbackDays: number;
	/** Subdomain, team id or name of one workspace; empty means every signed-in workspace. */
	workspace: string;
}
