import { describe, it, expect } from "vitest";
import { getWeekRange, getMonthRange, getDigest } from "../digest";

/* ------------------------------------------------------------------ */
/*  Helper: build a minimal session stub                               */
/* ------------------------------------------------------------------ */

function session(createdAt: string) {
  return { createdAt, status: "completed" as const };
}

/* ================================================================== */
/*  getWeekRange                                                       */
/* ================================================================== */

describe("getWeekRange", () => {
  it("start is Monday 00:00:00.000 for a mid-week date", () => {
    // 2026-06-10 is a Wednesday
    const { start } = getWeekRange(new Date(2026, 5, 10), 0);
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    expect(start.getDate()).toBe(8); // Mon Jun 8
  });

  it("end is Sunday 23:59:59.999", () => {
    const { end } = getWeekRange(new Date(2026, 5, 10), 0);
    expect(end.getDay()).toBe(0); // Sunday
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
    expect(end.getDate()).toBe(14); // Sun Jun 14
  });

  it("works when now is already Monday", () => {
    // 2026-06-08 is a Monday
    const { start, end } = getWeekRange(new Date(2026, 5, 8), 0);
    expect(start.getDate()).toBe(8);
    expect(end.getDate()).toBe(14);
  });

  it("works when now is Sunday", () => {
    // 2026-06-14 is a Sunday
    const { start, end } = getWeekRange(new Date(2026, 5, 14), 0);
    expect(start.getDay()).toBe(1);
    expect(start.getDate()).toBe(8);
    expect(end.getDay()).toBe(0);
    expect(end.getDate()).toBe(14);
  });

  it("offset=-1 returns the full prior week", () => {
    // now = Wed Jun 10 2026 → current week = Jun 8–14
    // last week = Jun 1–7
    const { start, end } = getWeekRange(new Date(2026, 5, 10), -1);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(5); // June
    expect(end.getDate()).toBe(7);
    expect(end.getMonth()).toBe(5);
  });

  it("handles year-crossing boundary (Jan date, week starts in Dec)", () => {
    // 2026-01-02 is a Friday → current week = Mon Dec 29 2025 – Sun Jan 4 2026
    const { start, end } = getWeekRange(new Date(2026, 0, 2), 0);
    expect(start.getFullYear()).toBe(2025);
    expect(start.getMonth()).toBe(11); // December
    expect(start.getDate()).toBe(29);
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(0); // January
    expect(end.getDate()).toBe(4);
  });

  it("handles month-crossing boundary (week spans Feb→Mar)", () => {
    // 2026-03-01 is a Sunday → current week = Mon Feb 23 – Sun Mar 1
    const { start, end } = getWeekRange(new Date(2026, 2, 1), 0);
    expect(start.getMonth()).toBe(1); // February
    expect(start.getDate()).toBe(23);
    expect(end.getMonth()).toBe(2); // March
    expect(end.getDate()).toBe(1);
  });
});

/* ================================================================== */
/*  getMonthRange                                                      */
/* ================================================================== */

describe("getMonthRange", () => {
  it("start is 1st of the month at 00:00:00.000", () => {
    const { start } = getMonthRange(new Date(2026, 5, 15), 0);
    expect(start.getDate()).toBe(1);
    expect(start.getMonth()).toBe(5);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
  });

  it("end is last day of the month at 23:59:59.999", () => {
    // June has 30 days
    const { end } = getMonthRange(new Date(2026, 5, 15), 0);
    expect(end.getDate()).toBe(30);
    expect(end.getMonth()).toBe(5);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getSeconds()).toBe(59);
    expect(end.getMilliseconds()).toBe(999);
  });

  it("February in a non-leap year has 28 days", () => {
    // 2026 is NOT a leap year
    const { end } = getMonthRange(new Date(2026, 1, 10), 0);
    expect(end.getDate()).toBe(28);
    expect(end.getMonth()).toBe(1);
  });

  it("February in a leap year has 29 days", () => {
    // 2028 IS a leap year
    const { end } = getMonthRange(new Date(2028, 1, 10), 0);
    expect(end.getDate()).toBe(29);
    expect(end.getMonth()).toBe(1);
  });

  it("month with 31 days ends on 31st", () => {
    // January has 31 days
    const { end } = getMonthRange(new Date(2026, 0, 15), 0);
    expect(end.getDate()).toBe(31);
    expect(end.getMonth()).toBe(0);
  });
});

/* ================================================================== */
/*  getDigest — aggregation                                            */
/* ================================================================== */

