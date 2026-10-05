#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * connector-init — scaffold a new connector, declaration-first.
 *
 * Generates the minimal set of files a new connector needs to pass the
 * fleet's build-time guardrails (manifest-honesty suite, pilot-fixture
 * shape lock, manifest/schema/emit reconciliation) on day one:
 *
 *   connectors/<name>/manifest.json    — one stream, honest minimal schema
 *   connectors/<name>/index.ts         — runConnector wiring, one TODO endpoint
 *   connectors/<name>/schemas.ts       — makeValidateRecord over the manifest schema
 *   connectors/<name>/types.ts         — upstream API response shape stub
 *   connectors/<name>/parsers.ts       — pure record builder stub
 *   connectors/<name>/pilot-fixture.test.ts — wired via the shared helper
 *   connectors/<name>/fixtures/scrubbed/pilot-real-shape/records/<stream>.jsonl
 *   connectors/<name>/fixtures/scrubbed/pilot-real-shape/provenance.json
 *
 * Usage:
 *   node --import tsx bin/connector-init.ts <name> [--display-name <n>] [--stream <stream-name>] [--browser]
 *
 * `<name>` becomes the connector key (directory name, manifest filename,
 * `connector_key`). It must be a lowercase snake_case identifier — the same
 * shape every existing connector key uses.
 *
 * Refuses to run if any target file/directory already exists (lists every
 * collision and exits non-zero) — init never overwrites.
 *
 * Default (API mode): the scaffold is deliberately tiny — one stream, one
 * synthetic pilot record, one TODO'd HTTP call. It exists to get a new
 * connector past the "does the fleet's plumbing accept this shape" question
 * immediately, so a connector author's first `node --test` run is green and
 * every edit from there on is adding real behavior, not fighting the
 * harness.
 *
 * `--browser`: scaffolds a browser-session connector instead (manifest
 * declares `browser` + `network` bindings and `human_interaction:
 * ["manual_action"]"`; `index.ts` wires the canonical `runConnector({
 * browser: { profileName } })` pattern — a session probe against a declared
 * "am I logged in" URL/selector, the fleet's `manualBrowserLogin` handoff on
 * a cold profile, and one TODO where the author navigates and extracts
 * rows). Modeled on `connectors/github_browser/index.ts` — see
 * docs/connector-authoring-guide.md §0 ("Browser architecture").
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	connectorDir as connectorDirFor,
	fixturesDir,
	manifestPath,
} from "../src/connector-paths.ts";

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const STREAM_RE = /^[a-z][a-z0-9_]*$/;

interface InitArgs {
	/** `--browser`: scaffold a browser-session connector instead of the
	 *  default API-class one. See this file's module docstring. */
	browser: boolean;
	displayName: string;
	name: string;
	stream: string;
}

const USAGE =
	"usage: node --import tsx bin/connector-init.ts <name> [--display-name <n>] [--stream <stream-name>] [--browser]";

/** Thrown by parseArgs on any invalid invocation. main() maps this to a printed usage + exit(2). */
export class InitArgsError extends Error {}

function titleCase(name: string): string {
	return name
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/**
 * Pure argument parser: never touches process.exit/console so it is directly
 * unit-testable. Throws InitArgsError on any invalid invocation; the CLI
 * entry point (main()) is the only place that turns a thrown error into
 * printed usage text and a process exit code.
 */
function parseArgs(argv: string[]): InitArgs {
	const [name, ...rest] = argv;
	if (!name || name.startsWith("--")) {
		throw new InitArgsError(USAGE);
	}
	if (!NAME_RE.test(name)) {
		throw new InitArgsError(
			`invalid connector name "${name}": must be lowercase snake_case (e.g. "acme_widgets")`,
		);
	}
	let displayName = titleCase(name);
	let stream = "items";
	let browser = false;
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--display-name") {
			const value = rest[i + 1];
			if (!value) {
				throw new InitArgsError(USAGE);
			}
			displayName = value;
			i += 1;
		} else if (arg === "--stream") {
			const value = rest[i + 1];
			if (!value) {
				throw new InitArgsError(USAGE);
			}
			stream = value;
			i += 1;
		} else if (arg === "--browser") {
			browser = true;
		} else {
			throw new InitArgsError(`unrecognized argument: ${String(arg)}`);
		}
	}
	if (!STREAM_RE.test(stream)) {
		throw new InitArgsError(
			`invalid stream name "${stream}": must be lowercase snake_case (e.g. "items")`,
		);
	}
	return { name, displayName, stream, browser };
}

// ─── Target file plan ───────────────────────────────────────────────────

interface TargetPlan {
	connectorDir: string;
	files: {
		fixtureJsonl: string;
		indexTs: string;
		manifestJson: string;
		parsersTs: string;
		pilotFixtureTestTs: string;
		provenanceJson: string;
		schemasTs: string;
		typesTs: string;
	};
	fixtureRecordsDir: string;
}

