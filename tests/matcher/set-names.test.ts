import { describe, expect, it } from 'vitest';
import { resolveTitleSet, type SetRef } from '../../src/matcher/set-names.js';

const SETS: SetRef[] = [
  ['base1', 'Base Set'], ['base4', 'Base Set 2'], ['base5', 'Team Rocket'], ['lc', 'Legendary Collection'],
  ['ex1', 'Ruby & Sapphire'], ['ex2', 'Sandstorm'], ['ex3', 'Dragon'], ['ex8', 'Deoxys'], ['ex9', 'Emerald'],
  ['ex13', 'Holon Phantoms'], ['ex15', 'Dragon Frontiers'], ['dp1', 'Diamond & Pearl'], ['dp3', 'Secret Wonders'],
  ['bw1', 'Black & White'], ['xy1', 'XY'], ['xy12', 'Evolutions'], ['sm1', 'Sun & Moon'], ['sm115', 'Hidden Fates'],
  ['sma', 'Hidden Fates Shiny Vault'], ['smp', 'SM Black Star Promos'], ['swsh1', 'Sword & Shield'], ['swsh4', 'Vivid Voltage'],
  ['swsh7', 'Evolving Skies'], ['swsh8', 'Fusion Strike'], ['swshp', 'SWSH Black Star Promos'], ['sv01', 'Scarlet & Violet'],
  ['svp', 'SVP Black Star Promos'], ['sv03.5', '151'], ['sv06', 'Twilight Masquerade'], ['sv08', 'Surging Sparks'],
  ['sv08.5', 'Prismatic Evolutions'], ['mep', 'MEP Black Star Promos'], ['swsh3.5', "Champion's Path"],
  ['ex7', 'Team Rocket Returns'], ['ecard1', 'Expedition Base Set'], ['pl1', 'Platinum'], ['pl2', 'Rising Rivals'],
  ['hgss1', 'HeartGold SoulSilver'], ['hgss2', 'Unleashed'], ['me01', 'Mega Evolution'], ['me02', 'Phantasmal Flames'],
].map(([id, name]) => ({ id: id!, name: name! }));

