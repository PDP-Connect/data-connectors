// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shapes the page's own reads hand back, as `fixtures-live/` observed
 * them. These are the raw source items the parsers read; every field the
 * connector emits is derived from them, and every field it must never read
 * (mediaKey, encIv, encFilehash, filehash, directPath, deprecatedMms3Url,
 * messageSecret, botMessageSecret, tcToken, token, thumbnail bytes) is
 * deliberately absent.
 */

/** One chat of WAWebCollections.Chat, as the chat-list read maps it. */
export interface RawChat {
	id: string;
	server: string | null;
	title: string | null;
	t: number | null;
	archive: boolean;
	pin: boolean | number | null;
	mute_expiration: number | null;
	unread_count: number;
	read_only: boolean;
	history_state: string | null;
	msgs_in_memory: number;
}

/** One message row, as the in-memory read and the local walk map it. */
export interface RawMessage {
	id: string;
	from_me: boolean;
	remote: string;
	author: string | null;
	type: string | null;
	subtype: string | null;
	body: string | null;
	caption: string | null;
	t: number | null;
	quoted_id: string | null;
	quoted_participant: string | null;
	mimetype: string | null;
	size: number | null;
	filename: string | null;
	duration: number | string | null;
	is_forwarded: boolean;
	star: boolean;
	ack: number | null;
	is_view_once: boolean;
	call_duration: number | null;
	call_outcome: string | null;
	is_video_call: boolean | null;
	poll_name: string | null;
	lat: number | null;
	lng: number | null;
	loc: string | null;
	vcard_name: string | null;
	title: string | null;
	description: string | null;
	url: null;
}

/** One chat's full message walk, as the in-page walk returns it. */
export interface RawChatMessageWalk {
	chat_id: string;
	status: number;
	memory: RawMessage[];
	messages: RawMessage[];
	complete: boolean;
	anchored: boolean;
}

/**
 * One page of WAWebDBMessageFindLocal.msgFindBefore as the store answers it
 * (the shape `fixtures-live/messages-local.json` wraps per chat).
 */
export interface RawMessagesPage {
	chat_id: string;
	status: number;
	messages: RawMessage[];
}

/** One contact the page's contact collection holds. */
export interface RawContact {
	id: string;
	name: string | null;
	short_name: string | null;
	push_name: string | null;
	is_business: boolean;
	verified_name: string | null;
}

/** One participant of a group's metadata. */
export interface RawGroupParticipant {
	id: string;
	is_admin: boolean;
	is_super_admin: boolean;
}

/** One group of WAWebGroupMetadataCollection, as the group read maps it. */
export interface RawGroupMetadata {
	id: string;
	subject: string | null;
	creation: number | null;
	owner: string | null;
	announce: boolean;
	restrict: boolean;
	participants: RawGroupParticipant[];
}

/** The page's module-store readiness flags, as the readiness probe returns. */
export interface RawStoresReadiness {
	require_function: boolean;
	chats: boolean;
	contacts: boolean;
	groups: boolean;
	find_messages: boolean;
	send_request: boolean;
}
