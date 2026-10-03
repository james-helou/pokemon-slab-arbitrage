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
});
