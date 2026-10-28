export type Grader = 'PSA' | 'CGC' | 'BGS' | 'SGC' | 'TAG';

export type CompKind = 'paid_source' | 'disappearing_bin' | 'browser_agent' | 'auction_result';
/** Why a listing's gone_at was set. See migrations/005_disappearing_bin.sql for the exact meaning of each. */
export type GoneReason = 'out_of_stock' | 'not_found' | 'window_miss';

export type ListingOrigin = 'us_bin' | 'ca_bin' | 'auction';

export interface Listing {
  source: 'ebay';
  externalId: string;
  title: string;
  price: number;
  /** null = unknown (eBay gave no shipping cost); callers must treat as blocking. */
  shipping: number | null;
  currency: string;
  url: string;
  imageUrl: string | null;
  sellerUsername: string | null;
  sellerFeedbackScore: number | null;
  sellerFeedbackPct: number | null;
  listedAt: Date | null;
  aspects: Record<string, string>;
  raw: unknown;
  /** Which scan found it; absent = us_bin. */
  origin?: ListingOrigin;
  buyingOptions?: string[] | null;
  /** Seller's price/currency before our CAD->USD conversion (CA scan only). */
  originalPrice?: number | null;
  originalCurrency?: string | null;
  auction?: { currentBid: number; bidCount: number; endsAt: Date } | null;
}

export interface Match {
  cardId: string;
  grader: Grader;
  grade: number;
  gradeLabel: 'pristine' | 'black_label' | null;
  cert: string | null;
  confidence: number;
  reasons: string[];
  matcherVersion: string;
}

export interface ValuationKey {
  cardId: string;
  grader: Grader;
  grade: number;
}

export interface Valuation extends ValuationKey {
  value: number;
  low: number;
  high: number;
  compCount: number;
  newestCompAgeDays: number;
  confidence: number;
  compsSource: string;
  oracleVersion: string;
  computedAt: Date;
}

export interface RedFlag {
  code: string;
  blocking: boolean;
  confidencePenalty: number;
}
