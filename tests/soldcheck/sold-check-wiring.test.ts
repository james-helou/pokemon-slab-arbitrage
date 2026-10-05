import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { buildSoldCheckDep } from '../../src/soldcheck/sold-check-wiring.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';
import { soldHtml } from '../helpers/sold-html.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');

async function harness() {
  const db = await createTestDb();
  await seedCards(db);
  const lines: { level: string; msg: string }[] = [];
  const urls: string[] = [];
  const deps = {
    db, now: () => NOW,
    log: (level: string, msg: string) => { lines.push({ level, msg }); },
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(soldHtml([{ price: 600, sold: 'Oct 2, 2026' }]));
    }) as unknown as typeof fetch,
  };
  return { deps, lines, urls };
}

describe('buildSoldCheckDep', () => {
  it('off wires no dep, logs the mode and never fetches', async () => {
    const h = await harness();
    expect(buildSoldCheckDep({ SOLD_CHECK: 'off' }, h.deps)).toBeUndefined();
    expect(h.lines.map((l) => l.msg)).toEqual(['sold check: off']);
    expect(h.urls).toEqual([]);
  });

  it('on wires a runner over the injected fetch and warns while the parser is unverified', async () => {
    const h = await harness();
    const dep = buildSoldCheckDep({ SOLD_CHECK: 'on' }, h.deps);
    expect(dep).toBeTypeOf('function');
    expect(h.lines[0]).toEqual({ level: 'info', msg: 'sold check: on' });
    expect(h.lines.some((l) => l.level === 'warn' && /unverified/.test(l.msg))).toBe(true);
    const r = await dep!({ cardId: 'sv03.5-199', grader: 'PSA', grade: 10 }, { name: 'Charizard ex', number: '199', setName: '151' }, DEFAULT_SETTINGS);
    expect(r.status).toBe('ok');
    expect(h.urls).toHaveLength(1);
  });
});
