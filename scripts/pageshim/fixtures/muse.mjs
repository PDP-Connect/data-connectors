// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. Muse serves its data through the web app's gateway client
// (a React context value with `sendRequest` and `gatewayUrl`) over an
// encrypted WebSocket, not over HTTP. The signed-in page here mounts a
// synthetic fiber tree whose provider value answers the same read methods
// with the shapes observed live; the signed-out page has no client. Real
// WebView behavior and the live gateway need a device run.

const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

const chat = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const event = (session, n, role, seq, text) => ({
	agent_id: null,
	display_text: text,
	display_text_ready: true,
	message_id: chat(1000 + n),
	occurred_at_ms: 1792608185000 + n * 1000,
	payload: { content: text, role, session_id: session, source: "runtime", visibility: "public" },
	reply_to_message_id: "",
	role,
	seq,
	visibility: "public",
});

const DATA = {
	sessions: [
		{ archived: false, created_at_ms: 1792607934000, is_primary: true, is_thread: false, pinned: false, session_id: chat(1), snippet: "Synthetic snippet", status: "completed", title: "Main chat", unread_count: 0, updated_at_ms: 1792612428000 },
		{ archived: false, created_at_ms: 1792608473000, is_primary: false, is_thread: true, pinned: false, session_id: chat(2), snippet: "Synthetic thread", status: "completed", title: "Side chat", unread_count: 0, updated_at_ms: 1792610689000 },
	],
	history: {
		[chat(1)]: [event(chat(1), 1, "user", 1, "Hello"), event(chat(1), 2, "assistant", 2, "Hi there")],
		[chat(2)]: [event(chat(2), 3, "user", 1, "A thread question")],
	},
	activity: {
		days: [
			{
				date: "2026-10-21",
				count: 2,
				activities: [
					{ timestamp: "2026-10-21T10:02:14Z", type: "web_search", message_id: chat(1002), title: "Searched the web", status_title: "Done", subtitle: null, details: { items: [] }, status: "success", task_label: "Research" },
					{ timestamp: "2026-10-21T09:58:00Z", type: "reminder_set", message_id: chat(1002), title: "Set a reminder", status_title: "Done", subtitle: null, details: { action: "add", tool: "cron" }, status: "success", task_label: "Reminders" },
				],
			},
		],
	},
	goals: {
		user_goal: { goals: [], warnings: [], pagination: { has_next_page: false } },
		completed: { goals: [], warnings: [], pagination: { has_next_page: false } },
		assistant_tracking: {
			goals: [{ goal_id: "goal_000000000001", source: "assistant_tracking", slug: "stretch", title: "Stretch daily", status: "active", summary: "Synthetic summary", description: "Synthetic description", momentum: "", momentum_status: "on_track", created_at: "2026-10-20T10:05:35Z", updated_at: "2026-10-21T10:06:42Z", last_activity_at: "2026-10-21T10:07:49Z", pushable: true, emoji: "*", sort_order: 0, is_thread: false }],
			warnings: [],
			pagination: { has_next_page: false },
		},
	},
	tasks: {
		schedules: [{ id: "stretch-reminder", title: "Stretch", path: "cron/stretch.json", schedule_key: "stretch", mode: "task", enabled: true, execution_target: "main", is_heartbeat: false, next_run_at_utc: 1792684800, timezone: "UTC", cadence: { kind: "runonce", run_at_utc: 1792684800 } }],
		invalid: [],
	},
	root: {
		path: "",
		entries: [
			{ name: "MEMORY.md", type: "file", size: 24, modifiedAt: "2026-10-21T10:02:14.123Z" },
			{ name: "USER.md", type: "file", size: 18, modifiedAt: "2026-10-21T10:03:14.123Z" },
			{ name: "notes", type: "directory", modifiedAt: "2026-10-21T10:04:14.123Z" },
		],
	},
	files: { "MEMORY.md": "# Memory\n- likes tea\n", "USER.md": "# User\nSynthetic\n" },
	library: {
		entries: [
			{ name: "plan.md", path: "notes/plan.md", size: 488, modified_ms: 1792612228050 },
			{ name: "list.md", path: "notes/list.md", size: 253, modified_ms: 1792608283653 },
		],
		total: 2,
		has_more: false,
	},
	connectors: {
		connectors: [
			{ id: "browser", name: "Browser", description: "Synthetic", icon: "browser", icon_url: "https://muse.ai/icon.png", supports_multiple_accounts: false, is_custom: false, management_kind: "policy_only", needs_reauth: false, state: "connected" },
			{ id: "asana", name: "Asana", description: "Synthetic", icon: "asana", icon_url: "https://muse.ai/icon.png", supports_multiple_accounts: true, is_custom: false, management_kind: "auth", needs_reauth: false, state: "disconnected" },
		],
	},
};

