// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Oura 3.1.2's owner-app authorization flow, shared by Desktop and PageShim. */
import type { Page } from "playwright";

const PORTAL = "https://developer.ouraring.com";
const APPLICATIONS = `${PORTAL}/applications`;
const AUTHORIZE = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize";
const TOKEN = "https://moi.ouraring.com/oauth/v2/ext/oauth-token";
const REDIRECT = "https://vana.org/oauth/oura/callback";
const STORAGE_KEY = "vana:oura-connector:token";
const SCOPE = "extapi:daily";
const PORTAL_SESSION_SETTLE_MS = 45_000;
const PORTAL_SESSION_POLL_MS = 2_000;
const PORTAL_SETTLE_MS = 1_500;
const PORTAL_SETTLE_TIMEOUT_MS = 15_000;

export const OURA_LOGIN_URL = APPLICATIONS;

interface TokenEntry {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
	clientId: string;
	clientSecret: string;
	/** Key of the portal account that authorized this grant. */
	account: string;
}

/** An Oura API token and the key of the account whose data it reads. */
export interface OuraApiAccess {
	accessToken: string;
	account: string;
}

/**
 * What the portal says about its session. "unknown" covers a failed read and
 * a page off the portal, and it never counts as "signed_out".
 */
type PortalSession =
	| { status: "signed_in"; email: string; account: string }
	| { status: "signed_out" }
	| { status: "unknown" };

type Interact = (url: string, message: string, ready: () => Promise<boolean>) => Promise<void>;

async function portalSession(page: Page): Promise<PortalSession> {
	try {
		if ((await page.evaluate(() => location.origin).catch(() => "")) !== PORTAL)
			return { status: "unknown" };
		return await page.evaluate(async (): Promise<PortalSession> => {
			if (location.origin !== "https://developer.ouraring.com") return { status: "unknown" };
			// A route the portal does not serve (404 or a page, not JSON) says
			// nothing. A route that fails leaves the session unknown, even if the
			// other route answers that nobody is signed in.
			let answered = false;
			let failed = false;
			for (const route of ["/api/auth/get-session", "/api/auth/session"]) {
				const response = await fetch(route, { credentials: "include" }).catch(() => null);
				if (!response || (!response.ok && response.status !== 404)) { failed = true; continue; }
				if (!response.ok) continue;
				const value: unknown = await response.json().catch(() => undefined);
				if (value === undefined) continue;
				answered = true;
				if (value && typeof value === "object" && "user" in value) {
					const user = value.user;
					if (user && typeof user === "object" && "email" in user && typeof user.email === "string" && user.email) {
						// Collection state stores this pseudonymous key, not the email.
						const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(user.email.trim().toLowerCase()));
						const account = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
						return { status: "signed_in", email: user.email, account };
					}
				}
			}
			return { status: answered && !failed ? "signed_out" : "unknown" };
		});
	} catch { return { status: "unknown" }; }
}

async function portalSignedIn(page: Page): Promise<boolean> {
	return (await portalSession(page)).status === "signed_in";
}

async function cachedToken(page: Page): Promise<TokenEntry | null> {
	const value: unknown = await page.evaluate((key) => {
		if (location.origin !== "https://developer.ouraring.com") return null;
		try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
	}, STORAGE_KEY);
	if (!value || typeof value !== "object") return null;
	const entry = value as Record<string, unknown>;
	// An entry without an account binding, such as one written by 3.1.2, is not reusable.
	if (typeof entry.accessToken !== "string" || typeof entry.clientId !== "string" ||
		typeof entry.clientSecret !== "string" || typeof entry.expiresAt !== "number" ||
		typeof entry.account !== "string" || !entry.account) return null;
	return {
		accessToken: entry.accessToken,
		refreshToken: typeof entry.refreshToken === "string" ? entry.refreshToken : null,
		expiresAt: entry.expiresAt,
		clientId: entry.clientId,
		clientSecret: entry.clientSecret,
		account: entry.account,
	};
}

