import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat } from '../providers/stream';
import type { ResolvedTarget } from '../providers/target';

let server: Server; let target: ResolvedTarget;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, headers: {}, bodyExtra: {} };
});
afterAll(() => server.close());

describe('streamChat reasoning + usage', () => {
  it('separates reasoning from content and captures usage', async () => {
    const content: string[] = []; const reason: string[] = [];
    const r = await streamChat(target, [{ role: 'user', content: 'hi' }], (t) => content.push(t), new AbortController().signal, (t) => reason.push(t));
    expect(r.content).toBe('Hi!');
    expect(r.reasoning).toBe('thinking');
    expect(r.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
    expect(content.join('')).toBe('Hi!');
    expect(reason.join('')).toBe('thinking');
  });
});
