export type Grader = 'PSA' | 'CGC' | 'BGS' | 'SGC' | 'TAG';

export type CompKind = 'paid_source' | 'disappearing_bin' | 'browser_agent';

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
