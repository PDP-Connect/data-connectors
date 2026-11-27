# Polyfill connector agent rules

Rules for anyone who edits `packages/polyfill-connectors`. Run the commands from this directory. The steps to build a connector are in [AUTHORING.md](../../AUTHORING.md). The test commands and lanes are in [TESTING.md](../../TESTING.md).

## Before a PR

1. Run `npm run verify`. CI runs the same command in the `verify` job.
2. Run `npm run test:fast` while you edit, and `npm test` from the repo root before the PR.

[TESTING.md](../../TESTING.md#tiers) says what each command runs and holds the rule that a fix needs a test.

## Rules in TypeScript files

Biome rejects each of these with its Ultracite rules at error severity.

1. `any`. Use `unknown` and narrow, or write the real type.
2. `@ts-ignore`. Use `@ts-expect-error` with a comment.
3. A non-null assertion (`x!`). Narrow with an `if` check or `??`.
4. Banned types (`Function`, `Object`, `{}`, boxed `String` and `Number`). Use lowercase primitives or a real signature.
5. `const enum`. Use a literal union type.

Reviewers also reject the double cast `as unknown as X`. Bridge types with a narrowing function or a schema parse.

## Parse third-party responses at the boundary

A response body is `unknown`. A type assertion hides a changed response shape until it crashes at runtime.

```ts
// Hides drift.
const data = (await res.json()) as OrderResponse;

// Parse at the boundary; the schema is the type.
const data = orderResponseSchema.parse(await res.json());
```

Each connector's `connectors/<key>/schemas.ts` exports `validateRecord`. Use it to check records, and add a schema for each new record format instead of widening a type.

## What the runtime owns

The runtime in `src/` owns the protocol messages, and a connector owns its records and stream logic. [collection-profile-runtime.md](docs/collection-profile-runtime.md) lists which side owns what.

If a connector needs something the runtime does, find the shared helper in `src/` first, and add one when none exists. Do not work around the runtime inside a connector.
