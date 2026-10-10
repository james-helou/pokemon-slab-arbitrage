import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import type { Log } from '../../src/log.js';
import { createCaScan, type CaScanDeps } from '../../src/pipeline/ca-scan.js';
import { setSetting } from '../../src/settings/settings.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import type { EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const CA_ID = 'v1|147629684283|0';

function caSummary(over: Partial<EbayItemSummary> = {}): EbayItemSummary {
  return {
    ...SUMMARY, itemId: CA_ID, legacyItemId: '147629684283', itemWebUrl: 'https://www.ebay.ca/itm/147629684283',
    price: { value: '630.00', currency: 'CAD' },
    shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '28.00', currency: 'CAD' } }],
    buyingOptions: ['FIXED_PRICE'], ...over,
  };
}

async function setup(opts: { used?: number; results?: EbayItemSummary[]; rates?: (number | null)[]; ask?: string; bo?: boolean } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 2000 });
  const calls = { search: 0, getItem: 0 };
  const logs: { level: string; msg: string }[] = [];
  const log: Log = (level, msg) => { logs.push({ level, msg }); };
  const rates = [...(opts.rates ?? [1.4])];
  const budget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => opts.used ?? 0 };
  const bo = opts.bo ? ['FIXED_PRICE', 'BEST_OFFER'] : ['FIXED_PRICE'];
  const deps: CaScanDeps = {
    db, budget, log,
    ebay: {
      searchNewGraded: async () => { calls.search++; return opts.results ?? [caSummary({ buyingOptions: bo, price: { value: opts.ask ?? '630.00', currency: 'CAD' } })]; },
      searchEndingAuctions: async () => [],
      getItem: async (id) => {
        calls.getItem++;
        return { ...ITEM, ...caSummary({ itemId: id, buyingOptions: bo, price: { value: opts.ask ?? '630.00', currency: 'CAD' } }) };
      },
    },
    usdCad: async () => (rates.length > 1 ? rates.shift()! : rates[0]!),
    valuate: async (key) => ({
      ...key, value: 600, low: 590, high: 610, compCount: 6, newestCompAgeDays: 1, confidence: 0.9,
      compsSource: 'ppt', oracleVersion: 'v1.0.0', computedAt: NOW,
    }),
    now: () => NOW,
  };
  return { db, deps, calls, logs };
}

describe('caScan', () => {
  it('is paused / disabled / throttled before any search', async () => {
    const a = await setup();
    await setSetting(a.db, 'paused', true);
    expect((await createCaScan(a.deps)()).status).toBe('paused');
    const b = await setup();
    await setSetting(b.db, 'caScan', false);
    expect((await createCaScan(b.deps)()).status).toBe('disabled');
    const c = await setup({ used: 4000 });
    expect((await createCaScan(c.deps)()).status).toBe('throttled');
    expect(a.calls.search + b.calls.search + c.calls.search).toBe(0);
  });

  it('stores a C$630 listing as US$450 with the original and origin ca_bin', async () => {
    const { db, deps } = await setup();
    const r = await createCaScan(deps)();
    expect(r).toMatchObject({ status: 'ok', seen: 1, new: 1, errors: 0 });
    const { rows } = await db.query<{ price: string; original_price: string; origin: string }>(
      'select price, original_price, origin from listings',
    );
    expect(rows.map((x) => ({ price: Number(x.price), original: Number(x.original_price), origin: x.origin }))).toEqual([
      { price: 450, original: 630, origin: 'ca_bin' },
    ]);
  });

  it('fails closed without a rate and warns once per outage', async () => {
    const { deps, calls, logs } = await setup({ rates: [null] });
    const scan = createCaScan(deps);
    expect((await scan()).status).toBe('no_fx');
    expect((await scan()).status).toBe('no_fx');
    expect(calls.search).toBe(0);
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1);
  });

  it('warns again when the rate fails after a success', async () => {
    const { deps, logs } = await setup({ rates: [null, null, 1.4, null] });
    const scan = createCaScan(deps);
    await scan();
    await scan();
    expect((await scan()).status).toBe('ok');
    await scan();
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(2);
  });

  it('skips an item owned by the US scan and leaves its price alone', async () => {
    const { db, deps, calls } = await setup();
    await upsertListing(db, summaryToListing({ ...SUMMARY, itemId: CA_ID })!, NOW);
    const r = await createCaScan(deps)();
    expect(r.outcomes).toEqual({});
    expect(calls.getItem).toBe(0);
    const { rows } = await db.query<{ price: string; origin: string }>('select price, origin from listings');
    expect(rows.map((x) => ({ price: Number(x.price), origin: x.origin }))).toEqual([{ price: 350, origin: 'us_bin' }]);
  });

  it('keeps FIXED_PRICE+AUCTION items with no bids while auction mode is on', async () => {
    const { db, deps } = await setup({ results: [caSummary({ buyingOptions: ['FIXED_PRICE', 'AUCTION'] })] });
    await createCaScan(deps)();
    expect((await db.query('select 1 from listings')).rows).toHaveLength(1);
  });

  it('skips bid-on and auction-only items while auction mode is on', async () => {
    const { db, deps } = await setup({
      results: [
        caSummary({ buyingOptions: ['FIXED_PRICE', 'AUCTION'], bidCount: 1 }),
        caSummary({ itemId: 'v1|999|0', buyingOptions: ['AUCTION'] }),
      ],
    });
    await createCaScan(deps)();
    expect((await db.query('select 1 from listings')).rows).toHaveLength(0);
  });

  it('suggests an offer for a Best Offer CA listing (ask C$630 = US$450, ship C$28 = US$20)', async () => {
    const { db, deps } = await setup({ bo: true });
    const r = await createCaScan(deps)();
    expect(r.outcomes).toEqual({ recommended: 1 });
    const { rows } = await db.query<{ kind: string; suggested_price: string }>('select kind, suggested_price from recommendations');
    expect(rows.map((x) => ({ kind: x.kind, suggested: Number(x.suggested_price) }))).toEqual([{ kind: 'offer', suggested: 350 }]);
  });
});
