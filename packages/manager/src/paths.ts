import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonInfo { pid: number; port: number; token: string }

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** One-time migration from the old 'fortress-code' data dir to 'fortress-chat'.
 *  Moves the legacy dir in place if the new one doesn't already exist. */
function migrateLegacyDataDir(newDir: string): void {
  if (existsSync(newDir)) return;
  const legacy = join(homedir(), 'Library', 'Application Support', 'fortress-code');
  if (!existsSync(legacy)) return;
  try { renameSync(legacy, newDir); return; } catch { /* fall through to copy */ }
  try { cpSync(legacy, newDir, { recursive: true }); } catch { /* leave legacy in place */ }
}

export function dataDir(): string {
  const dir = process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-chat');
  if (!process.env.FC_DATA_DIR) migrateLegacyDataDir(dir);
  return ensure(dir);
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