describe('resolveTitleSet', () => {
  it.each([
    ['2021 POKEMON SWORD & SHIELD EVOLVING SKIES #095 FULL ART/UMBREON VMAX PSA 10', 'swsh7'],
    ['2020 POKEMON SWORD & SHIELD VIVID VOLTAGE #179 FULL ART/ALLISTER PSA 9', 'swsh4'],
    ['2021 POKEMON SWORD & SHIELD FUSION STRIKE #123 SIGILYPH PSA 10', 'swsh8'],
    ['2003 POKEMON EX SANDSTORM #94 AERODACTYL EX-HOLO PSA 10', 'ex2'],
    ['2007 POKEMON DIAMOND & PEARL SECRET WONDERS #3 CHARIZARD-HOLO PSA 8', 'dp3'],
    ['2024 POKEMON SSP EN-SURGING SPARKS ILLUSTRATION RARE #204 MESPRIT PSA 10', 'sv08'],
    ['PSA 9 - ALAKAZAM #082 - 2024 POKEMON TWM EN TWILIGHT MASQUERADE #82', 'sv06'],
    ["2025 POKEMON SVP EN-SV BLACK STAR PROMO #205 TEAM ROCKET'S MEWTWO EX PSA 10", 'svp'],
    ['2025 POKEMON MEP EN-ME BLACK STAR PROMO #018 COTTONEE PSA 10', 'mep'],
    ['2019 POKEMON SM BLACK STAR PROMO #100 PIKACHU PSA 10', 'smp'],
    ['2020 POKEMON SWSH BLACK STAR PROMO #050 PIKACHU PSA 10', 'swshp'],
    ['1999 POKEMON GAME #49 DROWZEE PSA 8', 'base1'],
    ['2023 POKEMON MEW EN-151 ULTRA RARE #197 GIOVANNI\'S CHARISMA PSA 10', 'sv03.5'],
    ['2011 Pokemon Black & White Zekrom #114 Gray Background Full Art Tag 7 NM', 'bw1'],
    ['2006 POKEMON EX HOLON PHANTOMS #8 GYARADOS-HOLO PSA 6', 'ex13'],
    ['2004 POKEMON EX DRAGON FRONTIERS #100 CHARIZARD PSA 9', 'ex15'],
    ['2016 POKEMON XY EVOLUTIONS #11 CHARIZARD PSA 10', 'xy12'],
    ['2025 POKEMON PRE EN-PRISMATIC EVOLUTIONS #161 UMBREON EX PSA 10', 'sv08.5'],
    ['2019 POKEMON SUN & MOON HIDDEN FATES SHINY VAULT #60 CHARIZARD PSA 10', 'sma'],
    ["2020 POKEMON SWORD & SHIELD CHAMPION'S PATH #74 CHARIZARD PSA 10", 'swsh3.5'],
    ['2000 POKEMON BASE SET 2 #4 CHARIZARD PSA 9', 'base4'],
    ['Pokemon 2002 Legendary Collection Dark Dragonair #38 PSA 9', 'lc'],
    ['2000 POKEMON ROCKET #4 DARK CHARIZARD-HOLO PSA 9', 'base5'],
    ['2004 POKEMON EX TEAM ROCKET RETURNS #4 DARK DRAGONITE PSA 9', 'ex7'],
    ['2002 POKEMON EXPEDITION #6 CHARIZARD-HOLO PSA 8', 'ecard1'],
    ['2009 POKEMON PLATINUM RISING RIVALS #1 ARCEUS PSA 9', 'pl2'],
    ['2010 POKEMON HEARTGOLD & SOULSILVER #1 ARCANINE PSA 9', 'hgss1'],
    ['2010 POKEMON HS UNLEASHED #1 ENTEI & RAIKOU LEGEND PSA 9', 'hgss2'],
    ['2025 POKEMON MEGA EVOLUTION PHANTASMAL FLAMES #125 MEGA CHARIZARD X EX PSA 10', 'me02'],
    ['2025 POKEMON MEG EN-MEGA EVOLUTION #179 MEGA LUCARIO EX PSA 10', 'me01'],
  ])('%s -> %s', (title, id) => {
    expect(resolveTitleSet(title, SETS)).toBe(id);
  });

  it('uses an era name (Sword & Shield) only when no other set is named', () => {
    expect(resolveTitleSet('2020 POKEMON SWORD & SHIELD #25 PIKACHU PSA 10', SETS)).toBe('swsh1');
    expect(resolveTitleSet('Evolving Skies Umbreon VMAX #215 Sword & Shield PSA 10', SETS)).toBe('swsh7');
  });

  it('ignores the #N itself, so #151 is not the 151 set', () => {
    expect(resolveTitleSet('PSA 10 Mew #151 Pokemon', SETS)).toBeNull();
  });

  it('refuses two different sets named equally', () => {
    expect(resolveTitleSet('2005 POKEMON EX EMERALD #9 DEOXYS PSA 9', SETS)).toBe('ambiguous');
  });

  it('returns null when no set is named', () => {
    expect(resolveTitleSet('PSA 10 Blaine\'s Arcanine Holo #59 Guren Town Gym Deck 1999', SETS)).toBeNull();
    expect(resolveTitleSet('PSA 10 Magma\'s Houndoom Holo #020 Magma Vs Aqua 2003', SETS)).toBeNull();
  });

  it('skips an alias whose target set is not in the catalog', () => {
    expect(resolveTitleSet('1999 POKEMON GAME #49 DROWZEE PSA 8', SETS.filter((s) => s.id !== 'base1'))).toBeNull();
  });
});

describe('resolveTitleSet era prefixes', () => {
  it('drops Platinum when another one-word set is named', () => {
    expect(resolveTitleSet('2009 POKEMON PLATINUM ARCEUS #1 ARCEUS PSA 9', [{ id: 'pl1', name: 'Platinum' }, { id: 'pl4', name: 'Arceus' }])).toBe('pl4');
  });
});
