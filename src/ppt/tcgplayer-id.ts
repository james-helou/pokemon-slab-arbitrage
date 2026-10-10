const TCGDEX = 'https://api.tcgdex.net/v2/en';
const TIMEOUT_MS = 15_000;
const EXCLUDED_TYPE = /reverse/i;
const EXCLUDED_SUBTYPE = /shadowless|1st|first|copyright/i;

interface Variant {
  type?: string | null;
  subtype?: string | null;
  thirdParty?: { tcgplayer?: number | string | null };
}

/**
 * The TCGplayer product id to price a card by on PPT, from TCGdex `variants_detailed`. Vintage cards list several
 * prints (unlimited, shadowless, ...) under different ids; the matcher cannot tell editions apart from a title, so
 * shadowless / 1st edition / copyright prints and reverse holos are dropped and the unlimited one remains. Exactly one
 * distinct id left gives it; zero (no id, or unknown card) or several (still ambiguous) give null. 'error' means TCGdex
 * failed: the caller must not cache anything.
 */
export async function pptTcgplayerId(fetchFn: typeof fetch, cardId: string): Promise<string | null | 'error'> {
  let body: { variants_detailed?: Variant[] };
  try {
    const res = await fetchFn(`${TCGDEX}/cards/${encodeURIComponent(cardId)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) return 'error';
    body = (await res.json()) as typeof body;
  } catch {
    return 'error';
  }
  const ids = (body.variants_detailed ?? [])
    .filter((v) => !EXCLUDED_TYPE.test(v.type ?? '') && !EXCLUDED_SUBTYPE.test(v.subtype ?? ''))
    .map((v) => v.thirdParty?.tcgplayer)
    .filter((id): id is number | string => id !== undefined && id !== null && id !== '')
    .map(String);
  const distinct = [...new Set(ids)];
  return distinct.length === 1 ? distinct[0]! : null;
}
