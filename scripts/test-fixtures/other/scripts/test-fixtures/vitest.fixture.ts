import { appendFileSync } from "node:fs";
import { it } from "vitest";

it("same-suffix decoy stays out of selected runs", () => {
	if (process.env.TEST_DISPATCH_MARKERS) {
		appendFileSync(process.env.TEST_DISPATCH_MARKERS, "decoy\n");
	}
});
