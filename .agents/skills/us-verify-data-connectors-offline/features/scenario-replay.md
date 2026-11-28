# Record and replay a connector scenario

An author can verify the scenario workflow with the real CLIs and a synthetic provider. The fixture exercises a saved cursor and records how the verifier reacts to a changed payload.

## Sub-features

- Record an initial collection and continue from its cursor.
- Replay both runs after shutting down the fixture provider.
- Reject a tampered payload with a record-hash mismatch.

## How to get to it (user POV)

Use the scenario command-line tools from the repository root. For this proof, use the skill runner, which selects the [two-run synthetic fixture](../../../../packages/polyfill-connectors/bin/scenario-cli.test.ts) and retains its diagnostics.

## Driving it with node:test

Preconditions: the [developer-tool doctor](../SKILL.md#doctor) passes and the local environment permits loopback sockets.

```sh
proof_parent="$(mktemp -d)"
node .agents/skills/us-verify-data-connectors-offline/run.mjs "$proof_parent/proof"
```

Require `recordedRuns: 2`, `replayedRuns: 2`, `replayedInteractions: 3` and `mutationRejectedAt: "record_hash"` in the passing receipt. In `scenario.tap`, verify both original runs pass and the tampered first run fails.

## Gotchas

The process-local result proves intercepted Node fetch and a replay that succeeds after the fixture server shuts down. Kernel isolation has its own reported condition. Keep the synthetic evidence distinct from a bound connector claim.
