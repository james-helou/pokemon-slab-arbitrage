import type { Db } from '../db/db.js';
import type { PoketraceClient } from './client.js';

const PROVIDER = 'poketrace';
const TCGDEX = 'https://api.tcgdex.net/v2/en';
const NEGATIVE_TTL_MS = 7 * 86_400_000;
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
}

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const normNumber = (s: string | undefined) => norm(s).split('/')[0]!.replace(/^0+(?=\d)/, '');

async function tcgplayerIds(fetchFn: typeof fetch, cardId: string): Promise<string[]> {
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

/**
 * Resolves our TCGdex card id to a PokeTrace card uuid, caching in card_external_ids. A null external_id is a
 * negative cache entry, retried after 7 days. TCGdex/PokeTrace failures throw and cache nothing.
 * Returns null when there is no single confident match (callers fall back to the comps path).
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
    if (hit.external_id) return hit.external_id;
    if (now.getTime() - new Date(hit.resolved_at).getTime() < NEGATIVE_TTL_MS) return null;
  }

  const card = (
    await db.query<{ name: string; number: string; set_name: string }>(
      'select name, number, set_name from cards where id = $1', [cardId],
    )
  ).rows[0];
  if (!card) return null;

  let externalId: string | null = null;
  const ids = await tcgplayerIds(deps.fetch, cardId);
  if (ids.length > 0) {
    const { data } = await deps.client.get<{ data?: PtCard[] }>('/cards', { tcgplayer_ids: ids.join(',') });
    const singles = (data ?? []).filter((c) => c.productType === undefined || c.productType === 'single');
    if (singles.length === 1) externalId = singles[0]!.id;
  } else {
    const { data } = await deps.client.get<{ data?: PtCard[] }>('/cards', { search: card.name, card_number: card.number });
    const exact = (data ?? []).filter(
      (c) => norm(c.name) === norm(card.name) && normNumber(c.cardNumber) === normNumber(card.number)
        && norm(c.set?.name) === norm(card.set_name),
    );
    if (exact.length === 1) externalId = exact[0]!.id;
  }

  await db.query(
    `insert into card_external_ids (card_id, provider, external_id, resolved_at) values ($1, $2, $3, $4)
     on conflict (card_id, provider) do update set external_id = excluded.external_id, resolved_at = excluded.resolved_at`,
    [cardId, PROVIDER, externalId, now],
  );
  return externalId;
}
