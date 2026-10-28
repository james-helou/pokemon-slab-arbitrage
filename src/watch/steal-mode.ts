import type { Settings } from '../settings/settings.js';

/** Steal alerts (US BIN + CA scans, old auction scan, outcome tracking). Off since the watchlist pivot. */
export function stealJobsEnabled(s: Pick<Settings, 'stealMode'>): boolean {
  return s.stealMode;
}

/** Runs a steal job only while stealMode is on. Settings are read each run, so a DB flip needs no deploy. */
export async function whenStealMode<T>(
  load: () => Promise<Pick<Settings, 'stealMode'>>,
  job: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (!stealJobsEnabled(await load())) return { ran: false };
  return { ran: true, result: await job() };
}
