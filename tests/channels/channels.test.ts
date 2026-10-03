import { describe, expect, it } from 'vitest';
import { loadChannels } from '../../src/channels/channels.js';
import { createTestDb } from '../helpers/test-db.js';
import { EBAY } from '../helpers/channels.js';

describe('loadChannels', () => {
  it('maps seeded rows to numbers', async () => {
    const db = await createTestDb();
    const channels = await loadChannels(db);
    expect(channels.find((c) => c.name === 'ebay')).toEqual(EBAY);
    expect(channels.find((c) => c.name === 'friend')?.enabled).toBe(false);
  });
});