function planTargets(name: string, stream: string): TargetPlan {
	const connectorDir = connectorDirFor(name);
	const fixtureDir = join(fixturesDir(name), "scrubbed", "pilot-real-shape");
	const fixtureRecordsDir = join(fixtureDir, "records");
	return {
		connectorDir,
		fixtureRecordsDir,
		files: {
			manifestJson: manifestPath(name),
			indexTs: join(connectorDir, "index.ts"),
			schemasTs: join(connectorDir, "schemas.ts"),
			typesTs: join(connectorDir, "types.ts"),
			parsersTs: join(connectorDir, "parsers.ts"),
			pilotFixtureTestTs: join(connectorDir, "pilot-fixture.test.ts"),
			fixtureJsonl: join(fixtureRecordsDir, `${stream}.jsonl`),
			provenanceJson: join(fixtureDir, "provenance.json"),
		},
	};
}

function findCollisions(plan: TargetPlan): string[] {
	const candidates = [plan.connectorDir, ...Object.values(plan.files)];
	return candidates.filter((path) => existsSync(path));
}

// ─── File content builders ──────────────────────────────────────────────
//
// The manifest is the declaration-first source of truth: one stream with an
// `id` primary key and a `created_at` event-time cursor field, plus one
// example free-text field (`title`). This exact shape is chosen to satisfy
// the manifest-honesty test family without any per-field allowlisting:
//
//   - `required: true` is declared explicitly on the stream (the
//     coverage-policy honesty test's ratchet requires every NEW stream to
//     state this rather than rely on the implicit default).
//   - `created_at` carries `x_pdpp_role: "event-time"` and is BOTH the
//     stream's `cursor_field` and `consent_time_field` — the
//     query-affordance honesty tests exempt a field from the mandatory
//     `range_filters`/`group_by_time` declarations exactly when it IS the
//     stream's own cursor_field (see src/query-affordance-manifest-honesty
//     .test.ts's isRangeRequiredTimeField/isGroupByTimeRequiredField), so
//     no range/group_by_time declaration is needed for it.
//   - `title` carries `x_pdpp_role: "primary-title"` (presentation-role
//     honesty requires >=1 role per stream, and the primary-title role
//     must land on a string field) and is declared in both
//     `query.search.lexical_fields` and `query.search.semantic_fields`
//     (the search-affordance honesty test requires this for any
//     string field named "title" — see LEXICAL_FIELD_NAMES /
//     SEMANTIC_FIELD_NAMES in src/search-affordance-manifest-honesty.test.ts).
//   - `public_listing.tier: "development"` — the only tier a brand-new,
//     unverified connector can honestly claim.

