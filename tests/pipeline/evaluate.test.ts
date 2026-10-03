import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import type { Valuation } from '../../src/domain/types.js';
import { getRecommendation, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing, type EvaluateDeps } from '../../src/pipeline/evaluate.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings/settings.js';
import type { EbayItem, EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const VALUATION: Valuation = {
  cardId: 'sv3pt5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.893, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
};

async function setup(opts: { cash?: number; item?: EbayItem | null; valuation?: Valuation | null; settings?: Partial<Settings> } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: opts.cash ?? 500 });
  let getItemCalls = 0;
  const deps: EvaluateDeps = {
    db,
    ebay: { getItem: async () => { getItemCalls++; return opts.item === undefined ? ITEM : opts.item; } },
    valuate: async () => (opts.valuation === undefined ? VALUATION : opts.valuation),
    now: () => NOW,
    log: silentLog,
  };
  const channels = await loadChannels(db);
  return { db, deps, channels, getItemCalls: () => getItemCalls };
}

async function run(
  title = SUMMARY.title,
  price = '350.00',
  opts: Parameters<typeof setup>[0] = {},
  summary: Partial<EbayItemSummary> = {},
) {
  const ctx = await setup(opts);
  const listing = summaryToListing({ ...SUMMARY, title, price: { value: price, currency: 'USD' }, ...summary })!;
  await upsertListing(ctx.db, listing, NOW);
  const outcome = await evaluateListing(ctx.deps, listing, { ...DEFAULT_SETTINGS, ...opts.settings }, ctx.channels);
  return { ...ctx, outcome };
}