describe("getDigest — aggregation", () => {
  // Fixed reference: Wednesday 2026-06-10T12:00:00
  // Current week = Mon Jun 8 – Sun Jun 14
  const NOW = new Date(2026, 5, 10, 12, 0, 0);

  it("counts sessions in current week correctly", () => {
    const sessions = [
      session("2026-06-08T10:00:00"), // Mon – in range
      session("2026-06-10T08:30:00"), // Wed – in range
      session("2026-06-14T23:00:00"), // Sun – in range
      session("2026-06-07T23:59:59"), // last Sun – out
      session("2026-06-15T00:00:00"), // next Mon – out
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(3);
  });

  it("sums totalDuration and computes avgDuration", () => {
    const sessions = [
      session("2026-06-09T10:00:00"), // Tue
      session("2026-06-11T14:00:00"), // Thu
    ];
    const durations = new Map([
      ["2026-06-09T10:00:00", 60000],  // 1 min
      ["2026-06-11T14:00:00", 120000], // 2 min
    ]);
    const digest = getDigest(sessions, NOW, durations);
    expect(digest.currentWeek.totalDuration).toBe(180000);
    expect(digest.currentWeek.avgDuration).toBe(90000);
  });

  it("session exactly on Monday 00:00:00.000 is included", () => {
    // Create a session at the exact boundary start
    const sessions = [session("2026-06-08T00:00:00.000")];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(1);
  });

  it("session 1ms before range start is excluded", () => {
    // Sunday Jun 7 23:59:59.999 — belongs to last week
    const sessions = [session("2026-06-07T23:59:59.999")];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(0);
    expect(digest.lastWeek.sessions).toBe(1);
  });
});

/* ================================================================== */
/*  getDigest — delta calculations                                     */
/* ================================================================== */

describe("getDigest — delta calculations", () => {
  // Current week = Mon Jun 8 – Sun Jun 14
  // Last week    = Mon Jun 1 – Sun Jun 7
  const NOW = new Date(2026, 5, 10, 12, 0, 0);

  it("positive delta: 6 this week vs 5 last week = +20%", () => {
    const sessions = [
      // Last week (5 sessions)
      session("2026-06-01T10:00:00"),
      session("2026-06-02T10:00:00"),
      session("2026-06-03T10:00:00"),
      session("2026-06-04T10:00:00"),
      session("2026-06-05T10:00:00"),
      // This week (6 sessions)
      session("2026-06-08T10:00:00"),
      session("2026-06-09T10:00:00"),
      session("2026-06-10T10:00:00"),
      session("2026-06-11T10:00:00"),
      session("2026-06-12T10:00:00"),
      session("2026-06-13T10:00:00"),
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(6);
    expect(digest.lastWeek.sessions).toBe(5);
    expect(digest.deltaSessionsPct).toBeCloseTo(20);
  });

  it("negative delta: 2 this week vs 4 last week = -50%", () => {
    const sessions = [
      // Last week (4)
      session("2026-06-01T10:00:00"),
      session("2026-06-02T10:00:00"),
      session("2026-06-03T10:00:00"),
      session("2026-06-04T10:00:00"),
      // This week (2)
      session("2026-06-08T10:00:00"),
      session("2026-06-09T10:00:00"),
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.deltaSessionsPct).toBeCloseTo(-50);
  });

  it("zero last week → delta is null (avoids division by zero)", () => {
    const sessions = [
      // Only this week
      session("2026-06-08T10:00:00"),
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.deltaSessionsPct).toBeNull();
    expect(digest.deltaDurationPct).toBeNull();
  });

  it("identical periods → delta is 0%", () => {
    const sessions = [
      // Last week (3)
      session("2026-06-01T10:00:00"),
      session("2026-06-02T10:00:00"),
      session("2026-06-03T10:00:00"),
      // This week (3)
      session("2026-06-08T10:00:00"),
      session("2026-06-09T10:00:00"),
      session("2026-06-10T10:00:00"),
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.deltaSessionsPct).toBeCloseTo(0);
  });
});

/* ================================================================== */
/*  getDigest — empty / edge inputs                                    */
/* ================================================================== */

describe("getDigest — empty/edge inputs", () => {
  const NOW = new Date(2026, 5, 10, 12, 0, 0);

  it("empty session array returns zeroed stats", () => {
    const digest = getDigest([], NOW);
    expect(digest.currentWeek.sessions).toBe(0);
    expect(digest.currentWeek.totalDuration).toBe(0);
    expect(digest.currentWeek.avgDuration).toBe(0);
    expect(digest.lastWeek.sessions).toBe(0);
    expect(digest.currentMonth.sessions).toBe(0);
    expect(digest.deltaSessionsPct).toBeNull();
    expect(digest.deltaDurationPct).toBeNull();
  });

  it("all sessions outside any range returns 0 for every period", () => {
    const sessions = [
      session("2025-01-01T10:00:00"), // way in the past
      session("2027-12-31T10:00:00"), // way in the future
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(0);
    expect(digest.lastWeek.sessions).toBe(0);
    expect(digest.currentMonth.sessions).toBe(0);
  });

  it("sessions with missing createdAt are gracefully skipped", () => {
    const sessions = [
      { createdAt: "", status: "completed" as const },
      { createdAt: "not-a-date", status: "completed" as const },
      session("2026-06-09T10:00:00"), // valid — in current week
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentWeek.sessions).toBe(1);
  });
});

/* ================================================================== */
/*  getDigest — month aggregation                                      */
/* ================================================================== */

describe("getDigest — month aggregation", () => {
  // Fixed reference: Wednesday 2026-06-10
  // Current month = Jun 1 – Jun 30
  const NOW = new Date(2026, 5, 10, 12, 0, 0);

  it("counts sessions in current month correctly", () => {
    const sessions = [
      session("2026-06-01T00:00:00"), // in
      session("2026-06-15T12:00:00"), // in
      session("2026-06-30T23:59:59"), // in
      session("2026-05-31T23:59:59"), // out (May)
      session("2026-07-01T00:00:00"), // out (July)
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentMonth.sessions).toBe(3);
  });

  it("month range doesn't leak into adjacent months", () => {
    const sessions = [
      session("2026-05-31T23:59:59.999"), // last ms of May — out
      session("2026-07-01T00:00:00.000"), // first ms of July — out
    ];
    const digest = getDigest(sessions, NOW);
    expect(digest.currentMonth.sessions).toBe(0);
  });
});
