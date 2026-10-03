import { readFile } from 'node:fs/promises';
import type { ValuationKey } from '../domain/types.js';
import type { CompPoint } from './valuation.js';

export interface SourcedComp extends CompPoint {
  /** Must be stable per real-world sale, so refetching the same sale upserts instead of duplicating. */
  sourceRef: string;
}

export interface CompsSource {
  name: string;
  fetchComps(key: ValuationKey): Promise<SourcedComp[]>;
}

export interface FixtureEntry extends ValuationKey {
  sales: { price: number; daysAgo: number }[];
}

/** Development-only source. Dates are relative to `now` so the fixture never goes stale. */
export function fixtureCompsSource(entries: FixtureEntry[], now: () => Date): CompsSource {
  return {
    name: 'fixture',
    async fetchComps(key) {
      const entry = entries.find((e) => e.cardId === key.cardId && e.grader === key.grader && e.grade === key.grade);
      if (!entry) return [];
      return entry.sales.map((s, index) => {
        const soldAt = new Date(now().getTime() - s.daysAgo * 86_400_000);
        return {
          price: s.price, soldAt, kind: 'paid_source' as const,
          sourceRef: `fixture:${key.cardId}:${key.grader}:${key.grade}:${index}`,
        };
      });
    },
  };
}

export async function loadFixtureCompsSource(path: string, now: () => Date): Promise<CompsSource> {
  const body = JSON.parse(await readFile(path, 'utf8')) as { entries: FixtureEntry[] };
  return fixtureCompsSource(body.entries, now);
}
