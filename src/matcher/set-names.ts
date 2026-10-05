/**
 * Resolves the catalog set a title names, for PSA label titles that carry "#N" but no "/total"
 * ("2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10").
 *
 * Pure: the caller supplies the set list (TCGdex id + English name). A set is "hit" when its name, or an alias in
 * SET_ALIASES, appears in the title as a contiguous run of normalized tokens. Fail-closed rules, in order:
 *  1. "#N" numbers are removed first, so "#151" never names the "151" set.
 *  2. A hit followed by a possessive "s" is a card owner prefix, not a set ("TEAM ROCKET'S MEWTWO").
 *  3. An all-digit set name ("151") counts only with an English marker (EN / English): Japanese "151" shares numbering.
 *  4. A hit nested inside a longer hit is dropped ("Evolutions" inside "Prismatic Evolutions").
 *  5. Era names (Sword & Shield, Sun & Moon, ...) only ever disambiguate: if nothing but era names is hit, no set.
 *  6. Two or more different non-era sets (canonical or alias, any length) is 'ambiguous'.
 *  7. A guard word (promo, McDonald's, trainer kit, gallery, vault, calendar) outside the resolved hit means the title
 *     names a product the resolved set does not cover: no set.
 * The caller must still check the card name, and for an alias hit that no other set has the same number + name.
 */

export interface SetRef {
  id: string;
  name: string;
}

export interface SetHit {
  id: string;
  /** True when the set was resolved through SET_ALIASES (a PSA name), not its TCGdex name. */
  alias: boolean;
  /** The normalized tokens of the name that hit. */
  tokens: string[];
}

/**
 * PSA label names that differ from TCGdex names (written as on the label; normalized like titles). An alias is used
 * only if its target set is in the supplied list. "SWSH/SM BLACK STAR PROMO" already equal the TCGdex names once
 * "Promos" is normalized to "promo"; they are listed so the mapping is explicit.
 */
export const SET_ALIASES: Record<string, string> = {
  'POKEMON GAME': 'base1',
  'POKEMON ROCKET': 'base5',
  'POKEMON EXPEDITION': 'ecard1',
  'BASE SET II': 'base4',
  'BASE II': 'base4',
  'BASE 2': 'base4',
  'HEARTGOLD & SOULSILVER': 'hgss1',
  'SV BLACK STAR PROMO': 'svp',
  'ME BLACK STAR PROMO': 'mep',
  'SWSH BLACK STAR PROMO': 'swshp',
  'SM BLACK STAR PROMO': 'smp',
};

/** Sets whose name is also the series name PSA prefixes to every set of that era. They never resolve on their own. */
const ERA_SET_IDS = new Set(['dp1', 'pl1', 'hgss1', 'bw1', 'xy1', 'sm1', 'swsh1', 'sv01', 'me01']);

/** Words naming a product line; outside the resolved hit they mean the title is about some other set. */
const GUARD_WORDS = new Set(['promo', 'mcdonald', 'mcdonalds', 'kit', 'gallery', 'vault', 'calendar']);
const ENGLISH_MARKERS = new Set(['en', 'english']);

export function setTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t === 'promos' ? 'promo' : t));
}

interface Occ {
  id: string;
  alias: boolean;
  era: boolean;
  tokens: string[];
  start: number;
  end: number;
}

function occurrences(needle: string[], hay: string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) out.push(i);
  }
  return out;
}

export function resolveTitleSetHit(title: string, sets: readonly SetRef[]): SetHit | 'ambiguous' | null {
  const hay = setTokens(title.replace(/#\s?\d+/g, ' '));
  const known = new Set(sets.map((s) => s.id));
  const names = [
    ...sets.map((s) => ({ id: s.id, alias: false, tokens: setTokens(s.name) })),
    ...Object.entries(SET_ALIASES).filter(([, id]) => known.has(id)).map(([a, id]) => ({ id, alias: true, tokens: setTokens(a) })),
  ];
  const english = hay.some((t) => ENGLISH_MARKERS.has(t));
  let hits: Occ[] = [];
  for (const n of names) {
    if (n.tokens.every((t) => /^\d+$/.test(t)) && !english) continue;
    for (const start of occurrences(n.tokens, hay)) {
      const end = start + n.tokens.length;
      if (hay[end] === 's') continue;
      hits.push({ ...n, era: ERA_SET_IDS.has(n.id), start, end });
    }
  }
  hits = hits.filter((h) => !hits.some((o) => o !== h && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
  const real = hits.filter((h) => !h.era);
  if (real.length === 0) return null;
  const ids = new Set(real.map((h) => h.id));
  if (ids.size > 1) return 'ambiguous';
  const covered = new Set(hits.filter((h) => h.id === real[0]!.id).flatMap((h) => Array.from({ length: h.end - h.start }, (_, k) => h.start + k)));
  if (hay.some((t, i) => GUARD_WORDS.has(t) && !covered.has(i))) return null;
  const best = real.reduce((a, b) => (b.tokens.length > a.tokens.length ? b : a));
  return { id: best.id, alias: real.every((h) => h.alias), tokens: best.tokens };
}

/** The resolved set id, 'ambiguous', or null. */
export function resolveTitleSet(title: string, sets: readonly SetRef[]): string | 'ambiguous' | null {
  const r = resolveTitleSetHit(title, sets);
  return r === null || r === 'ambiguous' ? r : r.id;
}
