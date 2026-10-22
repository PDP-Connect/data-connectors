// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertHttpOk,
	assertLandedOnContent,
	assertNoEnvelopeFailure,
	assertReadOnlyOperation,
	buildProfileRecord,
	buildVariables,
	epochSecondsToIso,
	extractPreloadedPayloads,
	extractProfileIntro,
	extractViewer,
	type JsonRecord,
	matchActivityConnection,
	matchFriendsConnection,
	matchGroupsConnection,
	matchTimelineConnection,
	missingConnectionError,
	newTextCounter,
	nodeOf,
	parseActivityNode,
	parseCapturedGraphqlRequest,
	parseFriendNode,
	parseGraphqlText,
	parseGroupNode,
	parsePostNode,
	pickConnection,
	profileUrlFrom,
	splitGraphqlText,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import {
	ACTIVITY,
	FRIENDS,
	loadFixture,
	TIMELINE,
	TIMELINE_VIEWER,
} from "./test-helpers.ts";

function firstEdgeNode(
	payload: JsonRecord,
	match: Parameters<typeof pickConnection>[1],
): JsonRecord {
	const connection = pickConnection(payload.data ?? payload, match);
	assert.ok(connection, "connection present");
	const node = nodeOf(connection.edges[0]);
	assert.ok(node, "first edge has a node");
	return node;
}

