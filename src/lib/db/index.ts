import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.');
}

// A single pooled connection reused across the server process.
// In serverless environments with many cold starts, consider
// Supabase's pgbouncer connection string (port 6543) instead.
const client = postgres(process.env.DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });
