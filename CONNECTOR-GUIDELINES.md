# Browser connector guidelines

These rules apply to browser connectors, which read data through a signed-in page and can run in the desktop app and in the mobile app. API and file-import connectors skip this page.

A browser connector's `collect()` receives a `BrowserCollectContext`, and reads the site through `ctx.page`. In the desktop app `ctx.page` is a Playwright page in Chromium. In the mobile app (PageShim, a native WebView) it is a small subset of that page: `goto`, `content`, `evaluate`, `waitForFunction` and `context().request.get`. Every other member is missing on mobile, and the PageShim harness fails a run that calls one. A connector that stays inside this subset, and follows the rules below, can be added to the mobile build.

---

## The rules

### 1. Read data and state from the site's API, not from the page layout

A check on the page layout breaks when the site shows a different layout on a phone, and when the site is redesigned.

```js
// BAD - assumes the desktop layout
const loggedIn = await page.evaluate(`
  !!document.querySelector('nav[aria-label="Chat history"]') ||
  !!document.querySelector('[data-testid="profile-button"]')
`)
```

The sidebar and the profile button belong to the desktop layout. On a phone the site collapses them into a drawer, so the check always returns `false` and the connector waits for a sign-in that already happened.

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

Detect the sign-in state with the first of these that the site offers.

1. A session or auth endpoint.
2. An authenticated API call that returns 401 when the user is signed out.
3. A durable token in storage.

Use DOM selectors only when none of these exists, and then pick structural selectors that do not depend on fixed positions, an open sidebar or hover. The same order applies to the data itself.

### 2. Make the run resumable

The mobile app can lose the page in the middle of a run, when the OS ends the WebView under memory pressure or the user leaves the app. The mobile runtime commits a run's `STATE` only after `collect()` ends and the host accepts the stream, so an interrupted run starts again from the `STATE` of the last finished run.

1. Emit `STATE` only after every record it covers has been emitted, and key it by a stable cursor (offset, page token or last ID), not by array position.
2. Use a `primary_key` that stays the same across runs, because a resumed run emits some records again and the store replaces them by key.
3. Do not keep a separate list of what was fetched, for example in the page's IndexedDB, to skip items on the next run. The runtime may not have committed the records that list names, so skipping them can lose data.

### 3. Fetch from inside the page, do not observe the network

`page.evaluate` with `fetch` runs in the page, carries the page's cookies, and works in both apps.

Reading the bodies of the site's own responses (`page.waitForResponse` or `page.on("response")`, manifest feature `page_response_observation`) works in the desktop app only. The mobile app does not provide it yet; support is planned. Use it only as a fallback, or leave the connector out of the mobile build (rule 6).

### 4. Pass `page.evaluate` a complete script as a string

Pass a complete expression in a string, such as an immediately invoked async function.

```js
await page.evaluate(`(async () => { /* ... */ return result })()`)
```

A function passed to `page.evaluate` is sent as its `toString()`. The desktop loader and the PageShim bundler each rewrite function bodies, so a function that works in one app can call a helper the page does not have in the other. A string reaches the page as written.

Do not call `eval()` or `new Function()` inside the page. Sites with a strict Content Security Policy (`script-src` without `'unsafe-eval'`) reject both. A test in the desktop app does not show the problem, because the desktop app evaluates over the debugger protocol, which the policy does not gate.

### 5. Let the user sign in on the site

When the session probe finds no sign-in, hand the sign-in to the user with `manualBrowserLogin` from `packages/polyfill-connectors/src/browser-handoff.ts`, as the browser scaffold does. The user signs in on the site itself, and the connector never sees a password.

Some desktop connectors sign in for the user with a stored password, through a module in `packages/polyfill-connectors/src/auto-login/`. That types into the page (`page_input`), which the mobile app does not provide, so keep it an optional first attempt and keep `manualBrowserLogin` as the fallback.

### 6. Declare what the connector needs

List each binding and feature the connector uses under `runtime_requirements.bindings` in the manifest. [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md#declare-runtime-binding-features) lists the feature names.

The mobile build takes every connector whose declared bindings pass the admission rules in that guide. A connector that uses a feature the mobile app lacks, such as `page_input` for clicks and typing, declares it and so stays desktop-only. No feature name covers cross-origin iframes yet, so ask a maintainer how to keep such a connector out of the mobile build.

### 7. Report progress, and bound the work

Run time grows with the size of the account. The app shows true progress only if the connector reports it.

1. Call `ctx.progress(message, { stream, count, total })`, with `total` only when the site tells you.
2. Report progress on each page of results, not once at the end.
3. Continue after a failure on one item and report it, as a detail gap or with `ctx.reportStreamFailure`. Do not stop the whole run for it.

---

## What runs on desktop and on mobile

| What the connector does | Desktop app | Mobile app | In the mobile app, do this instead |
|---|---|---|---|
| `page.goto`, `page.content`, `page.evaluate`, `page.waitForFunction` | yes | yes | Nothing |
| `fetch` inside `page.evaluate` (`same_origin_page_fetch`) | yes | yes | Nothing |
| `page.context().request.get` (`host_http_request`) | yes, with the page's cookies | yes, but do not rely on the page's cookies | Use `fetch` inside the page for signed-in requests (rule 3) |
| Locators, `click`, `fill`, `waitForSelector` (`page_input`) | yes | no | Read through the site's API (rule 1), and use `waitForFunction` to wait |
| Read response bodies of the site's own traffic (`page_response_observation`) | yes | no, support is planned | Call the same API with `fetch` inside the page (rule 3) |
| Read the cookie jar (`cookie_read`) | yes | no | Send requests with `fetch` inside the page, which carries the cookies |
| Cross-origin iframes | yes | no | Keep the connector desktop-only (rule 6) |
| Downloads and archive reads (`host_download_capture`, `host_archive_extraction`) | yes | only through an adapter written for one connector (`connectors/anthropic/` has the only one) | Ask a maintainer before you depend on them |

`scripts/pageshim/capabilities.mjs` is the current list of features the mobile app provides, and `playwrightPageFacade` in `scripts/pageshim/runtime.ts` is the page subset.

---

## Before you open a PR

Check the connector against the rules above. To add it to the mobile build, follow [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md). Its harness runs the mobile bundle against fixtures.
