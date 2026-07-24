import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { McpClient } from '../mcpClient';

const mockServerPath = resolve(__dirname, 'fixtures', 'mockMcpServer.js');

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function rpcResult(id: number | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function sendJson(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

describe('McpClient', () => {
  it('connects and calls tools over Content-Length framing', async () => {
    const client = new McpClient({
      name: 'mock',
      command: process.execPath,
      args: [mockServerPath, 'framed'],
    });

    try {
      const tools = await client.connect();
      expect(tools.map((t) => t.name)).toEqual(['mock__echo', 'mock__structured']);
      await expect(client.callTool('mock__echo', { message: 'hello' })).resolves.toBe('hello');
      await expect(client.callTool('mock__structured', {})).resolves.toBe('{"ok":true,"source":"mock"}');
    } finally {
      client.dispose();
    }
  });

  it('falls back to newline transport for non-standard MCP servers', async () => {
    const client = new McpClient({
      name: 'mock',
      command: process.execPath,
      args: [mockServerPath, 'newline'],
    });

    try {
      const tools = await client.connect();
      expect(tools.map((t) => t.name)).toEqual(['mock__echo', 'mock__structured']);
      await expect(client.callTool('mock__echo', { message: 'fallback-ok' })).resolves.toBe('fallback-ok');
    } finally {
      client.dispose();
    }
  }, 15_000);

  it('connects and calls tools over HTTP transport', async () => {
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404);
        res.end();
        return;
      }
      const msg = await readJson(req);
      if (msg.method === 'initialize') {
        sendJson(res, 200, rpcResult(msg.id, {
          protocolVersion: '2025-03-26',
          capabilities: {},
          serverInfo: { name: 'mock-http', version: '1.0.0' },
        }));
        return;
      }
      if (msg.method === 'notifications/initialized') {
        sendJson(res, 200, JSON.stringify({ jsonrpc: '2.0', result: null }));
        return;
      }
      if (msg.method === 'tools/list') {
        sendJson(res, 200, rpcResult(msg.id, {
          tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }],
        }));
        return;
      }
      if (msg.method === 'tools/call') {
        sendJson(res, 200, rpcResult(msg.id, {
          content: [{ type: 'text', text: String((msg.params?.arguments || {}).message || '') }],
        }));
        return;
      }
      sendJson(res, 200, JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
    });

    await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', () => resolveStart()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind http test server');

    const client = new McpClient({
      name: 'httpmock',
      transport: 'http',
      url: `http://127.0.0.1:${address.port}/mcp`,
    });

    try {
      const tools = await client.connect();
      expect(tools.map((t) => t.name)).toEqual(['httpmock__echo']);
      await expect(client.callTool('httpmock__echo', { message: 'via-http' })).resolves.toBe('via-http');
    } finally {
      client.dispose();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('connects and calls tools over SSE transport', async () => {
    let sseRes: ServerResponse | null = null;
    const server = createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        sseRes = res;
        res.write('event: endpoint\n');
        res.write('data: /messages\n\n');
        return;
      }
      if (req.method === 'POST' && req.url === '/messages') {
        const msg = await readJson(req);
        res.writeHead(202);
        res.end();
        if (!sseRes) return;
        let result: unknown;
        if (msg.method === 'initialize') {
          result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock-sse', version: '1.0.0' } };
        } else if (msg.method === 'tools/list') {
          result = { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }] };
        } else if (msg.method === 'tools/call') {
          result = { content: [{ type: 'text', text: String((msg.params?.arguments || {}).message || '') }] };
        } else {
          if (msg.id != null) {
            sseRes.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })}\n\n`);
          }
          return;
        }
        if (msg.id != null) sseRes.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', () => resolveStart()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind sse test server');

    const client = new McpClient({
      name: 'ssemock',
      transport: 'sse',
      url: `http://127.0.0.1:${address.port}/sse`,
    });

    try {
      const tools = await client.connect();
      expect(tools.map((t) => t.name)).toEqual(['ssemock__echo']);
      await expect(client.callTool('ssemock__echo', { message: 'via-sse' })).resolves.toBe('via-sse');
    } finally {
      client.dispose();
      const live = sseRes as ServerResponse | null;
      if (live) live.end();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
