import { describe, expect, it } from 'vitest';
import { recordDisappearingComps } from '../../src/disappearing/comps-writer.js';
import type { GoneReason, Match } from '../../src/domain/types.js';
import { insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { insertMatch, markGone, upsertListing } from '../../src/listings/listings-repo.js';
import type { MatchResult } from '../../src/matcher/matcher.js';
import { fixtureCompsSource } from '../../src/oracle/comps-source.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { SUMMARY, makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const match = (confidence: number, gradeLabel: Match['gradeLabel'] = null): MatchResult => ({
  match: { cardId: 'sv03.5-199', grader: 'PSA', grade: 10, gradeLabel, cert: null, confidence, reasons: [], matcherVersion: 'v1.0.0' },
  reasons: [],
});

async function gone(
  db: TestDb,
  id: string,
  o: { confidence?: number; reason?: GoneReason; lastSeen?: Date; label?: Match['gradeLabel']; noMatch?: boolean } = {},
) {
  const l = { ...summaryToListing(SUMMARY)!, externalId: id };
  await upsertListing(db, l, o.lastSeen ?? NOW);
  if (!o.noMatch) await insertMatch(db, l, match(o.confidence ?? 0.9, o.label ?? null), 'title');
  await markGone(db, l, NOW, o.reason ?? 'not_found');
}

describe('recordDisappearingComps', () => {
  it('writes one comp per confirmed, confidently matched disappearance, idempotently', async () => {
    const db = await createTestDb();
    await seedCards(db);
    await gone(db, 'sold', { reason: 'out_of_stock' });
    await gone(db, 'ended', { reason: 'not_found' });
    await gone(db, 'unconfirmed', { reason: 'window_miss' });
    await gone(db, 'weak', { confidence: 0.6 });
    await gone(db, 'pristine', { label: 'pristine' });
    await gone(db, 'late', { lastSeen: new Date('2026-09-25T12:00:00Z') }); // sold time uncertain by 8 days
    await gone(db, 'nomatch', { noMatch: true });
    expect(await recordDisappearingComps(db, 0.85, NOW)).toBe(2);
    expect(await recordDisappearingComps(db, 0.85, NOW)).toBe(0);
    const { rows } = await db.query<{ source_ref: string; price: string; kind: string; sold_at: Date }>(
      'select source_ref, price, kind, sold_at from comps order by source_ref',
    );
    expect(rows.map((r) => r.source_ref)).toEqual(['ebay:ended:not_found', 'ebay:sold:out_of_stock']);
    expect(Number(rows[0]!.price)).toBe(350);
    expect(rows[0]!.kind).toBe('disappearing_bin');
    expect(new Date(rows[0]!.sold_at).toISOString()).toBe(NOW.toISOString());
  });

  it('uses the latest enriched match over the title match', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const up = { ...summaryToListing(SUMMARY)!, externalId: 'upgraded' };
    await upsertListing(db, up, NOW);
    await insertMatch(db, up, match(0.6), 'title');
    await insertMatch(db, up, match(0.95), 'enriched');
    await markGone(db, up, NOW, 'not_found');
    const down = { ...summaryToListing(SUMMARY)!, externalId: 'downgraded' };
    await upsertListing(db, down, NOW);
    await insertMatch(db, down, match(0.95), 'title');
    await insertMatch(db, down, { match: null, reasons: ['lot'] }, 'enriched');
    await markGone(db, down, NOW, 'not_found');
    expect(await recordDisappearingComps(db, 0.85, NOW)).toBe(1);
    const { rows } = await db.query<{ source_ref: string }>('select source_ref from comps');
    expect(rows[0]!.source_ref).toBe('ebay:upgraded:not_found');
  });

  it('feeds the oracle, which applies the Best Offer discount', async () => {
    const db = await createTestDb();
    await seedCards(db);
    for (const id of ['a', 'b', 'c']) await gone(db, id);
    await recordDisappearingComps(db, 0.85, NOW);
    const v = await getValuation(
      { db, source: fixtureCompsSource([], () => NOW), now: () => NOW },
      { cardId: 'sv03.5-199', grader: 'PSA', grade: 10 },
      DEFAULT_SETTINGS,
    );
    expect(v).toMatchObject({ value: 322, compCount: 3 }); // 350 x 0.92
  });

  it('excludes listings that were themselves recommended (flagged deals bias values down)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    await gone(db, 'plain');
    await gone(db, 'flagged');
    await insertRecommendation(db, { ...makeNewRecommendation(), externalId: 'flagged' });
    expect(await recordDisappearingComps(db, 0.85, NOW)).toBe(1);
    const { rows } = await db.query<{ source_ref: string }>('select source_ref from comps');
    expect(rows.map((r) => r.source_ref)).toEqual(['ebay:plain:not_found']);
  });
});
