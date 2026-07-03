import { describe, it, expect } from 'vitest';
import { runAgentTurn, MAX_ITERATIONS } from '../agent/loop';
import { Session } from '../chat/session';
import type { ResolvedTarget } from '../providers/target';

const target: ResolvedTarget = { url: 'http://x/v1/chat/completions', headers: {}, bodyExtra: {} };

function fakeCompleter(script: Array<{ content: string; toolCalls: any[] }>) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

describe('runAgentTurn', () => {
  it('executes tool calls then finishes on a content reply', async () => {
    const session = new Session();
    session.addUser('read a file');
    const executed: string[] = [];
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { content: 'The file says hi.', toolCalls: [] },
      ]),
      execute: async (name) => { executed.push(name); return 'hi'; },
      workspaceRoot: '/ws',
    });
    expect(executed).toEqual(['read_file']);
    expect(session.messages.at(-1)!).toEqual({ role: 'assistant', content: 'The file says hi.' });
    expect(session.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('stops after MAX_ITERATIONS of pure tool calls', async () => {
    const session = new Session();
    session.addUser('loop forever');
    let calls = 0;
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: async () => { calls++; return { content: '', toolCalls: [{ id: String(calls), type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } }] }; },
      execute: async () => 'nothing',
      workspaceRoot: '/ws',
    });
    expect(calls).toBe(MAX_ITERATIONS);
    expect(session.messages.at(-1)!.content).toContain('iteration limit');
  });

  it('reports malformed tool arguments as a tool error, not a crash', async () => {
    const session = new Session();
    session.addUser('bad args');
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: 'NOT JSON' } }] },
        { content: 'done', toolCalls: [] },
      ]),
      execute: async () => 'never called',
      workspaceRoot: '/ws',
    });
    const toolMsg = session.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('invalid arguments');
  });
});
