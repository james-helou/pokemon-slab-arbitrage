import { ButtonStyle, ComponentType, type APIEmbed } from 'discord.js';
import type { StoredRecommendation } from '../ledger/ledger-repo.js';
import type { SoldCheckRunStatus, SoldCheckSnapshot } from '../soldcheck/sold-check.js';
import { buildCheckLinks } from './check-links.js';

export interface ActionRow {
  type: ComponentType.ActionRow;
  components: Record<string, unknown>[];
}

export interface AlertPayload {
  content?: string;
  embeds: APIEmbed[];
  components: ActionRow[];
}

export const PASS_REASONS = ['condition', 'fake_suspicion', 'price', 'not_interested', 'other'] as const;

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function safeEbayUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const ok = u.protocol === 'https:' && (u.hostname === 'ebay.com' || u.hostname.endsWith('.ebay.com'));
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const cadSuffix = (n: number, rate: number | null | undefined) => (rate ? ` (≈ C$${(n * rate).toFixed(2)})` : '');

const UNAVAILABLE: Record<SoldCheckRunStatus, string> = {
  ok: 'no median',
  no_results: 'no matching sales',
  blocked: 'blocked by eBay',
  error: 'fetch error',
  skipped_budget: 'daily cap reached',
  skipped_rate: 'rate limited',
  skipped_blocked: 'paused after an eBay block',
};

function soldCheckLine(s: SoldCheckSnapshot, value: number, createdAt: Date): string {
  if (s.verdict === 'unavailable' || s.median === null) return `unavailable (${UNAVAILABLE[s.status] ?? s.status})`;
  if (s.verdict === 'disagrees') return `disagrees: value ${usd(value)} vs sold median ${usd(s.median)} (${s.saleCount} sales)`;
  const ref = s.fetchedAt ? new Date(s.fetchedAt) : createdAt;
  const age = s.newestSoldAt ? `newest ${Math.max(0, Math.floor((ref.getTime() - new Date(s.newestSoldAt).getTime()) / 86_400_000))}d` : 'newest ?';
  const note = s.verdict === 'insufficient' ? ', too few to judge' : '';
  return `eBay sold median ${usd(s.median)} from ${s.saleCount} sales (${age}${note})`;
}

export function buildAlertPayload(r: StoredRecommendation, opts?: { usdCad?: number | null }): AlertPayload {
  const rate = opts?.usdCad;
  const v = r.valuationSnapshot;
  const nets = r.channelNets
    .map((c) => {
      const line = `${c.channel}: ${usd(c.net)}${c.daysToSell !== null ? ` (~${c.daysToSell}d to sell)` : ''}`;
      return c.channel === r.bestChannel ? `**${line}**` : line;
    })
    .join('\n');
  const ship = r.listingSnapshot.shipping === null ? 'ship ?' : `ship ${usd(r.listingSnapshot.shipping)}`;

  const url = safeEbayUrl(r.listingSnapshot.url);
  const discount = v.value > 0 ? Math.round((1 - r.buyTotal / v.value) * 100) : 0;
  const why = [
    `${Math.round(v.confidence * 100)}% valuation confidence from ${v.compCount} comps`,
    `${discount}% below market value`,
    r.redFlags.length > 0 ? `flags: ${r.redFlags.join(', ')}` : 'no red flags',
  ].join('\n');

  const fields: NonNullable<APIEmbed['fields']> = [
    {
      name: 'Buy total',
      value: `${usd(r.buyTotal)}${cadSuffix(r.buyTotal, rate)} (list ${usd(r.listingSnapshot.price)} + ${ship} + tax)`,
    },
    {
      name: 'Market value',
      value: `${usd(v.value)} (range ${usd(v.low)} to ${usd(v.high)}, ${v.compCount} comps, newest ${Math.round(v.newestCompAgeDays)}d)`,
    },
    ...(r.soldCheck ? [{ name: 'Sold check', value: soldCheckLine(r.soldCheck, v.value, r.createdAt) }] : []),
    { name: 'Best net', value: `${usd(r.bestNet)} via ${r.bestChannel} · ROI ${Math.round(r.roi * 100)}%${cadSuffix(r.bestNet, rate)}`, inline: true },
    { name: 'Confidence', value: `${Math.round(r.confidence * 100)}%`, inline: true },
    { name: 'Net by channel', value: nets || 'none' },
    { name: 'Cert', value: r.cert ?? 'not listed', inline: true },
    { name: 'Why', value: why },
  ];
  if (r.redFlags.length > 0) fields.push({ name: 'Red flags', value: r.redFlags.join(', '), inline: true });

  const embed: APIEmbed = {
    title: `${r.grader} ${r.grade} · ${r.cardSnapshot.name} (${r.cardSnapshot.setName} #${r.cardSnapshot.number})`.slice(0, 256),
    color: r.routedTo === 'alerts' ? 0x2ecc71 : 0x95a5a6,
    description: r.listingSnapshot.title.slice(0, 300),
    fields: fields.map((f) => ({ ...f, value: truncate(f.value, 1024) })),
    footer: { text: `rec #${r.id} · comps: ${v.compsSource} · scorer ${r.scorerVersion}` },
  };
  if (url) embed.url = url;
  if (r.listingSnapshot.imageUrl) embed.image = { url: r.listingSnapshot.imageUrl };

  const checkLinks = buildCheckLinks({ ...r.cardSnapshot, grader: r.grader, grade: r.grade }).slice(0, 5);

  return {
    content: v.compsSource.split('+').includes('fixture')
      ? '⚠️ SAMPLE COMPS, not real prices. Do not buy from this alert.'
      : undefined,
    embeds: [embed],
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          ...(url ? [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'Open in eBay', url }] : []),
          { type: ComponentType.Button, style: ButtonStyle.Success, label: 'Bought', custom_id: `bought:${r.id}` },
          { type: ComponentType.Button, style: ButtonStyle.Danger, label: 'Pass', custom_id: `pass:${r.id}` },
          { type: ComponentType.Button, style: ButtonStyle.Secondary, label: 'Watch', custom_id: `watch:${r.id}` },
        ],
      },
      ...(checkLinks.length > 0
        ? [{
            type: ComponentType.ActionRow as const,
            components: checkLinks.map((l) => ({ type: ComponentType.Button, style: ButtonStyle.Link, label: l.label, url: l.url })),
          }]
        : []),
    ],
  };
}

export function buildPassReasonMenu(recommendationId: number): ActionRow {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        custom_id: `passreason:${recommendationId}`,
        placeholder: 'Why pass?',
        options: PASS_REASONS.map((r) => ({ label: r.replace('_', ' '), value: r })),
      },
    ],
  };
}
