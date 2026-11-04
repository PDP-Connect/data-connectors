// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import type {
	InteractionRequest,
	InteractionResponse,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	CONNECTOR_CONFIG,
	ensureGoodreadsSession,
	LOGIN_URL,
	SIGN_IN_MESSAGE,
} from "./index.ts";
import {
	attemptAutomaticSignIn,
	classifySignInSurface,
	fallbackExplanation,
	fallbackHandoffReason,
	GOODREADS_LOGIN_FIELDS,
	type SignInObservation,
} from "./sign-in.ts";

const ORIGIN = "https://www.goodreads.com";
// Synthetic values: none of this belongs to a real account.
const EMAIL = "reader@example.test";
const PASSWORD = "synthetic-passphrase-0";
const CREDENTIALS = {
	GOODREADS_PASSWORD: PASSWORD,
	GOODREADS_USERNAME: EMAIL,
};

// ─── A fake goodreads.com sign-in ────────────────────────────────────────

type Key =
	| "captcha"
	| "code"
	| "codeSubmit"
	| "email"
	| "emailLink"
	| "error"
	| "password"
	| "remember"
	| "rememberDevice"
	| "submit";

interface Screen {
	readonly body?: string;
	readonly url: string;
	readonly visible?: readonly Key[];
}

const SCREENS = {
	captcha: {
		body: "Enter the characters you see below",
		url: `${ORIGIN}/ap/signin`,
		visible: ["captcha", "password"],
	},
	form: {
		url: `${ORIGIN}/ap/signin`,
		visible: ["email", "password", "submit", "remember"],
	},
	home: { body: "Your home feed", url: `${ORIGIN}/` },
	landing: { url: `${ORIGIN}/user/sign_in`, visible: ["emailLink"] },
	approve: {
		body: "Approve the notification sent to your device",
		url: `${ORIGIN}/ap/cvf/transactionapproval`,
	},
	otp: {
		url: `${ORIGIN}/ap/mfa`,
		visible: ["code", "codeSubmit", "rememberDevice"],
	},
	otpRejected: {
		url: `${ORIGIN}/ap/mfa`,
		visible: ["code", "codeSubmit", "rememberDevice", "error"],
	},
	rejected: {
		url: `${ORIGIN}/ap/signin`,
		visible: ["email", "password", "submit", "error"],
	},
	unrecognized: { url: "https://www.example.test/elsewhere" },
	rejectedAgain: {
		url: `${ORIGIN}/ap/signin/136-0000000-0000000`,
		visible: ["email", "password", "submit", "error"],
	},
	foreignForm: {
		url: "https://www.example.test/ap/signin",
		visible: ["email", "password", "submit", "remember"],
	},
} satisfies Record<string, Screen>;

type ScreenName = keyof typeof SCREENS;

interface World {
	checked: boolean;
	deviceRemembered: boolean;
	readonly clicks: Key[];
	readonly filled: Record<string, string>;
	readonly gotos: string[];
	now: number;
	screen: ScreenName;
	signedIn: boolean;
}

interface Script {
	/** Where the email link leads; `landing` models a page without the form. */
	readonly afterEmailLink?: ScreenName;
	/** Where sending the verification code leads; `home` by default. */
	readonly afterCode?: ScreenName;
	/** Where the submit leads. */
	readonly afterSubmit: ScreenName;
	/** The submit click moves the page, then throws (a navigation race). */
	readonly clickThrows?: boolean;
	/** Typing into the form throws (an overlay, a detached node). */
	readonly fillThrows?: boolean;
}

function keysOf(selector: string): Key[] {
	const keys: Key[] = [];
	const table: [string, Key][] = [
		["Sign in with email", "emailLink"],
		["ap_email", "email"],
		["ap_password", "password"],
		["signInSubmit", "submit"],
		["auth-remember-me", "remember"],
		["auth-mfa-remember-device", "rememberDevice"],
		["auth-signin-button", "codeSubmit"],
		["auth-error-message-box", "error"],
		["captcha", "captcha"],
		["otpCode", "code"],
	];
	for (const [needle, key] of table) {
		if (selector.includes(needle)) keys.push(key);
	}
	return keys;
}

