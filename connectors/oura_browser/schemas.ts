// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z, type z as Zod } from "zod";
import { sleepSchema } from "../oura/schemas.ts";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";
import { activitySchema, readinessSchema } from "../oura/schemas.ts";

const browserSleepSchema = sleepSchema.extend({
	record_type: z.enum(["sleep_session", "daily_score"]),
	awake_time: z.number().nullable(),
	daily_sleep_id: z.string().uuid().nullable(),
	daily_sleep_timestamp: z.string().datetime({ offset: true }).nullable(),
});

export const SCHEMAS: Record<string, Zod.ZodTypeAny> = {
	sleep: browserSleepSchema,
	readiness: readinessSchema,
	activity: activitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
