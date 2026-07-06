// packages/extension/src/agentCheckpoint.ts
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface FileSnapshot { rel: string; content: string | null; existed: boolean }

/** Captures file contents before agent edits so the user can undo one agent run. */
export class AgentCheckpoint {
  private snapshots = new Map<string, FileSnapshot>();

  /** Snapshot a file before it is modified (first touch only). */
  capture(rel: string, abs: string): void {
    if (this.snapshots.has(rel)) return;
    try {
      this.snapshots.set(rel, { rel, content: readFileSync(abs, 'utf8'), existed: true });
    } catch {
      this.snapshots.set(rel, { rel, content: null, existed: false });
    }
  }

  hasChanges(): boolean { return this.snapshots.size > 0; }

  /** Drop a pending snapshot when the user rejected an agent edit. */
  revert(rel: string): void { this.snapshots.delete(rel); }

  clear(): void { this.snapshots.clear(); }

  /** Restore all snapshotted files; returns paths restored. */
  restore(workspaceRoot: string): string[] {
    const restored: string[] = [];
    for (const snap of this.snapshots.values()) {
      const abs = join(workspaceRoot, snap.rel);
      if (!snap.existed) {
        if (existsSync(abs)) { unlinkSync(abs); restored.push(snap.rel); }
        continue;
      }
      if (snap.content != null) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, snap.content, 'utf8');
        restored.push(snap.rel);
      }
    }
    this.clear();
    return restored;
  }
}
