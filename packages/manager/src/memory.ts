import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem } from 'node:os';

const execFileP = promisify(execFile);

export const OVERHEAD_BYTES = 1.5 * 1024 ** 3;

export function totalRamBytes(): number { return totalmem(); }

export function parseVmStat(output: string): { availableBytes: number } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 16384);
  const page = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
  return { availableBytes: (page('free') + page('inactive') + page('speculative')) * pageSize };
}

export async function readAvailableBytes(): Promise<number> {
  const { stdout } = await execFileP('vm_stat');
  return parseVmStat(stdout).availableBytes;
}

export type FitResult = { fits: true } | { fits: false; requiredBytes: number; availableBytes: number };

export function checkFit(modelMemoryBytes: number, availableBytes: number, totalBytes: number): FitResult {
  const requiredBytes = modelMemoryBytes + OVERHEAD_BYTES;
  if (availableBytes - requiredBytes >= 0.15 * totalBytes) return { fits: true };
  return { fits: false, requiredBytes, availableBytes };
}
