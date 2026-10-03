import { describe, expect, it } from 'vitest';
import { respondEphemeral } from '../../src/discord/respond.js';

function fake(opts: { failDefer?: boolean } = {}) {
  const calls: string[] = [];
  const i = {
    deferred: false,
    replied: false,
    async deferReply() { if (opts.failDefer) throw new Error('unknown interaction'); calls.push('defer'); this.deferred = true; },
    async editReply(o: { content: string }) { calls.push(`edit:${o.content}`); },
    async reply(o: { content: string }) { calls.push(`reply:${o.content}`); this.replied = true; },
  };
  return { i, calls };
}

describe('respondEphemeral', () => {
  it('defers before doing work, then edits the reply', async () => {
    const { i, calls } = fake();
    await respondEphemeral(i, async () => { calls.push('work'); return { content: 'ok' }; }, () => {});
    expect(calls).toEqual(['defer', 'work', 'edit:ok']);
  });

  it('logs the message and sends a generic error via editReply when work throws', async () => {
    const { i, calls } = fake();
    const logs: Record<string, unknown>[] = [];
    await respondEphemeral(i, async () => { throw new Error('db down'); }, (_l, _m, d) => void logs.push(d ?? {}));
    expect(calls).toEqual(['defer', 'edit:Something went wrong']);
    expect(logs[0]).toEqual({ message: 'db down' });
  });

  it('falls back to reply when defer fails, without throwing', async () => {
    const { i, calls } = fake({ failDefer: true });
    await respondEphemeral(i, async () => ({ content: 'never' }), () => {});
    expect(calls).toEqual(['reply:Something went wrong']);
  });
});
