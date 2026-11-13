// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import type { kindleHighlightsSchema } from "./schemas.ts";
/** Record emitted by the single Readwise stream. */
export type KindleHighlight = z.infer<typeof kindleHighlightsSchema>;
