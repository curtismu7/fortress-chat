import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ForeignProcess } from '@fortress-chat/shared';

const execFileP = promisify(execFile);
const PATTERN = /(llama-server\s+-m|llama serve\s+-m|llama-server\s+--|llama serve\s+--|llama-server\s+-hf|llama serve\s+-hf|ollama runner)/;

export function parsePs(output: string, excludePids: number[]): ForeignProcess[] {
  const out: ForeignProcess[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[3];
    if (!PATTERN.test(command) || excludePids.includes(pid)) continue;
    out.push({ pid, command: command.slice(0, 200), rssBytes: Number(m[2]) * 1024 });
  }
  return out;
}

export async function scanForeign(excludePids: number[]): Promise<ForeignProcess[]> {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,rss=,command=']);
  return parsePs(stdout, excludePids);
}

export function killPids(pids: number[]): { killed: number[]; failed: number[] } {
  const killed: number[] = [];
  const failed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      killed.push(pid);
    } catch {
      failed.push(pid);
    }
  }
  return { killed, failed };
}

/** Read resident set size for a process (bytes), or 0 if the process is gone. */
export async function rssForPid(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileP('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0;
  } catch {
    return 0;
  }
}
