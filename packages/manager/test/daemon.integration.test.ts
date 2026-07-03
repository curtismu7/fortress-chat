import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = join(__dirname, '..', 'dist', 'index.js');
let dataDir: string; let child: ChildProcess | null = null;

function daemonInfo() { return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')); }
async function waitFor(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timeout');
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'fc-daemon-')); });
afterEach(() => { child?.kill('SIGKILL'); child = null; });

describe('daemon', () => {
  it('starts, writes daemon.json, answers /status with token, 401 without', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    await waitFor(() => !!daemonInfo().port);
    const { port, token } = daemonInfo();
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'x-fc-token': token } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe('idle');
    const bad = await fetch(`http://127.0.0.1:${port}/status`);
    expect(bad.status).toBe(401);
  });

  it('exits after idle timeout', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir, FC_IDLE_MS: '500' } });
    await waitFor(() => !!daemonInfo().port);
    const exited = new Promise((r) => child!.on('exit', r));
    await expect(Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('no exit')), 5000))])).resolves.toBeDefined();
  });

  it('second instance refuses to start while first is alive', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    await waitFor(() => !!daemonInfo().port);
    const second = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    const code = await new Promise((r) => second.on('exit', r));
    expect(code).toBe(3); // EXIT_ALREADY_RUNNING
  });
});
