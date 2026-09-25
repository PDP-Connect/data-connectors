// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";

const source = new URL("../schemas/source-declaration.schema.json", import.meta.url);
const destination = new URL(
	"../packages/connector-installer-core/source-declaration-schema-data.mjs",
	import.meta.url,
);
const schema = JSON.parse(readFileSync(source, "utf8"));
const generated = [
	"// Copyright The PDP-Connect Contributors",
	"// SPDX-License-Identifier: Apache-2.0",
	"// Generated from schemas/source-declaration.schema.json; run npm run source-declaration-schema:generate.",
	"",
	`export default ${JSON.stringify(schema, null, 2)};`,
	"",
].join("\n");

if (process.argv.includes("--check")) {
	if (readFileSync(destination, "utf8") !== generated) {
		throw new Error("SourceDeclaration schema module is stale; run npm run source-declaration-schema:generate");
	}
} else {
	writeFileSync(destination, generated);
}
