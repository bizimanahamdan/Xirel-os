# Staging verification before production

- Apply migration 0006 only after XIREL OS foundation migration 0001.
- Sign in with an existing XIREL OS user who belongs to a workspace.
- Add a customer and product; refresh and confirm persistence.
- Create a product with 3 units, sell 2, confirm stock becomes 1.
- Attempt another sale of 2; expect `Insufficient stock` and no extra sale.
- Create an invoice for 100, record payments of 40 and 60; expect partially_paid then paid.
- Test with a second user from a different workspace; cross-workspace reads and writes must fail.
- Verify the Next.js build, browser console, Supabase logs, and database policies.
- Validate VAT, local fiscal requirements, audit needs and backup strategy before official bookkeeping.

## Scope limitations
Sales currently support one product per transaction. Invoices are total-only (no line items/PDF/tax calculations). There is no refund, dedicated stock-restock workflow or official accounting/fiscal compliance. The live database, production build and deployment have not been verified from this environment.
