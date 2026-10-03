import type { Grader } from '../domain/types.js';

export interface TitleParse {
  grader: Grader | null;
  grade: number | null;
  gradeLabel: 'pristine' | 'black_label' | null;
  number: string | null;
  total: string | null;
  /** TCGdex promo set id when the title carries a promo code (e.g. SWSH020) instead of an N/T number. */
  promoSet: string | null;
  flags: string[];
}

const GRADER_RE =
  /\b(PSA|CGC|BGS|BECKETT|SGC|TAG)\b[\s:-]*(?:GEM[\s-]*(?:MT|MINT)|MINT|NM[\s-]*MT|PRISTINE|BLACK[\s-]*LABEL)?[\s:-]*(10|9\.5|[1-9](?:\.5)?)(?![\d./])/i;
const NUMBER_RE = /(?:^|[\s#(])([A-Z]{0,4}\d{1,4})\s*\/\s*([A-Z]{0,4}\d{1,4})(?!\d)/i;
const NON_ENGLISH_RE = /\b(japanese|japan|jpn|korean|chinese|german|french|italian|spanish|portuguese|thai|indonesian)\b/i;
const LOT_RE = /\b(lot|bundle)\b|\bx\s?\d+\b|\b\d+\s?x\b/i;
const VARIANT_RE = /\b(1st\s*ed(ition)?|first\s*edition|shadowless|reverse\s*holo|pre-?release|first\s*ed|w\s*stamp|jumbo|celebrations|classic\s*collection|staff|stamped)\b/i;
const RAW_CANDIDATE_RE = /\b(candidate|ready|equivalent|potential)\b/i;
const ANY_GRADER_RE = /\b(PSA|CGC|BGS|BECKETT|SGC|TAG)\b/gi;
const NOT_AUTHENTIC_RE = /\b(proxy|custom|replica|orica|fan\s*art)\b/i;

const PROMO_SETS: Record<string, string> = { SVP: 'svp', SWSH: 'swshp', SM: 'smp', XY: 'xyp', BW: 'bwp' };
/** Highest main-set number per series code. Above it (or zero-padded, or with "promo"), a code can only be a promo. */
const MAIN_SET_MAX: Record<string, number> = { SWSH: 12, SM: 12, XY: 12, BW: 11 };
const PROMO_RE = /(?:^|[\s#(])(SVP|SWSH|SM|XY|BW)[\s-]?(\d{1,3})(?![\d/])/gi;
const PROMO_ONLY_RE = /^\s*#?(SVP|SWSH|SM|XY|BW)[\s-]?(\d{1,3})\s*$/i;
const PROMO_WORD_RE = /\bpromo|black\s*star/i;

export interface Promo {
  promoSet: string;
  number: string;
}

/**
 * Promo codes in a string, de-duplicated. SVP is always a promo. SWSH/SM/XY/BW are also main-set codes that sellers
 * put in titles ("SWSH12 Silver Tempest"), so they count only with a promo word, 3+ digit padding, or a number above
 * the series' main-set range. SVP numbers are plain digits in TCGdex; the others keep their prefix (SWSH020).
 */
export function parsePromos(s: string, anchored = false, promoWord = PROMO_WORD_RE.test(s)): Promo[] {
  const out = new Map<string, Promo>();
  const ms = anchored ? [PROMO_ONLY_RE.exec(s)] : [...s.matchAll(PROMO_RE)];
  for (const m of ms) {
    if (!m) continue;
    const prefix = m[1]!.toUpperCase();
    const digits = m[2]!;
    const qualifies = prefix === 'SVP' || promoWord || digits.length >= 3 || Number.parseInt(digits, 10) > MAIN_SET_MAX[prefix]!;
    if (!qualifies) continue;
    const number = prefix === 'SVP' ? String(Number.parseInt(digits, 10)) : prefix + digits;
    out.set(`${PROMO_SETS[prefix]}:${Number.parseInt(digits, 10)}`, { promoSet: PROMO_SETS[prefix]!, number });
  }
  return [...out.values()];
}

export function normalizeNumber(n: string): string {
  return /^\d+$/.test(n) ? String(Number.parseInt(n, 10)) : n.toUpperCase();
}

function toGrader(s: string): Grader {
  const u = s.toUpperCase();
  return u === 'BECKETT' ? 'BGS' : (u as Grader);
}

export function parseTitle(title: string): TitleParse {
  const flags: string[] = [];
  if (NON_ENGLISH_RE.test(title)) flags.push('non_english');
  if (LOT_RE.test(title)) flags.push('lot');
  if (VARIANT_RE.test(title)) flags.push('variant');
  if (NOT_AUTHENTIC_RE.test(title)) flags.push('not_authentic');
  if (RAW_CANDIDATE_RE.test(title)) flags.push('raw_candidate');
  const graders = new Set([...title.matchAll(ANY_GRADER_RE)].map((m) => toGrader(m[1]!)));
  if (graders.size > 1) flags.push('grader_conflict');

  const g = GRADER_RE.exec(title);
  const n = NUMBER_RE.exec(title);
  const gradeLabel = /\bpristine\b/i.test(title) ? 'pristine' : /black[\s-]*label/i.test(title) ? 'black_label' : null;

  const promos = n ? [] : parsePromos(title);
  if (promos.length > 1) flags.push('number_conflict');
  const promo = promos.length === 1 ? promos[0]! : null;

  return {
    grader: g ? toGrader(g[1]!) : null,
    grade: g ? Number.parseFloat(g[2]!) : null,
    gradeLabel,
    number: n ? normalizeNumber(n[1]!) : (promo?.number ?? null),
    total: n ? normalizeNumber(n[2]!) : null,
    promoSet: promo?.promoSet ?? null,
    flags,
  };
}
