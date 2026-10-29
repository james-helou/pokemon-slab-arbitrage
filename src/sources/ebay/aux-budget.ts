import type { Db } from '../../db/db.js';
import { BudgetExceededError, createBudget, type Budget } from './budget.js';

/** api_usage source row for getItem calls made outside scanning (disappearance confirmations, outcome checks). */
export const AUX_SOURCE = 'ebay_aux';
/** api_usage source row for the auction watchlist's getItem calls (matching + final checks), capped on its own. */
export const WATCH_SOURCE = 'ebay_watch';
/** Auxiliary calls stop once the main budget reaches this share, so scanning always keeps priority. */
export const AUX_MAIN_RESERVE_RATIO = 0.8;

/**
 * Claims one auxiliary getItem call. Returns false when today's aux cap is spent or the main budget is past the
 * reserve ratio; both are checked before anything is recorded, so a refusal normally costs nothing. Only a
 * concurrent race past the cap can leave the aux counter one over (beforeCall increments, then throws). The call itself still goes through the eBay client, so it also counts
 * against the main budget. `source` names the counter (default the shared AUX_SOURCE; the watchlist uses WATCH_SOURCE).
 */
export async function claimAuxCall(
  db: Db, main: Budget, cap: number, now: () => Date, source: string = AUX_SOURCE,
): Promise<boolean> {
  if ((await main.usedToday()) >= main.limit * AUX_MAIN_RESERVE_RATIO) return false;
  const aux = createBudget(db, source, cap, now);
  if ((await aux.usedToday()) >= cap) return false;
  try {
    await aux.beforeCall();
    return true;
  } catch (err) {
    if (err instanceof BudgetExceededError) return false;
    throw err;
  }
}
