import { ButtonStyle, ComponentType, type APIEmbed } from 'discord.js';
import type { StoredRecommendation } from '../ledger/ledger-repo.js';

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

export function buildAlertPayload(r: StoredRecommendation): AlertPayload {
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
      value: `${usd(r.buyTotal)} (list ${usd(r.listingSnapshot.price)} + ${ship} + tax)`,
    },
    {
      name: 'Market value',
      value: `${usd(v.value)} (range ${usd(v.low)} to ${usd(v.high)}, ${v.compCount} comps, newest ${Math.round(v.newestCompAgeDays)}d)`,
    },
    { name: 'Best net', value: `${usd(r.bestNet)} via ${r.bestChannel} · ROI ${Math.round(r.roi * 100)}%`, inline: true },
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

  return {
    content: v.compsSource === 'fixture' ? '⚠️ SAMPLE COMPS, not real prices. Do not buy from this alert.' : undefined,
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
