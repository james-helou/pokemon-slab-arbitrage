import { describe, expect, it } from 'vitest';
import { buildWeeklyReport, median, type WeeklyReportInput } from '../../src/reports/weekly.js';

const d = (iso: string) => new Date(iso);

const INPUT: WeeklyReportInput = {
  week: '2026-W40',
  generatedAt: d('2026-10-05T01:00:00Z'),
  minNet: 75,
  recommendations: [
    { id: 1, createdAt: d('2026-09-21T10:00:00Z'), grader: 'PSA', grade: 10, buyTotal: 380, predictedValue: 600, confidence: 0.85, routedTo: 'alerts', deliveryStatus: 'sent' },
    { id: 2, createdAt: d('2026-09-30T10:00:00Z'), grader: 'PSA', grade: 9, buyTotal: 250, predictedValue: 400, confidence: 0.65, routedTo: 'over_budget', deliveryStatus: 'sent' },
    { id: 3, createdAt: d('2026-09-10T10:00:00Z'), grader: 'PSA', grade: 10, buyTotal: 700, predictedValue: 1000, confidence: 0.92, routedTo: 'alerts', deliveryStatus: 'expired' },
    { id: 4, createdAt: d('2026-10-01T10:00:00Z'), grader: 'PSA', grade: 10, buyTotal: 300, predictedValue: 450, confidence: 0.7, routedTo: 'alerts', deliveryStatus: 'pending' },
  ],
  outcomes: [
    { recommendationId: 1, horizonDays: 7, label: 'good', marketValue: 570, netAtHorizon: 100, listingFinalState: 'sold_out', observedAt: d('2026-09-28T11:00:00Z') },
    { recommendationId: 3, horizonDays: 7, label: 'good', marketValue: 900, netAtHorizon: 80, listingFinalState: 'live', observedAt: d('2026-09-17T11:00:00Z') },
    { recommendationId: 3, horizonDays: 14, label: 'bad', marketValue: 800, netAtHorizon: -10, listingFinalState: 'not_found', observedAt: d('2026-09-24T11:00:00Z') },
  ],
  decisions: [
    { recommendationId: 1, action: 'pass', reason: 'condition', createdAt: d('2026-09-21T11:00:00Z') },
    { recommendationId: 2, action: 'pass', reason: 'price', createdAt: d('2026-09-30T12:00:00Z') },
    { recommendationId: 3, action: 'watch', reason: null, createdAt: d('2026-09-10T11:00:00Z') },
  ],
};

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('buildWeeklyReport', () => {
  const { markdown, summary } = buildWeeklyReport(INPUT);

  it('writes vault frontmatter and the week range', () => {
    expect(markdown).toContain('week: 2026-W40');
    expect(markdown).toContain('# Weekly calibration 2026-W40');
    expect(markdown).toContain('Week 2026-09-28 to 2026-10-04 (UTC)');
  });

  it('counts this week by status and decision', () => {
    expect(markdown).toContain('- Recommendations: 2 (alerts 1, over_budget 1)');
    expect(markdown).toContain('- Deliveries: pending 1, sent 1');
    expect(markdown).toContain('- Decisions: bought 0, pass 1, watch 0, none 1');
    expect(markdown).toContain('- Outcomes recorded: 1 (good 1, marginal 0, bad 0, unlabeled 0)');
  });

  it('tabulates pass reasons for the week and all time', () => {
    expect(markdown).toContain('| condition | 0 | 1 |');
    expect(markdown).toContain('| price | 1 | 1 |');
  });

  it('calibrates per confidence band on the longest labelled horizon', () => {
    expect(markdown).toContain('| 0.80-0.90 | 1 | 0.85 | 100% | 100% |');
    expect(markdown).toContain('| 0.90-1.00 | 1 | 0.92 | 0% | 0% |');
  });

  it('reports valuation error, hit rate and segments', () => {
    expect(markdown).toContain('- Median absolute % error: 15.1% (n=2)');
    expect(markdown).toContain('- By horizon: 7d 8.2% (n=2) · 14d 25.0% (n=1) · 30d n/a (n=0)');
    expect(markdown).toContain('- Net > $0: 50% (1/2)');
    expect(markdown).toContain('- Net ≥ $75: 50% (1/2)');
    expect(markdown).toContain('| PSA 10 | 2 | 50% | 15.1% |');
    expect(markdown).toContain('| $200-499 | 1 | 100% | 5.3% |');
    expect(markdown).toContain('| $500-999 | 1 | 0% | 25.0% |');
    expect(markdown).toContain('- Listing final state (all outcomes): live 1, not_found 1, sold_out 1');
  });

  it('produces a short Discord summary', () => {
    expect(summary).toContain('Weekly calibration 2026-W40');
    expect(summary).toContain('Hit rate (net > $0): 50% (1/2)');
    expect(summary).toContain('Median abs valuation error: 15.1% (n=2)');
    expect(summary.length).toBeLessThan(2000);
  });

  it('renders an empty week without crashing', () => {
    const empty = buildWeeklyReport({ ...INPUT, recommendations: [], outcomes: [], decisions: [] });
    expect(empty.markdown).toContain('_No labelled outcomes yet._');
    expect(empty.markdown).toContain('- Net > $0: n/a (0/0)');
    expect(empty.markdown).toContain('_No passes yet._');
  });
});
