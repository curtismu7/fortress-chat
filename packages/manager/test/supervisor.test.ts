import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor';
import type { CatalogModel } from '@fortress-code/shared';

const STUB = join(__dirname, 'fixtures', 'stub-llama-server.mjs');
const model: CatalogModel = {
  id: 'stub', family: 'gemma3', displayName: 'Stub', hfRepo: 'x/y',
  files: [{ name: 'stub.gguf', sha256: 'a'.repeat(64), bytes: 1 }],
  memoryBytes: 1, ramTierBytes: 1, toolCalling: true, license: 'test', extraArgs: [],
};

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-sup-'));
  process.env.FC_LLAMA_BIN = process.execPath; // node
  process.env.FC_LLAMA_BIN_ARGS = STUB;        // supervisor prepends this when set (test hook)
});

describe('Supervisor', () => {
  it('walks starting → loading-model → ready and exposes endpoint', async () => {
    // The supervisor polls /health every 500ms; the stub's default STUB_LOAD_MS (300ms) is
    // shorter than that interval, so the first poll (which always misses because the child
    // hasn't started listening yet) is followed by a poll ~500ms later — by then the stub is
    // already past its loading window and the 503 state is skipped. Raise STUB_LOAD_MS above
    // one poll interval so the loading-model state is deterministically observed.
    process.env.STUB_LOAD_MS = '700';
    const sup = new Supervisor();
    const states: string[] = [];
    sup.onStateChange((s) => states.push(s));
    await sup.start(model, '/dev/null');
    expect(sup.state).toBe('ready');
    expect(states).toEqual(['starting', 'loading-model', 'ready']);
    expect(sup.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await sup.stop();
    expect(sup.state).toBe('idle');
    delete process.env.STUB_LOAD_MS;
  });

  it('detects crash and captures stderr', async () => {
    process.env.STUB_CRASH_MS = '600';
    const sup = new Supervisor();
    await sup.start(model, '/dev/null');
    await new Promise((r) => setTimeout(r, 900));
    expect(sup.state).toBe('crashed');
    expect(sup.crashLog!.join('\n')).toContain('simulated crash');
    delete process.env.STUB_CRASH_MS;
  });
});
