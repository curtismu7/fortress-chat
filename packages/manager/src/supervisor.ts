import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { CatalogModel, ServerState } from '@fortress-chat/shared';
import { llamaServerPath } from './binary';

export const DEFAULT_CTX = 8192;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export class Supervisor {
  state: ServerState = 'idle';
  modelId: string | null = null;
  port: number | null = null;
  crashLog: string[] | null = null;
  private child: ChildProcess | null = null;
  private stderrRing: string[] = [];
  private listeners: Array<(s: ServerState) => void> = [];
  private expectedExit = false;

  onStateChange(cb: (s: ServerState) => void): void { this.listeners.push(cb); }
  managedPid(): number | null { return this.child?.pid ?? null; }
  endpoint(): string | null { return this.state === 'ready' && this.port ? `http://127.0.0.1:${this.port}` : null; }

  private setState(s: ServerState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  async start(model: CatalogModel, modelPath: string): Promise<void> {
    if (this.child) await this.stop();
    this.crashLog = null;
    this.stderrRing = [];
    this.expectedExit = false;
    this.port = await freePort();
    const bin = llamaServerPath();
    const args = [
      ...(process.env.FC_LLAMA_BIN_ARGS ? [process.env.FC_LLAMA_BIN_ARGS] : []),
      '-m', modelPath, '-ngl', '99', '-c', String(DEFAULT_CTX),
      '--jinja', '--host', '127.0.0.1', '--port', String(this.port),
      ...model.extraArgs,
    ];
    this.setState('starting');
    this.child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
      }
    });
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.expectedExit) return;
      this.crashLog = [...this.stderrRing, `(exit code ${code})`];
      this.setState('crashed');
    });
    this.modelId = model.id;
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let sawLoading = false;
    while (Date.now() < deadline) {
      if (this.state === 'crashed') throw new Error(`llama-server crashed during startup:\n${this.crashLog?.join('\n')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 503 && !sawLoading) { sawLoading = true; this.setState('loading-model'); }
        if (res.ok) { this.setState('ready'); return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error('llama-server did not become ready within 120s');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.setState('idle'); this.modelId = null; return; }
    this.setState('stopping');
    this.expectedExit = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
    this.modelId = null;
    this.setState('idle');
  }
}
