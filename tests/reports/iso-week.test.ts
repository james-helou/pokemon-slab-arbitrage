import { describe, expect, it } from 'vitest';
import { isoWeekOf, isoWeekRange, previousIsoWeek } from '../../src/reports/iso-week.js';

describe('iso week', () => {
  it.each([
    ['2026-10-03T12:00:00Z', '2026-W40'],
    ['2026-09-28T00:00:00Z', '2026-W40'],
    ['2026-10-04T23:59:59Z', '2026-W40'],
    ['2026-10-05T00:00:00Z', '2026-W41'],
    ['2026-01-01T00:00:00Z', '2026-W01'],
    ['2027-01-01T12:00:00Z', '2026-W53'],
  ])('%s is %s', (iso, week) => {
    expect(isoWeekOf(new Date(iso))).toBe(week);
  });

  it('returns the UTC Monday-to-Monday range', () => {
    const { start, end } = isoWeekRange('2026-W40');
    expect(start.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    expect(isoWeekRange('2026-W01').start.toISOString()).toBe('2025-12-29T00:00:00.000Z');
    expect(isoWeekRange('2026-W53').start.toISOString()).toBe('2026-12-28T00:00:00.000Z');
  });

  it('rejects invalid labels', () => {
    expect(() => isoWeekRange('2025-W53')).toThrow(/Invalid ISO week/);
    expect(() => isoWeekRange('2026-W00')).toThrow(/Invalid ISO week/);
    expect(() => isoWeekRange('2026-40')).toThrow(/Invalid ISO week/);
  });

  it('previousIsoWeek is the last complete week', () => {
    expect(previousIsoWeek(new Date('2026-10-05T01:00:00Z'))).toBe('2026-W40');
  });
});
