---
name: pdp-connect
description: >
  Connect personal data from any web platform using legacy Playwright browser automation.
  Use when: (1) user wants to connect a data source like ChatGPT, Instagram,
  Spotify, or any platform, (2) user says "connect my [platform]",
  (3) user wants to generate or update their profile from connected data.
  New connector requests route to PDP-Connect/pdpp instead of this legacy skill.
---

# Connect with legacy Playwright

Connect personal data from web platforms using the in-repo scripts under `skills/pdp-connect/scripts/` and local browser automation.

This skill runs and maintains the legacy `*-playwright.js` and `*-playwright.json` format. It does not create or run PDPP Collection Profiles. For new connector work, read [Connector authoring](../../AUTHORING.md).

## Setup

Check whether the bundled runner's dependencies are already installed:

```bash
ls playwright-runner/node_modules/playwright/package.json
```

If it's missing, follow `SETUP.md` in this folder before continuing. Tell the user: "I need to do a one-time setup first. This installs a browser engine and some dependencies and usually takes about a minute."

If setup, fetch, or run output is truncated, check `~/.pdp-connect/desktop/logs/` directly.

## Flow

### 1. Explore available sources

```bash
node skills/pdp-connect/scripts/fetch-connector.cjs <platform>
```

or inspect `registry.json` / the `connectors/` directory directly for the source of truth on what can currently be connected.

If the requested platform is present, use the run flow below.

**If no connector exists for the platform,** start the work in `PDP-Connect/pdpp`. Follow [Connector authoring](../../AUTHORING.md). Do not create a legacy Playwright connector unless a maintainer approves an explicit exception.

If the user is building or testing an app and needs sample data, prefer the
public fixture flow over pasting large JSON into the agent:

```bash
curl -fsSL https://raw.githubusercontent.com/PDP-Connect/data-connectors/main/fixture-index.json
```

Find the matching `sourceId`, `scope`, and `scenario`, then download the entry's
`rawUrl` into a local `fixtures/` directory. Fixtures are synthetic scope
payloads that conform to the connector schema. The raw URL points at latest
`main`. Compare the downloaded file against the entry's `sha256` if exact bytes
matter.

### 2. Run the connector

Start with the agent-safe, non-interactive probe:

```bash
node run-connector.cjs connectors/<company>/<name>-playwright.js [start-url]
```

This will:

- resolve the playwright-runner (auto-detected, or pass `--runner-dir`)
- try a saved browser-profile session if one exists
- stream structured line-delimited JSON events on stdout: `need-input`, `legacy-auth`, `log`, `result`, `error`

If the connector emits `need-input`, either supply the value up front with `--inputs '{"key":"val"}'` or rerun with `--pretty` for a human-readable interactive session so the user can respond.

If the connector emits `legacy-auth`, it still depends on an older `showBrowser` / `promptUser` pattern. It may need a headed or manual session path. Tell the user instead of retrying blindly.

### 3. Handle outcomes

- `need-input`: The connector needs a live login or another manual step. Explain that you will rerun interactively or with `--inputs`.
- `legacy-auth`: This source still needs a headed or manual session. It might not work in fully headless batch mode.
- `result`: The connector wrote data to the output path. The default path is `~/.pdp-connect/desktop/last-result.json`.
- `error`: The run failed. Inspect the emitted message and `~/.pdp-connect/desktop/logs/` if present.

If output is truncated or unclear, check `~/.pdp-connect/desktop/logs/` directly rather than rerunning blindly.

After a successful run, read the result file at the output path to inspect the collected data.

### 4. Validate, present results, and offer to contribute

If you modified a connector, run validation before you present results to the user:

```bash
node skills/pdp-connect/scripts/validate.cjs connectors/<company>/<name>-playwright.js --check-result ~/.pdp-connect/desktop/last-result.json
```

Fix all reported issues. The validator checks debug code, login methods, schema descriptions, and data cleanliness. Iterate until validation passes.

Then read the result file and summarize for the user in human terms (see "Communicating with the user" below).

If you built a new legacy connector under an approved exception, ask the user:

> "Want to share this connector so others can connect their [Platform] data too? Contributing means the community helps maintain it when [Platform] changes their site."

If yes, run `node skills/pdp-connect/scripts/validate.cjs connectors/<company>/<name>-playwright.js --contribute`. If no, move on.

### 5. Suggest what to do with the data

After the contribution question is resolved (or if using an existing connector), suggest use cases from `RECIPES.md`: user profile generation, personal knowledge base, data backup, cross-platform synthesis, activity analytics.

## Communicating with the user

The user can't see what you're doing behind the scenes. Keep them informed at key moments:

1. **Before asking for credentials**, explain the approach and reassure on privacy:
   - "I will connect to [Platform] using a local browser. Your credentials stay local. Only [Platform] receives them."
   - If using an API key: "This uses [Platform]'s API key. You can find it at [location]. The key stays on your machine."

2. **During long operations** (building a connector, collecting paginated data), give brief progress updates. Don't go silent for more than ~30 seconds.

3. **After collection**, summarize results in human terms, not file paths:
   - Good: "Connected! I collected 249 issues, 63 projects, 9 teams, and your profile from Linear."
   - Bad: "Data saved to ~/.pdp-connect/desktop/last-result.json"
   - Build the summary from the result's `exportSummary` and the scoped keys.

4. **On failure**, explain what went wrong and what the user can do:
   - Auth failed → "Login didn't work. Can you double-check your credentials?"
   - Platform API changed → "The connector couldn't find the expected data. The platform may have changed their site."

## Rules

1. **Ask before saving** -- no writes to user profile without approval
2. **Never log credentials** -- no echo, print, or output of secrets
3. **One platform at a time**
4. **Check session first** -- try without credentials if a browser profile exists
5. **Read connectors before running them**
6. **Run connectors via `run-connector.cjs`** -- it is the sole documented entrypoint for executing a connector; see `SETUP.md` for the one-time runtime install
