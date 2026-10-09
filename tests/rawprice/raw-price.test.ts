import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { silentLog } from '../../src/log.js';
import { getRawPrice } from '../../src/rawprice/raw-price.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const FIXTURE = JSON.parse(readFileSync('tests/fixtures/tcgdex/card-pricing.json', 'utf8'));
const CARD = 'sv03.5-199';

function fakeFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function setup(f: typeof fetch, now = NOW) {
  const db = await createTestDb();
  await seedCards(db);
  const warns: string[] = [];
  const log = (level: string, msg: string) => { if (level === 'warn') warns.push(msg); };
  return { db, warns, deps: { db, fetch: f, now: () => now, log: log as never } };
}

describe('getRawPrice', () => {
  it('takes the max marketPrice over variants, excluding reverse and 1st edition', async () => {
    const f = fakeFetch(FIXTURE);
    const { deps, db } = await setup(f.fn);
    expect(await getRawPrice(deps, CARD)).toBe(2351.42);
    expect(f.calls[0]).toBe(`https://api.tcgdex.net/v2/en/cards/${CARD}`);
    const { rows } = await db.query<{ source: string }>('select source from card_raw_prices where card_id = $1', [CARD]);
    expect(rows[0]!.source).toBe('tcgdex:tcgplayer');
  });

  it('serves a cache hit younger than 3 days and refetches an older one', async () => {
    const f = fakeFetch(FIXTURE);
    const { deps, db } = await setup(f.fn);
    await getRawPrice(deps, CARD);
    await getRawPrice(deps, CARD);
    expect(f.calls).toHaveLength(1);
    const later = fakeFetch({ pricing: { tcgplayer: { normal: { marketPrice: 50 } } } });
    const stale = { ...deps, fetch: later.fn, now: () => new Date(NOW.getTime() + 3 * 86_400_000 + 1000) };
    expect(await getRawPrice(stale, CARD)).toBe(50);
    expect(later.calls).toHaveLength(1);
    void db;
  });

  it('negative-caches a card with no pricing', async () => {
    const f = fakeFetch({ id: CARD });
    const { deps } = await setup(f.fn);
    expect(await getRawPrice(deps, CARD)).toBeNull();
    expect(await getRawPrice(deps, CARD)).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('ignores non-object, non-positive and excluded-only variants', async () => {
    const f = fakeFetch({ pricing: { tcgplayer: { unit: 'USD', updated: 'x', normal: { marketPrice: 0 }, reverseHolofoil: { marketPrice: 5 } } } });
    const { deps } = await setup(f.fn);
    expect(await getRawPrice(deps, CARD)).toBeNull();
  });

  it('returns null and caches nothing on http failure, 404, or a thrown fetch', async () => {
    for (const f of [fakeFetch({}, 500), fakeFetch({}, 404)]) {
      const { deps, db, warns } = await setup(f.fn);
      expect(await getRawPrice(deps, CARD)).toBeNull();
      const { rows } = await db.query('select 1 from card_raw_prices');
      expect(rows).toHaveLength(0);
      expect(warns).toHaveLength(1);
    }
    const boom = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const { deps, db } = await setup(boom);
    expect(await getRawPrice(deps, CARD)).toBeNull();
    expect((await db.query('select 1 from card_raw_prices')).rows).toHaveLength(0);
  });
});

void silentLog;