async function saveToken(page: Page, entry: TokenEntry): Promise<void> {
	if ((await page.evaluate(() => location.origin)) !== PORTAL)
		await page.goto(APPLICATIONS, { waitUntil: "domcontentloaded" });
	await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
		key: STORAGE_KEY, value: entry,
	});
}

async function forgetToken(page: Page): Promise<void> {
	await page.evaluate((key) => {
		if (location.origin === "https://developer.ouraring.com") localStorage.removeItem(key);
	}, STORAGE_KEY);
}

async function tokenRequest(page: Page, grant: Record<string, string>, clientId: string, clientSecret: string,
	account: string): Promise<TokenEntry> {
	const body = new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret });
	const response = await page.context().request.post(TOKEN, {
		data: body.toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			// The mobile host must fall back to native HTTP before the one-use code is spent.
			"X-Vana-Connector": "oura",
		},
	});
	try {
		const value: unknown = await response.json().catch(() => null);
		if (!response.ok() || !value || typeof value !== "object") throw new Error(`oura_token_${response.status()}`);
		const token = value as Record<string, unknown>;
		if (typeof token.access_token !== "string") throw new Error("oura_token_invalid_payload");
		return {
			accessToken: token.access_token,
			refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : grant.refresh_token ?? null,
			expiresAt: Date.now() + (typeof token.expires_in === "number" ? token.expires_in : 86_400) * 1000,
			clientId, clientSecret, account,
		};
	} finally { await response.dispose(); }
}

