import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, setSetting } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';

describe('settings', () => {
  it('returns defaults when nothing is stored', async () => {
    const db = await createTestDb();
    expect(await loadSettings(db)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.minNet).toBe(75);
    expect(DEFAULT_SETTINGS.minRoi).toBe(0.2);
    expect(DEFAULT_SETTINGS.enabledGraders).toEqual(['PSA']);
    expect(DEFAULT_SETTINGS.minMatchConfidence).toBe(0.85);
  });

  it('overrides a stored key and ignores unknown keys', async () => {
    const db = await createTestDb();
    await setSetting(db, 'paused', true);
    await setSetting(db, 'minNet', 100);
    await db.query(`insert into settings (key, value) values ('bogus', '1'::jsonb)`);
    const s = await loadSettings(db);
    expect(s.paused).toBe(true);
    expect(s.minNet).toBe(100);
    expect('bogus' in s).toBe(false);
  });

  it('clamps DB-loaded intervals and falls back on non-finite values', async () => {
    const db = await createTestDb();
    const put = (k: string, v: string) => db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, v]);
    await put('scanIntervalSeconds', '1');
    await put('deliveryIntervalSeconds', '0');
    await put('minNet', '"abc"');
    await put('maxAlertAgeMinutes', 'null');
    const s = await loadSettings(db);
    expect(s.scanIntervalSeconds).toBe(30);
    expect(s.deliveryIntervalSeconds).toBe(5);
    expect(s.minNet).toBe(DEFAULT_SETTINGS.minNet);
    expect(s.maxAlertAgeMinutes).toBe(15);
    await put('scanIntervalSeconds', '120');
    expect((await loadSettings(db)).scanIntervalSeconds).toBe(120);
  });

  it('has slice-2 defaults and clamps them', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      disappearMissScans: 3, disappearMinPrice: 75, disappearConfirmMaxAgeHours: 24,
      auxGetItemDailyCap: 300, sweepIntervalMinutes: 10, outcomeIntervalMinutes: 60,
    });
    const db = await createTestDb();
    await setSetting(db, 'disappearMissScans', 1);
    await setSetting(db, 'outcomeIntervalMinutes', 0);
    await setSetting(db, 'sweepIntervalMinutes', 0);
    await setSetting(db, 'auxGetItemDailyCap', -5);
    const s = await loadSettings(db);
    expect(s.disappearMissScans).toBe(2);
    expect(s.outcomeIntervalMinutes).toBe(5);
    expect(s.sweepIntervalMinutes).toBe(1);
    expect(s.auxGetItemDailyCap).toBe(0);
  });

  it('has sold-check defaults and clamps them to their ranges', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      soldCheckDailyCap: 40, soldCheckMinSpacingSeconds: 30, soldCheckCacheHours: 12, soldCheckMinSales: 5,
      soldCheckMaxGap: 0.2,
    });
    const db = await createTestDb();
    await setSetting(db, 'soldCheckDailyCap', -1);
    await setSetting(db, 'soldCheckMinSpacingSeconds', 1);
    await setSetting(db, 'soldCheckCacheHours', 0);
    await setSetting(db, 'soldCheckMinSales', 1);
    await setSetting(db, 'soldCheckMaxGap', 0);
    const low = await loadSettings(db);
    expect(low).toMatchObject({
      soldCheckDailyCap: 0, soldCheckMinSpacingSeconds: 10, soldCheckCacheHours: 1, soldCheckMinSales: 3,
      soldCheckMaxGap: 0.05,
    });
    await setSetting(db, 'soldCheckDailyCap', 5000);
    await setSetting(db, 'soldCheckMinSpacingSeconds', 9999);
    await setSetting(db, 'soldCheckCacheHours', 1000);
    await setSetting(db, 'soldCheckMinSales', 100);
    await setSetting(db, 'soldCheckMaxGap', 5);
    const high = await loadSettings(db);
    expect(high).toMatchObject({
      soldCheckDailyCap: 200, soldCheckMinSpacingSeconds: 600, soldCheckCacheHours: 72, soldCheckMinSales: 30,
      soldCheckMaxGap: 1,
    });
  });
});

