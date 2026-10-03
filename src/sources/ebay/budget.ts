import type { Db } from '../../db/db.js';

export class BudgetExceededError extends Error {}

export interface Budget {
  readonly limit: number;
  /** Records one call; throws BudgetExceededError if today's count is now over the limit. */
  beforeCall(): Promise<void>;
  usedToday(): Promise<number>;
}

export function createBudget(db: Db, source: string, limit: number, now: () => Date): Budget {
  const day = () => now().toISOString().slice(0, 10);
  return {
    limit,
    async usedToday() {
      const { rows } = await db.query<{ calls: number }>('select calls from api_usage where day = $1 and source = $2', [
        day(), source,
      ]);
      return rows[0] ? Number(rows[0].calls) : 0;
    },
    async beforeCall() {
      const { rows } = await db.query<{ calls: number }>(
        `insert into api_usage (day, source, calls) values ($1, $2, 1)
         on conflict (day, source) do update set calls = api_usage.calls + 1 returning calls`,
        [day(), source],
      );
      if (Number(rows[0]!.calls) > limit) throw new BudgetExceededError(`${source} daily budget of ${limit} exceeded`);
    },
  };
}
