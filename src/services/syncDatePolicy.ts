/** Inclusive calendar-date range in the ad account's reporting timezone. */
export interface SyncDateRange {
  startDate: string;
  endDate: string;
}

export interface SyncDatePolicy {
  /** Already resolved in the reporting timezone, not the server's local date. */
  today: string;
  lastSyncedAt?: Date | null;
  lookbackDays?: number;
  defaultLookbackDays: number;
  initialHistory?: boolean;
}

const MAX_SYNC_DAYS = 62;

/**
 * A new store starts at the first day of the previous calendar month. Explicit
 * lookbackDays retains its old precedence; existing stores otherwise use the
 * short rolling refresh. initialHistory lets an operator repair a store that
 * had already completed a short sync before this policy was introduced.
 */
export function planSyncDateRange(policy: SyncDatePolicy): SyncDateRange {
  const today = parseCalendarDate(policy.today);
  if (policy.lookbackDays === undefined && (policy.initialHistory || policy.lastSyncedAt == null)) {
    today.setUTCDate(1);
    today.setUTCMonth(today.getUTCMonth() - 1);
    return { startDate: isoDate(today), endDate: policy.today };
  }

  const days = policy.lookbackDays ?? policy.defaultLookbackDays;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SYNC_DAYS) {
    throw new Error(`Sync lookbackDays must be an integer between 1 and ${MAX_SYNC_DAYS}`);
  }
  today.setUTCDate(today.getUTCDate() - (days - 1));
  return { startDate: isoDate(today), endDate: policy.today };
}

/** Split into nonoverlapping, inclusive API windows, including the final day. */
export function splitSyncDateRange(range: SyncDateRange, maxDays = 30): SyncDateRange[] {
  const cursor = parseCalendarDate(range.startDate);
  const end = parseCalendarDate(range.endDate);
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 30) {
    throw new Error("Sync request windows must contain between 1 and 30 calendar days");
  }
  if (cursor > end) throw new Error("Sync startDate must not be after endDate");

  const windows: SyncDateRange[] = [];
  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + maxDays - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    windows.push({ startDate: isoDate(cursor), endDate: isoDate(windowEnd) });
    cursor.setTime(windowEnd.getTime());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function parseCalendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Expected a YYYY-MM-DD reporting date");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || isoDate(date) !== value) {
    throw new Error("Invalid reporting calendar date");
  }
  return date;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
