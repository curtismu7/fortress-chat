import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { downloadFile, ChecksumError } from '../src/download';

const BODY = randomBytes(1024 * 64);
const SHA = createHash('sha256').update(BODY).digest('hex');
let server: Server; let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'content-length': BODY.length - start });
    res.end(BODY.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('downloadFile', () => {
  it('downloads, verifies sha, renames .part to final', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    let last = 0;
    await downloadFile(`${base}/f`, dest, SHA, BODY.length, (r) => (last = r));
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(dest + '.part')).toBe(false);
    expect(last).toBe(BODY.length);
  });

  it('resumes from an existing .part', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    writeFileSync(dest + '.part', BODY.subarray(0, 1000));
    await downloadFile(`${base}/f`, dest, SHA, BODY.length, () => {});
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('throws ChecksumError on sha mismatch and keeps no final file', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    await expect(downloadFile(`${base}/f`, dest, 'a'.repeat(64), BODY.length, () => {})).rejects.toThrow(ChecksumError);
    expect(existsSync(dest)).toBe(false);
  });
});
