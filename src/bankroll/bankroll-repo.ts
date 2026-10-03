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