describe('evaluateListing', () => {
  it('recommends a good deal and queues an alert', async () => {
    const { db, outcome } = await run();
    expect(outcome.status).toBe('recommended');
    const rec = await getRecommendation(db, outcome.recommendationId!);
    expect(rec).toMatchObject({ bestChannel: 'ebay', bestNet: 133.75, routedTo: 'alerts', cert: '12345678' });
    expect(rec?.cardSnapshot.name).toBe('Charizard ex');
    const d = await db.query<{ status: string }>('select status from alert_deliveries');
    expect(d.rows[0]!.status).toBe('pending');
  });

  it('routes to over_budget when cash is short', async () => {
    const { db, outcome } = await run(undefined, undefined, { cash: 100 });
    expect((await getRecommendation(db, outcome.recommendationId!))?.routedTo).toBe('over_budget');
  });

  it('stops at no_match for lots without calling getItem', async () => {
    const { outcome, getItemCalls } = await run('Lot of 3 PSA 10 Charizard ex 199/165');
    expect(outcome.status).toBe('no_match');
    expect(getItemCalls()).toBe(0);
  });

  it('stops at the grader gate', async () => {
    expect((await run('CGC 10 Charizard ex 199/165')).outcome).toMatchObject({ status: 'grader_disabled' });
  });

  it('returns no_valuation when the oracle has no comps', async () => {
    expect((await run(undefined, undefined, { valuation: null })).outcome.status).toBe('no_valuation');
  });

  it('rejects overpriced listings before spending a getItem call', async () => {
    const { outcome, getItemCalls } = await run(undefined, '550.00');
    expect(outcome.status).toBe('rejected');
    expect(getItemCalls()).toBe(0);
  });

  it('marks gone listings', async () => {
    const { db, outcome } = await run(undefined, undefined, { item: null });
    expect(outcome.status).toBe('gone');
    const { rows } = await db.query<{ gone_at: Date | null }>('select gone_at from listings');
    expect(rows[0]!.gone_at).not.toBeNull();
  });

  it('re-scores with the enriched price', async () => {
    const pricier: EbayItem = { ...ITEM, price: { value: '540.00', currency: 'USD' } };
    expect((await run(undefined, undefined, { item: pricier })).outcome.status).toBe('rejected');
  });

  it('rejects shipping_unknown at stage 1 without calling getItem', async () => {
    const { outcome, getItemCalls } = await run(undefined, undefined, {}, { shippingOptions: [] });
    expect(outcome).toMatchObject({ status: 'rejected', reasons: ['shipping_unknown'] });
    expect(getItemCalls()).toBe(0);
  });

  it('rejects shipping_unknown when the enriched item has no shipping', async () => {
    const noShip: EbayItem = { ...ITEM, shippingOptions: [] };
    expect((await run(undefined, undefined, { item: noShip })).outcome).toMatchObject({
      status: 'rejected', reasons: ['shipping_unknown'],
    });
  });

  it('rejects invalid_listing when the enriched item is not USD', async () => {
    const eur: EbayItem = { ...ITEM, price: { value: '350.00', currency: 'EUR' } };
    expect((await run(undefined, undefined, { item: eur })).outcome).toMatchObject({
      status: 'rejected', reasons: ['invalid_listing'],
    });
  });

  it('returns match_changed when the enriched item resolves to a different grade', async () => {
    const other: EbayItem = { ...ITEM, title: 'PSA 9 Charizard ex 199/165 151', localizedAspects: [
      { name: 'Professional Grader', value: 'Professional Sports Authenticator (PSA)' },
      { name: 'Grade', value: '9' },
      { name: 'Language', value: 'English' },
    ] };
    expect((await run(undefined, undefined, { item: other })).outcome).toMatchObject({ status: 'match_changed' });
  });

  it('stops at the unsupported_label gate', async () => {
    expect((await run('PSA Pristine 10 Charizard ex 199/165 151')).outcome).toMatchObject({
      status: 'unsupported_label', reasons: ['pristine'],
    });
  });

  it('records non-blocking red flags on the recommendation', async () => {
    const noCert: EbayItem = { ...ITEM, localizedAspects: ITEM.localizedAspects!.filter((a) => a.name !== 'Certification Number') };
    const { db, outcome } = await run(undefined, undefined, { item: noCert });
    expect(outcome.status).toBe('recommended');
    expect((await getRecommendation(db, outcome.recommendationId!))?.redFlags).toEqual(['no_cert']);
  });

  it('returns duplicate and queues no second delivery when a recommendation exists', async () => {
    const ctx = await setup();
    const listing = summaryToListing(SUMMARY)!;
    await upsertListing(ctx.db, listing, NOW);
    await insertRecommendation(ctx.db, makeNewRecommendation());
    const outcome = await evaluateListing(ctx.deps, listing, DEFAULT_SETTINGS, ctx.channels);
    expect(outcome.status).toBe('duplicate');
    const d = await ctx.db.query('select 1 from alert_deliveries');
    expect(d.rows).toHaveLength(0);
  });

  it('rejects low_match_confidence at stage 1 without calling getItem', async () => {
    const { outcome, getItemCalls } = await run('PSA 10 Pikachu 199/165 151');
    expect(outcome).toMatchObject({ status: 'rejected', reasons: ['low_match_confidence'] });
    expect(getItemCalls()).toBe(0);
  });

  it('rejects low_match_confidence at stage 2', async () => {
    const mismatched: EbayItem = { ...ITEM, title: 'PSA 10 Pikachu 199/165 151' };
    expect((await run(undefined, undefined, { item: mismatched })).outcome).toMatchObject({
      status: 'rejected', reasons: ['low_match_confidence'],
    });
  });

  it('accepts a title-only PSA match (0.855) at the default floor but not at 0.9', async () => {
    expect((await run()).outcome.status).toBe('recommended');
    expect((await run(undefined, undefined, { settings: { minMatchConfidence: 0.9 } })).outcome).toMatchObject({
      status: 'rejected', reasons: ['low_match_confidence'],
    });
  });

  it('rejects a stale valuation', async () => {
    const stale = { ...VALUATION, computedAt: new Date(NOW.getTime() - 25 * 3600_000) };
    expect((await run(undefined, undefined, { valuation: stale })).outcome).toMatchObject({
      status: 'rejected', reasons: ['stale_valuation'],
    });
  });
});
