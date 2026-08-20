import 'server-only';
import { z } from 'zod';
import type { ToolDefinition } from './types';

/**
 * Returns the current server time. Models frequently need this — their
 * training data has a cutoff, so they cannot know "today's date" on
 * their own. Deliberately UTC-only for now; per-workspace timezone
 * preference is a reasonable future addition once workspaces have a
 * timezone setting (they don't yet — see src/lib/db/schema.ts).
 */
const datetimeInputSchema = z.object({}).describe('No arguments required.');

type DatetimeInput = z.infer<typeof datetimeInputSchema>;

export const getCurrentDatetimeTool: ToolDefinition<
  DatetimeInput,
  { iso: string; unixSeconds: number }
> = {
  name: 'get_current_datetime',
  description:
    "Get the current date and time in UTC (ISO 8601) and as a Unix timestamp. Use this whenever you need to know 'today' or the current time — your training data has a cutoff and cannot tell you this.",
  inputSchema: datetimeInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {},
  },
  outputDescription: 'An object { iso: string, unixSeconds: number } for the current UTC time.',
  riskLevel: 'safe',
  requiredPermission: 'member',
  async execute() {
    const now = new Date();
    return {
      success: true,
      output: {
        iso: now.toISOString(),
        unixSeconds: Math.floor(now.getTime() / 1000),
      },
    };
  },
};
