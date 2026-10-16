// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notion page and database rows, read field by field with `readField`.
 *
 * Notion's API is not sparse: page and database objects always carry `id`,
 * `object`, `parent`, `url`, `archived`, `created_time` and
 * `last_edited_time`; pages also carry `created_by`, `last_edited_by` and
 * exactly one `title` property; databases carry a `title` array and a
 * `properties` map (https://developers.notion.com/reference/page,
 * /reference/database). So every mapped field uses the default absence
 * semantics: a missing or malformed field makes the row uncovered, and the
 * runtime withholds it rather than store a row that looks complete.
 *
 * The one stated empty value is an empty rich-text title (an untitled page
 * or database), which reads as `null`.
 */

import {
	buildRow,
	type FieldRead,
	fieldValue,
	mapField,
	type RowRead,
	readField,
	unavailableField,
	v,
} from "../../packages/polyfill-connectors/src/field-reader.ts";

const nonEmptyText = v.string({ nonEmpty: true });

/** A rich-text array: every part must carry a string `plain_text`. */
const richText = v.arrayOf(
	v.custom<string>("rich text part", (raw) => {
		const text = readField(raw, "plain_text", v.string());
		return text.kind === "read"
			? { kind: "value", value: text.value }
			: { kind: "malformed", problem: "rich text part has no plain_text" };
	}),
);

/** Join rich text; an empty array is an untitled object (stated empty). */
function titleFrom(parts: FieldRead<string[]>): FieldRead<string> {
	return mapField(parts, (texts) =>
		texts.length === 0
			? { kind: "explicit_empty" }
			: fieldValue(texts.join("")),
	);
}

/** A page's title lives in its one property of type `title`. */
function pageTitleOf(page: unknown): FieldRead<string> {
	const properties = readField(page, "properties", v.object());
	if (properties.kind !== "read")
		return properties.kind === "unavailable"
			? properties
			: unavailableField("properties is null");
	for (const [name, property] of Object.entries(properties.value)) {
		const type = readField(property, "type", v.string());
		if (type.kind === "unavailable") return type;
		if (type.kind === "read" && type.value === "title")
			return titleFrom(readField(properties.value, [name, "title"], richText));
	}
	return unavailableField("no title property");
}

/**
 * The parent's id sits under the key its `type` names (`page_id`,
 * `database_id`, `block_id`, ...). A workspace parent has no id.
 */
function parentIdOf(object: unknown): FieldRead<string> {
	const type = readField(object, ["parent", "type"], nonEmptyText);
	return mapField(type, (kind) =>
		kind === "workspace"
			? { kind: "explicit_empty" }
			: readField(object, ["parent", kind], nonEmptyText),
	);
}

function commonFields(object: unknown) {
	return {
		id: readField(object, "id", nonEmptyText),
		parent_type: readField(object, ["parent", "type"], nonEmptyText),
		parent_id: parentIdOf(object),
		url: readField(object, "url", v.url()),
		archived: readField(object, "archived", v.boolean()),
		created_time: readField(object, "created_time", v.date()),
		last_edited_time: readField(object, "last_edited_time", v.date()),
	};
}

export function pageRow(page: unknown): RowRead {
	return buildRow({
		...commonFields(page),
		object: readField(page, "object", nonEmptyText),
		title: pageTitleOf(page),
		created_by_id: readField(page, ["created_by", "id"], nonEmptyText),
		last_edited_by_id: readField(page, ["last_edited_by", "id"], nonEmptyText),
	});
}

export function databaseRow(database: unknown): RowRead {
	return buildRow({
		...commonFields(database),
		title: titleFrom(readField(database, "title", richText)),
		property_names: mapField(
			readField(database, "properties", v.object()),
			(properties) => fieldValue(Object.keys(properties)),
		),
	});
}

/** The row's own edit time, for the incremental cursor. */
export function lastEditedTimeOf(object: unknown): FieldRead<string> {
	return readField(object, "last_edited_time", v.date());
}
