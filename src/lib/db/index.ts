import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

// A single pooled connection reused across the server process.
//
// connect_timeout / idle_timeout are real postgres-js options (not a
// guess): connect_timeout fails fast if a new connection can't be
// established at all; idle_timeout proactively closes connections that
// have sat idle, so a serverless invocation is less likely to reuse a
// connection that looks open locally but was silently dropped by a
// load balancer/NAT somewhere in between — a common cause of a query
// hanging forever with no error in serverless + Postgres setups.
//
// This does NOT by itself fix everything: if DATABASE_URL points at
// Supabase's direct connection (port 5432) rather than the pooler
// (port 6543, pgbouncer, transaction mode), serverless cold starts can
// still exhaust the direct-connection limit. Recommended: use the
// pooler connection string for DATABASE_URL in serverless deployments.
const client = postgres(process.env.DATABASE_URL, {
  max: 10,
  connect_timeout: 10,
  idle_timeout: 20,
});

export const db = drizzle(client, { schema });