describe("response text", () => {
	it("strips the anti-hijack prefix and splits streamed parts", () => {
		const parts = splitGraphqlText(
			`for (;;);{"data":{"a":1}}\n{"label":"x","path":["a"],"data":{}}\r\n`,
		);
		assert.equal(parts.length, 2);
	});

	it("rejects a body that is not JSON", () => {
		assert.throws(
			() => splitGraphqlText("<html>nope</html>"),
			/^Error: facebook_response_unparseable/,
		);
	});

	it("merges @stream edges and the @defer page_info into the first part", () => {
		const first = loadFixture(TIMELINE);
		const edges = ((first.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		const firstEdge = (edges.edges as JsonRecord[])[0] as JsonRecord;
		const second = structuredClone(firstEdge);
		(second.node as JsonRecord).post_id = "100999";
		(second.node as JsonRecord).id = "UzpfSTEwMDk5OQ==";
		const text = [
			JSON.stringify(first),
			JSON.stringify({
				label:
					"ProfileCometTimelineFeed_user$stream$ProfileCometTimelineFeed_user_timeline_list_feed_units",
				path: ["node", "timeline_list_feed_units", "edges", 1],
				data: second,
			}),
			JSON.stringify({
				label:
					"ProfileCometTimelineFeed_user$defer$ProfileCometTimelineFeed_user_timeline_list_feed_units$page_info",
				path: ["node", "timeline_list_feed_units"],
				data: { page_info: { end_cursor: "next-1", has_next_page: true } },
				extensions: { is_final: true },
			}),
		].join("\n");
		const payload = parseGraphqlText(`for (;;);${text}`);
		const connection = pickConnection(payload.data, matchTimelineConnection);
		assert.ok(connection);
		assert.equal(connection.edges.length, 2);
		assert.deepEqual(connection.pageInfo, {
			endCursor: "next-1",
			hasNextPage: true,
		});
		assert.equal(payload.parts, 3);
	});
});

describe("posts", () => {
	it("reads the viewer's own post from the timeline fixture", () => {
		const node = firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection);
		const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
		assert.equal(parsed.kind, "post");
		if (parsed.kind !== "post") return;
		assert.equal(parsed.record.id, "100011");
		assert.equal(parsed.record.create_time, "2022-03-04T15:07:37.000Z");
		assert.equal(parsed.record.privacy, "FRIENDS");
		assert.equal(
			parsed.record.attachments[0]?.kind,
			"messenger_generic_template",
		);
		assert.equal(parsed.record.url, "https://example.com/item/471");
		assert.equal(validateRecord("posts", { ...parsed.record }).ok, true);
	});

	it("skips a unit someone else posted on the timeline", () => {
		const node = firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection);
		assert.equal(parsePostNode(node, "999", newTextCounter()).kind, "not_own");
	});

	it("reads the post text from the content section", () => {
		const node = firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection);
		const story = ((node.comet_sections as JsonRecord).content as JsonRecord)
			.story as JsonRecord;
		story.message = { text: "Hello from the lake" };
		const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
		assert.equal(
			parsed.kind === "post" ? parsed.record.text : null,
			"Hello from the lake",
		);
	});

	it("finds the post text in every Comet layout the timeline uses", () => {
		const layouts: [string, (node: JsonRecord) => void][] = [
			[
				"content.story.comet_sections.message_container",
				(node) => {
					const sections = (
						((node.comet_sections as JsonRecord).content as JsonRecord)
							.story as JsonRecord
					).comet_sections as JsonRecord;
					sections.message_container = {
						story: { message: { text: "Lake day" } },
					};
				},
			],
			[
				"content.story.comet_sections.message",
				(node) => {
					const sections = (
						((node.comet_sections as JsonRecord).content as JsonRecord)
							.story as JsonRecord
					).comet_sections as JsonRecord;
					sections.message = { story: { message: { text: "Lake day" } } };
				},
			],
			[
				"comet_sections.message",
				(node) => {
					(node.comet_sections as JsonRecord).message = {
						story: { message: { text: "Lake day" } },
					};
				},
			],
			[
				"story.message",
				(node) => {
					node.message = { text: "Lake day" };
				},
			],
		];
		for (const [layout, place] of layouts) {
			const node = firstEdgeNode(
				loadFixture(TIMELINE),
				matchTimelineConnection,
			);
			place(node);
			const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
			assert.equal(
				parsed.kind === "post" ? parsed.record.text : "unread",
				"Lake day",
				layout,
			);
		}
	});

	it("takes text delivered by a deferred part into message_container", () => {
		const first = loadFixture(TIMELINE);
		const text = [
			JSON.stringify(first),
			JSON.stringify({
				label: "CometFeedStoryDefaultMessageRenderingStrategy_message$defer",
				path: [
					"node",
					"timeline_list_feed_units",
					"edges",
					0,
					"node",
					"comet_sections",
					"content",
					"story",
					"comet_sections",
					"message_container",
				],
				data: { story: { message: { text: "Deferred words" } } },
			}),
		].join("\n");
		const node = firstEdgeNode(
			{ data: parseGraphqlText(text).data },
			matchTimelineConnection,
		);
		const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
		assert.equal(
			parsed.kind === "post" ? parsed.record.text : "unread",
			"Deferred words",
		);
	});

	it("keeps text null for a post without its own words, never borrowing a share's or a comment's", () => {
		const node = firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection);
		node.attached_story = { message: { text: "someone else's post" } };
		const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
		assert.equal(parsed.kind === "post" ? parsed.record.text : "unread", null);
	});

	it("fills title, shared_text and attachment_title from the live share layouts, keeping text null", () => {
		const sharedLayouts: [string, (story: JsonRecord) => void][] = [
			[
				"content.story.attached_story.message",
				(story) => {
					story.attached_story = { message: { text: "Shared words" } };
				},
			],
			[
				"content.story.attached_story.comet_sections.message.story.message",
				(story) => {
					story.attached_story = {
						comet_sections: {
							message: { story: { message: { text: "Shared words" } } },
						},
					};
				},
			],
			[
				"content.story.attached_story...message_container.story.message",
				(story) => {
					story.attached_story = {
						comet_sections: {
							message_container: {
								story: { message: { text: "Shared words" } },
							},
						},
					};
				},
			],
			[
				"content.story.comet_sections.attached_story.story.attached_story.comet_sections.attached_story_layout.story.message",
				(story) => {
					(story.comet_sections as JsonRecord).attached_story = {
						story: {
							attached_story: {
								comet_sections: {
									attached_story_layout: {
										story: { message: { text: "Shared words" } },
									},
								},
							},
						},
					};
				},
			],
		];
		for (const [layout, place] of sharedLayouts) {
			const node = firstEdgeNode(
				loadFixture(TIMELINE),
				matchTimelineConnection,
			);
			const sections = node.comet_sections as JsonRecord;
			place((sections.content as JsonRecord).story as JsonRecord);
			const titleStory = (
				((sections.context_layout as JsonRecord).story as JsonRecord)
					.comet_sections as JsonRecord
			).title as JsonRecord;
			(titleStory.story as JsonRecord).title = {
				text: "Ada Example shared a post.",
			};
			const attachment = ((node.attachments as JsonRecord[])[0] as JsonRecord)
				.styles as JsonRecord;
			(attachment.attachment as JsonRecord).title_with_entities = {
				text: "A headline",
			};
			const parsed = parsePostNode(node, TIMELINE_VIEWER, newTextCounter());
			assert.equal(parsed.kind, "post", layout);
			if (parsed.kind !== "post") continue;
			assert.equal(parsed.record.text, null, layout);
			assert.equal(parsed.record.shared_text, "Shared words", layout);
			assert.equal(parsed.record.title, "Ada Example shared a post.", layout);
			assert.equal(parsed.record.attachment_title, "A headline", layout);
			assert.equal(
				validateRecord("posts", { ...parsed.record }).ok,
				true,
				layout,
			);
		}
	});

	it("leaves the new fields null when the live fixture has none of them", () => {
		const parsed = parsePostNode(
			firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection),
			TIMELINE_VIEWER,
			newTextCounter(),
		);
		assert.equal(parsed.kind, "post");
		if (parsed.kind !== "post") return;
		assert.deepEqual(
			[
				parsed.record.title,
				parsed.record.shared_text,
				parsed.record.attachment_title,
			],
			[null, null, null],
		);
	});

	it("calls a unit without a post id unreadable instead of guessing", () => {
		const node = firstEdgeNode(loadFixture(TIMELINE), matchTimelineConnection);
		delete node.post_id;
		delete (
			((node.comet_sections as JsonRecord).content as JsonRecord)
				.story as JsonRecord
		).post_id;
		assert.equal(
			parsePostNode(node, TIMELINE_VIEWER, newTextCounter()).kind,
			"unreadable",
		);
	});
});