function buildManifest(
	name: string,
	displayName: string,
	stream: string,
): string {
	const manifest = {
		protocol_version: "0.1.0",
		connector_id: `https://registry.pdpp.dev/connectors/${name}`,
		connector_key: name,
		manifest_uri: `https://registry.pdpp.dev/connectors/${name}`,
		version: "0.1.0",
		display_name: displayName,
		runtime_requirements: {
			bindings: {
				network: {
					required: true,
				},
			},
		},
		capabilities: {
			human_interaction: [],
			refresh_policy: {
				recommended_mode: "manual",
				recommended_interval_seconds: 21_600,
				minimum_interval_seconds: 3600,
				maximum_staleness_seconds: 86_400,
				interaction_posture: "none",
				rate_limit_sensitivity: "medium",
				bot_detection_sensitivity: "low",
				background_safe: false,
				rationale:
					"Scaffolded connector: manual refresh until a real rate profile is measured against the live API.",
			},
			public_listing: {
				tier: "development",
			},
			auth: {
				kind: "env",
				required: [`${name.toUpperCase()}_API_TOKEN`],
			},
		},
		streams: [
			{
				name: stream,
				description: `TODO: describe the ${stream} stream (what it is, one sentence).`,
				display: {
					label: `Your ${displayName} ${stream}`,
					detail:
						"TODO: describe the fields an owner will see for this stream.",
				},
				semantics: "mutable_state",
				schema: {
					type: "object",
					properties: {
						id: {
							type: "string",
						},
						created_at: {
							type: "string",
							format: "date-time",
							x_pdpp_role: "event-time",
						},
						title: {
							type: ["string", "null"],
							x_pdpp_role: "primary-title",
						},
					},
					required: ["id", "created_at"],
				},
				primary_key: ["id"],
				cursor_field: "created_at",
				consent_time_field: "created_at",
				required: true,
				selection: {
					fields: true,
					resources: true,
				},
				incremental: true,
				query: {
					search: {
						lexical_fields: ["title"],
						semantic_fields: ["title"],
					},
					aggregations: {
						count: true,
					},
				},
				coverage_strategy: "checkpoint_window",
				freshness_strategy: "manual_as_of",
			},
		],
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

// ─── Browser-mode manifest ───────────────────────────────────────────────
//
// Same stream shape (id/created_at/title, same x_pdpp_role placements) as
// buildManifest above — that shape is what already satisfies the honesty
// suite, so browser mode keeps it unchanged and only varies the parts that
// are genuinely different for a browser-session connector:
//
//   - `runtime_requirements.bindings` declares BOTH `browser` and `network`
//     (every browser-binding connector in the fleet declares both — see
//     connectors/github_browser and connectors/oura_browser/manifest.json).
//     `browser.features` lists only what this scaffold's index.ts actually
//     calls: `page_navigation` (the session-check/listing `page.goto`),
//     `page_condition_wait` (the session-check `page.waitForSelector`), and
//     `page_script_evaluation` (the TODO extraction's `page.locator(...)
//     .evaluateAll(...)`). `network` is declared `required: true` with no
//     `features` — this scaffold never makes a host-level or same-origin
//     fetch, matching how the API-mode scaffold above also declares a
//     bare, feature-less `network` binding.
//   - `capabilities.auth` is omitted: a browser-session connector
//     authenticates via the owner's signed-in browser profile, not an env
//     credential (no `*_browser` connector in the fleet declares `auth`).
//   - `capabilities.human_interaction: ["manual_action"]` — required by
//     docs/spec/collection-profile.md §3.4 before a connector may emit an
//     INTERACTION of that kind; this scaffold's manual-login handoff does.
//   - `refresh_policy.interaction_posture: "manual_action_likely"` instead
//     of API mode's `"none"` — the session can go cold and need a fresh
//     owner sign-in, exactly the posture every `*_browser` manifest states.
//   - `protocol_version: "0.2.0"`, `protocol_capabilities: ["OBSERVATION"]`,
//     and `diagnostic_descriptors` (steps `sign_in`/`list_rows`,
//     expectations `session_check`/`rows_container`) — so a selector miss
//     diagnoses as `expectation_mismatch` instead of `unknown` (Collection
//     Profile §3.8, §5.10-5.11). index.ts's probeLoggedIn/extractRows wait
//     on these exact ids via waitForElementExpectation. See the CAUTION
//     comment above `protocolCapabilities` in buildBrowserIndexTs below
//     before this connector is placed on anything but connector-dev.

function buildBrowserManifest(
	name: string,
	displayName: string,
	stream: string,
): string {
	const manifest = {
		// 0.2.0, not 0.1.0: this manifest declares `protocol_capabilities`
		// (OBSERVATION) and `diagnostic_descriptors` below, and Collection
		// Profile §3.8 requires a manifest that declares either to state
		// `protocol_version: "0.2.0"`. See the CAUTION comment above
		// `protocolCapabilities` in index.ts before placing this connector on
		// any runtime other than connector-dev.
		protocol_version: "0.2.0",
		connector_id: `https://registry.pdpp.dev/connectors/${name}`,
		connector_key: name,
		manifest_uri: `https://registry.pdpp.dev/connectors/${name}`,
		version: "0.1.0",
		display_name: displayName,
		runtime_requirements: {
			bindings: {
				browser: {
					required: true,
					features: [
						"page_navigation",
						"page_condition_wait",
						"page_script_evaluation",
					],
				},
				network: {
					required: true,
				},
			},
		},
		capabilities: {
			human_interaction: ["manual_action"],
			refresh_policy: {
				recommended_mode: "manual",
				recommended_interval_seconds: 21_600,
				minimum_interval_seconds: 3600,
				maximum_staleness_seconds: 86_400,
				interaction_posture: "manual_action_likely",
				rate_limit_sensitivity: "medium",
				bot_detection_sensitivity: "medium",
				background_safe: false,
				rationale:
					"Scaffolded browser connector: manual refresh via the owner's signed-in session until a real rate profile is measured against the live site.",
			},
			public_listing: {
				tier: "development",
			},
		},
		// Declares the OBSERVATION wire capability (Collection Profile §3.4,
		// §5.10) so a failed session check or extraction reports WHAT the page
		// showed (expectation_mismatch) instead of `unknown`. index.ts's
		// probeLoggedIn/extractRows wait on these declared ids via
		// waitForElementExpectation — see the CAUTION comment above
		// `protocolCapabilities` in index.ts.
		protocol_capabilities: ["OBSERVATION"],
		diagnostic_descriptors: {
			steps: [{ id: "sign_in" }, { id: "list_rows" }],
			expectations: [
				{ id: "session_check", step: "sign_in" },
				{ id: "rows_container", step: "list_rows" },
			],
		},
		streams: [
			{
				name: stream,
				description: `TODO: describe the ${stream} stream (what it is, one sentence).`,
				display: {
					label: `Your ${displayName} ${stream}`,
					detail:
						"TODO: describe the fields an owner will see for this stream.",
				},
				semantics: "mutable_state",
				schema: {
					type: "object",
					properties: {
						id: {
							type: "string",
						},
						created_at: {
							type: "string",
							format: "date-time",
							x_pdpp_role: "event-time",
						},
						title: {
							type: ["string", "null"],
							x_pdpp_role: "primary-title",
						},
					},
					required: ["id", "created_at"],
				},
				primary_key: ["id"],
				cursor_field: "created_at",
				consent_time_field: "created_at",
				required: true,
				selection: {
					fields: true,
					resources: true,
				},
				incremental: true,
				query: {
					search: {
						lexical_fields: ["title"],
						semantic_fields: ["title"],
					},
					aggregations: {
						count: true,
					},
				},
				coverage_strategy: "checkpoint_window",
				freshness_strategy: "manual_as_of",
			},
		],
	};
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function buildTypesTs(displayName: string, stream: string): string {
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the ${displayName} connector. Kept out of index.ts so the
// pure record builders in parsers.ts can import them without pulling in the
// runtime entry point (see connectors/github/types.ts for the pattern this
// scaffold follows).

// TODO: replace with the real upstream ${displayName} API response shape
// for the "${stream}" stream.
export interface ${pascalCase(stream)}Item {
  created_at: string;
  id: number | string;
  title?: string | null;
}
`;
}

function buildBrowserTypesTs(displayName: string, stream: string): string {
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the ${displayName} browser connector. Kept out of
// index.ts so the pure record builder in parsers.ts can import them
// without pulling in the Playwright-facing runtime entry point (see
// connectors/github_browser/types.ts for the pattern this scaffold
// follows).

// TODO: replace with the real shape extracted from the ${displayName}
// page's DOM for the "${stream}" stream, once index.ts's extractRows()
// TODO is filled in.
export interface ${pascalCase(stream)}Row {
  created_at: string;
  id: string;
  title: string | null;
}
`;
}

function buildParsersTs(name: string, stream: string): string {
	const typeName = `${pascalCase(stream)}Item`;
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the ${name} connector. Kept free of fetch / Node I/O so
// they can be unit-tested in isolation. The HTTP client and pagination
// loop live in index.ts (see connectors/github/parsers.ts for the pattern
// this scaffold follows).

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { ${typeName} } from "./types.ts";

// TODO: fill in the record builder once the real upstream shape is known.
// Must emit exactly the fields declared in manifests/${name}.json's
// "${stream}" stream schema (id, created_at, title).
export function ${camelCase(stream)}Record(item: ${typeName}): RecordData {
  return {
    id: String(item.id),
    created_at: item.created_at,
    title: item.title ?? null,
  };
}
`;
}

function buildBrowserParsersTs(name: string, stream: string): string {
	const typeName = `${pascalCase(stream)}Row`;
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the ${name} browser connector. Kept free of Playwright
// calls so this builder can be unit-tested in isolation. The page
// navigation, session check, and DOM extraction live in index.ts (see
// connectors/github_browser/parsers.ts for the pattern this scaffold
// follows).

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { ${typeName} } from "./types.ts";

// Must emit exactly the fields declared in manifests/${name}.json's
// "${stream}" stream schema (id, created_at, title). Already matches the
// row shape index.ts's extractRows() TODO returns — widen both together as
// the real DOM shape lands.
export function ${camelCase(stream)}Record(row: ${typeName}): RecordData {
  return {
    id: row.id,
    created_at: row.created_at,
    title: row.title,
  };
}
`;
}

function buildIndexTs(name: string, stream: string): string {
	const envVar = `${name.toUpperCase()}_API_TOKEN`;
	const typeName = `${pascalCase(stream)}Item`;
	const recordFn = `${camelCase(stream)}Record`;
	return `#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP ${name} Connector (v0.1.0) — scaffolded by bin/connector-init.ts.
 *
 * Auth: TODO document the real auth flow. Placeholder: bearer token via
 * ${envVar} env var.
 *
 * TODO: document the real upstream API base URL, endpoint(s), and rate
 * limits here, following the header comment style in
 * connectors/strava/index.ts or connectors/github/index.ts.
 */

import { type RecordData, runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { isMainModule } from "@pdpp/connector-protocol";
import { ${recordFn} } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ${typeName} } from "./types.ts";

// TODO: replace with the real upstream endpoint.
const API_URL = "https://api.example.invalid/v1/${stream}";

async function fetch${pascalCase(stream)}(token: string, since: string | undefined): Promise<${typeName}[]> {
  const url = new URL(API_URL);
  if (since) {
    url.searchParams.set("since", since);
  }
  const res = await fetch(url, { headers: { Authorization: \`Bearer \${token}\` } });
  if (res.status === 401) {
    throw new Error("${name}_auth_failed");
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(\`${name}_http_\${String(res.status)}: \${text}\`);
  }
  // TODO: adjust to the real response envelope (this assumes a bare array).
  return (await res.json()) as ${typeName}[];
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "${name}",
    validateRecord,
    retryablePattern: /ECONN|fetch failed/i,
    auth: { kind: "env", required: ["${envVar}"] },
    async collect({ state, requested, credentials, emit, emitRecord, progress }) {
      const token = credentials.${envVar};
      if (!token) {
        throw new Error("${name}_auth_failed");
      }

      if (!requested.has("${stream}")) {
        return;
      }
      await progress("Fetching ${stream}", { stream: "${stream}" });
      const streamState = state.${stream} as { last_created_at?: string } | undefined;
      const since = streamState?.last_created_at;
      let latest = since;

      const items = await fetch${pascalCase(stream)}(token, since);
      for (const item of items) {
        const record: RecordData = ${recordFn}(item);
        await emitRecord("${stream}", record);
        if (!latest || item.created_at > latest) {
          latest = item.created_at;
        }
      }

      await emit({
        type: "STATE",
        stream: "${stream}",
        cursor: { last_created_at: latest ?? null },
      });
    },
  });
}
`;
}

// ─── Browser-mode index.ts ───────────────────────────────────────────────
//
// Follows connectors/github_browser/index.ts — the fleet's smallest, most
// decomposed browser connector (120 lines; everything except the TODO'd
// row extraction is canonical helper wiring) — not the two other `*_browser`
// connectors in the fleet (oura_browser, strava_browser), which are larger
// and inline more business logic. See this file's module docstring.
//
// Shape, matching every `*_browser` connector in the fleet:
//   - `runConnector({ browser: { profileName: name }, ensureSession,
//     probeSession, probeSessionIsAuthoritative: true, collect })`.
//   - `probeLoggedIn` is the "am I logged in" check (3.4's declared
//     human_interaction precondition): navigate to LOGIN_CHECK_URL, wait
//     for LOGIN_CHECK_SELECTOR. Both are loud placeholders (see
//     requireConfigured below) — a scaffold cannot know a real provider's
//     login URL or a selector only present once signed in.
//   - `ensureSession` re-probes, then falls back to `manualBrowserLogin`
//     (packages/polyfill-connectors/src/browser-handoff.ts) in its SIMPLE
//     form — page/probe/sendInteraction only, no assist/completeAssistance/
//     readinessProbe — which emits a real "manual_action" INTERACTION
//     (connector-dev.ts answers it via --answer, TTY, or file-drop) and
//     re-probes once that resolves. Every shipped `*_browser` connector
//     instead passes the assist-based args (see ensureSession's own
//     comment, below, for why this scaffold deliberately doesn't): that
//     richer form polls the live page directly and needs the reference
//     server's streaming-companion wiring to show that page to a remote
//     owner — infrastructure a brand-new `connector-dev` run doesn't have.
//     `ensureSession` only throws if the session still isn't live after
//     the handoff resolves.
//   - `collect`'s ONE TODO is `extractRows`: navigate to the real listing
//     page and extract rows. Everything around it (the `requested` gate,
//     `progress`, the `emitRecord` loop) is already wired, matching how
//     the API-mode scaffold's one TODO is its endpoint URL, not the
//     surrounding protocol plumbing.
//   - Both waits that matter for diagnosis — the session check in
//     probeLoggedIn and the rows-container check in extractRows — go
//     through `waitForElementExpectation` (src/auto-login/locator-helpers.ts)
//     against the manifest's declared `diagnostic_descriptors` ids, and
//     `runConnector` declares `protocolCapabilities: ["OBSERVATION"]`. A
//     missing/hidden rows container then fails the run with an
//     `expectation_mismatch` fact instead of succeeding with 0 records
//     (Collection Profile §5.10-5.11) — see the CAUTION comment above
//     `protocolCapabilities` below before this leaves connector-dev.

function buildBrowserIndexTs(
	name: string,
	displayName: string,
	stream: string,
): string {
	const typeName = `${pascalCase(stream)}Row`;
	const recordFn = `${camelCase(stream)}Record`;
	return `#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP ${name} Connector (v0.1.0) — scaffolded by bin/connector-init.ts --browser.
 *
 * Browser-session connector: ${displayName} is collected from the owner's
 * own signed-in browser session, not an API token. The runtime launches an
 * isolated, persistent Patchright Chromium profile at
 * ~/.pdpp/profiles/${name}/ (PDPP_BROWSER_PROFILE_ROOT overrides the root;
 * see packages/polyfill-connectors/src/browser-launch.ts) and hands this
 * connector a live \`page\` once acquired.
 *
 * Canonical pattern followed: connectors/github_browser/index.ts (see
 * docs/connector-authoring-guide.md §0, "Browser architecture").
 *
 * Declares the OBSERVATION protocol capability (manifest.json's
 * protocol_capabilities + diagnostic_descriptors) and routes both waits
 * that matter for diagnosis through waitForElementExpectation, so a
 * selector miss reports expectation_mismatch instead of unknown
 * (docs/connector-authoring-guide.md §0). See the CAUTION comment above
 * protocolCapabilities below before this connector leaves connector-dev.
 *
 * TODO: document the real ${displayName} login URL and the page(s) this
 * connector navigates, once known.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { waitForElementExpectation } from "../../packages/polyfill-connectors/src/auto-login/locator-helpers.ts";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
  type BrowserCollectContext,
  type EnsureSessionArgs,
  runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { withObservationBasis } from "../../packages/polyfill-connectors/src/observation.ts";
import { ${recordFn} } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ${typeName} } from "./types.ts";

// Declared diagnostic_descriptors ids (manifest.json) — the step/expectation
// pair each waitForElementExpectation call below cites. Keep these in
// lockstep with manifest.json's diagnostic_descriptors if you rename either.
const SIGN_IN_STEP = "sign_in";
const SESSION_CHECK_EXPECTATION = "session_check";
const LIST_ROWS_STEP = "list_rows";
const ROWS_CONTAINER_EXPECTATION = "rows_container";
const ELEMENT_WAIT_TIMEOUT_MS = 8_000;

// ─── Placeholder config: fails loudly, never silently ───────────────────
//
// These two constants ARE the connector's declared "am I logged in" check.
// A literal "TODO:" value can never be a real URL or selector, so
// requireConfigured() throws a clear, named error the first time either is
// actually read — instead of this scaffold silently probing a URL that was
// never real. Same posture as dlt's "Please set me up!": a config value
// that cannot be skimmed past.
const LOGIN_CHECK_URL =
  "TODO: set the URL only a signed-in ${displayName} session can load (e.g. https://app.example.com/account)";
const LOGIN_CHECK_SELECTOR =
  "TODO: set a CSS selector only present once signed in (e.g. [data-testid='account-menu'])";

const PLACEHOLDER_RE = /^TODO:/;

function requireConfigured(value: string, fieldName: string): string {
  if (PLACEHOLDER_RE.test(value)) {
    throw new Error(
      \`${name}_not_configured: \${fieldName} in connectors/${name}/index.ts is still a placeholder ("\${value}"). Set a real value before running connector-dev.\`,
    );
  }
  return value;
}

// "am I logged in" check, routed through waitForElementExpectation (step
// SIGN_IN_STEP, expectation SESSION_CHECK_EXPECTATION) instead of a raw
// page.waitForSelector, so a missed check becomes a diagnosable
// element_expectation fact (absent/hidden/disabled/ambiguous at the
// deadline) rather than a bare timeout. Returning false here is the
// EXPECTED branch on a cold profile (not yet signed in) and routes to
// manualBrowserLogin below — it does not, by itself, fail the run.
async function probeLoggedIn(
  page: BrowserCollectContext["page"],
): Promise<boolean> {
  const url = requireConfigured(LOGIN_CHECK_URL, "LOGIN_CHECK_URL");
  const selector = requireConfigured(LOGIN_CHECK_SELECTOR, "LOGIN_CHECK_SELECTOR");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const wait = await waitForElementExpectation({
    expectation: SESSION_CHECK_EXPECTATION,
    locator: page.locator(selector),
    require: "visible",
    sleep: (ms) => page.waitForTimeout(ms),
    step: SIGN_IN_STEP,
    timeoutMs: ELEMENT_WAIT_TIMEOUT_MS,
  });
  return wait.final === "matched";
}

// Session-only cookies (no Expires/Max-Age) do not survive Chromium's clean
// exit, even inside the persistent profile acquireIsolatedBrowser keeps at
// ~/.pdpp/profiles/${name}/ — only cookies with an expiry do. If this
// connector reports "signed out" on EVERY run despite a real prior sign-in
// (never just the first cold run), check the ${displayName} auth cookie's
// Expires/Max-Age in devtools; a session-only cookie is the likely cause,
// not a selector or credential problem. There is no shared long-lived
// browser daemon to opt into — it was retired 2026-04-25 because no
// production runtime used it (docs/connector-authoring-guide.md §0, §5).
// The fleet's actual answer for this shape (USAA) is to accept re-auth via
// ensureSession on every run; the runtime schedules runs per connector well
// outside any in-memory cookie window, so a daemon would not buy anything
// here either. Do not build connector-local persistence to work around
// this — accept the re-auth cost, as ensureSession below already does.
async function ensureSession({
  page,
  sendInteraction,
}: Pick<EnsureSessionArgs, "page" | "sendInteraction">): Promise<void> {
  if (await probeLoggedIn(page)) return;
  // manualBrowserLogin's SIMPLE form: pass only page/probe/sendInteraction
  // (no assist/completeAssistance/readinessProbe) so it emits a real
  // "manual_action" INTERACTION via sendInteraction and re-probes once that
  // resolves — exactly what bin/connector-dev.ts answers via --answer (or
  // its TTY/file-drop fallback) and what capabilities.human_interaction:
  // ["manual_action"] (manifest.json) declares. Every shipped *_browser
  // connector instead passes assist/completeAssistance/readinessProbe +
  // readinessProbeOnHandoffPage: true, which polls the live page directly
  // and needs the reference server's streaming-companion wiring to show
  // that page to an owner — infrastructure a brand-new scaffold run
  // (connector-dev, no reference server) does not have. Switch to that
  // richer form once this connector is wired into a deployment that has it.
  const ready = await manualBrowserLogin({
    message:
      "Sign in to ${displayName} in the secure browser, then continue. PDPP will verify the session before collecting.",
    page,
    probe: () => probeLoggedIn(page),
    reason: "login",
    sendInteraction,
    timeoutSeconds: 30 * 60,
  });
  if (!ready) {
    throw new Error("${name}_session_missing");
  }
}

// TODO: replace LISTING_URL/ROWS_CONTAINER_SELECTOR/ROW_SELECTOR and the
// extraction below with the real ${displayName} listing page and row shape
// for "${stream}" — this is the one thing a new browser connector has to
// write. Prefer structure over text (docs/connector-authoring-guide.md §2):
// read attributes/ARIA, not regexed innerText. See
// connectors/github_browser/collector.ts for a real example of this same
// extract-then-emitRecord shape.
const LISTING_URL = "https://example.invalid/TODO-${name}-${stream}";
// The element that wraps every row, present even when the list is
// genuinely empty (an ancestor of ROW_SELECTOR, never the rows themselves).
// Waiting on THIS, not on individual rows, is what makes "0 rows" and
// "broken selector" distinguishable — see the comment on extractRows below.
const ROWS_CONTAINER_SELECTOR = "TODO-rows-container-selector";
const ROW_SELECTOR = "TODO-row-selector";

// Waits for ROWS_CONTAINER_SELECTOR (step LIST_ROWS_STEP, expectation
// ROWS_CONTAINER_EXPECTATION) before reading rows out of it. This is the
// fix for a known scaffold failure mode: reading ROW_SELECTOR directly
// against the page, with no wait, turns a renamed/removed/hidden container
// into a silent "0 records, succeeded" run — indistinguishable from a
// genuinely empty list. Waiting on the CONTAINER first keeps both outcomes
// honest: container absent/hidden -> the run fails with an
// expectation_mismatch fact citing "rows_container"; container present
// with zero matching rows -> 0 records, success, exactly as it should.
async function extractRows(
  page: BrowserCollectContext["page"],
): Promise<${typeName}[]> {
  await page.goto(LISTING_URL, { waitUntil: "domcontentloaded" });
  const containerWait = await waitForElementExpectation({
    expectation: ROWS_CONTAINER_EXPECTATION,
    locator: page.locator(ROWS_CONTAINER_SELECTOR),
    require: "visible",
    sleep: (ms) => page.waitForTimeout(ms),
    step: LIST_ROWS_STEP,
    timeoutMs: ELEMENT_WAIT_TIMEOUT_MS,
  });
  if (!containerWait.match) {
    throw withObservationBasis(
      new Error("${name}_rows_container_missing"),
      containerWait.observationIds,
    );
  }
  return await containerWait.match
    .locator(ROW_SELECTOR)
    .evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.getAttribute("data-id") ?? "",
        created_at: element.getAttribute("data-created-at") ?? "",
        title: element.textContent?.trim() ?? null,
      })),
    );
}

export async function collect({
  emitRecord,
  page,
  progress,
  requested,
}: Pick<
  BrowserCollectContext,
  "emitRecord" | "page" | "progress" | "requested"
>): Promise<void> {
  if (!requested.has("${stream}")) {
    return;
  }
  await progress("Collecting ${stream}");
  const rows = await extractRows(page);
  for (const row of rows) {
    await emitRecord("${stream}", ${recordFn}(row));
  }
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "${name}",
    validateRecord,
    browser: { profileName: "${name}" },
    ensureSession,
    probeSession: ({ page }) => probeLoggedIn(page),
    probeSessionIsAuthoritative: true,
    // CAUTION: matches manifest.json's protocol_capabilities, declaring the
    // Collection Profile 0.2.0 OBSERVATION capability (§3.4, §5.10) this
    // scaffold's probeLoggedIn/extractRows rely on for expectation_mismatch
    // diagnosis. connector-dev.ts (0.2.0-aware) supports this today. The
    // production runtime, data-connect, does not yet understand protocol
    // 0.2.0 and currently REJECTS a connector manifest that declares a
    // capability it does not recognize — so do not point data-connect at
    // this manifest until it ships 0.2.0 support. This scaffold's
    // public_listing.tier is "development", which scripts/
    // connector-publish-allowlist.mjs's CONNECTOR_PUBLISH_INVENTORY does
    // not include by default (it is an opt-in allowlist, not a tier
    // filter) — confirm "${name}" has no entry there before adding one.
    protocolCapabilities: ["OBSERVATION"],
    collect,
  });
}
`;
}

function buildSchemasTs(name: string, stream: string): string {
	const schemaVar = `${camelCase(stream)}Schema`;
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for ${name} stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3. Mirrors manifests/${name}.json's
 * "${stream}" stream schema exactly — see src/manifest-reconcile.ts (run
 * via bin/reconcile-manifests.test.ts) for the drift check across
 * manifest / SCHEMAS registry / emitted-stream literals.
 *
 * TODO: as the real upstream shape lands in parsers.ts's record builder,
 * widen these fields (and manifests/${name}.json's schema in lockstep) to
 * match the real payload instead of this placeholder id/created_at/title
 * shape.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const ISO_DT_RE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}/;

/**
 * ${stream} stream: one record per ${name} ${stream} item.
 * Cursor: last_created_at (derived from created_at).
 */
export const ${schemaVar} = z.object({
  id: z.string().min(1),
  created_at: z.string().regex(ISO_DT_RE, "created_at must be an ISO-8601 datetime"),
  title: pdppSafeText.max(2000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  ${stream}: ${schemaVar},
};

export const validateRecord = makeValidateRecord(SCHEMAS);
`;
}

function buildPilotFixtureTestTs(name: string): string {
	return `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({ connector: "${name}", validateRecord });
`;
}

function buildFixtureJsonl(name: string): string {
	const record = {
		id: "1",
		created_at: "2026-01-15T09:30:00Z",
		title: `Example ${name} item`,
	};
	return `${JSON.stringify(record)}\n`;
}

function buildProvenanceJson(): string {
	const today = new Date().toISOString().slice(0, 10);
	const provenance = {
		format: "pdpp.fixture-provenance/1",
		class: "synthetic",
		labeled_by: "tool:connector-init/1",
		labeled_at: today,
	};
	return `${JSON.stringify(provenance, null, 2)}\n`;
}

// ─── Small string helpers (no deps) ─────────────────────────────────────

const WORD_SPLIT_RE = /[_-]+/;

function pascalCase(input: string): string {
	return input
		.split(WORD_SPLIT_RE)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function camelCase(input: string): string {
	const pascal = pascalCase(input);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ─── Writer ──────────────────────────────────────────────────────────────

export function writeScaffold(args: InitArgs): TargetPlan {
	const { name, displayName, stream, browser } = args;
	const plan = planTargets(name, stream);

	mkdirSync(plan.connectorDir, { recursive: true });
	mkdirSync(plan.fixtureRecordsDir, { recursive: true });

	writeFileSync(
		plan.files.manifestJson,
		browser
			? buildBrowserManifest(name, displayName, stream)
			: buildManifest(name, displayName, stream),
	);
	writeFileSync(
		plan.files.typesTs,
		browser
			? buildBrowserTypesTs(displayName, stream)
			: buildTypesTs(displayName, stream),
	);
	writeFileSync(
		plan.files.parsersTs,
		browser
			? buildBrowserParsersTs(name, stream)
			: buildParsersTs(name, stream),
	);
	writeFileSync(
		plan.files.indexTs,
		browser
			? buildBrowserIndexTs(name, displayName, stream)
			: buildIndexTs(name, stream),
	);
	writeFileSync(plan.files.schemasTs, buildSchemasTs(name, stream));
	writeFileSync(plan.files.pilotFixtureTestTs, buildPilotFixtureTestTs(name));
	writeFileSync(plan.files.fixtureJsonl, buildFixtureJsonl(name));
	writeFileSync(plan.files.provenanceJson, buildProvenanceJson());

	return plan;
}

export type { InitArgs, TargetPlan };
export { findCollisions, parseArgs, planTargets };

// ─── CLI entry point ─────────────────────────────────────────────────────

function printNextSteps(name: string, stream: string): void {
	console.log(`
Scaffolded connector "${name}" (stream: "${stream}").

Next steps:
  1. Read docs/connector-authoring-guide.md — the authoring conventions
     (source-of-truth ranking, fail-loud schema discipline, naming, cursor
     discipline) every connector in this fleet follows.
  2. Edit connectors/${name}/index.ts: replace the TODO endpoint (API_URL,
     auth header shape, response envelope) with the real upstream call.
  3. Widen connectors/${name}/types.ts, parsers.ts, and schemas.ts (in
     lockstep with manifests/${name}.json's stream schema) to match the
     real payload shape as you discover it.
  4. Run the connector against the real API and watch it live:
       node --import tsx bin/connector-dev.ts ${name}
  5. Capture a real run, then replay it strictly offline to prove the
     connector against fixed evidence:
       node --import tsx bin/scenario-record.ts ${name}
       node --import tsx bin/scenario-verify.ts ${name}
     Scrub the capture (see bin/scrub-fixtures.ts) before committing
     anything under fixtures/${name}/scrubbed/, and replace this
     scaffold's synthetic pilot-real-shape fixture with a scrubbed real
     one once you have it.
  6. Run the test suite for this connector:
       node --test --import tsx "connectors/${name}/**/*.test.ts"
  7. connector-dev, scenario-record, register-all, and orchestrate all
     resolve this connector automatically — they discover it from
     connectors/${name}/manifest.json (src/orchestrator.ts's
     getConnectorPaths), so no hand-registration step is needed. If the
     reference implementation should offer it to owners, add the
     canonical-key / setup-planner / console wiring (see
     docs/whoop-connector-learnings.md for the checklist a real
     first-time contribution surfaced).
`);
}

/**
 * Browser-mode next steps: deliberately just the three commands/pointers
 * the task of getting a browser connector running actually needs — doctor
 * first (so a missing Chromium revision or an unwritable profile dir is a
 * clear message, not a confusing mid-run failure), then connector-dev (which
 * drives the session check and manual-login handoff this scaffold already
 * wires up), then where the one real TODO lives.
 */
function printBrowserNextSteps(name: string, stream: string): void {
	console.log(`
Scaffolded browser connector "${name}" (stream: "${stream}").

Next commands:
  1. node --import tsx bin/connector-doctor.ts
       Checks Node, dependencies, the Patchright Chromium revision, display
       availability, .env.local location, and ~/.pdpp/profiles — before you
       drive a real browser.
  2. node --import tsx bin/connector-dev.ts ${name}
       Launches the browser, runs the session check, and hands you the
       manual-login window if the ${name} profile isn't signed in yet.
       "${name}" is already resolvable — connector-dev/orchestrate discover
       it from connectors/${name}/manifest.json, no registration step needed.
  3. The one TODO is extractRows() in connectors/${name}/index.ts — replace
     LISTING_URL/ROWS_CONTAINER_SELECTOR/ROW_SELECTOR and the extraction
     with real navigation for the "${stream}" stream. LOGIN_CHECK_URL/
     LOGIN_CHECK_SELECTOR just above it need a real value too (all four
     fail loudly if left as-is — a missing/hidden rows container now fails
     the run with an "expectation_mismatch" diagnosis instead of silently
     succeeding with 0 records).

Widen connectors/${name}/types.ts, parsers.ts, and schemas.ts (in lockstep
with manifests/${name}.json's stream schema) to match the real row shape as
you discover it. See docs/connector-authoring-guide.md §0 ("Browser
architecture") and connectors/github_browser/ for the fuller reference this
scaffold follows.

CAUTION: this manifest declares protocol_version 0.2.0 and the OBSERVATION
capability so connector-dev's diagnosis works. data-connect (the production
runtime) does not support 0.2.0 yet and rejects a manifest declaring a
capability it doesn't know — keep this connector on connector-dev until
that lands. It also stays out of scripts/connector-publish-allowlist.mjs's
CONNECTOR_PUBLISH_INVENTORY (an opt-in allowlist) unless someone adds it.
`);
}

function main(): void {
	let args: InitArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (err) {
		if (err instanceof InitArgsError) {
			console.error(err.message);
			process.exit(2);
		}
		throw err;
	}
	const plan = planTargets(args.name, args.stream);
	const collisions = findCollisions(plan);
	if (collisions.length > 0) {
		console.error(
			`connector-init: refusing to overwrite existing path(s):\n${collisions.map((p) => `  ${p}`).join("\n")}`,
		);
		process.exit(1);
	}
	writeScaffold(args);
	if (args.browser) {
		printBrowserNextSteps(args.name, args.stream);
	} else {
		printNextSteps(args.name, args.stream);
	}
}

if (isMainModule(import.meta.url)) {
	main();
}
