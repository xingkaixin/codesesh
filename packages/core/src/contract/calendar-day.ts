/**
 * Local calendar days, the unit the dashboard and its time windows are defined
 * in. A calendar day is not a fixed duration: across a DST transition adjacent
 * local midnights are 23 or 25 hours apart, so stepping by a constant number of
 * milliseconds skips or repeats a day. Every helper here advances date fields
 * instead.
 */

/** Local midnight of the calendar day containing `timestamp`. */
export function startOfCalendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local midnight `days` calendar days from the day containing `timestamp`. */
export function addCalendarDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

/** Days since the epoch for a local calendar date, counted on a fixed-length UTC grid. */
function toCalendarDayNumber(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** Calendar days in the inclusive local range, at least 1. */
export function countCalendarDays(from: number, to: number): number {
  return Math.max(1, toCalendarDayNumber(to) - toCalendarDayNumber(from) + 1);
}

/** `YYYY-MM-DD` key for the local calendar day; the dashboard wire format. */
export function toCalendarDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(date.getDate()).padStart(2, "0")}`;
}