describe("friends", () => {
	it("matches the friends list and reads each friend", () => {
		const payload = loadFixture(FRIENDS);
		const connection = pickConnection(payload.data, matchFriendsConnection);
		assert.ok(connection);
		assert.equal(connection.key, "pageItems");
		assert.equal(connection.pageInfo?.hasNextPage, true);
		const records = connection.edges.map((edge) => {
			const node = nodeOf(edge);
			assert.ok(node);
			return parseFriendNode(node, newTextCounter());
		});
		assert.equal(records.length, 3);
		assert.deepEqual(records[0], {
			id: "100026",
			name: "Synthetic text 4 lorem",
			profile_url: "https://example.com/item/6",
		});
		for (const record of records)
			assert.equal(validateRecord("friends", record as never).ok, true);
	});
});

describe("activity log", () => {
	it("reads reactions and tolerates field errors next to data", () => {
		const payload = loadFixture(ACTIVITY);
		const connection = pickConnection(payload.data, matchActivityConnection);
		assert.ok(connection);
		assert.equal(connection.edges.length, 3);
		const node = nodeOf(connection.edges[0]);
		assert.ok(node);
		node.id = "S:_I100001:VK:100004";
		const record = parseActivityNode(node, "reaction", newTextCounter());
		assert.ok(record);
		assert.equal(record.time, "2022-03-30T21:20:59.000Z");
		assert.equal(record.post_id, "100004");
		assert.equal(
			record.title,
			"Synthetic text 6 lorem lorem lorem lorem lorem",
		);
		assert.equal(record.comment_text, null);
		assert.equal(validateRecord("reactions", record as never).ok, true);
		const merged = parseGraphqlText(JSON.stringify(payload));
		assert.doesNotThrow(() =>
			assertNoEnvelopeFailure(
				merged,
				"CometActivityLogStoriesListPaginationQuery",
			),
		);
	});

	it("keeps the comment text on comment entries", () => {
		const payload = loadFixture(ACTIVITY);
		const node = firstEdgeNode(payload, matchActivityConnection);
		node.id = "S:_I100001:VK:100005";
		node.message = { text: "Congratulations!" };
		const record = parseActivityNode(node, "comment", newTextCounter());
		assert.equal(record?.comment_text, "Congratulations!");
		assert.equal(validateRecord("comments", record as never).ok, true);
	});
});

