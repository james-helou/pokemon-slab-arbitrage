import { matchListing, type CandidateLookup } from '../matcher/matcher.js';
import type { ParsedSale } from './parse.js';
import type { SoldCheckKey } from './sold-checks-repo.js';

export const MAX_SALE_AGE_DAYS = 90;
const DAY = 86_400_000;

export interface SoldSummary {
  status: 'ok' | 'no_results';
  saleCount: number;
  median: number | null;
  /** p25 of kept sale prices. */
  low: number | null;
  /** p75 of kept sale prices. */
  high: number | null;
  newestSoldAt: Date | null;
  matchedTitles: string[];
}

export interface SummarizeOpts {
  key: SoldCheckKey;
  lookup: CandidateLookup;
  minMatchConfidence: number;
  now: Date;
}

/** Linear-interpolated percentile (q in 0..1) of a non-empty list. */
export function percentile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (values: number[]) => percentile(values, 0.5);

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Pure apart from the injected lookup. Keeps a sale only when it is a single USD sale at a known price,
 * sold within 90 days, and the same rules matcher the pipeline uses (no LLM) maps its title to the same
 * card, grader and grade at or above minMatchConfidence, with no grade label (pristine/black label).
 *
 * Confidence ceiling: sold titles carry no item aspects, so the best a title-only match can score is
 * 0.95 (name in title) x 0.9 (grade from title) = 0.855. That sits just above the 0.85 default floor;
 * raising minMatchConfidence past 0.855 would silently drop every sale. A test pins this.
 */
export async function summarizeSales(sales: ParsedSale[], opts: SummarizeOpts): Promise<SoldSummary> {
  const { key, lookup, minMatchConfidence, now } = opts;
  const oldest = now.getTime() - MAX_SALE_AGE_DAYS * DAY;
  const kept: (ParsedSale & { soldAt: Date })[] = [];
  for (const s of sales) {
    if (s.isLot || s.bestOfferAccepted || s.currency !== 'USD') continue;
    if (!s.soldAt || s.soldAt.getTime() < oldest || s.soldAt.getTime() > now.getTime() + DAY) continue;
    if (!(Number.isFinite(s.price) && s.price > 0)) continue;
    const { match } = await matchListing({ title: s.title, aspects: {} }, lookup);
    if (!match) continue;
    if (match.cardId !== key.cardId || match.grader !== key.grader || match.grade !== key.grade) continue;
    if (match.confidence < minMatchConfidence || match.gradeLabel !== null) continue;
    kept.push({ ...s, soldAt: s.soldAt });
  }
  if (kept.length < 1) {
    return { status: 'no_results', saleCount: 0, median: null, low: null, high: null, newestSoldAt: null, matchedTitles: [] };
  }
  const prices = kept.map((s) => s.price);
  return {
    status: 'ok',
    saleCount: kept.length,
    median: cents(median(prices)),
    low: cents(percentile(prices, 0.25)),
    high: cents(percentile(prices, 0.75)),
    newestSoldAt: new Date(Math.max(...kept.map((s) => s.soldAt.getTime()))),
    matchedTitles: kept.map((s) => s.title),
  };
}
