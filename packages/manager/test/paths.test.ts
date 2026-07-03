import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, writeDaemonInfo, readDaemonInfo, isProcessAlive } from '../src/paths';

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-test-'));
});

describe('paths', () => {
  it('uses FC_DATA_DIR override and creates it', () => {
    expect(dataDir()).toBe(process.env.FC_DATA_DIR);
  });

  it('daemon.json round-trips and is 0600', () => {
    writeDaemonInfo({ pid: 123, port: 45678, token: 'abc' });
    expect(readDaemonInfo()).toEqual({ pid: 123, port: 45678, token: 'abc' });
    const mode = statSync(join(dataDir(), 'daemon.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readDaemonInfo returns null when missing', () => {
    expect(readDaemonInfo()).toBeNull();
  });

  it('isProcessAlive: own pid alive, absurd pid not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 - 7)).toBe(false);
  });
});
