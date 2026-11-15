# Expensify connector

Development connector for expenses, reports and report-derived reimbursements exported by the Expensify Integration Server at `https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations`.

Create integration credentials at https://www.expensify.com/tools/integrations/ and supply `EXPENSIFY_PARTNER_USER_ID` (partnerUserID) and `EXPENSIFY_PARTNER_USER_SECRET` (partnerUserSecret). Keep the secret private. No browser sign-in is used.

`EXPENSIFY_HISTORY_YEARS` sets the export lookback, default **3** years. Options currently come from the environment. The collector rejects non-positive or unsafe year counts before requesting an export.

Coverage is per selected stream and selected export window only, not an all-time account inventory. No durable change cursor, account profile or usage stream is provided. Date-only and local date-time fields have no proved timezone. Amounts are integer minor units with nullable currency; reimbursement amounts come from report totals, not observed cash settlement.

Registration tests use a fake client and fixed clock; no real account is contacted:
```sh
node --import tsx --test connectors/expensify/integration.test.ts connectors/expensify/collect.test.ts
```
