import * as vscode from 'vscode';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, sep, join, relative } from 'node:path';

export class PathEscapeError extends Error {}

export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files under a workspace directory (recursive, max 200 entries)', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative directory, "" for root' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents with a case-sensitive substring', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace the full contents of a file (or create it). The user reviews a diff and can reject.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'complete new file contents' } }, required: ['path', 'content'] } } },
];

export function resolveInWorkspace(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathEscapeError(`path escapes workspace: ${relPath}`);
  return abs;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.venv']);

function walk(dir: string, root: string, acc: string[], limit: number): void {
  if (acc.length >= limit) return;
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, acc, limit);
    else acc.push(relative(root, full));
    if (acc.length >= limit) return;
  }
}

export async function editFileWithApproval(abs: string, content: string, rel: string): Promise<string> {
  const uri = vscode.Uri.file(abs);
  let original = '';
  try { original = readFileSync(abs, 'utf8'); } catch { /* new file */ }
  const left = vscode.Uri.parse(`untitled:${rel}.orig`).with({ scheme: 'fc-orig', path: rel });
  const provider = vscode.workspace.registerTextDocumentContentProvider('fc-orig', {
    provideTextDocumentContent: () => original,
  });
  const right = vscode.Uri.parse(`fc-new:${rel}`).with({ scheme: 'fc-new', path: rel });
  const provider2 = vscode.workspace.registerTextDocumentContentProvider('fc-new', {
    provideTextDocumentContent: () => content,
  });
  try {
    await vscode.commands.executeCommand('vscode.diff', left, right, `Agent edit: ${rel}`);
    const choice = await vscode.window.showInformationMessage(`Apply agent edit to ${rel}?`, { modal: true }, 'Apply', 'Reject');
    if (choice !== 'Apply') return 'rejected by user';
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, 'utf8') });
    await vscode.workspace.applyEdit(edit);
    return 'applied';
  } finally {
    provider.dispose(); provider2.dispose();
  }
}

export async function executeTool(name: string, args: any, workspaceRoot: string): Promise<string> {
  switch (name) {
    case 'read_file': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path));
      const body = readFileSync(abs, 'utf8');
      return body.length > 50_000 ? body.slice(0, 50_000) + '\n…(truncated)' : body;
    }
    case 'list_files': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path ?? ''));
      const acc: string[] = [];
      walk(abs, workspaceRoot, acc, 200);
      return acc.join('\n') || '(empty)';
    }
    case 'search': {
      const acc: string[] = [];
      walk(workspaceRoot, workspaceRoot, acc, 2000);
      const hits: string[] = [];
      for (const rel of acc) {
        try {
          const lines = readFileSync(join(workspaceRoot, rel), 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (line.includes(String(args.query)) && hits.length < 100) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch { /* binary or unreadable */ }
      }
      return hits.join('\n') || 'no matches';
    }
    case 'edit_file': {
      const rel = String(args.path);
      const abs = resolveInWorkspace(workspaceRoot, rel);
      return editFileWithApproval(abs, String(args.content), rel);
    }
    default:
      return `unknown tool: ${name}`;
  }
}
