import 'server-only';
import { db } from '@/lib/db';
import { tasks } from '@/lib/db/schema';

/**
 * Check if Phase 2 database setup is complete
 * Returns true if tasks table exists and is accessible
 */
export async function isPhase2SetupComplete(): Promise<boolean> {
  try {
    // Try to query the tasks table - this will fail if migration hasn't run
    await db.select().from(tasks).limit(1);
    return true;
  } catch (err) {
    // Table doesn't exist or other database error
    return false;
  }
}
