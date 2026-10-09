import type { Db } from '../db/db.js';
import type { PoketraceClient } from './client.js';

const PROVIDER = 'poketrace';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const NEGATIVE_TTL_MS = 7 * 86_400_000;
const POSITIVE_TTL_MS = 30 * 86_400_000;
/** Editions the matcher cannot detect from a title: never safe to price against. */
const UNSAFE_VARIANT = /1st|first.?ed|shadowless/i;
const REVERSE_VARIANT = /reverse/i;
const TIMEOUT_MS = 15_000;

export interface MappingDeps {
  db: Db;
  client: PoketraceClient;
  fetch: typeof fetch;
  now: () => Date;
}

interface PtCard {
  id: string;
  name?: string;
  cardNumber?: string;
  set?: { name?: string };
  productType?: string;
  variant?: string;
  game?: string;
  market?: string;
}

/**
 * Variant rules: drop 1st edition / shadowless; when several remain prefer non-reverse; accept only a single survivor.
 */
function pickCandidate(cands: PtCard[]): PtCard | null {
  let left = cands.filter((c) => !UNSAFE_VARIANT.test(c.variant ?? ''));
  if (left.length > 1 && left.some((c) => !REVERSE_VARIANT.test(c.variant ?? ''))) {
    left = left.filter((c) => !REVERSE_VARIANT.test(c.variant ?? ''));
  }
  return left.length === 1 ? left[0]! : null;
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const normNumber = (s: string | undefined) => norm(s).split('/')[0]!.replace(/^0+(?=\d)/, '');

/** Distinct TCGplayer product ids TCGdex lists for a card (empty when the card is unknown). Throws on TCGdex failure. */
export async function tcgplayerIds(fetchFn: typeof fetch, cardId: string): Promise<string[]> {
  const res = await fetchFn(`${TCGDEX}/cards/${encodeURIComponent(cardId)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`tcgdex card ${cardId}: status ${res.status}`);
  const body = (await res.json()) as { variants_detailed?: { thirdParty?: { tcgplayer?: number | string | null } }[] };
  const ids = (body.variants_detailed ?? [])
    .map((v) => v.thirdParty?.tcgplayer)
    .filter((v): v is number | string => v !== undefined && v !== null && v !== '')
    .map(String);
  return [...new Set(ids)];
}

/** Turns the mapping into a fresh negative entry (e.g. PokeTrace 404s the mapped card); retried after 7 days. */
export async function invalidatePoketraceId(db: Db, cardId: string, now: Date = new Date()): Promise<void> {
  await db.query(
    `update card_external_ids set external_id = null, variant = null, resolved_at = $3 where card_id = $1 and provider = $2`,
    [cardId, PROVIDER, now],
  );
}

/**
 * Resolves our TCGdex card id to a PokeTrace card uuid, caching in card_external_ids. A positive entry is re-resolved
 * after 30 days; a null external_id is a negative cache entry, retried after 7 days. TCGdex/PokeTrace failures throw
 * and cache nothing. Returns null when there is no single confident match (callers fall back to the comps path).
 */
export async function resolvePoketraceId(deps: MappingDeps, cardId: string): Promise<string | null> {
  const { db } = deps;
  const now = deps.now();
  const cached = await db.query<{ external_id: string | null; resolved_at: string | Date }>(
    'select external_id, resolved_at from card_external_ids where card_id = $1 and provider = $2',
    [cardId, PROVIDER],
  );
  const hit = cached.rows[0];
  if (hit) {
    const age = now.getTime() - new Date(hit.resolved_at).getTime();
    if (hit.external_id && age < POSITIVE_TTL_MS) return hit.external_id;
    if (!hit.external_id && age < NEGATIVE_TTL_MS) return null;
  }

  const card = (
    await db.query<{ name: string; number: string; set_name: string }>(
      'select name, number, set_name from cards where id = $1', [cardId],
    )
  ).rows[0];
  if (!card) return null;

  let picked: PtCard | null;
  const ids = await tcgplayerIds(deps.fetch, cardId);
  if (ids.length > 0) {
    const { data } = await deps.client.get<{ data?: PtCard[] }>('/cards', { tcgplayer_ids: ids.join(',') });
    picked = pickCandidate((data ?? []).filter((c) => c.productType === undefined || c.productType === 'single'));
  } else {
    const { data } = await deps.client.get<{ data?: PtCard[] }>('/cards', {
      search: card.name, card_number: card.number, game: 'pokemon', market: 'US',
    });
    picked = pickCandidate((data ?? []).filter(
      (c) => c.game === 'pokemon' && c.market === 'US'
        && norm(c.name) === norm(card.name) && normNumber(c.cardNumber) === normNumber(card.number)
        && norm(c.set?.name) === norm(card.set_name),
    ));
  }

  const externalId = picked?.id ?? null;
  await db.query(
    `insert into card_external_ids (card_id, provider, external_id, variant, resolved_at) values ($1, $2, $3, $4, $5)
     on conflict (card_id, provider) do update
       set external_id = excluded.external_id, variant = excluded.variant, resolved_at = excluded.resolved_at`,
    [cardId, PROVIDER, externalId, picked?.variant ?? null, now],
  );
  return externalId;
}
