import { describe, expect, it } from 'vitest';
import { deliverPending } from '../../src/discord/delivery.js';
import { insertDelivery, insertRecommendation, type Route } from '../../src/ledger/ledger-repo.js';
import { setSetting } from '../../src/settings/settings.js';
import { silentLog } from '../../src/log.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

// Recommendations are stamped with the DB clock, so "now" must be real time for the max-age check.
const NOW = new Date();

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
    await setSetting(db, 'maxAlertAgeMinutes', 100_000);
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

  it('does nothing while paused and sends after resume', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const send = async () => 'm';
    await setSetting(db, 'paused', true);
    expect(await deliverPending({ db, send, now: () => NOW, log: silentLog })).toEqual({ sent: 0, failed: 0 });
    await setSetting(db, 'paused', false);
    expect(await deliverPending({ db, send, now: () => NOW, log: silentLog })).toEqual({ sent: 1, failed: 0 });
  });

  it('does not markFailed when send succeeded but bookkeeping failed', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const logged: string[] = [];
    const log = (_l: string, msg: string) => { logged.push(msg); };
    const flaky = {
      ...db,
      query: (async (text: string, params?: unknown[]) => {
        if (text.includes("set status = 'sent'") || text.includes("status = 'sent'") && text.includes('update')) throw new Error('db down');
        return db.query(text, params);
      }) as typeof db.query,
    };
    expect(await deliverPending({ db: flaky, send: async () => 'm', now: () => NOW, log })).toEqual({ sent: 1, failed: 0 });
    expect(logged).toContain('alert sent but markDelivered failed');
    const { rows } = await db.query<{ status: string; attempts: number }>('select status, attempts from alert_deliveries');
    expect(rows[0]!.status).not.toBe('failed');
  });

  it('logs only the error message', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const err = Object.assign(new Error('boom'), { config: { headers: { Authorization: 'Bot SECRET' } } });
    await deliverPending({ db, send: async () => { throw err; }, now: () => NOW, log: silentLog });
    const { rows } = await db.query<{ last_error: string }>('select last_error from alert_deliveries');
    expect(rows[0]!.last_error).toBe('boom');
  });

  it('expires a 20-minute-old queued delivery without sending it', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const sent: Route[] = [];
    const logged: string[] = [];
    const log = (_l: string, msg: string) => { logged.push(msg); };
    const later = new Date(Date.now() + 20 * 60_000);
    const send = async (route: Route) => { sent.push(route); return 'm'; };
    expect(await deliverPending({ db, send, now: () => later, log })).toEqual({ sent: 0, failed: 0 });
    expect(sent).toEqual([]);
    const { rows } = await db.query<{ status: string }>('select status from alert_deliveries');
    expect(rows[0]!.status).toBe('expired');
    expect(logged).toContain('alert deliveries expired');
  });

  it('still sends a 5-minute-old queued delivery', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await deliverPending({ db, send: async () => 'm', now: () => later, log: silentLog })).toEqual({ sent: 1, failed: 0 });
  });
});
