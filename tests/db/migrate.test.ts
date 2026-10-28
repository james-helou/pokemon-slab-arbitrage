import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
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
    const { rows } = await db.query<{ status: string; claimed_at: Date | null }>('select status, claimed_at from job_runs');
    expect(rows).toEqual([{ status: 'done', claimed_at: null }]);
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
  it('migration 017 backfills buying_options and defaults recommendation kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-'));
    const { readdir, readFile } = await import('node:fs/promises');
    const files = (await readdir('migrations')).filter((f) => f < '017').sort();
    for (const f of files) await writeFile(join(dir, f), await readFile(join('migrations', f)));
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    const old: Db = {
      async query<T>(text: string, params: unknown[] = []) {
        return { rows: (await pg.query<T>(text, params as never[])).rows };
      },
      async exec(text: string) {
        await pg.exec(text);
      },
    };
    await migrate(old, dir);
    await old.query(`insert into cards (id, name, number, set_id, set_name, set_printed_total) values ('c1','Card','1','s','Set',10)`);
    await old.query(
      `insert into listings (source, external_id, title, price, currency, url, aspects, raw, first_seen_at, last_seen_at)
       values ('ebay','a','t',1,'USD','u','{}','{"buyingOptions":["FIXED_PRICE","BEST_OFFER"]}', now(), now()),
              ('ebay','b','t',1,'USD','u','{}','{}', now(), now())`,
    );
    await old.query(
      `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
        valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
        scorer_version, matcher_version, oracle_version)
       values ('ebay','a','c1','PSA',10,null,'{}','{}','{}','[]','ebay',1,1,1,1,1,'[]','alerts','v','v','v')`,
    );
    expect(await migrate(old, 'migrations')).toContain('017_deal_modes.sql');
    const l = await old.query<{ external_id: string; origin: string; buying_options: unknown }>(
      'select external_id, origin, buying_options from listings order by external_id',
    );
    expect(l.rows).toEqual([
      { external_id: 'a', origin: 'us_bin', buying_options: ['FIXED_PRICE', 'BEST_OFFER'] },
      { external_id: 'b', origin: 'us_bin', buying_options: null },
    ]);
    const r = await old.query<{ kind: string; suggested_price: string | null }>('select kind, suggested_price from recommendations');
    expect(r.rows).toEqual([{ kind: 'bin', suggested_price: null }]);
  });

  it('enforces the recommendation kind / suggested_price pairing', async () => {
    const db = await createTestDb();
    await db.query(`insert into cards (id, name, number, set_id, set_name, set_printed_total) values ('c1','Card','1','s','Set',10)`);
    const ins = (kind: string, price: number | null) =>
      db.query(
        `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
          valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
          scorer_version, matcher_version, oracle_version, kind, suggested_price)
         values ('ebay',$1,'c1','PSA',10,null,'{}','{}','{}','[]','ebay',1,1,1,1,1,'[]','alerts','v','v','v',$2,$3)`,
        [`x-${kind}-${price}`, kind, price],
      );
    await expect(ins('offer', null)).rejects.toThrow();
    await expect(ins('bin', 5)).rejects.toThrow();
    await expect(ins('bogus', 5)).rejects.toThrow();
    await expect(ins('offer', 350)).resolves.toBeDefined();
    await expect(ins('bin', null)).resolves.toBeDefined();
  });
  it('migration 019 adds watch_auctions and the auction_result comp kind', async () => {
    const db = await createTestDb();
    await db.query(`insert into cards (id, name, number, set_id, set_name, set_printed_total) values ('c1','Card','1','s','Set',10)`);
    await expect(db.query(
      `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref)
       values ('c1','PSA',10,100,now(),'auction_result','ebay_auction:x')`,
    )).resolves.toBeDefined();
    await expect(db.query(
      `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ('c1','PSA',10,100,now(),'bogus','y')`,
    )).rejects.toThrow();
    await expect(db.query('select * from watch_auctions')).resolves.toEqual({ rows: [] });
  });
});
