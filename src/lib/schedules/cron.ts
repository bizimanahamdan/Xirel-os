/**
 * Minimal 5-field cron parser + next-run calculator (Phase 11).
 *
 * Pure logic, UTC only (the agent_schedules.timezone column records the
 * user's intent for a future local-time feature; evaluation is UTC so
 * behavior is deterministic regardless of host/server timezone —
 * documented limitation, not a hidden one).
 *
 * Supported syntax:  ┌──────── minute      (0-59)
 *                    │ ┌────── hour        (0-23)
 *                    │ │ ┌──── day-of-month (1-31)
 *                    │ │ │ ┌── month        (1-12, JAN-DEC)
 *                    │ │ │ │ ┌ day-of-week   (0-7, 0/7=SUN, MON-SAT)
 * `* / , -` steps, ranges and lists are supported in every field.
 * Standard Vixie cron day-combining rule: if BOTH day-of-month and
 * day-of-week are restricted, a day matches when EITHER matches.
 */

export interface CronFields {
  minute: boolean[]; // [0..59]
  hour: boolean[]; // [0..23]
  dom: boolean[]; // [1..31] (index 0 unused)
  month: boolean[]; // [1..12] (index 0 unused)
  dow: boolean[]; // [0..6] (7 normalized to 0)
  domRestricted: boolean;
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseField(
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): boolean[] {
  const slots = new Array<boolean>(max + 1).fill(false);
  for (const part of field.split(',')) {
    const stepMatch = /^(\*|\d+(?:-\d+)?|[a-z]{3}(?:-[a-z]{3})?)(?:\/(\d+))?$/.exec(
      part.trim().toLowerCase(),
    );
    if (!stepMatch) throw new Error(`Invalid cron field segment: "${part}"`);
    const rangePart: string = stepMatch[1] ?? '';
    const stepPart: string | undefined = stepMatch[2];
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step in "${part}"`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const segments = rangePart.split('-');
      const a: string = segments[0] ?? '';
      const b: string = segments[1] ?? '';
      lo = aliases?.[a] ?? Number(a);
      hi = aliases?.[b] ?? Number(b);
    } else {
      lo = aliases?.[rangePart] ?? Number(rangePart);
      hi = stepPart ? max : lo; // "5/10" means start at 5, step to max
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`Invalid cron value in "${part}"`);
    }
    // Normalize dow 7 → 0 (both mean Sunday); ranges like 5-7 wrap poorly —
    // require lo<=hi except the dow 0-7 aliasing handled below.
    if (lo < min || hi > max || lo > hi) {
      if (max === 6 && lo === 7 && hi === 7) {
        lo = 0;
        hi = 0; // "7" = Sunday
      } else {
        throw new Error(`Cron value out of range in "${part}" (expected ${min}-${max})`);
      }
    }
    for (let v = lo; v <= hi; v += step) {
      slots[max === 6 && v === 7 ? 0 : v] = true;
    }
  }
  return slots;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields (minute hour dom month dow): "${expr}"`);
  }
  const minute = parts[0] ?? '';
  const hour = parts[1] ?? '';
  const domField = parts[2] ?? '';
  const month = parts[3] ?? '';
  const dowField = parts[4] ?? '';
  const dom = parseField(domField, 1, 31);
  const dow = parseField(dowField, 0, 6, DAY_NAMES);
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom,
    month: parseField(month, 1, 12, MONTH_NAMES),
    dow,
    domRestricted: domField !== '*',
    dowRestricted: dowField !== '*',
  };
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** boolean[] lookup that satisfies noUncheckedIndexedAccess. */
function flag(slots: boolean[], i: number): boolean {
  return slots[i] === true;
}

function dayMatches(c: CronFields, date: Date): boolean {
  const domOk = flag(c.dom, date.getUTCDate());
  const dowOk = flag(c.dow, date.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk; // Vixie rule
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return domOk && dowOk; // both '*'
}

function timeMatches(c: CronFields, date: Date): boolean {
  return (
    flag(c.minute, date.getUTCMinutes()) &&
    flag(c.hour, date.getUTCHours()) &&
    flag(c.month, date.getUTCMonth() + 1) &&
    dayMatches(c, date)
  );
}

const MINUTE_MS = 60_000;
/** Upper bound for the scan: one leap year of minutes. */
const MAX_SCAN_MINUTES = 366 * 24 * 60;

/**
 * Next fire time strictly AFTER `from` (UTC), or null if none within a
 * year (e.g. Feb 30 — unrepresentable dates).
 */
export function nextCronRun(expr: string, from: Date): Date | null {
  const c = parseCron(expr);
  const candidate = new Date(Math.floor(from.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (timeMatches(c, candidate)) return new Date(candidate.getTime());
    candidate.setTime(candidate.getTime() + MINUTE_MS);
  }
  return null;
}
