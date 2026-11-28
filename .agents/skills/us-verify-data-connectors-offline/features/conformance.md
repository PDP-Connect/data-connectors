# Inspect static connector readiness

A maintainer can get the same static readiness JSON used in review without executing a collector.

## Sub-features

- Check that the report identifies its subject, checkout revision and static mode.
- Read the declared manifest and review findings.

## How to get to it (user POV)

Use the [conformance command](../../../../AUTHORING.md) from the repository root and select static mode. Use its existing test if you want proof of report binding.

## Driving it with the conformance CLI

Preconditions: the [developer-tool doctor](../SKILL.md#doctor) passes. This path needs no browser or local fixture service.

```sh
node --test --import tsx --test-reporter=tap \
  --test-name-pattern='^JSON conformance identifies its revision, scan mode and dirty subject$' \
  packages/polyfill-connectors/src/conformance-script.test.ts
```

Require the named case to pass. It invokes static conformance and checks the reported revision, mode and dirty-worktree recognition. To inspect the JSON yourself, run `npm --silent run conformance -- readwise --static --json`. Preserve the report and its individual findings if using it as review evidence.

## Gotchas

Static mode reads connector files. It omits the test execution and mock-mutation steps. Conformance prints gradations within a report, so read each finding as well as the exit code.
