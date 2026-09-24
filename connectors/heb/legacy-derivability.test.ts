// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TEST-ONLY derivability proof for heb.profile and heb.nutrition.
 *
 * This file maps PDPP `profile`/`nutrition` records into the exact frozen
 * legacy payload shapes (connectors/heb/schemas/heb.profile.json,
 * connectors/heb/schemas/heb.nutrition.json) and validates the result against
 * those schemas. It ships NO projection module in src/ or the connector —
 * Vana owns the product projection (docs/migration/connector-cutover/
 * CONTRACTS.md "Ownership boundary"). The mapping functions below exist only
 * to prove derivability; they are not exported and must never be imported by
 * connector or runtime code.
 *
 * SYNTHETIC: records are hand-authored, shape-derived from parsers.ts output
 * (see schemas.test.ts's PROFILE_RECORD/NUTRITION_RECORD) — no real H-E-B
 * capture has driven this connector yet (live proof pending — see report).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { NutritionRecord, ProfileRecord } from "./types.ts";

// ─── Minimal JSON Schema validator ─────────────────────────────────────────
//
// Just enough of the Draft-07-ish vocabulary the two frozen legacy schema
// files actually use (type, properties, items, required, enum, oneOf,
// additionalProperties-as-a-schema). Not a general-purpose validator: ajv is
// not a dependency of this package, and this proof needs only the subset
// below. A validation failure returns a list of "<path>: <reason>" strings;
// an empty list means valid.

type JsonSchema = Record<string, unknown>;

function typeOf(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value === "number" ? "number" : typeof value;
}

function validateAgainst(
	schema: JsonSchema,
	value: unknown,
	path: string,
): string[] {
	const errors: string[] = [];

	const typeConstraint = schema.type;
	if (typeConstraint !== undefined) {
		const allowed = Array.isArray(typeConstraint)
			? typeConstraint
			: [typeConstraint];
		if (!allowed.includes(typeOf(value))) {
			errors.push(
				`${path}: expected type ${allowed.join("|")}, got ${typeOf(value)}`,
			);
			return errors;
		}
	}

	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
		errors.push(`${path}: value not in enum ${JSON.stringify(schema.enum)}`);
	}

	if (Array.isArray(schema.oneOf)) {
		const branchResults = (schema.oneOf as JsonSchema[]).map((branch) =>
			validateAgainst(branch, value, path),
		);
		if (!branchResults.some((r) => r.length === 0)) {
			errors.push(
				`${path}: matched none of ${branchResults.length} oneOf branches (${branchResults.map((r) => r.join("; ")).join(" | ")})`,
			);
		}
	}

	if (typeOf(value) === "object" && value !== null) {
		const obj = value as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
		for (const key of (schema.required as string[] | undefined) ?? []) {
			if (!(key in obj)) {
				errors.push(`${path}.${key}: required property missing`);
			}
		}
		for (const [key, propSchema] of Object.entries(properties)) {
			if (key in obj) {
				errors.push(...validateAgainst(propSchema, obj[key], `${path}.${key}`));
			}
		}
		if (
			schema.additionalProperties &&
			typeof schema.additionalProperties === "object"
		) {
			const definedKeys = new Set(Object.keys(properties));
			for (const [key, v] of Object.entries(obj)) {
				if (!definedKeys.has(key)) {
					errors.push(
						...validateAgainst(
							schema.additionalProperties as JsonSchema,
							v,
							`${path}.${key}`,
						),
					);
				}
			}
		}
	}

	if (typeOf(value) === "array" && schema.items) {
		(value as unknown[]).forEach((item, i) => {
			errors.push(
				...validateAgainst(schema.items as JsonSchema, item, `${path}[${i}]`),
			);
		});
	}

	return errors;
}

function loadLegacySchema(name: string): JsonSchema {
	const url = new URL(`./schemas/${name}`, import.meta.url);
	const contract = JSON.parse(readFileSync(url, "utf8")) as {
		schema: JsonSchema;
	};
	return contract.schema;
}

const LEGACY_PROFILE_SCHEMA = loadLegacySchema("heb.profile.json");
const LEGACY_NUTRITION_SCHEMA = loadLegacySchema("heb.nutrition.json");

// ─── PDPP -> legacy mapping (test-only; not exported) ──────────────────────

function toLegacyProfile(record: ProfileRecord): unknown {
	return {
		name: record.name,
		email: record.email,
		phone: record.phone,
		deliveryAddresses: record.delivery_addresses.map((a) => ({
			address: a.address,
			label: a.label,
			isPrimary: a.is_primary,
		})),
	};
}

