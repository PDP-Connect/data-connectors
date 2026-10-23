// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which Slack channel types a run may collect (the `CHANNEL_TYPES` option).
 *
 * `slackdump archive` has no channel-type flag, and `slackdump list channels`
 * lists every channel the signed-in user can see. So a run that narrows the
 * types lists first, keeps the IDs of the chosen types, and hands only those
 * to `archive`; a channel of an excluded type is never downloaded.
 *
 * Everything here fails closed. A selection that cannot be read, a listing
 * that cannot be read, or a channel that cannot be placed in exactly one type
 * throws; nothing falls back to "every channel". The subprocess call itself
 * lives in index.ts. These helpers only decide.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

export const CHANNEL_TYPES = ["public", "private", "im", "mpim"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type ChannelTypeFailure =
	| "ambiguous"
	| "invalid_types"
	| "no_channels"
	| "needs_slackdump"
	| "unreadable";

/**
 * A refusal to guess. `reason` is for code and tests; the message is plain
 * English with no long snake_case token, because the runtime redacts those
 * from free-form error text.
 */
export class ChannelTypeError extends Error {
	readonly reason: ChannelTypeFailure;
	constructor(reason: ChannelTypeFailure, message: string) {
		super(message);
		this.name = "ChannelTypeError";
		this.reason = reason;
	}
}

/**
 * The option's value as a set of known types. An empty list or an unknown
 * name is a configuration the connector cannot honour, so it throws instead of
 * guessing what the owner meant.
 */
export function parseChannelTypes(raw: readonly string[]): Set<ChannelType> {
	const known = new Set<string>(CHANNEL_TYPES);
	const selected = new Set<ChannelType>();
	const unknown: string[] = [];
	for (const entry of raw) {
		const name = entry.trim().toLowerCase();
		if (name.length === 0) continue;
		if (known.has(name)) selected.add(name as ChannelType);
		else unknown.push(name);
	}
	if (unknown.length > 0) {
		throw new ChannelTypeError(
			"invalid_types",
			`CHANNEL_TYPES names an unknown channel type (${unknown.join(", ")}). Choose from ${CHANNEL_TYPES.join(", ")}.`,
		);
	}
	if (selected.size === 0) {
		throw new ChannelTypeError(
			"invalid_types",
			`CHANNEL_TYPES chooses no channel type. Choose from ${CHANNEL_TYPES.join(", ")}.`,
		);
	}
	return selected;
}

/** True when the selection leaves at least one type out. */
export function narrowsChannelTypes(
	selected: ReadonlySet<ChannelType>,
): boolean {
	return CHANNEL_TYPES.some((type) => !selected.has(type));
}

const CHANNEL_ID = /^[A-Z0-9]{3,32}$/;

function flag(entry: Record<string, unknown>, key: string): boolean {
	return entry[key] === true;
}

/**
 * The one type a listed channel belongs to. Slack marks a public channel
 * `is_channel`, a private one `is_private` or `is_group`, a direct message
 * `is_im` and a group direct message `is_mpim`; a channel whose flags name no
 * type, or two, is ambiguous and throws.
 */
export function classifyChannelType(
	entry: Record<string, unknown>,
): ChannelType {
	for (const key of [
		"is_im",
		"is_mpim",
		"is_private",
		"is_group",
		"is_channel",
	]) {
		if (Object.hasOwn(entry, key) && typeof entry[key] !== "boolean") {
			throw new ChannelTypeError(
				"ambiguous",
				"Slack lists a channel with a malformed type flag, so no channel was downloaded.",
			);
		}
	}
	const im = flag(entry, "is_im");
	const mpim = flag(entry, "is_mpim");
	const priv = flag(entry, "is_private") || flag(entry, "is_group");
	const channel = flag(entry, "is_channel");
	if (im && !mpim && !channel) return "im";
	if (mpim && !im && !channel) return "mpim";
	if (!im && !mpim && priv) return "private";
	if (!im && !mpim && !priv && channel) return "public";
	throw new ChannelTypeError(
		"ambiguous",
		"Slack lists a channel that is not clearly public, private, a direct message or a group message, so no channel was downloaded.",
	);
}

/**
 * The IDs, sorted, of the listed channels whose type is selected. `listing` is
 * the parsed output of `slackdump list channels -format JSON`: an array of
 * channel objects. Anything else throws.
 */
export function selectChannelIdsByType(
	listing: unknown,
	selected: ReadonlySet<ChannelType>,
): string[] {
	if (!Array.isArray(listing)) {
		throw new ChannelTypeError(
			"unreadable",
			"The Slack channel list could not be read (it is not a list), so no channel was downloaded.",
		);
	}
	const typeById = new Map<string, ChannelType>();
	for (const entry of listing as unknown[]) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new ChannelTypeError(
				"unreadable",
				"The Slack channel list could not be read (an entry is not a channel), so no channel was downloaded.",
			);
		}
		const record = entry as Record<string, unknown>;
		const id = record.id;
		if (typeof id !== "string" || !CHANNEL_ID.test(id)) {
			throw new ChannelTypeError(
				"unreadable",
				"The Slack channel list could not be read (a channel has no usable ID), so no channel was downloaded.",
			);
		}
		const type = classifyChannelType(record);
		const previous = typeById.get(id);
		if (previous !== undefined && previous !== type) {
			throw new ChannelTypeError(
				"ambiguous",
				"Slack lists one channel under two types, so no channel was downloaded.",
			);
		}
		typeById.set(id, type);
	}
	return [...typeById]
		.filter(([, type]) => selected.has(type))
		.map(([id]) => id)
		.sort();
}

