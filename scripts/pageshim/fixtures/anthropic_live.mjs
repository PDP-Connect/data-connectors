// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves synthetic claude.ai session-API responses for the PageShim harness.
const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});
const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

const ORG = "00000000-0000-4000-8000-0000000000f1";
const CONVERSATION = "00000000-0000-4000-8000-0000000000c1";
const O = `/api/organizations/${ORG}`;

let loggedIn = true;
export const setLoggedIn = (value) => {
	loggedIn = value;
};

// Inside the harness's default 30-day window; fixed for the process so two
// runs return identical records.
const loadedAt = Date.now();
const minutesAgo = (minutes) =>
	new Date(loadedAt - minutes * 60_000).toISOString();

function conversation() {
	return {
		uuid: CONVERSATION,
		name: "Synthetic conversation",
		summary: "",
		model: "claude-sonnet-4-6",
		created_at: minutesAgo(60),
		updated_at: minutesAgo(30),
		is_starred: false,
		project_uuid: null,
	};
}

function messages() {
	return [
		{
			uuid: "00000000-0000-4000-8000-0000000000a1",
			text: "",
			content: [{ type: "text", text: "Synthetic question" }],
			sender: "human",
			created_at: minutesAgo(60),
			updated_at: minutesAgo(60),
			attachments: [],
			parent_message_uuid: "00000000-0000-4000-8000-000000000000",
		},
		{
			uuid: "00000000-0000-4000-8000-0000000000a2",
			text: "",
			content: [{ type: "text", text: "Synthetic answer" }],
			sender: "assistant",
			created_at: minutesAgo(30),
			updated_at: minutesAgo(30),
			attachments: [],
			parent_message_uuid: "00000000-0000-4000-8000-0000000000a1",
		},
	];
}

export function resolveFixture(raw) {
	const url = new URL(raw);
	const p = url.pathname;
	if (p === "/login") return html('<form><input name="email"></form>');
	if (!p.startsWith("/api/")) return html();
	if (!loggedIn) return json({ error: "unauthorized" }, 401);
	if (p === "/api/organizations") {
		return json([
			{
				uuid: ORG,
				capabilities: ["claude_max", "chat"],
				rate_limit_tier: "default_claude_max_20x",
				billing_type: "stripe_subscription",
				created_at: "2025-03-01T12:00:00.000000Z",
			},
		]);
	}
	if (p === `${O}/subscription_details`) {
		return json({
			status: "active",
			billing_interval: "monthly",
			next_charge_at: "2026-12-01T12:00:00Z",
			plan_ending_at: null,
		});
	}
	if (p === `${O}/usage`) {
		return json({
			limits: [
				{
					kind: "session",
					group: "session",
					percent: 2,
					severity: "normal",
					resets_at: "2026-12-01T12:00:00Z",
					scope: null,
					is_active: false,
				},
			],
		});
	}
	if (p === `${O}/chat_conversations`) {
		return json(url.searchParams.get("offset") === "0" ? [conversation()] : []);
	}
	if (p === `${O}/chat_conversations/${CONVERSATION}`) {
		return json({ ...conversation(), chat_messages: messages() });
	}
	return json({ error: "not found" }, 404);
}

export const anthropicLiveFixtures = {
	hosts: /^https:\/\/claude\.ai\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://claude.ai/login",
	homeUrl: "https://claude.ai/new",
};

export const pageshimCase = {
	fixtures: anthropicLiveFixtures,
	scopes: [
		"claude_live.conversations",
		"claude_live.messages",
		"claude_live.account_plan",
		"claude_live.usage_limits",
	],
	exportSummary: {
		count: 1,
		label: "conversation",
		details: { conversations: 1, messages: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "conversations",
		details: { conversations: 0, messages: 0 },
	},
};
