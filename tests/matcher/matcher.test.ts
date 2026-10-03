import { describe, expect, it } from 'vitest';
import type { CardCandidate } from '../../src/catalog/catalog-repo.js';
import { graderFromAspect, matchListing, type CandidateLookup } from '../../src/matcher/matcher.js';

const CHARIZARD: CardCandidate = { id: 'sv03.5-199', name: 'Charizard ex', number: '199', setPrintedTotal: 165 };
const lookupOf = (cands: CardCandidate[]): CandidateLookup => async () => cands;

const ASPECTS = {
  'Professional Grader': 'Professional Sports Authenticator (PSA)',
  Grade: '10',
  'Certification Number': '12345678',
  Language: 'English',
};

describe('matchListing', () => {
  it('matches from title only with reduced confidence', async () => {
    const r = await matchListing({ title: 'PSA 10 Charizard ex 199/165 151', aspects: {} }, lookupOf([CHARIZARD]));
    expect(r.match).toMatchObject({ cardId: 'sv03.5-199', grader: 'PSA', grade: 10, cert: null, confidence: 0.855 });
    expect(r.reasons).toContain('grade_from_title');
  });

  it('prefers aspects and reads the cert', async () => {
    const r = await matchListing({ title: 'PSA 10 Charizard ex 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD]));
    expect(r.match).toMatchObject({ grader: 'PSA', grade: 10, cert: '12345678', confidence: 0.95 });
  });

  it('rejects a non-English Language aspect', async () => {
    const r = await matchListing(
      { title: 'PSA 10 Charizard ex 199/165', aspects: { ...ASPECTS, Language: 'Japanese' } },
      lookupOf([CHARIZARD]),
    );
    expect(r.match).toBeNull();
    expect(r.reasons).toContain('non_english');
  });

  it('rejects grader conflicts between title and aspects', async () => {
    const r = await matchListing({ title: 'CGC 10 Charizard ex 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD]));
    expect(r.reasons).toEqual(['grader_conflict']);
  });

  it('keeps a single candidate with mismatched name at low confidence', async () => {
    const r = await matchListing({ title: 'PSA 10 Zard 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD]));
    expect(r.match?.confidence).toBe(0.6);
    expect(r.reasons).toContain('name_mismatch');
  });

  it('refuses ambiguous candidates', async () => {
    const other = { ...CHARIZARD, id: 'x-199' };
    const r = await matchListing({ title: 'PSA 10 Charizard ex 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD, other]));
    expect(r.reasons).toEqual(['ambiguous_card']);
  });

  it('reports unknown card, grade and number', async () => {
    expect((await matchListing({ title: 'PSA 10 Charizard ex 199/165', aspects: {} }, lookupOf([]))).reasons).toEqual(['card_not_found']);
    expect((await matchListing({ title: 'Charizard ex 199/165', aspects: {} }, lookupOf([CHARIZARD]))).reasons).toEqual(['grade_unknown']);
    expect((await matchListing({ title: 'PSA 10 Charizard ex', aspects: {} }, lookupOf([CHARIZARD]))).reasons).toEqual(['number_unknown']);
  });

  it('falls back to the Card Number aspect', async () => {
    const r = await matchListing(
      { title: 'PSA 10 Charizard ex SIR', aspects: { ...ASPECTS, 'Card Number': '199/165' } },
      lookupOf([CHARIZARD]),
    );
    expect(r.match?.cardId).toBe('sv03.5-199');
  });

  it('rejects a Celebrations reprint', async () => {
    const base: CardCandidate = { id: 'base1-4', name: 'Charizard', number: '4', setPrintedTotal: 102 };
    const r = await matchListing({ title: 'Celebrations Charizard 4/102 Classic Collection PSA 10', aspects: ASPECTS }, lookupOf([base]));
    expect(r.match).toBeNull();
    expect(r.reasons).toContain('variant');
  });

  it('rejects when aspect grade and title grade differ', async () => {
    const r = await matchListing({ title: 'PSA 9 Charizard ex 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD]));
    expect(r.match).toBeNull();
    expect(r.reasons).toEqual(['grade_conflict']);
  });

  it('rejects an unrecognised aspect grader instead of trusting the title', async () => {
    const r = await matchListing(
      { title: 'PSA 10 Charizard ex 199/165', aspects: { ...ASPECTS, 'Professional Grader': 'ACE Grading' } },
      lookupOf([CHARIZARD]),
    );
    expect(r.match).toBeNull();
    expect(r.reasons).toEqual(['grader_unknown']);
  });

  it('rejects raw candidate listings', async () => {
    const r = await matchListing({ title: 'Charizard ex 199/165 PSA 10 Candidate NM', aspects: {} }, lookupOf([CHARIZARD]));
    expect(r.match).toBeNull();
    expect(r.reasons).toContain('raw_candidate');
    const e = await matchListing({ title: 'PSA 10 Equivalent CGC 9.5 Charizard ex 199/165', aspects: {} }, lookupOf([CHARIZARD]));
    expect(e.match).toBeNull();
  });

  it('rejects titles naming more than one grader', async () => {
    const r = await matchListing({ title: 'PSA 10 or CGC 9.5 Charizard ex 199/165', aspects: {} }, lookupOf([CHARIZARD]));
    expect(r.match).toBeNull();
    expect(r.reasons).toContain('grader_conflict');
  });

  it('matches names across punctuation', async () => {
    const r = await matchListing({ title: 'PSA 10 Charizard-ex 199/165', aspects: ASPECTS }, lookupOf([CHARIZARD]));
    expect(r.match?.confidence).toBe(0.95);
  });

  it('caps confidence at 0.8 when the Card Number aspect has no total', async () => {
    const r = await matchListing(
      { title: 'PSA 10 Charizard ex SIR', aspects: { ...ASPECTS, 'Card Number': '199' } },
      lookupOf([CHARIZARD]),
    );
    expect(r.match?.confidence).toBe(0.8);
    expect(r.reasons).toContain('number_without_total');
  });
});

describe('graderFromAspect', () => {
  it.each([
    ['Professional Sports Authenticator (PSA)', 'PSA'],
    ['Certified Guaranty Company (CGC)', 'CGC'],
    ['Beckett Grading Services (BGS)', 'BGS'],
    ['Sportscard Guaranty (SGC)', 'SGC'],
    ['Unknown', null],
  ])('%s -> %s', (v, g) => expect(graderFromAspect(v)).toBe(g));
});

describe('matchListing promo cards', () => {
  const PIKA: CardCandidate = { id: 'svp-085', name: 'Pikachu with Grey Felt Hat', number: '85', setPrintedTotal: 225 };
  const spy = (cands: CardCandidate[]) => {
    const calls: unknown[][] = [];
    const lookup: CandidateLookup = async (...a) => { calls.push(a); return cands; };
    return { lookup, calls };
  };

  it.each([
    ['PSA 10 Pikachu with Grey Felt Hat SVP085', 'svp', '85'],
    ['PSA 10 Pikachu with Grey Felt Hat SVP 085', 'svp', '85'],
    ['PSA 10 Pikachu SWSH020 Black Star Promo', 'swshp', 'SWSH020'],
    ['PSA 10 Pikachu SM214 Promo', 'smp', 'SM214'],
    ['PSA 10 Pikachu XY95 Promo', 'xyp', 'XY95'],
    ['PSA 10 Pikachu BW12 Promo', 'bwp', 'BW12'],
  ])('looks up %s in its promo set', async (title, set, number) => {
    const s = spy([{ ...PIKA, id: 'x-1', name: 'Pikachu' }]);
    const r = await matchListing({ title, aspects: {} }, s.lookup);
    expect(s.calls).toEqual([[number, null, set]]);
    expect(r.match).toMatchObject({ cardId: 'x-1', confidence: 0.855 });
  });

  it('does not match a promo number whose name is wrong at high confidence', async () => {
    const r = await matchListing({ title: 'PSA 10 Charizard SVP085', aspects: {} }, spy([PIKA]).lookup);
    expect(r.match?.confidence ?? 0).toBeLessThan(0.85);
    expect(r.reasons).toContain('name_mismatch');
  });

  it('reads a promo Card Number aspect', async () => {
    const s = spy([PIKA]);
    const r = await matchListing(
      { title: 'Pikachu with Grey Felt Hat PSA 10', aspects: { ...ASPECTS, 'Card Number': 'SVP085' } },
      s.lookup,
    );
    expect(s.calls).toEqual([['85', null, 'svp']]);
    expect(r.match).toMatchObject({ cardId: 'svp-085', confidence: 0.95 });
  });

  it('uses N/T, not the promo set, when both appear', async () => {
    const s = spy([CHARIZARD]);
    await matchListing({ title: 'PSA 10 Charizard ex 199/165 SWSH020', aspects: {} }, s.lookup);
    expect(s.calls).toEqual([['199', '165', undefined]]);
  });

  it('gives number_unknown for an unknown prefix', async () => {
    const r = await matchListing({ title: 'PSA 10 Lugia HGSS05 Promo', aspects: {} }, spy([]).lookup);
    expect(r.reasons).toEqual(['number_unknown']);
  });
});
