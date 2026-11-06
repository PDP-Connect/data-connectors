// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic Chase site for the Mobile (PageShim) path. The dashboard is a
// small hash-routed page. Its transaction download form builds a hidden GET
// form with a CSRF token and submits it, as chase.com does; the server answers
// that request with a QFX file only for the right token and file type. All
// names, numbers and amounts are made up.

const ORIGIN = "https://secure.chase.com";
const ACCOUNT_ID = "800100200";
const CSRF_TOKEN = "f".repeat(64);
const QFX_PATH =
	"/svc/rr/accounts/secure/gateway/credit-card/transactions/inquiry-maintenance/digital-transaction-activity/v1/transaction-activities";

const DAY_MS = 86_400_000;
const isoDay = (offset) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
const packed = (iso) => iso.replaceAll("-", "");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const visibleDate = (iso) => {
	const [y, m, d] = iso.split("-").map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
};

/**
 * Card activity the QFX endpoint serves. Two rows are older than a year, so
 * only a second request reads them; one row is older than the 24-month
 * window. One FITID is listed twice, as a device QFX did.
 */
const TRANSACTIONS = [
	{ fitid: "2026SYN0001", date: isoDay(3), amount: "-42.17", name: "SYNTHETIC GROCER" },
	{ fitid: "2026SYN0001", date: isoDay(3), amount: "-42.17", name: "SYNTHETIC GROCER" },
	{ fitid: "2026SYN0002", date: isoDay(12), amount: "-9.99", name: "SYNTHETIC STREAMING" },
	{ fitid: "2026SYN0003", date: isoDay(40), amount: "250.00", name: "PAYMENT THANK YOU" },
	{ fitid: "2025SYN0005", date: isoDay(450), amount: "-18.40", name: "SYNTHETIC BOOKSHOP" },
	{ fitid: "2024SYN0006", date: isoDay(700), amount: "-61.25", name: "SYNTHETIC HARDWARE" },
	{ fitid: "2024SYN0004", date: isoDay(900), amount: "-5.00", name: "OUTSIDE WINDOW" },
];

/**
 * The longest range one QFX request may span; a longer one gets 204 and no
 * body, as on the device (729 days got 204, 364 days got activity).
 */
const SERVED_WINDOW_DAYS = 400;

let olderHistoryServed = true;
/**
 * Whether the endpoint serves requests that start more than a year back.
 * When false it answers them with 204, however short the range.
 */
export function useOlderHistoryServed(value) {
	olderHistoryServed = value;
}

let loggedIn = true;
/** Every QFX request the site answered, for assertions. */
export const qfxRequests = [];

