import { describe, expect, it } from 'vitest';
import { insertDecision, insertDelivery, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { insertOutcome } from '../../src/outcomes/outcomes-repo.js';
import { isoWeekOf } from '../../src/reports/iso-week.js';
import { loadReportInput } from '../../src/reports/report-data.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

describe('loadReportInput', () => {
  it('loads recommendations, outcomes and decisions up to the end of the week', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    await insertDecision(db, { recommendationId: id, action: 'pass', reason: 'price', actor: 'james' });
    await insertOutcome(db, {
      recommendationId: id, horizonDays: 7, listingFinalState: 'live', observedPrice: 350, marketValue: 600,
      valuationConfidence: 0.9, valuationCompCount: 6, netAtHorizon: 133.75, netChannel: 'ebay', label: 'good',
      labelBasis: 'counterfactual', decision: 'pass', minNet: 75, trackerVersion: 'v1.0.0', oracleVersion: 'v1.0.0',
      observedAt: new Date(),
    });
    const generatedAt = new Date();
    const input = await loadReportInput(db, isoWeekOf(generatedAt), generatedAt, 75);
    expect(input.recommendations[0]).toMatchObject({
      id, grader: 'PSA', grade: 10, buyTotal: 379.85, predictedValue: 600, confidence: 0.848,
      routedTo: 'alerts', deliveryStatus: 'pending', compsSource: 'fixture',
    });
    expect(input.outcomes[0]).toMatchObject({
      recommendationId: id, horizonDays: 7, label: 'good', marketValue: 600, netAtHorizon: 133.75, listingFinalState: 'live',
    });
    expect(input.decisions[0]).toMatchObject({ recommendationId: id, action: 'pass', reason: 'price' });
    expect(input.recommendations[0]!.createdAt).toBeInstanceOf(Date);

    const past = await loadReportInput(db, '2020-W01', generatedAt, 75);
    expect(past).toMatchObject({ recommendations: [], outcomes: [], decisions: [] });
  });
});
