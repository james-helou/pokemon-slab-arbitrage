import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('makes outcomes append-only and unique per recommendation and horizon', async () => {
    const db = await createTestDb();
    await db.query(`insert into cards (id, name, number, set_id, set_name, set_printed_total) values ('c1','Card','1','s','Set',10)`);
    const rec = await db.query<{ id: number }>(
      `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
        valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
        scorer_version, matcher_version, oracle_version)
       values ('ebay','x','c1','PSA',10,null,'{}','{}','{}','[]','ebay',1,1,1,1,1,'[]','alerts','v','v','v') returning id`,
    );
    const recId = Number(rec.rows[0]!.id);
    const ins = (h: number) =>
      db.query(
        `insert into outcomes (recommendation_id, horizon_days, listing_final_state, label_basis, decision, min_net,
           tracker_version, observed_at)
         values ($1, $2, 'live', 'no_valuation', 'none', 75, 'v', now())
         on conflict (recommendation_id, horizon_days) do nothing returning id`,
        [recId, h],
      );
    expect((await ins(7)).rows).toHaveLength(1);
    expect((await ins(7)).rows).toHaveLength(0);
    await expect(ins(10)).rejects.toThrow();
    await expect(db.query(`update outcomes set label = 'good'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from outcomes`)).rejects.toThrow(/append-only/);
  });

  it('adds disappearance bookkeeping columns and job_runs', async () => {
    const db = await createTestDb();
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'listings' order by column_name`,
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).toEqual(expect.arrayContaining(['miss_count', 'gone_reason', 'checked_at']));
    await expect(db.query(`update listings set gone_reason = 'bogus'`)).resolves.toBeDefined(); // no rows, no error
    await db.query(`insert into job_runs (job, period, ran_at) values ('weekly_report', '2026-W40', now())`);
    await expect(
      db.query(`insert into job_runs (job, period, ran_at) values ('weekly_report', '2026-W40', now())`),
    ).rejects.toThrow();
  });

  it('rolls back a failing migration and leaves the db usable', async () => {
    const db = await createTestDb();
    const dir = await mkdtemp(join(tmpdir(), 'migrate-'));
    await writeFile(join(dir, '9001_good.sql'), 'create table mig_good (id int);');
    await writeFile(join(dir, '9002_bad.sql'), 'select * from nonexistent_table;');
    await expect(migrate(db, dir)).rejects.toThrow(/nonexistent_table/);
    await expect(db.query('select 1 as one')).resolves.toEqual({ rows: [{ one: 1 }] });
    const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
    expect(rows.map((r) => r.name)).toContain('9001_good.sql');
    expect(rows.map((r) => r.name)).not.toContain('9002_bad.sql');
  });

  it('rejects unsafe migration filenames', async () => {
    const db = await createTestDb();
    const dir = await mkdtemp(join(tmpdir(), 'migrate-'));
    await writeFile(join(dir, "x'; drop table cards;--.sql"), 'select 1;');
    await expect(migrate(db, dir)).rejects.toThrow(/invalid migration filename/i);
  });
});
