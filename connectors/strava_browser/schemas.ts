// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Strava source's record contracts. The browser profile emits exactly
 * what the export profile does, so it registers the export profile's Zod
 * schemas rather than restating them. The published stream contracts are
 * asserted identical in
 * packages/connector-installer-core/source-declaration.test.mjs.
 */

import type { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";
import {
	activitiesSchema,
	coverageDiagnosticsSchema,
} from "../strava/schemas.ts";

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	activities: activitiesSchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