describe("groups", () => {
	it("matches a joined-groups list by its group links and reads each group", () => {
		const connection = {
			edges: [
				{
					node: {
						id: "123456",
						name: "Lake swimmers",
						url: "https://www.facebook.com/groups/123456/",
					},
				},
			],
			page_info: { end_cursor: null, has_next_page: false },
		};
		const found = pickConnection(
			{ viewer: { id: "1", groups_tab: connection } },
			matchGroupsConnection,
		);
		assert.ok(found);
		const node = nodeOf(found.edges[0]);
		assert.ok(node);
		const record = parseGroupNode(node, newTextCounter());
		assert.deepEqual(record, {
			id: "123456",
			name: "Lake swimmers",
			url: "https://www.facebook.com/groups/123456/",
			joined_time: null,
		});
		assert.equal(validateRecord("groups", record as never).ok, true);
	});

	it("does not mistake the friends list for groups", () => {
		assert.equal(
			pickConnection(loadFixture(FRIENDS).data, matchGroupsConnection),
			null,
		);
	});
});

describe("server-rendered payloads", () => {
	const streamed = (id: string, sequence: number, result: unknown) =>
		JSON.stringify({
			require: [
				[
					"ScheduledServerJS",
					"handle",
					null,
					[
						{
							__bbox: {
								require: [
									[
										"RelayPrefetchedStreamCache",
										"next",
										[],
										[
											id,
											{
												__bbox: {
													complete: false,
													result,
													sequence_number: sequence,
												},
											},
										],
									],
								],
							},
						},
					],
				],
			],
		});

	it("merges preloaded parts per preloader and finds the list", () => {
		const friends = loadFixture(FRIENDS);
		const scripts = [
			streamed("adp_friends", 0, { data: friends.data }),
			streamed("adp_friends", 1, {
				data: { page_info: { end_cursor: "x", has_next_page: false } },
				path: ["node", "pageItems"],
			}),
			"not json",
		];
		const payloads = extractPreloadedPayloads(scripts);
		assert.equal(payloads.length, 1);
		const connection = pickConnection(
			payloads[0]?.data,
			matchFriendsConnection,
		);
		assert.equal(connection?.pageInfo?.hasNextPage, false);
		assert.equal(connection?.edges.length, 3);
	});

	it("reads the signed-in person and treats USER_ID 0 as signed out", () => {
		const page = JSON.stringify({
			define: [
				[
					"CurrentUserInitialData",
					[],
					{ USER_ID: "100476", NAME: "Ada Example" },
					270,
				],
			],
		});
		assert.deepEqual(extractViewer([page]), {
			id: "100476",
			name: "Ada Example",
		});
		const out = JSON.stringify({
			define: [
				["CurrentUserInitialData", [], { USER_ID: "0", ACCOUNT_ID: "0" }, 270],
			],
		});
		assert.equal(extractViewer([out]), null);
	});

	it("reads the intro card when the page has one, and says null when it does not", () => {
		const card = {
			profile_intro_card: {
				bio: { text: "Swimmer." },
				context_items: {
					nodes: [
						{
							renderer: {
								context_item: { title: { text: "Lives in Lisbon" } },
							},
						},
					],
				},
			},
		};
		const intro = extractProfileIntro(
			extractPreloadedPayloads([
				streamed("adp_p", 0, { data: { user: card } }),
			]),
			newTextCounter(),
		);
		assert.deepEqual(intro, { bio: "Swimmer.", items: ["Lives in Lisbon"] });
		assert.equal(extractProfileIntro([], newTextCounter()), null);
		const record = buildProfileRecord(
			{ id: "100476", name: "Ada" },
			"https://www.facebook.com/ada.example",
			intro,
			newTextCounter(),
		);
		assert.equal(record.username, "ada.example");
		assert.equal(validateRecord("profile", record as never).ok, true);
	});

	it("builds a profile link from where /me landed", () => {
		assert.deepEqual(
			profileUrlFrom("https://www.facebook.com/profile.php?id=42", "42"),
			{
				url: "https://www.facebook.com/profile.php?id=42",
				username: null,
			},
		);
		assert.equal(
			profileUrlFrom("https://evil.example/ada", "42").username,
			null,
		);
	});
});

