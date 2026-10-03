import {
  Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  type Interaction, type MessageCreateOptions,
} from 'discord.js';
import type { Db } from '../db/db.js';
import type { Route } from '../ledger/ledger-repo.js';
import type { Log } from '../log.js';
import type { AlertPayload } from './alert-payload.js';
import { handleCommand, handleComponent } from './handlers.js';
import { respondEphemeral } from './respond.js';

export const COMMANDS = [
  new SlashCommandBuilder().setName('pause').setDescription('Pause scanning and alerts (kill switch)'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume scanning and alerts'),
  new SlashCommandBuilder().setName('status').setDescription('Show bot status, cash and API usage'),
  new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Add cash to the bankroll')
    .addNumberOption((o) => o.setName('amount').setDescription('USD').setRequired(true).setMinValue(1)),
].map((c) => c.toJSON());

export interface BotOptions {
  token: string;
  appId: string;
  guildId: string;
  channelIds: Record<Route, string>;
  reportChannelId: string;
  db: Db;
  ebayUsedToday: () => Promise<number>;
  log: Log;
}

export interface Bot {
  send(route: Route, payload: AlertPayload): Promise<string>;
  /** Plain message + one text attachment (weekly report). Content is truncated to Discord's 2000-char limit. */
  sendReport(content: string, file: { name: string; body: string }): Promise<string>;
  stop(): Promise<void>;
}

export async function startBot(o: BotOptions): Promise<Bot> {
  await new REST().setToken(o.token).put(Routes.applicationGuildCommands(o.appId, o.guildId), { body: COMMANDS });

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  async function onInteraction(i: Interaction) {
    if (i.isChatInputCommand()) {
      await respondEphemeral(i, async () => ({
        content: await handleCommand({ db: o.db, ebayUsedToday: o.ebayUsedToday }, i.commandName, {
          amount: i.options.getNumber('amount') ?? undefined,
        }),
      }), o.log);
      return;
    }
    if (i.isButton() || i.isStringSelectMenu()) {
      const values = i.isStringSelectMenu() ? i.values : [];
      await respondEphemeral(i, async () => {
        const r = await handleComponent(o.db, i.customId, values, i.user.username);
        return { content: r.reply, components: (r.components ?? []) as never[] };
      }, o.log);
    }
  }

  client.on(Events.InteractionCreate, (i) => {
    onInteraction(i).catch((err) => o.log('error', 'interaction failed', { message: err instanceof Error ? err.message : String(err) }));
  });
  client.on(Events.Error, (e) => o.log('error', 'discord client error', { message: e.message }));
  client.on(Events.ShardError, (e) => o.log('error', 'discord shard error', { message: e.message }));
  const ready = new Promise<void>((resolve) => client.once(Events.ClientReady, () => resolve()));
  await client.login(o.token);
  await ready;
  o.log('info', 'discord bot ready', { user: client.user?.tag });

  return {
    async send(route, payload) {
      const channel = await client.channels.fetch(o.channelIds[route]);
      if (!channel || !channel.isSendable()) throw new Error(`Discord channel for ${route} is not sendable`);
      const msg = await channel.send(payload as MessageCreateOptions);
      return msg.id;
    },
    async sendReport(content, file) {
      const channel = await client.channels.fetch(o.reportChannelId);
      if (!channel || !channel.isSendable()) throw new Error('Discord report channel is not sendable');
      const msg = await channel.send({
        content: content.slice(0, 2000),
        files: [{ attachment: Buffer.from(file.body, 'utf8'), name: file.name }],
      });
      return msg.id;
    },
    async stop() {
      await client.destroy();
    },
  };
}
