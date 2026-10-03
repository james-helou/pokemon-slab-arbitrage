import { PGlite } from '@electric-sql/pglite';
import type { Db } from '../../src/db/db.js';
import { migrate } from '../../src/db/migrate.js';

export async function createTestDb(): Promise<Db> {
  const pg = new PGlite();
  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      const r = await pg.query<T>(text, params as never[]);
      return { rows: r.rows };
    },
    async exec(text: string) {
      await pg.exec(text);
    },
  };
  await migrate(db, 'migrations');
  return db;
}
