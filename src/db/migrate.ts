import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';

export async function migrate(db: Db, dir: string): Promise<string[]> {
  await db.exec(
    `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
  const done = new Set(rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    if (!/^[\w.-]+$/.test(file)) throw new Error(`Invalid migration filename: ${file}`);
    const sql = await readFile(join(dir, file), 'utf8');
    try {
      await db.exec(`begin;\n${sql}\ninsert into schema_migrations (name) values ('${file}');\ncommit;`);
    } catch (err) {
      try {
        await db.exec('rollback');
      } catch {
        // ignore rollback failure; surface the original error
      }
      throw err;
    }
    applied.push(file);
  }
  return applied;
}