function toLegacyNutritionItem(record: NutritionRecord): unknown {
	return {
		name: record.name,
		product_url: record.product_url,
		source: record.source,
		confidence: record.confidence,
		calories: record.calories,
		protein_g: record.protein_g,
		carbs_g: record.carbs_g,
		fat_g: record.fat_g,
		sodium_mg: record.sodium_mg,
		fiber_g: record.fiber_g,
		sugar_g: record.sugar_g,
		saturated_fat_g: record.saturated_fat_g,
		trans_fat_g: record.trans_fat_g,
		cholesterol_mg: record.cholesterol_mg,
		added_sugar_g: record.added_sugar_g,
		calcium_mg: record.calcium_mg,
		iron_mg: record.iron_mg,
		potassium_mg: record.potassium_mg,
		vitamin_d_mcg: record.vitamin_d_mcg,
		servingSize: record.serving_size,
		servingsPerContainer: record.servings_per_container,
		upc: record.upc,
		ingredients: record.ingredients,
		allergens: record.allergens,
		category: record.category,
		highlights: record.highlights,
		images: record.images,
	};
}

/** D3: envelope counters (`coverage`) are run evidence, not a PDPP record —
 *  derived here from the record set only to prove the full legacy envelope
 *  (including `coverage`) is reconstructable, not to claim `coverage` is
 *  itself a PDPP-modeled field. */
