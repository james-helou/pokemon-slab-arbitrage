import { describe, expect, it } from 'vitest';
import { addEntry, availableCash } from '../../src/bankroll/bankroll-repo.js';
import { buildAlertPayload, buildPassReasonMenu } from '../../src/discord/alert-payload.js';
import { handleCommand, handleComponent, parseCustomId } from '../../src/discord/handlers.js';
import { getRecommendation, hasDecision, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { loadSettings } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

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

  it('builds a pass reason menu', () => {
    const menu = buildPassReasonMenu(7);
    const select = menu.components[0] as { custom_id: string; options: { value: string }[] };
    expect(select.custom_id).toBe('passreason:7');
    expect(select.options.map((o) => o.value)).toContain('fake_suspicion');
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
