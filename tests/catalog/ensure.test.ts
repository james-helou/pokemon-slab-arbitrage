import { describe, expect, it } from 'vitest';
import { ensureCatalog } from '../../src/catalog/ensure.js';
import { silentLog } from '../../src/log.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

describe('ensureCatalog', () => {
  it('does not sync when the catalog already has cards', async () => {
    const db = await createTestDb();
    await seedCards(db);
    let calls = 0;
    expect(await ensureCatalog(db, async () => { calls++; return 1; }, silentLog)).toBe(true);
    expect(calls).toBe(0);
  });

  it('syncs an empty catalog and succeeds once cards exist', async () => {
    const db = await createTestDb();
    const sync = async () => { await seedCards(db); return 3; };
    expect(await ensureCatalog(db, sync, silentLog)).toBe(true);
  });

  it('fails when the sync throws', async () => {
    const db = await createTestDb();
    const logs: string[] = [];
    const ok = await ensureCatalog(db, async () => { throw new Error('429'); }, (_l, m) => void logs.push(m));
    expect(ok).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('fails when the catalog is still empty after a sync', async () => {
    const db = await createTestDb();
    expect(await ensureCatalog(db, async () => 0, silentLog)).toBe(false);
  });
});
