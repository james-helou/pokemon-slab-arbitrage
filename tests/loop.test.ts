import { describe, expect, it } from 'vitest';
import { silentLog, type Log } from '../src/log.js';
import { every } from '../src/loop.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('every', () => {
  it('runs repeatedly, survives errors, and stops', async () => {
    let runs = 0;
    const stop = every(async () => 5, async () => { runs++; if (runs === 2) throw new Error('x'); }, silentLog, 'test');
    await sleep(60);
    stop();
    const after = runs;
    await sleep(30);
    expect(after).toBeGreaterThanOrEqual(3);
    expect(runs).toBe(after);
  });

  it('logs only the error message when a tick throws, then the next tick still runs', async () => {
    const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
    const log: Log = (level, msg, data) => void logs.push({ level, msg, data });
    let runs = 0;
    let succeeded = 0;
    const stop = every(async () => 5, async () => {
      runs++;
      if (runs === 1) throw new Error('searchNewGraded exploded');
      succeeded++;
    }, log, 'scan');
    await sleep(50);
    stop();
    expect(succeeded).toBeGreaterThanOrEqual(2);
    const errs = logs.filter((l) => l.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0]!.data).toEqual({ err: 'searchNewGraded exploded' });
    expect(JSON.stringify(errs[0])).not.toContain('at ');
  });

  it('skips a tick while the previous one is still running', async () => {
    const logs: string[] = [];
    const log: Log = (_l, msg) => void logs.push(msg);
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const stop = every(async () => 5, async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      active--;
    }, log, 'scan');
    await sleep(100);
    stop();
    await sleep(50);
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes('skipped'))).toBe(true);
  });
});
