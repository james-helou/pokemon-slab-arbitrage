import type { Log } from '../log.js';

const URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD';
const TIMEOUT_MS = 10_000;
/** After a failure, return null without refetching or logging for this long. */
const FAILURE_COOLDOWN_MS = 10 * 60_000;

export interface UsdCadDeps {
  fetch: typeof globalThis.fetch;
  now: () => Date;
  log: Log;
  ttlMs?: number;
}

/** USD to CAD rate from Frankfurter (ECB), cached in memory. Best effort: any failure returns null and logs one warn, then
 * stays null (no refetch, no log) for 10 minutes. */
export function createUsdCadRate(deps: UsdCadDeps): () => Promise<number | null> {
  const ttlMs = deps.ttlMs ?? 12 * 3_600_000;
  let cached: { rate: number; at: number } | null = null;
  let failedAt: number | null = null;

  return async () => {
    const t = deps.now().getTime();
    if (cached && t - cached.at < ttlMs) return cached.rate;
    if (failedAt !== null && t - failedAt < FAILURE_COOLDOWN_MS) return null;
    failedAt = null;
    const fail = (): null => {
      failedAt = t;
      return null;
    };
    try {
      const res = await deps.fetch(URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        deps.log('warn', 'usd/cad rate fetch failed', { status: res.status });
        return fail();
      }
      const body = (await res.json()) as { rates?: { CAD?: unknown } };
      const rate = body.rates?.CAD;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1 || rate > 2) {
        deps.log('warn', 'usd/cad rate out of bounds');
        return fail();
      }
      cached = { rate, at: t };
      return rate;
    } catch (err) {
      deps.log('warn', 'usd/cad rate fetch failed', { message: err instanceof Error ? err.message : String(err) });
      return fail();
    }
  };
}
