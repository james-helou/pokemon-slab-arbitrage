import { HORIZONS_DAYS, type OutcomeLabel } from '../outcomes/label.js';
import { isoWeekRange } from './iso-week.js';

export const REPORT_VERSION = 'v1.0.0';

export interface ReportRecommendation {
  id: number;
  createdAt: Date;
  grader: string;
  grade: number;
  buyTotal: number;
  /** valuation_snapshot.value at recommendation time. */
  predictedValue: number;
  confidence: number;
  routedTo: string;
  deliveryStatus: string | null;
}

export interface ReportOutcome {
  recommendationId: number;
  horizonDays: number;
  label: OutcomeLabel | null;
  marketValue: number | null;
  netAtHorizon: number | null;
  listingFinalState: string;
  observedAt: Date;
}

export interface ReportDecision {
  recommendationId: number;
  action: 'bought' | 'pass' | 'watch';
  reason: string | null;
  createdAt: Date;
}

export interface WeeklyReportInput {
  week: string;
  generatedAt: Date;
  minNet: number;
  /** Everything up to the end of the week (the report for a past week is reproducible). */
  recommendations: ReportRecommendation[];
  outcomes: ReportOutcome[];
  decisions: ReportDecision[];
}

export interface WeeklyReport {
  week: string;
  markdown: string;
  summary: string;
}

type Pair = { r: ReportRecommendation; o: ReportOutcome };

const BAND_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9];
const PRICE_BANDS = [
  { label: '<$200', lo: 0, hi: 200 },
  { label: '$200-499', lo: 200, hi: 500 },
  { label: '$500-999', lo: 500, hi: 1000 },
  { label: '$1000+', lo: 1000, hi: Infinity },
];
const DECISION_RANK = { bought: 3, pass: 2, watch: 1 } as const;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const pct = (x: number | null, digits = 0) => (x === null ? 'n/a' : `${(x * 100).toFixed(digits)}%`);
const rate = (hits: number, n: number) => (n === 0 ? null : hits / n);
const day = (d: Date) => d.toISOString().slice(0, 10);
const inWeek = (d: Date, start: Date, end: Date) => d >= start && d < end;
const isNum = (x: number | null): x is number => x !== null;
const isHit = (p: Pair) => (p.o.netAtHorizon ?? 0) > 0;
const isGood = (p: Pair) => p.o.label === 'good';
const errorOf = ({ r, o }: Pair): number | null =>
  o.marketValue !== null && o.marketValue > 0 ? Math.abs(r.predictedValue - o.marketValue) / o.marketValue : null;

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return out;
}

const fmtCounts = (c: Record<string, number>) => {
  const keys = Object.keys(c).sort();
  return keys.length ? keys.map((k) => `${k} ${c[k]}`).join(', ') : 'none';
};

function bandLabel(c: number): string {
  let i = BAND_EDGES.length - 1;
  while (i > 0 && c < BAND_EDGES[i]!) i--;
  const lo = BAND_EDGES[i]!;
  const hi = i + 1 < BAND_EDGES.length ? BAND_EDGES[i + 1]! : 1;
  return `${lo.toFixed(2)}-${hi.toFixed(2)}`;
}

function segmentRow(name: string, ps: Pair[]): string {
  const errs = ps.map(errorOf).filter(isNum);
  return `| ${name} | ${ps.length} | ${pct(rate(ps.filter(isHit).length, ps.length))} | ${pct(median(errs), 1)} |`;
}

