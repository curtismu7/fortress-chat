import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '../daemon';

let server: Server; let port: number;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers['x-fc-token'] !== 't') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/start') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'insufficient-memory', requiredBytes: 10, availableBytes: 5, wouldFitAfterForeignKill: true, foreign: [] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'idle' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

describe('DaemonClient', () => {
  it('start() surfaces 409 as a typed rejection, not an exception', async () => {
    const c = new DaemonClient(port, 't');
    const r = await c.start('gpt-oss-20b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe('insufficient-memory');
  });

  it('throws on auth failure', async () => {
    const c = new DaemonClient(port, 'wrong');
    await expect(c.status()).rejects.toThrow();
  });
});
