// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves synthetic character.ai pages and neo.character.ai API responses for
// the PageShim harness. Synthetic values only; the shapes follow the
// connector's __fixtures__ (GET /chats/recent/, GET /turns/:chat_id/, GET /user/).
// CORS is fulfilled by the harness.
const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});

let loggedIn = true;
export const setLoggedIn = (value) => {
	loggedIn = value;
};

const TOKEN = "synthetic-character-ai-token";
const CHAT_ID = "00000000-0000-4000-8000-000000000a01";

// The signed-in page carries its API token in the Next.js bootstrap data;
// a signed-out page does not.
const page = () => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
		props: { pageProps: loggedIn ? { token: TOKEN } : {} },
	})}</script>Character.AI fixture</body></html>`,
});

const chats = {
	chats: [
		{
			chat_id: CHAT_ID,
			create_time: "2026-10-01T10:00:00.123456Z",
			creator_id: "100001",
			character_id: "SyntheticCharacterId_000000000000000000001",
			state: "STATE_ACTIVE",
			type: "TYPE_ONE_ON_ONE",
			visibility: "VISIBILITY_PRIVATE",
			character_name: "Synthetic Character",
			character_avatar_uri: "",
			character_visibility: "PUBLIC",
			character_translations: { name: {} },
			default_voice_id: null,
			lorebook_id: null,
		},
	],
	meta: { next_token: "" },
};

const turns = {
	turns: [
		{
			turn_key: { chat_id: CHAT_ID, turn_id: "00000000-0000-4000-8000-000000000b01" },
			create_time: "2026-10-01T10:00:00.123456Z",
			last_update_time: "2026-10-01T10:00:00.123456Z",
			state: "STATE_OK",
			author: { author_id: "SyntheticCharacterId_000000000000000000001", name: "Synthetic Character" },
			candidates: [
				{
					candidate_id: "00000000-0000-4000-8000-000000000c01",
					create_time: "2026-10-01T10:00:00.123456Z",
					raw_content: "Hello from a synthetic character.",
					is_final: true,
					model_type: "MODEL_TYPE_PIPSQUEAK_3",
				},
			],
			primary_candidate_id: "00000000-0000-4000-8000-000000000c01",
		},
		{
			turn_key: { chat_id: CHAT_ID, turn_id: "00000000-0000-4000-8000-000000000b02" },
			create_time: "2026-10-01T10:01:00.123456Z",
			last_update_time: "2026-10-01T10:01:00.123456Z",
			state: "STATE_OK",
			author: { author_id: "100001", is_human: true, name: "Synthetic Owner" },
			candidates: [
				{
					candidate_id: "00000000-0000-4000-8000-000000000c02",
					create_time: "2026-10-01T10:01:00.123456Z",
					raw_content: "Hi, synthetic character.",
					is_final: true,
				},
			],
			primary_candidate_id: "00000000-0000-4000-8000-000000000c02",
		},
	],
	meta: { next_token: "synthetic-turns-page-2" },
};

export const requests = [];

export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	if (url.hostname !== "neo.character.ai") return page();
	if (request.method === "OPTIONS") return { status: 204, contentType: "text/plain", body: "" };
	requests.push({ path: url.pathname, search: url.search });
	if (!loggedIn || request.headers?.authorization !== `Token ${TOKEN}`) {
		return json({ detail: "Authentication credentials were not provided." }, 401);
	}
	if (url.pathname === "/user/") return json({ user: { user: { username: "synthetic-owner", id: 100001 } } });
	if (url.pathname === "/chats/recent/") return json(chats);
	if (url.pathname === `/turns/${CHAT_ID}/`) {
		return url.searchParams.get("next_token") === "synthetic-turns-page-2"
			? json({ turns: [], meta: { next_token: "" } })
			: json(turns);
	}
	return json({ detail: "Not found" }, 404);
}

export const characterAiFixtures = {
	hosts: /^https:\/\/(?:neo\.)?character\.ai\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://character.ai/",
	homeUrl: "https://character.ai/",
};

export const pageshimCase = {
	fixtures: characterAiFixtures,
	scopes: ["character_ai.chats", "character_ai.messages"],
	exportSummary: {
		count: 3,
		label: "records",
		details: { chats: 1, messages: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { chats: 0, messages: 0 },
	},
};
