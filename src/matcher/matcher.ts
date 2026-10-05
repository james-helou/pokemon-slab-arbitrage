import type { CardCandidate } from '../catalog/catalog-repo.js';
import type { Grader, Match } from '../domain/types.js';
import { resolveTitleSet, type SetRef } from './set-names.js';
import { normalizeNumber, parsePromos, parseTitle } from './title-parse.js';

export const MATCHER_VERSION = 'v1.2.0';

/**
 * Cards with this number. With `setId` (a promo set, or the set named in a PSA label title) the search is that set
 * only, ignoring zero padding; otherwise across sets, filtered by printed total when `total` is numeric.
 */
export type CandidateLookup = (number: string, total: string | null, setId?: string) => Promise<CardCandidate[]>;
/** The catalog's sets, for resolving a set named in the title. Called only for "#N"-without-total titles. */
export type SetLister = () => Promise<readonly SetRef[]>;

export interface MatchResult {
  match: Match | null;
  reasons: string[];
}

const BLOCKING_FLAGS = new Set(['non_english', 'lot', 'variant', 'not_authentic', 'raw_candidate', 'grader_conflict', 'number_conflict']);

export function graderFromAspect(v: string | undefined): Grader | null {
  if (!v) return null;
  const s = v.toUpperCase();
  if (s.includes('PSA') || s.includes('PROFESSIONAL SPORTS')) return 'PSA';
  if (s.includes('CGC') || s.includes('CERTIFIED GUARANTY')) return 'CGC';
  if (s.includes('BGS') || s.includes('BECKETT')) return 'BGS';
  if (s.includes('SGC') || s.includes('SPORTSCARD GUARANTY')) return 'SGC';
  if (s.includes('TAG')) return 'TAG';
  return null;
}

function parseGrade(v: string | undefined): number | null {
  if (!v) return null;
  const m = /(10|9\.5|[1-9](?:\.5)?)/.exec(v);
  return m ? Number.parseFloat(m[1]!) : null;
}

function tokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function nameInTitle(name: string, title: string): boolean {
  const t = new Set(tokens(title));
  return tokens(name).every((x) => t.has(x));
}

const PROMO_WORD = /\bpromo|black\s*star/i;
const promoKey = (p: { promoSet: string; number: string }) => `${p.promoSet}:${Number.parseInt(p.number.replace(/\D/g, ''), 10)}`;

/**
 * Confidence: name + number agree with exactly one candidate = 0.95, x0.9 when the grade is only in the title, so a
 * title-only match tops out at 0.855 (just over the 0.85 alert floor). The PSA label path (set named in title + "#N")
 * uses the same numbers: it reaches 0.95/0.855 only when set, number and card name all agree; a name mismatch is
 * 0.6. A bare Card Number aspect with no total and no set stays capped at 0.8.
 */
export async function matchListing(
  input: { title: string; aspects: Record<string, string> },
  lookup: CandidateLookup,
  listSets?: SetLister,
): Promise<MatchResult> {
  const p = parseTitle(input.title);
  const lang = input.aspects['Language'];
  if (lang && !/english/i.test(lang) && !p.flags.includes('non_english')) p.flags.push('non_english');
  const blocking = p.flags.filter((f) => BLOCKING_FLAGS.has(f));
  if (blocking.length > 0) return { match: null, reasons: blocking };

  const aspectGrader = graderFromAspect(input.aspects['Professional Grader']);
  const aspectGrade = parseGrade(input.aspects['Grade']);
  if (input.aspects['Professional Grader'] && !aspectGrader) return { match: null, reasons: ['grader_unknown'] };
  if (aspectGrade !== null && p.grade !== null && aspectGrade !== p.grade) return { match: null, reasons: ['grade_conflict'] };
  if (aspectGrader && p.grader && aspectGrader !== p.grader) return { match: null, reasons: ['grader_conflict'] };
  const grader = aspectGrader ?? p.grader;
  const grade = aspectGrade ?? p.grade;
  if (!grader || grade === null) return { match: null, reasons: ['grade_unknown'] };

  let number = p.number;
  let numberWithoutTotal = false;
  let total = p.total;
  let promoSet = p.promoSet;
  const aspectNumber = input.aspects['Card Number'];
  const aspectPromo = aspectNumber ? (parsePromos(aspectNumber, true, PROMO_WORD.test(input.title))[0] ?? null) : null;
  if (aspectPromo && p.promoSet && promoKey(aspectPromo) !== promoKey({ promoSet: p.promoSet, number: p.number! })) {
    return { match: null, reasons: ['number_conflict'] };
  }
  let labelSetTotalCheck: number | null = null;
  const reasons: string[] = [];
  if (!number && aspectPromo) {
    number = aspectPromo.number;
    promoSet = aspectPromo.promoSet;
  } else if (!number && p.hashNumber && listSets) {
    const set = resolveTitleSet(input.title, await listSets());
    if (set === 'ambiguous') return { match: null, reasons: ['ambiguous_set'] };
    if (set) {
      if (aspectNumber) {
        const [an, at] = aspectNumber.split('/').map((x) => x.trim().replace(/^#/, ''));
        if (!an || normalizeNumber(an) !== p.hashNumber) return { match: null, reasons: ['number_conflict'] };
        if (at && /^\d+$/.test(at)) labelSetTotalCheck = Number(at);
      }
      number = p.hashNumber;
      promoSet = set;
      reasons.push('set_from_title');
    }
  }
  if (!number && !aspectPromo && aspectNumber) {
    const [n, t] = aspectNumber.split('/').map((x) => x.trim());
    number = n ? normalizeNumber(n.replace(/^#/, '')) : null;
    total = t ? normalizeNumber(t) : null;
    numberWithoutTotal = total === null;
  }
  if (!number) return { match: null, reasons: ['number_unknown'] };

  const cands = await lookup(number, total, promoSet ?? undefined);
  const named = cands.filter((c) => nameInTitle(c.name, input.title));
  let card: CardCandidate;
  let confidence: number;
  if (named.length === 1) {
    card = named[0]!;
    confidence = 0.95;
  } else if (named.length > 1) {
    return { match: null, reasons: ['ambiguous_card'] };
  } else if (cands.length === 1) {
    card = cands[0]!;
    confidence = 0.6;
    reasons.push('name_mismatch');
  } else {
    return { match: null, reasons: [cands.length > 1 ? 'ambiguous_card' : 'card_not_found'] };
  }
  if (labelSetTotalCheck !== null && card.setPrintedTotal !== labelSetTotalCheck) {
    return { match: null, reasons: ['number_conflict'] };
  }
  if (numberWithoutTotal) {
    confidence = Math.min(confidence, 0.8);
    reasons.push('number_without_total');
  }
  if (aspectGrade === null) {
    confidence *= 0.9;
    reasons.push('grade_from_title');
  }

  const cert = input.aspects['Certification Number']?.trim() || null;
  return {
    match: {
      cardId: card.id, grader, grade, gradeLabel: p.gradeLabel, cert,
      confidence: Math.round(confidence * 1000) / 1000, reasons, matcherVersion: MATCHER_VERSION,
    },
    reasons,
  };
}