const html = (body, status = 200) => ({
	status,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html lang="en"><head><title>Chase</title></head><body>${body}</body></html>`,
});

const overviewHtml = () => `
<div class="accounts-list">
  <button id="accounts-name-link-button-${ACCOUNT_ID}" type="button">
    <span id="accounts-name-link-button-${ACCOUNT_ID}-label">Sapphire Preferred (...9241)</span>
  </button>
</div>
<div id="activity"></div>`;

/**
 * Recent activity, one subtable per row as the Mobile layout groups it. The
 * row markup is the Desktop one: the Mobile row markup is not captured yet.
 */
const activityHtml = () => `
<table class="mds-activity-table__mobile"><tbody>
  <tr id="ovd-recent-activity-table-dataTableId-row-1" class="mds-activity-table__row" data-values="Pending,SYNTHETIC CAFE,$6.50,">
    <td>Pending</td><td>SYNTHETIC CAFE</td><td>$6.50</td>
  </tr>
</tbody></table>
<table class="mds-activity-table__mobile"><tbody>
  <tr id="ovd-recent-activity-table-dataTableId-row-2" class="mds-activity-table__row" data-values="${visibleDate(isoDay(3))},SYNTHETIC GROCER,$42.17,">
    <td>${visibleDate(isoDay(3))}</td><td>SYNTHETIC GROCER</td><td>$42.17</td>
  </tr>
</tbody></table>`;

/** How long after the accounts the activity tables render, as on a device. */
const ACTIVITY_RENDER_DELAY_MS = 1500;

const documentsHtml = () => `
<div class="documents-page">
  <button id="button-documentsAccordion-0" type="button">SAPPHIRE PREFERRED (...9241)</button>
  <table id="accountsTable-0"><tbody>
    <tr>
      <td>${visibleDate(isoDay(20))}</td><td>Statement</td><td>4 pages</td>
      <td><a id="accountsTable-0-row0-cell3-requestThisDocumentAnchor-download" href="#accountsTable-0-row0-cell3-requestThisDocumentAnchor-download">Download</a></td>
    </tr>
    <tr>
      <td>${visibleDate(isoDay(51))}</td><td>Statement</td><td>5 pages</td>
      <td><a id="accountsTable-0-row1-cell3-requestThisDocumentAnchor-download" href="#accountsTable-0-row1-cell3-requestThisDocumentAnchor-download">Download</a></td>
    </tr>
  </tbody></table>
</div>`;

/**
 * The documents page as the Mobile WebView rendered it on a device: a tab bar
 * and a dialog, no statement accordion and no tables. The real Mobile
 * statement markup is not captured yet.
 */
const mobileDocumentsHtml = () => `
<mds-tab-bar></mds-tab-bar>
<mds-dialog></mds-dialog>`;

let documentsShape = "desktop";
/** Serve the documents page in its "desktop" or "mobile" shape. */
export function useDocumentsShape(shape) {
	documentsShape = shape;
}

/**
 * The download form. `mds-button` keeps its button in a shadow root; the
 * click builds a hidden GET form, as chase.com does, defaulting to CSV.
 */
const downloadFormHtml = (accountId) => `
<mds-select id="downloadFileTypeOption" value="CSV"></mds-select>
<mds-select id="downloadActivityOptionId" value="CURRENT_DISPLAY"></mds-select>
<mds-button id="download" data-account="${accountId}"></mds-button>`;

const spa = () => `
<div id="app"></div>
<script>
const views = ${JSON.stringify({
	overview: overviewHtml(),
	activity: activityHtml(),
	documents: documentsShape === "mobile" ? mobileDocumentsHtml() : documentsHtml(),
})};
const formHtml = ${JSON.stringify(downloadFormHtml("__ID__"))};
if (!customElements.get("mds-button")) {
  customElements.define("mds-button", class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.textContent = "Download";
      button.addEventListener("click", () => {
        // chase.com opens "_self" first and builds the form only when that
        // returns a window.
        if (!window.open("", "_self")) return;
        const form = document.createElement("form");
        form.method = "GET";
        form.action = ${JSON.stringify(QFX_PATH)};
        form.style.display = "none";
        const fields = {
          "digital-account-identifier": this.dataset.account,
          "account-activity-download-type-code": "CSV",
          "eligibility-indicator": "true",
          "csrftoken": ${JSON.stringify(CSRF_TOKEN)},
        };
        for (const [name, value] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.type = "hidden"; input.name = name; input.value = value;
          form.append(input);
        }
        const submit = document.createElement("input");
        submit.type = "submit"; submit.name = "submit"; submit.value = "Submit";
        form.append(submit);
        document.body.append(form);
        submit.click();
        // The connector must read the submission, not the leftover form.
        form.remove();
      });
      root.append(button);
    }
  });
}
function render() {
  const hash = location.hash;
  const app = document.getElementById("app");
  const download = /downloadAccountTransactions\\/index;params=[A-Z]+,[A-Z]+,(\\d+)/.exec(hash);
  if (download) app.innerHTML = formHtml.replace("__ID__", download[1]);
  else if (hash.includes("/documents/")) app.innerHTML = views.documents;
  else {
    app.innerHTML = views.overview;
    setTimeout(() => {
      const slot = document.getElementById("activity");
      if (slot) slot.innerHTML = views.activity;
    }, ${ACTIVITY_RENDER_DELAY_MS});
  }
}
addEventListener("hashchange", render);
render();
</script>`;

const LOGON = html(`<form id="logonForm"><input id="userId-text-input-field"><input id="password-text-input-field" type="password"></form>`);

function qfx(start, end) {
	const rows = TRANSACTIONS.filter((t) => t.date >= start && t.date <= end)
		.map((t) => `<STMTTRN>
