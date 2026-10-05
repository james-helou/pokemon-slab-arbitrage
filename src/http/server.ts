import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Log } from '../log.js';

export type HttpServer = { port: number; close(): Promise<void> };

export function startHttpServer(o: {
  port: number;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  log: Log;
}): Promise<HttpServer> {
  const server = createServer((req, res) => {
    try {
      o.handler(req, res);
    } catch (err) {
      o.log('error', 'http handler failed', { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, () => {
      const port = (server.address() as AddressInfo).port;
      o.log('info', 'http server listening', { port });
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => {
          server.close((err) => (err ? rej(err) : res()));
          server.closeAllConnections();
        }),
      });
    });
  });
}
