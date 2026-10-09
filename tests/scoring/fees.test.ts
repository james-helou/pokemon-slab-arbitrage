import { describe, expect, it } from 'vitest';
import { buyTotal, channelCosts, netProfit, round2 } from '../../src/scoring/fees.js';
import { EBAY, TCGPLAYER } from '../helpers/channels.js';

describe('fees', () => {
  it('eBay below the $7,500 tier', () => {
    expect(channelCosts(EBAY, 500)).toBe(73.15);
  });
  it('eBay above the tier uses the lower rate on the excess', () => {
    expect(channelCosts(EBAY, 10_000)).toBe(1059.4);
  });
  it('TCGplayer commission is capped at $75', () => {
    expect(channelCosts(TCGPLAYER, 1000)).toBe(106.8);
  });
  it('TCGplayer below the cap', () => {
    expect(channelCosts(TCGPLAYER, 500)).toBe(73.05);
  });
  it('buy total includes shipping and tax', () => {
    expect(buyTotal(350, 5, 0.07)).toBe(379.85);
  });
  it('buy total adds the FX fee on top of tax', () => {
    expect(buyTotal(350, 5, 0.14975, 0.025)).toBe(417.04);
    expect(buyTotal(350, 5, 0.07, 0)).toBe(buyTotal(350, 5, 0.07));
  });
  it('net profit = sale - costs - buy total', () => {
    expect(netProfit(EBAY, 600, 379.85)).toBe(133.75);
  });
  it('round2 rounds half-cent floating error up', () => {
    expect(round2(1.005)).toBe(1.01);
  });
});
