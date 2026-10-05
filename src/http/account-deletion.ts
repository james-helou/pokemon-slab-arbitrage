import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Log } from '../log.js';

const MAX_BODY_BYTES = 64 * 1024;

/** eBay challenge: lowercase hex SHA-256 of challengeCode + verificationToken + endpoint, in that order. */
export function challengeResponse(code: string, token: string, endpoint: string): string {
  return createHash('sha256').update(code + token + endpoint).digest('hex');
}

export type AccountDeletionOpts = {
  /** Exact public URL as registered with eBay (never derived from request headers). */
  endpoint: string;
  verificationToken: string;
  /** Pathname of `endpoint`. */
  path: string;
  log: Log;
};

function send(res: ServerResponse, status: number, body?: string, contentType?: string): void {
  res.writeHead(status, contentType ? { 'Content-Type': contentType } : {});
  res.end(body);
}

export function createAccountDeletionHandler(o: AccountDeletionOpts): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, 'ok', 'text/plain');
    if (url.pathname !== o.path) return send(res, 404);

    if (req.method === 'GET') {
      const code = url.searchParams.get('challenge_code');
      if (!code) return send(res, 400);
      return send(
        res, 200,
        JSON.stringify({ challengeResponse: challengeResponse(code, o.verificationToken, o.endpoint) }),
        'application/json',
      );
    }
    if (req.method !== 'POST') return send(res, 405);

    // No x-ebay-signature verification on purpose: the bot stores no eBay user data, so there is nothing
    // to delete and a forged notification has no effect. We only acknowledge and log id + topic.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        send(res, 413);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          metadata?: { topic?: unknown }; notification?: { notificationId?: unknown };
        };
        // Only these two fields are ever read: username/userId/eiasToken are user data and are never logged.
        o.log('info', 'ebay account deletion notification', {
          notificationId: String(body?.notification?.notificationId ?? ''),
          topic: String(body?.metadata?.topic ?? ''),
        });
        send(res, 204);
      } catch {
        send(res, 400);
      }
    });
    req.on('error', () => { if (!res.headersSent) send(res, 400); });
  };
}
