// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional automatic sign-in for the Goodreads connector.
 *
 * The owner may save a Goodreads email and password for this connection (the
 * manifest's optional `credential_capture`). When the browser profile holds no
 * live session and a saved pair exists, this module signs in once through
 * Goodreads' "Sign in with email" form. Every other case stays with the
 * owner's browser handoff in index.ts: no saved pair, a CAPTCHA, a
 * verification code or approval step, a rejected password, or a page this
 * module does not recognize. It never retries; one call is one attempt.
 *
 * Why this is not `auto-login/amazon.ts`. Goodreads' email sign-in runs on
 * Amazon's sign-in system (`/ap/signin`) and shares its field ids, but
 * Goodreads serves ONE form with the email, the password, and "Keep me signed
 * in" together (live 2026-11-03: `input#ap_email`, `input#ap_password`,
 * `input#auth-remember-me`, `input#signInSubmit`). Amazon's own helper drives
 * an email-then-continue flow, keeps its helpers private, and judges success
 * by Amazon's orders page, so none of it fits. What is shared is the
 * credential resolution (`resolveLoginCredentials`) and the handoff.
 *
 * Success is the connector's own signed-in check, injected as `probe`, never
 * a guess from the URL. Credential values appear only as the argument to
 * `fill`; nothing here logs, throws, or checkpoints them.
 */

import type { Page } from "playwright";
import type { LoginCredentialFields } from "../../packages/polyfill-connectors/src/auto-login/login-credentials.ts";
import type { ManualActionReason } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type { SessionCheckpointFn } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

/**
 * Where the pair sits in the runtime-resolved `credentials` object. Must match
 * the manifest's `credential_capture` env mapping and the connector's `auth`
 * declaration.
 */
export const GOODREADS_LOGIN_FIELDS: LoginCredentialFields = {
	password: ["GOODREADS_PASSWORD"],
	username: ["GOODREADS_USERNAME"],
};

const SIGN_IN_FORM_TIMEOUT_MS = 20_000;
const OUTCOME_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;

const EMAIL_SIGN_IN_LINK =
	'a:has-text("Sign in with email"), button:has-text("Sign in with email")';
const EMAIL_FIELD = "input#ap_email, input#ap_email_login";
const PASSWORD_FIELD = "input#ap_password";
const REMEMBER_ME = "input#auth-remember-me";
const SUBMIT_BUTTON = "input#signInSubmit";
/** Amazon's own sign-in error box: wrong password, unknown email, locked account. */
const ERROR_BOX = "#auth-error-message-box, #auth-warning-message-box";
const CAPTCHA_ELEMENT =
	'#auth-captcha-guess, #captchacharacters, #auth-captcha-image, form[action*="validateCaptcha"], iframe[src*="captcha" i], #captcha-container';
const CODE_FIELD =
	'input#auth-mfa-otpcode, input[name="otpCode"], input[name="code"], input[autocomplete="one-time-code"]';

const CAPTCHA_TEXT_RE =
	/\b(enter the characters you see|type the characters|solve this puzzle|captcha)\b/i;
const VERIFICATION_TEXT_RE =
	/\b(verification code|one[- ]time (?:password|code)|approve (?:the|this) (?:notification|sign[- ]in)|two[- ]step verification)\b/i;
const VERIFICATION_PATH_RE =
	/^\/ap\/(?:mfa|cvf|challenge|transactionapproval|claim|ax|forgotpassword)\b/i;
const SIGN_IN_PATH_RE = /^\/(?:user\/sign_in|sign_in|ap\/signin)\b/i;
const PENDING_PATH_RE = /^\/ap-handler\b/i;
const BODY_TEXT_LIMIT = 1500;
const GOODREADS_HOSTS: ReadonlySet<string> = new Set([
	"www.goodreads.com",
	"goodreads.com",
]);

/** What the page showed, as plain facts. The classifier reads only this. */
export interface SignInObservation {
	readonly bodyText: string;
	readonly captchaElement: boolean;
	readonly codeField: boolean;
	readonly errorBox: boolean;
	readonly host: string;
	readonly passwordField: boolean;
	readonly path: string;
}

export type SignInSurface =
	| "captcha"
	| "verification"
	| "rejected"
	| "form"
	| "pending"
	| "goodreads_page"
	| "unrecognized";

/**
 * Name the page. Order matters: a CAPTCHA page often still carries the form
 * and an error box, and a verification page lives under the same `/ap/` tree
 * as the sign-in form, so the stricter reading wins.
 */
