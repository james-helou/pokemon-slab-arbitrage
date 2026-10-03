import type { Db } from '../db/db.js';
import { dueDeliveries, markDelivered, markFailed, type Route } from '../ledger/ledger-repo.js';
import type { Log } from '../log.js';
import { buildAlertPayload, type AlertPayload } from './alert-payload.js';

export interface DeliveryDeps {
  db: Db;
  send: (route: Route, payload: AlertPayload) => Promise<string>;
  now: () => Date;
  log: Log;
}

export async function deliverPending(deps: DeliveryDeps): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  // dueDeliveries leases the rows it returns, so overlapping ticks never double-send.
  for (const d of await dueDeliveries(deps.db, deps.now(), 20)) {
    try {
      const messageId = await deps.send(d.route, buildAlertPayload(d.recommendation));
      await markDelivered(deps.db, d.recommendation.id, messageId, deps.now());
      sent++;
    } catch (err) {
      await markFailed(deps.db, d.recommendation.id, String(err), deps.now(), deps.log);
      deps.log('warn', 'alert delivery failed', { recommendationId: d.recommendation.id, err: String(err) });
      failed++;
    }
  }
  return { sent, failed };
}
