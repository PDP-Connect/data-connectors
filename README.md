# Data Connectors

This repository holds connectors that collect a person's own data from a platform, such as an API, a signed-in website or an exported file, and emit it as records in the format of the [PDPP Collection Profile](docs/spec/collection-profile.md). Each connector is a directory in `connectors/`. The runtime and tools they share are in `packages/polyfill-connectors/`.

## Contribute a connector

1. Follow [AUTHORING.md](AUTHORING.md). It takes you from install to an open PR, with one command per step.
2. For a browser connector, also follow the [browser connector guidelines](CONNECTOR-GUIDELINES.md). They say what works in the desktop app and in the mobile app.
3. Sign off each commit with `git commit -s`. If AI helped with a commit, add an `Assisted-by: AI` trailer. [CONTRIBUTING.md](https://github.com/PDP-Connect/.github/blob/main/CONTRIBUTING.md) gives the full policy.

A maintainer reviews the PR against [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md). Coding agents start at [AGENTS.md](AGENTS.md).

## Reference

| You want to | Read |
|---|---|
| Look up a rule for runtime, schemas or capture | [Connector authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md) |
| Look up what each evidence tier needs | [Connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) |
| Add a connector to the mobile app | [docs/add-a-connector-to-mobile.md](docs/add-a-connector-to-mobile.md) |
| Run the test suites | [TESTING.md](TESTING.md) |
| Learn how connectors are versioned and published | [docs/publishing.md](docs/publishing.md) |
| Review, merge and publish a connector PR | [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md) |
