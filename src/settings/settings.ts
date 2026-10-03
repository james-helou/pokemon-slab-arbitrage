import type { Db } from '../db/db.js';
import type { Grader } from '../domain/types.js';

export interface Settings {
  paused: boolean;
  enabledGraders: Grader[];
  minNet: number;
  minRoi: number;
  alertRatio: number;
  valueFloor: number;
  buyTaxRate: number;
  /** Multiplier applied to comps whose real price may be hidden (accepted Best Offers). Not applied to paid_source. */
  boDiscount: number;
  valuationMaxAgeHours: number;
  /** Minimum comps in the window required to produce a valuation. */
  minCompCount: number;
  /** Minimum matcher confidence required to proceed (title-only PSA match is 0.855). */
  minMatchConfidence: number;
  scanIntervalSeconds: number;
  deliveryIntervalSeconds: number;
  /** Queued alerts older than this are expired instead of sent. */
  maxAlertAgeMinutes: number;
  browserAgentEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  enabledGraders: ['PSA'],
  minNet: 75,
  minRoi: 0.2,
  alertRatio: 0.8,
  valueFloor: 150,
  buyTaxRate: 0.07,
  boDiscount: 0.92,
  valuationMaxAgeHours: 24,
  minCompCount: 3,
  minMatchConfidence: 0.85,
  scanIntervalSeconds: 90,
  deliveryIntervalSeconds: 15,
  maxAlertAgeMinutes: 15,
  browserAgentEnabled: false,
};

/** Lower bounds for DB-loaded values that would otherwise hammer eBay or Discord. */
const MINIMUMS: Partial<Record<keyof Settings, number>> = {
  scanIntervalSeconds: 30,
  deliveryIntervalSeconds: 5,
  maxAlertAgeMinutes: 1,
};

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('select key, value from settings');
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    const key = r.key as keyof Settings;
    const dflt = DEFAULT_SETTINGS[key];
    let value = r.value;
    if (typeof dflt === 'number') {
      value = typeof value === 'number' && Number.isFinite(value) ? Math.max(value, MINIMUMS[key] ?? -Infinity) : dflt;
    }
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

export async function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): Promise<void> {
  await db.query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
