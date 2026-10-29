import { describe, expect, it, vi } from 'vitest';
import type { AlertPayload } from '../../src/discord/alert-payload.js';
import { silentLog } from '../../src/log.js';
import { setSetting } from '../../src/settings/settings.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import type { EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import type { SourceReader } from '../../src/watch/market-value.js';
import { watchScan, type WatchScanDeps } from '../../src/watch/watch-scan.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const T0 = new Date('2026-10-28T12:00:00Z');
const END = new Date(T0.getTime() + 120 * 60_000);

function auction(id: string, bid: number, bids: number, over: Partial<EbayItemSummary> = {}): EbayItemSummary {
  const rest: Partial<EbayItemSummary> = { ...SUMMARY };
  delete rest.price;
  delete rest.shippingOptions;
  return {
    ...(rest as EbayItemSummary), itemId: id, itemWebUrl: `https://www.ebay.com/itm/${id}`, buyingOptions: ['AUCTION'],
    currentBidPrice: { value: bid.toFixed(2), currency: 'USD' }, bidCount: bids, itemEndDate: END.toISOString(), ...over,
  };
}

async function setup(opts: { used?: number; value?: number | null | 'deferred' } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  const state = {
    now: T0,
    results: [auction('A1', 3000, 5), auction('A2', 2100, 3)] as EbayItemSummary[],
    complete: true,
    searchFails: false,
    /** getItem overrides by id; default: the current search summary with the fixture aspects. */
    items: {} as Record<string, EbayItemSummary | null>,
    sendFails: false,
  };
  const calls = { search: 0, getItem: [] as string[], searchArgs: [] as unknown[] };
  const sent: AlertPayload[] = [];
  const budget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => opts.used ?? 0 };
  const value = opts.value === undefined ? 2000 : opts.value;
  const reader: SourceReader = async () =>
    value === null || value === 'deferred' ? value : { name: 'ppt', value, saleCount: 12, asOf: T0 };
  const deps: WatchScanDeps = {
    db, budget, readers: [reader], log: silentLog, now: () => state.now,
    ebay: {
      searchLiveAuctions: async (o) => {
        calls.search++;
        calls.searchArgs.push(o);
        if (state.searchFails) throw new Error('eBay search 500');
        return { items: state.results, complete: state.complete };
      },
      getItem: async (id) => {
        calls.getItem.push(id);
        const over = id in state.items ? state.items[id] : state.results.find((r) => r.itemId === id) ?? auction(id, 3000, 5);
        return over === null ? null : { ...ITEM, ...over };
      },
    },
    send: async (p) => {
      if (state.sendFails) throw new Error('discord down');
      sent.push(p);
      return `msg${sent.length}`;
    },
    usdCad: async () => 1.4,
  };
  return { db, deps, state, calls, sent };
}

async function row(db: Awaited<ReturnType<typeof createTestDb>>, id: string) {
  const { rows } = await db.query<Record<string, unknown>>(`select * from watch_auctions where external_id = $1`, [id]);
  return rows[0];
}