function makeSignIn(script: Script, start: ScreenName = "landing") {
	const world: World = {
		checked: false,
		deviceRemembered: false,
		clicks: [],
		filled: {},
		gotos: [],
		now: 0,
		screen: start,
		signedIn: start === "home",
	};
	const screen = (): Screen => SCREENS[world.screen];
	const visible = (keys: Key[]): boolean =>
		keys.some((key) =>
			(screen().visible as readonly Key[] | undefined)?.includes(key),
		);
	const locator = (selector: string) => {
		const keys = keysOf(selector);
		const self = {
			check: async () => {
				if (keys[0] === "rememberDevice") world.deviceRemembered = true;
				else world.checked = true;
			},
			click: async () => {
				const key = keys[0] as Key;
				world.clicks.push(key);
				if (key === "emailLink") {
					world.screen = script.afterEmailLink ?? "form";
				} else if (key === "submit") {
					world.screen = script.afterSubmit;
					world.signedIn = script.afterSubmit === "home";
					if (script.clickThrows) throw new Error("Target closed");
				} else if (key === "codeSubmit") {
					world.screen = script.afterCode ?? "home";
					world.signedIn = world.screen === "home";
				}
			},
			count: async () => (selector === "body" || visible(keys) ? 1 : 0),
			fill: async (value: string) => {
				if (script.fillThrows) throw new Error("Element is not attached");
				world.filled[keys[0] as string] = value;
			},
			first: () => self,
			innerText: async () => screen().body ?? "",
			isChecked: async () =>
				keys[0] === "rememberDevice" ? world.deviceRemembered : world.checked,
			isVisible: async () => selector === "body" || visible(keys),
			nth: () => self,
		};
		return self;
	};
	const page = {
		context: () => ({
			request: {
				get: async () => ({
					dispose: async () => undefined,
					headers: () => ({
						location: world.signedIn
							? `/review/list/90000001-synthetic-reader`
							: `${ORIGIN}/user/sign_in?returnurl=%2Freview%2Flist`,
					}),
					status: () => 302,
					url: () => `${ORIGIN}/review/list`,
				}),
			},
		}),
		evaluate: async () => null,
		goto: async (url: string) => {
			world.gotos.push(url);
			if (world.screen !== "form") world.screen = "landing";
		},
		locator,
		url: () => screen().url,
		waitForTimeout: async (ms: number) => {
			world.now += ms;
		},
	};
	const clock = {
		now: () => world.now,
		wait: async (ms: number) => {
			world.now += ms;
		},
	};
	return { clock, page, world };
}

function makeHandoff(
	world: World,
	{ code, ownerSignsIn }: { code: string | null; ownerSignsIn: boolean },
) {
	const requests: InteractionRequest[] = [];
	return {
		requests,
		sendInteraction: async (
			request: InteractionRequest,
		): Promise<InteractionResponse> => {
			requests.push(request);
			// A code question is answered on the run page; the browser is untouched.
			if (request.kind === "otp") {
				return code === null
					? {
							request_id: request.request_id ?? "test",
							status: "cancelled",
							type: "INTERACTION_RESPONSE",
						}
					: {
							data: { code },
							request_id: request.request_id ?? "test",
							status: "success",
							type: "INTERACTION_RESPONSE",
						};
			}
			if (ownerSignsIn) {
				world.signedIn = true;
				world.screen = "home";
			}
			return {
				request_id: request.request_id ?? "test",
				status: "success",
				type: "INTERACTION_RESPONSE",
			};
		},
	};
}

interface Spy {
	checkpoints: string[];
	submitted: number;
	args: {
		checkpoint: (name: string) => Promise<void>;
		onCredentialSubmit: () => void;
	};
}