describe('rawCeilingMultipliers setting', () => {
  it('defaults, loads a valid object, and falls back on bad values', async () => {
    const { createTestDb } = await import('../helpers/test-db.js');
    const db = await createTestDb();
    const put = (v: string) => db.query(`insert into settings (key, value) values ('rawCeilingMultipliers', $1::jsonb) on conflict (key) do update set value = excluded.value`, [v]);
    expect((await loadSettings(db)).rawCeilingMultipliers).toEqual(DEFAULT_SETTINGS.rawCeilingMultipliers);
    await put('{"10": 30, "default": 5}');
    expect((await loadSettings(db)).rawCeilingMultipliers).toEqual({ '10': 30, default: 5 });
    await put('{"10": -1, "9": "x", "default": 6}');
    expect((await loadSettings(db)).rawCeilingMultipliers).toEqual({ '10': 25, '9': 8, default: 6 });
    await put('"nope"');
    expect((await loadSettings(db)).rawCeilingMultipliers).toEqual(DEFAULT_SETTINGS.rawCeilingMultipliers);
  });

  it('defaults pptBurstCredits to 20 and clamps stored values to 0..100', async () => {
    expect(DEFAULT_SETTINGS.pptBurstCredits).toBe(20);
    const db = await createTestDb();
    await setSetting(db, 'pptBurstCredits', 500);
    expect((await loadSettings(db)).pptBurstCredits).toBe(100);
    await setSetting(db, 'pptBurstCredits', -1);
    expect((await loadSettings(db)).pptBurstCredits).toBe(0);
  });

  it('defaults pptDailyCredits to 90 and clamps stored values to 0..100', async () => {
    expect(DEFAULT_SETTINGS.pptDailyCredits).toBe(90);
    const db = await createTestDb();
    await setSetting(db, 'pptDailyCredits', 500);
    expect((await loadSettings(db)).pptDailyCredits).toBe(100);
    await setSetting(db, 'pptDailyCredits', -5);
    expect((await loadSettings(db)).pptDailyCredits).toBe(0);
  });
});

describe('rawPromiseMultipliers setting', () => {
  it('defaults to the measured p90 ratios, loads a valid object, and falls back per key on bad values', async () => {
    const { createTestDb } = await import('../helpers/test-db.js');
    const db = await createTestDb();
    const put = (v: string) => db.query(`insert into settings (key, value) values ('rawPromiseMultipliers', $1::jsonb) on conflict (key) do update set value = excluded.value`, [v]);
    expect(DEFAULT_SETTINGS.rawPromiseMultipliers).toEqual({ '10': 8, '9.5': 4, '9': 2, default: 2 });
    expect((await loadSettings(db)).rawPromiseMultipliers).toEqual(DEFAULT_SETTINGS.rawPromiseMultipliers);
    await put('{"10": 6, "default": 3}');
    expect((await loadSettings(db)).rawPromiseMultipliers).toEqual({ '10': 6, default: 3 });
    await put('{"10": -1, "9": "x", "default": 5}');
    expect((await loadSettings(db)).rawPromiseMultipliers).toEqual({ '10': 8, '9': 2, default: 5 });
    await put('"nope"');
    expect((await loadSettings(db)).rawPromiseMultipliers).toEqual(DEFAULT_SETTINGS.rawPromiseMultipliers);
  });
  it('has deal-mode defaults, clamps them, and ignores non-boolean modes', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      offerMode: true, offerMinPctOfAsk: 0.75, auctionMode: true, auctionScanMinutes: 10,
      auctionWindowMinutes: 60, auctionAlertPct: 0.7, auctionSpendsCredits: false, caScan: true, caScanEveryNCycles: 3,
    });
    expect((await (async () => { const d = await createTestDb(); await d.query(`insert into settings (key, value) values ('auctionSpendsCredits', '"true"'::jsonb)`); return loadSettings(d); })()).auctionSpendsCredits).toBe(false);
    const db = await createTestDb();
    const put = (k: string, v: string) => db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, v]);
    await put('offerMinPctOfAsk', '0.1');
    await put('auctionScanMinutes', '1');
    await put('auctionWindowMinutes', '1000');
    await put('auctionAlertPct', '5');
    await put('caScanEveryNCycles', '0');
    await put('offerMode', '"false"');
    await put('caScan', '0');
    await put('auctionMode', 'false');
    const s = await loadSettings(db);
    expect(s).toMatchObject({
      offerMinPctOfAsk: 0.5, auctionScanMinutes: 5, auctionWindowMinutes: 180, auctionAlertPct: 1,
      caScanEveryNCycles: 1, offerMode: true, caScan: true, auctionMode: false,
    });
    await put('offerMinPctOfAsk', '2');
    await put('auctionScanMinutes', '100');
    await put('auctionWindowMinutes', '1');
    await put('auctionAlertPct', '0.01');
    await put('caScanEveryNCycles', '99');
    expect(await loadSettings(db)).toMatchObject({
      offerMinPctOfAsk: 1, auctionScanMinutes: 60, auctionWindowMinutes: 15, auctionAlertPct: 0.3, caScanEveryNCycles: 20,
    });
  });

  it('fails closed on a non-boolean paused value, and falls back on other booleans', async () => {
    const db = await createTestDb();
    const put = (k: string, v: string) => db.query(`insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, v]);
    await put('paused', '"true"');
    expect((await loadSettings(db)).paused).toBe(true);
    await put('paused', '"yes"');
    expect((await loadSettings(db)).paused).toBe(true);
    await put('paused', 'false');
    expect((await loadSettings(db)).paused).toBe(false);
    await put('offerMode', '"false"');
    expect((await loadSettings(db)).offerMode).toBe(DEFAULT_SETTINGS.offerMode);
  });
});
