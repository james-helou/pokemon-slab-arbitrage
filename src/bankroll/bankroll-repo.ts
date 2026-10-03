import type { Db } from '../db/db.js';

export type BankrollKind = 'deposit' | 'withdrawal' | 'purchase' | 'sale' | 'fee' | 'adjustment';

export async function addEntry(
  db: Db,
  e: { kind: BankrollKind; amount: number; recommendationId?: number; note?: string },
): Promise<void> {
  await db.query(`insert into bankroll_ledger (kind, amount, recommendation_id, note) values ($1, $2, $3, $4)`, [
    e.kind, e.amount, e.recommendationId ?? null, e.note ?? null,
  ]);
}

export async function availableCash(db: Db): Promise<number> {
  const { rows } = await db.query<{ total: string }>('select coalesce(sum(amount), 0) as total from bankroll_ledger');
  return Math.round(Number(rows[0]!.total) * 100) / 100;
}

/**
 * Records a 'bought' decision and its bankroll purchase entry in one statement (atomic).
 * Returns false when this recommendation was already marked bought (nothing written).
 */
export async function recordPurchase(
  db: Db,
  p: { recommendationId: number; amount: number; actor: string | null; note?: string },
): Promise<boolean> {
  const { rows } = await db.query(
    `with d as (
       insert into decisions (recommendation_id, action, reason, actor) values ($1, 'bought', null, $3)
       on conflict (recommendation_id) where action = 'bought' do nothing
       returning recommendation_id
     )
     insert into bankroll_ledger (kind, amount, recommendation_id, note)
     select 'purchase', $2::numeric, recommendation_id, $4 from d
     returning id`,
    [p.recommendationId, -p.amount, p.actor, p.note ?? null],
  );
  return rows.length > 0;
}
