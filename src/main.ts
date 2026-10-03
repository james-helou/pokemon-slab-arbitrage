import { loadConfig } from './config.js';
import { pgDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { startBot } from './discord/bot.js';
import { deliverPending } from './discord/delivery.js';
import { log } from './log.js';
import { every } from './loop.js';
import { loadFixtureCompsSource } from './oracle/comps-source.js';
import { getValuation } from './oracle/oracle.js';
import { scanCycle } from './pipeline/scan-cycle.js';
import { loadSettings } from './settings/settings.js';
import { createBudget } from './sources/ebay/budget.js';
import { createEbayClient } from './sources/ebay/ebay-client.js';

async function main() {
  const cfg = loadConfig();
  const db = pgDb(cfg.DATABASE_URL, (err) => log('error', 'pg pool error', { message: err.message }));
  // Applies every migrations/*.sql not yet recorded (001, 002, 003, ...) before anything else runs.
  log('info', 'migrations', { applied: await migrate(db, 'migrations') });

  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from cards');
  if (rows[0]!.n === 0) log('warn', 'card catalog is empty: run `npm run catalog:sync`');

  const now = () => new Date();
  const budget = createBudget(db, 'ebay_browse', cfg.EBAY_DAILY_CALL_LIMIT, now);
  const ebay = createEbayClient({
    clientId: cfg.EBAY_CLIENT_ID, clientSecret: cfg.EBAY_CLIENT_SECRET, fetchFn: fetch, now,
    categoryIds: cfg.EBAY_CATEGORY_IDS, query: cfg.EBAY_QUERY, minPrice: cfg.EBAY_MIN_PRICE, budget,
  });
  const source = await loadFixtureCompsSource(cfg.COMPS_FIXTURE_PATH, now);

  const bot = await startBot({
    token: cfg.DISCORD_TOKEN, appId: cfg.DISCORD_APP_ID, guildId: cfg.DISCORD_GUILD_ID,
    channelIds: { alerts: cfg.DISCORD_ALERT_CHANNEL_ID, over_budget: cfg.DISCORD_OVERBUDGET_CHANNEL_ID },
    db, ebayUsedToday: () => budget.usedToday(), log,
  });

  let cycle = 0;
  const stopScan = every(
    async () => (await loadSettings(db)).scanIntervalSeconds * 1000,
    async () => {
      const s = await scanCycle(
        { db, ebay, budget, valuate: (key, settings) => getValuation({ db, source, now }, key, settings), now, log },
        cycle++,
      );
      log('info', 'scan cycle', { ...s });
    },
    log,
    'scan',
  );
  const stopDeliver = every(
    async () => 15_000,
    async () => {
      const r = await deliverPending({ db, send: bot.send, now, log });
      if (r.sent || r.failed) log('info', 'deliveries', r);
    },
    log,
    'deliver',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    stopScan();
    stopDeliver();
    let code = 0;
    try {
      await bot.stop();
      await db.end();
    } catch (err) {
      log('error', 'shutdown failed', { message: err instanceof Error ? err.message : String(err) });
      code = 1;
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // message only: stacks and wrapped errors can echo connection strings or tokens.
  log('error', 'fatal', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
