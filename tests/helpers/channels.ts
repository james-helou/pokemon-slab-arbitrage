import type { Channel } from '../../src/channels/channels.js';

export const EBAY: Channel = {
  name: 'ebay', enabled: true, priceFactor: 1, feePct: 0.1325, feeTierThreshold: 7500, feePctAboveTier: 0.0235,
  feeCap: null, paymentPct: 0, paymentFlat: 0, orderFlatFee: 0.4, outboundShipping: 5, supplies: 1.5, avgDaysToSell: 10,
};

export const TCGPLAYER: Channel = {
  name: 'tcgplayer', enabled: true, priceFactor: 0.95, feePct: 0.1075, feeTierThreshold: null, feePctAboveTier: null,
  feeCap: 75, paymentPct: 0.025, paymentFlat: 0.3, orderFlatFee: 0, outboundShipping: 5, supplies: 1.5, avgDaysToSell: 21,
};

export const LOCAL_DISABLED: Channel = {
  name: 'local', enabled: false, priceFactor: 0.9, feePct: 0, feeTierThreshold: null, feePctAboveTier: null,
  feeCap: null, paymentPct: 0, paymentFlat: 0, orderFlatFee: 0, outboundShipping: 0, supplies: 0, avgDaysToSell: 30,
};
