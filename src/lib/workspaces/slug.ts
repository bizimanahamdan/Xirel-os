import 'server-only';
import { db } from '@/lib/db';
import { workspaces } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
}

/**
 * Generates a unique slug for a workspace name, appending -2, -3, etc.
 * if the base slug is taken. Capped at a reasonable number of attempts
 * so a pathological case (someone scripting workspace creation) can't
 * spin this into an infinite loop.
 */
export async function generateUniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let attempt = 1;

  const MAX_ATTEMPTS = 25;

  while (attempt <= MAX_ATTEMPTS) {
    const existing = await db.query.workspaces.findFirst({
      where: eq(workspaces.slug, candidate),
      columns: { id: true },
    });

    if (!existing) return candidate;

    attempt += 1;
    candidate = `${base}-${attempt}`;
  }

  // Extremely unlikely fallback — guarantees uniqueness without another query.
  return `${base}-${Date.now()}`;
}