<TRNTYPE>${t.amount.startsWith("-") ? "DEBIT" : "CREDIT"}
<DTPOSTED>${packed(t.date)}120000[0:GMT]
<TRNAMT>${t.amount}
<FITID>${t.fitid}
<NAME>${t.name}
</STMTTRN>`)
		.join("\n");
	return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>${packed(isoDay(0))}120000[0:GMT]<LANGUAGE>ENG</SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>0<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS><CURDEF>USD<CCACCTFROM><ACCTID>${ACCOUNT_ID}</CCACCTFROM>
<BANKTRANLIST><DTSTART>${start}120000[0:GMT]<DTEND>${end}120000[0:GMT]
${rows}
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-301.66<DTASOF>${packed(isoDay(0))}120000[0:GMT]</LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>
</OFX>
`;
}

function resolveQfx(url) {
	const params = url.searchParams;
	qfxRequests.push(Object.fromEntries(params));
	if (!loggedIn) return html("Signed out", 401);
	if (params.get("csrftoken") !== CSRF_TOKEN) return html("Bad token", 403);
	if (params.get("digital-account-identifier") !== ACCOUNT_ID) return html("Unknown account", 404);
	if (params.get("account-activity-download-type-code") !== "QFX") {
		return { status: 200, contentType: "text/csv", body: "Transaction Date,Description,Amount\n" };
	}
	const start = params.get("start-date") ?? "";
	const end = params.get("end-date") ?? "";
	if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) return html("Choose a date range", 400);
	const iso = (p) => `${p.slice(0, 4)}-${p.slice(4, 6)}-${p.slice(6, 8)}`;
	// Chase answers a window longer than it will serve with 204 and no body.
	if (
		(Date.parse(iso(end)) - Date.parse(iso(start))) / DAY_MS > SERVED_WINDOW_DAYS ||
		(!olderHistoryServed && iso(start) < isoDay(364))
	) {
		return { status: 204, contentType: "application/vnd.intu.qfx", body: "" };
	}
	return {
		status: 200,
		contentType: "application/vnd.intu.qfx",
		headers: { "content-disposition": `attachment; filename="Chase${ACCOUNT_ID.slice(-4)}_Activity.QFX"` },
		body: qfx(iso(start), iso(end)),
	};
}

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.origin !== ORIGIN) return html("");
	if (url.pathname === QFX_PATH) return resolveQfx(url);
	if (url.pathname === "/web/auth/dashboard") {
		return loggedIn
			? html(spa())
			: html(`<script>location.replace("/web/auth/#/logon/logon/chaseOnline")</script>`);
	}
	if (url.pathname === "/web/auth/") return LOGON;
	return html("", 404);
}

export async function setLoggedIn(value, page) {
	loggedIn = value;
	if (page) await page.goto(`${ORIGIN}/web/auth/dashboard`);
}

export const chaseFixtures = {
	hosts: /^https:\/\/secure\.chase\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: `${ORIGIN}/web/auth/dashboard`,
	homeUrl: `${ORIGIN}/web/auth/dashboard`,
};

export const pageshimCase = {
	fixtures: chaseFixtures,
	scopes: [
		"chase.accounts",
		"chase.transactions",
		"chase.current_activity",
		"chase.statements",
		"chase.balances",
	],
	exportSummary: {
		count: 11,
		label: "records",
		details: { accounts: 1, transactions: 5, current_activity: 2, statements: 2, balances: 1 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { accounts: 0, transactions: 0, current_activity: 0, statements: 0, balances: 0 },
	},
	// The QFX endpoint serves at most SERVED_WINDOW_DAYS per request, so the
	// connector reads its 729 days as two windows and reports no gap.
	// Statement PDFs are not kept on Mobile; the statement list is.
	partialErrors: [
		{
			errorClass: "partial",
			reason:
				"The Mobile app saved the statement list without the PDF files. Run Chase on Desktop to save statement PDFs.",
			scope: "chase.statements",
			phase: "collect",
			disposition: "degraded",
			code: "statement_pdfs_partial_on_mobile",
		},
	],
};