describe("guards", () => {
	it("refuses every mutation and anything that is not a plain query", () => {
		assert.throws(
			() => assertReadOnlyOperation("CometUFIFeedbackReactMutation"),
			/^Error: facebook_mutation_refused/,
		);
		assert.throws(
			() => assertReadOnlyOperation("CometTS2BitArrayLoggerMutation"),
			/facebook_mutation_refused/,
		);
		assert.throws(
			() => assertReadOnlyOperation("SomethingSubscriptionQuery"),
			/facebook_mutation_refused/,
		);
		assert.throws(
			() => assertReadOnlyOperation("useSomething"),
			/facebook_mutation_refused/,
		);
		assert.doesNotThrow(() =>
			assertReadOnlyOperation("CometActivityLogStoriesListPaginationQuery"),
		);
	});

	it("classifies sign-in, challenge, rate limit and server answers", () => {
		const ok = {
			status: 200,
			text: "{}",
			url: "https://www.facebook.com/api/graphql/",
		};
		assert.doesNotThrow(() => assertHttpOk(ok));
		assert.throws(
			() => assertHttpOk({ ...ok, status: 401 }),
			/^Error: facebook_auth_failed/,
		);
		assert.throws(
			() => assertHttpOk({ ...ok, status: 429 }),
			/^Error: facebook_rate_limited/,
		);
		assert.throws(
			() => assertHttpOk({ ...ok, status: 502 }),
			/^Error: facebook_http_5xx/,
		);
		assert.throws(
			() => assertHttpOk({ ...ok, status: 403, text: "<!DOCTYPE html>" }),
			/^Error: facebook_challenge/,
		);
		assert.throws(
			() =>
				assertHttpOk({
					...ok,
					url: "https://www.facebook.com/checkpoint/1501092823525282/",
				}),
			/facebook_challenge/,
		);
		assert.throws(
			() => assertLandedOnContent("https://www.facebook.com/login/?next=x"),
			/facebook_auth_failed/,
		);
		assert.doesNotThrow(() =>
			assertLandedOnContent("https://www.facebook.com/ada.example"),
		);
	});

	it("classifies bot checks before server errors, from the header or a non-JSON body (finding 10)", () => {
		const base = {
			status: 200,
			text: "{}",
			url: "https://www.facebook.com/api/graphql/",
		};
		assert.throws(
			() =>
				assertHttpOk({
					...base,
					status: 503,
					text: "<!DOCTYPE html><title>Security check</title>",
				}),
			/^Error: facebook_challenge/,
		);
		assert.throws(
			() => assertHttpOk({ ...base, status: 403, text: "<html></html>" }),
			/^Error: facebook_challenge/,
		);
		assert.throws(
			() => assertHttpOk({ ...base, text: "Please verify you are a human" }),
			/^Error: facebook_challenge/,
		);
		assert.throws(
			() =>
				assertHttpOk({
					...base,
					status: 503,
					text: "{}",
					mitigated: "challenge",
				}),
			/^Error: facebook_challenge/,
		);
		assert.throws(
			() => assertHttpOk({ ...base, status: 500, text: "{}" }),
			/^Error: facebook_http_5xx/,
		);
		assert.doesNotThrow(() =>
			assertHttpOk({ ...base, text: 'for (;;);{"data":{}}' }),
		);
	});

	it("classifies legacy error envelopes", () => {
		const signedOut = parseGraphqlText(
			'for (;;);{"__ar":1,"error":1357001,"errorSummary":"Not logged in"}',
		);
		assert.throws(
			() => assertNoEnvelopeFailure(signedOut, "Q"),
			/^Error: facebook_auth_failed/,
		);
		const blocked = parseGraphqlText(
			'{"error":1390008,"errorSummary":"You can\'t use this feature right now"}',
		);
		assert.throws(
			() => assertNoEnvelopeFailure(blocked, "Q"),
			/^Error: facebook_rate_limited/,
		);
	});

	it("names an outdated query when the list is missing and the server complains", () => {
		const payload = parseGraphqlText(
			'{"errors":[{"message":"missing_required_variable_value","path":[]}],"data":null}',
		);
		assert.match(
			missingConnectionError(payload, "Q").message,
			/^facebook_query_outdated/,
		);
		const shape = parseGraphqlText('{"data":{"node":{"something_else":{}}}}');
		assert.match(
			missingConnectionError(shape, "Q").message,
			/^facebook_shape_changed/,
		);
	});

	it("converts epoch seconds to a zoned time and rejects junk", () => {
		assert.equal(epochSecondsToIso(1_648_675_259), "2022-03-30T21:20:59.000Z");
		assert.equal(epochSecondsToIso("1648675259"), null);
		assert.equal(epochSecondsToIso(0), null);
	});
});