describe('watchScan', () => {
  it('searches with the watch settings and alerts once on a bid well above market value', async () => {
    const { db, deps, calls, sent } = await setup();
    const s = await watchScan(deps);
    expect(s).toEqual({ status: 'ok', seen: 2, candidates: 2, matched: 2, alerts: 1, realerts: 0, deferred: 0, finalized: 0, errors: 0 });
    expect(calls.searchArgs).toEqual([{ windowHours: 72, minBid: 300, maxPages: 3 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.embeds[0]!.title).toBe('Bid above market: Charizard ex PSA 10');
    expect(JSON.stringify(sent[0])).toContain('C$4,200.00');
    const r = await row(db, 'A1');
    expect(r).toMatchObject({ match_status: 'ok', card_id: 'sv03.5-199', grader: 'PSA' });
    expect(Number(r!.alerted_bid)).toBe(3000);
    expect(Number(r!.value_at_alert)).toBe(2000);
    expect((r!.sources_at_alert as { name: string }[])[0]!.name).toBe('ppt');
    expect((await row(db, 'A2'))!.alerted_at).toBeNull();
    expect(calls.getItem.sort()).toEqual(['A1', 'A2']);
  });

  it('re-alerts once when the bid climbs another 25%, then stays quiet', async () => {
    const { deps, state, calls, sent } = await setup();
    await watchScan(deps);
    state.results = [auction('A1', 3800, 7)];
    expect((await watchScan(deps)).realerts).toBe(1);
    expect(sent[1]!.embeds[0]!.title).toBe('Still climbing: Charizard ex PSA 10');
    state.results = [auction('A1', 5000, 9)];
    const third = await watchScan(deps);
    expect(third).toMatchObject({ alerts: 0, realerts: 0 });
    expect(sent).toHaveLength(2);
    expect(calls.getItem.filter((id) => id === 'A1')).toHaveLength(1);
  });

  it('never matches or sends a 1-bid auction', async () => {
    const { db, deps, state, calls, sent } = await setup();
    state.results = [auction('A1', 3000, 1)];
    const s = await watchScan(deps);
    expect(s).toMatchObject({ seen: 1, candidates: 0, matched: 0 });
    expect(calls.getItem).toEqual([]);
    expect(sent).toEqual([]);
    expect(await row(db, 'A1')).toBeUndefined();
  });

  it('stores an unmatched title with its reason, spends no getItem and never retries it', async () => {
    const { db, deps, state, calls } = await setup();
    state.results = [auction('A1', 3000, 5, { title: 'Pokemon mystery lot of 50 cards' })];
    await watchScan(deps);
    expect((await row(db, 'A1'))!.match_status).toMatch(/^no_match:/);
    await watchScan(deps);
    expect(calls.getItem).toEqual([]);
  });

  it('records a changed enriched match and never alerts on it', async () => {
    const { db, deps, state, sent } = await setup();
    state.results = [auction('A1', 3000, 5)];
    state.items = { A1: { ...auction('A1', 3000, 5, { title: SUMMARY.title.replace('PSA 10', 'PSA 9') }), localizedAspects: [...ITEM.localizedAspects!.filter((a) => a.name !== 'Grade'), { name: 'Grade', value: '9' }] } as EbayItemSummary };
    await watchScan(deps);
    expect((await row(db, 'A1'))!.match_status).toBe('match_changed');
    expect(sent).toEqual([]);
  });

  it('leaves the auction unmatched for retry when the watch getItem cap is spent', async () => {
    const { db, deps, calls } = await setup();
    await setSetting(db, 'watchGetItemDailyCap', 0);
    const s = await watchScan(deps);
    expect(s.matched).toBe(0);
    expect(calls.getItem).toEqual([]);
    expect((await row(db, 'A1'))!.match_status).toBeNull();
  });

  it('uses its own getItem counter, not the shared aux cap', async () => {
    const { db, deps, calls } = await setup();
    await setSetting(db, 'auxGetItemDailyCap', 0);
    expect((await watchScan(deps)).matched).toBe(2);
    expect(calls.getItem.sort()).toEqual(['A1', 'A2']);
    const usage = await db.query<{ source: string; calls: number }>('select source, calls from api_usage order by source');
    expect(usage.rows.map((r) => [r.source, Number(r.calls)])).toEqual([['ebay_watch', 2]]);
  });

  it('stops matching getItems for the pass at the per-pass limit; the rest match next pass', async () => {
    const { db, deps, calls } = await setup();
    await setSetting(db, 'watchGetItemsPerPass', 1);
    expect((await watchScan(deps)).matched).toBe(1);
    expect(calls.getItem).toHaveLength(1);
    expect(await watchScan(deps)).toMatchObject({ matched: 1 });
    expect(calls.getItem.sort()).toEqual(['A1', 'A2']);
    expect((await row(db, 'A2'))!.match_status).toBe('ok');
  });

  it('is paused / disabled / throttled before any search', async () => {
    const a = await setup();
    await setSetting(a.db, 'paused', true);
    expect((await watchScan(a.deps)).status).toBe('paused');
    const b = await setup();
    await setSetting(b.db, 'watchMode', false);
    expect((await watchScan(b.deps)).status).toBe('disabled');
    const c = await setup({ used: 4000 });
    expect((await watchScan(c.deps)).status).toBe('throttled');
    expect(a.calls.search + b.calls.search + c.calls.search).toBe(0);
  });

  it('sends nothing without a market value', async () => {
    const { deps, sent } = await setup({ value: null });
    const s = await watchScan(deps);
    expect(s).toMatchObject({ matched: 2, alerts: 0 });
    expect(sent).toEqual([]);
  });

  it('decides nothing while a source is deferred, and alerts once it has a value', async () => {
    const { deps, sent } = await setup({ value: 'deferred' });
    const s = await watchScan(deps);
    expect(s).toMatchObject({ matched: 2, alerts: 0, deferred: 2 });
    expect(sent).toEqual([]);
    deps.readers = [async () => ({ name: 'ppt', value: 2000, saleCount: 12, asOf: T0 })];
    expect((await watchScan(deps)).alerts).toBe(1);
  });

  it('skips the paid source when the free sources already put the bid below the gap', async () => {
    const { deps, sent } = await setup();
    const paid = vi.fn(async () => ({ name: 'ppt', value: 1000, saleCount: 12, asOf: T0 }));
    // A1 bid 3000 vs free 2900: fails the 25% gap whatever PPT says. A2 bid 2100 vs 2900: same.
    deps.readers = [async () => ({ name: 'own_sales', value: 2900, saleCount: 3, asOf: T0 }), paid];
    const s = await watchScan(deps);
    expect(s).toMatchObject({ matched: 2, alerts: 0, deferred: 0 });
    expect(paid).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('does not mark the auction alerted when the send fails, and alerts on the next pass', async () => {
    const { db, deps, state, sent } = await setup();
    state.sendFails = true;
    const s = await watchScan(deps);
    expect(s).toMatchObject({ alerts: 0, errors: 1 });
    expect((await row(db, 'A1'))!.alerted_at).toBeNull();
    state.sendFails = false;
    expect((await watchScan(deps)).alerts).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('sends one alert when two passes overlap (claim before send)', async () => {
    const { deps, sent } = await setup();
    const [a, b] = await Promise.all([watchScan(deps), watchScan(deps)]);
    expect(a.alerts + b.alerts).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('skips matching and alerting for an auction ending in under 3 minutes', async () => {
    const { deps, state, calls, sent } = await setup();
    state.results = [auction('A1', 3000, 5, { itemEndDate: new Date(T0.getTime() + 2 * 60_000).toISOString() })];
    await watchScan(deps);
    expect(calls.getItem).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refreshes the bid of a matched auction close to its end that the search no longer returned', async () => {
    const { db, deps, state, calls } = await setup();
    await watchScan(deps);
    state.now = new Date(END.getTime() - 5 * 60_000);
    state.results = [];
    state.items = { A1: auction('A1', 4100, 8), A2: null };
    calls.getItem = [];
    await watchScan(deps);
    expect(calls.getItem.sort()).toEqual(['A1', 'A2']);
    const r = await row(db, 'A1');
    expect(Number(r!.current_bid)).toBe(4100);
    expect(r!.bid_count).toBe(8);
  });

  it('finalizes an ended auction with its last bid and writes one auction_result comp', async () => {
    const { db, deps, state } = await setup();
    await watchScan(deps);
    // Last sighting inside the final window.
    state.now = new Date(END.getTime() - 5 * 60_000);
    await watchScan(deps);
    state.now = new Date(END.getTime() + 60_000);
    state.results = [];
    const s = await watchScan(deps);
    expect(s.finalized).toBe(2);
    expect(Number((await row(db, 'A1'))!.final_bid)).toBe(3000);
    expect((await watchScan(deps)).finalized).toBe(0);
    const { rows } = await db.query<{ price: string; kind: string; source_ref: string }>(
      `select price, kind, source_ref from comps where kind = 'auction_result' order by source_ref`,
    );
    expect(rows.map((r) => [Number(r.price), r.source_ref])).toEqual([[3000, 'ebay_auction:A1'], [2100, 'ebay_auction:A2']]);
  });

  it('finalizes without a comp when the last sighting was before the final window', async () => {
    const { db, deps, state } = await setup();
    await watchScan(deps); // seen 120 min before the end, never again
    state.now = new Date(END.getTime() + 60_000);
    state.results = [];
    expect((await watchScan(deps)).finalized).toBe(2);
    expect((await db.query(`select 1 from comps where kind = 'auction_result'`)).rows).toEqual([]);
  });

  it('skips finalization in a pass whose search failed', async () => {
    const { db, deps, state } = await setup();
    await watchScan(deps);
    state.now = new Date(END.getTime() + 60_000);
    state.searchFails = true;
    expect(await watchScan(deps)).toMatchObject({ finalized: 0, errors: 1 });
    expect((await row(db, 'A1'))!.ended_at).toBeNull();
    state.searchFails = false;
    state.results = [];
    expect((await watchScan(deps)).finalized).toBe(2);
  });

  it('refreshes rows ending before the next pass by getItem even when the search returned them, storing reserve_met', async () => {
    const { db, deps, state, calls } = await setup();
    await watchScan(deps);
    state.now = new Date(END.getTime() - 12 * 60_000); // ends within watchScanMinutes (15), not yet within 10
    state.items = { A1: { ...auction('A1', 3300, 6), reservePriceMet: false } as EbayItemSummary };
    calls.getItem = [];
    await watchScan(deps);
    expect(calls.getItem.sort()).toEqual(['A1', 'A2']);
    const r = await row(db, 'A1');
    expect(r).toMatchObject({ reserve_met: false });
    expect(Number(r!.current_bid)).toBe(3300);
    expect(new Date(r!.last_seen_at as string)).toEqual(state.now);
  });

  it('writes no comp for an auction whose reserve was not met', async () => {
    const { db, deps, state } = await setup();
    await watchScan(deps);
    state.now = new Date(END.getTime() - 5 * 60_000);
    state.items = { A1: { ...auction('A1', 3300, 6), reservePriceMet: false } as EbayItemSummary };
    await watchScan(deps);
    state.now = new Date(END.getTime() + 60_000);
    state.results = [];
    expect((await watchScan(deps)).finalized).toBe(2);
    const { rows } = await db.query<{ source_ref: string }>(`select source_ref from comps where kind = 'auction_result'`);
    expect(rows.map((r) => r.source_ref)).toEqual(['ebay_auction:A2']);
  });

  it('processes the items of a partial search', async () => {
    const { deps, state, sent } = await setup();
    state.complete = false;
    const s = await watchScan(deps);
    expect(s).toMatchObject({ seen: 2, matched: 2, alerts: 1 });
    expect(sent).toHaveLength(1);
  });

  it('keeps going when one auction fails', async () => {
    const { deps, state, sent } = await setup();
    state.results = [auction('A0', 3000, 5), auction('A1', 3000, 5)];
    const getItem = deps.ebay.getItem;
    deps.ebay.getItem = async (id) => { if (id === 'A0') throw new Error('eBay 500'); return getItem(id); };
    const s = await watchScan(deps);
    expect(s).toMatchObject({ errors: 1, alerts: 1 });
    expect(sent).toHaveLength(1);
  });
});
