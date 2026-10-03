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
  scanIntervalSeconds: number;
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
  scanIntervalSeconds: 90,
  browserAgentEnabled: false,
};

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('select key, value from settings');
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) (out as unknown as Record<string, unknown>)[r.key] = r.value;
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
