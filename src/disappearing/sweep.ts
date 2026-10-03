import type { Db } from '../db/db.js';
import { markGone, markSeenLive } from '../listings/listings-repo.js';
import type { Log } from '../log.js';
import { loadSettings } from '../settings/settings.js';
import { claimAuxCall } from '../sources/ebay/aux-budget.js';
import type { Budget } from '../sources/ebay/budget.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { isOutOfStock } from '../sources/ebay/normalize.js';
import { recordDisappearingComps } from './comps-writer.js';

/** A listing confirmed live is not re-checked for this long, even if it keeps missing from search. */
export const RECHECK_COOLDOWN_HOURS = 6;
const MAX_SUSPECTS_PER_RUN = 500;
/** How often the kill switch is re-read during a run, so /pause takes effect mid-sweep. */
const PAUSE_CHECK_EVERY = 10;

export interface SweepDeps {
  db: Db;
  ebay: Pick<EbayClient, 'getItem'>;
  /** Main eBay budget; aux calls stop at 80% of it. */
  budget: Budget;
  now: () => Date;
  log: Log;
}

export interface SweepSummary {
  status: 'ok' | 'paused';
  suspects: number;
  soldOut: number;
  notFound: number;
  stillLive: number;
  unconfirmed: number;
  deferred: number;
  compsWritten: number;
}

interface Suspect {
  externalId: string;
  price: number;
  lastSeenAt: Date;
  cardId: string | null;
  confidence: number | null;
  gradeLabel: string | null;
}

async function listSuspects(db: Db, minMisses: number, now: Date): Promise<Suspect[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select l.external_id, l.price, l.last_seen_at, m.card_id, m.confidence, m.grade_label
     from listings l
     left join lateral (
       select card_id, confidence, grade_label from listing_matches lm
       where lm.source = l.source and lm.external_id = l.external_id
       order by (lm.stage = 'enriched') desc, lm.id desc
       limit 1
     ) m on true
     where l.source = 'ebay' and l.currency = 'USD' and l.gone_at is null and l.miss_count >= $1
       and (l.checked_at is null or l.checked_at < $2)
     order by l.price desc
     limit ${MAX_SUSPECTS_PER_RUN}`,
    [minMisses, new Date(now.getTime() - RECHECK_COOLDOWN_HOURS * 3_600_000)],
  );
  return rows.map((r) => ({
    externalId: String(r.external_id),
    price: Number(r.price),
    lastSeenAt: new Date(r.last_seen_at as string),
    cardId: (r.card_id as string | null | undefined) ?? null,
    confidence: r.confidence === null || r.confidence === undefined ? null : Number(r.confidence),
    gradeLabel: (r.grade_label as string | null | undefined) ?? null,
  }));
}

/**
 * Classifies listings that missed >= disappearMissScans scans:
 * - not worth a call (no confident label-free match, below disappearMinPrice) or too stale -> gone 'window_miss', no comp;
 * - otherwise one budgeted getItem: 404 -> 'not_found', OUT_OF_STOCK -> 'out_of_stock', live -> reset + cooldown.
 * Then writes disappearing_bin comps for every confirmed disappearance (including ones found by evaluate/outcomes).
 * Re-reads `paused` every 10 suspects and stops early (status 'paused') when it is set.
 */
export async function sweepDisappeared(deps: SweepDeps): Promise<SweepSummary> {
  const s: SweepSummary = {
    status: 'ok', suspects: 0, soldOut: 0, notFound: 0, stillLive: 0, unconfirmed: 0, deferred: 0, compsWritten: 0,
  };
  const settings = await loadSettings(deps.db);
  if (settings.paused) return { ...s, status: 'paused' };

  const suspects = await listSuspects(deps.db, settings.disappearMissScans, deps.now());
  s.suspects = suspects.length;
  const maxAgeMs = settings.disappearConfirmMaxAgeHours * 3_600_000;
  let budgetLeft = true;
  for (const [i, l] of suspects.entries()) {
    if (i > 0 && i % PAUSE_CHECK_EVERY === 0 && (await loadSettings(deps.db)).paused) {
      // Stop without writing comps: the next unpaused run records every confirmed disappearance.
      return { ...s, status: 'paused' };
    }
    const ref = { source: 'ebay' as const, externalId: l.externalId };
    const worthACall =
      l.cardId !== null && l.gradeLabel === null && l.confidence !== null &&
      l.confidence >= settings.minMatchConfidence && l.price >= settings.disappearMinPrice;
    const stale = deps.now().getTime() - l.lastSeenAt.getTime() > maxAgeMs;
    if (!worthACall || stale) {
      await markGone(deps.db, ref, deps.now(), 'window_miss');
      s.unconfirmed++;
      continue;
    }
    if (!budgetLeft) {
      s.deferred++;
      continue;
    }
    if (!(await claimAuxCall(deps.db, deps.budget, settings.auxGetItemDailyCap, deps.now))) {
      budgetLeft = false;
      s.deferred++;
      continue;
    }
    try {
      const item = await deps.ebay.getItem(l.externalId);
      if (!item) {
        await markGone(deps.db, ref, deps.now(), 'not_found');
        s.notFound++;
      } else if (isOutOfStock(item)) {
        await markGone(deps.db, ref, deps.now(), 'out_of_stock');
        s.soldOut++;
      } else {
        await markSeenLive(deps.db, ref, deps.now());
        s.stillLive++;
      }
    } catch (err) {
      s.deferred++;
      deps.log('warn', 'disappearance check failed', {
        externalId: l.externalId, err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  s.compsWritten = await recordDisappearingComps(deps.db, settings.minMatchConfidence, deps.now());
  return s;
}