/** Pure: plain data in, vault markdown + Discord summary out. Calibration uses each rec's longest labelled horizon. */
export function buildWeeklyReport(input: WeeklyReportInput): WeeklyReport {
  const { start, end } = isoWeekRange(input.week);
  const lastDay = new Date(end.getTime() - 86_400_000);
  const recById = new Map(input.recommendations.map((r) => [r.id, r]));
  const weekRecs = input.recommendations.filter((r) => inWeek(r.createdAt, start, end));

  const strongest = new Map<number, ReportDecision['action']>();
  for (const dcs of input.decisions) {
    const cur = strongest.get(dcs.recommendationId);
    if (!cur || DECISION_RANK[dcs.action] > DECISION_RANK[cur]) strongest.set(dcs.recommendationId, dcs.action);
  }
  const decisionCounts = { bought: 0, pass: 0, watch: 0, none: 0 };
  for (const r of weekRecs) decisionCounts[strongest.get(r.id) ?? 'none']++;

  const weekOutcomes = input.outcomes.filter((o) => inWeek(o.observedAt, start, end));
  const weekLabels = { good: 0, marginal: 0, bad: 0, unlabeled: 0 };
  for (const o of weekOutcomes) weekLabels[o.label ?? 'unlabeled']++;

  const passes = input.decisions.filter((x) => x.action === 'pass');
  const passAll = countBy(passes, (x) => x.reason ?? 'unspecified');
  const passWeek = countBy(passes.filter((x) => inWeek(x.createdAt, start, end)), (x) => x.reason ?? 'unspecified');

  const canonical = new Map<number, ReportOutcome>();
  for (const o of input.outcomes) {
    if (o.label === null || o.netAtHorizon === null) continue;
    const cur = canonical.get(o.recommendationId);
    if (!cur || o.horizonDays > cur.horizonDays) canonical.set(o.recommendationId, o);
  }
  const labelled: Pair[] = [];
  for (const o of canonical.values()) {
    const r = recById.get(o.recommendationId);
    if (r) labelled.push({ r, o });
  }
  labelled.sort((a, b) => a.r.id - b.r.id);

  const n = labelled.length;
  const hits = labelled.filter(isHit).length;
  const goods = labelled.filter(isGood).length;
  const errors = labelled.map(errorOf).filter(isNum);
  const medErr = median(errors);

  const calRows = [...groupBy(labelled, (p) => bandLabel(p.r.confidence)).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([band, ps]) => {
      const mean = ps.reduce((s, p) => s + p.r.confidence, 0) / ps.length;
      return `| ${band} | ${ps.length} | ${mean.toFixed(2)} | ${pct(rate(ps.filter(isHit).length, ps.length))} | ${pct(rate(ps.filter(isGood).length, ps.length))} |`;
    });

  const byHorizon = HORIZONS_DAYS.map((h) => {
    const errs = input.outcomes
      .filter((o) => o.horizonDays === h)
      .map((o) => {
        const r = recById.get(o.recommendationId);
        return r ? errorOf({ r, o }) : null;
      })
      .filter(isNum);
    return `${h}d ${pct(median(errs), 1)} (n=${errs.length})`;
  }).join(' · ');

  const gradeRows = [...groupBy(labelled, (p) => `${p.r.grader} ${p.r.grade}`).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, ps]) => segmentRow(k, ps));
  const priceRows = PRICE_BANDS.flatMap((b) => {
    const ps = labelled.filter((p) => p.r.buyTotal >= b.lo && p.r.buyTotal < b.hi);
    return ps.length ? [segmentRow(b.label, ps)] : [];
  });

  const passReasons = [...new Set([...Object.keys(passAll), ...Object.keys(passWeek)])].sort();

  const lines = [
    '---',
    'tags: [journal, weekly, calibration]',
    `week: ${input.week}`,
    `generated: ${input.generatedAt.toISOString()}`,
    `report_version: ${REPORT_VERSION}`,
    '---',
    `# Weekly calibration ${input.week}`,
    '',
    `Week ${day(start)} to ${day(lastDay)} (UTC). Labels compare the counterfactual net at each horizon with min net $${input.minNet}. Calibration, error and hit rate use each recommendation's longest labelled horizon, cumulative to the end of the week.`,
    '',
    '## This week',
    `- Recommendations: ${weekRecs.length} (${fmtCounts(countBy(weekRecs, (r) => r.routedTo))})`,
    `- Deliveries: ${fmtCounts(countBy(weekRecs, (r) => r.deliveryStatus ?? 'none'))}`,
    `- Decisions: bought ${decisionCounts.bought}, pass ${decisionCounts.pass}, watch ${decisionCounts.watch}, none ${decisionCounts.none}`,
    `- Outcomes recorded: ${weekOutcomes.length} (good ${weekLabels.good}, marginal ${weekLabels.marginal}, bad ${weekLabels.bad}, unlabeled ${weekLabels.unlabeled})`,
    '',
    '## Pass reasons',
    ...(passReasons.length
      ? ['| Reason | This week | All time |', '|---|---|---|', ...passReasons.map((k) => `| ${k} | ${passWeek[k] ?? 0} | ${passAll[k] ?? 0} |`)]
      : ['_No passes yet._']),
    '',
    '## Calibration by confidence band',
    ...(calRows.length
      ? ['| Confidence band | n | Mean confidence | Hit rate (net > $0) | Good rate (net ≥ min) |', '|---|---|---|---|---|', ...calRows]
      : ['_No labelled outcomes yet._']),
    '',
    '## Valuation error',
    `- Median absolute % error: ${pct(medErr, 1)} (n=${errors.length})`,
    `- By horizon: ${byHorizon}`,
    '',
    '## Hit rate',
    `- Net > $0: ${pct(rate(hits, n))} (${hits}/${n})`,
    `- Net ≥ $${input.minNet}: ${pct(rate(goods, n))} (${goods}/${n})`,
    `- Listing final state (all outcomes): ${fmtCounts(countBy(input.outcomes, (o) => o.listingFinalState))}`,
    '',
    '## By segment',
    ...(gradeRows.length || priceRows.length
      ? ['| Segment | n | Hit rate | Median abs % error |', '|---|---|---|---|', ...gradeRows, ...priceRows]
      : ['_No labelled outcomes yet._']),
    '',
    '## Not yet measured',
    '- Predicted vs actual days to sell, realized net for bought slabs (needs inventory and sales, slice 4).',
    '- Set-era and comps-source breakdowns (catalog has no release dates; one comps source so far).',
    '',
    'Related: [[Learning-Loop]], [[Decision-Log]]',
    '',
  ];

  const summary = [
    `**Weekly calibration ${input.week}**`,
    `Recommendations this week: ${weekRecs.length} · outcomes recorded: ${weekOutcomes.length}`,
    `Hit rate (net > $0): ${pct(rate(hits, n))} (${hits}/${n}) · good (net ≥ $${input.minNet}): ${pct(rate(goods, n))}`,
    `Median abs valuation error: ${pct(medErr, 1)} (n=${errors.length})`,
    `Full report attached as ${input.week}.md. Save it to vault/journal/weekly/ or run npm run report:weekly.`,
  ].join('\n');

  return { week: input.week, markdown: lines.join('\n'), summary };
}
