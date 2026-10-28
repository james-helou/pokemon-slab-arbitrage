import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ENV = {
  DATABASE_URL: 'postgres://u:p@h:5432/d', EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b', DISCORD_TOKEN: 't',
  DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2', DISCORD_ALERT_CHANNEL_ID: '3', DISCORD_OVERBUDGET_CHANNEL_ID: '4',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(ENV);
    expect(c.EBAY_CATEGORY_IDS).toBe('183454');
    expect(c.EBAY_DAILY_CALL_LIMIT).toBe(5000);
    expect(c.EBAY_MIN_PRICE).toBe(25);
  });
  it('fails loudly on missing secrets', () => {
    expect(() => loadConfig({ ...ENV, DISCORD_TOKEN: '' })).toThrow(/DISCORD_TOKEN/);
  });
  it('never puts provided secret values in the error message', () => {
    const secrets = {
      DATABASE_URL: 'postgres://user:db-pass-s3cret@host:5432/db',
      EBAY_CLIENT_SECRET: 'ebay-s3cret-value',
      DISCORD_TOKEN: 'discord-s3cret-token',
    };
    let message = '';
    try {
      loadConfig({ ...ENV, ...secrets, DISCORD_APP_ID: '', EBAY_MIN_PRICE: 'not-a-number-s3cret' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/DISCORD_APP_ID/);
    expect(message).toMatch(/EBAY_MIN_PRICE/);
    for (const v of [...Object.values(secrets), 'not-a-number-s3cret']) expect(message).not.toContain(v);
  });
  it('treats DISCORD_REPORT_CHANNEL_ID as optional', () => {
    expect(loadConfig(ENV).DISCORD_REPORT_CHANNEL_ID).toBeUndefined();
    expect(loadConfig({ ...ENV, DISCORD_REPORT_CHANNEL_ID: '' }).DISCORD_REPORT_CHANNEL_ID).toBeUndefined();
    expect(loadConfig({ ...ENV, DISCORD_REPORT_CHANNEL_ID: '5' }).DISCORD_REPORT_CHANNEL_ID).toBe('5');
  });
  it('treats DISCORD_WATCH_CHANNEL_ID as optional, blank as unset', () => {
    expect(loadConfig(ENV).DISCORD_WATCH_CHANNEL_ID).toBeUndefined();
    expect(loadConfig({ ...ENV, DISCORD_WATCH_CHANNEL_ID: '' }).DISCORD_WATCH_CHANNEL_ID).toBeUndefined();
    expect(loadConfig({ ...ENV, DISCORD_WATCH_CHANNEL_ID: '6' }).DISCORD_WATCH_CHANNEL_ID).toBe('6');
  });
  it('defaults COMPS_SOURCE to fixture with no PokeTrace key', () => {
    const c = loadConfig(ENV);
    expect(c.COMPS_SOURCE).toBe('fixture');
    expect(c.POKETRACE_API_KEY).toBeUndefined();
    expect(loadConfig({ ...ENV, COMPS_SOURCE: '', POKETRACE_API_KEY: '' })).toMatchObject({ COMPS_SOURCE: 'fixture' });
  });
  it('accepts COMPS_SOURCE=poketrace with a key', () => {
    const c = loadConfig({ ...ENV, COMPS_SOURCE: 'poketrace', POKETRACE_API_KEY: 'pt-key' });
    expect(c).toMatchObject({ COMPS_SOURCE: 'poketrace', POKETRACE_API_KEY: 'pt-key' });
  });
  it('rejects an unknown COMPS_SOURCE', () => {
    expect(() => loadConfig({ ...ENV, COMPS_SOURCE: 'ebay' })).toThrow(/COMPS_SOURCE/);
  });
  it('rejects COMPS_SOURCE=poketrace without a key, with a clear key-free message', () => {
    for (const key of [undefined, '']) {
      let message = '';
      try {
        loadConfig({ ...ENV, COMPS_SOURCE: 'poketrace', POKETRACE_API_KEY: key, DISCORD_TOKEN: 'discord-s3cret-token' });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/POKETRACE_API_KEY/);
      expect(message).toMatch(/required when COMPS_SOURCE=poketrace/);
      expect(message).not.toContain('discord-s3cret-token');
    }
  });
  it('defaults SOLD_CHECK to off and accepts only off|on', () => {
    expect(loadConfig(ENV).SOLD_CHECK).toBe('off');
    expect(loadConfig({ ...ENV, SOLD_CHECK: '' }).SOLD_CHECK).toBe('off');
    expect(loadConfig({ ...ENV, SOLD_CHECK: 'on' }).SOLD_CHECK).toBe('on');
    expect(() => loadConfig({ ...ENV, SOLD_CHECK: 'yes' })).toThrow(/SOLD_CHECK/);
  });
  it('parses the optional buyer location and normalizes the postal code', () => {
    const none = loadConfig(ENV);
    expect(none.EBAY_BUYER_COUNTRY).toBeUndefined();
    expect(none.EBAY_BUYER_POSTAL_CODE).toBeUndefined();
    const blank = loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: '', EBAY_BUYER_POSTAL_CODE: '' });
    expect(blank.EBAY_BUYER_COUNTRY).toBeUndefined();
    expect(blank.EBAY_BUYER_POSTAL_CODE).toBeUndefined();
    const c = loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'CA', EBAY_BUYER_POSTAL_CODE: ' h7t 2w7 ' });
    expect(c.EBAY_BUYER_COUNTRY).toBe('CA');
    expect(c.EBAY_BUYER_POSTAL_CODE).toBe('H7T2W7');
    expect(loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'CA' }).EBAY_BUYER_POSTAL_CODE).toBeUndefined();
  });
  it('rejects a bad buyer country, a bad postal code, or a postal code without a country', () => {
    expect(() => loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'ca' })).toThrow(/EBAY_BUYER_COUNTRY/);
    expect(() => loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'CAN' })).toThrow(/EBAY_BUYER_COUNTRY/);
    expect(() => loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'CA', EBAY_BUYER_POSTAL_CODE: 'H7' })).toThrow(/EBAY_BUYER_POSTAL_CODE/);
    expect(() => loadConfig({ ...ENV, EBAY_BUYER_COUNTRY: 'CA', EBAY_BUYER_POSTAL_CODE: 'H7T-2W7' })).toThrow(/EBAY_BUYER_POSTAL_CODE/);
    expect(() => loadConfig({ ...ENV, EBAY_BUYER_POSTAL_CODE: 'H7T2W7' })).toThrow(/EBAY_BUYER_COUNTRY \(required when EBAY_BUYER_POSTAL_CODE is set\)/);
  });
  it('accepts COMPS_SOURCE=ppt with a key and rejects it without one (key-free message)', () => {
    expect(loadConfig({ ...ENV, COMPS_SOURCE: 'ppt', PPT_API_KEY: 'ppt-key' })).toMatchObject({ COMPS_SOURCE: 'ppt', PPT_API_KEY: 'ppt-key' });
    for (const key of [undefined, '']) {
      expect(() => loadConfig({ ...ENV, COMPS_SOURCE: 'ppt', PPT_API_KEY: key })).toThrow(/PPT_API_KEY/);
    }
    expect(loadConfig(ENV).PPT_API_KEY).toBeUndefined();
    expect(loadConfig({ ...ENV, PPT_PARSER_ACK: '1' }).PPT_PARSER_ACK).toBe('1');
    expect(loadConfig({ ...ENV, PPT_PARSER_ACK: '' }).PPT_PARSER_ACK).toBeUndefined();
    expect(() => loadConfig({ ...ENV, PPT_PARSER_ACK: 'yes' })).toThrow(/PPT_PARSER_ACK/);
  });
});
