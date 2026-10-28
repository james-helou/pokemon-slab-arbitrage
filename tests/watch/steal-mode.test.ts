import { describe, expect, it } from 'vitest';
import type { AggregatePriceSource } from '../../src/oracle/aggregate-source.js';
import { DEFAULT_SETTINGS, setSetting, loadSettings } from '../../src/settings/settings.js';
import { buildWatchReaders } from '../../src/watch/market-value.js';
import { stealJobsEnabled, whenStealMode } from '../../src/watch/steal-mode.js';
import { createTestDb } from '../helpers/test-db.js';

const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };

describe('steal mode gate', () => {
  it('is off by default', () => {
    expect(stealJobsEnabled(DEFAULT_SETTINGS)).toBe(false);
    expect(stealJobsEnabled({ ...DEFAULT_SETTINGS, stealMode: true })).toBe(true);
  });

  it('runs the job only while the DB setting is on, re-read each run', async () => {
    const db = await createTestDb();
    let runs = 0;
    const job = async () => ++runs;
    expect(await whenStealMode(() => loadSettings(db), job)).toEqual({ ran: false });
    await setSetting(db, 'stealMode', true);
    expect(await whenStealMode(() => loadSettings(db), job)).toEqual({ ran: true, result: 1 });
    await setSetting(db, 'stealMode', false);
    expect(await whenStealMode(() => loadSettings(db), job)).toEqual({ ran: false });
    expect(runs).toBe(1);
  });
});

describe('buildWatchReaders', () => {
  it('uses PPT only when an aggregate source is wired, and always own sales', async () => {
    const db = await createTestDb();
    const now = () => new Date('2026-10-28T12:00:00Z');
    expect(buildWatchReaders({ db, now, minSales: 3 })).toHaveLength(1);
    const aggregate: AggregatePriceSource = {
      fetchAggregate: async () => ({
        value: 2000, low: 1900, high: 2100, saleCount: 12, windowDays: 30, confidence: 0.9, asOf: now(), sourceName: 'ppt',
      }),
    };
    const readers = buildWatchReaders({ db, now, minSales: 3, aggregate });
    expect(readers).toHaveLength(2);
    expect(await readers[0]!(KEY)).toMatchObject({ name: 'ppt', value: 2000 });
    expect(await readers[1]!(KEY)).toBeNull();
  });
});
