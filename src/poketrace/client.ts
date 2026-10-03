const BASE = 'https://api.poketrace.com/v1';
const MAX_TRIES = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_S = 10;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 10 * 60_000;
/** Pro allows 30 req / 10s; stay at 3/s with a burst of 3. */
const RATE_PER_SEC = 3;

/** Carries the HTTP status (when there was a response) and the path only; never the key or the body. */
export class PoketraceHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PoketraceHttpError';
  }
}

/** Thrown without calling fetch while the circuit breaker is open (PokeTrace kept failing). Carries no request details. */
export class PoketraceUnavailableError extends Error {
  constructor() {
    super('poketrace unavailable: circuit breaker open');
    this.name = 'PoketraceUnavailableError';
  }
}

export interface PoketraceClient {
  get<T>(path: string, query?: Record<string, string>): Promise<T>;
}

export interface PoketraceClientOptions {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic-ish millisecond clock for the token bucket and the circuit breaker. */
  now?: () => number;
  /** Consecutive failed requests (retries exhausted) that open the breaker. Default 5. */
  breakerThreshold?: number;
  /** How long the breaker stays open. Default 10 minutes. */
  breakerCooldownMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal PokeTrace GET client: X-API-Key auth, 15s timeout, token bucket, 3 tries on 429/5xx honoring Retry-After
 * (capped at 10s). Circuit breaker: after `breakerThreshold` consecutive failed requests (429/5xx/network, retries
 * exhausted) every get throws PoketraceUnavailableError without fetching for `breakerCooldownMs`; after that one
 * request is let through, and a failure reopens it. Any HTTP answer the server chose (2xx, or a 4xx such as 404)
 * resets the count. Errors carry the path and HTTP status only; never the key, headers, or response body.
 */
export function createPoketraceClient(opts: PoketraceClientOptions): PoketraceClient {
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const threshold = opts.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
  const cooldownMs = opts.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  let tokens = RATE_PER_SEC;
  let last = now();
  let consecutiveFailures = 0;
  let openUntil = 0;

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
      if (consecutiveFailures >= threshold && now() < openUntil) throw new PoketraceUnavailableError();
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
          if (res.ok) {
            consecutiveFailures = 0;
            return (await res.json()) as T;
          }
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
        if (!retryable) {
          // The server answered on purpose (e.g. 404, 401): it is up, so this is not an outage.
          consecutiveFailures = 0;
          break;
        }
        if (attempt < MAX_TRIES) await sleep(delay);
      }
      if (lastStatus === undefined || lastStatus === 429 || lastStatus >= 500) {
        consecutiveFailures++;
        if (consecutiveFailures >= threshold) openUntil = now() + cooldownMs;
      }
      throw new PoketraceHttpError(`poketrace ${path}: ${lastError}`, lastStatus);
    },
  };
}
