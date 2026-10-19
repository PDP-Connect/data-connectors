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

export const OURA_LOGIN_URL = APPLICATIONS;

interface TokenEntry {
	accessToken: string;
	refreshToken: string | null;
	expiresAt: number;
	clientId: string;
	clientSecret: string;
}

type Interact = (url: string, message: string, ready: () => Promise<boolean>) => Promise<void>;

async function portalEmail(page: Page): Promise<string | null> {
	if ((await page.evaluate(() => location.origin).catch(() => "")) !== PORTAL)
		return null;
	return page.evaluate(async () => {
		if (location.origin !== "https://developer.ouraring.com") return null;
		for (const route of ["/api/auth/get-session", "/api/auth/session"]) {
			const response = await fetch(route, { credentials: "include" });
			if (!response.ok) continue;
			const value: unknown = await response.json().catch(() => null);
			if (value && typeof value === "object" && "user" in value) {
				const user = value.user;
				if (user && typeof user === "object" && "email" in user && typeof user.email === "string")
					return user.email;
			}
		}
		return null;
	});
}

async function cachedToken(page: Page): Promise<TokenEntry | null> {
	const value: unknown = await page.evaluate((key) => {
		if (location.origin !== "https://developer.ouraring.com") return null;
		try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
	}, STORAGE_KEY);
	if (!value || typeof value !== "object") return null;
	const entry = value as Record<string, unknown>;
	if (typeof entry.accessToken !== "string" || typeof entry.clientId !== "string" ||
		typeof entry.clientSecret !== "string" || typeof entry.expiresAt !== "number") return null;
	return {
		accessToken: entry.accessToken,
		refreshToken: typeof entry.refreshToken === "string" ? entry.refreshToken : null,
		expiresAt: entry.expiresAt,
		clientId: entry.clientId,
		clientSecret: entry.clientSecret,
	};
}

async function saveToken(page: Page, entry: TokenEntry): Promise<void> {
	if ((await page.evaluate(() => location.origin)) !== PORTAL)
		await page.goto(APPLICATIONS, { waitUntil: "domcontentloaded" });
	await page.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
		key: STORAGE_KEY, value: entry,
	});
}

async function tokenRequest(page: Page, grant: Record<string, string>, clientId: string, clientSecret: string): Promise<TokenEntry> {
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
			clientId, clientSecret,
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

async function portalApplications(page: Page): Promise<Array<Record<string, unknown>>> {
	const value: unknown = await page.evaluate(async () => {
		if (location.origin !== "https://developer.ouraring.com") throw new Error("oura_portal_origin");
		for (let attempt = 0; attempt < 12; attempt++) {
			const response = await fetch("/api/extapi/v2/oauth/applications", { credentials: "include" });
			if (response.ok) return response.json();
			if (response.status !== 401 && response.status !== 403) throw new Error(`oura_portal_${response.status}`);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error("oura_portal_session_unconfirmed");
	});
	if (!Array.isArray(value) || value.some((app) => !app || typeof app !== "object" || Array.isArray(app)))
		throw new Error("oura_portal_invalid_applications");
	return value as Array<Record<string, unknown>>;
}

async function application(page: Page, email: string, interact: Interact): Promise<{ clientId: string; clientSecret: string }> {
	let apps = await portalApplications(page);
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
			chosen = apps.find((app) => app.application_name === "Personal access" && usable(app));
		}
		if (!chosen) {
			await interact(APPLICATIONS,
				"Create a personal Oura API app with scope extapi:daily and redirect URI https://vana.org/oauth/oura/callback, then continue.",
				async () => {
					try { return (await portalApplications(page)).some(usable); } catch { return false; }
				});
			apps = await portalApplications(page);
			chosen = apps.find(usable);
		}
	}
	if (!chosen || typeof chosen.client_id !== "string" || typeof chosen.client_secret !== "string")
		throw new Error("oura_portal_app_credentials_missing");
	return { clientId: chosen.client_id, clientSecret: chosen.client_secret };
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
	try { return Boolean(await portalEmail(page)); } catch { return false; }
}

export async function ensureOuraApiAccess(page: Page, interact: Interact): Promise<string> {
	if ((await page.evaluate(() => location.origin).catch(() => "")) !== PORTAL)
		await page.goto(APPLICATIONS, { waitUntil: "domcontentloaded" });
	const cached = await cachedToken(page);
	if (cached) {
		if (cached.expiresAt > Date.now() + 600_000) {
			const status = await tokenStatus(page, cached.accessToken).catch(() => 0);
			if (status !== 401 && status !== 403) return cached.accessToken;
		}
		if (cached.refreshToken) {
			try {
				const renewed = await tokenRequest(page, {
					grant_type: "refresh_token", refresh_token: cached.refreshToken,
				}, cached.clientId, cached.clientSecret);
				await saveToken(page, renewed);
				const status = await tokenStatus(page, renewed.accessToken).catch(() => 0);
				if (status !== 401 && status !== 403) return renewed.accessToken;
			} catch { /* A revoked grant needs owner authorization. */ }
		}
	}
	let email = await portalEmail(page);
	if (!email) {
		await interact(APPLICATIONS, "Sign in to the Oura Developer Portal, then continue.", async () => Boolean(await portalEmail(page)));
		email = await portalEmail(page);
	}
	if (!email) throw new Error("oura_portal_session_unconfirmed");
	const { clientId, clientSecret } = await application(page, email, interact);
	const proof = await pkce(page);
	const url = new URL(AUTHORIZE);
	url.search = new URLSearchParams({
		response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
		scope: SCOPE, state: proof.state, code_challenge: proof.challenge,
		code_challenge_method: "S256", prompt: "consent",
	}).toString();
	await interact(url.toString(), "Approve daily Oura data access, then continue.", async () => {
		const current = await page.evaluate(() => location.href);
		if (current.startsWith(REDIRECT)) return true;
		// Oura has recorded empty grants when Allow is pressed before its page script binds.
		await page.evaluate(() => {
			const box = document.querySelector<HTMLInputElement>('input[type="checkbox"][name="consent.scope.extapi:daily"]');
			if (box && !box.checked) box.click();
		});
		return false;
	});
	const redirect = new URL(await page.evaluate(() => location.href));
	if (!redirect.href.startsWith(REDIRECT) || redirect.searchParams.get("state") !== proof.state)
		throw new Error("oura_oauth_state_invalid");
	const code = redirect.searchParams.get("code");
	if (!code) throw new Error("oura_oauth_code_missing");
	const entry = await tokenRequest(page, {
		grant_type: "authorization_code", code, redirect_uri: REDIRECT,
		code_verifier: proof.verifier,
	}, clientId, clientSecret);
	const status = await tokenStatus(page, entry.accessToken);
	if (status === 401 || status === 403) throw new Error("oura_daily_scope_missing");
	await saveToken(page, entry);
	return entry.accessToken;
}

export async function readOuraCachedAccessToken(page: Page): Promise<string> {
	const token = await cachedToken(page);
	if (!token) throw new Error("oura_api_token_missing");
	return token.accessToken;
}
