// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read connector operator-options in a forward-compatible way.
 *
 * A value comes from `START.connector_options` (owner-confirmed by the
 * runtime, declared in the manifest's `options_schema`) when present, else from
 * `process.env` under a connector-specific prefix, else from the default. The
 * env fallback keeps deployments that set a variable working; new tuning goes
 * through the manifest.
 *
 * Credentials vs. options:
 *   - Credentials (tokens, passwords, cookies) belong in the credential vault
 *     path — use `requireCredentialsOrAsk` from scope-filters.js.
 *   - Options are operator tuning knobs (lookback window, allowlists, skip
 *     toggles). They are not secrets and should be declarable in the manifest.
 */

const BOOL_TRUE = /^(1|true|yes|on)$/i;

export type OptionParseKind = "int" | "bool" | "csv" | "string";

export interface OptionFieldSpec {
	default: unknown;
	parse: OptionParseKind;
}

export interface OptionsSpec {
	envPrefix: string;
	fields: Record<string, OptionFieldSpec>;
}

export interface StartMessageWithOptions {
	connector_options?: Record<string, unknown> | undefined;
}

/**
 * Read options for a connector. Example spec:
 *
 *   {
 *     envPrefix: 'SLACK_',
 *     fields: {
 *       LOOKBACK_DAYS: { parse: 'int', default: 7 },
 *       CHANNEL_ALLOWLIST: { parse: 'csv', default: [] },
 *       SKIP_FILES: { parse: 'bool', default: false },
 *       CHANNEL_TYPES: { parse: 'csv', default: ['public', 'private', 'im', 'mpim'] },
 *     },
 *   }
 */
export function readOptions(
	startMsg: StartMessageWithOptions | null | undefined,
	spec: OptionsSpec,
): Record<string, unknown> {
	const fromStart: Record<string, unknown> = startMsg?.connector_options ?? {};
	const out: Record<string, unknown> = {};
	for (const [name, def] of Object.entries(spec.fields)) {
		const envKey = `${spec.envPrefix}${name}`;
		let raw: unknown;
		if (Object.hasOwn(fromStart, name)) {
			raw = fromStart[name];
		} else if (process.env[envKey] === undefined) {
			out[name] = def.default;
			continue;
		} else {
			raw = process.env[envKey];
		}
		out[name] = coerce(raw, def.parse, def.default);
	}
	return out;
}

/**
 * For a connector whose existing resolvers already parse and bound env-shaped
 * strings: `process.env` with each named option overlaid by its effective
 * value (START first, then env, through `readOptions`). The resolvers keep
 * their own validation, so a bad owner value is ignored exactly as a bad
 * env value is. Pass the result wherever a resolver takes `env`.
 */
export function readOptionsAsEnv(
	startMsg: StartMessageWithOptions | null | undefined,
	envPrefix: string,
	names: readonly string[],
): NodeJS.ProcessEnv {
	const fields: Record<string, OptionFieldSpec> = {};
	for (const name of names) {
		fields[name] = { default: undefined, parse: "string" };
	}
	const effective = readOptions(startMsg, { envPrefix, fields });
	const overlay: NodeJS.ProcessEnv = { ...process.env };
	for (const name of names) {
		const value = effective[name];
		if (value !== undefined) {
			overlay[`${envPrefix}${name}`] = String(value);
		}
	}
	return overlay;
}

function coerce(
	raw: unknown,
	parse: OptionParseKind,
	fallback: unknown,
): unknown {
	if (raw === null || raw === undefined) {
		return fallback;
	}
	switch (parse) {
		case "int": {
			const n = Number.parseInt(String(raw), 10);
			return Number.isFinite(n) ? n : fallback;
		}
		case "bool": {
			if (typeof raw === "boolean") {
				return raw;
			}
			return BOOL_TRUE.test(String(raw).trim());
		}
		case "csv": {
			const items = Array.isArray(raw)
				? raw.map(String)
				: String(raw).split(",");
			return items.map((s) => s.trim()).filter(Boolean);
		}
		default:
			return String(raw);
	}
}
