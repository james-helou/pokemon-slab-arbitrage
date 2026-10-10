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
    const ok = u.protocol === 'https:' && ['ebay.com', 'ebay.ca'].some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
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

  const snap = r.listingSnapshot;
  const cadList = snap.originalCurrency === 'CAD' && snap.originalPrice != null ? `C$${snap.originalPrice.toFixed(2)} (≈ ${usd(snap.price)})` : null;
  const offer = r.kind === 'offer' && r.suggestedPrice != null ? r.suggestedPrice : null;
  const offerField: NonNullable<APIEmbed['fields']> = offer === null ? [] : [{
    name: 'Make an offer',
    value: `Offer ${usd(offer).replace(/\.00$/, '')}${cadSuffix(offer, rate)} ` +
      `(${Math.round((1 - offer / r.listingSnapshot.price) * 100)}% under ask ${usd(r.listingSnapshot.price)})\n` +
      `Send it yourself on eBay. Highest offer that still clears the rules: ${usd(r.listingSnapshot.maxOffer ?? offer)}.`,
  }];

  const auction = r.kind === 'auction' && r.suggestedPrice != null && r.listingSnapshot.auction ? r.listingSnapshot.auction : null;
  const auctionFields: NonNullable<APIEmbed['fields']> = auction === null ? [] : [
    (() => {
      const unix = Math.floor(new Date(auction.endsAt).getTime() / 1000);
      return { name: 'Ends', value: `<t:${unix}:R> (<t:${unix}:t>)` };
    })(),
    { name: 'Current bid', value: `${usd(auction.currentBid)} (${auction.bidCount} ${auction.bidCount === 1 ? 'bid' : 'bids'})${cadSuffix(auction.currentBid, rate)}` },
    (() => {
      const max = r.suggestedPrice!;
      const t = r.listingSnapshot.ceilingTerms;
      const rules = t
        ? ` and ${+(t.taxRate * 100).toFixed(3)}% tax (buy total ${usd(r.buyTotal)}) still clears net ${usd(t.minNet).replace(/\.00$/, '')} and ROI ${Math.round(t.minRoi * 100)}%`
        : ` (buy total ${usd(r.buyTotal)}) is the most you should pay`;
      return {
        name: 'Max bid',
        value: `${usd(max)}${cadSuffix(max, rate)}\nAll-in ceiling: winning at this price plus ${r.listingSnapshot.shipping === null ? 'shipping' : `${usd(r.listingSnapshot.shipping)} shipping`}${rules}. Bid it yourself on eBay.`,
      };
    })(),
  ];

  const buyPart = auction !== null ? usd(r.suggestedPrice!) : offer !== null ? usd(offer) : (cadList ?? usd(snap.price));
  const fields: NonNullable<APIEmbed['fields']> = [
    ...offerField,
    ...auctionFields,
    {
      name: auction !== null ? 'Buy total at max bid' : offer === null ? 'Buy total' : 'Buy total at offer',
      value: `${usd(r.buyTotal)}${cadSuffix(r.buyTotal, rate)} (${auction !== null ? 'max bid' : offer === null ? 'list' : 'offer'} ${buyPart} + ${ship} + tax)`,
    },
    {
      name: 'Market value',
      value: `${usd(v.value)} (range ${usd(v.low)} to ${usd(v.high)}, ${v.compCount} comps, newest ${Math.round(v.newestCompAgeDays)}d)`,
    },
    ...(r.soldCheck ? [{ name: 'Sold check', value: soldCheckLine(r.soldCheck, v.value, r.createdAt) }] : []),
    { name: auction === null ? 'Best net' : 'Best net at max bid', value: `${usd(r.bestNet)} via ${r.bestChannel} · ROI ${Math.round(r.roi * 100)}%${cadSuffix(r.bestNet, rate)}`, inline: true },
    { name: 'Confidence', value: `${Math.round(r.confidence * 100)}%`, inline: true },
    { name: 'Net by channel', value: nets || 'none' },
    { name: 'Cert', value: r.cert ?? 'not listed', inline: true },
    { name: 'Why', value: why },
  ];
  if (r.redFlags.length > 0) fields.push({ name: 'Red flags', value: r.redFlags.join(', '), inline: true });

  const embed: APIEmbed = {
    title: `${offer === null ? '' : 'MAKE AN OFFER · '}${auction === null ? '' : 'AUCTION · '}${r.grader} ${r.grade} · ${r.cardSnapshot.name} (${r.cardSnapshot.setName} #${r.cardSnapshot.number})`.slice(0, 256),
    color: r.routedTo === 'alerts' ? (auction !== null ? 0x3498db : offer === null ? 0x2ecc71 : 0xf1c40f) : 0x95a5a6,
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
