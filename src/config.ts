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
  /** fixture = sample comps (dev, SAMPLE COMPS banner); poketrace = PokeTrace aggregates + own DB comps; ppt = PokemonPriceTracker free tier + own DB comps. */
  COMPS_SOURCE: z.preprocess(blankToUndefined, z.enum(['fixture', 'poketrace', 'ppt']).default('fixture')),
  POKETRACE_API_KEY: z.string().optional().transform((v) => v || undefined),
  PPT_API_KEY: z.string().optional().transform((v) => v || undefined),
  /** Set to 1 only after running npm run ppt:probe and checking the parser against a real response. */
  PPT_PARSER_ACK: z.preprocess(blankToUndefined, z.enum(['1']).optional()),
  /** off (default): no eBay sold-search fetches at all. on: guarded check on alert candidates only. */
  SOLD_CHECK: z.preprocess(blankToUndefined, z.enum(['off', 'on']).default('off')),
  /** HTTP listen port (Railway sets it); main falls back to 8080. */
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).optional()),
  /** Public https URL registered with eBay for Marketplace Account Deletion notifications. */
  EBAY_DELETION_ENDPOINT: z.preprocess(
    blankToUndefined,
    z.string().url().refine((u) => u.startsWith('https://'), { message: 'must be an https URL' }).optional(),
  ),
  /** 32-80 chars of [A-Za-z0-9_-], the same token entered in the eBay developer portal. */
  EBAY_DELETION_VERIFICATION_TOKEN: z.preprocess(
    blankToUndefined,
    z.string().min(32).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
  ),
  /** Buyer's ISO country (e.g. CA). eBay then quotes shipping to them and the search keeps only listings that ship there. */
  EBAY_BUYER_COUNTRY: z.preprocess(blankToUndefined, z.string().regex(/^[A-Z]{2}$/).optional()),
  /** Buyer's postal code for shipping quotes; trimmed, spaces removed, uppercased. Requires EBAY_BUYER_COUNTRY. */
  EBAY_BUYER_POSTAL_CODE: z.preprocess(
    (v) => (typeof v === 'string' ? (v.replace(/\s+/g, '').toUpperCase() || undefined) : v),
    z.string().regex(/^[A-Z0-9]{3,10}$/).optional(),
  ),
}).superRefine((c, ctx) => {
  if (c.EBAY_BUYER_POSTAL_CODE && !c.EBAY_BUYER_COUNTRY) {
    ctx.addIssue({ code: 'custom', path: ['EBAY_BUYER_COUNTRY'], message: 'required when EBAY_BUYER_POSTAL_CODE is set' });
  }
  if (c.EBAY_DELETION_ENDPOINT && !c.EBAY_DELETION_VERIFICATION_TOKEN) {
    ctx.addIssue({ code: 'custom', path: ['EBAY_DELETION_VERIFICATION_TOKEN'], message: 'required when EBAY_DELETION_ENDPOINT is set' });
  }
  if (c.EBAY_DELETION_VERIFICATION_TOKEN && !c.EBAY_DELETION_ENDPOINT) {
    ctx.addIssue({ code: 'custom', path: ['EBAY_DELETION_ENDPOINT'], message: 'required when EBAY_DELETION_VERIFICATION_TOKEN is set' });
  }
  if (c.COMPS_SOURCE === 'poketrace' && !c.POKETRACE_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['POKETRACE_API_KEY'], message: 'required when COMPS_SOURCE=poketrace' });
  }
  if (c.COMPS_SOURCE === 'ppt' && !c.PPT_API_KEY) {
    ctx.addIssue({ code: 'custom', path: ['PPT_API_KEY'], message: 'required when COMPS_SOURCE=ppt' });
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
