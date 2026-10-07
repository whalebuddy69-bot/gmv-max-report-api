import { describe, expect, it } from "vitest";
import { planSyncDateRange, splitSyncDateRange } from "./syncDatePolicy";

const existingSync = new Date("2026-10-01T00:00:00Z");

describe("initial store history policy", () => {
  it.each([
    ["2026-10-07", "2026-09-01"],
    ["2026-01-07", "2025-12-01"],
    ["2024-03-01", "2024-02-01"],
    ["2025-03-31", "2025-02-01"],
    ["2026-08-31", "2026-07-01"],
  ])("starts an unsynced store on the previous month boundary: %s", (today, startDate) => {
    expect(planSyncDateRange({ today, lastSyncedAt: null, defaultLookbackDays: 3 })).toEqual({
      startDate,
      endDate: today,
    });
  });

  it("treats an omitted lastSyncedAt as a new store", () => {
    expect(planSyncDateRange({ today: "2026-10-07", defaultLookbackDays: 3 }).startDate).toBe("2026-09-01");
  });

  it("uses the short rolling window only after a successful initial sync", () => {
    expect(planSyncDateRange({ today: "2026-10-07", lastSyncedAt: existingSync, defaultLookbackDays: 3 })).toEqual({
      startDate: "2026-10-05", endDate: "2026-10-07",
    });
  });

  it("can explicitly repair history for an already short-synced store", () => {
    expect(planSyncDateRange({ today: "2026-10-07", lastSyncedAt: existingSync, initialHistory: true, defaultLookbackDays: 3 }).startDate).toBe("2026-09-01");
  });

  it.each([null, existingSync])("preserves an explicit 30-day override for any store", (lastSyncedAt) => {
    expect(planSyncDateRange({ today: "2026-10-07", lastSyncedAt, lookbackDays: 30, defaultLookbackDays: 3 })).toEqual({
      startDate: "2026-09-08", endDate: "2026-10-07",
    });
  });

  it("keeps explicit day precedence even for a direct internal call with initialHistory", () => {
    expect(planSyncDateRange({ today: "2026-10-07", lookbackDays: 1, initialHistory: true, defaultLookbackDays: 3 }).startDate).toBe("2026-10-07");
  });

  it("supports the full 62-day maximum across two 31-day months", () => {
    const range = planSyncDateRange({ today: "2026-08-31", lastSyncedAt: existingSync, lookbackDays: 62, defaultLookbackDays: 3 });
    expect(range).toEqual({ startDate: "2026-07-01", endDate: "2026-08-31" });
  });

  it.each([0, -1, 1.5, 63, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid lookback %s", (lookbackDays) => {
    expect(() => planSyncDateRange({ today: "2026-10-07", lookbackDays, defaultLookbackDays: 3 })).toThrow(/lookbackDays/);
  });

  it.each(["2026-02-29", "2026-04-31", "2026-13-01", "2026-1-01", "not-a-date"])("rejects invalid reporting dates %s", (today) => {
    expect(() => planSyncDateRange({ today, defaultLookbackDays: 3 })).toThrow();
  });
});

describe("inclusive API window splitting", () => {
  it("splits September and partial October with no duplicated boundary day", () => {
    expect(splitSyncDateRange({ startDate: "2026-09-01", endDate: "2026-10-07" })).toEqual([
      { startDate: "2026-09-01", endDate: "2026-09-30" },
      { startDate: "2026-10-01", endDate: "2026-10-07" },
    ]);
  });

  it.each([
    ["2026-01-01", "2026-01-01", 1],
    ["2026-01-01", "2026-01-30", 1],
    ["2026-01-01", "2026-01-31", 2],
    ["2024-02-01", "2024-03-31", 2],
    ["2026-07-01", "2026-08-31", 3],
    ["2025-12-01", "2026-01-31", 3],
  ])("covers every day exactly once for %s through %s", (startDate, endDate, expectedWindows) => {
    const windows = splitSyncDateRange({ startDate, endDate });
    expect(windows).toHaveLength(expectedWindows);
    const dates: string[] = [];
    for (const window of windows) {
      const cursor = new Date(`${window.startDate}T00:00:00Z`);
      const end = new Date(`${window.endDate}T00:00:00Z`);
      expect((end.getTime() - cursor.getTime()) / 86_400_000 + 1).toBeLessThanOrEqual(30);
      while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    const expectedDayCount = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
    expect(dates).toHaveLength(expectedDayCount);
    expect(new Set(dates).size).toBe(expectedDayCount);
    expect(dates[0]).toBe(startDate);
    expect(dates.at(-1)).toBe(endDate);
  });

  it("rejects a reversed range", () => {
    expect(() => splitSyncDateRange({ startDate: "2026-10-02", endDate: "2026-10-01" })).toThrow(/after/);
  });

  it.each([0, -1, 1.5, 31, Number.NaN])("does not allow oversized or invalid request windows %s", (maxDays) => {
    expect(() => splitSyncDateRange({ startDate: "2026-10-01", endDate: "2026-10-01" }, maxDays)).toThrow(/calendar days/);
  });
});
