# Polyfill connectors: agent rules

Rules for anyone who edits `packages/polyfill-connectors`. Run the commands from this directory. The connector command sequence is in [AUTHORING.md](../../AUTHORING.md); test lanes are in [TESTING.md](../../TESTING.md).

## Before a PR

1. `npm run verify` runs the library metadata check, `tsc --noEmit` with the strict flags in `tsconfig.json`, the Biome check (`npm run check`) and three package guards. CI runs the same command in the `verify` job.
2. `npm run test:fast` runs the tests related to your change.

## Rules in TypeScript files

Biome (Ultracite rules at error severity) rejects each of these:

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

Each connector's `connectors/<key>/schemas.ts` exports `validateRecord`. Use it for record shapes, and add a schema for each new shape instead of widening a type.

## What the runtime owns

The runtime in `src/` owns the Collection Profile protocol messages, browser lifecycle, tracing, fixture capture, counters, retryable-error classification and auth resolution. A connector owns which records it produces, how it parses them, and its stream logic (cursors, tombstones through `isTombstone`).

If a connector needs protocol plumbing, look for the runtime seam first, and add one to the runtime when none exists. Do not work around the runtime inside a connector.
