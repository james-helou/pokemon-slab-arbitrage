const DAY_MS = 86_400_000;

/** ISO-8601 week label (UTC), e.g. 2026-W40. Weeks start Monday; week 1 contains the year's first Thursday. */
export function isoWeekOf(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** [start, end) of an ISO week in UTC. Throws on malformed or non-existent weeks (e.g. 2025-W53). */
export function isoWeekRange(label: string): { start: Date; end: Date } {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`Invalid ISO week: ${label}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4Dow = new Date(Date.UTC(year, 0, 4)).getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (jan4Dow - 1));
  const start = new Date(week1Monday + (week - 1) * 7 * DAY_MS);
  if (week < 1 || isoWeekOf(start) !== label) throw new Error(`Invalid ISO week: ${label}`);
  return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
}

/** The most recent complete ISO week before `now`. */
export function previousIsoWeek(now: Date): string {
  return isoWeekOf(new Date(now.getTime() - 7 * DAY_MS));
}
