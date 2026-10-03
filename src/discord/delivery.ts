import type { Db } from '../db/db.js';
import { dueDeliveries, markDelivered, markFailed, type Route } from '../ledger/ledger-repo.js';
import { loadSettings } from '../settings/settings.js';
import type { Log } from '../log.js';
import { buildAlertPayload, type AlertPayload } from './alert-payload.js';

export interface DeliveryDeps {
  db: Db;
  send: (route: Route, payload: AlertPayload) => Promise<string>;
  now: () => Date;
  log: Log;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : 'unknown error');

export async function deliverPending(deps: DeliveryDeps): Promise<{ sent: number; failed: number }> {
  if ((await loadSettings(deps.db)).paused) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  // dueDeliveries leases the rows it returns, so overlapping ticks never double-send.
  for (const d of await dueDeliveries(deps.db, deps.now(), 20)) {
    const id = d.recommendation.id;
    let messageId: string;
    try {
      messageId = await deps.send(d.route, buildAlertPayload(d.recommendation));
    } catch (err) {
      const message = errorMessage(err);
      await markFailed(deps.db, id, message, deps.now(), deps.log);
      deps.log('warn', 'alert delivery failed', { recommendationId: id, err: message });
      failed++;
      continue;
    }
    sent++;
    try {
      await markDelivered(deps.db, id, messageId, deps.now());
    } catch (err) {
      // The alert is out; never mark it failed or it would be re-sent.
      deps.log('error', 'alert sent but markDelivered failed', { recommendationId: id, messageId, err: errorMessage(err) });
    }
  }
  return { sent, failed };
}