function makeSpy(): Spy {
	const spy: Spy = {
		args: {
			checkpoint: async (name: string) => {
				spy.checkpoints.push(name);
			},
			onCredentialSubmit: () => {
				spy.submitted += 1;
			},
		},
		checkpoints: [],
		submitted: 0,
	};
	return spy;
}

async function runEnsure(
	script: Script,
	credentials: Record<string, string>,
	{
		code = null as string | null,
		ownerSignsIn = true,
		start = "landing" as ScreenName,
	} = {},
) {
	const fake = makeSignIn(script, start);
	const handoff = makeHandoff(fake.world, { code, ownerSignsIn });
	const spy = makeSpy();
	let error: unknown;
	// The session hook times its waits with Date.now; drive that from the
	// fake page's own clock so a long wait costs no real time.
	const clock = mock.method(Date, "now", () => fake.world.now);
	try {
		await ensureGoodreadsSession({
			...spy.args,
			credentials,
			page: fake.page,
			sendInteraction: handoff.sendInteraction,
		} as never);
	} catch (caught) {
		error = caught;
	} finally {
		clock.mock.restore();
	}
	return { ...fake, error, handoff, spy };
}

const submits = (world: World): number =>
	world.clicks.filter((key) => key === "submit").length;

/** Credential values must not reach any owner-facing or diagnostic text. */
function assertNoSecrets(texts: unknown): void {
	const dump = JSON.stringify(texts);
	assert.equal(dump.includes(PASSWORD), false, "password leaked");
	assert.equal(dump.includes(EMAIL), false, "email leaked");
}

// ─── Decision logic through the connector's own session hook ─────────────

test("no saved sign-in: straight to the browser handoff, nothing typed", async () => {
	const run = await runEnsure({ afterSubmit: "home" }, {});
	assert.equal(run.error, undefined);
	assert.equal(run.handoff.requests.length, 1);
	assert.equal(run.handoff.requests[0]?.kind, "manual_action");
	assert.equal(run.handoff.requests[0]?.message, SIGN_IN_MESSAGE);
	assert.deepEqual(run.world.filled, {});
	assert.equal(submits(run.world), 0);
	assert.equal(run.spy.submitted, 0);
	assert.deepEqual(run.world.gotos, [LOGIN_URL]);
});

test("half a saved pair is not submitted: handoff, nothing typed", async () => {
	for (const partial of [
		{ GOODREADS_USERNAME: EMAIL },
		{ GOODREADS_PASSWORD: PASSWORD },
		{ GOODREADS_USERNAME: EMAIL, GOODREADS_PASSWORD: "   " },
	]) {
		const run = await runEnsure({ afterSubmit: "home" }, partial);
		assert.equal(run.handoff.requests.length, 1);
		assert.deepEqual(run.world.filled, {});
		assert.equal(run.spy.submitted, 0);
	}
});

test("a live session is used first: saved credentials are not touched", async () => {
	const run = await runEnsure({ afterSubmit: "home" }, CREDENTIALS, {
		start: "home",
	});
	assert.equal(run.error, undefined);
	assert.equal(run.handoff.requests.length, 0);
	assert.deepEqual(run.world.filled, {});
	assert.equal(run.spy.submitted, 0);
	assert.deepEqual(run.world.gotos, []);
});

test("saved sign-in accepted: signed in with no handoff, one submit", async () => {
	const run = await runEnsure({ afterSubmit: "home" }, CREDENTIALS);
	assert.equal(run.error, undefined);
	assert.equal(run.handoff.requests.length, 0);
	assert.deepEqual(run.world.filled, { email: EMAIL, password: PASSWORD });
	assert.equal(run.world.checked, true, "Keep me signed in is ticked");
	assert.equal(submits(run.world), 1);
	assert.equal(run.spy.submitted, 1);
	assertNoSecrets(run.spy.checkpoints);
});

