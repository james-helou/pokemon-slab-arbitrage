import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { findCandidates, findCandidatesInSet, getCard, listSets, type CardRow } from '../../src/catalog/catalog-repo.js';
import type { Db } from '../../src/db/db.js';
import { matchListing, type CandidateLookup, type SetLister } from '../../src/matcher/matcher.js';
import { seedCards } from '../helpers/fixtures.js';
import { createTestDb } from '../helpers/test-db.js';

/**
 * Real TCGdex English cards (every set) whose number is one the titles below use. Wrong-card matches the v1.2.0
 * review found at 0.855 are pinned here against real data, so a fake catalog cannot hide a collision.
 */
const SLICE: CardRow[] = JSON.parse(readFileSync('tests/fixtures/matcher/catalog-slice.json', 'utf8'));

let db: Db;
let lookup: CandidateLookup;
let sets: SetLister;
beforeAll(async () => {
  db = await createTestDb();
  for (let i = 0; i < SLICE.length; i += 1000) await seedCards(db, SLICE.slice(i, i + 1000));
  lookup = (n, t, set) => (set ? findCandidatesInSet(db, set, n) : findCandidates(db, n, t));
  sets = () => listSets(db);
});

const run = (title: string, aspects: Record<string, string> = {}) => matchListing({ title, aspects }, lookup, sets);

describe('set path: confirmed wrong-card matches must not reach the alert floor', () => {
  it.each([
    'Rillaboom V Sword & Shield Promo #14 PSA 10',
    '2020 POKEMON SWORD & SHIELD BLACK STAR PROMO #14 RILLABOOM V PSA 10',
    'Greninja BREAK XY #41 PSA 10',
    'Pinsir GX Sun & Moon #6 PSA 10',
    'Deoxys EX POP 4 #17 Holo PSA 9',
    'Deoxys ex #17 PSA 10',
    'Snivy Black & White Black Star Promo #1 PSA 10',
    "2011 POKEMON BLACK & WHITE MCDONALD'S #1 SNIVY PSA 10",
    "2019 POKEMON SUN & MOON MCDONALD'S #1 CATERPIE PSA 10",
    '2019 Pokemon Sun & Moon McDonalds Caterpie #1 PSA 10',
    '2017 Pokemon Sun & Moon Trainer Kit Lycanroc Caterpie #1 PSA 10',
    'Zoroark #71 Black & White Dark Explorer PSA 10',
    'Woobat #50 Black & White Dark Explorer PSA 10',
    'Klinklang #76 Black & White Emerging Power PSA 10',
    'Caterpie #1 Sun & Moon Burning Shadow PSA 10',
    'Growlithe #21 Sun & Moon Unbroken Bond PSA 10',
    'Shinx #98 Diamond & Pearl Mysterious Treasure PSA 10',
    'Quilava #49 HeartGold SoulSilver Call Legends PSA 9',
    'Charizard #4 Base Set II PSA 9',
    '1999 Pokemon Game Fossil Raichu #14 Holo PSA 9',
    '2020 POKEMON GAME #14 RAICHU PSA 10',
    '2020 POKEMON GAME #4 DARK CHARIZARD PSA 10',
    'Blastoise #2 Base 2 Pokemon Game PSA 9',
    '1999-2000 POKEMON GAME #4 CHARIZARD-HOLO 4TH PRINT UK PSA 10',
    '1999 POKEMON GAME #4 CHARIZARD-HOLO 1999-2000 UK PRINT PSA 9',
    '1999 POKEMON GAME #58 PIKACHU RED CHEEKS PSA 9',
    '1999 POKEMON GAME #58 PIKACHU YELLOW CHEEKS E3 PSA 9',
    '2020 POKEMON SV BLACK STAR PROMO #3 QUAXLY PSA 10',
    '2020 POKEMON MEGA EVOLUTION #25 VOLCANION PSA 10',
    'Charizard #4 PSA 9 1999 151 Original',
    'Pikachu #25 151 PSA 10',
    'Pitch Black Charizard #4 Base Set PSA 9',
    "PSA 10 Blaine's Charizard #4 Base Set",
    'Torterra LV.X #122 Diamond & Pearl PSA 8',
    'Charizard Dark #4 Team Rocket Returns PSA 9',
    // Evolutions reprints Drowzee as #49, so the POKEMON GAME alias cannot tell base1-49 from xy12-49.
    '1999 POKEMON GAME #49 DROWZEE PSA 8',
  ])('%s', async (title) => {
    const r = await run(title);
    expect(r.match?.confidence ?? 0, `${title} -> ${r.match?.cardId}`).toBeLessThan(0.85);
  });

  it('rejects a Set aspect that names a different set than the title', async () => {
    const r = await run('2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10', { Set: 'Vivid Voltage' });
    expect(r.match).toBeNull();
    expect(r.reasons).toEqual(['set_conflict']);
  });
});

describe('set path: correct label titles still match', () => {
  it.each([
    ['2024 POKEMON SSP EN-SURGING SPARKS ILLUSTRATION RARE #204 MESPRIT PSA 10', 'sv08-204'],
    ["2025 POKEMON SVP EN-SV BLACK STAR PROMO #205 TEAM ROCKET'S MEWTWO EX PSA 10", 'svp-205'],
    ['2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10', 'swsh7-95'],
    ['2007 POKEMON DIAMOND & PEARL SECRET WONDERS #3 CHARIZARD-HOLO PSA 8', 'dp3-3'],
    ['2003 POKEMON EX SANDSTORM #94 AERODACTYL EX-HOLO PSA 10', 'ex2-94'],
    ['Pokemon 2006 EX Holon Phantoms Pikachu Gold Star #104 PSA 6', 'ex13-104'],
    ["2023 POKEMON MEW EN-151 ULTRA RARE #197 GIOVANNI'S CHARISMA PSA 10", 'sv03.5-197'],
    ['2006 POKEMON EX HOLON PHANTOMS #8 GYARADOS-HOLO PSA 6', 'ex13-8'],
    ['1999 POKEMON GAME #88 PROFESSOR OAK PSA 7', 'base1-88'],
    ['1999 POKEMON GAME #95 SWITCH PSA 4', 'base1-95'],
  ])('%s -> %s', async (title, id) => {
    const r = await run(title);
    const card = r.match ? await getCard(db, r.match.cardId) : null;
    expect(card?.id ?? r.reasons.join(','), title).toBe(id);
    expect(r.match?.confidence).toBe(0.855);
  });

  it('accepts a Set aspect naming the same set', async () => {
    const r = await run('2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10', { Set: 'Evolving Skies' });
    expect(r.match?.cardId).toBe('swsh7-95');
  });
});
