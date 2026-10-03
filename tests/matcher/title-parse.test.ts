import { describe, expect, it } from 'vitest';
import { normalizeNumber, parseTitle } from '../../src/matcher/title-parse.js';

describe('parseTitle', () => {
  it.each([
    ['PSA 10 Charizard ex 199/165 151 SIR', 'PSA', 10, '199', '165'],
    ['Umbreon VMAX 215/203 Evolving Skies PSA GEM MT 10', 'PSA', 10, '215', '203'],
    ['CGC 9.5 Pikachu 025/165', 'CGC', 9.5, '25', '165'],
    ['Beckett 9.5 Mew ex 232/091', 'BGS', 9.5, '232', '91'],
    ['Pikachu TG05/TG30 Lost Origin PSA 9', 'PSA', 9, 'TG05', 'TG30'],
    ['Radiant Charizard #011/078 PSA 8', 'PSA', 8, '11', '78'],
  ])('%s', (title, grader, grade, number, total) => {
    const p = parseTitle(title);
    expect(p.grader).toBe(grader);
    expect(p.grade).toBe(grade);
    expect(p.number).toBe(number);
    expect(p.total).toBe(total);
    expect(p.flags).toEqual([]);
  });

  it('does not read a grade out of a card number', () => {
    expect(parseTitle('PSA 199/165 Charizard').grade).toBeNull();
  });

  it.each([
    ['Japanese PSA 10 Charizard 201/165', 'non_english'],
    ['Lot of 5 PSA 10 slabs', 'lot'],
    ['PSA 10 Pikachu x3 bundle', 'lot'],
    ['1st Edition Charizard 4/102 PSA 9', 'variant'],
    ['Shadowless Blastoise 2/102 PSA 8', 'variant'],
    ['Reverse Holo Pikachu 25/165 PSA 10', 'variant'],
    ['Charizard 4/102 PSA 10 custom proxy', 'not_authentic'],
  ])('flags "%s" as %s', (title, flag) => {
    expect(parseTitle(title).flags).toContain(flag);
  });

  it.each([
    'Celebrations Charizard 4/102 PSA 10',
    'Charizard 4/102 Classic Collection PSA 10',
    'Charizard 4/102 Pre-Release PSA 10',
    'Charizard 4/102 First Ed PSA 10',
    'Charizard 4/102 W Stamp PSA 10',
    'Charizard 4/102 Jumbo PSA 10',
  ])('flags "%s" as variant', (title) => {
    expect(parseTitle(title).flags).toContain('variant');
  });

  it('does not flag Mega Charizard X ex as a lot', () => {
    expect(parseTitle('Mega Charizard X ex 125/094 PSA 10').flags).toEqual([]);
  });

  it('detects graded labels', () => {
    expect(parseTitle('CGC Pristine 10 Mew 151/165').gradeLabel).toBe('pristine');
    expect(parseTitle('BGS 10 Black Label Pikachu 25/165').gradeLabel).toBe('black_label');
  });
});

describe('normalizeNumber', () => {
  it('strips leading zeros from numeric parts only', () => {
    expect(normalizeNumber('025')).toBe('25');
    expect(normalizeNumber('tg05')).toBe('TG05');
  });
});

describe('parseTitle promo codes', () => {
  it.each([
    ['PSA 10 Pikachu with Grey Felt Hat SVP085', 'svp', '85'],
    ['PSA 10 Pikachu with Grey Felt Hat SVP 085 Van Gogh Promo', 'svp', '85'],
    ['PSA 10 Pikachu SWSH020 Black Star Promo', 'swshp', 'SWSH020'],
    ['PSA 10 Mewtwo SM214 Black Star Promo', 'smp', 'SM214'],
    ['PSA 10 Pikachu XY95 Promo', 'xyp', 'XY95'],
    ['PSA 9 Reshiram BW 12 Promo', 'bwp', 'BW12'],
    ['PSA 10 Mew ex 151 Promo SVP 053', 'svp', '53'],
  ])('%s', (title, promoSet, number) => {
    const p = parseTitle(title);
    expect(p.promoSet).toBe(promoSet);
    expect(p.number).toBe(number);
    expect(p.total).toBeNull();
  });

  it('prefers N/T over a promo code', () => {
    const p = parseTitle('PSA 10 Charizard ex 199/165 SWSH020');
    expect(p).toMatchObject({ promoSet: null, number: '199', total: '165' });
  });

  it('ignores unknown prefixes and the grade', () => {
    const p = parseTitle('PSA 10 Lugia HGSS05 Promo');
    expect(p.promoSet).toBeNull();
    expect(p.number).toBeNull();
  });
});
