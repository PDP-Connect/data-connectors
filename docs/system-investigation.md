# System Investigation Guide

Start with one claim you could be wrong about. “If a collection stops after page one, the next run at the same limit will emit the deferred record.” Name the caller, the action, and the observation that would settle it. Read the existing assertion in the connector, runtime or installer that owns it. Use [TESTING.md](../TESTING.md) to locate its normal test lane.

## Four questions

Consider all four questions together as you investigate. Use the tools that can settle the claim. The person reporting the problem only needs to describe what happened.

| Question | How to answer it |
| --- | --- |
| Where should we look? | Start with the connector entry point, a failed replay or a consumer's report. When the search is wide, [Deslop](https://github.com/deterministic-machines/deslop-please) can suggest a dependency or caller worth tracing. The architecture audit used [deslop-please-ts](https://github.com/cmd8/deslop-please-ts) for TypeScript and [deslop-please](https://github.com/Bor4brn/deslop-please) for the JavaScript installer packages. Record what the scan covered. Scanning two packages separately can miss a decision they both make. |
| Who has to know the rule? | Use [Matt Pocock’s `codebase-design` skill](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md) to follow a real collector into the shared runtime and back to its emitted output. For a proposed shared interface, trace a second caller. Name one plausible change that would force both callers to learn the same detail. Compare what each would have to know before and after moving it. Keep provider-specific policy with the connector when its callers genuinely need different behavior. |
| Can a sequence of events break the promise? | If ordering matters, state the invariant and the events that might violate it, such as a retry after a deadline or resuming after a partial page. Start with the smallest sequence you can replay. If the claim covers all allowed orderings, bound a model, map the transitions to real code, check that a deliberately broken rule is detected, and replay a counterexample through the collector. Optional tools for a new model include Pstack’s [`create-formal-verification-skill`](https://github.com/cursor/plugins/tree/main/pstack/skills/create-formal-verification-skill) and [`statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart), which uses TLC for TLA+. A two-run fixture establishes the sequence it exercised. |
| What happened when we tried it? | Follow saved state into the next collection, emitted records into the consuming stream, or installed files into an actual import. Match the observation to the claim. To establish that a downstream app rendered a record, carry its key to that app and check there. If access stops at the connector output, state exactly where the evidence ends. |

## Worked example: can the next Calendar run reach page two?

The [Calendar tests](../connectors/google_calendar/index.test.ts) include a two-page fixture with a one-page limit. The capped-run check asserts that the collector emits the first event and discloses the deferred page. A claim about resuming requires one more observation. Give a fresh collector the first run's saved state, keep the limit at one, and check whether the second event's ID appears. Increasing the limit on run two answers a different question. Keep the provider interaction synthetic and distinguish a fixture result from a claim about a live account. The Calendar fixture uses `node:test` and `FakeCalendarClient`. For recorded two-run scenarios, use [`scenario-record` and `scenario-verify`](../AUTHORING.md). For browser connectors, the [PageShim test lane](../TESTING.md#tiers) exercises browser behavior with fixture responses.

For an example already exercised at the receiving end, find `an installed multi-module profile loads as a module graph` in the [installer test](../packages/connector-installer-core/oci.test.mjs). It installs a signed fixture into a temporary directory, imports the entry point from that directory, and calls the exported function that uses its sibling helper. That establishes what a caller of the installed snapshot can load. Activation inside a host app is a separate observation.

Run that example from the repository root with the installer dependencies installed and a loopback port available. The fixture invokes `tar` to build its archive. Use GNU tar on macOS if the fixture picks up a `LIBARCHIVE.xattr.com.apple.provenance` attribute and is rejected before import.

```sh
scripts/test-sandbox/test-sandbox -- node --test --test-name-pattern='an installed multi-module profile loads' packages/connector-installer-core/oci.test.mjs
```

## Leave the next investigator a better starting point

Keep a reproduced fault in the connector or package test that exercises its public interface. Update its authoring or review guidance when the supported contract or interpretation of evidence changes. For replay evidence follow the [review rules](../CONNECTOR-REVIEW.md) and the repository’s recording policy. A replay claim belongs in the existing claim file; account recordings stay local.

Alongside a reusable check, give the revision, synthetic input or fixture, command, expected observation, actual result and limits. Explain why the evidence warrants fixing the fault, keeping the design for a named caller, or deferring until a specific need appears. A teammate should be able to rerun the smallest check and challenge the conclusion. Update this guide when the method changes and the owning check when the behavior changes.
