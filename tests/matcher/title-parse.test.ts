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

  it.each([
    'PSA 10 Morpeko SWSH12 Silver Tempest',
    'PSA 10 Snivy BW1 Black and White',
    'PSA 10 Chespin XY1',
    'PSA 10 Pikachu SM4',
    'PSA 10 Pikachu SM01',
    'PSA 10 Pikachu SM 10',
  ])('does not treat main-set code as a promo: %s', (title) => {
    const p = parseTitle(title);
    expect(p.promoSet).toBeNull();
    expect(p.number).toBeNull();
  });

  it.each([
    ['PSA 10 Pikachu XY95', 'xyp', 'XY95'],
    ['PSA 10 Pikachu SWSH050', 'swshp', 'SWSH050'],
    ['PSA 10 Pikachu SWSH020', 'swshp', 'SWSH020'],
    ['PSA 10 Pikachu XY01 Black Star Promo', 'xyp', 'XY01'],
    ['PSA 10 Pikachu SM4 Promo', 'smp', 'SM4'],
    ['PSA 10 Pikachu SVP 001', 'svp', '1'],
  ])('treats an unambiguous code as a promo: %s', (title, promoSet, number) => {
    expect(parseTitle(title)).toMatchObject({ promoSet, number });
  });

  it('flags two different promo codes in one title', () => {
    expect(parseTitle('PSA 10 Pikachu SWSH020 SWSH050').flags).toContain('number_conflict');
  });
});

describe('parseTitle live-title fixes (v1.2.0)', () => {
  it.each([
    ['PSA 10 2019 Pokemon TCG EN Team Up Latias & Latios GX TAG TEAM Holo 113/181', 'PSA', 10],
    ['Pokémon Eevee & Snorlax GX TAG TEAM Promo Holo SM169 PSA 10 2019', 'PSA', 10],
    ['PSA 9 Pikachu & Zekrom GX Tag-Team 33/181', 'PSA', 9],
  ])('does not read TAG TEAM as the TAG grader: %s', (title, grader, grade) => {
    const p = parseTitle(title);
    expect(p.flags).not.toContain('grader_conflict');
    expect(p.grader).toBe(grader);
    expect(p.grade).toBe(grade);
  });

  it('still reads a real TAG slab', () => {
    const p = parseTitle('2011 Pokemon Black & White Zekrom #114 Gray Background Full Art Tag 7 NM');
    expect(p).toMatchObject({ grader: 'TAG', grade: 7 });
    expect(parseTitle('TAG 10 Charizard ex 199/165')).toMatchObject({ grader: 'TAG', grade: 10 });
  });

  it.each([
    ["'S Pikachu 24 Pikachu World Coll. ENGLISH Promo PSA10 Gem Mint Pokemon Card", 'PSA', 10],
    ['Charizard ex 199/165 PSA-10', 'PSA', 10],
    ['Charizard ex 199/165 PSA 10', 'PSA', 10],
    ['Mew ex 151/165 CGC9.5', 'CGC', 9.5],
    ['Mew ex 151/165 BGS9', 'BGS', 9],
    ['Mew ex 151/165 SGC10', 'SGC', 10],
  ])('reads a grade glued to the grader: %s', (title, grader, grade) => {
    expect(parseTitle(title)).toMatchObject({ grader, grade });
  });

  it('does not read a grade out of digits glued to a grader that are not a grade', () => {
    expect(parseTitle('PSA199/165 Charizard').grade).toBeNull();
    expect(parseTitle('PSA1999 Charizard').grade).toBeNull();
    expect(parseTitle('PSA10 Charizard ex 199/165')).toMatchObject({ grade: 10, number: '199', total: '165' });
  });

  it.each([
    'Pokemon TCG 2007 Torterra LV.X 122/130 Diamond & Pearl Holo English Graded PSA 8',
    'Rayquaza LV. X 105/111 PSA 9',
    'Gardevoir LVX 131/132 PSA 7',
    'Mega Mewtwo X 160/162 PSA 10',
  ])('does not flag an X card as a lot: %s', (title) => {
    expect(parseTitle(title).flags).not.toContain('lot');
  });

  it.each(['2x PSA 10 Pikachu 25/165', 'PSA 10 Pikachu 25/165 x2', 'PSA 10 Pikachu x 3', 'Lot of 3 PSA 10', 'PSA 10 Pikachu 25/165 Pair'])(
    'still flags a real lot: %s',
    (title) => expect(parseTitle(title).flags).toContain('lot'),
  );

  it.each([
    '2003 POKEMON EX DRAGON #77 TORCHIC-REVERSE FOIL PSA 7',
    '2006 Pokemon EX Holon Phantoms Reverse Foil Pikachu #78 PSA 9 Mint',
    'Pikachu 25/165 Rev Holo PSA 10',
  ])('flags reverse foil as a variant: %s', (title) => {
    expect(parseTitle(title).flags).toContain('variant');
  });

  it.each([
    ['2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10', '95'],
    ['2007 POKEMON DIAMOND & PEARL SECRET WONDERS #3 CHARIZARD-HOLO PSA 8', '3'],
    ['PSA 9 - ALAKAZAM #082 - 2024 POKEMON TWM EN TWILIGHT MASQUERADE #82', '82'],
    ['1999 POKEMON GAME #49 DROWZEE PSA 8', '49'],
  ])('reads a #N label number without a total: %s', (title, n) => {
    const p = parseTitle(title);
    expect(p).toMatchObject({ number: null, total: null, promoSet: null, hashNumber: n });
    expect(p.flags).toEqual([]);
  });

  it('does not read #N when the title has N/T or a promo code', () => {
    expect(parseTitle('Pokémon TCG Mega Lucario ex #179/132 SIR PSA 9').hashNumber).toBeNull();
    expect(parseTitle('2021 POKEMON SM BLACK STAR PROMO #SM248 FULL ART/PIKACHU & ZEKROM GX PSA 10').hashNumber).toBeNull();
  });

  it('flags two different #N numbers', () => {
    const p = parseTitle('2021 POKEMON EVOLVING SKIES #95 UMBREON VMAX #215 PSA 10');
    expect(p.hashNumber).toBeNull();
    expect(p.flags).toContain('number_conflict');
  });
});

