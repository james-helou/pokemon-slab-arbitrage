import { z } from 'zod';

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
  COMPS_FIXTURE_PATH: z.string().default('data/comps-fixture.json'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) {
    // Names only, never values: several of these are secrets.
    const bad = [...new Set(r.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`Invalid environment: ${bad}`);
  }
  return r.data;
}
