import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { PARSER_VERSION } from './parse.js';
import { createSoldCheck, type SoldCheck } from './sold-check.js';

export interface SoldCheckWiringDeps {
  db: Db;
  fetch: typeof fetch;
  now: () => Date;
  log: Log;
}

/** SOLD_CHECK=off returns undefined, so evaluateListing gets no dep and behaves exactly as before. */
export function buildSoldCheckDep(cfg: Pick<Config, 'SOLD_CHECK'>, deps: SoldCheckWiringDeps): SoldCheck | undefined {
  deps.log('info', `sold check: ${cfg.SOLD_CHECK}`);
  if (cfg.SOLD_CHECK !== 'on') return undefined;
  if (PARSER_VERSION.includes('unverified')) {
    deps.log('warn', `sold check parser ${PARSER_VERSION} is unverified against a real eBay page; run soldcheck:probe first`);
  }
  return createSoldCheck(deps);
}