test("a CAPTCHA after submit falls back to the handoff with a captcha reason, no second submit", async () => {
	const run = await runEnsure({ afterSubmit: "captcha" }, CREDENTIALS);
	assert.equal(run.error, undefined);
	assert.equal(submits(run.world), 1);
	assert.equal(run.handoff.requests.length, 1);
	const message = run.handoff.requests[0]?.message ?? "";
	assert.match(message, /CAPTCHA/);
	assert.ok(message.endsWith(SIGN_IN_MESSAGE));
	assert.equal(run.world.gotos.length, 1, "the CAPTCHA page is left in place");
	assertNoSecrets([message, run.spy.checkpoints]);
});

const CODE = "424242";
const kinds = (run: { handoff: { requests: InteractionRequest[] } }) =>
	run.handoff.requests.map((request) => request.kind);
const codeSubmits = (world: World): number =>
	world.clicks.filter((key) => key === "codeSubmit").length;

test("a verification-code page asks for the code on the run page and sends it once", async () => {
	const run = await runEnsure({ afterSubmit: "otp" }, CREDENTIALS, {
		code: CODE,
	});
	assert.equal(run.error, undefined);
	// No browser handoff: the run page asked, the connector typed.
	assert.deepEqual(kinds(run), ["otp"]);
	assert.match(run.handoff.requests[0]?.message ?? "", /verification code/);
	assert.equal(run.world.filled.code, CODE);
	assert.equal(run.world.deviceRemembered, true, "this browser is remembered");
	assert.equal(submits(run.world), 1);
	assert.equal(codeSubmits(run.world), 1);
	assert.ok(run.spy.checkpoints.includes("goodreads-signin-code-submitted"));
	assert.equal(JSON.stringify(run.spy.checkpoints).includes(CODE), false);
	assertNoSecrets(run.handoff.requests);
});

test("no code, or an answer that is not a code: nothing is typed and the code page is handed off", async () => {
	for (const code of [null, "12ab", " "]) {
		const run = await runEnsure({ afterSubmit: "otp" }, CREDENTIALS, {
			code,
		});
		assert.equal(run.error, undefined);
		assert.deepEqual(kinds(run), ["otp", "manual_action"], String(code));
		assert.equal(run.world.filled.code, undefined);
		assert.equal(codeSubmits(run.world), 0);
		assert.match(run.handoff.requests[1]?.message ?? "", /verification code/);
		assert.equal(run.world.gotos.length, 1, "the code page is left in place");
	}
});

test("a rejected code is named and handed off; the code is sent once only", async () => {
	const run = await runEnsure(
		{ afterCode: "otpRejected", afterSubmit: "otp" },
		CREDENTIALS,
		{ code: CODE },
	);
	assert.equal(run.error, undefined);
	assert.deepEqual(kinds(run), ["otp", "manual_action"]);
	assert.equal(codeSubmits(run.world), 1);
	const message = run.handoff.requests[1]?.message ?? "";
	assert.match(message, /did not accept the verification code/);
	assert.equal(message.includes(CODE), false);
	assert.equal(run.world.gotos.length, 1, "the code page is left in place");
});

test("an approval page without a code field goes straight to the handoff", async () => {
	const run = await runEnsure({ afterSubmit: "approve" }, CREDENTIALS, {
		code: CODE,
	});
	assert.equal(run.error, undefined);
	assert.deepEqual(kinds(run), ["manual_action"]);
	assert.equal(submits(run.world), 1);
	assert.match(
		run.handoff.requests[0]?.message ?? "",
		/verification code or an approval/,
	);
	assertNoSecrets(run.handoff.requests);
});

test("without a way to ask, a code page falls back as before", async () => {
	const run = attempt({ afterSubmit: "otp" });
	assert.deepEqual(await run.outcome, {
		kind: "fallback",
		reason: "verification",
	});
	assert.equal(codeSubmits(run.world), 0);
});

