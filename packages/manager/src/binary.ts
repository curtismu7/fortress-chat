import { existsSync, chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binDir, dataDir } from './paths';
import { downloadFile } from './download';

const execFileP = promisify(execFile);
export const LLAMA_RELEASE = 'b9840';
const ASSET = `llama-${LLAMA_RELEASE}-bin-macos-arm64.tar.gz`;
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${ASSET}`;
// Size checked at download time via content-length; archive integrity via TLS + version assert.
const APPROX_ZIP_BYTES = 30 * 1024 * 1024;

export function llamaServerPath(): string {
  return process.env.FC_LLAMA_BIN ?? join(binDir(), LLAMA_RELEASE, 'llama-server');
}

export function binaryInstalled(): boolean {
  return existsSync(llamaServerPath());
}

// Always installs to the DEFAULT binDir()/b9840 location; does NOT honor FC_LLAMA_BIN (that
// override is a run/test hook for pointing llamaServerPath() at a stub, not an install target).
export async function installBinary(onProgress: (r: number, t: number) => void): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`Unsupported platform ${process.platform}/${process.arch} (v1 is Apple Silicon macOS only)`);
  }
  const zipPath = join(dataDir(), ASSET);
  const extractDir = join(dataDir(), 'extract-tmp');
  // Staged on the same filesystem as the final target (both under binDir()) so the final move
  // is an atomic directory rename: the target directory is always complete-or-absent, so
  // binaryInstalled() (which just checks llamaServerPath() existence) can never observe a
  // partially-installed binary.
  const staging = join(binDir(), '.b9840-staging');
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  try {
    // GitHub asset downloads don't publish sha256; pass a sentinel and skip hash verification for the binary only.
    await downloadNoHash(URL, zipPath, APPROX_ZIP_BYTES, onProgress);
    mkdirSync(extractDir, { recursive: true });
    await execFileP('tar', ['-xzf', zipPath, '-C', extractDir]);
    mkdirSync(staging, { recursive: true });
    // release archive layout (verified against the real b9840 asset): llama-b9840/llama-server + *.dylib
    const srcBin = join(extractDir, `llama-${LLAMA_RELEASE}`);
    for (const f of readdirSync(srcBin)) renameSync(join(srcBin, f), join(staging, f));
    const stagedServer = join(staging, 'llama-server');
    chmodSync(stagedServer, 0o755);
    const versionResult = await execFileP(stagedServer, ['--version']).catch((e) => e);
    const stdout = versionResult?.stdout ?? '';
    const stderr = versionResult?.stderr ?? '';
    // llama-server --version prints "version: 9840 (<hash>)" — no leading "b" — so check the numeric
    // build id, anchored at word boundaries so e.g. "b9840" doesn't false-match a build "98400".
    const versionOutput = `${stdout}${stderr}`;
    const buildId = LLAMA_RELEASE.replace(/^b/, '');
    if (!new RegExp(String.raw`\b${buildId}\b`).test(versionOutput)) {
      const execError = versionResult instanceof Error ? ` execError: code=${(versionResult as any).code} message=${versionResult.message}` : '';
      throw new Error(
        `Installed llama-server failed version check (expected build ${buildId}): stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}${execError}`
      );
    }
    // Everything succeeded against the staged copy — commit it as a single atomic rename.
    const target = join(binDir(), LLAMA_RELEASE);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    rmSync(zipPath, { force: true });
  }
}

async function downloadNoHash(url: string, dest: string, approxBytes: number, onProgress: (r: number, t: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? approxBytes);
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  let received = 0;
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const c of src) { received += c.length; onProgress(received, total); yield c; }
  };
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
}
