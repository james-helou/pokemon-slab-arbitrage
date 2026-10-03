const BASE = 'https://api.poketrace.com/v1';
const MAX_TRIES = 4;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_S = 30;
/** Pro allows 30 req / 10s; stay at 3/s with a burst of 3. */
const RATE_PER_SEC = 3;

/** Carries the HTTP status (when there was a response) and the path only; never the key or the body. */
export class PoketraceHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PoketraceHttpError';
  }
}

export interface PoketraceClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
}

export interface PoketraceClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish millisecond clock for the token bucket. */
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal PokeTrace GET client: X-API-Key auth, 15s timeout, token bucket, retry on 429/5xx honoring Retry-After.
 * Errors carry the path and HTTP status only; never the key, headers, or response body.
 */
export function createPoketraceClient(opts: PoketraceClientOptions): PoketraceClient {
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  let tokens = RATE_PER_SEC;
  let last = now();

  async function acquire(): Promise<void> {
    for (;;) {
      const t = now();
      tokens = Math.min(RATE_PER_SEC, tokens + ((t - last) / 1000) * RATE_PER_SEC);
      last = t;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - tokens) / RATE_PER_SEC) * 1000));
    }
  }

  return {
    async get<T>(path: string, query?: Record<string, string>): Promise<T> {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
      let lastError = '';
      let lastStatus: number | undefined;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        let retryable = true;
        let delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        await acquire();
        try {
          const res = await fetchFn(`${BASE}${path}${qs}`, {
            headers: { 'X-API-Key': opts.apiKey, Accept: 'application/json' },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (res.ok) return (await res.json()) as T;
          lastError = `status ${res.status}`;
          lastStatus = res.status;
          retryable = res.status === 429 || res.status >= 500;
          const header = res.headers.get('Retry-After');
          const retryAfter = Number(header);
          if (retryable && header && Number.isFinite(retryAfter) && retryAfter >= 0) {
            delay = Math.min(retryAfter, MAX_RETRY_AFTER_S) * 1000;
          }
        } catch {
          // Deliberately drop the underlying message: keep the key and request details out of errors.
          lastError = 'request failed';
          lastStatus = undefined;
        }
        if (!retryable) break;
        if (attempt < MAX_TRIES) await sleep(delay);
      }
      throw new PoketraceHttpError(`poketrace ${path}: ${lastError}`, lastStatus);
    },
  };
}
