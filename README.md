# Data Connectors

This repository holds the connectors that collect a person's own data from a platform and emit it as records that follow the [PDPP Collection Profile](docs/spec/collection-profile.md). Each connector lives in `connectors/<key>/`, with its `manifest.json`, code, icon and tests. `packages/polyfill-connectors/` holds the runtime the connectors share and the tools to build and check them.

A connector reads from one of three kinds of source:

1. A platform API, with a token or key the person supplies (example: `connectors/steam/`).
2. A browser session the person signs in to (example: `connectors/chatgpt/`).
3. A file the person exports from the platform or a local app (example: `connectors/apple_health/`).

## Where to start

| You want to | Read |
|---|---|
| Build a new connector or change one | [AUTHORING.md](AUTHORING.md) |
| Review, merge and publish a connector PR | [CONNECTOR-REVIEW.md](CONNECTOR-REVIEW.md) |
| Look up a runtime rule, schema rule or capture rule | [Connector authoring guide](packages/polyfill-connectors/docs/connector-authoring-guide.md) |
| Look up what each evidence tier needs | [Connector checklist](packages/polyfill-connectors/CONNECTOR-CHECKLIST.md) |
| Run the test suites | [TESTING.md](TESTING.md) |
| Learn how connectors are packaged and published | [docs/publishing.md](docs/publishing.md) |
| Contribute under the project's policy (sign-off, AI disclosure) | [CONTRIBUTING.md](https://github.com/PDP-Connect/.github/blob/main/CONTRIBUTING.md) |

Coding agents start at [AGENTS.md](AGENTS.md).

## Install

You need Node 24 and npm. From the repository root:

```sh
npm ci
npm ci --ignore-scripts --prefix packages/polyfill-connectors/test-tools
```

The second command installs the pinned test tools that the package's checks use. Then check one connector:

```sh
npm run conformance -- steam
```

Each line of the output starts with a verdict symbol. `AUTHORING.md` explains each one.
