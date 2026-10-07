/*! telemetry-ids
steps: init, portal_signin, portal_app, authorize, token, fetch_daily_readiness, fetch_daily_sleep, fetch_sleep, fetch_daily_activity, build_result
codes: scopes_invalid, portal_unreachable, signin_needs_browser, signin_unconfirmed, portal_app_list_failed, portal_app_not_created, portal_app_secret_unreadable, authorize_page_unreachable, authorize_incomplete, authorize_declined, authorize_no_code, authorize_bad_state, token_request_failed, token_scope_missing, token_rejected, daily_access_denied, api_all_failed, api_scope_failed, api_scope_degraded, unexpected
*/
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Oura Ring Connector
 *
 * Exports:
 * - Readiness scores (daily)
 * - Sleep data (daily scores + sleep periods)
 * - Activity data (daily)
 *
 * Oura discontinues Oura on the Web (cloud.ouraring.com dashboard and its
 * private /api/account/* endpoints) on 5 Oct 2026. The Membership Hub has no
 * live health data (only an async CSV export that takes up to 10 days), so
 * this connector reads the public Oura API V2 instead:
 *
 * 1. Sign in to the Oura Developer Portal (developer.ouraring.com) with the
 *    user's Oura account (same Oura identity as the Membership Hub).
 * 2. Find or create a personal API application on the user's own developer
 *    account. Each user owns their app, so Oura's 10-users-per-unapproved-app
 *    cap never applies. The user ticks the Oura API Agreement themselves.
 * 3. Authorize that app with the OAuth2 authorization-code flow (PKCE,
 *    scope "extapi:daily") and exchange the code with the app's own client
 *    secret, read from the portal API and never logged. Oura's client-side
 *    (implicit) flow is not used: it issues tokens without scopes.
 * 4. Fetch daily_readiness, daily_sleep, sleep and daily_activity from
 *    api.ouraring.com/v2/usercollection.
 *
 * Oura's sign-in cookies are session-only, so steps 1-3 need the user in a
 * headed browser. The resulting access + refresh tokens are cached in the
 * connector's own browser profile on the developer.ouraring.com origin, so
 * scheduled re-runs stay headless and refresh the access token themselves.
 *
 * On mobile (3.0.0-vana.4+) a full-screen Vana screen covers Oura's pages:
 * the person types their email and the emailed codes into Vana screens, the
 * connector types them into Oura's own forms underneath, and the rest of the
 * setup shows as a progress list. From vana.8, on a shell with page.setCover
 * that screen is drawn natively above the WebView, so Oura's pages never show
 * between steps; older shells keep the in-page overlay. See "Vana overlay"
 * and "Native cover" below.
 *
 * 90-day lookback window, cursor-paginated (next_token).
 *
 * Honest connector telemetry contract:
 * - Returns canonical flat result shape
 * - Explicit requestedScopes
 * - errors[] for unresolved output-affecting problems only
 * - omitted / degraded / fatal dispositions
 *
 * Monitoring contract (vana.14; the reference for every connector):
 * - Every step the run can be in has an id in STEPS, a literal below. The
 *   run reports the current one with `page.setProgress({ step })` during
 *   collection, and names the failing one on every error.
 * - Every error carries `errorClass` (the shared telemetry vocabulary) and a
 *   `code` from CODES: a literal that names the cause (`http_401`,
 *   `oauth_consent_empty`). The reason text is for the log and the person;
 *   analytics get class, code and step, never text.
 * - On failure the connector tells the host what it knows through
 *   `page.setData('errorDetail', { errorClass, code, step })` and
 *   `page.setData('scopeCounts', { <scope>: { found, ok } })`, so an empty
 *   account and a broken request are different numbers, not one `no_data`.
 * - The `telemetry-ids` block at the very top of this file lists every
 *   STEPS and CODES value (a test keeps them in step). The host reads only
 *   that block and keeps a code or step only if it is listed there, so
 *   nothing a run assembles from a person's data can reach analytics.
 */

const PLATFORM = "oura";
const VERSION = "3.1.0";
const CANONICAL_SCOPES = [
  "oura.readiness",
  "oura.sleep",
  "oura.activity",
];

// Where a run can be. Reported on progress and named on every failure.
// Ids only: a label is for people and never leaves the device.
const STEPS = {
  init: "init",
  portalSignin: "portal_signin",
  portalApp: "portal_app",
  authorize: "authorize",
  token: "token",
  fetchDailyReadiness: "fetch_daily_readiness",
  fetchDailySleep: "fetch_daily_sleep",
  fetchSleep: "fetch_sleep",
  fetchDailyActivity: "fetch_daily_activity",
  buildResult: "build_result",
};

const ENDPOINT_STEPS = {
  daily_readiness: "fetch_daily_readiness",
  daily_sleep: "fetch_daily_sleep",
  sleep: "fetch_sleep",
  daily_activity: "fetch_daily_activity",
};

// The step the run is in, for an error that carries no step of its own
// (an exception outside our envelope). Set at every boundary below, never
// from a response or a person's data.
let currentStep = "init";

// Why a run failed, one literal per cause. Add a code before adding a
// failure path; a cause without a code lands in analytics as `unknown`.
const CODES = {
  scopesInvalid: "scopes_invalid",
  portalUnreachable: "portal_unreachable",
  signinHeadless: "signin_needs_browser",
  signinUnconfirmed: "signin_unconfirmed",
  appListFailed: "portal_app_list_failed",
  appNotCreated: "portal_app_not_created",
  appSecretUnreadable: "portal_app_secret_unreadable",
  authorizeUnreachable: "authorize_page_unreachable",
  authorizeIncomplete: "authorize_incomplete",
  authorizeDeclined: "authorize_declined",
  authorizeNoCode: "authorize_no_code",
  authorizeBadState: "authorize_bad_state",
  tokenRequestFailed: "token_request_failed",
  tokenScopeMissing: "token_scope_missing",
  tokenRejected: "token_rejected",
  dailyAccessDenied: "daily_access_denied",
  apiAllFailed: "api_all_failed",
  apiScopeFailed: "api_scope_failed",
  apiScopeDegraded: "api_scope_degraded",
  unexpected: "unexpected",
};

const DEV_PORTAL = "https://developer.ouraring.com";
const APPS_URL = `${DEV_PORTAL}/applications`;
// Oura's external-API authorization server (the legacy
// cloud.ouraring.com/oauth/authorize redirects here but drops the scope).
const AUTHORIZE_URL = "https://moi.ouraring.com/oauth/v2/ext/oauth-authorize";
const TOKEN_URL = "https://moi.ouraring.com/oauth/v2/ext/oauth-token";
const API_BASE = "https://api.ouraring.com/v2/usercollection";

const APP_NAME = "Personal access";
const APP_REDIRECT_URI = "https://vana.org/oauth/oura/callback";
const APP_SCOPE = "extapi:daily";
const OAUTH_SCOPE = "extapi:daily";
const TOKEN_STORAGE_KEY = "vana:oura-connector:token";
// The sign-in method the Developer Portal uses (its authorize request lands on
// moi.ouraring.com/authn/authentication/default). Asking the consent step for
// the same method lets Oura reuse the session the person just opened on the
// portal, so they are not asked to sign in a second time.
const PORTAL_SIGN_IN_METHOD = "urn:se:curity:authentication:username:default";
// How long the authorize page may sit without a consent form before a request
// that named the portal's sign-in method is retried without it.
const SESSION_REUSE_GRACE_MS = 10000;
// How long the Create New form may stay unsubmitted, and how long the consent
// screen may stay up after Allow is pressed, before the person is asked to do
// that step by hand.
const CREATE_FORM_GRACE_MS = 15000;
const ALLOW_GRACE_MS = 8000;

const LOOKBACK_DAYS = 90;
const INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

// Each scope maps to the API V2 collections it is built from.
const ENDPOINT_LABELS = {
  daily_readiness: "readiness scores",
  daily_sleep: "sleep scores",
  sleep: "sleep sessions",
  daily_activity: "activity",
};

const SCOPE_ENDPOINTS = {
  "oura.readiness": ["daily_readiness"],
  "oura.sleep": ["daily_sleep", "sleep"],
  "oura.activity": ["daily_activity"],
};

// ── Telemetry helpers ──────────────────────────────────────────────

// `phase` is the desktop contract's field; `step` is the same id for hosts
// that read it. Both are STEPS values.
const makeConnectorError = (errorClass, code, reason, disposition, extras = {}) => ({
  errorClass,
  code,
  reason,
  disposition,
  ...extras,
  phase: extras.step,
});

const makeFatalRunError = (errorClass, code, reason, step) => {
  const error = new Error(reason);
  error.telemetryError = makeConnectorError(errorClass, code, reason, "fatal", { step });
  return error;
};

const inferErrorClass = (message, fallback = "runtime_error") => {
  const text = String(message || "").toLowerCase();
  if (text.includes("auth") || text.includes("login") || text.includes("credential")) {
    return "auth_failed";
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "timeout";
  }
  if (text.includes("network") || text.includes("fetch") || text.includes("net::")) {
    return "network_error";
  }
  if (text.includes("navigation") || text.includes("goto")) {
    return "navigation_error";
  }
  return fallback;
};

const buildResult = ({ requestedScopes, scopes, errors, exportSummary }) => ({
  requestedScopes: [...requestedScopes],
  timestamp: new Date().toISOString(),
  version: VERSION,
  platform: PLATFORM,
  exportSummary,
  errors,
  ...scopes,
});

const buildEmptyResult = (requestedScopes, errors) =>
  buildResult({
    requestedScopes,
    scopes: {},
    errors,
    exportSummary: {
      count: 0,
      label: "days of Oura data",
    },
  });

const resolveRequestedScopes = () => {
  const raw =
    typeof page.requestedScopes === "function" ? page.requestedScopes() : null;
  if (raw == null) {
    return [...CANONICAL_SCOPES];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw makeFatalRunError(
      "protocol_violation",
      CODES.scopesInvalid,
      "Oura connector received an empty or invalid requestedScopes array.",
      STEPS.init,
    );
  }
  const deduped = Array.from(new Set(raw));
  const invalid = deduped.filter((scope) => !CANONICAL_SCOPES.includes(scope));
  if (invalid.length > 0) {
    throw makeFatalRunError(
      "protocol_violation",
      CODES.scopesInvalid,
      `Oura connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
      STEPS.init,
    );
  }
  return deduped;
};

// ── Resilience helpers ──────────────────────────────────────────────

const withTimeout = async (promise, ms, label) => {
  let timeoutId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const safeGoto = async (url, options = {}) => {
  const { attempts = 3, timeout = 20000, betweenMs = 2000, label = url } = options;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await withTimeout(
        page.goto(url, { timeout }),
        timeout + 5000,
        `goto ${label}`,
      );
      return true;
    } catch (error) {
      const message = error?.message || String(error);
      console.error(
        `[oura] Navigation attempt ${attempt}/${attempts} failed for ${label}: ${message}`,
      );
      if (attempt < attempts) {
        await page.sleep(betweenMs);
      }
    }
  }
  return false;
};

const currentUrl = async () => {
  try {
    return String(await page.url());
  } catch {
    return "";
  }
};

// Origin + path only: never log query strings or fragments (they carry
// OAuth state and tokens).
const describeUrl = (url) => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unknown page)";
  }
};

// Polls `check` until it returns a truthy value or the timeout passes.
const waitFor = async (check, timeoutMs, intervalMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // keep polling
    }
    await page.sleep(intervalMs);
  }
  return null;
};

// ── Page state detection ────────────────────────────────────────────

// The token cache lives in the portal origin's localStorage, so reading or
// writing it only needs a portal document, not a fully rendered page. Polled
// instead of a fixed sleep: on mobile page.goto returns before the page loads.
// (From #1391.)
const PORTAL_READY_TIMEOUT_MS = 10000;
const PORTAL_READY_POLL_MS = 200;
// On Android an evaluate before the WebView has a document never answers, so
// each check is bounded. An unanswered check counts as "not on the portal",
// which loads it, the way earlier versions always did.
const PORTAL_CHECK_TIMEOUT_MS = 1500;
const onPortalDocument = async () => {
  try {
    return Boolean(await withTimeout(page.evaluate(`
      (() => location.origin === ${JSON.stringify(DEV_PORTAL)} && document.readyState !== 'loading')()
    `), PORTAL_CHECK_TIMEOUT_MS, "portal check"));
  } catch {
    return false;
  }
};

const isOnMoiLogin = (url) => url.startsWith("https://moi.ouraring.com/authn/");
const isOnRedirect = (url) => url.startsWith(APP_REDIRECT_URI);
const isOnAuthorize = (url) => url.startsWith("https://moi.ouraring.com/oauth/");
const isOnPortal = (url) => url.startsWith(DEV_PORTAL);

// Returns the signed-in Developer Portal email, or null.
const checkLoginStatus = async () => {
  try {
    return await page.evaluate(`
      (async () => {
        if (!location.href.startsWith(${JSON.stringify(DEV_PORTAL)})) return null;
        // The portal moved from NextAuth (/api/auth/session) to better-auth
        // (/api/auth/get-session) in early October 2026; the old route is a
        // 404 page now. Ask the current route first, keep the old one as a
        // fallback, and read the signed-in email from whichever answers.
        for (const route of ['/api/auth/get-session', '/api/auth/session']) {
          const resp = await fetch(route, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!resp.ok) continue;
          const data = await resp.json().catch(() => null);
          const email = data && data.user && data.user.email;
          if (email) return email;
          if (data !== null && typeof data === 'object') return null;
        }
        return null;
      })()
    `);
  } catch {
    return null;
  }
};

// Reads the OAuth redirect parameters. The code only travels back to the
// connector, never to the log stream.
const readRedirectParams = async () => {
  try {
    return await page.evaluate(`
      (() => {
        if (!location.href.startsWith(${JSON.stringify(APP_REDIRECT_URI)})) return null;
        const params = new URLSearchParams(location.search.slice(1) || location.hash.slice(1));
        return {
          code: params.get('code'),
          state: params.get('state'),
          error: params.get('error'),
        };
      })()
    `);
  } catch {
    return null;
  }
};

// Pre-fills the email on Oura's sign-in page so the user only has to enter
// the one-time code.
const prefillOuraEmail = async (email) => {
  if (!email) return;
  try {
    await page.evaluate(`
      (() => {
        const input = document.querySelector('input#username, input[type="email"]');
        if (!input || input.value) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(email)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
  } catch {
    // Pre-fill is a convenience only.
  }
};

// Submits Oura's email step when it holds the address we pre-filled, so a
// second sign-in is only "enter the new code". The form is a plain
// server-rendered POST (input#username, button#submit-button). Returns true
// once the click is sent; the caller submits at most once per attempt, so a
// rejected address is left for the person to correct.
const submitOuraEmail = async (email) => {
  if (!email) return false;
  try {
    return Boolean(await page.evaluate(`
      (() => {
        if (document.readyState !== 'complete') return false;
        const input = document.querySelector('input#username');
        const button = document.querySelector('#submit-button');
        const error = document.querySelector('#error-container');
        if (!input || !button) return false;
        if (input.value !== ${JSON.stringify(email)}) return false;
        if (error && error.textContent.trim()) return false;
        button.click();
        return true;
      })()
    `));
  } catch {
    return false;
  }
};

// ── Vana overlay ────────────────────────────────────────────────────
//
// On mobile the person never has to read Oura's pages. A full-screen Vana
// layer sits on top of them: it asks for the email and the one-time codes,
// types them into Oura's own forms underneath, and shows progress while the
// connector sets up the API application and approves access. Oura's pages
// stay real and in charge: every code goes to Oura's own form, and anything
// the overlay does not recognise falls back to showing Oura's page with an
// instruction in the status line.
//
// A row-level documentStartJs can hide each ouraring.com page as it loads
// (window.__vanaOuraRemoveVeil); vana.6 ships without one, because on iOS the
// provider WebView was never created when the row carried a documentStartJs
// (2026-10-02, shell 297ebcc). Without it, Oura's page shows briefly after
// each navigation until the next poll draws this layer.

const OVERLAY_MANUAL_KEY = "vana:oura:manual";

// Runs INSIDE the Oura page (serialised with toString), so it must not use
// anything from the connector's scope. Returns "shown", "hidden" or "manual"
// (the person chose Oura's own screen for this site).
function vanaOuraOverlay(state) {
  const HOST_ID = "vana-oura-overlay";
  const VEIL_ID = "vana-oura-veil";
  const MANUAL_KEY = "vana:oura:manual";
  const EMAIL_KEY = "vana:oura:email";
  const OTP_AT_KEY = "vana:oura:otp-at";
  const RESENT_AT_KEY = "vana:oura:resent-at";
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) {
      try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, String(v)); } catch (e) {}
    },
  };
  const removeVeil = () => {
    try { if (window.__vanaOuraRemoveVeil) window.__vanaOuraRemoveVeil(); } catch (e) {}
    const v = document.getElementById(VEIL_ID);
    if (v) v.remove();
  };
  const removeHost = () => { const h = document.getElementById(HOST_ID); if (h) h.remove(); };

  if (state.screen === "hidden") { removeHost(); removeVeil(); return "hidden"; }
  if (store.get(MANUAL_KEY) === "1") { removeHost(); removeVeil(); return "manual"; }
  const root = document.documentElement;
  if (!root) return "hidden";

  // Leaving the code screen ends that code's attempt, so a later sign-in on
  // this origin does not start with a stale "that code didn't work".
  if (state.screen !== "code") { store.set(OTP_AT_KEY, null); store.set(RESENT_AT_KEY, null); }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .screen {
      position: fixed; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch;
      background: #f4f4f4; color: #0a0a0a;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, Roboto, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
      display: flex; flex-direction: column;
      padding: 28px 24px calc(24px + env(safe-area-inset-bottom));
    }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; font-weight: 600; color: #5c5c5c; }
    .mark {
      width: 34px; height: 34px; border-radius: 999px; background: #eceaff;
      display: grid; place-items: center; flex: none;
    }
    .mark i { width: 16px; height: 16px; border-radius: 999px; border: 3px solid #4141fc; display: block; }
    h1 { font-size: 28px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 650; margin: 36px 0 10px; }
    p.lead { font-size: 17px; line-height: 1.45; color: #5c5c5c; margin: 0 0 28px; }
    p.lead b { color: #0a0a0a; font-weight: 600; }
    p.lead b.email { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
    label { display: block; font-size: 14px; font-weight: 600; margin: 0 0 8px; }
    input {
      width: 100%; height: 58px; border-radius: 14px; border: 1.5px solid #e2e2e2; background: #fff;
      padding: 0 18px; font: inherit; font-size: 18px; color: #0a0a0a; outline: none;
      transition: border-color .15s, box-shadow .15s; -webkit-appearance: none; appearance: none;
    }
    input:focus { border-color: #4141fc; box-shadow: 0 0 0 4px #eceaff; }
    input.code { text-align: center; font-size: 30px; letter-spacing: 0.4em; padding-left: calc(18px + 0.4em); font-variant-numeric: tabular-nums; font-weight: 600; }
    input.code::placeholder { letter-spacing: 0.3em; color: #c8c8c8; }
    .error { min-height: 22px; margin: 10px 2px 0; font-size: 15px; line-height: 1.4; color: #c81e1e; }
    .note { min-height: 22px; margin: 10px 2px 0; font-size: 15px; line-height: 1.4; color: #007a55; }
    button.primary {
      width: 100%; height: 56px; margin-top: 18px; border: 0; border-radius: 14px;
      background: #4141fc; color: #fff; font: inherit; font-size: 17px; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      -webkit-tap-highlight-color: transparent; cursor: pointer;
    }
    button.primary:active { transform: scale(0.99); background: #3434e0; }
    button.primary[disabled] { background: #8d87ef; }
    button.link {
      border: 0; background: none; padding: 12px 0; font: inherit; font-size: 16px; font-weight: 600;
      color: #4141fc; -webkit-tap-highlight-color: transparent; cursor: pointer;
    }
    .center { display: flex; justify-content: center; }
    .spinner {
      width: 22px; height: 22px; border-radius: 999px; flex: none;
      border: 2.5px solid rgba(255,255,255,.35); border-top-color: #fff; animation: spin .8s linear infinite;
    }
    .spinner.brand { border-color: #dcdcf8; border-top-color: #4141fc; }
    .spinner.big { width: 44px; height: 44px; border-width: 3.5px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .waiting { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 22px; padding-bottom: 60px; }
    .waiting h2 { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
    .waiting p { font-size: 16px; color: #5c5c5c; margin: 0; line-height: 1.45; max-width: 300px; }
    .card { background: #fff; border-radius: 18px; padding: 6px 18px; margin-top: 4px; }
    .step { display: flex; gap: 14px; padding: 16px 0; align-items: flex-start; }
    .step + .step { border-top: 1px solid #efefef; }
    .dot { width: 26px; height: 26px; border-radius: 999px; flex: none; display: grid; place-items: center; margin-top: -1px; }
    .dot.pending { border: 2px solid #e2e2e2; }
    .dot.done { background: #4141fc; }
    .dot.done::after { content: ""; width: 9px; height: 5px; border-left: 2.5px solid #fff; border-bottom: 2.5px solid #fff; transform: translateY(-1px) rotate(-45deg); }
    .dot.active .spinner { width: 24px; height: 24px; }
    .step .t { font-size: 16px; line-height: 1.35; font-weight: 600; }
    .step.pending .t { color: #9a9a9a; font-weight: 500; }
    .step .d { font-size: 14px; line-height: 1.4; color: #5c5c5c; margin-top: 4px; }
    .grow { flex: 1; min-height: 24px; }
    .foot { display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 12px; }
    .trust { display: flex; gap: 8px; align-items: center; font-size: 13px; color: #7a7a7a; text-align: center; line-height: 1.4; }
    .done-mark { width: 64px; height: 64px; border-radius: 999px; background: #4141fc; display: grid; place-items: center; }
    .done-mark::after { content: ""; width: 22px; height: 12px; border-left: 4px solid #fff; border-bottom: 4px solid #fff; transform: translateY(-3px) rotate(-45deg); }
  `;

  let host = document.getElementById(HOST_ID);
  const fresh = !host;
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    // Through the CSSOM: Oura's sign-in pages carry a nonce CSP that drops
    // style attributes and <style> tags, but not CSSOM writes or constructed
    // stylesheets.
    for (const [prop, value] of [["position", "fixed"], ["inset", "0"], ["z-index", "2147483647"],
      ["visibility", "visible"], ["opacity", "1"], ["pointer-events", "auto"], ["display", "block"]]) {
      host.style.setProperty(prop, value, "important");
    }
    const shadow = host.attachShadow({ mode: "open" });
    let adopted = false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
      adopted = true;
    } catch (e) {}
    if (!adopted) {
      const style = document.createElement("style");
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    root.appendChild(host);
  }
  const shadow = host.shadowRoot;

  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const child of children.flat()) if (child != null) node.append(child);
    return node;
  };

  // Types into one of Oura's own inputs the way a person would, so the page's
  // script sees input and change events.
  const fillOura = (selector, value) => {
    const input = document.querySelector(selector);
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  };
  const submitOura = (selector) => {
    const button = document.querySelector(selector);
    if (button && !button.disabled) { button.click(); return true; }
    const form = button ? button.form : document.querySelector("form");
    if (form && typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
    return false;
  };
  // Oura's own error text on the page underneath, if it shows one.
  const ouraError = () => {
    const node = document.querySelector("#error-container, [role='alert'], .error-message, .alert-danger");
    const text = node ? (node.innerText || node.textContent || "").trim() : "";
    return text.slice(0, 200);
  };

  const brand = () => el("div", { class: "brand" }, el("span", { class: "mark" }, el("i")), "Connect Oura Ring");
  // No footer: nothing on these screens points at the page underneath.
  const footer = () => null;
  const setBusy = (button, busy, label) => {
    button.disabled = busy;
    button.replaceChildren(...(busy ? [el("span", { class: "spinner" }), label] : [label]));
  };

  const buildEmail = () => {
    const input = el("input", {
      type: "email", inputmode: "email", autocomplete: "email", autocapitalize: "off",
      autocorrect: "off", spellcheck: "false", placeholder: "you@example.com", id: "vana-email",
    });
    // Oura pre-fills the address it last saw on its own form; reuse it.
    const remembered = document.querySelector("input#username");
    input.value = state.email || store.get(EMAIL_KEY) || (remembered && remembered.value) || "";
    const error = el("div", { class: "error", role: "alert" });
    const button = el("button", { class: "primary", type: "submit", text: "Email me a code" });
    let tries = 0;
    const send = (value) => {
      if (fillOura("input#username", value) && submitOura("#submit-button")) return;
      if (++tries > 20) { setBusy(button, false, "Email me a code"); error.textContent = "Something went wrong. Try again."; return; }
      setTimeout(() => send(value), 500);
    };
    const form = el("form", {
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          error.textContent = "Enter the email address you use with Oura.";
          input.focus();
          return;
        }
        error.textContent = "";
        store.set(EMAIL_KEY, value);
        setBusy(button, true, "Sending code…");
        tries = 0;
        send(value);
      },
    },
      el("label", { for: "vana-email", text: "Email" }),
      input,
      error,
      button,
    );
    return el("div", { class: "screen" },
      brand(),
      el("h1", { text: "Sign in to Oura" }),
      el("p", { class: "lead", text: "Enter the email you use with Oura. Oura will email you a 6-digit sign-in code." }),
      form,
      el("div", { class: "grow" }),
      footer(),
    );
  };

  const buildCode = () => {
    const second = state.variant === "second";
    const shownEmail = state.email || store.get(EMAIL_KEY) || "";
    const input = el("input", {
      class: "code", type: "text", inputmode: "numeric", autocomplete: "one-time-code",
      pattern: "[0-9]*", maxlength: "6", placeholder: "••••••", id: "vana-code",
      "aria-label": "6-digit code",
    });
    const error = el("div", { class: "error", role: "alert" });
    const note = el("div", { class: "note", role: "status" });
    const button = el("button", { class: "primary", type: "submit", text: "Continue" });
    const submit = () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 6);
      if (digits.length !== 6) {
        error.textContent = "Enter the 6-digit code from Oura's email.";
        input.focus();
        return;
      }
      error.textContent = "";
      note.textContent = "";
      store.set(OTP_AT_KEY, Date.now());
      setBusy(button, true, "Checking code…");
      if (!(fillOura("input#otp-code, input[autocomplete='one-time-code'], input[name='otp']", digits) &&
            submitOura("#submit-button"))) {
        setBusy(button, false, "Continue");
        error.textContent = "Something went wrong. Try again.";
      }
    };
    input.addEventListener("input", () => {
      const digits = input.value.replace(/\D/g, "").slice(0, 6);
      if (input.value !== digits) input.value = digits;
      error.textContent = "";
      if (digits.length === 6 && !button.disabled) submit();
    });
    const form = el("form", { novalidate: true, onsubmit: (event) => { event.preventDefault(); submit(); } },
      input, error, note, button);
    const resend = el("button", {
      class: "link",
      type: "button",
      text: "Send a new code",
      onclick: () => {
        // By address first: Oura localises the link text.
        const candidates = [...document.querySelectorAll("a, button")].filter((node) => !host.contains(node));
        const link =
          candidates.find((node) => /resend/i.test(node.getAttribute("href") || "")) ||
          candidates.find((node) => /resend|ponownie|erneut|renvoyer|reenviar|reinviare|opnieuw/i.test(node.innerText || node.textContent || ""));
        if (!link) { error.textContent = "Couldn't send a new code. Try again in a moment."; return; }
        store.set(RESENT_AT_KEY, Date.now());
        error.textContent = "";
        note.textContent = "New code requested. Check your email.";
        link.click();
      },
    });
    const lead = el("p", { class: "lead" },
      second ? "Oura asks you to confirm it's you once more. Enter the " : "Enter the 6-digit code Oura sent to ",
      second ? el("b", { text: "new" }) : null,
      second ? " code sent to " : null,
      shownEmail ? el("b", { class: "email", text: shownEmail }) : "your email",
      ".");
    return el("div", { class: "screen" },
      brand(),
      el("h1", { text: second ? "One more code" : "Check your email" }),
      lead,
      form,
      el("div", { class: "center" }, resend),
      el("div", { class: "grow" }),
      footer(),
    );
  };

  const buildWaiting = () =>
    el("div", { class: "screen" },
      brand(),
      el("div", { class: "waiting" },
        el("div", { class: "spinner brand big" }),
        el("h2", { text: state.title || "One moment…" }),
        state.body ? el("p", { text: state.body }) : null,
      ),
      footer(),
    );

  const buildSteps = () => {
    const done = state.screen === "done";
    return el("div", { class: "screen" },
      brand(),
      done
        ? el("div", { class: "waiting" },
            el("div", { class: "done-mark" }),
            el("h2", { text: state.title || "Oura connected" }),
            state.body ? el("p", { text: state.body }) : null)
        : [
            el("h1", { text: state.title || "Connecting your Oura Ring" }),
            el("p", { class: "lead", text: state.body || "This takes about a minute. Keep this screen open." }),
            el("div", { class: "card", "data-steps": "1" }),
            el("div", { class: "grow" }),
          ],
    );
  };
  const renderSteps = () => {
    const card = shadow.querySelector("[data-steps]");
    if (!card) return;
    card.replaceChildren(...(state.steps || []).map((step) =>
      el("div", { class: `step ${step.status}` },
        el("div", { class: `dot ${step.status}` }, step.status === "active" ? el("span", { class: "spinner brand" }) : null),
        el("div", {},
          el("div", { class: "t", text: step.label }),
          step.detail ? el("div", { class: "d", text: step.detail }) : null),
      )));
  };

  const key = `${state.screen}:${state.variant || ""}:${state.title || ""}`;
  if (host.dataset.key !== key) {
    const builders = { email: buildEmail, code: buildCode, waiting: buildWaiting, working: buildSteps, done: buildSteps };
    const screen = (builders[state.screen] || buildWaiting)();
    [...shadow.childNodes].forEach((node) => { if (node.nodeName !== "STYLE") node.remove(); });
    shadow.append(screen);
    host.dataset.key = key;
    const focusTarget = shadow.querySelector("input");
    if (focusTarget && !focusTarget.value) setTimeout(() => focusTarget.focus(), 50);
  }
  if (state.screen === "working") renderSteps();

  // A fresh code screen right after a code was submitted means Oura sent the
  // person back to the same step: the code was wrong or expired.
  if (fresh && state.screen === "code") {
    const error = shadow.querySelector(".error");
    const submittedAt = Number(store.get(OTP_AT_KEY)) || 0;
    const resentAt = Number(store.get(RESENT_AT_KEY)) || 0;
    if (resentAt && Date.now() - resentAt < 120000) {
      shadow.querySelector(".note").textContent = "New code requested. Check your email.";
    } else if (submittedAt && Date.now() - submittedAt < 120000 && error) {
      error.textContent = ouraError() || "That code didn't work. Check it, or send a new code.";
    }
    store.set(OTP_AT_KEY, null);
    store.set(RESENT_AT_KEY, null);
  }
  if (fresh && state.screen === "email") {
    const message = ouraError();
    if (message) shadow.querySelector(".error").textContent = message;
  }

  removeVeil();
  return "shown";
}

const OVERLAY_SOURCE = vanaOuraOverlay.toString();
let overlayInstalledFor = "";
let lastStatus = null;

const setStatus = async (text) => {
  if (text === lastStatus) return;
  lastStatus = text;
  await page.setData("status", text);
};

/**
 * Draws (or updates) the overlay and keeps the shell's status card in step:
 * empty while the overlay covers the page, the plain instruction when the
 * person is looking at Oura's own page. A single space hides the card (the
 * shell ignores an empty string).
 */
// Oura's OAuth hops are always in transit and never need the person, so they
// stay covered however long they take (a slow device spent >5 s on one). Any
// other page that asks to hide gets a grace period counted from load
// complete, and the last screen is redrawn meanwhile, so a page change never
// shows Oura's page or the shell's header in between.
const UNKNOWN_PAGE_GRACE_MS = 15000;
let hideGrace = { url: "", since: 0 };
let lastCoverState = null;
const isOuraTransitPage = (url) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith("ouraring.com") && parsed.pathname.includes("/oauth/");
  } catch {
    return false;
  }
};
const pageSettled = async () => {
  try {
    return (await page.evaluate("document.readyState")) === "complete";
  } catch {
    return false;
  }
};
const keepCovering = async () => {
  const url = await currentUrl();
  if (isOuraTransitPage(url)) return true;
  if (hideGrace.url !== url) hideGrace = { url, since: 0 };
  if (!hideGrace.since && (await pageSettled())) hideGrace.since = Date.now();
  return !hideGrace.since || Date.now() - hideGrace.since < UNKNOWN_PAGE_GRACE_MS;
};

const showOverlay = async (state, instruction, options = {}) => {
  if (state.screen === "hidden") {
    if (!options.now && !(NATIVE_COVER && cover.manual) && lastCoverState && (await keepCovering())) {
      state = lastCoverState;
    }
  } else {
    hideGrace = { url: "", since: 0 };
    lastCoverState = state;
  }
  if (NATIVE_COVER) return showNativeCover(state, instruction, options);
  let result = "hidden";
  try {
    const url = await currentUrl();
    const call = `window.__vanaOuraOverlay(${JSON.stringify(state)})`;
    if (overlayInstalledFor === url) {
      result = await page.evaluate(`(window.__vanaOuraOverlay ? ${call} : "missing")`);
    }
    if (result === "missing" || overlayInstalledFor !== url) {
      result = await page.evaluate(
        `((window.__vanaOuraOverlay = ${OVERLAY_SOURCE}), ${call})`,
      );
      overlayInstalledFor = url;
    }
  } catch (error) {
    console.error(`[oura] Overlay could not be drawn: ${error?.message || error}`);
    result = null;
  }
  if (result === "shown") {
    await setStatus(" ");
  } else if (result === "hidden" || result === "manual") {
    await setStatus(instruction || describeState(state));
  } else {
    // The page was navigating (the shim answers null). The next document is
    // veiled until the next poll draws; leave the status line alone.
    overlayInstalledFor = "";
  }
  return result;
};

// ── Native cover ────────────────────────────────────────────────────
//
// A shell with page.setCover draws the Vana screens itself, as a native layer
// above the provider WebView. Oura's navigations happen underneath it, so no
// Oura page shows between steps and nothing has to be redrawn per document.
// The connector sends the screen to draw and reads back what the person did
// (page.takeCoverActions): an email or code to type into Oura's own form, a
// "send a new code" tap, or "use Oura's own screen instead".

const NATIVE_COVER =
  typeof page.setCover === "function" && typeof page.takeCoverActions === "function";
// No footer and no "use Oura's own screen" link: to the person this is simply
// the Oura sign-in. Unrecognised pages still hand over by themselves.
const COVER_TRUST = null;
const COVER_MANUAL = null;
// A fallback hide waits this long, so a redirect through a page the connector
// does not recognise does not uncover Oura for a moment.
// The hand-over grace now lives in showOverlay (see keepCovering).
const COVER_HIDE_GRACE_MS = 0;
// An email the person submitted waits this long for Oura's email form.
const COVER_EMAIL_WAIT_MS = 10000;
// A code screen within this long of a submitted code is Oura's answer to it.
const COVER_ANSWER_WINDOW_MS = 120000;

const cover = {
  manual: false,
  email: null,
  key: "",
  error: null,
  note: null,
  pendingEmail: null,
  pendingEmailSince: 0,
  emailSubmittedAt: 0,
  codeSubmittedAt: 0,
  resentAt: 0,
  hideRequestedAt: 0,
  drawn: null,
};

// Types into one of Oura's own inputs and submits its form, the way the
// in-page overlay does. Marks the document, so a fresh copy of the same page
// (Oura's answer) can be told apart from the one the value went into.
const fillAndSubmitOura = async (selector, value, mark) => {
  try {
    return Boolean(await page.evaluate(`
      (() => {
        if (document.readyState !== 'complete') return false;
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const button = document.querySelector('#submit-button');
        if (button && !button.disabled) button.click();
        else if (input.form && typeof input.form.requestSubmit === 'function') input.form.requestSubmit();
        else return false;
        window[${JSON.stringify(mark)}] = true;
        return true;
      })()
    `));
  } catch {
    return false;
  }
};

// Whether the current document is a new one since a value was submitted.
const isFreshDocument = async (mark) => {
  try {
    return (await page.evaluate(`(() => !window[${JSON.stringify(mark)}])()`)) === true;
  } catch {
    return false;
  }
};

// Oura's own error text on its page, if it shows one.
const readOuraError = async () => {
  try {
    const text = await page.evaluate(`
      (() => {
        const node = document.querySelector("#error-container, [role='alert'], .error-message, .alert-danger");
        return node ? (node.innerText || node.textContent || '').trim().slice(0, 200) : '';
      })()
    `);
    return typeof text === "string" && text ? text : null;
  } catch {
    return null;
  }
};

// Taps Oura's "resend code" link. By address first: Oura localises the text.
const clickOuraResend = async () => {
  try {
    return Boolean(await page.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('a, button')];
        const link =
          candidates.find((node) => /resend/i.test(node.getAttribute('href') || '')) ||
          candidates.find((node) => /resend|ponownie|erneut|renvoyer|reenviar|reinviare|opnieuw/i.test(node.innerText || node.textContent || ''));
        if (!link) return false;
        window.__vanaCoverResent = true;
        link.click();
        return true;
      })()
    `));
  } catch {
    return false;
  }
};

const CODE_SELECTOR = "input#otp-code, input[autocomplete='one-time-code'], input[name='otp']";

const applyCoverActions = async () => {
  let actions = [];
  try {
    actions = (await page.takeCoverActions()) || [];
  } catch (error) {
    console.error(`[oura] Could not read the cover: ${error?.message || error}`);
  }
  for (const action of actions) {
    if (action?.type === "manual") {
      cover.manual = true;
    } else if (action?.type === "submit" && action.field === "email") {
      cover.email = String(action.value || "");
      cover.pendingEmail = cover.email;
      cover.pendingEmailSince = Date.now();
      cover.error = null;
    } else if (action?.type === "submit" && action.field === "code") {
      const digits = String(action.value || "").replace(/\D/g, "").slice(0, 6);
      if (await fillAndSubmitOura(CODE_SELECTOR, digits, "__vanaCoverCodeSent")) {
        cover.codeSubmittedAt = Date.now();
        cover.resentAt = 0;
        cover.error = null;
        cover.note = null;
      } else {
        cover.error = "Something went wrong. Try again.";
      }
    } else if (action?.type === "link" && action.id === "resend") {
      if (await clickOuraResend()) {
        cover.resentAt = Date.now();
        cover.codeSubmittedAt = 0;
        cover.error = null;
        cover.note = "New code requested. Check your email.";
      } else {
        cover.error = "Couldn't send a new code. Try again in a moment.";
      }
    }
  }

  if (cover.pendingEmail) {
    if (await fillAndSubmitOura("input#username", cover.pendingEmail, "__vanaCoverEmailSent")) {
      cover.pendingEmail = null;
      cover.emailSubmittedAt = Date.now();
    } else if (Date.now() - cover.pendingEmailSince > COVER_EMAIL_WAIT_MS) {
      cover.pendingEmail = null;
      cover.error = "Something went wrong. Try again.";
    }
  }
};

// Oura's answer to a submitted email or code: the same page again, as a new
// document, means it was refused.
const readCoverAnswer = async (screen) => {
  const now = Date.now();
  if (screen === "code" && cover.codeSubmittedAt && now - cover.codeSubmittedAt < COVER_ANSWER_WINDOW_MS) {
    if (await isFreshDocument("__vanaCoverCodeSent")) {
      cover.codeSubmittedAt = 0;
      cover.error = (await readOuraError()) || "That code didn't work. Check it, or send a new code.";
    }
  }
  if (screen === "email" && cover.emailSubmittedAt && now - cover.emailSubmittedAt < COVER_ANSWER_WINDOW_MS) {
    if (await isFreshDocument("__vanaCoverEmailSent")) {
      cover.emailSubmittedAt = 0;
      cover.error = (await readOuraError()) || "Oura didn't accept that email. Check it and try again.";
    }
  }
  if (screen !== "code") { cover.codeSubmittedAt = 0; cover.resentAt = 0; }
  if (screen !== "email") cover.emailSubmittedAt = 0;
};

// The overlay's state, as the shell's cover screen.
const toCoverState = (state) => {
  const footer = { trust: COVER_TRUST, manualLabel: COVER_MANUAL };
  if (state.screen === "email") {
    return {
      screen: "input",
      key: "email",
      title: "Sign in to Oura",
      body: "Enter the email you use with Oura. Oura will email you a 6-digit sign-in code.",
      input: {
        kind: "email",
        value: state.email || cover.email || undefined,
        label: "Email",
        placeholder: "you@example.com",
        submitLabel: "Email me a code",
        busyLabel: "Sending code…",
      },
      ...footer,
    };
  }
  if (state.screen === "code") {
    const second = state.variant === "second";
    const email = state.email || cover.email;
    const to = email ? `sent to ${email}` : "Oura emailed you";
    return {
      screen: "input",
      key: `code:${second ? "second" : "first"}`,
      title: second ? "One more code" : "Check your email",
      body: second
        ? `Oura asks you to confirm it's you once more. Enter the new code ${to}.`
        : `Enter the 6-digit code ${to}.`,
      input: { kind: "code", length: 6, submitLabel: "Continue", busyLabel: "Checking code…" },
      links: [{ id: "resend", label: "Send a new code" }],
      ...footer,
    };
  }
  if (state.screen === "working") {
    return {
      screen: "steps",
      key: "steps",
      title: state.title || "Connecting your Oura Ring",
      body: state.body || "This takes about a minute. Keep this screen open.",
      steps: state.steps || [],
    };
  }
  if (state.screen === "done") {
    return { screen: "done", key: "done", title: state.title || "Oura connected", body: state.body };
  }
  if (state.screen === "hidden") return { screen: "hidden" };
  return {
    screen: "waiting",
    key: `waiting:${state.title || ""}`,
    title: state.title || "One moment…",
    body: state.body,
    ...footer,
  };
};

const showNativeCover = async (state, instruction, { now = false } = {}) => {
  await applyCoverActions();

  if (state.screen === "hidden" && !now && !cover.manual) {
    // A fallback hide: keep the cover through a short redirect.
    if (!cover.hideRequestedAt) cover.hideRequestedAt = Date.now();
    if (Date.now() - cover.hideRequestedAt < COVER_HIDE_GRACE_MS) return "shown";
  } else if (state.screen !== "hidden") {
    cover.hideRequestedAt = 0;
  }

  await readCoverAnswer(state.screen);
  const next = cover.manual ? { screen: "hidden" } : toCoverState(state);
  if (next.key !== cover.key) {
    // A new screen starts clean; an answer to the old one no longer applies.
    cover.key = next.key || "";
    cover.error = null;
    cover.note = null;
  }
  if (cover.error) next.error = cover.error;
  if (cover.note) next.note = cover.note;

  let result = null;
  try {
    result = await page.setCover(next);
  } catch (error) {
    console.error(`[oura] Cover could not be drawn: ${error?.message || error}`);
  }
  if (result === "manual") cover.manual = true;
  if (result === "shown") {
    await setStatus(" ");
  } else {
    await setStatus(instruction || describeState(state));
  }
  return result || "hidden";
};

// The status line to show when the person is looking at Oura's own page.
const describeState = (state) => {
  const active = (state.steps || []).find((step) => step.status === "active");
  if (active) return `${active.label}…`;
  return state.title || "Continue on Oura's screen.";
};

// A hide the connector decides on (the person must act on Oura's page) is
// immediate. Every other hide is a fallback for a page the connector does not
// recognise, which on the native cover waits out short redirects first.
const hideOverlay = (instruction, { now = false } = {}) =>
  showOverlay({ screen: "hidden" }, instruction, { now });

const STEP_LABELS = [
  "Sign in to Oura",
  "Set up your personal Oura app",
  "Approve access to sleep, readiness and activity",
  "Download your last 90 days",
];

const workingState = (activeStep, detail, extra = {}) => ({
  screen: "working",
  steps: STEP_LABELS.map((label, index) => ({
    label,
    status: index < activeStep ? "done" : index === activeStep ? "active" : "pending",
    detail: index === activeStep ? detail : undefined,
  })),
  ...extra,
});

// Every non-input moment is the steps list: the active step carries the
// detail. One screen kind means no jumps between a spinner and the list.
const waitingState = (detail, _body, activeStep = 0) => workingState(activeStep, detail);

// Which of Oura's sign-in pages the browser is on, read from the form on the
// page. The address alone is not enough: the first sign-in's email step is
// /authn/authentication/default, the consent sign-in's is .../default_ext.
const moiPage = async (url) => {
  const kind = await page.evaluate(`
    (() => {
      if (document.querySelector('input#otp-code, input[autocomplete="one-time-code"], input[name="otp"]')) return 'code';
      if (document.querySelector('input#username, input[type="email"]')) return 'email';
      if (document.querySelector('button[name="selectedId"], #passkey-button')) return 'method';
      return document.readyState === 'complete' ? 'unknown' : 'loading';
    })()
  `).catch(() => null);
  if (kind && kind !== "unknown") return kind;
  let path = "";
  try { path = new URL(url).pathname; } catch { return "loading"; }
  if (path.includes("/enter-otp")) return "code";
  if (path.includes("auth_selector")) return "method";
  if (path.includes("/authn/authentication/default")) return "email";
  // No answer from the page (mid-navigation) is not an unknown page.
  return kind === "unknown" ? "unknown" : "loading";
};

// On Oura's "Choose how to sign in" page, picks "Email me a code" (never the
// passkey: the overlay collects codes, not passkeys). Once per page. Chosen by
// the form's structure, not its wording: Oura localises the page (Polish:
// "Wybierz sposób logowania się", the button says "e-mail").
const chooseEmailCode = async () => {
  try {
    return Boolean(await page.evaluate(`
      (() => {
        if (window.__vanaChoseEmailCode) return true;
        if (document.readyState !== 'complete') return false;
        const options = [...document.querySelectorAll('button[name="selectedId"], input[type="submit"][name="selectedId"]')]
          .filter((b) => b.id !== 'passkey-button' && !/passkey/i.test(b.value || ''));
        const button = options.length === 1
          ? options[0]
          : options.find((b) => /e-?mail|otp|code/i.test((b.value || '') + ' ' + (b.innerText || '')));
        if (!button) return false;
        window.__vanaChoseEmailCode = true;
        button.click();
        return true;
      })()
    `));
  } catch {
    return false;
  }
};

// A sign-in step the connector drives itself (picking the email-code option,
// re-submitting the email) must move on within this long; otherwise the
// person is handed Oura's page, since the cover has no manual escape.
const DRIVEN_STEP_GRACE_MS = 8000;
let drivenStep = { url: "", since: 0 };
const stuckOn = (url) => {
  if (drivenStep.url !== url) drivenStep = { url, since: Date.now() };
  return Date.now() - drivenStep.since > DRIVEN_STEP_GRACE_MS;
};

/**
 * One poll of Oura's sign-in pages under the overlay. The first sign-in asks
 * the person for their email; the second (consent) sign-in already knows it
 * and submits it itself, so the person only types the new code.
 */
const driveOuraSignIn = async (url, { second, email, submitEmail }) => {
  const kind = await moiPage(url);
  if (kind === "loading") return kind;
  if (kind === "email") {
    if (second && email && submitEmail) {
      await submitEmail();
      if (stuckOn(url)) {
        // Oura kept the email step (rejected address, changed page): the
        // person finishes it on Oura's page.
        console.error("[oura] Second sign-in email step did not advance; handing over");
        await hideOverlay("Enter your email to sign in to Oura.", { now: true });
        return kind;
      }
      await showOverlay(
        waitingState("Confirming it's you with Oura…", null, 2),
        "Oura asks you to sign in once more. Sending your email…",
      );
    } else {
      await showOverlay({ screen: "email", email: email || undefined }, "Enter your email to sign in to Oura.");
    }
  } else if (kind === "method") {
    await chooseEmailCode();
    if (stuckOn(url)) {
      // The email-code option could not be picked (Oura changed the page),
      // or picking it did not move on. There is no manual escape on the
      // cover, so hand the person Oura's page.
      console.error("[oura] Could not pick Oura's email-code option; handing over");
      await hideOverlay("Tap 'Email me a code'.", { now: true });
      return kind;
    }
    await showOverlay(
      waitingState("Sending your code…", null, second ? 2 : 0),
      "Tap 'Email me a code'.",
    );
  } else if (kind === "code") {
    await showOverlay(
      { screen: "code", variant: second ? "second" : "first", email: email || undefined },
      "Enter the code Oura emailed you.",
    );
  } else {
    await hideOverlay("Finish signing in to Oura on this screen.");
  }
  return kind;
};

// ── Cached access token (connector browser profile, portal origin) ──

const readCachedToken = async () => {
  try {
    return await page.evaluate(`
      (() => {
        if (!location.href.startsWith(${JSON.stringify(DEV_PORTAL)})) return null;
        try {
          const raw = localStorage.getItem(${JSON.stringify(TOKEN_STORAGE_KEY)});
          return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
      })()
    `);
  } catch {
    return null;
  }
};

const writeCachedToken = async (entry) => {
  try {
    await page.evaluate(`
      (() => {
        if (!location.href.startsWith(${JSON.stringify(DEV_PORTAL)})) return false;
        try {
          if (${JSON.stringify(entry)} === null) {
            localStorage.removeItem(${JSON.stringify(TOKEN_STORAGE_KEY)});
          } else {
            localStorage.setItem(${JSON.stringify(TOKEN_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(entry))});
          }
          return true;
        } catch (e) { return false; }
      })()
    `);
  } catch {
    // Caching is an optimisation; the next run re-authorizes.
  }
};

// A cheap, date-bounded call that proves the token still reads daily data.
const probeToken = async (accessToken) => {
  const today = new Date().toISOString().split("T")[0];
  const resp = await page.httpFetch(
    `${API_BASE}/daily_activity?start_date=${today}&end_date=${today}`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      timeout: 15000,
    },
  );
  return {
    status: resp.status,
    detail: resp.ok
      ? null
      : `${String(resp.text || resp.error || "").slice(0, 160)}${resp.headers?.["www-authenticate"] ? ` (www-authenticate: ${resp.headers["www-authenticate"]})` : ""}`,
  };
};

// ── Developer portal API (same-origin proxy, cookie session) ────────

/**
 * Calls the portal's API proxy. Only whitelisted fields cross back into the
 * connector: the client secret stays inside the page.
 */
const portalApi = async (method, path) =>
  page.evaluate(`
    (async () => {
      try {
        const resp = await fetch(${JSON.stringify(`/api/extapi/v2/oauth${path}`)}, {
          method: ${JSON.stringify(method)},
          credentials: 'include',
          headers: { 'Accept': 'application/json' },
        });
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        const pick = (app) => app && typeof app === 'object' ? {
          clientId: app.client_id,
          name: app.application_name,
          redirectUris: app.redirect_uris || [],
          scopes: app.scopes || [],
          status: app.application_status,
        } : null;
        return {
          ok: resp.ok,
          status: resp.status,
          apps: Array.isArray(json) ? json.map(pick) : null,
          detail: json && json.detail ? String(json.detail).slice(0, 200) : (resp.ok ? null : text.slice(0, 200)),
        };
      } catch (err) {
        return { ok: false, status: 0, detail: err.message || String(err) };
      }
    })()
  `);

// The authorization-code flow needs no implicit grant, so an app with it
// disabled is still usable.
const isUsableApp = (app) =>
  app &&
  app.clientId &&
  app.redirectUris.includes(APP_REDIRECT_URI) &&
  app.scopes.includes(APP_SCOPE);

// Returns { clientId } for a usable app, or { clientId: null } when none
// exists. Throws when the portal API itself fails.
const findApiApplication = async () => {
  currentStep = STEPS.portalApp;
  const listed = await portalApi("GET", "/applications");
  if (listed?.status === 401 || listed?.status === 403) {
    // The better-auth session cookie can outlive the portal's upstream API
    // session: get-session still names the user while the applications API
    // answers 401. That is a stale sign-in, not a portal failure.
    return { clientId: null, unauthorized: true };
  }
  if (!listed?.ok || !Array.isArray(listed.apps)) {
    throw makeFatalRunError(
      "upstream_error",
      CODES.appListFailed,
      `Could not list Oura API applications (HTTP ${listed?.status || "unknown"}): ${listed?.detail || "no detail"}`,
      STEPS.portalApp,
    );
  }
  const usable =
    listed.apps.find((app) => app?.name === APP_NAME && isUsableApp(app)) ||
    listed.apps.find((app) => isUsableApp(app));
  return { clientId: usable ? usable.clientId : null };
};

// One step of submitting the Create New form per call, so the page's own
// script sees each change before the next: first tick the agreement box, then
// (on a later call) press "Create Application" once it is enabled. Returns
// "ticked", "submitted" or "waiting".
const submitCreateForm = async () => {
  try {
    return await page.evaluate(`
      (() => {
        const labelOf = (box) => ((box.closest('label') || box.parentElement || {}).innerText || '').trim();
        const agreement = [...document.querySelectorAll('input[type="checkbox"]')].find((box) => /agree/i.test(labelOf(box)));
        if (!agreement) return 'waiting';
        if (!agreement.checked) { agreement.click(); return 'ticked'; }
        const button = [...document.querySelectorAll('button')].find((b) => /create application/i.test(b.innerText || ''));
        if (!button || button.disabled) return 'waiting';
        button.click();
        return 'submitted';
      })()
    `);
  } catch {
    return "waiting";
  }
};

/**
 * Opens the portal's "Create New" form, fills it, accepts the Oura API
 * Agreement and submits it. If that does not create the application, the
 * person is asked to finish the form. Runs in the headed browser.
 */
const createApiApplicationWithUser = async (contactEmail) => {
  currentStep = STEPS.portalApp;
  await showOverlay(workingState(1, "Creates an app on your Oura developer account and accepts the Oura API Agreement for it."));
  await safeGoto(APPS_URL, { label: "developer portal" });
  await page.sleep(2000);

  await page.evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /create new/i.test(b.innerText || ''));
      if (btn) btn.click();
    })()
  `);
  await page.sleep(1500);

  const filled = await page.evaluate(`
    (() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const textSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      const setValue = (el, value) => {
        if (!el) return false;
        (el.tagName === 'TEXTAREA' ? textSetter : setter).call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      };
      const byPlaceholder = (p) => [...document.querySelectorAll('input, textarea')].filter((el) => el.placeholder === p);
      const urls = byPlaceholder('Enter a URL');
      const results = [
        setValue(byPlaceholder('Enter a display name')[0], ${JSON.stringify(APP_NAME)}),
        setValue(byPlaceholder('Enter a description')[0], 'Personal connector that exports my own Oura readiness, sleep and activity data to my Vana account.'),
        setValue(byPlaceholder('Enter an email')[0], ${JSON.stringify(contactEmail)}),
        setValue(urls[0], 'https://vana.org'),
        setValue(urls[1], 'https://vana.org/privacy'),
        setValue(urls[2], 'https://vana.org/terms'),
        setValue(byPlaceholder('URI')[0], ${JSON.stringify(APP_REDIRECT_URI)}),
      ];
      // Least privilege: only the Daily scope. The API Agreement box is
      // ticked by submitCreateForm, after the status line has named it.
      for (const box of document.querySelectorAll('input[type="checkbox"]')) {
        const label = ((box.closest('label') || box.parentElement || {}).innerText || '').trim();
        if (/agree/i.test(label)) continue;
        const wanted = /^daily$/i.test(label);
        if (box.checked !== wanted) box.click();
      }
      return results.every(Boolean);
    })()
  `);
  if (!filled) {
    console.error("[oura] Could not pre-fill every field of the Create New form; the user completes it.");
  }

  // The connector accepts the agreement and submits the form itself. The
  // status line names the agreement first, so the person is told what is
  // accepted for their Oura account. If the form does not go through, they
  // are asked to finish it by hand.
  await showOverlay(workingState(1, "Creates an app on your Oura developer account and accepts the Oura API Agreement for it."));
  let submitted = false;
  let askedToFinish = false;
  const startedAt = Date.now();
  const created = await waitFor(async () => {
    if (!isOnPortal(await currentUrl())) return null;
    if (!askedToFinish) await showOverlay(workingState(1, "Creates an app on your Oura developer account and accepts the Oura API Agreement for it."));
    const { clientId } = await findApiApplication();
    if (clientId) return clientId;
    if (!submitted) {
      submitted = (await submitCreateForm()) === "submitted";
    }
    if (!askedToFinish && Date.now() - startedAt > CREATE_FORM_GRACE_MS) {
      askedToFinish = true;
      console.error("[oura] The Create New form was not submitted automatically; the user completes it.");
      await hideOverlay("Tick 'I agree to the Oura API Agreement', then tap Create Application.", { now: true });
    }
    return null;
  }, INTERACTION_TIMEOUT_MS, 3000);

  if (!created) {
    throw makeFatalRunError(
      "auth_failed",
      CODES.appNotCreated,
      "No Oura API application was created (the Oura API Agreement must be accepted in the browser).",
      STEPS.portalApp,
    );
  }
  return created;
};

// ── OAuth2 authorization-code flow (PKCE + client secret) ───────────

/**
 * Reads the client secret of the user's own API application from the portal
 * API. It is used only for Oura's token endpoint and never logged.
 */
const readClientSecret = async (clientId) =>
  page.evaluate(`
    (async () => {
      try {
        const resp = await fetch('/api/extapi/v2/oauth/applications', { credentials: 'include' });
        if (!resp.ok) return null;
        const apps = await resp.json();
        const app = Array.isArray(apps) ? apps.find((a) => a.client_id === ${JSON.stringify(clientId)}) : null;
        return (app && app.client_secret) || null;
      } catch (e) { return null; }
    })()
  `);

// PKCE verifier + S256 challenge, generated with the page's WebCrypto.
const createPkcePair = async () =>
  page.evaluate(`
    (async () => {
      const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
      return { verifier, challenge: b64url(digest) };
    })()
  `);

const buildAuthorizeUrl = (clientId, state, codeChallenge, signInMethod) =>
  `${AUTHORIZE_URL}?response_type=code` +
  `&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(APP_REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(OAUTH_SCOPE)}` +
  `&state=${encodeURIComponent(state)}` +
  `&code_challenge=${encodeURIComponent(codeChallenge)}` +
  "&code_challenge_method=S256" +
  // Always show the consent screen so an earlier empty grant is not reused.
  "&prompt=consent" +
  (signInMethod ? `&acr_values=${encodeURIComponent(signInMethod)}` : "");

/**
 * Posts a grant to Oura's token endpoint. Returns a cache entry, or throws a
 * fatal auth error. Token values are never logged; only response keys are.
 */
const requestTokens = async (grant, clientId, clientSecret) => {
  currentStep = STEPS.token;
  const body = new URLSearchParams({ ...grant, client_id: clientId, client_secret: clientSecret });
  // The custom header is load-bearing on mobile. The phone's httpFetch tries a
  // fetch inside the current page first and falls back to native HTTP only if
  // that throws. A form POST is a CORS "simple" request, so from the redirect
  // page the browser SENDS it, Oura spends the one-time code, and the
  // response is hidden (no CORS headers); the native retry then reuses the
  // spent code and gets invalid_grant. A non-simple header forces a
  // preflight, which Oura fails, so the in-page POST never leaves and the
  // native request is the only one. Desktop's Node fetch ignores it.
  const resp = await page.httpFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "X-Vana-Connector": "oura",
    },
    body: body.toString(),
    timeout: 20000,
  });
  const json = resp.json || {};
  if (!resp.ok || !json.access_token) {
    const reason = json.error_description || json.error || resp.error || `HTTP ${resp.status}`;
    throw makeFatalRunError(
      "auth_failed",
      CODES.tokenRequestFailed,
      `Oura token request (${grant.grant_type}) failed: ${String(reason).slice(0, 160)}`,
      STEPS.token,
    );
  }
  console.error(
    `[oura] Token response (${grant.grant_type}): keys=${Object.keys(json).join(",")} ` +
    `scope=${json.scope || "(none)"} expires_in=${json.expires_in}`,
  );
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || grant.refresh_token || null,
    expiresAt: Date.now() + (Number(json.expires_in) || 24 * 3600) * 1000,
    clientId,
    clientSecret,
  };
};

// On Oura's consent screen, makes sure the daily-data box is ticked.
const ensureConsentScopeTicked = async () =>
  page.evaluate(`
    (() => {
      const box = document.querySelector('input[type="checkbox"][name="consent.scope.${OAUTH_SCOPE}"]');
      if (!box) return 'no-consent-form';
      if (!box.checked) box.click();
      return box.checked ? 'ticked' : 'unticked';
    })()
  `);

// Presses "Allow" on Oura's consent screen. The caller only calls this after
// the scope box has read as ticked on two polls in a row: a click that lands
// before the page's script has bound the box makes Oura record an empty
// grant (seen in four test runs on 2026-09-30). Returns true once pressed.
const pressAllow = async () => {
  try {
    return Boolean(await page.evaluate(`
      (() => {
        if (document.readyState !== 'complete') return false;
        const box = document.querySelector('input[type="checkbox"][name="consent.scope.${OAUTH_SCOPE}"]');
        if (!box || !box.checked) return false;
        const allow = document.querySelector(
          'button[name="submit_consent"], input[name="submit_consent"], #submit_consent, button[value="submit_consent"]'
        );
        if (!allow || allow.disabled) return false;
        allow.click();
        return true;
      })()
    `));
  } catch {
    return false;
  }
};

/**
 * Runs the authorization-code flow in the current (headed) browser: the user
 * signs in and approves, the connector exchanges the code. Returns the token
 * cache entry.
 */
const authorizeWithUser = async (clientId, clientSecret, email, { autoAllow = false } = {}) => {
  // First ask for the portal's sign-in method, so Oura can reuse the session
  // and go straight to consent. If Oura refuses that for this application,
  // run the plain request, which asks the person to sign in once more.
  for (const signInMethod of [PORTAL_SIGN_IN_METHOD, null]) {
    const attempt = await runAuthorizeAttempt(clientId, email, signInMethod, autoAllow);
    if (attempt.retry) {
      console.error("[oura] Oura did not accept the portal sign-in method; retrying without it");
      continue;
    }
    return requestTokens(
      {
        grant_type: "authorization_code",
        code: attempt.code,
        redirect_uri: APP_REDIRECT_URI,
        code_verifier: attempt.verifier,
      },
      clientId,
      clientSecret,
    );
  }
  throw makeFatalRunError("auth_failed", CODES.authorizeIncomplete, "Oura authorization did not complete.", STEPS.authorize);
};

// One pass through Oura's authorize page. Returns { code, verifier }, or
// { retry: true } when a request that named a sign-in method got neither a
// consent form nor a sign-in page, or came back with an error other than the
// person declining.
const runAuthorizeAttempt = async (clientId, email, signInMethod, autoAllow) => {
  currentStep = STEPS.authorize;
  const state = `vana-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const pkce = await createPkcePair();
  await showOverlay(workingState(2, "Opening Oura's approval screen…"));
  const opened = await safeGoto(buildAuthorizeUrl(clientId, state, pkce.challenge, signInMethod), {
    attempts: 2,
    label: "Oura authorize",
  });
  if (!opened && !isOnRedirect(await currentUrl())) {
    throw makeFatalRunError("navigation_error", CODES.authorizeUnreachable, "Could not open the Oura authorization page.", STEPS.authorize);
  }

  let lastPage = "";
  let consentState = "";
  let askedToSignInAgain = false;
  let emailSubmitted = false;
  let noFormSince = 0;
  let tickedPolls = 0;
  let allowPressedAt = 0;
  let askedToApprove = false;
  let lastSignInPage = "";
  const askToApprove = async () => {
    askedToApprove = true;
    await hideOverlay("Last step: tap Allow on Oura's screen.", { now: true });
  };
  const reached = await waitFor(async () => {
    const url = await currentUrl();
    if (isOnRedirect(url)) return "redirect";

    const where = describeUrl(url);
    if (where !== lastPage) {
      console.error(`[oura] Authorization waiting on ${where}`);
      lastPage = where;
    }
    if (isOnMoiLogin(url)) {
      noFormSince = 0;
      if (!askedToSignInAgain) {
        askedToSignInAgain = true;
        console.error("[oura] Oura asked for a second sign-in");
      }
      // The email step is submitted at most once per attempt, so an address
      // Oura rejects is left for the person to correct on Oura's page.
      const kind = await driveOuraSignIn(url, {
        second: true,
        email,
        submitEmail: async () => {
          await prefillOuraEmail(email);
          if (!emailSubmitted) emailSubmitted = await submitOuraEmail(email);
        },
      });
      if (kind !== lastSignInPage) {
        console.error(`[oura] Second sign-in page: ${kind}`);
        lastSignInPage = kind;
      }
    } else if (isOnAuthorize(url)) {
      if (!askedToApprove) {
        await showOverlay(workingState(2, "Approving access on Oura…"));
      }
      const state = await ensureConsentScopeTicked().catch(() => "");
      if (state && state !== consentState) {
        consentState = state;
        console.error(`[oura] Consent screen: ${state}`);
        if (state === "ticked") {
          if (!autoAllow) {
            await askToApprove();
          }
        }
      }
      tickedPolls = state === "ticked" ? tickedPolls + 1 : 0;
      if (autoAllow && state === "ticked") {
        if (!allowPressedAt && tickedPolls >= 2 && (await pressAllow())) {
          allowPressedAt = Date.now();
          console.error("[oura] Pressed Allow on the consent screen");
        } else if (!askedToApprove && (
          (allowPressedAt && Date.now() - allowPressedAt > ALLOW_GRACE_MS) ||
          (!allowPressedAt && tickedPolls >= 6)
        )) {
          // Pressed and still here, or the button could not be found.
          console.error("[oura] Automatic approval did not go through; the user approves");
          await askToApprove();
        }
      }
      if (state === "ticked" || state === "unticked") {
        noFormSince = 0;
      } else if (signInMethod) {
        // Neither a consent form nor a sign-in page: Oura's error page for a
        // sign-in method this application may not use.
        if (!noFormSince) noFormSince = Date.now();
        if (Date.now() - noFormSince > SESSION_REUSE_GRACE_MS) return "retry";
      }
    } else {
      noFormSince = 0;
    }
    return null;
  }, INTERACTION_TIMEOUT_MS, 400);

  if (reached === "retry") return { retry: true };
  if (!reached) {
    throw makeFatalRunError(
      "auth_failed",
      CODES.authorizeIncomplete,
      `Oura authorization did not complete (last page: ${lastPage || "unknown"}).`,
      STEPS.authorize,
    );
  }
  if (signInMethod && !askedToSignInAgain) {
    console.error("[oura] Oura reused the portal session; no second sign-in");
  }

  const redirect = await readRedirectParams();
  if (redirect?.error) {
    if (signInMethod && redirect.error !== "access_denied") return { retry: true };
    throw makeFatalRunError("auth_failed", CODES.authorizeDeclined, `Oura authorization was declined (${redirect.error}).`, STEPS.authorize);
  }
  if (!redirect?.code) {
    throw makeFatalRunError("auth_failed", CODES.authorizeNoCode, "Oura authorization finished without an authorization code.", STEPS.authorize);
  }
  if (redirect.state !== state) {
    throw makeFatalRunError("auth_failed", CODES.authorizeBadState, "Oura authorization returned an unexpected state value.", STEPS.authorize);
  }
  return { code: redirect.code, verifier: pkce.verifier };
};

// ── Auth orchestration ──────────────────────────────────────────────

// Validates a cache entry, refreshing it when the access token is stale.
// Returns a usable access token, or null when the user must re-authorize.
const tokenFromCache = async (cached) => {
  if (!cached?.accessToken) return null;

  if (Number(cached.expiresAt) > Date.now() + 10 * 60 * 1000) {
    const { status } = await probeToken(cached.accessToken);
    if (status === 200) return cached.accessToken;
    if (status !== 401 && status !== 403) {
      // Oura unreachable or rate limited: let collection report it honestly.
      return cached.accessToken;
    }
  }

  if (cached.refreshToken && cached.clientId && cached.clientSecret) {
    try {
      const refreshed = await requestTokens(
        { grant_type: "refresh_token", refresh_token: cached.refreshToken },
        cached.clientId,
        cached.clientSecret,
      );
      // Refresh tokens are single-use: persist the rotated one immediately.
      await writeCachedToken(refreshed);
      const { status } = await probeToken(refreshed.accessToken);
      if (status !== 401 && status !== 403) return refreshed.accessToken;
    } catch (error) {
      console.error(`[oura] Token refresh failed: ${error?.message || error}`);
    }
  }

  await writeCachedToken(null);
  return null;
};

/**
 * Returns a working API access token.
 *
 * Headless first: a cached access token, or one refreshed with the cached
 * refresh token. Otherwise one headed session covers portal sign-in, app
 * setup and OAuth consent, then the browser returns to headless mode.
 */
const obtainAccessToken = async () => {
  currentStep = STEPS.portalSignin;
  // The native cover can draw before any Oura page has loaded.
  if (NATIVE_COVER) await showOverlay(waitingState("Checking your Oura connection…"));
  // Hidden from the first moment: the cover carries the words.
  await setStatus(" ");
  // The host opens the connector's loginUrl (the portal) before the script
  // starts, so a cached token is usually readable without loading it again.
  if (!(await onPortalDocument())) {
    if (!(await safeGoto(APPS_URL, { label: "developer portal" }))) {
      throw makeFatalRunError(
        "navigation_error",
        CODES.portalUnreachable,
        "Could not reach the Oura Developer Portal after multiple attempts.",
        STEPS.portalSignin,
      );
    }
  }
  await showOverlay(waitingState("Checking your Oura connection…"));
  await waitFor(onPortalDocument, PORTAL_READY_TIMEOUT_MS, PORTAL_READY_POLL_MS);

  const cachedToken = await tokenFromCache(await readCachedToken());
  if (cachedToken) return cachedToken;

  const { headed } = await page.showBrowser(APPS_URL);
  if (!headed) {
    throw makeFatalRunError(
      "auth_failed",
      CODES.signinHeadless,
      "Connecting Oura needs a one-time sign-in in a visible browser window.",
      STEPS.portalSignin,
    );
  }

  // Drives the Developer Portal sign-in in the headed browser and returns the
  // signed-in email, or null. With `stale`, the portal session exists but its
  // API rejects it, so the session is ended first and the sign-in starts fresh.
  const signInToPortal = async ({ stale = false } = {}) => {
    if (stale) {
      try {
        await page.evaluate(`fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' }).catch(() => {})`);
      } catch {}
      await safeGoto(`${DEV_PORTAL}/signin?callbackUrl=%2Fapplications`, { label: "portal sign-in" });
    }
    // A single space keeps the shell's status card hidden: the overlay
    // carries the instructions while it is up.
    await page.promptUser(
      " ",
      async () => {
        const url = await currentUrl();
        if (isOnPortal(url) && url.includes("/signin")) {
          await showOverlay(waitingState("Opening Oura sign-in…"), "Tap Sign In to continue with Oura.");
          // Starts Oura SSO from the NextAuth sign-in page.
          await page.evaluate(`
            (() => {
              const btn = [...document.querySelectorAll('button')].find((b) => /sign in/i.test(b.innerText || ''));
              if (btn && !window.__vanaSignInClicked) { window.__vanaSignInClicked = true; btn.click(); }
            })()
          `);
          return false;
        }
        if (isOnMoiLogin(url)) {
          await driveOuraSignIn(url, { second: false, email: null });
          return false;
        }
        if (!isOnPortal(url)) {
          await hideOverlay("Finish signing in to Oura on this screen.");
          return false;
        }
        if (await checkLoginStatus()) return true;
        await showOverlay(waitingState("Signing you in…"), "Signing in to Oura…");
        return false;
      },
      400,
    );
    // promptUser and the shell both wrote the status line; resync it.
    lastStatus = null;
    return checkLoginStatus();
  };

  let email = await checkLoginStatus();
  if (!email) email = await signInToPortal();
  if (!email) {
    throw makeFatalRunError("auth_failed", CODES.signinUnconfirmed, "Oura sign-in could not be confirmed on the Developer Portal.", STEPS.portalSignin);
  }

  await showOverlay(workingState(1, "Looking for your Oura app…"));
  let app = await findApiApplication();
  if (app.unauthorized) {
    console.error("[oura] The Developer Portal session is stale (applications API answered 401); asking the user to sign in again");
    email = await signInToPortal({ stale: true });
    if (!email) {
      throw makeFatalRunError("auth_failed", CODES.signinUnconfirmed, "Oura sign-in could not be confirmed on the Developer Portal.", STEPS.portalSignin);
    }
    await showOverlay(workingState(1, "Looking for your Oura app…"));
    app = await findApiApplication();
    if (app.unauthorized) {
      throw makeFatalRunError("auth_failed", CODES.signinUnconfirmed, "The Oura Developer Portal rejected the session right after sign-in.", STEPS.portalSignin);
    }
  }
  let { clientId } = app;
  if (!clientId) {
    clientId = await createApiApplicationWithUser(email);
  }
  const clientSecret = await readClientSecret(clientId);
  if (!clientSecret) {
    throw makeFatalRunError(
      "upstream_error",
      CODES.appSecretUnreadable,
      "Could not read the Oura API application credentials from the Developer Portal.",
      STEPS.portalApp,
    );
  }

  let entry = await authorizeWithUser(clientId, clientSecret, email, { autoAllow: true });
  let { status } = await probeToken(entry.accessToken);
  if (status === 401 || status === 403) {
    // Oura recorded the automatic approval without the daily scope. Run the
    // consent once more and let the person press Allow.
    console.error(`[oura] Automatic approval gave a token without daily access (HTTP ${status}); asking the user to approve`);
    entry = await authorizeWithUser(clientId, clientSecret, email, { autoAllow: false });
    ({ status } = await probeToken(entry.accessToken));
  }
  if (status === 401 || status === 403) {
    throw makeFatalRunError(
      "auth_failed",
      CODES.tokenScopeMissing,
      `Oura issued a token that cannot read daily summaries (API returned HTTP ${status}).`,
      STEPS.token,
    );
  }

  // Leave the redirect page and cache the tokens on the portal origin before
  // switching back to headless.
  await safeGoto(APPS_URL, { attempts: 2, label: "developer portal" });
  await showOverlay(workingState(3, "Starting the download…"));
  await waitFor(onPortalDocument, PORTAL_READY_TIMEOUT_MS, PORTAL_READY_POLL_MS);
  await writeCachedToken(entry);
  await page.goHeadless({ resumeUrl: APPS_URL });

  return entry.accessToken;
};

// ── API V2 collection ───────────────────────────────────────────────

const isoDate = (date) => date.toISOString().split("T")[0];

/**
 * Fetches every document of one usercollection endpoint in the window,
 * following next_token. Returns { ok, data, pages, error, status }.
 */
const fetchCollection = async (accessToken, endpoint, startDate, endDate) => {
  const data = [];
  let nextToken = null;
  let pages = 0;

  do {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (nextToken) params.set("next_token", nextToken);
    const url = `${API_BASE}/${endpoint}?${params.toString()}`;

    let resp = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      resp = await page.httpFetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        timeout: 30000,
      });
      if (resp.status === 429) {
        const retryAfter = Number(resp.headers?.["retry-after"]) || 5 * attempt;
        await page.setData("status", `Oura rate limit reached; waiting ${retryAfter}s...`);
        await page.sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      if (resp.status === 0 || resp.status >= 500) {
        await page.sleep(1500 * attempt);
        continue;
      }
      break;
    }

    if (!resp?.ok || !resp.json) {
      return {
        ok: false,
        data,
        pages,
        status: resp?.status || 0,
        error: resp?.error || `HTTP ${resp?.status || "unknown"}`,
      };
    }

    data.push(...(Array.isArray(resp.json.data) ? resp.json.data : []));
    nextToken = resp.json.next_token || null;
    pages++;
    if (nextToken) await page.sleep(300);
  } while (nextToken && pages < 50);

  return { ok: true, data, pages, status: 200, error: null };
};

// ── Scope extraction helpers ────────────────────────────────────────

const mapReadiness = (rawReadiness) =>
  rawReadiness.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    temperatureDeviation: d.temperature_deviation,
    temperatureTrendDeviation: d.temperature_trend_deviation,
    contributors: d.contributors || {},
  }));

const mapSleep = (dailySleep, sleepPeriods) => ({
  dailyScores: dailySleep.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    contributors: d.contributors || {},
  })),
  sleepPeriods: sleepPeriods.map((d) => ({
    id: d.id,
    day: d.day,
    type: d.type,
    bedtimeStart: d.bedtime_start,
    bedtimeEnd: d.bedtime_end,
    totalSleepDuration: d.total_sleep_duration,
    timeInBed: d.time_in_bed,
    deepSleepDuration: d.deep_sleep_duration,
    lightSleepDuration: d.light_sleep_duration,
    remSleepDuration: d.rem_sleep_duration,
    awakeTime: d.awake_time,
    efficiency: d.efficiency,
    latency: d.latency,
    averageHeartRate: d.average_heart_rate,
    averageHrv: d.average_hrv,
    lowestHeartRate: d.lowest_heart_rate,
    averageBreath: d.average_breath,
    restlessPeriods: d.restless_periods,
  })),
});

const mapActivity = (rawActivity) =>
  rawActivity.map((d) => ({
    id: d.id,
    day: d.day,
    score: d.score,
    timestamp: d.timestamp,
    activeCalories: d.active_calories,
    totalCalories: d.total_calories,
    steps: d.steps,
    equivalentWalkingDistance: d.equivalent_walking_distance,
    highActivityTime: d.high_activity_time,
    mediumActivityTime: d.medium_activity_time,
    lowActivityTime: d.low_activity_time,
    sedentaryTime: d.sedentary_time,
    restingTime: d.resting_time,
    inactivityAlerts: d.inactivity_alerts,
    contributors: d.contributors || {},
  }));

// ── Main Flow ───────────────────────────────────────────────────────

(async () => {
  let requestedScopes = [...CANONICAL_SCOPES];
  let initError = null;
  try {
    requestedScopes = resolveRequestedScopes();
  } catch (error) {
    initError = error;
  }

  try {
    if (initError) {
      throw initError;
    }

    const errors = [];
    const scopes = {};

    // ── Auth ──
    // Status only: on mobile the first setProgress marks the run as
    // extracting, which must not happen before the owner has signed in.
    const accessToken = await obtainAccessToken();

    // ── Data Collection ──
    const end = new Date();
    end.setDate(end.getDate() + 1); // end_date is exclusive for daily collections
    const start = new Date();
    start.setDate(start.getDate() - LOOKBACK_DAYS);
    const startDate = isoDate(start);
    const endDate = isoDate(end);

    const endpoints = Array.from(
      new Set(requestedScopes.flatMap((scope) => SCOPE_ENDPOINTS[scope])),
    );
    const collections = {};
    for (const endpoint of endpoints) {
      currentStep = ENDPOINT_STEPS[endpoint];
      await page.setProgress({
        phase: "collect",
        step: ENDPOINT_STEPS[endpoint],
        message: `Downloading Oura ${endpoint.replace(/_/g, " ")}...`,
      });
      lastStatus = null; // setProgress wrote the status line too
      await showOverlay(workingState(3, `Downloading ${ENDPOINT_LABELS[endpoint] || endpoint}…`));
      collections[endpoint] = await fetchCollection(accessToken, endpoint, startDate, endDate);
      if (collections[endpoint].status === 401) {
        await writeCachedToken(null);
        throw makeFatalRunError(
          "auth_failed",
          CODES.tokenRejected,
          "Oura rejected the API access token. Reconnect to authorize again.",
          ENDPOINT_STEPS[endpoint],
        );
      }
    }

    // Per scope: did its requests work, and how many rows came back. The
    // host counts these so `no_data` can say "empty account" or "broken".
    const scopeCounts = {};
    for (const scope of requestedScopes) {
      const own = SCOPE_ENDPOINTS[scope];
      scopeCounts[scope] = {
        found: own.reduce((n, endpoint) => n + (collections[endpoint].data?.length || 0), 0),
        ok: own.every((endpoint) => collections[endpoint].ok),
      };
    }
    await page.setData("scopeCounts", scopeCounts);

    const allFailed = endpoints.every((endpoint) => !collections[endpoint].ok);
    if (allFailed) {
      const statuses = endpoints.map((e) => collections[e].status).join(", ");
      const denied = collections[endpoints[0]].status === 403;
      throw makeFatalRunError(
        denied ? "auth_failed" : "upstream_error",
        denied ? CODES.dailyAccessDenied : CODES.apiAllFailed,
        denied
          ? "Oura denied access to daily data (HTTP 403). The Oura membership may have expired or the daily scope was not granted."
          : `All Oura API requests failed (HTTP ${statuses}).`,
        ENDPOINT_STEPS[endpoints[0]],
      );
    }

    // ── Per-scope collection ──
    for (const scope of requestedScopes) {
      const scopeEndpoints = SCOPE_ENDPOINTS[scope];
      const failed = scopeEndpoints.filter((endpoint) => !collections[endpoint].ok);
      const rows = (endpoint) => collections[endpoint].data;

      if (failed.length === scopeEndpoints.length) {
        errors.push(makeConnectorError(
          "upstream_error",
          CODES.apiScopeFailed,
          `Oura API request failed for ${failed.join(", ")} (${failed.map((e) => collections[e].error).join("; ")}).`,
          "omitted",
          { scope, step: ENDPOINT_STEPS[failed[0]] },
        ));
        continue;
      }

      if (scope === "oura.readiness") {
        scopes[scope] = { days: mapReadiness(rows("daily_readiness")) };
      } else if (scope === "oura.sleep") {
        scopes[scope] = mapSleep(rows("daily_sleep"), rows("sleep"));
      } else if (scope === "oura.activity") {
        scopes[scope] = { days: mapActivity(rows("daily_activity")) };
      }

      if (failed.length > 0) {
        errors.push(makeConnectorError(
          "upstream_error",
          CODES.apiScopeDegraded,
          `Oura API request failed for ${failed.join(", ")}; ${scope} data is incomplete.`,
          "degraded",
          { scope, step: ENDPOINT_STEPS[failed[0]] },
        ));
      }
    }

    // ── Build result ──
    currentStep = STEPS.buildResult;
    // Step only: no message, so the status line the person sees is unchanged.
    await page.setProgress({ phase: "collect", step: STEPS.buildResult });
    const totalItems =
      (scopes["oura.readiness"]?.days?.length || 0) +
      (scopes["oura.sleep"]?.sleepPeriods?.length || 0) +
      (scopes["oura.activity"]?.days?.length || 0);

    const result = buildResult({
      requestedScopes,
      scopes,
      errors,
      exportSummary: {
        count: totalItems,
        label: "days of Oura data",
        details: {
          readiness: scopes["oura.readiness"]?.days?.length || 0,
          sleepScores: scopes["oura.sleep"]?.dailyScores?.length || 0,
          sleepPeriods: scopes["oura.sleep"]?.sleepPeriods?.length || 0,
          activity: scopes["oura.activity"]?.days?.length || 0,
        },
      },
    });

    await showOverlay({
      screen: "done",
      title: "Oura connected",
      body: `${totalItems} records ready. Saving them to your Vana account…`,
    });
    await page.setData("result", result);
    await page.setData(
      "status",
      `Complete! ${scopes["oura.readiness"]?.days?.length || 0} readiness, ` +
      `${scopes["oura.sleep"]?.sleepPeriods?.length || 0} sleep periods, ` +
      `${scopes["oura.activity"]?.days?.length || 0} activity days collected.`,
    );

    return result;
  } catch (error) {
    // An error without our envelope is a defect in this file: it is still
    // classified from its text, coded `unexpected` and placed at the step
    // the run was in, so it is counted and can be found, but it stays a bug
    // to fix here.
    const telemetryError =
      error?.telemetryError ||
      makeConnectorError(
        inferErrorClass(error?.message || String(error)),
        CODES.unexpected,
        error?.message || String(error),
        "fatal",
        { step: currentStep },
      );
    const result = buildEmptyResult(requestedScopes, [telemetryError]);
    await hideOverlay(" ", { now: true });
    await page.setData("result", result);
    await page.setData("errorDetail", {
      errorClass: telemetryError.errorClass,
      code: telemetryError.code,
      step: telemetryError.step,
    });
    await page.setData("error", telemetryError.reason);
    return result;
  }
})();