export function classifySignInSurface(
	observed: SignInObservation,
): SignInSurface {
	// Page copy counts only on the sign-in tree: a signed-in Goodreads page can
	// mention "captcha" in a book title or a review, and must not read as one.
	const onSignInTree =
		!GOODREADS_HOSTS.has(observed.host) ||
		observed.path.startsWith("/ap/") ||
		SIGN_IN_PATH_RE.test(observed.path) ||
		observed.passwordField;
	if (
		observed.captchaElement ||
		(onSignInTree && CAPTCHA_TEXT_RE.test(observed.bodyText))
	) {
		return "captcha";
	}
	if (
		observed.codeField ||
		VERIFICATION_PATH_RE.test(observed.path) ||
		(onSignInTree && VERIFICATION_TEXT_RE.test(observed.bodyText))
	) {
		return "verification";
	}
	if (observed.errorBox) {
		return "rejected";
	}
	if (observed.passwordField) {
		return "form";
	}
	if (PENDING_PATH_RE.test(observed.path)) {
		return "pending";
	}
	if (
		GOODREADS_HOSTS.has(observed.host) &&
		!SIGN_IN_PATH_RE.test(observed.path) &&
		!observed.path.startsWith("/ap/")
	) {
		return "goodreads_page";
	}
	return "unrecognized";
}

export type FallbackReason =
	| "captcha"
	| "form_missing"
	| "not_signed_in"
	| "rejected_credentials"
	| "unrecognized_page"
	| "verification";

export type AutomaticSignInOutcome =
	| { readonly kind: "signed_in" }
	| { readonly kind: "fallback"; readonly reason: FallbackReason };

/** The owner-facing sentence for one fallback. It names the page state, never a credential. */
export function fallbackExplanation(reason: FallbackReason): string {
	switch (reason) {
		case "captcha":
			return "Goodreads is showing a CAPTCHA, so the saved sign-in could not finish.";
		case "verification":
			return "Goodreads is asking for a verification code or an approval, so the saved sign-in could not finish.";
		case "rejected_credentials":
			return "Goodreads did not accept the saved email and password. Update the saved sign-in afterwards if it is out of date.";
		case "form_missing":
			return "Goodreads did not show its email sign-in form, so the saved sign-in was not used.";
		case "not_signed_in":
			return "The saved sign-in was submitted but Goodreads did not confirm a signed-in session.";
		default:
			return "Goodreads showed a page the connector does not recognize, so the saved sign-in could not finish.";
	}
}

/** The handoff reason the owner's console shows for a fallback. */
export function fallbackHandoffReason(
	reason: FallbackReason,
): ManualActionReason {
	if (reason === "captcha") {
		return "captcha";
	}
	if (reason === "verification") {
		return "2fa";
	}
	return "login";
}

export interface SignInClock {
	readonly now: () => number;
	readonly wait: (ms: number) => Promise<void>;
}

type SignInPage = Pick<Page, "goto" | "locator" | "url" | "waitForTimeout">;

async function anyVisible(
	page: SignInPage,
	selector: string,
): Promise<boolean> {
	const matches = page.locator(selector);
	const count = await matches.count().catch((): number => 0);
	for (let i = 0; i < count; i += 1) {
		if (
			await matches
				.nth(i)
				.isVisible()
				.catch((): boolean => false)
		) {
			return true;
		}
	}
	return false;
}

function hostAndPath(url: string): { host: string; path: string } {
	try {
		const parsed = new URL(url);
		return { host: parsed.hostname, path: parsed.pathname };
	} catch {
		return { host: "", path: "" };
	}
}

async function observe(page: SignInPage): Promise<SignInObservation> {
	const [captchaElement, codeField, errorBox, passwordField, bodyText] =
		await Promise.all([
			anyVisible(page, CAPTCHA_ELEMENT),
			anyVisible(page, CODE_FIELD),
			anyVisible(page, ERROR_BOX),
			anyVisible(page, PASSWORD_FIELD),
			page
				.locator("body")
				.innerText({ timeout: 2000 })
				.catch((): string => ""),
		]);
	return {
		...hostAndPath(page.url()),
		bodyText: bodyText.slice(0, BODY_TEXT_LIMIT),
		captchaElement,
		codeField,
		errorBox,
		passwordField,
	};
}

/** Wait for a visible match, then return it; `null` if none appears in time. */
async function waitForVisible(
	page: SignInPage,
	selector: string,
	clock: SignInClock,
	timeoutMs: number,
): Promise<ReturnType<SignInPage["locator"]> | null> {
	const startedAt = clock.now();
	while (clock.now() - startedAt <= timeoutMs) {
		const matches = page.locator(selector);
		const count = await matches.count().catch((): number => 0);
		for (let i = 0; i < count; i += 1) {
			const candidate = matches.nth(i);
			if (await candidate.isVisible().catch((): boolean => false)) {
				return candidate;
			}
		}
		await clock.wait(POLL_INTERVAL_MS);
	}
	return null;
}