test("a rejected password falls back to the handoff and is named, with one submit only", async () => {
	const run = await runEnsure({ afterSubmit: "rejected" }, CREDENTIALS);
	assert.equal(run.error, undefined);
	assert.equal(submits(run.world), 1);
	assert.equal(run.handoff.requests.length, 1);
	assert.match(
		run.handoff.requests[0]?.message ?? "",
		/did not accept the saved email and password/,
	);
	assertNoSecrets(run.handoff.requests);
});

test("a fallback the owner does not finish fails the run with the existing error code", async () => {
	const run = await runEnsure({ afterSubmit: "rejected" }, CREDENTIALS, {
		ownerSignsIn: false,
	});
	assert.equal(
		(run.error as Error | undefined)?.message,
		"goodreads_session_missing",
	);
	assert.equal(submits(run.world), 1);
	assertNoSecrets((run.error as Error).message);
});

test("a page without the email form hands off with nothing typed", async () => {
	const run = await runEnsure(
		{ afterEmailLink: "unrecognized", afterSubmit: "home" },
		CREDENTIALS,
	);
	assert.equal(run.error, undefined);
	assert.deepEqual(run.world.filled, {});
	assert.equal(run.spy.submitted, 0);
	assert.equal(run.handoff.requests.length, 1);
	assert.match(
		run.handoff.requests[0]?.message ?? "",
		/did not show its email sign-in form/,
	);
});

test("a sign-in form on another site gets nothing typed into it", async () => {
	const run = await runEnsure(
		{ afterEmailLink: "foreignForm", afterSubmit: "home" },
		CREDENTIALS,
	);
	assert.equal(run.error, undefined);
	assert.deepEqual(run.world.filled, {});
	assert.equal(run.spy.submitted, 0);
	assert.equal(run.handoff.requests.length, 1);
	assert.match(run.handoff.requests[0]?.message ?? "", /does not recognize/);
});

test("a submit click that throws still counts as sent: one submit, and the outcome is read", async () => {
	const run = await runEnsure(
		{ afterSubmit: "home", clickThrows: true },
		CREDENTIALS,
	);
	assert.equal(run.error, undefined);
	assert.equal(run.spy.submitted, 1);
	assert.equal(submits(run.world), 1);
	assert.equal(run.handoff.requests.length, 0);
});

test("typing that throws hands off with nothing sent", async () => {
	const run = await runEnsure(
		{ afterSubmit: "home", fillThrows: true },
		CREDENTIALS,
	);
	assert.equal(run.error, undefined);
	assert.equal(run.spy.submitted, 0);
	assert.equal(submits(run.world), 0);
	assert.equal(run.handoff.requests.length, 1);
});

test("an error the attempt throws still reaches the handoff", async () => {
	const run = await runEnsure({ afterSubmit: "home" }, CREDENTIALS);
	const fake = makeSignIn({ afterSubmit: "home" });
	const handoff = makeHandoff(fake.world, { ownerSignsIn: true });
	const page = {
		...fake.page,
		locator: () => {
			throw new Error("Target crashed");
		},
	};
	const clock = mock.method(Date, "now", () => fake.world.now);
	try {
		await ensureGoodreadsSession({
			credentials: CREDENTIALS,
			page,
			sendInteraction: handoff.sendInteraction,
		} as never);
	} finally {
		clock.mock.restore();
	}
	assert.equal(run.error, undefined);
	assert.equal(handoff.requests.length, 1);
	assert.match(handoff.requests[0]?.message ?? "", /does not recognize/);
});

test("with an assistance surface, the fallback's explanation reaches the owner", async () => {
	const fake = makeSignIn({ afterSubmit: "captcha" });
	const asked: string[] = [];
	const clock = mock.method(Date, "now", () => fake.world.now);
	try {
		await ensureGoodreadsSession({
			assist: async (request: { message: string }) => {
				asked.push(request.message);
				fake.world.signedIn = true;
				fake.world.screen = "home";
				return "assist-1";
			},
			completeAssistance: async () => undefined,
			credentials: CREDENTIALS,
			page: fake.page,
		} as never);
	} finally {
		clock.mock.restore();
	}
	assert.equal(asked.length, 1);
	assert.match(asked[0] ?? "", /CAPTCHA/);
	assertNoSecrets(asked);
});

