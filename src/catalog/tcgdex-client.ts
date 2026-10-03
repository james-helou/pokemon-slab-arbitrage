import type { Log } from '../log.js';
import { normalizeNumber } from '../matcher/title-parse.js';
import type { CardRow } from './catalog-repo.js';

const BASE = 'https://api.tcgdex.net/v2/en';
const MAX_TRIES = 4;
const BASE_DELAY_MS = 500;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_S = 30;
/** Digital or otherwise non-physical series. TCG Pocket (tcgp) card names would cause ambiguous matches. */
export const EXCLUDED_SERIES = ['tcgp'];

interface TcgdexSetBrief {
  id: string;
}

interface TcgdexSet {
  id: string;
  name: string;
  serie?: { id: string };
  cardCount?: { official?: number; total?: number };
  cards?: { id: string; localId: string; name: string }[];
}

export interface FetchAllResult {
  cards: CardRow[];
  skippedSets: string[];
  attemptedSets: number;
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
    let delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    try {
      const res = await fetchFn(`${BASE}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return (await res.json()) as T;
      lastError = `${res.status}`;
      retryable = res.status === 429 || res.status >= 500;
      const retryAfter = Number(res.headers.get('Retry-After'));
      if (res.status === 429 && res.headers.get('Retry-After') && Number.isFinite(retryAfter) && retryAfter >= 0) {
        delay = Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (!retryable) break;
    if (attempt < MAX_TRIES) await sleep(delay);
  }
  throw new Error(`tcgdex ${path}: ${lastError}`);
}

/** Fetches every English card. A set that keeps failing is skipped and reported, not fatal. */
export async function fetchAllCards(fetchFn: typeof fetch, log: Log, opts: ClientOptions = {}): Promise<FetchAllResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const allSets = await getJson<TcgdexSetBrief[]>(fetchFn, '/sets', sleep);
  // The brief set list has no series field, so look up each excluded series' set ids up front.
  const excludedIds = new Set<string>();
  for (const serie of EXCLUDED_SERIES) {
    try {
      const body = await getJson<{ sets?: { id: string }[] }>(fetchFn, `/series/${encodeURIComponent(serie)}`, sleep);
      for (const s of body.sets ?? []) excludedIds.add(s.id);
    } catch (err) {
      log('warn', 'excluded series lookup failed, relying on set detail', { serie, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const sets = allSets.filter((s) => !excludedIds.has(s.id));
  let excluded = allSets.length - sets.length;
  const bySet: CardRow[][] = sets.map(() => []);
  const skippedSets: string[] = [];
  let next = 0;

  const worker = async () => {
    while (next < sets.length) {
      const i = next++;
      const id = sets[i]!.id;
      try {
        const set = await getJson<TcgdexSet>(fetchFn, `/sets/${encodeURIComponent(id)}`, sleep);
        if (set.serie && EXCLUDED_SERIES.includes(set.serie.id)) {
          excluded++;
          continue;
        }
        bySet[i] = (set.cards ?? []).map((c) => ({
          id: c.id, name: c.name, number: normalizeNumber(c.localId.replace(/\s+/g, '')),
          setId: set.id, setName: set.name, setPrintedTotal: set.cardCount?.official || null,
        }));
        log('info', 'catalog set fetched', { set: id, cards: bySet[i]!.length });
      } catch (err) {
        skippedSets.push(id);
        log('warn', 'catalog set skipped after retries', { set: id, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sets.length) }, worker));
  log('info', 'catalog excluded sets in excluded series', { excluded, series: EXCLUDED_SERIES });
  return { cards: bySet.flat(), skippedSets, attemptedSets: sets.length };
}