// Runs in the page. Builds the synthetic gateway and hangs a fiber tree off
// #root the way React does (an expando `__reactFiber$...` key).
function mountGateway(data) {
	const answer = (method, params) => {
		switch (method) {
			case "sessions.list":
				return { sessions: params && params.view === "archived" ? [] : data.sessions };
			case "chat.history":
				return { channel: "all", chat_events: data.history[params.session_id] || [], has_more: false, transcript_revision: 1 };
			case "activity.list":
				return params && params.before ? { days: [] } : data.activity;
			case "goals.list":
				return data.goals[params.source || params.status];
			case "tasks.list":
				return data.tasks;
			case "fs.list":
				return data.root;
			case "fs.raw":
				return new Blob([data.files[params.path]], { type: "text/markdown" });
			case "fs.library":
				return data.library;
			case "connectors.list":
				return data.connectors;
			default:
				throw new Error(`synthetic gateway refuses ${method}`);
		}
	};
	const value = {
		gatewayUrl: "wss://example.invalid/v1/noise",
		isReady: true,
		sendRequest: async (method, params) => answer(method, params),
	};
	const provider = { memoizedProps: { value }, child: null, sibling: null };
	const root = { memoizedProps: {}, child: provider, sibling: null, return: null };
	const leaf = { memoizedProps: {}, child: null, sibling: null, return: root };
	document.getElementById("root")["__reactFiber$synthetic"] = leaf;
}

let loggedIn = true;
const appPage = () =>
	loggedIn
		? html(`<div id="root">Muse</div><script>(${mountGateway.toString()})(${JSON.stringify(DATA)})</script>`)
		: html('<form action="https://auth.muse.ai/aymh/"><button>Continue with Meta</button></form>');

export const museFixtures = {
	hosts: /^https:\/\/muse\.ai\//,
	loginUrl: "https://muse.ai/",
	homeUrl: "https://muse.ai/",
	resolve: () => appPage(),
	async setLoggedIn(value, page) {
		loggedIn = value;
		if (page) await page.reload({ waitUntil: "load" });
	},
};

export const pageshimCase = {
	fixtures: museFixtures,
	partialErrors: [
		{
			errorClass: "partial",
			reason: "Muse chat inventory is incomplete: active and archived lists are independent reads without an authoritative all-status snapshot. Readable chats were imported, but conversations and messages are not checkpointed as complete.",
			disposition: "degraded",
			scope: "muse.conversations",
			phase: "collect",
			code: "stream_collection_failed",
			recovery_hint: { action: "retry_by_runtime", retryable: false },
		},
		{
			errorClass: "partial",
			reason: "Muse chat inventory is incomplete: active and archived lists are independent reads without an authoritative all-status snapshot. Readable chats were imported, but conversations and messages are not checkpointed as complete.",
			disposition: "degraded",
			scope: "muse.messages",
			phase: "collect",
			code: "stream_collection_failed",
			recovery_hint: { action: "retry_by_runtime", retryable: false },
		},
	],
	scopes: [
		"muse.conversations",
		"muse.messages",
		"muse.activities",
		"muse.goals",
		"muse.scheduled_tasks",
		"muse.memory_files",
		"muse.files",
		"muse.connected_apps",
	],
	exportSummary: {
		count: 14,
		label: "records",
		details: { conversations: 2, messages: 3, activities: 2, goals: 1, scheduled_tasks: 1, memory_files: 2, files: 2, connected_apps: 1 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { conversations: 0, messages: 0, activities: 0, goals: 0, scheduled_tasks: 0, memory_files: 0, files: 0, connected_apps: 0 },
	},
};