describe('parseTitle refusals found by the live-catalog probe', () => {
  it.each([
    'CGC 10 Pristine Mew ex 151/165 RR 151 sv2a Pokemon Card',
    'PSA 10 Togepi #034/055 SM9a Night Unison 2019',
    'Pikachu 236/190 Sv4a Shiny Treasure PSA 10',
    'Mega Venusaur ex 076/063 M1L Mega Brave Holo CGC 10',
    'Calyrex VMAX HR PSA 10 S6H',
    'PSA 9 Mega Charizard X E #110 Pokemon M2 Jp Special Art Rare 2025',
  ])('flags a Japanese set code as non-English: %s', (title) => {
    expect(parseTitle(title).flags).toContain('non_english');
  });

  // Live alerts 2026-10-13..27: Japanese 151 cards (shipped from JP) use the same numbers as the English set.
  it.each([
    'Bulbasaur AR 166/165 PSA 10 Pokemon',
    'Charmander 168/165 AR Pokemon PSA 10',
    'Pikachu ex SAR 132/106 PSA 10',
    'Umbreon V CSR 177/172 PSA 10',
    'Mew ex CHR 179/165 PSA 10',
    'Pikachu Special Art Rare 132/106 PSA 10',
  ])('flags a Japanese-only rarity code as non-English: %s', (title) => {
    expect(parseTitle(title).flags).toContain('non_english');
  });

  it.each([
    'Charizard ex SIR 199/165 PSA 10',
    'Charmander IR 168/165 Illustration Rare PSA 10',
    'Venusaur ex 198/165 Ultra Rare Full Art Rare PSA 10',
    'Umbreon VMAX Alt Art Rare 215/203 PSA 10',
    'Rayquaza VMAX Alternate Art Rare 218/203 PSA 10',
    'Charizard V Full-Art Rare 154/172 PSA 10',
    'Arcanine 23/64 Jungle PSA 9 Rare Art',
    'Pikachu ar 25/102 PSA 9',
  ])('does not flag English rarity wording: %s', (title) => {
    expect(parseTitle(title).flags).not.toContain('non_english');
  });

  it.each([
    'Pokémon TCG Team Rocket\'s Mewtwo ex 213/182 Sv10 PSA 10',
    'Pokemon Bulbasaur 133/132 Me01: Mega Evolution (2025) EN Holo PSA 9',
    'PSA 10 Charizard ex 199/165 SV3pt5 151',
    'PSA 10 Morpeko SWSH12 Silver Tempest',
  ])('does not flag an English set code: %s', (title) => {
    expect(parseTitle(title).flags).not.toContain('non_english');
  });

  it.each([
    'CGC 9 MINT AUTO 10 Mudkip 4/5 2004 Kids\' Wb! Poke Card Creator Pokemon Card',
    'PSA 10 Charizard ex 199/165 Autographed by artist',
    'PSA 9 Pikachu 25/165 Signed',
    'PSA Auto 9 Pikachu 25/165',
    '1999-2000 POKEMON GAME #4 CHARIZARD-HOLO 4TH PRINT UK PSA 10',
    '1999 POKEMON GAME #4 CHARIZARD-HOLO 1999-2000 UK PRINT PSA 9',
    '1999 POKEMON GAME #58 PIKACHU RED CHEEKS PSA 9',
    '1999 POKEMON GAME #58 PIKACHU YELLOW CHEEKS E3 PSA 9',
    'Pikachu E3 Promo PSA 9',
    'Charizard 4/102 Thin Stamp PSA 9',
    'Charizard 4/102 Thick Stamp PSA 9',
  ])('flags autographs and print variants as a variant: %s', (title) => {
    expect(parseTitle(title).flags).toContain('variant');
  });
});
