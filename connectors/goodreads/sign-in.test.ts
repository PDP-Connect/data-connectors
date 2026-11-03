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
	| "email"
	| "emailLink"
	| "error"
	| "password"
	| "remember"
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
	otp: { url: `${ORIGIN}/ap/mfa`, visible: ["code"] },
	rejected: {
		url: `${ORIGIN}/ap/signin`,
		visible: ["email", "password", "submit", "error"],
	},
	unrecognized: { url: "https://www.example.test/elsewhere" },
} satisfies Record<string, Screen>;

type ScreenName = keyof typeof SCREENS;

interface World {
	checked: boolean;
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
	/** Where the submit leads. */
	readonly afterSubmit: ScreenName;
}

function keysOf(selector: string): Key[] {
	const keys: Key[] = [];
	const table: [string, Key][] = [
		["Sign in with email", "emailLink"],
		["ap_email", "email"],
		["ap_password", "password"],
		["signInSubmit", "submit"],
		["auth-remember-me", "remember"],
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
				world.checked = true;
			},
			click: async () => {
				const key = keys[0] as Key;
				world.clicks.push(key);
				if (key === "emailLink") {
					world.screen = script.afterEmailLink ?? "form";
				} else if (key === "submit") {
					world.screen = script.afterSubmit;
					world.signedIn = script.afterSubmit === "home";
				}
			},
			count: async () => (selector === "body" || visible(keys) ? 1 : 0),
			fill: async (value: string) => {
				world.filled[keys[0] as string] = value;
			},
			first: () => self,
			innerText: async () => screen().body ?? "",
			isChecked: async () => world.checked,
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
	{ ownerSignsIn }: { ownerSignsIn: boolean },
) {
	const requests: InteractionRequest[] = [];
	return {
		requests,
		sendInteraction: async (
			request: InteractionRequest,
		): Promise<InteractionResponse> => {
			requests.push(request);
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
	{ ownerSignsIn = true, start = "landing" as ScreenName } = {},
) {
	const fake = makeSignIn(script, start);
	const handoff = makeHandoff(fake.world, { ownerSignsIn });
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

test("a verification-code page falls back to the handoff, no second submit", async () => {
	const run = await runEnsure({ afterSubmit: "otp" }, CREDENTIALS);
	assert.equal(run.error, undefined);
	assert.equal(submits(run.world), 1);
	assert.equal(run.handoff.requests.length, 1);
	assert.match(run.handoff.requests[0]?.message ?? "", /verification code/);
	assertNoSecrets(run.handoff.requests);
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

// ─── The attempt itself ──────────────────────────────────────────────────

function attempt(script: Script) {
	const fake = makeSignIn(script);
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
});

test("every fallback has owner copy that names no credential, and a handoff reason", () => {
	const reasons = [
		"captcha",
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
