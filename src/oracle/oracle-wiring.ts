import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { poketraceAggregateSource } from '../poketrace/aggregate-source.js';
import { createPoketraceClient } from '../poketrace/client.js';
import { invalidatePoketraceId, resolvePoketraceId } from '../poketrace/mapping.js';
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
 * aggregates preferred, own DB comps as fallback, fixture never loaded and any leftover fixture rows excluded.
 */
export async function buildOracleDeps(
  cfg: Pick<Config, 'COMPS_SOURCE' | 'POKETRACE_API_KEY' | 'COMPS_FIXTURE_PATH'>,
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
  // The fixture part keeps the SAMPLE COMPS banner on.
  const fixture = await (deps.loadFixture ?? loadFixtureCompsSource)(cfg.COMPS_FIXTURE_PATH, now);
  return { db, now, source: compositeCompsSource([{ source: fixture }, { source: own }], log), excludeFixture: false };
}