/**
 * The channels a run may archive: those of the chosen types that every
 * restriction the run carries also names. A restriction is an allowlist or a
 * grant's channels. Each present restriction narrows the set and none widens
 * it, so two restrictions are intersected, never united. A restriction that is
 * present but names nothing leaves nothing, which is different from no
 * restriction at all. An empty result is returned as empty so the caller can
 * refuse to archive: an empty positional list means "every channel" to
 * slackdump.
 */
export function channelsForRun(
	restrictions: readonly (readonly string[])[],
	typeSelected: readonly string[],
): string[] {
	const sets = restrictions.map((restriction) => new Set(restriction));
	return [...new Set(typeSelected)].filter((id) =>
		sets.every((set) => set.has(id)),
	);
}

/** Streams whose records name a channel in `id` or `channel_id`. */
const CHANNEL_KEY_BY_STREAM: Readonly<Record<string, string>> = {
	channel_memberships: "channel_id",
	channel_stats: "channel_id",
	channels: "id",
	dm_read_states: "channel_id",
	message_attachments: "channel_id",
	messages: "channel_id",
	reactions: "channel_id",
};

/** Streams whose `channel_id` may be null because the item is not in a channel. */
const OPTIONAL_CHANNEL_STREAMS: ReadonlySet<string> = new Set([
	"canvases",
	"stars",
]);

/**
 * What a restricted run may emit, whatever archive or API it came from. A
 * record naming a channel outside `allowed` is dropped (null), and a record
 * that should name one but does not is dropped too. `user_groups` keeps its
 * record but only the channel IDs that are allowed. Streams with no channel
 * pass through.
 */
export function restrictRecordToChannels(
	stream: string,
	data: RecordData,
	allowed: ReadonlySet<string>,
): RecordData | null {
	const key =
		CHANNEL_KEY_BY_STREAM[stream] ??
		(OPTIONAL_CHANNEL_STREAMS.has(stream) ? "channel_id" : undefined);
	if (key !== undefined) {
		const value = data[key];
		if (value === null || value === undefined) {
			return OPTIONAL_CHANNEL_STREAMS.has(stream) ? data : null;
		}
		return typeof value === "string" && allowed.has(value) ? data : null;
	}
	if (stream === "user_groups" && Array.isArray(data.channel_ids)) {
		return {
			...data,
			channel_ids: data.channel_ids.filter(
				(id): id is string => typeof id === "string" && allowed.has(id),
			),
		};
	}
	return data;
}
