# XIREL Business OS — complete companion app

A separate Next.js app for small shops, suppliers and service businesses. It shares XIREL OS authentication and its existing `workspaces` / `workspace_members` records when configured with the same Supabase project.

## Features
- Sign in with an existing XIREL OS email/password account; sign out
- Select an existing workspace membership
- Business dashboard, revenue/payment/invoice KPIs and low-stock list
- Customer directory (create, search, delete)
- Product and inventory management (create, update stock/price, delete)
- Sales recording with atomic stock deduction and payment ledger entry
- Invoice creation and payment recording with invoice status recalculation
- Tenant isolation through PostgreSQL RLS and workspace membership checks
- Responsive mobile and desktop layout

## Run
1. Use Node.js 20+.
2. Copy `.env.example` to `.env.local` and set the two public Supabase variables to the same project used by XIREL OS.
3. Run `supabase/migrations/0006_business_os.sql` in Supabase SQL Editor after XIREL OS migration `0001_foundation.sql`.
4. Run `npm install` then `npm run dev`; open `http://localhost:3000`.

## Deploy
Deploy this folder as a separate Vercel project and set the same two environment variables. Apply the migration first.

## Boundaries
This is a complete runnable companion-app code package, but it has not been connected to your live Supabase instance, built in your environment, or deployed from this chat. Test in staging with two different workspaces before production. Sales currently support one product per transaction; invoice line items, PDF export, VAT/tax calculations, refunds and local fiscal compliance are not included. It is not an official accounting package.
