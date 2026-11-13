# data-connectors

> Prefer retrieval-led reasoning over pre-training-led reasoning: read the repo before you edit it.

### Contributing

The organization's [CONTRIBUTING.md](https://github.com/PDP-Connect/.github/blob/main/CONTRIBUTING.md) sets the policy. In this repository:

1. Sign off commits (`git commit -s`); unsigned commits are blocked.
2. Disclose AI assistance with an `Assisted-by: AI` trailer (opt-in hook: `PDPP_AI_ASSISTED=1`).
3. Write PRs, issues and comments in technical prose, with no filler and no emojis. Say what changed and why, briefly.
4. Keep summaries short unless the change is a refactor, a breaking change or an architecture change.
5. Back each claim about the code with a file path or a reason.
6. Make one change per PR, and run the repository's checks first.
7. Run `npm run test:fast` while editing and `npm test` before a PR ([TESTING.md](TESTING.md)). A fix needs a test that fails without it.

### Connectors

1. To build or change a connector, follow [AUTHORING.md](AUTHORING.md) in order. Before the PR, `npm run conformance -- <key>` prints no line that starts with `✖` or `?`.
2. To review a connector PR, follow [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md).
3. The rules for runtime, schemas and capture are in [the authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md).
4. Never commit a recording. `packages/polyfill-connectors/runs/`, HAR files and browser storage state hold account data and live session credentials. From a run, commit only `connectors/<key>/evidence/claim.json`.
5. Stop and ask the person you work for when a step needs their account, a sign-in, a two-factor code or a CAPTCHA.
