import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pptTcgplayerId } from '../../src/ppt/tcgplayer-id.js';
import { createTestDb } from '../helpers/test-db.js';

const respond = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const v = (type: string, subtype: string | null, tcgplayer: number | null) => ({ type, subtype, thirdParty: { tcgplayer } });

describe('pptTcgplayerId (real TCGdex shapes, verified 2026-10-10)', () => {
  it('base1-2: unlimited plus shadowless and copyright prints resolves to the unlimited id', async () => {
    const body = { variants_detailed: [
      v('holo', 'unlimited', 42360), v('holo', 'shadowless', 106997), v('holo', 'shadowless', 106997),
      v('holo', '1999-2000-copyright', null),
    ] };
    expect(await pptTcgplayerId(respond(body), 'base1-2')).toBe('42360');
  });

  it('mep-070: two holo ids with no subtype stay ambiguous (null)', async () => {
    const body = { variants_detailed: [v('holo', null, 685562), v('holo', null, 685563)] };
    expect(await pptTcgplayerId(respond(body), 'mep-070')).toBeNull();
  });

  it('30th-158: a single id is returned as a string', async () => {
    expect(await pptTcgplayerId(respond({ variants_detailed: [v('holo', null, 696688)] }), '30th-158')).toBe('696688');
  });

  it('sm5-164: no tcgplayer id at all is null', async () => {
    expect(await pptTcgplayerId(respond({ variants_detailed: [v('normal', null, null)] }), 'sm5-164')).toBeNull();
  });

  it('drops reverse, 1st edition and first-edition variants too, and tolerates missing fields', async () => {
    const body = { variants_detailed: [
      v('reverse', null, 2), v('normal', '1st-edition', 3), v('holo', 'First Edition', 4),
      { thirdParty: { tcgplayer: 9 } }, { type: 'normal' }, { type: 'normal', subtype: 'unlimited', thirdParty: { tcgplayer: '' } },
    ] };
    expect(await pptTcgplayerId(respond(body), 'x')).toBe('9');
    expect(await pptTcgplayerId(respond({}), 'x')).toBeNull();
  });

  it('404 is null; any other failure is error (nothing to cache)', async () => {
    expect(await pptTcgplayerId(respond({}, 404), 'x')).toBeNull();
    expect(await pptTcgplayerId(respond({}, 500), 'x')).toBe('error');
    expect(await pptTcgplayerId((async () => { throw new Error('down'); }) as unknown as typeof fetch, 'x')).toBe('error');
  });
});

describe('migration 016', () => {
  it('clears plain negative ppt cache rows only', async () => {
    const db = await createTestDb(); // applies every migration, 016 included, without error
    const t = new Date('2026-10-10T00:00:00Z');
    const ins = (provider: string, id: string, body: string | null, kind: string | null) =>
      db.query(`insert into vendor_card_cache (provider, card_id, fetched_at, body, kind) values ($1, $2, $3, $4::jsonb, $5)`, [provider, id, t, body, kind]);
    await ins('ppt', 'neg', null, null);
    await ins('ppt', 'failed', null, 'failed');
    await ins('ppt', 'pos', '{"a":1}', null);
    await ins('other', 'neg', null, null);
    await db.exec(readFileSync('migrations/016_ppt_negative_cache_reset.sql', 'utf8'));
    const { rows } = await db.query<{ provider: string; card_id: string }>('select provider, card_id from vendor_card_cache order by provider, card_id');
    expect(rows).toEqual([{ provider: 'other', card_id: 'neg' }, { provider: 'ppt', card_id: 'failed' }, { provider: 'ppt', card_id: 'pos' }]);
  });
});
