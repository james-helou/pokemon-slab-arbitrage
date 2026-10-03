import { describe, expect, it } from 'vitest';
import { deliverPending } from '../../src/discord/delivery.js';
import { insertDelivery, insertRecommendation, type Route } from '../../src/ledger/ledger-repo.js';
import { silentLog } from '../../src/log.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');

describe('deliverPending', () => {
  it('sends to the routed channel and does not resend', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation({ routedTo: 'over_budget' })))!;
    await insertDelivery(db, id, 'over_budget');
    const sent: Route[] = [];
    const send = async (route: Route) => { sent.push(route); return 'msg-1'; };
    expect(await deliverPending({ db, send, now: () => NOW, log: silentLog })).toEqual({ sent: 1, failed: 0 });
    expect(await deliverPending({ db, send, now: () => NOW, log: silentLog })).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual(['over_budget']);
  });

  it('marks failures and retries only after the backoff', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    let fail = true;
    const send = async () => { if (fail) throw new Error('discord down'); return 'msg-2'; };
    expect(await deliverPending({ db, send, now: () => NOW, log: silentLog })).toEqual({ sent: 0, failed: 1 });
    fail = false;
    const early = new Date(NOW.getTime() + 30_000);
    expect(await deliverPending({ db, send, now: () => early, log: silentLog })).toEqual({ sent: 0, failed: 0 });
    const later = new Date(NOW.getTime() + 61_000);
    expect(await deliverPending({ db, send, now: () => later, log: silentLog })).toEqual({ sent: 1, failed: 0 });
  });

  it('logs once the delivery is dead after repeated failures', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const send = async () => { throw new Error('discord down'); };
    const logged: string[] = [];
    const log = (_level: string, msg: string) => { logged.push(msg); };
    let t = NOW.getTime();
    let failures = 0;
    for (let i = 0; i < 8; i++) {
      t += 3_600_000;
      failures += (await deliverPending({ db, send, now: () => new Date(t), log })).failed;
    }
    expect(failures).toBe(5);
    expect(logged.filter((m) => m === 'alert delivery dead')).toHaveLength(1);
  });
});
