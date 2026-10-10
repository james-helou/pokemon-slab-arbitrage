import { describe, expect, it } from 'vitest';
import { getRecommendation, insertDecision, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { decisionSnapshot, dueOutcomes, insertOutcome, type NewOutcome } from '../../src/outcomes/outcomes-repo.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const DAY = 86_400_000;

async function setup() {
  const db = await createTestDb();
  await seedCards(db);
  const id = (await insertRecommendation(db, makeNewRecommendation()))!;
  const rec = (await getRecommendation(db, id))!;
  const at = (days: number) => new Date(rec.createdAt.getTime() + days * DAY + 60_000);
  return { db, id, at };
}

const outcome = (recommendationId: number, horizonDays: number, observedAt: Date): NewOutcome => ({
  recommendationId, horizonDays, listingFinalState: 'live', observedPrice: 350, marketValue: 600,
  valuationConfidence: 0.9, valuationCompCount: 6, netAtHorizon: 133.75, netChannel: 'ebay', label: 'good',
  labelBasis: 'counterfactual', decision: 'none', minNet: 75, trackerVersion: 'v1.0.0', oracleVersion: 'v1.0.0', observedAt,
});

describe('outcomes repo', () => {
  it('lists due horizons and inserts each once', async () => {
    const { db, id, at } = await setup();
    expect(await dueOutcomes(db, at(6), 10)).toEqual([]);
    expect((await dueOutcomes(db, at(7), 10)).map((d) => d.horizons)).toEqual([[7]]);
    const due = await dueOutcomes(db, at(31), 10);
    expect(due[0]).toMatchObject({ id, externalId: 'v1|111|0', cardId: 'sv03.5-199', grader: 'PSA', grade: 10, buyTotal: 379.85, horizons: [7, 14, 30] });
    expect(await insertOutcome(db, outcome(id, 7, at(7)))).toBe(true);
    expect(await insertOutcome(db, outcome(id, 7, at(8)))).toBe(false);
    expect((await dueOutcomes(db, at(31), 10))[0]!.horizons).toEqual([14, 30]);
  });

  it('snapshots the strongest decision', async () => {
    const { db, id } = await setup();
    expect(await decisionSnapshot(db, id)).toBe('none');
    await insertDecision(db, { recommendationId: id, action: 'watch', reason: null, actor: 'james' });
    expect(await decisionSnapshot(db, id)).toBe('watch');
    await insertDecision(db, { recommendationId: id, action: 'pass', reason: 'price', actor: 'james' });
    expect(await decisionSnapshot(db, id)).toBe('pass');
    await insertDecision(db, { recommendationId: id, action: 'bought', reason: null, actor: 'james' });
    expect(await decisionSnapshot(db, id)).toBe('bought');
  });
});

describe('dueOutcomes kinds', () => {
  it('returns bin and offer recommendations but not auctions', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const bin = (await insertRecommendation(db, makeNewRecommendation({ externalId: 'v1|1|0' })))!;
    const offer = (await insertRecommendation(db, makeNewRecommendation({ externalId: 'v1|2|0', kind: 'offer', suggestedPrice: 300 })))!;
    await insertRecommendation(db, makeNewRecommendation({ externalId: 'v1|3|0', kind: 'auction', suggestedPrice: 300 }));
    const rec = (await getRecommendation(db, bin))!;
    const due = await dueOutcomes(db, new Date(rec.createdAt.getTime() + 8 * DAY), 10);
    expect(due.map((d) => d.id).sort()).toEqual([bin, offer].sort());
  });
});
