import type { MessageFlags } from 'discord.js';
import type { Log } from '../log.js';

export interface ReplyBody {
  content: string;
  components?: never[];
}

/** The slice of a discord.js repliable interaction that respondEphemeral needs. */
export interface Deferrable {
  deferred: boolean;
  replied: boolean;
  deferReply(o: { flags: MessageFlags.Ephemeral }): Promise<unknown>;
  editReply(o: ReplyBody): Promise<unknown>;
  reply(o: ReplyBody & { flags: MessageFlags.Ephemeral }): Promise<unknown>;
}

const EPHEMERAL = 64 as MessageFlags.Ephemeral;
const FAILED: ReplyBody = { content: 'Something went wrong' };

/** Defers first (the 3s ack window), then runs `work` and edits the reply. Never throws, never double-replies. */
export async function respondEphemeral(i: Deferrable, work: () => Promise<ReplyBody>, log: Log): Promise<void> {
  try {
    await i.deferReply({ flags: EPHEMERAL });
    await i.editReply(await work());
  } catch (err) {
    log('error', 'interaction failed', { message: err instanceof Error ? err.message : String(err) });
    try {
      if (i.deferred || i.replied) await i.editReply(FAILED);
      else await i.reply({ ...FAILED, flags: EPHEMERAL });
    } catch (err2) {
      log('error', 'interaction error reply failed', { message: err2 instanceof Error ? err2.message : String(err2) });
    }
  }
}
