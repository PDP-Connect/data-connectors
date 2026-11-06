// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic USAA site for the Mobile (PageShim) path. Each account page has
// USAA's Export button. It opens a dialog with a date-range choice; submit
// builds the CSV in the page and hands it to the browser as a `data:` link,
// as usaa.com does. All names, numbers and amounts are made up.

const ORIGIN = "https://www.usaa.com";

const DAY_MS = 86_400_000;
const isoDay = (offset) => new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
const usDate = (iso) => {
	const [y, m, d] = iso.split("-");
	return `${m}/${d}/${y}`;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => {
	const [, m, d] = iso.split("-").map(Number);
	return `${MONTHS[m - 1]} ${d}`;
};

const ACCOUNTS = [
	{
		id: "SYNCHK0001",
		path: "/my/checking",
		label: "Synthetic Checking *1234 Available Balance $1,234.56",
		exportClass: "ent-as-utility-bar__item export",
		barClass: "ent-as-utility-bar",
		// One row is older than the 17-month window and must not be exported.
		rows: [
			[isoDay(2), "Coffee Shop", "SYNTHETIC COFFEE #45", "Food & Drink", "-4.50", "Posted"],
			[isoDay(9), "Paycheck", "SYNTHETIC PAYROLL DEPOSIT", "Income", "2000.00", "Posted"],
			[isoDay(30), "Gas Station", "SYNTHETIC FUEL 123", "Transportation", "-42.17", "Posted"],
			[isoDay(700), "Old Purchase", "OUTSIDE WINDOW", "Shopping", "-1.00", "Posted"],
		],
	},
	{
		id: "SYNCC0002",
		path: "/my/credit-card",
		label: "Synthetic Rewards Card *5678 Current Balance $301.66",
		exportClass: "as_credit__utility-bar-item as_credit__export",
		barClass: "as_credit__utility-bar",
		rows: [
			[isoDay(4), "Grocer", "SYNTHETIC GROCER", "Groceries", "-61.20", "Posted"],
			[isoDay(15), "Streaming", "SYNTHETIC STREAMING", "Entertainment", "-9.99", "Posted"],
		],
		billing: {
			"Account Nickname": "Synthetic Rewards Card",
			"Credit Limit": "$5,000.00",
			"Annual Percent Rate": "19.99%",
			"Cash Advance APR": "24.99%",
			"Card Holders": "Synthetic Member",
			"Current Balance": "$301.66",
			"Available Credit": "$4,698.34",
		},
	},
];

const STATEMENTS = [
	["Bank Statement", usDate(isoDay(20)), "Synthetic Checking *1234"],
	["Credit Card Statement", usDate(isoDay(25)), "Synthetic Rewards Card *5678"],
];

const INBOX = [
	["Unread", shortDate(isoDay(1)), "Your synthetic statement is ready to view."],
	["Read", shortDate(isoDay(6)), "A synthetic security notice about your account."],
];

let loggedIn = true;
/** Every export the site answered, for assertions: account id and dates. */
export const exportRequests = [];

const html = (body, status = 200) => ({
	status,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html lang="en"><head><title>USAA</title></head><body>${body}</body></html>`,
});

const table = (rows) =>
	`<table><tbody>${rows
		.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`)
		.join("")}</tbody></table>`;

/** How long the Export dialog stays empty before its controls render. */
const EXPORT_DIALOG_RENDER_DELAY_MS = 1500;

/**
 * How the Export dialog's date fields behave after "date-range" is chosen:
 * "normal" enables them at once; "late_init" enables them but drops any
 * value typed in the first 150 ms, as a field that finishes initializing
 * after it renders; "never" leaves them disabled.
 */
let dateFieldsMode = "normal";
export function useExportDateFields(mode) {
	dateFieldsMode = mode;
}
const DATE_FIELDS_INIT_MS = 150;

const dashboardHtml = () => `
<nav><a href="/my/checking">View</a></nav>
<ul class="accounts">${ACCOUNTS.map(
	(a) => `<li><a href="${a.path}?accountId=${a.id}">${a.label}</a></li>`,
).join("")}</ul>`;

/**
 * The account page and its Export dialog. The page also carries OneTrust's
 * hidden "Privacy Preference Center" dialog ahead of it, as usaa.com does.
 * The Export dialog opens empty and renders its controls a moment later, as
 * on a device. The date inputs stay disabled until "date-range" is chosen. Submit filters the rows by date and clicks a
 * `data:text/csv` link, or shows USAA's no-transactions message.
 */
const accountHtml = (account) => {
	const billing = account.billing
		? `<dl>${Object.entries(account.billing)
				.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
				.join("")}</dl>`
		: "";
	return `
<div id="onetrust-consent-sdk"><div id="onetrust-pc-sdk" role="dialog" aria-label="Privacy Preference Center" style="display:none"><button type="submit">Confirm my choices</button></div></div>
<div class="${account.barClass}"><button type="button" class="${account.exportClass}">Export</button></div>
${billing}
<table aria-label="transactions"><tbody><tr><td>Recent activity</td></tr></tbody></table>
<script>
const ROWS = ${JSON.stringify(account.rows)};
const ACCOUNT_ID = ${JSON.stringify(account.id)};
const toIso = (us) => { const [m, d, y] = us.split("/"); return y + "-" + m + "-" + d; };
const csvCell = (v) => /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
document.querySelector("button.export, button.as_credit__export").addEventListener("click", () => {
  if (document.querySelector(".export-dialog")) return;
  const dialog = document.createElement("div");
  dialog.className = "export-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.textContent = "Loading";
  document.body.append(dialog);
  setTimeout(() => renderExportDialog(dialog), ${EXPORT_DIALOG_RENDER_DELAY_MS});
});
function renderExportDialog(dialog) {
  dialog.innerHTML =
    '<form>' +
    '<select name="selectionType"><option value="current">Current statement</option><option value="date-range">Date range</option></select>' +
    '<input name="fromDate" disabled><input name="endDate" disabled>' +
    '<p class="export_errorMessage"></p>' +
    '<button type="submit">Export</button></form>';
  const select = dialog.querySelector("select");
  const from = dialog.querySelector('input[name="fromDate"]');
  const to = dialog.querySelector('input[name="endDate"]');
  const mode = ${JSON.stringify(dateFieldsMode)};
  let initializedAt = Infinity;
  select.addEventListener("change", () => {
    if (mode === "never") return;
    from.disabled = to.disabled = select.value !== "date-range";
    initializedAt = Date.now() + (mode === "late_init" ? ${DATE_FIELDS_INIT_MS} : 0);
  });
  for (const input of [from, to]) {
    input.addEventListener("input", () => {
      if (Date.now() < initializedAt) input.value = "";
    });
  }
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const error = dialog.querySelector(".export_errorMessage");
    if (select.value !== "date-range" || !/^\\d\\d\\/\\d\\d\\/\\d{4}$/.test(from.value) || !/^\\d\\d\\/\\d\\d\\/\\d{4}$/.test(to.value)) {
      error.textContent = "Enter a valid date range.";
      return;
    }
    const start = toIso(from.value), end = toIso(to.value);
    window.__usaaExports = (window.__usaaExports || []).concat([{ account: ACCOUNT_ID, start, end }]);
    const rows = ROWS.filter((r) => r[0] >= start && r[0] <= end);
    if (rows.length === 0) {
      error.textContent = "There are no transactions to export for this date range.";
      return;
    }
    const csv = ["Date,Description,Original Description,Category,Amount,Status"]
      .concat(rows.map((r) => [toUs(r[0])].concat(r.slice(1)).map(csvCell).join(",")))
      .join("\\n");
    const link = document.createElement("a");
    link.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    link.download = "bk_download.csv";
    document.body.append(link);
    link.click();
    link.remove();
  });
}
function toUs(iso) { const [y, m, d] = iso.split("-"); return m + "/" + d + "/" + y; }
</script>`;
};

const LOGON = html(`<form id="logon"><input name="memberId"><input name="password" type="password"></form>`);
const toLogon = html(`<script>location.replace("/my/logon?redirect=" + encodeURIComponent(location.pathname))</script>`);

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.origin !== ORIGIN) return html("");
	if (url.pathname === "/my/logon") return LOGON;
	if (!url.pathname.startsWith("/my/")) return html("", 404);
	if (!loggedIn) return toLogon;
	if (url.pathname === "/my/usaa") return html(dashboardHtml());
	if (url.pathname === "/my/documents") return html(table(STATEMENTS));
	if (url.pathname === "/my/inbox") return html(table(INBOX));
	const account = ACCOUNTS.find(
		(a) => a.path === url.pathname && url.searchParams.get("accountId") === a.id,
	);
	if (account) {
		exportRequests.push({ account: account.id });
		return html(accountHtml(account));
	}
	return html("", 404);
}

export async function setLoggedIn(value, page) {
	loggedIn = value;
	if (page) await page.goto(`${ORIGIN}/my/usaa`);
}

export const usaaFixtures = {
	hosts: /^https:\/\/www\.usaa\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: `${ORIGIN}/my/usaa`,
	homeUrl: `${ORIGIN}/my/usaa`,
};

export const pageshimCase = {
	fixtures: usaaFixtures,
	scopes: [
		"usaa.accounts",
		"usaa.account_stats",
		"usaa.transactions",
		"usaa.statements",
		"usaa.inbox_messages",
		"usaa.credit_card_billing",
		"usaa.credit_card_billing_stats",
	],
	exportSummary: {
		count: 15,
		label: "records",
		details: {
			accounts: 2,
			account_stats: 2,
			transactions: 5,
			statements: 2,
			inbox_messages: 2,
			credit_card_billing: 1,
			credit_card_billing_stats: 1,
		},
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: {
			accounts: 0,
			account_stats: 0,
			transactions: 0,
			statements: 0,
			inbox_messages: 0,
			credit_card_billing: 0,
			credit_card_billing_stats: 0,
		},
	},
	// Statement PDFs are not kept on Mobile; the statement list is.
	partialErrors: [
		{
			errorClass: "partial",
			reason:
				"The Mobile app saved the statement list without the PDF files. Run USAA on Desktop to save statement PDFs.",
			scope: "usaa.statements",
			phase: "collect",
			disposition: "degraded",
			code: "statement_pdfs_partial_on_mobile",
		},
	],
};
