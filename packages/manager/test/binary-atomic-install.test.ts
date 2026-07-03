import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock execFile so the test never spawns a real `tar` or a real llama-server binary:
//  - the `tar -xzf ... -C <dir>` call is simulated by writing the expected
//    llama-b9840/llama-server layout directly into <dir>, so installBinary's extraction step
//    "succeeds" without a real archive.
//  - the subsequent `<staged llama-server> --version` call is forced to fail as if the process
//    never spawned (e.g. a dyld/permission error), so the version assert throws.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (file: string, args: readonly string[], callback: (err: unknown, stdout?: string, stderr?: string) => void) => {
      if (file === 'tar') {
        const dashC = args.indexOf('-C');
        const extractDir = args[dashC + 1];
        const srcBin = join(extractDir, 'llama-b9840');
        mkdirSync(srcBin, { recursive: true });
        writeFileSync(join(srcBin, 'llama-server'), '#!/bin/sh\necho fake\n');
        callback(null, '', '');
        return {} as ReturnType<typeof actual.execFile>;
      }
      const err: any = new Error('spawn EACCES');
      err.code = 'EACCES';
      callback(err);
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-bin-atomic-'));
  delete process.env.FC_LLAMA_BIN;
  // Fake a tiny download body; the mocked `tar` above never reads its actual bytes.
  global.fetch = vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
        controller.close();
      },
    });
    return { ok: true, status: 200, body, headers: new Map([['content-length', '1']]) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('installBinary atomicity', () => {
  it('leaves binaryInstalled() false if the install fails before completion (version assert)', async () => {
    const { installBinary, binaryInstalled } = await import('../src/binary');
    expect(binaryInstalled()).toBe(false);
    await expect(installBinary(() => {})).rejects.toThrow(/version check/);
    // The final target dir must never have been created, since the failure happened while
    // verifying the STAGED binary, before the atomic rename into place.
    expect(binaryInstalled()).toBe(false);
  });
});
