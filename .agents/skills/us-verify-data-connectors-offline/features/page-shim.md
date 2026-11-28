# Verify PageShim fixture navigation

A browser connector author can check the browser bridge against an HTML fixture without opening a provider session.

## Sub-features

- Serve the fixture page and read its ready text across the bridge.
- Check that fast fixture readiness preserves the authentic harness result.

## How to get to it (user POV)

Run the [PageShim timing test](../../../../scripts/pageshim/harness-timing.test.mjs) from the repository root.

## Driving it with Playwright Chromium

Preconditions: the [developer-tool doctor](../SKILL.md#doctor) passes and the Playwright-pinned Chromium is already installed. Check the executable with `node --input-type=module -e 'import { accessSync } from "node:fs"; import { chromium } from "playwright"; accessSync(chromium.executablePath());'`.

```sh
node --test --test-reporter=tap \
  --test-name-pattern="^fixture readiness keeps a run's results and skips the fixed navigation delay$" \
  scripts/pageshim/harness-timing.test.mjs
```

Require the named case to pass. The harness checks that the baseline and fast paths read the same ready text and emit the same calls and results. Keep the TAP output with the checkout revision if reporting this lane.

## Gotchas

A missing Chromium is a prerequisite failure. Use a synthetic fixture worktree and run one suite at a time. This exercise uses the browser harness that models the PageShim bridge. Device and provider proofs use their own entry points.
