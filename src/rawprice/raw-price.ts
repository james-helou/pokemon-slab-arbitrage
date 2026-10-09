import type { Db } from '../db/db.js';
import type { Log } from '../log.js';

const TCGDEX = 'https://api.tcgdex.net/v2/en';
const TIMEOUT_MS = 15_000;
const TTL_MS = 3 * 86_400_000;
const SOURCE = 'tcgdex:tcgplayer';
/** Variants that are not the plain card a graded slab competes with. */
const EXCLUDED_VARIANT = /reverse|1st|first/i;

export interface RawPriceDeps {
  db: Db;
  fetch: typeof fetch;
  now: () => Date;
  log: Log;
}

function pickRaw(body: unknown): number | null {
  const tcg = (body as { pricing?: { tcgplayer?: unknown } } | null)?.pricing?.tcgplayer;
  if (!tcg || typeof tcg !== 'object') return null;
  let best: number | null = null;
  for (const [name, v] of Object.entries(tcg)) {
    if (EXCLUDED_VARIANT.test(name) || !v || typeof v !== 'object') continue;
    const p = (v as { marketPrice?: unknown }).marketPrice;
    if (typeof p === 'number' && Number.isFinite(p) && p > 0 && (best === null || p > best)) best = p;
  }
  return best;
}

/**
 * Free TCGdex (TCGplayer market) raw price for a card, cached 3 days (a null result is cached too). Best-effort:
 * any fetch/parse failure logs one key-free warn line, caches nothing and returns null. Never throws.
 */
export async function getRawPrice(deps: RawPriceDeps, cardId: string): Promise<number | null> {
  try {
    const now = deps.now();
    const cached = await deps.db.query<{ raw_usd: string | number | null; fetched_at: string | Date }>(
      'select raw_usd, fetched_at from card_raw_prices where card_id = $1', [cardId],
    );
    const hit = cached.rows[0];
    if (hit && now.getTime() - new Date(hit.fetched_at).getTime() < TTL_MS) {
      return hit.raw_usd === null ? null : Number(hit.raw_usd);
    }
    const res = await deps.fetch(`${TCGDEX}/cards/${encodeURIComponent(cardId)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const raw = pickRaw(await res.json());
    await deps.db.query(
      `insert into card_raw_prices (card_id, raw_usd, source, fetched_at) values ($1, $2, $3, $4)
       on conflict (card_id) do update set raw_usd = excluded.raw_usd, source = excluded.source, fetched_at = excluded.fetched_at`,
      [cardId, raw, SOURCE, now],
    );
    return raw;
  } catch (err) {
    deps.log('warn', 'tcgdex raw price failed', { cardId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
