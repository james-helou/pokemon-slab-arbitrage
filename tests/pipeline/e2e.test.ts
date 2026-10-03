import { describe, expect, it } from 'vitest';
import { availableCash } from '../../src/bankroll/bankroll-repo.js';
import type { AlertPayload } from '../../src/discord/alert-payload.js';
import { deliverPending } from '../../src/discord/delivery.js';
import { handleCommand, handleComponent } from '../../src/discord/handlers.js';
import { silentLog } from '../../src/log.js';
import { loadFixtureCompsSource } from '../../src/oracle/comps-source.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { scanCycle } from '../../src/pipeline/scan-cycle.js';
import { createBudget } from '../../src/sources/ebay/budget.js';
import type { EbayItem, EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const now = () => new Date('2026-10-03T12:00:00Z');

async function setup(summary: EbayItemSummary, item: EbayItem) {
  const db = await createTestDb();
  await seedCards(db);
  await handleCommand({ db, ebayUsedToday: async () => 0 }, 'deposit', { amount: 500 });
  const source = await loadFixtureCompsSource('data/comps-fixture.json', now);
  const deps = {
    db,
    budget: createBudget(db, 'ebay_browse', 5000, now),
    ebay: { searchNewGraded: async () => [summary], getItem: async () => item },
    valuate: (key: Parameters<typeof getValuation>[1], s: Parameters<typeof getValuation>[2]) =>
      getValuation({ db, source, now }, key, s),
    now,
    log: silentLog,
  };
  return { db, deps };
}

describe('slice 1 end to end', () => {
  it('scan -> recommendation -> Discord payload -> Bought debits bankroll', async () => {
    const { db, deps } = await setup(SUMMARY, ITEM);

    const scan = await scanCycle(deps, 0);
    expect(scan.outcomes).toEqual({ recommended: 1 });

    const sent: AlertPayload[] = [];
    const delivery = await deliverPending({
      db, now, log: silentLog, send: async (_route, p) => { sent.push(p); return 'm1'; },
    });
    expect(delivery).toEqual({ sent: 1, failed: 0 });
    expect(sent).toHaveLength(1);

    const embed = sent[0]!.embeds[0]!;
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Best net']).toBe('$133.75 via ebay · ROI 35%');
    expect(fields['Why']).toContain('below market value');
    expect(fields['Cert']).toBe('12345678');
    expect(embed.image?.url).toBe('https://i.ebayimg.com/111.jpg');
    expect(embed.url).toBe('https://www.ebay.com/itm/111');

    const recId = Number(/rec #(\d+)/.exec(embed.footer!.text)![1]);
    const buttonIds = sent[0]!.components[0]!.components.map((c) => c.custom_id);
    expect(buttonIds).toContain(`bought:${recId}`);

    const pressed = await handleComponent(db, `bought:${recId}`, [], 'james');
    expect(pressed.reply).toContain('Marked bought');
    expect(await availableCash(db)).toBe(120.15);
    expect((await handleComponent(db, `bought:${recId}`, [], 'james')).reply).toBe('Already marked as bought.');
    expect(await availableCash(db)).toBe(120.15);

    expect((await scanCycle(deps, 1)).new).toBe(0);
  });

  it('never recommends a listing whose shipping is unknown', async () => {
    const summary: EbayItemSummary = { ...SUMMARY, shippingOptions: undefined };
    const { db, deps } = await setup(summary, { ...ITEM, shippingOptions: undefined });

    const scan = await scanCycle(deps, 0);
    expect(scan.outcomes).toEqual({ rejected: 1 });
    expect((await db.query('select 1 from recommendations')).rows).toHaveLength(0);
    expect((await db.query('select 1 from alert_deliveries')).rows).toHaveLength(0);

    const sent: AlertPayload[] = [];
    await deliverPending({ db, now, log: silentLog, send: async (_r, p) => { sent.push(p); return 'm1'; } });
    expect(sent).toHaveLength(0);
    expect(await availableCash(db)).toBe(500);
  });
});
