import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonInfo { pid: number; port: number; token: string }

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataDir(): string {
  return ensure(process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-code'));
}

export function binDir(): string { return ensure(join(dataDir(), 'bin')); }
export function modelsDir(): string { return ensure(join(dataDir(), 'models')); }

const daemonFile = () => join(dataDir(), 'daemon.json');

export function writeDaemonInfo(info: DaemonInfo): void {
  writeFileSync(daemonFile(), JSON.stringify(info), { mode: 0o600 });
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(daemonFile(), 'utf8'));
    if (typeof raw?.pid === 'number' && typeof raw?.port === 'number' && typeof raw?.token === 'string') return raw;
    return null;
  } catch { return null; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