describe("captured requests and variables", () => {
	const form = (fields: Record<string, string>) =>
		new URLSearchParams(fields).toString();

	it("keeps only the query id and variables of the page's own request", () => {
		const captured = parseCapturedGraphqlRequest({
			url: "https://www.facebook.com/api/graphql/",
			method: "POST",
			headers: { "x-asbd-id": "359341", "x-fb-lsd": "secret-lsd" },
			postData: form({
				av: "100476",
				fb_dtsg: "secret-dtsg",
				fb_api_req_friendly_name:
					"ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
				variables: JSON.stringify({
					count: 8,
					cursor: "abc",
					scale: 2,
					search: null,
					id: "YXBwX2NvbGxlY3Rpb246MQ==",
				}),
				doc_id: "24123456789012345",
			}),
		});
		assert.deepEqual(captured, {
			friendlyName:
				"ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
			docId: "24123456789012345",
			variables: {
				count: 8,
				cursor: "abc",
				scale: 2,
				search: null,
				id: "YXBwX2NvbGxlY3Rpb246MQ==",
			},
			asbdId: "359341",
		});
		assert.doesNotMatch(JSON.stringify(captured), /secret/);
	});

	it("ignores other paths, other origins, GETs and mutations", () => {
		const base = {
			url: "https://www.facebook.com/api/graphql/",
			method: "POST",
			headers: {},
			postData: form({
				fb_api_req_friendly_name: "XQuery",
				variables: "{}",
				doc_id: "1234567",
			}),
		};
		assert.ok(parseCapturedGraphqlRequest(base));
		assert.equal(
			parseCapturedGraphqlRequest({
				...base,
				url: "https://www.facebook.com/ajax/bz",
			}),
			null,
		);
		assert.equal(
			parseCapturedGraphqlRequest({
				...base,
				url: "https://evil.example/api/graphql/",
			}),
			null,
		);
		assert.equal(parseCapturedGraphqlRequest({ ...base, method: "GET" }), null);
		assert.equal(
			parseCapturedGraphqlRequest({
				...base,
				postData: form({
					fb_api_req_friendly_name: "CometTS2BitArrayLoggerMutation",
					variables: "{}",
					doc_id: "1234567",
				}),
			}),
			null,
		);
	});

	it("uses the captured template, fills provided variables, and sets the cursor", () => {
		const variables = buildVariables({
			cursor: "c2",
			defaults: { count: 25 },
			overrides: { category_key: "COMMENTSCLUSTER" },
			provided: { __relay_internal__pv__Flagrelayprovider: true, count: 99 },
			template: { count: 10, cursor: "c1", category_key: "LIKEDPOSTS" },
		});
		assert.deepEqual(variables, {
			count: 10,
			cursor: "c2",
			category_key: "COMMENTSCLUSTER",
			__relay_internal__pv__Flagrelayprovider: true,
		});
	});
});
