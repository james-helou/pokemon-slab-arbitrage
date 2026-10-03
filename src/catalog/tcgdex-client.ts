import type { Log } from '../log.js';
import { normalizeNumber } from '../matcher/title-parse.js';
import type { CardRow } from './catalog-repo.js';

const BASE = 'https://api.tcgdex.net/v2/en';
const MAX_TRIES = 4;
const BASE_DELAY_MS = 500;
const CONCURRENCY = 4;

interface TcgdexSetBrief {
  id: string;
}

interface TcgdexSet {
  id: string;
  name: string;
  cardCount?: { official?: number; total?: number };
  cards?: { id: string; localId: string; name: string }[];
}

export interface FetchAllResult {
  cards: CardRow[];
  skippedSets: string[];
}

export interface ClientOptions {
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GET json, retrying 429 and 5xx (and network errors) with exponential backoff, up to MAX_TRIES attempts. */
async function getJson<T>(fetchFn: typeof fetch, path: string, sleep: (ms: number) => Promise<void>): Promise<T> {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let retryable = true;
    try {
      const res = await fetchFn(`${BASE}${path}`);
      if (res.ok) return (await res.json()) as T;
      lastError = `${res.status}`;
      retryable = res.status === 429 || res.status >= 500;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (!retryable) break;
    if (attempt < MAX_TRIES) await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
  }
  throw new Error(`tcgdex ${path}: ${lastError}`);
}

/** Fetches every English card. A set that keeps failing is skipped and reported, not fatal. */
export async function fetchAllCards(fetchFn: typeof fetch, log: Log, opts: ClientOptions = {}): Promise<FetchAllResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const sets = await getJson<TcgdexSetBrief[]>(fetchFn, '/sets', sleep);
  const bySet: CardRow[][] = sets.map(() => []);
  const skippedSets: string[] = [];
  let next = 0;

  const worker = async () => {
    while (next < sets.length) {
      const i = next++;
      const id = sets[i]!.id;
      try {
        const set = await getJson<TcgdexSet>(fetchFn, `/sets/${encodeURIComponent(id)}`, sleep);
        bySet[i] = (set.cards ?? []).map((c) => ({
          id: c.id, name: c.name, number: normalizeNumber(c.localId.replace(/\s+/g, '')),
          setId: set.id, setName: set.name, setPrintedTotal: set.cardCount?.official ?? null,
        }));
        log('info', 'catalog set fetched', { set: id, cards: bySet[i]!.length });
      } catch (err) {
        skippedSets.push(id);
        log('warn', 'catalog set skipped after retries', { set: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sets.length) }, worker));
  return { cards: bySet.flat(), skippedSets };
}
