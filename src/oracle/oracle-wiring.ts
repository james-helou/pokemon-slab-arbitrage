import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { poketraceAggregateSource } from '../poketrace/aggregate-source.js';
import { createPoketraceClient } from '../poketrace/client.js';
import { invalidatePoketraceId, resolvePoketraceId } from '../poketrace/mapping.js';
import { PPT_PARSER_VERSION, pptAggregateSource } from '../ppt/aggregate-source.js';
import { createPptClient } from '../ppt/client.js';
import { loadSettings } from '../settings/settings.js';
import { loadFixtureCompsSource, type CompsSource } from './comps-source.js';
import { compositeCompsSource } from './composite-source.js';
import type { OracleDeps } from './oracle.js';
import { ownCompsSource } from './own-comps-source.js';

export interface OracleWiringDeps {
  db: Db;
  now: () => Date;
  log: Log;
  fetch: typeof fetch;
  loadFixture?: (path: string, now: () => Date) => Promise<CompsSource>;
}

/**
 * Oracle dependencies for COMPS_SOURCE. fixture: sample comps + own DB comps (today's behaviour). poketrace: PokeTrace
 * aggregates preferred, own DB comps as fallback, fixture never loaded and any leftover fixture rows excluded. ppt: same
 * shape with PokemonPriceTracker's free tier, its daily credit cap read from settings at call time.
 */
export async function buildOracleDeps(
  cfg: Partial<Pick<Config, 'PPT_PARSER_ACK'>> & Pick<Config, 'COMPS_SOURCE' | 'POKETRACE_API_KEY' | 'PPT_API_KEY' | 'COMPS_FIXTURE_PATH'>,
  deps: OracleWiringDeps,
): Promise<OracleDeps> {
  const { db, now, log } = deps;
  log('info', `comps source: ${cfg.COMPS_SOURCE}`);
  const own = ownCompsSource(db, now);
  if (cfg.COMPS_SOURCE === 'poketrace') {
    if (!cfg.POKETRACE_API_KEY) throw new Error('POKETRACE_API_KEY is required when COMPS_SOURCE=poketrace');
    const client = createPoketraceClient({ apiKey: cfg.POKETRACE_API_KEY, fetch: deps.fetch });
    const aggregate = poketraceAggregateSource({
      client, now, log,
      resolveId: (cardId) => resolvePoketraceId({ db, client, fetch: deps.fetch, now }, cardId),
      invalidateId: (cardId) => invalidatePoketraceId(db, cardId, now()),
    });
    return { db, now, source: compositeCompsSource([{ source: own }], log), aggregate, excludeFixture: true };
  }
  if (cfg.COMPS_SOURCE === 'ppt') {
    if (!cfg.PPT_API_KEY) throw new Error('PPT_API_KEY is required when COMPS_SOURCE=ppt');
    if (PPT_PARSER_VERSION === 'v0-unverified' && cfg.PPT_PARSER_ACK !== '1') {
      throw new Error(
        'COMPS_SOURCE=ppt needs a verified parser: run `npm run ppt:probe -- <cardId>`, check the output, then set PPT_PARSER_ACK=1',
      );
    }
    const client = createPptClient({ apiKey: cfg.PPT_API_KEY, fetch: deps.fetch });
    const aggregate = pptAggregateSource({
      db, client, now, log, fetch: deps.fetch,
      dailyCredits: async () => (await loadSettings(db)).pptDailyCredits,
      burstCredits: async () => (await loadSettings(db)).pptBurstCredits,
    });
    return { db, now, source: compositeCompsSource([{ source: own }], log), aggregate, excludeFixture: true };
  }
  // The fixture part keeps the SAMPLE COMPS banner on.
  const fixture = await (deps.loadFixture ?? loadFixtureCompsSource)(cfg.COMPS_FIXTURE_PATH, now);
  return { db, now, source: compositeCompsSource([{ source: fixture }, { source: own }], log), excludeFixture: false };
}
