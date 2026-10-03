import { z } from 'zod';

const blankToUndefined = (v: unknown) => (v === '' ? undefined : v);

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  EBAY_CLIENT_ID: z.string().min(1),
  EBAY_CLIENT_SECRET: z.string().min(1),
  EBAY_CATEGORY_IDS: z.string().default('183454'),
  EBAY_QUERY: z.string().default('pokemon'),
  EBAY_MIN_PRICE: z.coerce.number().default(25),
  EBAY_DAILY_CALL_LIMIT: z.coerce.number().default(5000),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_ALERT_CHANNEL_ID: z.string().min(1),
  DISCORD_OVERBUDGET_CHANNEL_ID: z.string().min(1),
  /** Weekly report channel; falls back to the over-budget channel when unset. */
  DISCORD_REPORT_CHANNEL_ID: z.string().optional().transform((v) => v || undefined),
  COMPS_FIXTURE_PATH: z.string().default('data/comps-fixture.json'),
  /** fixture = sample comps (dev, SAMPLE COMPS banner); poketrace = PokeTrace aggregates + own DB comps. */
  COMPS_SOURCE: z.preprocess(blankToUndefined, z.enum(['fixture', 'poketrace']).default('fixture')),
  POKETRACE_API_KEY: z.string().optional().transform((v) => v || undefined),
}).superRefine((c, ctx) => {
  if (c.COMPS_SOURCE === 'poketrace' && !c.POKETRACE_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['POKETRACE_API_KEY'], message: 'required when COMPS_SOURCE=poketrace' });
  }
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    // Names only, never values: several of these are secrets. Custom issues carry our own fixed text, never a value.
    const bad = [...new Set(r.error.issues.map((i) => (i.code === 'custom' ? `${i.path.join('.')} (${i.message})` : i.path.join('.'))))]
      .join(', ');
    throw new Error(`Invalid environment: ${bad}`);
  }
  return r.data;
}
