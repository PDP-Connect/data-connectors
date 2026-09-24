// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";
import {
	activitySchema,
	readinessSchema,
	sleepSchema,
} from "../oura/schemas.ts";

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	sleep: sleepSchema,
	readiness: readinessSchema,
	activity: activitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
