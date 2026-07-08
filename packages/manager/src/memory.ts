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

/** Re-read free memory after stopping a managed model; credit RSS when vm_stat lags. */
export async function availableAfterManagedStop(
  readAvailable: () => Promise<number>,
  reclaimedBytes: number,
): Promise<number> {
  const before = await readAvailable();
  if (reclaimedBytes <= 0) return before;
  await new Promise((r) => setTimeout(r, 400));
  const after = await readAvailable();
  const gained = after - before;
  if (gained < reclaimedBytes * 0.25) return before + reclaimedBytes;
  return after;
}
