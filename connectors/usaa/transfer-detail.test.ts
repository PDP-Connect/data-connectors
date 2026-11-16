// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { hashId, rowsToTransactions } from "./parsers.ts";
import { transactionSchema } from "./schemas.ts";
import { _internals } from "./statement-pdfs.ts";

const keys = ["transfer_direction", "counterparty_name", "counterparty_account_type",
 "counterparty_last4", "transfer_confirmation_number"] as const;
function record(description: string) {
 const rows = rowsToTransactions([
  ["Date", "Description", "Original Description", "Amount"],
  ["2026-04-10", description, "Different original text", "-12.34"],
 ], { accountId: "SYNTHETIC-ACCOUNT", accountName: "Synthetic checking", fetchedAt: "2026-04-10T00:00:00Z" });
 assert.equal(rows.length, 1);
 return rows[0]!;
}
function fields(value: object) {
 const row = value as Record<string, unknown>;
 return Object.fromEntries(keys.map(key => [key, row[key]]));
}
test("CSV carries transfer detail from description without changing identity", () => {
 const row = record("USAA FUNDS TRANSFER DB TO MORGAN FICTION CHECKING #1234, CONF# 7654321");
 assert.deepEqual(fields(row), {
  transfer_direction: "out", counterparty_name: "MORGAN FICTION",
  counterparty_account_type: "CHECKING", counterparty_last4: "1234",
  transfer_confirmation_number: "7654321",
 });
 assert.equal(row.id, hashId("SYNTHETIC-ACCOUNT|2026-04-10|-12.34|Different original text|#0"));
 assert.equal(row.original_description, "Different original text");
 assert.deepEqual(fields(transactionSchema.parse(row)), fields(row), "schema must retain fields, not strip them");
});
test("CSV incoming transfer and non-transfer have explicit nullable fields", () => {
 const incoming = record("USAA FUNDS TRANSFER CR FROM AVERY INVENTED SAVINGS #5678");
 assert.deepEqual(fields(incoming), {
  transfer_direction: "in", counterparty_name: "AVERY INVENTED",
  counterparty_account_type: "SAVINGS", counterparty_last4: "5678",
  transfer_confirmation_number: null,
 });
 const ordinary = record("SYNTHETIC COFFEE");
 assert.deepEqual(fields(ordinary), Object.fromEntries(keys.map(key => [key, null])));
 assert.deepEqual(fields(transactionSchema.parse(ordinary)), fields(ordinary));
});
test("transaction schema rejects invalid transfer direction and non-four-digit last4", () => {
 const base = { ...record("SYNTHETIC COFFEE"), ...Object.fromEntries(keys.map(key => [key, null])) };
 for (const transfer_direction of ["other", 1]) {
  assert.equal(transactionSchema.safeParse({ ...base, transfer_direction }).success, false);
 }
 for (const counterparty_last4 of ["123", "12345", "abcd"]) {
  assert.equal(transactionSchema.safeParse({ ...base, counterparty_last4 }).success, false);
 }
});
test("transactions manifest declares all five nullable transfer fields with descriptions", async () => {
 const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
 assert.equal(manifest.version, "0.2.25");
 const properties = manifest.streams.find((stream: { name: string }) => stream.name === "transactions").schema.properties;
 for (const key of keys) {
  assert.deepEqual(properties[key]?.type, ["string", "null"], key);
  assert.equal(typeof properties[key]?.description, "string", key);
  assert.ok(properties[key].description.trim().length > 0, key);
 }
 assert.deepEqual(properties.transfer_direction.enum, ["out", "in", null]);
 assert.equal(properties.counterparty_last4.pattern, "^[0-9]{4}$");
});

test("statement records carry nullable transfer fields without changing existing fields or ids", () => {
 const descriptions = [
  "USAA FUNDS TRANSFER CR FROM RILEY IMAGINARY SAVINGS #4321, CONF# 1234567",
  "SYNTHETIC BOOKSHOP",
 ];
 const txns = descriptions.map((description, ord) => ({
  description, iso: "2026-04-10", amount: ord === 0 ? 1234 : -500,
  balance: null, tupleKey: `2026-04-10|${ord === 0 ? "12.34" : "-5.00"}|${description}`, ord,
 }));
 const options = { accountId: "SYNTHETIC-ACCOUNT", accountName: "Synthetic checking", period: "2026-04" };
 const rows = _internals.buildStatementRecords(txns, options);
 assert.equal(rows.length, 2);
 assert.deepEqual(fields(rows[0]!), {
  transfer_direction: "in", counterparty_name: "RILEY IMAGINARY",
  counterparty_account_type: "SAVINGS", counterparty_last4: "4321",
  transfer_confirmation_number: "1234567",
 });
 assert.deepEqual(fields(rows[1]!), Object.fromEntries(keys.map(key => [key, null])));
 // Independent pre-change mapper oracle: the five additions cannot alter any existing field.
 const legacy = txns.map(t => ({
  id: hashId(`${options.accountId}|${t.tupleKey}|#${t.ord}`),
  account_id: options.accountId, account_name: options.accountName,
  date: t.iso, description: t.description, original_description: t.description,
  category: null, amount: t.amount, currency: "USD",
  balance_after_cents: t.balance, check_number: null, source: "pdf_statement_2026-04",
 }));
 for (const [index, row] of rows.entries()) {
  const withoutTransfer = Object.fromEntries(Object.entries(row).filter(([key]) => !keys.some(field => field === key)));
  assert.deepEqual(withoutTransfer, legacy[index]);
  assert.deepEqual(fields(transactionSchema.parse(row)), fields(row));
 }
});

test("modern checking statement text carries transfer detail into schema-valid records", () => {
 const text = [
  "SYNTHETIC CHECKING STATEMENT",
  "TRANSACTIONS",
  "Date Description Amount Balance",
  "04/10 USAA FUNDS TRANSFER CR FROM RILEY IMAGINARY SAVINGS #4321, CONF# 1234567 12.34 112.34",
  "04/11 SYNTHETIC BOOKSHOP -5.00 107.34",
  "ENDING BALANCE 107.34",
 ].join("\n");
 const parsed = _internals.parseModernCheckingEra(text, {
  closing: { closingYear: 2026, closingMonth: 4 },
 });
 assert.equal(parsed.length, 2, "both statement rows must be parsed");
 const rows = _internals.buildStatementRecords(parsed, {
  accountId: "SYNTHETIC-ACCOUNT", accountName: "Synthetic checking", period: "2026-04",
 });
 assert.equal(rows.length, 2);
 const [transfer, purchase] = rows;
 assert.ok(transfer);
 assert.ok(purchase);
 assert.equal(transfer.description, "USAA FUNDS TRANSFER CR FROM RILEY IMAGINARY SAVINGS #4321, CONF# 1234567");
 assert.equal(transfer.date, "2026-04-10");
 assert.equal(transfer.amount, 1234);
 assert.deepEqual(fields(transfer), {
  transfer_direction: "in", counterparty_name: "RILEY IMAGINARY",
  counterparty_account_type: "SAVINGS", counterparty_last4: "4321",
  transfer_confirmation_number: "1234567",
 });
 assert.equal(purchase.description, "SYNTHETIC BOOKSHOP");
 assert.equal(purchase.date, "2026-04-11");
 assert.equal(purchase.amount, -500);
 assert.deepEqual(fields(purchase), Object.fromEntries(keys.map(key => [key, null])));
 for (const row of rows) {
  assert.deepEqual(fields(transactionSchema.parse(row)), fields(row));
 }
});
