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
const PROMO_RE = /(?:^|[\s#(])(SVP|SWSH|SM|XY|BW)[\s-]?(\d{1,3})(?![\d/])/i;
const PROMO_ONLY_RE = /^\s*#?(SVP|SWSH|SM|XY|BW)[\s-]?(\d{1,3})\s*$/i;

/** Promo code to { promoSet, number }. SVP numbers are plain digits in TCGdex; the others keep their prefix (SWSH020). */
export function parsePromo(s: string, anchored = false): { promoSet: string; number: string } | null {
  const m = (anchored ? PROMO_ONLY_RE : PROMO_RE).exec(s);
  if (!m) return null;
  const prefix = m[1]!.toUpperCase();
  return { promoSet: PROMO_SETS[prefix]!, number: prefix === 'SVP' ? String(Number.parseInt(m[2]!, 10)) : prefix + m[2]! };
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

  const promo = n ? null : parsePromo(title);

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
