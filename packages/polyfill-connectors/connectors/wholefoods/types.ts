// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the Whole Foods connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry. Mirrors connectors/amazon/types.ts's split.

/** Amazon account profile, scraped once per run. `email` is always null —
 *  see parsers.ts's parseAmazonProfileDom header comment and the
 *  connector's report CONTRACT-CHANGE-REQUEST for why no safely-reachable
 *  page exposes it. `customerId` is Amazon's stable opaque account id. */
export interface WholeFoodsProfile {
	customerId: string | null;
	name: string | null;
}

/** One order discovered on the Amazon order-search results filtered to
 *  Whole Foods Market. The search page shows items, not orders, so this is
 *  built by deduplicating on `orderId` across every item row. */
export interface OrderStub {
	orderDateRaw: string | null;
	orderId: string;
	orderUrl: string;
}

/** One line item as it appears on the Amazon order-detail page for a Whole
 *  Foods order. */
export interface OrderDetailItem {
	imageUrl: string | null;
	name: string;
	productId: string | null;
	productUrl: string | null;
	quantity: number | null;
	unitPriceDollars: number | null;
}

/** The order-detail page's parsed contents: items plus whatever the detail
 *  page can confirm about the order date (the search page's date text is
 *  looser and the detail page is preferred when both are available). */
export interface OrderDetail {
	items: OrderDetailItem[];
	orderDateRaw: string | null;
}

/** Nutrition facts extracted from either the Whole Foods product page or
 *  the USDA FoodData Central API, normalized to one shape regardless of
 *  source. Fields absent from the source are `null`, never guessed. */
export interface NutritionFacts {
	calories: number | null;
	carbsG: number | null;
	confidence: "high" | "medium" | "low";
	fatG: number | null;
	fiberG: number | null;
	proteinG: number | null;
	servingSize: string | null;
	servingsPerContainer: number | null;
	sodiumMg: number | null;
	source: "usda_fdc" | "wholefoods_product_page";
	sugarG: number | null;
	/** Universal Product Code, when the source page/response exposed one.
	 *  Used to key a UPC-first USDA lookup; not itself part of the emitted
	 *  nutrition record. */
	upc: string | null;
}

/** One USDA FoodData Central search result, trimmed to the fields the
 *  matcher and nutrient mapper use. The real API response has many more
 *  fields; only these are load-bearing. */
export interface UsdaFood {
	brandName: string | null;
	brandOwner: string | null;
	description: string;
	fdcId: number;
	foodNutrients: readonly UsdaFoodNutrient[];
	gtinUpc: string | null;
	servingSize: number | null;
	servingSizeUnit: string | null;
}

export interface UsdaFoodNutrient {
	nutrientId: number;
	value: number;
}

export type UsdaMatchMethod = "text" | "upc";

/** Emitted `profile` stream record shape. */
export interface ProfileRecord {
	email: string | null;
	id: string;
	name: string | null;
	[field: string]: unknown;
}

/** Emitted `orders` stream record shape. */
export interface OrderRecord {
	id: string;
	item_count: number | null;
	order_date: string | null;
	order_url: string | null;
	status: string | null;
	total_cents: number | null;
	[field: string]: unknown;
}

/** Emitted `order_items` stream record shape. */
export interface OrderItemRecord {
	id: string;
	image_url: string | null;
	name: string;
	order_id: string;
	product_id: string | null;
	product_url: string | null;
	quantity: number | null;
	unit_price_cents: number | null;
	[field: string]: unknown;
}

/** Emitted `nutrition` stream record shape. */
export interface NutritionRecord {
	calories: number | null;
	carbs_g: number | null;
	confidence: "high" | "medium" | "low";
	fat_g: number | null;
	fiber_g: number | null;
	name: string | null;
	product_id: string;
	protein_g: number | null;
	serving_size: string | null;
	servings_per_container: number | null;
	sodium_mg: number | null;
	source: "usda_fdc" | "wholefoods_product_page";
	sugar_g: number | null;
	[field: string]: unknown;
}
