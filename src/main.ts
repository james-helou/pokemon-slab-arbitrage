import { ensureCatalog } from './catalog/ensure.js';
import { syncCatalog } from './catalog/sync.js';
import { loadConfig } from './config.js';
import { pgDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { sweepDisappeared } from './disappearing/sweep.js';
import { startBot } from './discord/bot.js';
import { deliverPending } from './discord/delivery.js';
import { log } from './log.js';
import { every } from './loop.js';
import { loadFixtureCompsSource } from './oracle/comps-source.js';
import { compositeCompsSource } from './oracle/composite-source.js';
import { getValuation } from './oracle/oracle.js';
import { ownCompsSource } from './oracle/own-comps-source.js';
import { runOutcomes } from './outcomes/outcome-tracker.js';
import type { EvaluateDeps } from './pipeline/evaluate.js';
import { scanCycle } from './pipeline/scan-cycle.js';
import { runWeeklyReportJob } from './reports/weekly-job.js';
import { loadSettings } from './settings/settings.js';
import { createBudget } from './sources/ebay/budget.js';
import { createEbayClient } from './sources/ebay/ebay-client.js';

const WEEKLY_CHECK_MS = 3_600_000;

async function main() {
  const cfg = loadConfig();
  const db = pgDb(cfg.DATABASE_URL, (err) => log('error', 'pg pool error', { message: err.message }));
  // Applies every migrations/*.sql not yet recorded (001 ... 007) before anything else runs.
  log('info', 'migrations', { applied: await migrate(db, 'migrations') });

  // The scan loop must never run against an empty catalog (every listing would be marked evaluated as no_match).
  if (!(await ensureCatalog(db, async () => (await syncCatalog(db, fetch, log)).cards, log))) {
    await db.end();
    process.exit(1);
  }

  const now = () => new Date();
  const budget = createBudget(db, 'ebay_browse', cfg.EBAY_DAILY_CALL_LIMIT, now);
  const ebay = createEbayClient({
    clientId: cfg.EBAY_CLIENT_ID, clientSecret: cfg.EBAY_CLIENT_SECRET, fetchFn: fetch, now,
    categoryIds: cfg.EBAY_CATEGORY_IDS, query: cfg.EBAY_QUERY, minPrice: cfg.EBAY_MIN_PRICE, budget,
  });
  // Paid vendor slots in here as another part once chosen; the fixture part keeps the SAMPLE COMPS banner on.
  const fixture = await loadFixtureCompsSource(cfg.COMPS_FIXTURE_PATH, now);
  const source = compositeCompsSource([{ source: fixture }, { source: ownCompsSource(db, now) }], log);
  const valuate: EvaluateDeps['valuate'] = (key, settings) => getValuation({ db, source, now }, key, settings);

  const bot = await startBot({
    token: cfg.DISCORD_TOKEN, appId: cfg.DISCORD_APP_ID, guildId: cfg.DISCORD_GUILD_ID,
    channelIds: { alerts: cfg.DISCORD_ALERT_CHANNEL_ID, over_budget: cfg.DISCORD_OVERBUDGET_CHANNEL_ID },
    reportChannelId: cfg.DISCORD_REPORT_CHANNEL_ID ?? cfg.DISCORD_OVERBUDGET_CHANNEL_ID,
    db, ebayUsedToday: () => budget.usedToday(), log,
  });

  // Every job below re-reads settings each run and returns early while paused (kill switch).
  let cycle = 0;
  const stopScan = every(
    async () => (await loadSettings(db)).scanIntervalSeconds * 1000,
    async () => {
      const s = await scanCycle({ db, ebay, budget, valuate, now, log }, cycle++);
      log('info', 'scan cycle', { ...s });
    },
    log,
    'scan',
  );
  const stopDeliver = every(
    async () => (await loadSettings(db)).deliveryIntervalSeconds * 1000,
    async () => {
      const r = await deliverPending({ db, send: bot.send, now, log });
      if (r.sent || r.failed) log('info', 'deliveries', r);
    },
    log,
    'deliver',
  );
  const stopSweep = every(
    async () => (await loadSettings(db)).sweepIntervalMinutes * 60_000,
    async () => {
      const r = await sweepDisappeared({ db, ebay, budget, now, log });
      if (r.suspects || r.compsWritten) log('info', 'disappearance sweep', { ...r });
    },
    log,
    'sweep',
  );
  const stopOutcomes = every(
    async () => (await loadSettings(db)).outcomeIntervalMinutes * 60_000,
    async () => {
      const r = await runOutcomes({ db, ebay, budget, valuate, now, log });
      if (r.due) log('info', 'outcomes', { ...r });
    },
    log,
    'outcomes',
  );
  const stopWeekly = every(
    async () => WEEKLY_CHECK_MS,
    async () => {
      const r = await runWeeklyReportJob({
        db, now, log,
        post: async (summary, file) => {
          await bot.sendReport(summary, file);
        },
      });
      if (r.status === 'posted') log('info', 'weekly report posted', { ...r });
    },
    log,
    'weekly-report',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'shutting down', { signal });
    let code = 0;
    try {
      // Let any in-flight job finish (bounded) before closing the bot and DB under it.
      await Promise.all([stopScan(), stopDeliver(), stopSweep(), stopOutcomes(), stopWeekly()]);
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
