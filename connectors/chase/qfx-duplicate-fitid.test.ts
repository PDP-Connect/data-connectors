// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A Chase QFX file can list one FITID twice (a device run parsed 741 rows
// with 740 distinct FITIDs). Both rows map to one record id, so the
// connector emits each id once and reports the distinct count.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type EmitDeps,
	parseQfxText,
	processParsedAccountQfx,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChaseAccount } from "./types.ts";

const ACCOUNT: ChaseAccount = {
	internal_id: "INTACC123",
	last_four: "9241",
	name: "Sapphire Preferred",
	type: "credit_card",
};

const row = (fitid: string, date: string, amount: string): string => `<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${date}120000[0:GMT]
<TRNAMT>${amount}
<FITID>${fitid}
<NAME>SYNTHETIC MERCHANT
</STMTTRN>`;

const QFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>0<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>800100200</CCACCTFROM>
<BANKTRANLIST><DTSTART>20260101120000[0:GMT]<DTEND>20260131120000[0:GMT]
${row("SYN1", "20260105", "-1.00")}
${row("SYN2", "20260106", "-2.00")}
${row("SYN1", "20260105", "-1.00")}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-3.00<DTASOF>20260131120000[0:GMT]</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>
`;

test("QFX with a repeated FITID: one record per id and the distinct count in progress", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const deps: EmitDeps = {
		capture: null,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-02-01T10:00:00.000Z",
		maxSeenByAccount: {},
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map<string, StreamScope>([
			["transactions", { name: "transactions" }],
		]),
		resFilters: new Map(),
		tmpDir: "/tmp/chase-test",
		txState: {},
		wantsAccounts: false,
		wantsBalances: false,
		wantsCurrentActivity: false,
		wantsStatements: false,
		wantsTransactions: true,
	};
	const outcome = await processParsedAccountQfx(
		deps,
		ACCOUNT,
		"all",
		await parseQfxText(QFX),
		"1/1",
	);
	assert.equal(outcome.kind, "hydrated");
	const ids = harness.emitted
		.filter((r) => r.stream === "transactions")
		.map((r) => (r.data as { id: string }).id);
	assert.deepEqual(ids, ["INTACC123|SYN1", "INTACC123|SYN2"]);
	const progress = harness.protocolMessages.flatMap((m) =>
		m.type === "PROGRESS" && /^Parsed account/.test(m.message)
			? [m.message]
			: [],
	);
	assert.deepEqual(progress, ["Parsed account 1/1: emitted 2 transaction(s)"]);
});