async function tokenStatus(page: Page, accessToken: string): Promise<number> {
	const today = new Date().toISOString().slice(0, 10);
	const response = await page.context().request.get(
		`https://api.ouraring.com/v2/usercollection/daily_activity?start_date=${today}&end_date=${today}`,
		{ headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
	);
	try { return response.status(); } finally { await response.dispose(); }
}

async function waitForPortalSettled(page: Page): Promise<void> {
	const deadline = Date.now() + PORTAL_SETTLE_TIMEOUT_MS;
	let stableUrl = "";
	let stableSince = 0;
	while (Date.now() < deadline) {
		const url = await page.evaluate(() => location.href).catch(() => "");
		if (url !== stableUrl) { stableUrl = url; stableSince = Date.now(); }
		else if (url.startsWith(PORTAL) && Date.now() - stableSince >= PORTAL_SETTLE_MS) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function portalApplications(page: Page): Promise<Array<Record<string, unknown>> | null> {
	let value: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			value = await page.evaluate(async () => {
				if (location.origin !== "https://developer.ouraring.com") throw new Error("oura_portal_origin");
				for (let edgeAttempt = 0; edgeAttempt < 12; edgeAttempt++) {
					const response = await fetch("/api/extapi/v2/oauth/applications", { credentials: "include" });
					if (response.ok) return response.json();
					if (response.status !== 401 && response.status !== 403) throw new Error(`oura_portal_${response.status}`);
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
				return null;
			});
			break;
		} catch (error) {
			if (attempt === 2) throw error;
			await waitForPortalSettled(page);
		}
	}
	if (value === null) return null;
	if (!Array.isArray(value) || value.some((app) => !app || typeof app !== "object" || Array.isArray(app)))
		throw new Error("oura_portal_invalid_applications");
	return value as Array<Record<string, unknown>>;
}

async function application(page: Page, email: string, interact: Interact): Promise<{ clientId: string; clientSecret: string } | null> {
	let apps = await portalApplications(page);
	if (!apps) return null;
	const usable = (app: Record<string, unknown>) => typeof app.client_id === "string" &&
		Array.isArray(app.redirect_uris) && app.redirect_uris.includes(REDIRECT) &&
		Array.isArray(app.scopes) && app.scopes.includes(SCOPE);
	let chosen = apps.find((app) => app.application_name === "Personal access" && usable(app)) ?? apps.find(usable);
	if (!chosen) {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("oura_portal_email_invalid");
		const created = await page.evaluate(async (contactEmail) => {
			const response = await fetch("/api/extapi/v2/oauth/registration", {
				method: "POST", credentials: "include",
				headers: { Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({
					application_name: "Personal access",
					description: "Personal connector that exports my own Oura readiness, sleep and activity data to my Vana account.",
					contact_email: contactEmail, website: "https://vana.org",
					privacy_policy: "https://vana.org/privacy", tos: "https://vana.org/terms",
					redirect_uris: ["https://vana.org/oauth/oura/callback"],
					scopes: ["extapi:daily"], group_id: "", api_agreement: "v1.0.0",
				}),
			});
			return response.ok;
		}, email);
		if (created) {
			apps = await portalApplications(page);
			if (!apps) return null;
			chosen = apps.find((app) => app.application_name === "Personal access" && usable(app));
		}
		if (!chosen) {
			await interact(APPLICATIONS,
				"Create a personal Oura API app with scope extapi:daily and redirect URI https://vana.org/oauth/oura/callback, then continue.",
				async () => {
					try { return (await portalApplications(page))?.some(usable) ?? false; } catch { return false; }
				});
			apps = await portalApplications(page);
			if (!apps) return null;
			chosen = apps.find(usable);
		}
	}
	if (!chosen || typeof chosen.client_id !== "string" || typeof chosen.client_secret !== "string")
		throw new Error("oura_portal_app_credentials_missing");
	return { clientId: chosen.client_id, clientSecret: chosen.client_secret };
}

async function applicationAfterSessionSettles(page: Page, email: string, interact: Interact): Promise<{ clientId: string; clientSecret: string } | null> {
	await waitForPortalSettled(page);
	const deadline = Date.now() + PORTAL_SESSION_SETTLE_MS;
	for (;;) {
		const app = await application(page, email, interact);
		if (app || Date.now() >= deadline) return app;
		await new Promise((resolve) => setTimeout(resolve, PORTAL_SESSION_POLL_MS));
	}
}

async function pkce(page: Page): Promise<{ challenge: string; state: string; verifier: string }> {
	return page.evaluate(async () => {
		const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
		const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		return {
			verifier,
			challenge: base64url(new Uint8Array(digest)),
			state: `vana-${base64url(crypto.getRandomValues(new Uint8Array(16)))}`,
		};
	});
}

export async function probeOuraPortalSession(page: Page): Promise<boolean> {
	return portalSignedIn(page);
}

/**
 * A cached token reads only the account that authorized it. It is reusable
 * when the portal shows that account signed in, or when the portal answers
 * that nobody is signed in: the profile still holds no other account's
 * session. An unreadable session could hide another account, so it never
 * permits reuse.
 */
async function reusableCachedAccess(page: Page, session: PortalSession): Promise<OuraApiAccess | null> {
	const cached = await cachedToken(page);
	if (!cached || session.status === "unknown" ||
		(session.status === "signed_in" && session.account !== cached.account)) return null;
	if (cached.expiresAt > Date.now() + 600_000) {
		const status = await tokenStatus(page, cached.accessToken).catch(() => 0);
		if (status !== 401 && status !== 403) return { accessToken: cached.accessToken, account: cached.account };
	}
	if (cached.refreshToken) {
		try {
			const renewed = await tokenRequest(page, {
				grant_type: "refresh_token", refresh_token: cached.refreshToken,
			}, cached.clientId, cached.clientSecret, cached.account);
			await saveToken(page, renewed);
			const status = await tokenStatus(page, renewed.accessToken).catch(() => 0);
			if (status !== 401 && status !== 403) return { accessToken: renewed.accessToken, account: renewed.account };
		} catch { /* A revoked grant needs owner authorization. */ }
	}
	return null;
}

export async function probeOuraCachedApiAccess(page: Page): Promise<string | null> {
	try {
		if ((await page.evaluate(() => location.origin).catch(() => "")) !== PORTAL) return null;
		return (await reusableCachedAccess(page, await portalSession(page)))?.accessToken ?? null;
	} catch { return null; }
}

export async function probeOuraSignInInProgress(page: Page): Promise<boolean> {
	return page.evaluate(() => location.origin === "https://moi.ouraring.com" &&
		location.pathname.startsWith("/authn/")).catch(() => false);
}

async function advanceOuraSignIn(page: Page, email?: string): Promise<void> {
	await page.evaluate((knownEmail) => {
		if (location.origin === "https://developer.ouraring.com" && location.pathname.startsWith("/signin")) {
			const button = [...document.querySelectorAll("button")].find((item) => /sign in/i.test(item.innerText));
			if (button && !(window as Window & { __vanaSignInClicked?: boolean }).__vanaSignInClicked) {
				(window as Window & { __vanaSignInClicked?: boolean }).__vanaSignInClicked = true;
				button.click();
			}
			return;
		}
		if (location.origin !== "https://moi.ouraring.com" || !location.pathname.startsWith("/authn/")) return;
		if (document.querySelector('input#otp-code, input[autocomplete="one-time-code"], input[name="otp"]')) return;
		const input = document.querySelector<HTMLInputElement>('input#username, input[type="email"]');
		if (input && knownEmail) {
			if (input.value !== knownEmail) {
				const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
				setter?.call(input, knownEmail);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
			const form = input.form;
			if (form && !(window as Window & { __vanaEmailSubmitted?: boolean }).__vanaEmailSubmitted) {
				(window as Window & { __vanaEmailSubmitted?: boolean }).__vanaEmailSubmitted = true;
				form.requestSubmit();
			}
			return;
		}
		if (document.readyState !== "complete") return;
		const choices = [...document.querySelectorAll<HTMLButtonElement>('button[name="selectedId"], input[type="submit"][name="selectedId"]')]
			.filter((item) => item.id !== "passkey-button" && !/passkey/i.test(item.value));
		const choice = choices.length === 1 ? choices[0] : choices.find((item) => /e-?mail|otp|code/i.test(`${item.value} ${item.innerText}`));
		if (choice && !(window as Window & { __vanaChoseEmailCode?: boolean }).__vanaChoseEmailCode) {
			(window as Window & { __vanaChoseEmailCode?: boolean }).__vanaChoseEmailCode = true;
			choice.click();
		}
	}, email).catch(() => {});
}

async function authorizeWithUser(page: Page, interact: Interact, owner: { email: string; account: string },
	clientId: string, clientSecret: string, autoAllow: boolean): Promise<TokenEntry> {
	const proof = await pkce(page);
	const url = new URL(AUTHORIZE);
	url.search = new URLSearchParams({
		response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
		scope: SCOPE, state: proof.state, code_challenge: proof.challenge,
		code_challenge_method: "S256", prompt: "consent",
	}).toString();
	let consentReadyPolls = 0;
	let allowPressed = false;
	await interact(url.toString(), "Approve daily Oura data access, then continue.", async () => {
		const current = await page.evaluate(() => location.href).catch(() => "");
		if (current.startsWith(REDIRECT)) return true;
		await advanceOuraSignIn(page, owner.email);
		// Oura has recorded empty grants when Allow is pressed before its page script binds.
		const consent = await page.evaluate(({ press }) => {
			const box = document.querySelector<HTMLInputElement>('input[type="checkbox"][name="consent.scope.extapi:daily"]');
			if (!box) return { ticked: false, pressed: false };
			if (!box.checked) box.click();
			if (!box.checked || document.readyState !== "complete") return { ticked: false, pressed: false };
			if (press) {
				const button = document.querySelector<HTMLButtonElement>('button[name="submit_consent"], input[name="submit_consent"], #submit_consent, button[value="submit_consent"]');
				if (button && !button.disabled) { button.click(); return { ticked: true, pressed: true }; }
			}
			return { ticked: true, pressed: false };
		}, { press: autoAllow && consentReadyPolls >= 1 && !allowPressed }).catch(() => ({ ticked: false, pressed: false }));
		consentReadyPolls = consent.ticked ? consentReadyPolls + 1 : 0;
		if (consent.pressed) allowPressed = true;
		return false;
	});
	const redirect = new URL(await page.evaluate(() => location.href));
	if (!redirect.href.startsWith(REDIRECT) || redirect.searchParams.get("state") !== proof.state)
		throw new Error("oura_oauth_state_invalid");
	const code = redirect.searchParams.get("code");
	if (!code) throw new Error("oura_oauth_code_missing");
	return tokenRequest(page, {
		grant_type: "authorization_code", code, redirect_uri: REDIRECT,
		code_verifier: proof.verifier,
	}, clientId, clientSecret, owner.account);
}

export async function ensureOuraApiAccess(page: Page, interact: Interact): Promise<OuraApiAccess> {
	if (await probeOuraSignInInProgress(page)) {
		const current = await page.evaluate(() => location.href);
		await interact(current, "Finish signing in to Oura.", async () => {
			await advanceOuraSignIn(page);
			return portalSignedIn(page);
		});
	} else if ((await page.evaluate(() => location.origin).catch(() => "")) !== PORTAL)
		await page.goto(APPLICATIONS, { waitUntil: "domcontentloaded" });
	const signIn = async () => {
		await interact(APPLICATIONS, "Sign in to the Oura Developer Portal, then continue.", async () => {
			await advanceOuraSignIn(page);
			return portalSignedIn(page);
		});
		return portalSession(page);
	};
	let session = await portalSession(page);
	// The cached token is judged only against a session the portal confirms.
	if (session.status === "unknown") session = await signIn();
	const cached = await reusableCachedAccess(page, session);
	if (cached) return cached;
	if (session.status !== "signed_in") session = await signIn();
	if (session.status !== "signed_in") throw new Error("oura_portal_session_unconfirmed");
	// Another account's grant, or an unbound one, must not outlive this sign-in.
	// This account's grant stays until a new grant replaces it.
	if ((await cachedToken(page))?.account !== session.account) await forgetToken(page);
	let owner = session;
	let app = await applicationAfterSessionSettles(page, owner.email, interact);
	if (!app) {
		await page.evaluate(async () => {
			await fetch("/api/auth/sign-out", {
				method: "POST", credentials: "include",
				headers: { "Content-Type": "application/json" }, body: "{}",
			}).catch(() => {});
		});
		await interact(`${PORTAL}/signin?callbackUrl=%2Fapplications`, "Sign in to Oura again to restore your Developer Portal session.",
			async () => {
				await advanceOuraSignIn(page);
				return portalSignedIn(page);
			});
		session = await portalSession(page);
		if (session.status !== "signed_in") throw new Error("oura_portal_session_unconfirmed");
		owner = session;
		app = await applicationAfterSessionSettles(page, owner.email, interact);
		if (!app) throw new Error("oura_portal_session_unconfirmed");
	}
	const { clientId, clientSecret } = app;
	let entry = await authorizeWithUser(page, interact, owner, clientId, clientSecret, true);
	let status = await tokenStatus(page, entry.accessToken);
	if (status === 401 || status === 403) {
		entry = await authorizeWithUser(page, interact, owner, clientId, clientSecret, false);
		status = await tokenStatus(page, entry.accessToken);
	}
	if (status === 401 || status === 403) throw new Error("oura_daily_scope_missing");
	await saveToken(page, entry);
	return { accessToken: entry.accessToken, account: entry.account };
}

export async function readOuraCachedAccess(page: Page): Promise<OuraApiAccess> {
	const token = await cachedToken(page);
	if (!token) throw new Error("oura_api_token_missing");
	return { accessToken: token.accessToken, account: token.account };
}
