import { describe, expect, it, vi } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing } from '../../src/pipeline/evaluate.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

vi.mock('../../src/risk/basic-flags.js', () => ({
  basicRedFlags: () => [{ code: 'test_block', blocking: true, confidencePenalty: 0 }],
}));

const NOW = new Date('2026-10-03T12:00:00Z');

describe('evaluateListing blocking red flags', () => {
  it('rejects when a red flag is blocking', async () => {
    const db = await seedDb();
    const listing = summaryToListing(SUMMARY)!;
    await upsertListing(db, listing, NOW);
    const outcome = await evaluateListing(
      {
        db,
        ebay: { getItem: async () => ITEM },
        valuate: async (key) => ({
          ...key, value: 600, low: 592.5, high: 607.5, compCount: 6, newestCompAgeDays: 1, confidence: 0.893,
          compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
        }),
        now: () => NOW,
        log: silentLog,
      },
      listing,
      DEFAULT_SETTINGS,
      await loadChannels(db),
    );
    expect(outcome).toMatchObject({ status: 'rejected', reasons: ['red_flag:test_block'] });
  });
});

async function seedDb() {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  return db;
}