function toLegacyNutritionEnvelope(
	records: readonly NutritionRecord[],
): unknown {
	const items: Record<string, unknown> = {};
	for (const record of records) {
		items[record.product_id] = toLegacyNutritionItem(record);
	}
	const found = records.filter((r) => r.source === "heb_product_page").length;
	const foundUSDA = records.filter((r) => r.source === "usda_fdc").length;
	const blocked = records.filter((r) => r.source === "blocked").length;
	const total = records.length;
	return {
		items,
		coverage: {
			total,
			found,
			foundUSDA,
			blocked,
			percentCovered:
				total > 0 ? Math.round(((found + foundUSDA) / total) * 100) : 0,
		},
	};
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const PROFILE_RECORD: ProfileRecord = {
	delivery_addresses: [
		{
			address: "123 Fictional Ave, Austin, TX 78701",
			is_primary: true,
			label: "Home",
		},
		{
			address: "456 Fictional Blvd, Austin, TX 78702",
			is_primary: false,
			label: null,
		},
	],
	email: "shopper@example.com",
	fetched_at: "2026-07-14T12:00:00.000Z",
	id: "profile",
	name: "Jamie Shopper",
	phone: "(512) 555-0100",
};

const NUTRITION_RECORD_FOUND: NutritionRecord = {
	added_sugar_g: 0,
	allergens: "Milk",
	calcium_mg: 300,
	calories: 150,
	carbs_g: 12,
	category: "Dairy & Eggs / Milk",
	cholesterol_mg: 20,
	confidence: "high",
	fat_g: 8,
	fetched_at: "2026-07-14T12:00:00.000Z",
	fiber_g: 0,
	highlights: ["Organic"],
	id: "123456789",
	images: {
		full: "https://images.heb.com/is/image/HEBGrocery/123456789-1",
		thumbnail:
			"https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg",
	},
	ingredients: "Grade A organic reduced fat milk, vitamin D3",
	iron_mg: 0,
	name: "H-E-B Organic 2% Reduced Fat Milk",
	potassium_mg: 380,
	product_id: "123456789",
	product_url:
		"https://www.heb.com/product-detail/heb-organic-2-reduced-fat-milk/123456789",
	protein_g: 8,
	saturated_fat_g: 5,
	serving_size: "1 cup (240mL)",
	servings_per_container: "8",
	sodium_mg: 120,
	source: "heb_product_page",
	sugar_g: 12,
	trans_fat_g: 0,
	upc: "072940001234",
	vitamin_d_mcg: 3,
};

const NUTRITION_RECORD_NOT_FOUND: NutritionRecord = {
	added_sugar_g: null,
	allergens: null,
	calcium_mg: null,
	calories: null,
	carbs_g: null,
	category: null,
	cholesterol_mg: null,
	confidence: "low",
	fat_g: null,
	fetched_at: "2026-07-14T12:00:00.000Z",
	fiber_g: null,
	highlights: null,
	id: "999",
	images: {
		full: "https://images.heb.com/is/image/HEBGrocery/999-1",
		thumbnail:
			"https://images.heb.com/is/image/HEBGrocery/prd-small/000000999.jpg",
	},
	ingredients: null,
	iron_mg: null,
	name: "Unlabeled Fallback Item",
	potassium_mg: null,
	product_id: "999",
	product_url: "https://www.heb.com/product-detail/unlabeled-item/999",
	protein_g: null,
	saturated_fat_g: null,
	serving_size: null,
	servings_per_container: null,
	sodium_mg: null,
	source: "not_found",
	sugar_g: null,
	trans_fat_g: null,
	upc: null,
	vitamin_d_mcg: null,
};

// ─── Tests ──────────────────────────────────────────────────────────────────

test("PDPP profile record maps to a legacy heb.profile payload that validates against the frozen legacy schema", () => {
	const legacyPayload = toLegacyProfile(PROFILE_RECORD);
	const errors = validateAgainst(LEGACY_PROFILE_SCHEMA, legacyPayload, "$");
	assert.deepEqual(errors, []);
});

test("PDPP profile record with null phone and empty delivery_addresses still validates (both fields are optional-shaped in legacy)", () => {
	const legacyPayload = toLegacyProfile({
		...PROFILE_RECORD,
		delivery_addresses: [],
		phone: null,
	});
	const errors = validateAgainst(LEGACY_PROFILE_SCHEMA, legacyPayload, "$");
	assert.deepEqual(errors, []);
});

test("negative control: an address that is not a string (wrong type) fails legacy validation", () => {
	const legacyPayload = toLegacyProfile(PROFILE_RECORD) as {
		deliveryAddresses: Array<Record<string, unknown>>;
	};
	const address = legacyPayload.deliveryAddresses[0];
	if (address) {
		address.address = 12345;
	}
	const errors = validateAgainst(LEGACY_PROFILE_SCHEMA, legacyPayload, "$");
	assert.ok(
		errors.some((e) => e.includes("address")),
		`expected an 'address' validation error, got: ${JSON.stringify(errors)}`,
	);
});

test("PDPP nutrition records map to a legacy heb.nutrition envelope (items + coverage) that validates against the frozen legacy schema", () => {
	const legacyPayload = toLegacyNutritionEnvelope([
		NUTRITION_RECORD_FOUND,
		NUTRITION_RECORD_NOT_FOUND,
		{ ...NUTRITION_RECORD_NOT_FOUND, source: "blocked" },
	]);
	const errors = validateAgainst(LEGACY_NUTRITION_SCHEMA, legacyPayload, "$");
	assert.deepEqual(errors, []);
});

test("legacy heb.nutrition envelope carries the derived images field with both thumbnail and full CDN URLs", () => {
	const legacyPayload = toLegacyNutritionEnvelope([NUTRITION_RECORD_FOUND]) as {
		items: Record<string, { images: unknown }>;
	};
	assert.deepEqual(legacyPayload.items["123456789"]?.images, {
		full: "https://images.heb.com/is/image/HEBGrocery/123456789-1",
		thumbnail:
			"https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg",
	});
});

test("legacy heb.nutrition envelope's coverage counters are reconstructable run evidence, not a PDPP record (D3)", () => {
	const legacyPayload = toLegacyNutritionEnvelope([
		NUTRITION_RECORD_FOUND,
		NUTRITION_RECORD_NOT_FOUND,
		{ ...NUTRITION_RECORD_NOT_FOUND, source: "blocked" },
	]) as {
		coverage: {
			total: number;
			found: number;
			foundUSDA: number;
			blocked: number;
			percentCovered: number;
		};
	};
	assert.deepEqual(legacyPayload.coverage, {
		total: 3,
		found: 1,
		foundUSDA: 0,
		blocked: 1,
		percentCovered: 33,
	});
});

test("negative control: dropping the top-level required 'coverage' envelope field fails legacy validation", () => {
	const legacyPayload = toLegacyNutritionEnvelope([
		NUTRITION_RECORD_FOUND,
	]) as Record<string, unknown>;
	delete legacyPayload.coverage;
	const errors = validateAgainst(LEGACY_NUTRITION_SCHEMA, legacyPayload, "$");
	assert.ok(
		errors.some((e) => e.includes("coverage")),
		`expected a 'coverage' validation error, got: ${JSON.stringify(errors)}`,
	);
});

test("negative control: dropping the required 'source' field from a nutrition item fails legacy validation", () => {
	const legacyPayload = toLegacyNutritionEnvelope([NUTRITION_RECORD_FOUND]) as {
		items: Record<string, Record<string, unknown>>;
	};
	delete legacyPayload.items["123456789"]?.source;
	const errors = validateAgainst(LEGACY_NUTRITION_SCHEMA, legacyPayload, "$");
	assert.ok(
		errors.some((e) => e.includes("source")),
		`expected a 'source' validation error, got: ${JSON.stringify(errors)}`,
	);
});

test("negative control: an unknown nutrition source value fails the legacy enum constraint", () => {
	const legacyPayload = toLegacyNutritionEnvelope([NUTRITION_RECORD_FOUND]) as {
		items: Record<string, Record<string, unknown>>;
	};
	const item = legacyPayload.items["123456789"];
	if (item) {
		item.source = "guessed";
	}
	const errors = validateAgainst(LEGACY_NUTRITION_SCHEMA, legacyPayload, "$");
	assert.ok(
		errors.some((e) => e.includes("enum")),
		`expected an enum validation error, got: ${JSON.stringify(errors)}`,
	);
});
