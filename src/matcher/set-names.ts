/**
 * Resolves the catalog set a title names, for PSA label titles that carry "#N" but no "/total"
 * ("2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10").
 *
 * Pure: the caller supplies the set list (TCGdex id + English name). A set counts when its name, or an alias in
 * SET_ALIASES, appears in the title as a contiguous run of normalized tokens. Rules, in order:
 *  1. The "#N" numbers are removed first, so "#151" never names the "151" set.
 *  2. Era names that are also a set name (Sword & Shield, Sun & Moon, ...) are PSA's series prefix, so they count only
 *     when no other set is named.
 *  3. The longest name (in tokens) wins, so "Prismatic Evolutions" beats "Evolutions" and an alias like
 *     "SV BLACK STAR PROMO" beats "Team Rocket" inside "TEAM ROCKET'S MEWTWO".
 *  4. Two different sets tied for longest is 'ambiguous': the caller must not guess.
 */

export interface SetRef {
  id: string;
  name: string;
}

/**
 * PSA label names that differ from TCGdex names (keys are written as on the label; they are normalized like titles).
 * An alias is used only if its target set is in the supplied list. "SWSH/SM BLACK STAR PROMO" already equal the
 * TCGdex names once "Promos" is normalized to "promo"; they are listed so the mapping is explicit.
 */
export const SET_ALIASES: Record<string, string> = {
  'POKEMON GAME': 'base1',
  'POKEMON ROCKET': 'base5',
  'POKEMON EXPEDITION': 'ecard1',
  'HEARTGOLD & SOULSILVER': 'hgss1',
  'SV BLACK STAR PROMO': 'svp',
  'ME BLACK STAR PROMO': 'mep',
  'SWSH BLACK STAR PROMO': 'swshp',
  'SM BLACK STAR PROMO': 'smp',
};

/** Sets whose name is also the series name PSA prefixes to every set of that era. */
const ERA_SET_IDS = new Set(['dp1', 'pl1', 'hgss1', 'bw1', 'xy1', 'sm1', 'swsh1', 'sv01', 'me01']);

export function setTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t === 'promos' ? 'promo' : t));
}

function occurs(needle: string[], hay: string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

export function resolveTitleSet(title: string, sets: readonly SetRef[]): string | 'ambiguous' | null {
  const hay = setTokens(title.replace(/#\s?\d+/g, ' '));
  const known = new Set(sets.map((s) => s.id));
  const names: { id: string; tokens: string[] }[] = [
    ...sets.map((s) => ({ id: s.id, tokens: setTokens(s.name) })),
    ...Object.entries(SET_ALIASES).filter(([, id]) => known.has(id)).map(([alias, id]) => ({ id, tokens: setTokens(alias) })),
  ];
  const hits = names.filter((n) => occurs(n.tokens, hay));
  const nonEra = hits.filter((h) => !ERA_SET_IDS.has(h.id));
  const pool = nonEra.length > 0 ? nonEra : hits;
  if (pool.length === 0) return null;
  const longest = Math.max(...pool.map((h) => h.tokens.length));
  const ids = new Set(pool.filter((h) => h.tokens.length === longest).map((h) => h.id));
  return ids.size === 1 ? [...ids][0]! : 'ambiguous';
}
