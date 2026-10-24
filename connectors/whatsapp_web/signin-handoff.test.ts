// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sign-in handoff: a tab on WhatsApp Web's QR screen is handed to the person
 * to link it from their phone, never failed outright. Synthetic pages only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
	ensureSession,
	type SessionTimings,
	WHATSAPP_LOGIN_MESSAGE,
} from "./index.ts";

const FAST: SessionTimings = {
	bootAttempts: 3,
	bootMs: 0,
	handoffProbeMs: 1,
	handoffTimeoutSeconds: 5,
};

interface FakeApp {
	/** Reads that show the QR screen before a phone links it (Infinity: never). */
	qrReads: number;
}

function fakeWhatsAppPage(startUrl: string, app: FakeApp) {
	let url = startUrl;
	const gotos: string[] = [];
	let reads = 0;
	const signedIn = () => reads > app.qrReads;
	const sandbox = vm.createContext({
		get location() {
			return { origin: new URL(url).origin };
		},
		document: { querySelector: () => null },
		window: {
			require: (name: string) => {
				if (name === "WAWebUserPrefsMeUser") {
					return {
						getMaybeMePnUser: () =>
							signedIn() ? { _serialized: "15550000000@c.us" } : null,
						getMaybeMeLidUser: () => null,
					};
				}
				if (name === "WAWebStreamModel") {
					return { Stream: { mode: signedIn() ? "MAIN" : "QR" } };
				}
				throw new Error(`no module ${name}`);
			},
		},
	});
	const page = {
		url: () => url,
		goto: async (next: string) => {
			gotos.push(next);
			url = next;
			return null;
		},
		evaluate: async (script: unknown) => {
			reads += 1;
			return await vm.runInContext(String(script), sandbox);
		},
		context: () => ({
			newPage: async () => {
				throw new Error("the connector must never open a second tab");
			},
		}),
	};
	return { gotos, page };
}

function handoff() {
	const assists: string[] = [];
	const completions: string[] = [];
	return {
		assists,
		completions,
		hooks: {
			assist: async (req: { message: string }) => {
				assists.push(req.message);
				return "whatsapp_handoff";
			},
			capture: null,
			completeAssistance: async (_id: string, status: string) => {
				completions.push(status);
			},
			sendInteraction: async () => {
				throw new Error("unexpected manual action fallback");
			},
		},
	};
}

type EnsureArgs = Parameters<typeof ensureSession>[0];

test("signin handoff: the QR screen is handed to the person, and collection waits until a phone links the browser", async () => {
	const { gotos, page } = fakeWhatsAppPage("about:blank", { qrReads: 6 });
	const h = handoff();
	await ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, FAST);
	assert.deepEqual(gotos, ["https://web.whatsapp.com/"], "one page, opened once");
	assert.deepEqual(h.assists, [WHATSAPP_LOGIN_MESSAGE]);
	assert.match(h.assists[0] ?? "", /Linked devices/);
	assert.deepEqual(h.completions, ["resolved"]);
});

test("signin handoff: a signed-in page goes straight to collection, with no handoff and no navigation", async () => {
	const { gotos, page } = fakeWhatsAppPage("https://web.whatsapp.com/", {
		qrReads: 0,
	});
	const h = handoff();
	await ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, FAST);
	assert.deepEqual(gotos, []);
	assert.deepEqual(h.assists, []);
});

test("signin handoff: when no one links the browser before the window closes, the run fails as whatsapp_web_auth_failed", async () => {
	const { page } = fakeWhatsAppPage("https://web.whatsapp.com/", {
		qrReads: Number.POSITIVE_INFINITY,
	});
	const h = handoff();
	await assert.rejects(
		ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, {
			...FAST,
			handoffTimeoutSeconds: 0,
		}),
		(error: unknown) => {
			assert.match(String((error as Error).message), /QR code/);
			assert.equal((error as { code?: string }).code, "whatsapp_web_auth_failed");
			return true;
		},
	);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["escalated"]);
});
