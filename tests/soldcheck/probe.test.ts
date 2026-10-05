import { describe, expect, it } from 'vitest';
import { runProbe, type ProbeDeps } from '../../src/soldcheck/probe.js';
import { soldHtml } from '../helpers/sold-html.js';

const NOW = new Date('2026-10-04T12:34:56.789Z');

function harness(respond: () => Response | Promise<Response>) {
  const writes: { path: string; data: string }[] = [];
  const dirs: string[] = [];
  const out: string[] = [];
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const deps: ProbeDeps = {
    fetch: (async (url: string, init?: RequestInit) => { urls.push(url); inits.push(init); return respond(); }) as unknown as typeof fetch,
    now: () => NOW,
    mkdir: async (p) => { dirs.push(p); },
    writeFile: async (p, d) => { writes.push({ path: p, data: d }); },
    print: (line) => { out.push(line); },
  };
  return { deps, writes, dirs, out, urls, inits };
}

describe('runProbe', () => {
  it('fetches once, saves the raw page under tmp/, prints parsed sales and the blocked verdict', async () => {
    const html = soldHtml([{ price: 612, sold: 'Oct 2, 2026' }, { price: 598.5, sold: 'Sep 30, 2026' }]);
    const h = harness(() => new Response(html, { status: 200 }));
    const r = await runProbe('Charizard ex 199 PSA 10', h.deps);
    expect(h.urls).toHaveLength(1);
    const u = new URL(h.urls[0]!);
    expect(u.searchParams.get('_nkw')).toBe('Charizard ex 199 PSA 10');
    expect(u.searchParams.get('LH_Sold')).toBe('1');
    expect(h.inits[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(h.dirs).toEqual(['tmp']);
    expect(h.writes).toEqual([{ path: 'tmp/soldcheck-20261004T123456Z.html', data: html }]);
    expect(r).toMatchObject({ status: 200, blocked: false, saleCount: 2, path: 'tmp/soldcheck-20261004T123456Z.html' });
    const text = h.out.join('\n');
    expect(text).toContain('blocked: no');
    expect(text).toContain('$612.00');
    expect(text).toContain('2 parsed sales');
  });

  it('reports a block and still saves the page', async () => {
    const h = harness(() => new Response('<html>Pardon Our Interruption</html>', { status: 200 }));
    const r = await runProbe('x', h.deps);
    expect(r.blocked).toBe(true);
    expect(h.writes).toHaveLength(1);
    expect(h.out.join('\n')).toContain('blocked: YES');
  });

  it('rejects an empty query without fetching', async () => {
    const h = harness(() => new Response(''));
    await expect(runProbe('  ', h.deps)).rejects.toThrow(/query/);
    expect(h.urls).toHaveLength(0);
  });
});
