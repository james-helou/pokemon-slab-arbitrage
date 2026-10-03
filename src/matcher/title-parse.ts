import type { Grader } from '../domain/types.js';

export interface TitleParse {
  grader: Grader | null;
  grade: number | null;
  gradeLabel: 'pristine' | 'black_label' | null;
  number: string | null;
  total: string | null;
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

  return {
    grader: g ? toGrader(g[1]!) : null,
    grade: g ? Number.parseFloat(g[2]!) : null,
    gradeLabel,
    number: n ? normalizeNumber(n[1]!) : null,
    total: n ? normalizeNumber(n[2]!) : null,
    flags,
  };
}
