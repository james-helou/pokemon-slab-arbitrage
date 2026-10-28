import type { APIEmbed } from 'discord.js';
import type { Grader } from '../domain/types.js';
import type { SourceValue } from '../watch/market-value.js';
import { cadSuffix, safeEbayUrl, usd, type AlertPayload } from './alert-payload.js';

export interface WatchAlert {
  title: string;
  url: string;
  imageUrl: string | null;
  cardName: string;
  setName: string;
  number: string;
  grader: Grader;
  grade: number;
  bid: number;
  bidCount: number;
  endsAt: Date;
  value: number;
  sources: SourceValue[];
  gapUsd: number;
  gapPct: number;
  realert: boolean;
}

/** Watchlist alert: a live auction bid above market value. Informational only, so no buttons. */
export function buildWatchPayload(w: WatchAlert, opts: { now: Date; usdCad?: number | null }): AlertPayload {
  const url = safeEbayUrl(w.url);
  const unix = Math.floor(w.endsAt.getTime() / 1000);
  const fields: NonNullable<APIEmbed['fields']> = [
    { name: 'Current bid', value: `${usd(w.bid)} (${w.bidCount} ${w.bidCount === 1 ? 'bid' : 'bids'})${cadSuffix(w.bid, opts.usdCad)}` },
    {
      name: 'Market value',
      value: [usd(w.value), ...w.sources.map((s) => `${s.name} ${usd(s.value)} (${s.saleCount} sales)`)].join('\n'),
    },
    { name: 'Gap', value: `+${usd(w.gapUsd)} (+${Math.round(w.gapPct * 100)}%)` },
    { name: 'Ends', value: `<t:${unix}:R>` },
    ...(url ? [{ name: 'Link', value: url }] : []),
  ];
  const embed: APIEmbed = {
    title: `${w.realert ? 'Still climbing' : 'Bid above market'}: ${w.cardName} ${w.grader} ${w.grade}`.slice(0, 256),
    color: w.realert ? 0xe67e22 : 0x9b59b6,
    description: `${w.setName} #${w.number}\n${w.title}`.slice(0, 300),
    fields: fields.map((f) => ({ ...f, value: f.value.slice(0, 1024) })),
    timestamp: opts.now.toISOString(),
  };
  if (url) embed.url = url;
  if (w.imageUrl) embed.image = { url: w.imageUrl };
  return { embeds: [embed], components: [] };
}
