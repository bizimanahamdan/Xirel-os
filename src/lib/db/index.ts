import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

// Serverless-oriented client configuration.
//
// This app runs on Vercel serverless functions, where every function
// instance is its own process. Consequences that shaped this config:
//
// - max: 1 — one Postgres connection per function instance. Each
//   concurrent Vercel invocation is a separate instance, so the real
//   connection count is (live instances × max). With Supabase's
//   max_connections = 60, max:10 multiplied burst load tenfold and was
//   the direct cause of production "CONNECT_TIMEOUT
//   ...pooler.supabase.com:5432" errors. Supabase itself was healthy
//   (~14 connections at the time) — the client was simply asking for
//   too many.
//
// - prepare: false — REQUIRED through Supabase's Transaction Pooler
//   (PgBouncer, transaction mode). Transaction-mode routing gives no
//   guarantee that consecutive statements reuse the same backing
//   server connection, so named prepared statements intermittently
//   fail with "prepared statement ... does not exist". postgres-js
//   transparently uses unnamed statements with this flag.
//
// - ssl: 'require' — Supabase Postgres requires TLS. Explicit here so
//   correctness doesn't depend on sslmode params inside DATABASE_URL.
//
// - connect_timeout: 10 / idle_timeout: 20 — fail fast when a new
//   connection can't be established at all, and close connections that
//   have sat idle long enough that the serverless platform or an
//   intermediate NAT may have silently dropped them (a classic cause
//   of queries hanging forever with no error in serverless setups).
//
// DATABASE_URL FOR PRODUCTION must be the Supabase TRANSACTION POOLER
// string (port 6543), copied exactly from
//   Supabase Dashboard → Connect → Transaction Pooler
// and configured as a Vercel environment variable — do not hand-write
// hostnames or credentials, and never commit them. The direct
// connection (port 5432) bypasses PgBouncer and will exhaust the
// connection limit under serverless load.
const client = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 10,
  idle_timeout: 20,
  ssl: 'require',
});

export const db = drizzle(client, { schema });