/** Open the email form: reuse it if the page already shows it, else follow the link. */
async function openEmailForm(
	page: SignInPage,
	clock: SignInClock,
	loginUrl: string,
): Promise<boolean> {
	if (!(await anyVisible(page, PASSWORD_FIELD))) {
		await page
			.goto(loginUrl, { waitUntil: "domcontentloaded" })
			.catch((): null => null);
		const link = await waitForVisible(page, EMAIL_SIGN_IN_LINK, clock, 10_000);
		if (link) {
			await link.click().catch((): undefined => undefined);
		}
	}
	return (
		(await waitForVisible(
			page,
			PASSWORD_FIELD,
			clock,
			SIGN_IN_FORM_TIMEOUT_MS,
		)) !== null
	);
}

export interface AutomaticSignInArgs {
	readonly checkpoint?: SessionCheckpointFn | undefined;
	readonly clock?: SignInClock | undefined;
	readonly loginUrl: string;
	readonly onCredentialSubmit?: (() => void) | undefined;
	readonly page: SignInPage;
	readonly password: string;
	/** The connector's own signed-in check. Success is this and nothing else. */
	readonly probe: () => Promise<boolean>;
	readonly username: string;
}

function defaultClock(page: SignInPage): SignInClock {
	return {
		now: (): number => Date.now(),
		wait: (ms: number): Promise<void> => page.waitForTimeout(ms),
	};
}

async function submitForm(
	page: SignInPage,
	clock: SignInClock,
	username: string,
	password: string,
): Promise<boolean> {
	const email = await waitForVisible(page, EMAIL_FIELD, clock, 5000);
	const pass = await waitForVisible(page, PASSWORD_FIELD, clock, 5000);
	const submit = await waitForVisible(page, SUBMIT_BUTTON, clock, 5000);
	if (!(email && pass && submit)) {
		return false;
	}
	await email.fill(username);
	await pass.fill(password);
	// Keep me signed in: without it the session ends with the browser and the
	// next run signs in again.
	const remember = page.locator(REMEMBER_ME).first();
	if (
		(await remember.isVisible().catch((): boolean => false)) &&
		!(await remember.isChecked().catch((): boolean => true))
	) {
		await remember.check().catch((): undefined => undefined);
	}
	await submit.click();
	return true;
}

/**
 * One automatic sign-in attempt. Returns `signed_in` only when `probe` says
 * the session is live; every other end is a named fallback for the caller to
 * hand to the owner. The sole thrown failure is a page or browser error.
 */
export async function attemptAutomaticSignIn({
	checkpoint,
	clock: injectedClock,
	loginUrl,
	onCredentialSubmit,
	page,
	password,
	probe,
	username,
}: AutomaticSignInArgs): Promise<AutomaticSignInOutcome> {
	const clock = injectedClock ?? defaultClock(page);
	await checkpoint?.("goodreads-signin-open");
	if (!(await openEmailForm(page, clock, loginUrl))) {
		return { kind: "fallback", reason: "form_missing" };
	}
	await checkpoint?.("goodreads-signin-form-loaded");
	if (!(await submitForm(page, clock, username, password))) {
		return { kind: "fallback", reason: "form_missing" };
	}
	// Called at the click that sent the password: a later fault must not let a
	// fresh process resubmit it (see EnsureSessionArgs.onCredentialSubmit).
	onCredentialSubmit?.();
	await checkpoint?.("goodreads-signin-submitted");

	const startedAt = clock.now();
	while (clock.now() - startedAt <= OUTCOME_TIMEOUT_MS) {
		await clock.wait(POLL_INTERVAL_MS);
		const surface = classifySignInSurface(await observe(page));
		if (surface === "goodreads_page" && (await probe())) {
			await checkpoint?.("goodreads-signin-live");
			return { kind: "signed_in" };
		}
		if (surface === "captcha") {
			return { kind: "fallback", reason: "captcha" };
		}
		if (surface === "verification") {
			return { kind: "fallback", reason: "verification" };
		}
		if (surface === "rejected") {
			return { kind: "fallback", reason: "rejected_credentials" };
		}
	}
	await checkpoint?.("goodreads-signin-timeout");
	const last = classifySignInSurface(await observe(page));
	if (last === "goodreads_page" || last === "form" || last === "pending") {
		return { kind: "fallback", reason: "not_signed_in" };
	}
	return { kind: "fallback", reason: "unrecognized_page" };
}
