import { createWriteStream, createReadStream, existsSync, statSync, statfsSync, unlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ChecksumError extends Error {}
export class DiskSpaceError extends Error {}

export function freeDiskBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string, destPath: string, expectedSha256: string, expectedBytes: number,
  onProgress: (received: number, total: number) => void, signal?: AbortSignal,
): Promise<void> {
  const part = destPath + '.part';
  const already = existsSync(part) ? statSync(part).size : 0;
  if (freeDiskBytes(dirname(destPath)) < expectedBytes - already) {
    throw new DiskSpaceError(`Need ${expectedBytes - already} bytes free`);
  }
  const headers: Record<string, string> = already > 0 ? { range: `bytes=${already}-` } : {};
  const res = await fetch(url, { headers, signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const resumed = res.status === 206;
  let received = resumed ? already : 0;
  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) { received += chunk.length; onProgress(received, expectedBytes); yield chunk; }
  };
  await pipeline(Readable.fromWeb(res.body as any), counter, out);
  const actual = await sha256File(part);
  if (actual !== expectedSha256) { unlinkSync(part); throw new ChecksumError(`sha256 mismatch: ${actual}`); }
  renameSync(part, destPath);
}
