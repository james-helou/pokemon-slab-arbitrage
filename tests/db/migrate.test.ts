import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { createTestDb } from '../helpers/test-db.js';

describe('migrate', () => {
  it('applies the schema once and is idempotent', async () => {
    const db = await createTestDb();
    const again = await migrate(db, 'migrations');
    expect(again).toEqual([]);
    const { rows } = await db.query<{ name: string }>('select name from channels order by name');
    expect(rows.map((r) => r.name)).toEqual(['ebay', 'friend', 'local', 'tcgplayer']);
  });

  it('makes recommendations append-only', async () => {
    const db = await createTestDb();
    await db.query(`insert into cards (id, name, number, set_id, set_name, set_printed_total) values ('c1','Card','1','s','Set',10)`);
    await db.query(
      `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
        valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
        scorer_version, matcher_version, oracle_version)
       values ('ebay','x','c1','PSA',10,null,'{}','{}','{}','[]','ebay',1,1,1,1,1,'[]','alerts','v','v','v')`,
    );
    await expect(db.query(`update recommendations set best_net = 2`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from recommendations`)).rejects.toThrow(/append-only/);
  });
});
