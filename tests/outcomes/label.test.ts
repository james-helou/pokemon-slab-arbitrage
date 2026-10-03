import { describe, expect, it } from 'vitest';
import { HORIZONS_DAYS, counterfactualNet, labelForNet } from '../../src/outcomes/label.js';
import { EBAY, LOCAL_DISABLED, TCGPLAYER } from '../helpers/channels.js';

describe('labelForNet', () => {
  it.each([
    [75, 'good'], [133.75, 'good'], [74.99, 'marginal'], [0, 'marginal'], [-0.01, 'bad'],
  ] as const)('net %s -> %s', (net, label) => {
    expect(labelForNet(net, 75)).toBe(label);
  });
});

describe('counterfactualNet', () => {
  const channels = [EBAY, TCGPLAYER, LOCAL_DISABLED];
  it.each([
    [600, { channel: 'ebay', net: 133.75 }],
    [500, { channel: 'ebay', net: 47 }],
    [400, { channel: 'ebay', net: -39.75 }],
  ])('market %s with buy total 379.85', (value, expected) => {
    expect(counterfactualNet(channels, value, 379.85)).toEqual(expected);
  });

  it('returns null with no enabled channel', () => {
    expect(counterfactualNet([LOCAL_DISABLED], 600, 379.85)).toBeNull();
  });

  it('defines the spec horizons', () => {
    expect(HORIZONS_DAYS).toEqual([7, 14, 30]);
  });
});
