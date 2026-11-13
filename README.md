# Data Connectors

This repository holds connectors that collect a person's own data from a platform, such as an API, a signed-in website or an exported file, and emit it as records in the format of the [PDPP Collection Profile](docs/spec/collection-profile.md). Each connector is a directory in `connectors/`. The runtime and tools they share are in `packages/polyfill-connectors/`.

| You want to | Read |
|---|---|
| Install, then build a new connector or change one | [AUTHORING.md](AUTHORING.md) |
| Review, merge and publish a connector PR | [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md) |
| Look up a rule for runtime, schemas or capture | [Connector authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md) |
| Look up what each evidence tier needs | [Connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) |
| Run the test suites | [TESTING.md](TESTING.md) |
| Learn how connectors are versioned and published | [docs/publishing.md](docs/publishing.md) |
| Contribute under the project's policy (sign-off, AI disclosure) | [CONTRIBUTING.md](https://github.com/PDP-Connect/.github/blob/main/CONTRIBUTING.md) |

Coding agents start at [AGENTS.md](AGENTS.md).