test("an error box already on the form is not the answer; a new page with one is", async () => {
	const stale = attempt({ afterSubmit: "rejected" }, "rejected");
	assert.deepEqual(await stale.outcome, {
		kind: "fallback",
		reason: "not_signed_in",
	});
	const fresh = attempt({ afterSubmit: "rejectedAgain" }, "rejected");
	assert.deepEqual(await fresh.outcome, {
		kind: "fallback",
		reason: "rejected_credentials",
	});
	assert.equal(submits(fresh.world), 1);
});

test("a signed-in check that never answers does not hold the run", async () => {
	const fake = makeSignIn({ afterSubmit: "home" });
	const outcome = await attemptAutomaticSignIn({
		clock: fake.clock,
		loginUrl: LOGIN_URL,
		page: fake.page as never,
		password: PASSWORD,
		probe: () => new Promise<boolean>(() => undefined),
		probeTimeoutMs: 1,
		username: EMAIL,
	});
	assert.deepEqual(outcome, { kind: "fallback", reason: "not_signed_in" });
});

// ─── The attempt itself ──────────────────────────────────────────────────

function attempt(script: Script, start: ScreenName = "landing") {
	const fake = makeSignIn(script, start);
	const spy = makeSpy();
	const outcome = attemptAutomaticSignIn({
		...spy.args,
		clock: fake.clock,
		loginUrl: LOGIN_URL,
		page: fake.page as never,
		password: PASSWORD,
		probe: async () => fake.world.signedIn,
		username: EMAIL,
	});
	return { ...fake, outcome, spy };
}

test("a page that never leaves the form is not signed in, after one submit", async () => {
	const run = attempt({ afterSubmit: "form" });
	assert.deepEqual(await run.outcome, {
		kind: "fallback",
		reason: "not_signed_in",
	});
	assert.equal(submits(run.world), 1);
	assert.equal(run.spy.submitted, 1);
});

test("a page nobody recognizes after submit times out as unrecognized", async () => {
	const run = attempt({ afterSubmit: "unrecognized" });
	assert.deepEqual(await run.outcome, {
		kind: "fallback",
		reason: "unrecognized_page",
	});
	assert.equal(submits(run.world), 1);
});

test("a goodreads page whose probe says signed out is not success", async () => {
	const fake = makeSignIn({ afterSubmit: "home" });
	const outcome = await attemptAutomaticSignIn({
		clock: fake.clock,
		loginUrl: LOGIN_URL,
		page: fake.page as never,
		password: PASSWORD,
		probe: async () => false,
		username: EMAIL,
	});
	assert.deepEqual(outcome, { kind: "fallback", reason: "not_signed_in" });
	assert.equal(submits(fake.world), 1);
});

test("the form already on screen is reused without another navigation", async () => {
	const fake = makeSignIn({ afterSubmit: "home" }, "form");
	const outcome = await attemptAutomaticSignIn({
		clock: fake.clock,
		loginUrl: LOGIN_URL,
		page: fake.page as never,
		password: PASSWORD,
		probe: async () => fake.world.signedIn,
		username: EMAIL,
	});
	assert.deepEqual(outcome, { kind: "signed_in" });
	assert.deepEqual(fake.world.gotos, []);
	assert.equal(fake.world.clicks.includes("emailLink"), false);
});

// ─── Classification ──────────────────────────────────────────────────────

const OBSERVED: SignInObservation = {
	bodyText: "",
	captchaElement: false,
	codeField: false,
	errorBox: false,
	host: "www.goodreads.com",
	passwordField: false,
	path: "/",
};

