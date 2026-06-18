import type { SessionMeta } from "./sessions";

/* ------------------------------------------------------------------ */
/*  Date-range helpers                                                 */
/* ------------------------------------------------------------------ */

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Returns the Monday-based ISO week range for a given reference date.
 *
 * @param now   - The reference point (any Date).
 * @param offset - 0 = current week, -1 = last week, etc.
 * @returns `{ start, end }` where start is Monday 00:00:00.000 and
 *          end is Sunday 23:59:59.999 of the target week.
 */
export function getWeekRange(now: Date, offset = 0): DateRange {
  const d = new Date(now);

  // day-of-week: JS uses 0=Sun, 1=Mon … 6=Sat
  // Convert to ISO convention: Mon=0, Tue=1 … Sun=6
  const jsDay = d.getDay();
  const isoDay = jsDay === 0 ? 6 : jsDay - 1; // Mon=0 … Sun=6

  // Rewind to Monday of the current week
  const monday = new Date(d);
  monday.setDate(d.getDate() - isoDay + offset * 7);
  monday.setHours(0, 0, 0, 0);

  // Sunday = Monday + 6 days, at 23:59:59.999
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { start: monday, end: sunday };
}

/**
 * Returns the calendar-month range for a given reference date.
 *
 * @param now   - The reference point (any Date).
 * @param offset - 0 = current month, -1 = last month, etc.
 * @returns `{ start, end }` where start is the 1st at 00:00:00.000 and
 *          end is the last day at 23:59:59.999.
 */
export function getMonthRange(now: Date, offset = 0): DateRange {
  const year = now.getFullYear();
  const month = now.getMonth() + offset;

  const start = new Date(year, month, 1, 0, 0, 0, 0);

  // Day 0 of the *next* month gives us the last day of *this* month
  const end = new Date(year, month + 1, 0, 23, 59, 59, 999);

  return { start, end };
}

/* ------------------------------------------------------------------ */
/*  Digest aggregation                                                 */
/* ------------------------------------------------------------------ */

export interface PeriodStats {
  sessions: number;
  totalDuration: number;
  avgDuration: number;
}

export interface DigestResult {
  currentWeek: PeriodStats;
  lastWeek: PeriodStats;
  currentMonth: PeriodStats;
  /** Percentage change in session count: current week vs last week.
   *  `null` when lastWeek.sessions === 0 (avoid ÷0). */
  deltaSessionsPct: number | null;
  /** Percentage change in total duration: current week vs last week.
   *  `null` when lastWeek.totalDuration === 0 (avoid ÷0). */
  deltaDurationPct: number | null;
}

/** Filter sessions that fall within a date range by `createdAt`. */
function sessionsInRange(
  sessions: Pick<SessionMeta, "createdAt">[],
  range: DateRange,
): Pick<SessionMeta, "createdAt">[] {
  return sessions.filter((s) => {
    if (!s.createdAt) return false;
    const t = new Date(s.createdAt).getTime();
    if (Number.isNaN(t)) return false;
    return t >= range.start.getTime() && t <= range.end.getTime();
  });
}

/** Compute aggregate stats for a set of sessions. */
function aggregateStats(
  sessions: Pick<SessionMeta, "createdAt">[],
  durations: Map<string, number>,
): PeriodStats {
  let totalDuration = 0;
  for (const s of sessions) {
    totalDuration += durations.get(s.createdAt) ?? 0;
  }
  return {
    sessions: sessions.length,
    totalDuration,
    avgDuration: sessions.length > 0 ? totalDuration / sessions.length : 0,
  };
}

/** Compute percentage change.  Returns `null` when base is 0. */
function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Build a weekly / monthly digest from a flat list of sessions.
 *
 * @param sessions  - Array of session metadata objects (only `createdAt` is required).
 * @param now       - Reference date (defaults to `new Date()`).  Accept a param so
 *                    tests can inject a deterministic clock.
 * @param durations - Optional map of createdAt → duration (ms).  When omitted,
 *                    duration is treated as 0 for every session.
 */
export function getDigest(
  sessions: Pick<SessionMeta, "createdAt">[],
  now: Date = new Date(),
  durations: Map<string, number> = new Map(),
): DigestResult {
  const cwRange = getWeekRange(now, 0);
  const lwRange = getWeekRange(now, -1);
  const cmRange = getMonthRange(now, 0);

  const cwSessions = sessionsInRange(sessions, cwRange);
  const lwSessions = sessionsInRange(sessions, lwRange);
  const cmSessions = sessionsInRange(sessions, cmRange);

  const currentWeek = aggregateStats(cwSessions, durations);
  const lastWeek = aggregateStats(lwSessions, durations);
  const currentMonth = aggregateStats(cmSessions, durations);

  return {
    currentWeek,
    lastWeek,
    currentMonth,
    deltaSessionsPct: pctChange(currentWeek.sessions, lastWeek.sessions),
    deltaDurationPct: pctChange(currentWeek.totalDuration, lastWeek.totalDuration),
  };
}
