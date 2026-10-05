import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { addEntry, availableCash, recordPurchase } from '../../src/bankroll/bankroll-repo.js';
import { PASS_REASONS, buildAlertPayload, buildPassReasonMenu } from '../../src/discord/alert-payload.js';
import { handleCommand, handleComponent, parseCustomId } from '../../src/discord/handlers.js';
import { getRecommendation, hasDecision, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { loadSettings } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';
import type { SoldCheckSnapshot } from '../../src/soldcheck/sold-check.js';

async function setupRec() {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  const id = (await insertRecommendation(db, makeNewRecommendation()))!;
  const rec = (await getRecommendation(db, id))!;
  const deps = { db, ebayUsedToday: async () => 42 };
  return { db, id, rec, deps };
}

describe('buildAlertPayload', () => {
  it('renders the deal and the four actions', async () => {
    const { rec } = await setupRec();
    const p = buildAlertPayload(rec);
    const embed = p.embeds[0]!;
    expect(embed.title).toBe('PSA 10 · Charizard ex (151 #199)');
    expect(embed.url).toBe('https://www.ebay.com/itm/111');
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Best net']).toBe('$133.75 via ebay · ROI 35%');
    expect(fields['Buy total']).toContain('$379.85');
    expect(p.content).toContain('SAMPLE COMPS');
    const buttons = p.components[0]!.components as { label: string; custom_id?: string; url?: string }[];
    expect(buttons.map((b) => b.label)).toEqual(['Open in eBay', 'Bought', 'Pass', 'Watch']);
    expect(buttons[1]!.custom_id).toBe(`bought:${rec.id}`);
    expect(JSON.stringify(p)).not.toContain('—');
  });

  it('shows ship ? when shipping is unknown', async () => {
    const { rec } = await setupRec();
    const p = buildAlertPayload({ ...rec, listingSnapshot: { ...rec.listingSnapshot, shipping: null } });
    const fields = Object.fromEntries((p.embeds[0]!.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Buy total']).toContain('ship ?');
    expect(fields['Buy total']).not.toContain('null');
  });

  it('omits non-eBay urls', async () => {
    const { rec } = await setupRec();
    for (const url of ['javascript:alert(1)', 'https://evilebay.com/x', 'http://www.ebay.com/itm/1']) {
      const p = buildAlertPayload({ ...rec, listingSnapshot: { ...rec.listingSnapshot, url } });
      expect(p.embeds[0]!.url).toBeUndefined();
      expect(p.components[0]!.components.map((b) => b.label)).toEqual(['Bought', 'Pass', 'Watch']);
    }
  });

  it('caps field values at 1024 and uses a main image and a Why field', async () => {
    const { rec } = await setupRec();
    const p = buildAlertPayload({ ...rec, redFlags: ['x'.repeat(3000)] });
    const e = p.embeds[0]!;
    for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(e.image?.url).toBe('https://i.ebayimg.com/111.jpg');
    expect(e.thumbnail).toBeUndefined();
    const why = (e.fields ?? []).find((f) => f.name === 'Why')!;
    expect(why.value).toContain('6 comps');
    expect(why.value).toContain('37%');
  });

  it('adds a second row of https price-check link buttons', async () => {
    const { rec } = await setupRec();
    const p = buildAlertPayload(rec);
    expect(p.components).toHaveLength(2);
    const links = p.components[1]!.components as { style: number; label: string; url: string }[];
    expect(links.map((b) => b.label)).toEqual(['eBay sold', 'PriceCharting']);
    expect(links.length).toBeLessThanOrEqual(5);
    for (const b of links) {
      expect(b.style).toBe(ButtonStyle.Link);
      expect(new URL(b.url).protocol).toBe('https:');
    }
    expect(new URL(links[0]!.url).searchParams.get('_nkw')).toBe('Charizard ex 199 PSA 10');
  });

  it('builds a pass reason menu', () => {
    const menu = buildPassReasonMenu(7);
    const select = menu.components[0] as { custom_id: string; options: { value: string }[] };
    expect(select.custom_id).toBe('passreason:7');
    expect(select.options.map((o) => o.value)).toContain('fake_suspicion');
  });

  it('keeps the sample-comps warning when the fixture is one of several sources', async () => {
    const { rec } = await setupRec();
    const mixed = buildAlertPayload({ ...rec, valuationSnapshot: { ...rec.valuationSnapshot, compsSource: 'fixture+own_db' } });
    expect(mixed.content).toContain('SAMPLE COMPS');
    const real = buildAlertPayload({ ...rec, valuationSnapshot: { ...rec.valuationSnapshot, compsSource: 'vendor+own_db' } });
    expect(real.content).toBeUndefined();
  });
});

describe('handlers', () => {
  it('parses custom ids', () => {
    expect(parseCustomId('bought:12')).toEqual({ action: 'bought', recommendationId: 12 });
    expect(parseCustomId('nope')).toBeNull();
  });

  it('Bought records a decision and debits the bankroll once', async () => {
    const { db, id } = await setupRec();
    const r = await handleComponent(db, `bought:${id}`, [], 'james');
    expect(r.reply).toContain('$120.15');
    expect(await availableCash(db)).toBe(120.15);
    expect((await handleComponent(db, `bought:${id}`, [], 'james')).reply).toContain('Already');
    expect(await availableCash(db)).toBe(120.15);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from bankroll_ledger where kind = 'purchase' and recommendation_id = $1`,
      [id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('recordPurchase is atomic and idempotent', async () => {
    const { db, id, rec } = await setupRec();
    expect(await recordPurchase(db, { recommendationId: id, amount: rec.buyTotal, actor: 'a', note: 'n' })).toBe(true);
    expect(await recordPurchase(db, { recommendationId: id, amount: rec.buyTotal, actor: 'a', note: 'n' })).toBe(false);
    const d = await db.query<{ n: number }>(`select count(*)::int as n from decisions where action = 'bought'`);
    const l = await db.query<{ n: number }>(`select count(*)::int as n from bankroll_ledger where kind = 'purchase'`);
    expect([d.rows[0]!.n, l.rows[0]!.n]).toEqual([1, 1]);
  });

  it('rejects malformed custom ids', async () => {
    expect(parseCustomId('bought:12345678901')).toBeNull();
    const { db } = await setupRec();
    expect((await handleComponent(db, 'bought:99999999999999999999', [], 'j')).reply).toBe('Unknown action.');
  });

  it('ignores Pass after Bought', async () => {
    const { db, id } = await setupRec();
    await handleComponent(db, `bought:${id}`, [], 'james');
    expect((await handleComponent(db, `pass:${id}`, [], 'james')).reply).toContain('Already bought');
    expect((await handleComponent(db, `passreason:${id}`, ['price'], 'james')).reply).toContain('Already bought');
    expect(await hasDecision(db, id, 'pass')).toBe(false);
  });

  it('stores unknown pass reasons as other', async () => {
    const { db, id } = await setupRec();
    await handleComponent(db, `passreason:${id}`, ['<script>'], 'james');
    const { rows } = await db.query<{ reason: string }>(`select reason from decisions where action = 'pass'`);
    expect(rows[0]!.reason).toBe('other');
    expect(PASS_REASONS).toContain('other');
  });

  it('Pass asks for a reason, then logs it', async () => {
    const { db, id } = await setupRec();
    const ask = await handleComponent(db, `pass:${id}`, [], 'james');
    expect(ask.components).toHaveLength(1);
    await handleComponent(db, `passreason:${id}`, ['price'], 'james');
    expect(await hasDecision(db, id, 'pass')).toBe(true);
  });

  it('Watch logs a decision', async () => {
    const { db, id } = await setupRec();
    await handleComponent(db, `watch:${id}`, [], 'james');
    expect(await hasDecision(db, id, 'watch')).toBe(true);
  });

  it('commands pause, resume, deposit, status', async () => {
    const { db, deps } = await setupRec();
    await handleCommand(deps, 'pause', {});
    expect((await loadSettings(db)).paused).toBe(true);
    await handleCommand(deps, 'resume', {});
    expect((await loadSettings(db)).paused).toBe(false);
    expect(await handleCommand(deps, 'deposit', { amount: 100 })).toContain('$600.00');
    const status = await handleCommand(deps, 'status', {});
    expect(status).toContain('running');
    expect(status).toContain('42');
  });
});

describe('buildAlertPayload sold check field', () => {
  const snap = (over: Partial<SoldCheckSnapshot> = {}): SoldCheckSnapshot => ({
    status: 'ok', saleCount: 6, median: 590, low: 570, high: 610, newestSoldAt: '2026-10-01T00:00:00.000Z',
    fetchedAt: '2026-10-03T12:00:00.000Z', fromCache: false, parserVersion: 'v0-unverified', verdict: 'agrees', ...over,
  });
  const field = async (s?: SoldCheckSnapshot) => {
    const { rec } = await setupRec();
    const p = buildAlertPayload({ ...rec, ...(s ? { soldCheck: s } : {}) });
    return (p.embeds[0]!.fields ?? []).find((f) => f.name === 'Sold check')?.value;
  };

  it('is absent when the check did not run', async () => {
    expect(await field()).toBeUndefined();
  });

  it('shows the sold median, sale count and newest age when it agrees', async () => {
    expect(await field(snap())).toBe('eBay sold median $590.00 from 6 sales (newest 2d)');
  });

  it('says too few to judge when insufficient', async () => {
    expect(await field(snap({ saleCount: 3, verdict: 'insufficient' }))).toBe(
      'eBay sold median $590.00 from 3 sales (newest 2d, too few to judge)',
    );
  });

  it('shows value vs sold median when it disagrees', async () => {
    expect(await field(snap({ median: 450, verdict: 'disagrees' }))).toBe(
      'disagrees: value $600.00 vs sold median $450.00 (6 sales)',
    );
  });

  it('shows unavailable with a reason otherwise', async () => {
    const un = (status: SoldCheckSnapshot['status']) =>
      field(snap({ status, saleCount: 0, median: null, newestSoldAt: null, verdict: 'unavailable' }));
    expect(await un('blocked')).toBe('unavailable (blocked by eBay)');
    expect(await un('skipped_budget')).toBe('unavailable (daily cap reached)');
    expect(await un('error')).toBe('unavailable (fetch error)');
    expect(await un('no_results')).toBe('unavailable (no matching sales)');
  });
});
