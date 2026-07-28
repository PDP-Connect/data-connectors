# Connector authoring guidelines

How to write a connector that runs **unchanged on desktop and mobile**.

Connectors are written against the [`page` API](README.md#page-api-reference), not
against a specific browser. Desktop implements `page` with Playwright + Chromium;
mobile implements it with a native WebView shim. A connector that only assumes the
`page` contract runs on both. A connector that assumes *Chromium on a laptop*
does not.

These rules come from running real connectors on both runtimes. Each one is a
failure we actually hit, not a hypothetical.

---

## The rules

### 1. Detect state from APIs, not from page chrome

The single most common portability break.

```js
// BAD - assumes the desktop layout
const loggedIn = await page.evaluate(`
  !!document.querySelector('nav[aria-label="Chat history"]') ||
  !!document.querySelector('[data-testid="profile-button"]')
`)
```

The sidebar, the profile button and the "Log in" text are **desktop layout**. On a
phone viewport the app collapses them into a drawer, so the check returns `false`
forever and the connector waits for a login that already happened.

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

This is more robust on desktop too - it survives redesigns.

### 2. Make the run resumable

Mobile can lose the runtime mid-run: the OS kills the WebView under memory
pressure, or the user backgrounds the app. There is no "pause the JS and continue"
- the context is gone. The only thing that survives is what you wrote down.

Checkpoint progress durably (IndexedDB on the source origin) and resume from the
cursor on the next run:

- key checkpoints by a stable cursor (offset, page token, last id), not by array position
- make writes idempotent - a resumed run will re-see some items
- record what is already fetched so a resume does not re-download it

A resumable connector turns "the import broke" into "the import continues where it
left off". A non-resumable one restarts from zero every time the user switches apps.

### 3. Fetch from inside the page, do not intercept the network

`page.evaluate` + `fetch` runs in the page, carries its cookies and its TLS
fingerprint, and works on every runtime.

Reading **response bodies** off the app's own traffic (`page.captureNetwork` +
`page.getCapturedResponse`) is desktop-only in practice: iOS WKWebView has no API
for it and Android can only intercept partially. Use capture as a **fallback**, never
as the primary data path, or declare the connector desktop-only (rule 6).

### 4. Keep `page.evaluate` payloads self-contained

Pass a complete expression - usually an IIFE - and let the runner evaluate it:

```js
await page.evaluate(`(async () => { /* ... */ return result })()`)
```

Do not depend on `eval()` or `new Function()` **inside the page**. Sites with a
strict CSP (`script-src` without `'unsafe-eval'`) reject those, and the runner
cannot work around it for you. Desktop hides this because it evaluates over the
debugger protocol, which CSP does not gate; mobile does not have that escape hatch.

### 5. Never require credentials from the driver

`page.requestInput` is **optional** and absent on mobile by design - we do not want
the app handling a user's password for a third-party service. Always probe for it
and keep a browser-login fallback:

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

Also: treat the URL you pass to `showBrowser` as a **hint**. On mobile the browser
is already visible and may already be on the login page; the runner may ignore the
URL rather than navigate away from a form the user is filling in.

### 6. Declare what you need; degrade to desktop handoff

If a connector genuinely needs a capability the mobile runtime does not have -
binary downloads and archive extraction (`page.captureDownload`,
`page.extractZipEntries`), cross-origin iframe access (`page.frame_*`), network
response bodies - say so in the manifest and check at runtime:

```js
if (typeof page.extractZipEntries !== 'function') {
  await page.setData('error', 'This source needs the desktop app.')
  return { error: 'requires desktop runtime' }
}
```

Failing cleanly with a reason routes the user to desktop handoff. Failing silently
looks like a broken app.

### 7. Report progress, and bound the work

Runtime scales with the user's data: a small account can finish in under a minute
while a large one runs for an hour. The UI can only show that honestly if you tell
it.

- call `page.setProgress` with `count` and, when known, the total
- emit progress at every page of pagination, not once at the end
- keep going through partial failures and record them in `errors[]` rather than
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
| cookies incl. HttpOnly, localStorage, IndexedDB | yes | yes |
| `showBrowser` / `promptUser` | yes | yes (always headed) |
| `httpFetch` (native HTTP with session cookies) | yes | yes |
| `requestInput` | yes | **no** (deliberate) |
| `captureNetwork` response bodies | yes | **iOS no, Android partial** |
| `captureDownload`, `extractZipEntries` | yes | **not yet** |
| cross-origin `page.frame_*` | yes | **no** |
| true headless | yes | n/a (hidden instead) |

Plan against iOS: it is the narrower of the two mobile runtimes.

---

## Checklist before you open a PR

- [ ] Login/state detection uses an API or session signal, not layout selectors
- [ ] The run resumes from a checkpoint instead of restarting
- [ ] The primary data path is in-page `fetch`, not network capture
- [ ] `page.evaluate` payloads are self-contained expressions, no in-page `eval`
- [ ] `requestInput` is optional, with a browser-login fallback
- [ ] Desktop-only capabilities are declared and checked, with a clean failure
- [ ] Progress is reported with counts; partial failures land in `errors[]`
- [ ] Verified on a phone-sized viewport, not only on a laptop
