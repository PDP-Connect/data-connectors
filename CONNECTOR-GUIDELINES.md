# Browser connector guidelines

These rules apply to browser connectors, which read data through a signed-in page session and run on both the desktop and mobile hosts. API and file-import connectors skip this page.

A browser connector talks to a `page` object (the methods are listed in `scripts/pageshim/harness.mjs`), not to a specific browser. The desktop host implements `page` with Playwright and Chromium. The mobile host (PageShim) implements it with a native WebView. A connector that uses only the `page` contract runs on both; a connector that assumes Chromium on a laptop runs on desktop only.

---

## The rules

### 1. Detect state from APIs, not from page chrome

A layout check is the most common portability break.

```js
// BAD - assumes the desktop layout
const loggedIn = await page.evaluate(`
  !!document.querySelector('nav[aria-label="Chat history"]') ||
  !!document.querySelector('[data-testid="profile-button"]')
`)
```

The sidebar, the profile button and the "Log in" text belong to the desktop layout. On a phone viewport the site collapses them into a drawer, so the check always returns `false` and the connector waits for a login that already happened.

```js
// GOOD - layout independent
const loggedIn = await page.evaluate(`
  (async () => {
    const r = await fetch('/api/auth/session', { credentials: 'include' })
    if (!r.ok) return false
    const j = await r.json()
    return !!(j && j.accessToken)
  })()
`)
```

Prefer, in order: a session/auth endpoint, an authenticated API call that 401s when
logged out, a durable token in storage. Use DOM selectors only when nothing else
exists, and then pick structural, layout-neutral ones.

An API check also survives site redesigns on desktop.

### 2. Make the run resumable

The mobile host can lose the runtime mid-run: the OS ends the WebView under memory pressure or when the user backgrounds the app. The page context is gone and only the progress you stored survives.

Checkpoint progress durably (IndexedDB on the source origin) and resume from the
cursor on the next run:

1. key checkpoints by a stable cursor (offset, page token, last id), not by array position
2. make writes idempotent because a resumed run sees some items again
3. record what is already fetched so a resume does not re-download it

A resumable connector continues where it stopped; a connector that is not resumable restarts from zero each time the user switches apps.

### 3. Fetch from inside the page, do not intercept the network

`page.evaluate` with `fetch` runs in the page, carries the page's cookies and TLS fingerprint, and works on every host.

Reading response bodies from the site's own traffic (`page.captureNetwork` and `page.getCapturedResponse`) works on desktop only: the mobile host does not provide the `page_response_observation` feature (`scripts/pageshim/capabilities.mjs`). Use capture as a fallback, never as the primary data path, or declare the connector desktop-only (rule 6).

### 4. Keep `page.evaluate` payloads self-contained

Pass a complete expression, as an immediately invoked function, and let the runner evaluate it:

```js
await page.evaluate(`(async () => { /* ... */ return result })()`)
```

Do not call `eval()` or `new Function()` inside the page. Sites with a strict Content Security Policy (`script-src` without `'unsafe-eval'`) reject both, and the runner cannot work around it. Desktop evaluates over the debugger protocol, which the policy does not gate, so a test on desktop passes; mobile has no such path.

### 5. Never require credentials from the driver

`page.requestInput` is optional and absent on mobile by design, so the app never handles a user's password for a third-party service. Probe for it and keep a browser-login fallback:

```js
if (typeof page.requestInput === 'function' && hasLoginForm) {
  // optional fast path
}
// always support this
const { headed } = await page.showBrowser('https://example.com/login')
if (headed) {
  await page.promptUser('Log in, then continue.', checkLoginStatus, 2000)
}
```

Treat the URL you pass to `showBrowser` as a hint. On mobile the browser is already visible and can already show the login page, and the runner ignores the URL rather than navigate away from a form the user is filling in.

### 6. Declare what you need; degrade to desktop handoff

If a connector genuinely needs a capability the mobile runtime does not have -
cross-origin iframe access (`page.frame_*`), network response bodies, reading the cookie jar - declare it under `runtime_requirements.bindings` in the manifest (see [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md)) and check at runtime:

```js
if (typeof page.captureNetwork !== 'function') {
  await page.setData('error', 'This source needs the desktop app.')
  return { error: 'requires desktop runtime' }
}
```

A clean failure with a reason routes the user to the desktop host. A silent failure looks like a broken app.

### 7. Report progress, and bound the work

Run time grows with the account's data, from under a minute to an hour. The UI shows honest progress only if the connector reports it.

1. call `page.setProgress` with `count` and, when known, the total
2. emit progress at every page of pagination, not once at the end
3. keep going through partial failures and record them in `errors[]` rather than
  aborting the whole export

### 8. Do not assume desktop layout or viewport

Beyond login checks: no fixed pixel positions, no "the sidebar is open", no hover-only
interactions. Prefer data over DOM wherever the site exposes it.

---

## Capability matrix

| Capability | Desktop (Playwright) | Mobile (WebView shim) |
|---|---|---|
| `page.evaluate`, `goto`, `sleep`, `setData`, `setProgress` | yes | yes |
| in-page `fetch` of private APIs | yes | yes |
| localStorage and IndexedDB, read in the page | yes | yes |
| cookie jar read (feature `cookie_read`) | yes | no |
| `showBrowser` / `promptUser` | yes | yes (always headed) |
| `httpFetch` (host HTTP request, feature `host_http_request`) | yes | yes |
| `requestInput` | yes | no (deliberate) |
| `captureNetwork` response bodies | yes | no (feature `page_response_observation`) |
| `captureDownload`, `extractZipEntries` | yes | yes |
| cross-origin `page.frame_*` | yes | no |
| true headless | yes | n/a (hidden instead) |

Mobile does not support a host request that reuses the page's cookie jar (feature `host_cookie_jar_request`), because `scripts/pageshim/capabilities.mjs` does not list it. Send authenticated requests from inside the page with `fetch` (rule 3).

---

## Checklist before you open a PR

1. Login/state detection uses an API or session signal, not layout selectors
2. The run resumes from a checkpoint instead of restarting
3. The primary data path is in-page `fetch`, not network capture
4. `page.evaluate` payloads are self-contained expressions, no in-page `eval`
5. `requestInput` is optional, with a browser-login fallback
6. Desktop-only capabilities are declared and checked, with a clean failure
7. Progress is reported with counts; partial failures land in `errors[]`
8. Verified on a phone-sized viewport, not only on a laptop
