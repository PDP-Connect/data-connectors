# Browser connector guidelines

These rules apply to browser connectors, which read data through a signed-in page session and run on both the desktop and mobile hosts. API and file-import connectors skip this page.

A browser connector talks to a `page` object (the methods are listed in `scripts/pageshim/harness.mjs`), not to a specific browser. The desktop host implements `page` with Playwright and Chromium. The mobile host (PageShim) implements it with a native WebView. A connector that uses only the `page` contract runs on both; a connector that assumes Chromium on a laptop runs on desktop only.

---

## The rules

### 1. Detect state from APIs, not from page layout

A check on the page layout breaks when the site shows a different layout on a phone.

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

Detect the login state with the first of these that the site offers.

1. A session or auth endpoint.
2. An authenticated API call that returns 401 when the user is logged out.
3. A durable token in storage.

Use DOM selectors only when none of these exists, and then pick structural selectors that do not depend on the layout.

An API check also survives site redesigns on desktop.

### 2. Make the run resumable

The mobile host can lose the runtime in the middle of a run. The OS ends the WebView under memory pressure or when the user backgrounds the app. The page context is gone and only the progress you stored survives.

Checkpoint progress durably in IndexedDB on the source origin, and resume from the cursor on the next run.

1. Key each checkpoint by a stable cursor (offset, page token or last ID), not by array position.
2. Make writes idempotent, because a resumed run sees some items again.
3. Record what is already fetched, so a resume does not download it again.

### 3. Fetch from inside the page, do not intercept the network

`page.evaluate` with `fetch` runs in the page, carries the page's cookies and TLS fingerprint, and works on every host.

Reading response bodies from the site's own traffic (`page.captureNetwork` and `page.getCapturedResponse`) works on desktop only. The mobile app does not provide it yet; support is planned (see [what runs on desktop and on mobile](#what-runs-on-desktop-and-on-mobile)). Use capture only as a fallback, never as the primary data path, or declare the connector desktop-only (rule 6).

### 4. Keep `page.evaluate` payloads self-contained

Pass a complete expression as an immediately invoked function, and let the runner evaluate it.

```js
await page.evaluate(`(async () => { /* ... */ return result })()`)
```

Do not call `eval()` or `new Function()` inside the page. Sites with a strict Content Security Policy (`script-src` without `'unsafe-eval'`) reject both, and the runner cannot work around it. Desktop evaluates over the debugger protocol, which the policy does not gate, so a test on desktop passes; mobile has no such path.

### 5. Never require credentials from the driver

`page.requestInput` is optional and absent on mobile by design, so the app never handles a user's password for a third-party service. Probe for it and keep a browser-login fallback.

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

### 6. Declare desktop-only features and fail cleanly

If a connector needs a capability that the mobile app does not have, such as cross-origin iframe access (`page.frame_*`), network response bodies or the cookie jar, declare it under `runtime_requirements.bindings` in the manifest. [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md#declare-runtime-binding-features) lists the feature names and shows a manifest example. Then check at runtime.

```js
if (typeof page.captureNetwork !== 'function') {
  await page.setData('error', 'This source needs the desktop app.')
  return { error: 'requires desktop runtime' }
}
```

A clean failure with a reason routes the user to the desktop host. A silent failure looks like a broken app.

### 7. Report progress, and bound the work

Run time grows with the size of the account. The UI shows true progress only if the connector reports it.

1. Call `page.setProgress` with `count` and, when known, the total.
2. Report progress on each page of results, not once at the end.
3. Continue after a partial failure and record it in `errors[]`. Do not stop the whole export.

### 8. Do not assume desktop layout or viewport

Do not rely on fixed pixel positions, on a sidebar being open, or on hover-only interactions. Read data from the site's API instead of the DOM wherever the site exposes it.

---

## What runs on desktop and on mobile

Most of the `page` contract works on both hosts. The table lists the parts the mobile app does not provide, and what to do instead. `scripts/pageshim/capabilities.mjs` is the current mobile support list.

| Capability | Desktop | Mobile app | On mobile, do this instead |
|---|---|---|---|
| Read the cookie jar (manifest feature `cookie_read`) | yes | no | Send requests with `fetch` from inside the page. They carry the page's cookies (rule 3). |
| Read response bodies of the site's own traffic with `captureNetwork` (`page_response_observation`) | yes | no, support is planned | Call the same API with `fetch` from inside the page (rule 3). |
| Host HTTP request that sends the page's cookies (`host_cookie_jar_request`) | yes | no | Use `fetch` inside the page for signed-in requests. `httpFetch` still works for requests that need no sign-in. |
| Click and type in the page (`page_input`) | yes | no | Read data through the site's API, not through the page's controls. |
| Cross-origin iframes with `page.frame_*` | yes | no | Declare the connector desktop-only and fail with a clear message (rule 6). |
| `requestInput` (ask the user for a password) | yes | no, by design (the app never handles a password for another service) | Use `showBrowser` and `promptUser` so the user signs in on the site itself (rule 5). |
| Headless run | yes | the page runs hidden | Nothing. The connector code is the same. |

All other `page` methods, such as `evaluate`, `goto`, `setData`, `setProgress`, `showBrowser`, `promptUser`, `httpFetch`, `captureDownload` and `extractZipEntries`, work on both hosts. [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md#declare-runtime-binding-features) lists every manifest feature name.

---

## Before you open a PR

Check your connector against rules 1 to 7, and run it on a phone-sized viewport, not only on a laptop.