test("classification names the page, and the stricter reading wins", () => {
	const classify = (patch: Partial<SignInObservation>) =>
		classifySignInSurface({ ...OBSERVED, ...patch });
	assert.equal(classify({}), "goodreads_page");
	assert.equal(classify({ path: "/ap-handler/sign-in" }), "pending");
	assert.equal(classify({ passwordField: true, path: "/ap/signin" }), "form");
	assert.equal(
		classify({ errorBox: true, passwordField: true, path: "/ap/signin" }),
		"rejected",
	);
	// A CAPTCHA page also carries the form and often an error box.
	assert.equal(
		classify({
			captchaElement: true,
			errorBox: true,
			passwordField: true,
			path: "/ap/signin",
		}),
		"captcha",
	);
	assert.equal(classify({ codeField: true, path: "/ap/mfa" }), "verification");
	assert.equal(classify({ path: "/ap/cvf/request" }), "verification");
	assert.equal(classify({ path: "/ap/challenge" }), "verification");
	assert.equal(
		classify({ bodyText: "Enter the characters you see", path: "/ap/signin" }),
		"captcha",
	);
	assert.equal(
		classify({ host: "www.example.test", path: "/x" }),
		"unrecognized",
	);
	assert.equal(classify({ path: "/user/sign_in" }), "unrecognized");
});

test("page copy on a signed-in goodreads page never reads as a CAPTCHA or a code request", () => {
	const page = {
		...OBSERVED,
		bodyText:
			"Shelf: the captcha handbook. Review: send a verification code to the reader.",
		path: "/review/list/90000001-synthetic-reader",
	};
	assert.equal(classifySignInSurface(page), "goodreads_page");
	// Nor does a reCAPTCHA badge or a field named "code" on such a page.
	assert.equal(
		classifySignInSurface({ ...page, captchaElement: true, codeField: true }),
		"goodreads_page",
	);
});

test("every fallback has owner copy that names no credential, and a handoff reason", () => {
	const reasons = [
		"captcha",
		"code_rejected",
		"form_missing",
		"not_signed_in",
		"rejected_credentials",
		"unrecognized_page",
		"verification",
	] as const;
	for (const reason of reasons) {
		const text = fallbackExplanation(reason);
		assert.ok(text.length > 20);
		assertNoSecrets(text);
		assert.equal(/GOODREADS_|password:/i.test(text), false);
	}
	assert.equal(fallbackHandoffReason("captcha"), "captcha");
	assert.equal(fallbackHandoffReason("verification"), "2fa");
	assert.equal(fallbackHandoffReason("code_rejected"), "2fa");
	assert.equal(fallbackHandoffReason("rejected_credentials"), "login");
});

// ─── Declarations agree ──────────────────────────────────────────────────

test("the connector's auth, the field map and the manifest name the same optional pair", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		setup: {
			credential_capture: {
				fields: { env: string[]; name: string; required: boolean }[];
				kind: string;
				required: boolean;
			};
			modality: string;
		};
	};
	const capture = manifest.setup.credential_capture;
	assert.equal(manifest.setup.modality, "static_secret");
	assert.equal(capture.required, false);
	assert.equal(capture.kind, "username_password");
	assert.deepEqual(
		capture.fields.map((field) => field.required),
		[false, false],
	);
	const envNames = capture.fields.flatMap((field) => field.env).sort();
	assert.deepEqual(envNames, ["GOODREADS_PASSWORD", "GOODREADS_USERNAME"]);
	assert.deepEqual(
		[
			...GOODREADS_LOGIN_FIELDS.username,
			...GOODREADS_LOGIN_FIELDS.password,
		].sort(),
		envNames,
	);
	assert.deepEqual([...CONNECTOR_CONFIG.auth.required].sort(), envNames);
	// Optional: a missing credential must never prompt or fail the run.
	assert.equal(CONNECTOR_CONFIG.authOptional, true);
});
