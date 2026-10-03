import { addEntry, availableCash, recordPurchase } from '../bankroll/bankroll-repo.js';
import type { Db } from '../db/db.js';
import { getRecommendation, hasDecision, insertDecision } from '../ledger/ledger-repo.js';
import { loadSettings, setSetting } from '../settings/settings.js';
import { PASS_REASONS, buildPassReasonMenu, type ActionRow } from './alert-payload.js';

export interface ComponentResult {
  reply: string;
  components?: ActionRow[];
}

type Action = 'bought' | 'pass' | 'watch' | 'passreason';

export function parseCustomId(id: string): { action: Action; recommendationId: number } | null {
  const m = /^(bought|pass|watch|passreason):(\d{1,10})$/.exec(id);
  return m && Number.isSafeInteger(Number(m[2])) ? { action: m[1] as Action, recommendationId: Number(m[2]) } : null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function handleComponent(db: Db, customId: string, values: string[], actor: string): Promise<ComponentResult> {
  const parsed = parseCustomId(customId);
  if (!parsed) return { reply: 'Unknown action.' };
  const rec = await getRecommendation(db, parsed.recommendationId);
  if (!rec) return { reply: 'Recommendation not found.' };

  switch (parsed.action) {
    case 'bought': {
      // One atomic statement: only the first call writes the decision and debits the bankroll.
      const inserted = await recordPurchase(db, {
        recommendationId: rec.id,
        amount: rec.buyTotal,
        actor,
        note: rec.cardSnapshot.name,
      });
      if (!inserted) return { reply: 'Already marked as bought.' };
      return { reply: `Marked bought for ${usd(rec.buyTotal)}. Available cash: ${usd(await availableCash(db))}.` };
    }
    case 'pass':
      if (await hasDecision(db, rec.id, 'bought')) return { reply: 'Already bought, pass ignored.' };
      return { reply: 'Why pass? This trains the scorer.', components: [buildPassReasonMenu(rec.id)] };
    case 'passreason': {
      if (await hasDecision(db, rec.id, 'bought')) return { reply: 'Already bought, pass ignored.' };
      const picked = values[0] ?? 'other';
      const reason = (PASS_REASONS as readonly string[]).includes(picked) ? picked : 'other';
      await insertDecision(db, { recommendationId: rec.id, action: 'pass', reason, actor });
      return { reply: `Passed (${reason}). Logged for learning.` };
    }
    case 'watch':
      await insertDecision(db, { recommendationId: rec.id, action: 'watch', reason: null, actor });
      return { reply: 'Watching. The outcome will still be tracked.' };
  }
}

export interface CommandDeps {
  db: Db;
  ebayUsedToday: () => Promise<number>;
}

export async function handleCommand(deps: CommandDeps, name: string, opts: { amount?: number }): Promise<string> {
  const { db } = deps;
  switch (name) {
    case 'pause':
      await setSetting(db, 'paused', true);
      return 'Paused. Scanning and alerts stopped.';
    case 'resume':
      await setSetting(db, 'paused', false);
      return 'Resumed.';
    case 'deposit': {
      if (!opts.amount || opts.amount <= 0) return 'Amount must be positive.';
      await addEntry(db, { kind: 'deposit', amount: opts.amount });
      return `Deposited ${usd(opts.amount)}. Available cash: ${usd(await availableCash(db))}.`;
    }
    case 'status': {
      const settings = await loadSettings(db);
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from recommendations where created_at >= date_trunc('day', now())`,
      );
      return [
        `State: ${settings.paused ? 'paused' : 'running'}`,
        `Available cash: ${usd(await availableCash(db))}`,
        `eBay calls today: ${await deps.ebayUsedToday()}`,
        `Recommendations today: ${rows[0]!.n}`,
        `Thresholds: net >= ${usd(settings.minNet)}, ROI >= ${Math.round(settings.minRoi * 100)}%, buy <= ${Math.round(settings.alertRatio * 100)}% of value`,
      ].join('\n');
    }
    default:
      return 'Unknown command.';
  }
}
