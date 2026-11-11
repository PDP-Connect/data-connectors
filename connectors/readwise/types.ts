import type { z } from "zod";
import type { kindleHighlightsSchema } from "./schemas.ts";
/** Record emitted by the single Readwise stream. */
export type KindleHighlight = z.infer<typeof kindleHighlightsSchema>;
