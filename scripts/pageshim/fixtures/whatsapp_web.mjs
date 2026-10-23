// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. WhatsApp Web has no JSON API: the client decrypts its own
// socket traffic in the page and keeps the result in its own data layer,
// which the connector reads through the page's module loader
// (`window.require`). The signed-in page here installs a synthetic loader
// whose modules answer the same reads (WAWebCollections, the local message
// store's msgFindBefore, the owner's own user) with the shapes the client's
// models have; the signed-out page has no loader. Every value is invented.
// Real WebView behavior and the live client need a device run.

const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

const OWNER = "15550000000@c.us";
const PEER = "15550000001@c.us";
const MEMBER = "15550000002@c.us";
const GROUP = "120363000000000001@g.us";

const message = (chat, n, fromMe, text, t, author = null) => ({
	chat,
	key: `SYNTHETIC${String(n).padStart(6, "0")}`,
	fromMe,
	author,
	type: "chat",
	body: text,
	t,
	ack: fromMe ? 3 : 0,
});

// Each chat's messages, oldest first. `inMemory` is how many of the newest
// the client holds in memory; the rest are only in the local store.
const DATA = {
	owner: OWNER,
	chats: [
		{
			id: PEER,
			server: "c.us",
			title: "Synthetic Peer",
			t: 1792608300,
			unread: 1,
			inMemory: 2,
			messages: [
				message(PEER, 1, false, "Synthetic hello", 1792608100),
				message(PEER, 2, true, "Synthetic reply", 1792608200),
				message(PEER, 3, false, "Synthetic follow-up", 1792608300),
			],
		},
		{
			id: GROUP,
			server: "g.us",
			title: "Synthetic Group",
			t: 1792608400,
			unread: 0,
			inMemory: 1,
			messages: [message(GROUP, 4, false, "Synthetic group note", 1792608400, MEMBER)],
		},
	],
	contacts: [
		{ id: PEER, name: "Synthetic Peer", pushname: "Peer" },
		{ id: MEMBER, name: null, pushname: "Member" },
		{ id: OWNER, name: null, pushname: "Owner" },
	],
	groups: [
		{
			id: GROUP,
			subject: "Synthetic Group",
			creation: 1792000000,
			owner: OWNER,
			participants: [
				{ id: OWNER, isAdmin: true, isSuperAdmin: true },
				{ id: MEMBER, isAdmin: false, isSuperAdmin: false },
			],
		},
	],
};

// Runs in the page. Builds the synthetic module loader on window.
function installClient(data) {
	const wid = (serialized) => ({
		_serialized: serialized,
		server: serialized.split("@")[1],
		toString: () => serialized,
	});
	const collection = (models) => ({
		getModelsArray: () => models.slice(),
		get: (id) => models.find((m) => m.id._serialized === id),
	});
	const msgModel = (m) => {
		const serialized = `${m.fromMe}_${m.chat}_${m.key}`;
		return {
			id: { fromMe: m.fromMe, remote: wid(m.chat), id: m.key, _serialized: serialized, toString: () => serialized },
			author: m.author ? wid(m.author) : undefined,
			type: m.type,
			body: m.body,
			t: m.t,
			ack: m.ack,
		};
	};
	const stores = new Map();
	const chats = data.chats.map((c) => {
		const all = c.messages.map(msgModel);
		stores.set(c.id, all);
		return {
			id: wid(c.id),
			formattedTitle: c.title,
			t: c.t,
			archive: false,
			pin: undefined,
			muteExpiration: 0,
			unreadCount: c.unread,
			isReadOnly: false,
			endOfHistoryTransferType: 1,
			msgs: collection(all.slice(all.length - c.inMemory)),
		};
	});
	const contacts = data.contacts.map((c) => ({ id: wid(c.id), name: c.name, pushname: c.pushname, isBusiness: false }));
	const groups = data.groups.map((g) => ({
		id: wid(g.id),
		subject: g.subject,
		creation: g.creation,
		owner: wid(g.owner),
		announce: false,
		restrict: false,
		participants: collection(g.participants.map((p) => ({ id: wid(p.id), isAdmin: p.isAdmin, isSuperAdmin: p.isSuperAdmin }))),
	}));
	// The local store answers up to `count` messages strictly before the
	// anchor, oldest first, the way the client's own store does.
	const msgFindBefore = async ({ anchor, count }) => {
		const all = stores.get(anchor.remote._serialized) || [];
		const at = all.findIndex((m) => m.id._serialized === anchor._serialized);
		if (at < 0) return { status: 404, messages: [] };
		return { status: 200, messages: all.slice(Math.max(0, at - count), at) };
	};
	const modules = {
		WAWebCollections: {
			Chat: collection(chats),
			Contact: collection(contacts),
			WAWebGroupMetadataCollection: collection(groups),
		},
		WAWebDBMessageFindLocal: { msgFindBefore },
		WAWebChatConstants: {
			ConversationEndOfHistoryTransferModelPropType: {
				COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY: 0,
				COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY: 1,
				INCOMPLETE: 2,
				NOT_INCLUDED_IN_HIST_SYNC: 3,
				COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY: 4,
				COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS: 5,
			},
		},
		WAWebUserPrefsMeUser: {
			getMaybeMePnUser: () => wid(data.owner),
			getMaybeMeLidUser: () => null,
		},
		// Every synthetic chat's history is complete on this device, so the
		// connector never asks the phone for more; a request would fail here.
		WAWebSyncGatingUtils: { isHistorySyncOnDemandEnabled: () => false },
		WAWebSendNonMessageDataRequest: {
			sendPeerDataOperationRequest: async () => {
				throw new Error("synthetic client refuses the on-demand history request");
			},
		},
	};
	window.require = (name) => {
		if (!(name in modules)) throw new Error(`synthetic client has no module ${name}`);
		return modules[name];
	};
}

let loggedIn = true;
const appPage = () =>
	loggedIn
		? html(`<div id="app">WhatsApp</div><script>(${installClient.toString()})(${JSON.stringify(DATA)})</script>`)
		: html('<div id="app"><canvas aria-label="Scan this QR code to link a device"></canvas></div>');

export const whatsappWebFixtures = {
	hosts: /^https:\/\/web\.whatsapp\.com\//,
	loginUrl: "https://web.whatsapp.com/",
	homeUrl: "https://web.whatsapp.com/",
	resolve: () => appPage(),
	async setLoggedIn(value, page) {
		loggedIn = value;
		if (page) await page.reload({ waitUntil: "load" });
	},
};

export const pageshimCase = {
	fixtures: whatsappWebFixtures,
	scopes: [
		"whatsapp_web.chats",
		"whatsapp_web.messages",
		"whatsapp_web.contacts",
		"whatsapp_web.groups",
	],
	exportSummary: {
		count: 10,
		label: "records",
		details: { chats: 2, messages: 4, contacts: 3, groups: 1 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { chats: 0, messages: 0, contacts: 0, groups: 0 },
	},
};
